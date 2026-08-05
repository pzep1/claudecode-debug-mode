'use strict';
const fs = require('fs');
const path = require('path');

// Fallback path: when a runtime has no inspector to attach to, we edit source.
// Every inserted line carries MARK, so removal is mechanical and verifiable —
// the failure mode of hand-written debug statements is that they ship.

const MARK = '/*@dbg*/';
const MARK_HASH = '#@dbg';
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', '__pycache__', '.claude-debug', 'coverage', '.venv', 'venv', 'target']);
const EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.java', '.php', '.sh', '.svelte', '.vue']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, out);
    } else if (EXTS.has(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

function verify(cwd, target = '.') {
  const base = path.resolve(cwd, target);
  const files = fs.existsSync(base) && fs.statSync(base).isDirectory() ? walk(base) : [base];
  const hits = [];
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes(MARK) && !src.includes(MARK_HASH)) continue;
    src.split('\n').forEach((line, i) => {
      if (line.includes(MARK) || line.includes(MARK_HASH)) {
        hits.push({ file: path.relative(cwd, f), line: i + 1, text: line.trim().slice(0, 100) });
      }
    });
  }
  return hits;
}

function strip(cwd, target = '.', opts = {}) {
  const base = path.resolve(cwd, target);
  const files = fs.existsSync(base) && fs.statSync(base).isDirectory() ? walk(base) : [base];
  let removed = 0, touched = 0;
  for (const f of files) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes(MARK) && !src.includes(MARK_HASH)) continue;
    const lines = src.split('\n');
    const kept = lines.filter((l) => {
      const isProbe = l.includes(MARK) || l.includes(MARK_HASH);
      if (isProbe) removed++;
      return !isProbe;
    });
    if (kept.length !== lines.length) {
      touched++;
      if (!opts.dryRun) fs.writeFileSync(f, kept.join('\n'));
    }
  }
  return { removed, files: touched };
}

