'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT_NAME = '.claude-debug';

function root(cwd = process.cwd()) {
  return path.join(cwd, ROOT_NAME);
}
function runsDir(cwd) { return path.join(root(cwd), 'runs'); }
function sessionFile(cwd) { return path.join(root(cwd), 'session.json'); }

function ensure(cwd) {
  fs.mkdirSync(runsDir(cwd), { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask (and ignored if the dir already exists),
  // so set it explicitly: this directory holds the control token.
  for (const dir of [root(cwd), runsDir(cwd)]) {
    try { fs.chmodSync(dir, 0o700); } catch {}
  }
  const gi = path.join(root(cwd), '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  return root(cwd);
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function newRunId(label) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = crypto.randomBytes(2).toString('hex');
  return `${stamp}-${rand}${label ? '-' + String(label).replace(/[^\w.-]+/g, '_').slice(0, 24) : ''}`;
}

function createRun(cwd, meta = {}) {
  ensure(cwd);
  const id = newRunId(meta.label);
  const dir = path.join(runsDir(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  const m = {
    id,
    startedAt: new Date().toISOString(),
    cwd,
    host: os.hostname(),
    ...meta,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(m, null, 2));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
  return { id, dir, meta: m };
}

function runDir(cwd, id) { return path.join(runsDir(cwd), id); }

function listRuns(cwd) {
  const d = runsDir(cwd);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d)
    .filter((f) => fs.existsSync(path.join(d, f, 'meta.json')))
    .sort()
    .map((id) => {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(d, id, 'meta.json'), 'utf8')); } catch {}
      let size = 0, count = 0;
      try {
        const p = path.join(d, id, 'events.jsonl');
        size = fs.statSync(p).size;
        count = meta.count != null ? meta.count : countLines(p);
      } catch {}
      return { id, dir: path.join(d, id), meta, size, count };
    });
}

function countLines(p) {
  try {
    const buf = fs.readFileSync(p);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch { return 0; }
}

function currentRun(cwd) {
  const s = readSession(cwd);
  if (s && s.runId && fs.existsSync(runDir(cwd, s.runId))) return s.runId;
  const runs = listRuns(cwd);
  return runs.length ? runs[runs.length - 1].id : null;
}

function resolveRun(cwd, spec) {
  if (!spec || spec === 'current' || spec === 'last') return currentRun(cwd);
  const runs = listRuns(cwd);
  if (/^-?\d+$/.test(spec)) {
    const n = Math.abs(parseInt(spec, 10));
    return runs.length >= n ? runs[runs.length - n].id : null;
  }
  const exact = runs.find((r) => r.id === spec);
  if (exact) return exact.id;
  const partial = runs.filter((r) => r.id.includes(spec));
  return partial.length ? partial[partial.length - 1].id : null;
}

// ---- writing -------------------------------------------------------------

class Writer {
  constructor(cwd, runId) {
    this.path = path.join(runDir(cwd, runId), 'events.jsonl');
    this.fd = fs.openSync(this.path, 'a');
    this.buf = [];
    this.bytes = 0;
    this.timer = null;
    this.written = 0;
  }
  write(ev) {
    this.buf.push(JSON.stringify(ev));
    this.written++;
    if (this.buf.length >= 256) return this.flush();
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 50);
      if (this.timer.unref) this.timer.unref();
    }
  }
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buf.length) return;
    const data = this.buf.join('\n') + '\n';
    this.buf.length = 0;
    try { fs.writeSync(this.fd, data); } catch {}
  }
  close() {
    this.flush();
    try { fs.closeSync(this.fd); } catch {}
  }
}

// ---- reading -------------------------------------------------------------

function readEvents(cwd, runId) {
  const p = path.join(runDir(cwd, runId), 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  let q = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    ev.q = ++q;
    out.push(ev);
  }
  return out.sort(cmp);
}

// Ordering. A sequence number is only meaningful against others from the same
// counter, so it is authoritative just when the producer AND the origin of the
// sequence match (`o`: 't' = assigned inside the target, 'd' = assigned by the
// recorder). Everything else falls back to wall clock. Mixing the two spaces
// silently reorders the timeline, which is worse than having no order at all.
function cmp(a, b) {
  if (a.p === b.p && a.o === b.o) return (a.s || 0) - (b.s || 0);
  const dt = (a.t || 0) - (b.t || 0);
  if (dt) return dt;
  return String(a.p).localeCompare(String(b.p)) || (a.s || 0) - (b.s || 0);
}

function readMeta(cwd, runId) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir(cwd, runId), 'meta.json'), 'utf8')); } catch { return {}; }
}
function writeMeta(cwd, runId, patch) {
  const m = { ...readMeta(cwd, runId), ...patch };
  try { fs.writeFileSync(path.join(runDir(cwd, runId), 'meta.json'), JSON.stringify(m, null, 2)); } catch {}
  return m;
}

function readSession(cwd) {
  try { return JSON.parse(fs.readFileSync(sessionFile(cwd), 'utf8')); } catch { return null; }
}
function writeSession(cwd, s) {
  ensure(cwd);
  // Holds the control token, which grants arbitrary evaluation inside the
  // attached process. Owner-only, and chmod explicitly because the mode
  // argument is ignored when the file already exists.
  const f = sessionFile(cwd);
  fs.writeFileSync(f, JSON.stringify(s, null, 2), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch {}
  return s;
}
function clearSession(cwd) {
  try { fs.unlinkSync(sessionFile(cwd)); } catch {}
}

function removeRun(cwd, id) {
  try { fs.rmSync(runDir(cwd, id), { recursive: true, force: true }); } catch {}
}

module.exports = {
  ROOT_NAME, root, runsDir, ensure, createRun, runDir, listRuns, currentRun, resolveRun,
  Writer, readEvents, readMeta, writeMeta, readSession, writeSession, clearSession, removeRun, cmp,
};