// Where a preamble can legally go: after a shebang and any encoding /
// `from __future__` lines, which must stay first in a Python file.
function preambleInsertIndex(lines, lang) {
  let i = 0;
  if (lines[0] && lines[0].startsWith('#!')) i = 1;
  if (lang === 'py') {
    while (i < lines.length && /^#.*coding[:=]/.test(lines[i])) i++;
    let j = i;
    while (j < lines.length) {
      const l = lines[j].trim();
      if (l === '' || l.startsWith('#')) { j++; continue; }
      if (/^from\s+__future__\s+import/.test(l)) { i = ++j; continue; }
      break;
    }
  }
  return i;
}

// Mark every line so `dbg probe strip` removes the preamble as cleanly as it
// removes the probes themselves.
function markBlock(text, lang) {
  const mark = lang === 'py' ? MARK_HASH : MARK;
  return text.split('\n').map((l) => (l.length ? `${l}  ${mark}` : mark));
}

function add(cwd, spec, opts = {}) {
  const m = String(spec).match(/^(.+?):(\d+)(?:\s+(.*))?$/);
  if (!m) throw new Error(`bad probe spec "${spec}" — expected file:line [expr ...]`);
  const file = path.resolve(cwd, m[1]);
  const line = Number(m[2]);
  const exprs = m[3] ? m[3].split(/[,\s]+/).filter(Boolean) : [];
  if (!fs.existsSync(file)) throw new Error(`no such file: ${m[1]}`);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  if (line < 1 || line > lines.length + 1) throw new Error(`${m[1]} has ${lines.length} lines`);
  const indent = (lines[line - 1] || '').match(/^\s*/)[0];
  const label = opts.label || `${path.basename(file)}:${line}`;
  const ext = path.extname(file);
  const text = ext === '.py'
    ? `${indent}dbg(${JSON.stringify(label)}${exprs.length ? ', ' + exprs.map((e) => `${sanitizeKw(e)}=${e}`).join(', ') : ''})  ${MARK_HASH}`
    : `${indent}__dbg(${JSON.stringify(label)}${exprs.length ? `, {${exprs.join(', ')}}` : ''}); ${MARK}`;
  lines.splice(line - 1, 0, text);

  // A probe calls a recorder the program does not have. Inserting the call
  // without it just moves the failure to runtime (NameError / ReferenceError),
  // so add the producer too when the file lacks one and we know where to send.
  const lang = ext === '.py' ? 'py' : 'js';
  let addedRecorder = false;
  let shift = 0;
  if (!hasRecorder(lines.join('\n')) && opts.url && opts.token) {
    const block = markBlock(snippet(lang === 'py' ? 'python' : 'node', opts.url, opts.token), lang);
    const at = preambleInsertIndex(lines, lang);
    lines.splice(at, 0, ...block);
    addedRecorder = true;
    shift = at <= line - 1 ? block.length : 0;
  }

  fs.writeFileSync(file, lines.join('\n'));
  return {
    file: m[1], line: line + shift, requested: line, label, lang,
    mark: lang === 'py' ? MARK_HASH : MARK, addedRecorder,
  };
}

function sanitizeKw(e) {
  return /^[A-Za-z_]\w*$/.test(e) ? e : 'v';
}

// ---- producer snippets ---------------------------------------------------

function snippet(kind, url, token) {
  switch (kind) {
    case 'python': case 'py': return pySnippet(url, token);
    case 'browser': case 'web': return browserSnippet(url, token);
    case 'shell': case 'sh': case 'bash': return shSnippet(url, token);
    case 'node': case 'js': return nodeSnippet(url, token);
    default: throw new Error('usage: dbg snippet python|browser|shell|node');
  }
}

function pySnippet(url, token) {
  return `# --- dbg producer: paste near the top of your module ------------------
# dbg("label", x=x, y=y)  -> non-blocking, ordered, safe to leave in a loop
import json, threading, queue, time, urllib.request
_DBG_URL, _DBG_TOKEN = ${JSON.stringify(url)}, ${JSON.stringify(token)}
_dbg_q, _dbg_lock, _dbg_n = queue.Queue(), threading.Lock(), [0]
_dbg_unsent = [0]
def _dbg_send():
    while True:
        batch = [_dbg_q.get()]
        while len(batch) < 64:
            try: batch.append(_dbg_q.get_nowait())
            except queue.Empty: break
        try:
            req = urllib.request.Request(_DBG_URL,
                data=json.dumps({"producer": "py", "events": batch}).encode(),
                headers={"content-type": "application/json", "x-dbg-token": _DBG_TOKEN})
            urllib.request.urlopen(req, timeout=2).read()
        except Exception: pass
        with _dbg_lock: _dbg_unsent[0] -= len(batch)
threading.Thread(target=_dbg_send, daemon=True).start()
# The sender is a daemon thread, so without this anything still in flight when
# the program ends is silently lost - which for a short script is all of it.
import atexit as _atexit
def _dbg_drain(timeout=3.0):
    end = time.time() + timeout
    while _dbg_unsent[0] > 0 and time.time() < end:
        time.sleep(0.01)
_atexit.register(_dbg_drain)
def _dbg_safe(v, d=0):
    if d > 3: return "<...>"
    if v is None or isinstance(v, (bool, int, float)): return v
    if isinstance(v, str): return v if len(v) <= 240 else v[:240] + "\\u2026"
    if isinstance(v, dict): return {str(k): _dbg_safe(x, d+1) for k, x in list(v.items())[:40]}
    if isinstance(v, (list, tuple, set)): return [_dbg_safe(x, d+1) for x in list(v)[:40]]
    if isinstance(v, BaseException): return {"__t": "error", "name": type(v).__name__, "message": str(v)}
    return repr(v)[:240]
def dbg(label, **data):
    kind = data.pop("_kind", None)
    with _dbg_lock:
        _dbg_n[0] += 1; s = _dbg_n[0]
    ev = {"s": s, "t": time.time() * 1000, "n": label,
          "d": {k: _dbg_safe(v) for k, v in data.items()}}
    if kind: ev["k"] = kind
    with _dbg_lock: _dbg_unsent[0] += 1
    _dbg_q.put(ev)
    return False
# uncaught exceptions, without touching your handlers:
import sys as _sys
_dbg_hook = _sys.excepthook
def _dbg_excepthook(t, v, tb):
    dbg("uncaught", _kind="err", error=v); _dbg_drain(1.0); _dbg_hook(t, v, tb)
_sys.excepthook = _dbg_excepthook
# ---------------------------------------------------------------------`;
}

function browserSnippet(url, token) {
  return `<!-- dbg producer: paste into the page (or run in the console) -->
<script>
(function(){
  var URL_=${JSON.stringify(url)}, TOK=${JSON.stringify(token)}, buf=[], n=0, timer=null;
  function flush(beacon){
    if(!buf.length) return;
    var body=JSON.stringify({producer:"browser",events:buf.splice(0,buf.length)});
    if(beacon && navigator.sendBeacon){ navigator.sendBeacon(URL_+"?k="+TOK, new Blob([body],{type:"application/json"})); return; }
    fetch(URL_,{method:"POST",headers:{"content-type":"application/json","x-dbg-token":TOK},body:body,keepalive:true}).catch(function(){});
  }
  window.__dbg=function(label,data){
    buf.push({s:++n,t:performance.timeOrigin+performance.now(),n:label,d:data});
    if(buf.length>=64) flush(); else if(!timer) timer=setTimeout(function(){timer=null;flush();},200);
    return false;
  };
  window.addEventListener("pagehide",function(){flush(true);});
  window.addEventListener("error",function(e){__dbg("uncaught",{message:e.message,src:e.filename+":"+e.lineno});});
  window.addEventListener("unhandledrejection",function(e){__dbg("unhandledrejection",{reason:String(e.reason)});});
})();
</script>
<!-- then call: __dbg("checkout:submit", {cartId: id, total}) -->`;
}

function shSnippet(url, token) {
  return `# --- dbg producer for shell scripts ---
DBG_URL=${JSON.stringify(url)}; DBG_TOKEN=${JSON.stringify(token)}; DBG_N=0
dbg() {
  DBG_N=$((DBG_N+1))
  curl -sS -m 2 -X POST "$DBG_URL" \\
    -H 'content-type: application/json' -H "x-dbg-token: $DBG_TOKEN" \\
    -d "{\\"producer\\":\\"sh\\",\\"s\\":$DBG_N,\\"n\\":\\"$1\\",\\"d\\":{\\"v\\":\\"\${2//\\"/\\\\\\"}\\"}}" >/dev/null 2>&1 || true
}
# usage:  dbg "migrate:start" "$TABLE"`;
}

function nodeSnippet(url, token) {
  return `// --- dbg producer for a node process you cannot attach to ---
// Prefer: dbg attach --pid <pid>   (no code changes at all)
const DBG_URL=${JSON.stringify(url)}, DBG_TOKEN=${JSON.stringify(token)};
let __n=0, __buf=[], __t=null;
function __flush(){ if(!__buf.length) return;
  const body=JSON.stringify({producer:"node:"+process.pid,events:__buf.splice(0,__buf.length)});
  fetch(DBG_URL,{method:"POST",headers:{"content-type":"application/json","x-dbg-token":DBG_TOKEN},body}).catch(()=>{});
}
globalThis.__dbg=(label,data)=>{ __buf.push({s:++__n,t:Date.now(),n:label,d:data});
  if(__buf.length>=64) __flush(); else if(!__t){__t=setTimeout(()=>{__t=null;__flush();},200); __t.unref&&__t.unref();}
  return false; };
process.on("exit",__flush);
// usage: __dbg("order:entry", {orderId, qty})`;
}

// Does this file already have something that defines the recorder the probes
// call? Used to warn instead of letting the next run die on a NameError.
function hasRecorder(src) {
  return /_dbg_q|__dbgAgentInstalled|globalThis\.__dbg\s*=|def dbg\(|function dbg\(|const dbg\s*=|DBG_URL/.test(src);
}

function definesRecorder(cwd, file) {
  try { return hasRecorder(fs.readFileSync(path.resolve(cwd, file), 'utf8')); }
  catch { return true; }   // unreadable: say nothing rather than nag
}

module.exports = { MARK, MARK_HASH, verify, strip, add, snippet, walk, definesRecorder, hasRecorder };
