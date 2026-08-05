#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

const store = require('../lib/store');
const query = require('../lib/query');
const fmt = require('../lib/fmt');
const har = require('../lib/har');
const diff = require('../lib/diff');
const probe = require('../lib/probe');
const { CDP } = require('../lib/cdp');
const { freePort, waitForFile, parseArgs, asArray, num, sleep } = require('../lib/util');

const VERSION = '3.0.0';
const CWD = process.cwd();

const BOOLS = ['bg', 'snapshot', 'snap', 'no-console', 'network', 'net', 'brk', 'no-brk', 'help', 'json',
  'last', 'follow', 'quiet', 'until-fail', 'all', 'force', 'dry-run', 'verbose'];
const ALIAS = { n: 'limit', r: 'run', l: 'label', o: 'out', e: 'expr', h: 'help', v: 'version' };

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1), { bools: BOOLS, alias: ALIAS });
  if (!cmd || cmd === 'help' || args.help) return void console.log(usage(argv[1]));
  if (cmd === '--version' || cmd === 'version') return void console.log(VERSION);

  const handlers = {
    run: cmdRun, attach: cmdAttach, sink: cmdSink, stop: cmdStop, status: cmdStatus,
    lp: cmdLp, eval: cmdEval,
    stats: cmdStats, tail: cmdTail, head: cmdHead, where: cmdWhere, timeline: cmdTimeline,
    trace: cmdTimeline, around: cmdAround, show: cmdShow, slow: cmdSlow, net: cmdNet,
    runs: cmdRuns, diff: cmdDiff, clean: cmdClean,
    import: cmdImport, export: cmdExport,
    probe: cmdProbe, snippet: cmdSnippet, repeat: cmdRepeat,
    exec: cmdExec, env: cmdEnv, scripts: cmdScripts,
  };
  const h = handlers[cmd];
  if (!h) {
    console.error(`unknown command: ${cmd}\n`);
    console.error(usage());
    process.exit(2);
  }
  await h(args);
}

// ---------------------------------------------------------------- sessions

function session() {
  const s = store.readSession(CWD);
  if (!s) throw new Error('no active recorder. start one with:  dbg run <cmd>  |  dbg attach --pid <pid>  |  dbg sink');
  return s;
}

async function control(pathname, opts = {}) {
  const s = opts.session || session();
  const url = `http://127.0.0.1:${s.controlPort}${pathname}`;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'content-type': 'application/json', 'x-dbg-token': s.token },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeout || 20000),
  }).catch((e) => { throw new Error(`recorder not reachable on :${s.controlPort} (${e.message}). It may have exited — try: dbg status`); });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok && body.error) throw new Error(body.error);
  return body;
}

async function alive() {
  const s = store.readSession(CWD);
  if (!s) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${s.controlPort}/health`, { signal: AbortSignal.timeout(1200) });
    return r.ok ? s : null;
  } catch { return null; }
}

async function launchDaemon(cfg) {
  const readyFile = path.join(os.tmpdir(), `dbg-ready-${process.pid}-${Date.now()}.json`);
  const full = { cwd: CWD, readyFile, ...cfg };
  const payload = Buffer.from(JSON.stringify(full)).toString('base64');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'daemon-main.js'), payload], {
    cwd: CWD,
    detached: true,
    stdio: ['ignore', 'ignore', fs.openSync(path.join(os.tmpdir(), 'dbg-daemon.log'), 'a')],
  });
  child.unref();
  const ready = await waitForFile(readyFile, 15000).catch(() => {
    throw new Error(`recorder failed to start — see ${path.join(os.tmpdir(), 'dbg-daemon.log')}`);
  });
  try { fs.unlinkSync(readyFile); } catch {}
  if (!ready.ok) throw new Error(ready.error || 'recorder failed to start');
  return ready;
}

function parseLpSpec(spec, extra = {}) {
  // "src/a.js:42" or "src/a.js:42 orderId qty" or "src/a.js:42:11"
  const s = String(spec).trim();
  const m = s.match(/^(.+?):(\d+)(?::(\d+))?(?:\s+(.*))?$/);
  if (!m) throw new Error(`bad logpoint "${spec}" — expected file:line [expr ...]`);
  const exprs = m[4] ? splitExprs(m[4]) : [];
  return { file: m[1], line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, exprs, ...extra };
}

// Split a capture list into expressions, keeping brackets and strings intact.
// Commas win when present: splitting on spaces too would tear `typeof x` or
// `a === b` in half and produce a condition that fails to compile — which V8
// reports as nothing at all, so the probe just silently never fires.
function splitExprs(s) {
  const parts = [];
  let depth = 0, cur = '', q = null, sawComma = false;
  const flush = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (depth === 0 && ch === ',') { sawComma = true; flush(); continue; }
    cur += ch;
  }
  flush();
  if (sawComma) return parts;
  // no commas: treat whitespace as the separator, but only between things that
  // each parse on their own (so a bare `typeof x` stays one expression)
  const single = parts[0] || '';
  const words = single.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words;
  return words.every(isSimpleRef) ? words : [single];
}

function isSimpleRef(w) {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\[[^\]]*\])*$/.test(w);
}

// ---------------------------------------------------------------- commands

async function cmdRun(args) {
  const rest = args.rest && args.rest.length ? args.rest : args._;
  if (!rest.length) throw new Error('nothing to run.  usage: dbg run [opts] -- <command>');
  const existing = await alive();
  if (existing) throw new Error(`a recorder is already running (run ${existing.runId}). Stop it first: dbg stop`);

  const port = await freePort();
  const controlPort = await freePort();
  const token = crypto.randomBytes(12).toString('hex');
  const cmd = rest[0];
  const cmdArgs = rest.slice(1);
  const brk = !args['no-brk'];
  const isNode = /(^|\/)(node|nodejs)$/.test(cmd);

  // The target needs to know where to send events before the recorder is up,
  // so the port and token are minted here rather than inside the daemon.
  const env = {
    DBG: '1',
    DBG_URL: `http://127.0.0.1:${controlPort}/e`,
    DBG_TOKEN: token,
  };
  const wantAgent = !!(args.agent || args['trace-http'] || args.network || args.net);
  const preload = wantAgent ? ` --require ${JSON.stringify(path.join(__dirname, '..', 'agents', 'node-preload.js'))}` : '';

  let spawnCmd = cmd, spawnArgs = cmdArgs;
  if (isNode) {
    spawnArgs = [`--inspect${brk ? '-brk' : ''}=${port}`, ...cmdArgs];
    if (wantAgent) spawnArgs.unshift('--require', path.join(__dirname, '..', 'agents', 'node-preload.js'));
  } else {
    // Works for tsx/ts-node/vitest wrappers, but binds to the FIRST node
    // process started — which for npm/yarn/pnpm is the package manager, not
    // your app. Prefer `dbg attach --pid` for those.
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --inspect${brk ? '-brk' : ''}=${port}${preload}`.trim();
  }

  const logpoints = asArray(args.lp).map((s) => parseLpSpec(s, {
    snapshot: !!(args.snapshot || args.snap), max: num(args.max, undefined), when: args.when,
  }));

  const cfg = {
    mode: 'run', port, brk, kind: 'node', controlPort, token,
    label: args.label, cmd: [cmd, ...cmdArgs].join(' '),
    spawn: { cmd: spawnCmd, args: spawnArgs },
    env, logpoints,
    network: !!(args.network || args.net),
    console: !args['no-console'],
    cap: num(args.cap, 20000),
    exitWithChild: true,
  };

  // stdout/stderr of the target go to the run dir so `dbg run` never floods
  // the terminal; foreground mode streams it back.
  const ready = await launchDaemon({ ...cfg, logFile: null });
  const runDir = store.runDir(CWD, ready.run);
  const outLog = path.join(runDir, 'output.log');

  if (args.bg) {
    console.log(`recording run ${ready.run}  (pid ${ready.childPid}, inspector :${port})`);
    if (ready.attachError) console.log(`note: could not attach a JS inspector (${ready.attachError}) — sink-only mode`);
    console.log(`  add probes : dbg lp add 'file.js:42 someVar'`);
    console.log(`  see events : dbg stats | dbg tail`);
    console.log(`  stop       : dbg stop`);
    return;
  }

  // foreground: wait for the recorder to exit (it exits with the child)
  const s = store.readSession(CWD);
  process.stdout.write(`recording run ${ready.run}…\n`);
  await waitForDaemonExit(s);
  const meta = store.readMeta(CWD, ready.run);
  if (fs.existsSync(outLog)) {
    const out = fs.readFileSync(outLog, 'utf8');
    if (out.trim()) {
      const lines = out.split('\n');
      const cap = num(args.output, 40);
      process.stdout.write(`--- target output (${lines.length} lines) ---\n`);
      process.stdout.write(lines.slice(-cap).join('\n'));
      if (lines.length > cap) process.stdout.write(`\n(… ${lines.length - cap} earlier lines in ${path.relative(CWD, outLog)})\n`);
      process.stdout.write('\n');
    }
  }
  console.log('');
  console.log(query.stats(CWD, { run: ready.run }));
  // Propagate the target's outcome: `dbg run -- npm test` must be usable in a
  // script or CI step, where swallowing a failure is worse than useless.
  if (meta.exitCode) process.exitCode = meta.exitCode;
  else if (meta.signal) process.exitCode = 1;
}

async function waitForDaemonExit(s, timeoutMs = 0) {
  const start = Date.now();
  for (;;) {
    await sleep(200);
    let ok = false;
    try {
      const r = await fetch(`http://127.0.0.1:${s.controlPort}/health`, { signal: AbortSignal.timeout(800) });
      ok = r.ok;
    } catch { ok = false; }
    if (!ok) return;
    if (timeoutMs && Date.now() - start > timeoutMs) return;
  }
}

async function cmdAttach(args) {
  const existing = await alive();
  if (existing) throw new Error(`a recorder is already running (run ${existing.runId}). Stop it first: dbg stop`);

  let port = num(args.port, null);
  let kind = 'node';
  if (args.pid) {
    // Node can be told to open an inspector after the fact, so an already
    // running dev server does not have to be restarted.
    port = port || 9229;
    try {
      CDP.openInspector(args.pid, port);
      await CDP.waitForPort(port, 6000);
    } catch (e) {
      throw new Error(`could not open an inspector on pid ${args.pid}: ${e.message}\n`
        + '(works for Node processes; for Chrome start it with --remote-debugging-port=9222 and use --port)');
    }
  }
  if (args.chrome) { port = port || 9222; kind = 'chrome'; }
  if (!port) port = 9229;
  if (args.chrome || port === 9222) kind = 'chrome';

  const targets = await CDP.targets(port).catch((e) => {
    throw new Error(`nothing to attach to on :${port} — ${e.message}\n`
      + 'start the target with:  node --inspect=PORT app.js   |   chrome --remote-debugging-port=9222\n'
      + 'or point at a running node process with:  dbg attach --pid <pid>');
  });

  const logpoints = asArray(args.lp).map((s) => parseLpSpec(s, {
    snapshot: !!(args.snapshot || args.snap), max: num(args.max, undefined), when: args.when,
  }));

  const ready = await launchDaemon({
    mode: 'attach', port, kind, target: args.target, label: args.label,
    pid: args.pid ? Number(args.pid) : null,
    network: !!(args.network || args.net) || kind === 'chrome',
    console: !args['no-console'],
    cap: num(args.cap, 20000),
    logpoints,
    exitOnDetach: false,
  });

  const st = await control('/status');
  const t = (st.live && st.live.target) || {};
  console.log(`attached to ${kind} target: ${fmt.clip(t.title || t.url || 'unknown', 70)}`);
  console.log(`recording run ${ready.run}  (${targets.length} target${targets.length === 1 ? '' : 's'} on :${port})`);
  if (logpoints.length) console.log(`installed ${logpoints.length} logpoint(s)`);
  console.log(`  add probes : dbg lp add 'file.js:42 someVar'`);
  console.log(`  see events : dbg stats | dbg tail`);
  console.log(`  stop       : dbg stop   (removes all probes)`);
}

async function cmdSink(args) {
  const existing = await alive();
  if (existing) throw new Error(`a recorder is already running (run ${existing.runId}). Stop it first: dbg stop`);
  const ready = await launchDaemon({
    mode: 'sink', label: args.label, controlPort: num(args.port, 0),
  });
  const s = store.readSession(CWD);
  console.log(`sink listening on http://127.0.0.1:${s.controlPort}/e   run ${ready.run}`);
  console.log(`token ${s.token}`);
  console.log('');
  console.log('producer snippets:  dbg snippet python | browser | shell | node');
}

async function cmdStop(args) {
  const s = await alive();
  if (!s) {
    store.clearSession(CWD);
    return void console.log('no recorder running');
  }
  const r = await control('/stop', { method: 'POST', session: s }).catch(() => ({}));
  console.log(`stopped. run ${r.run || s.runId} captured ${r.events != null ? r.events : '?'} events`);
  console.log(`inspect with: dbg stats`);
}

async function cmdStatus(args) {
  const s = await alive();
  if (!s) {
    const last = store.currentRun(CWD);
    return void console.log(`no recorder running.${last ? ` last run: ${last} (dbg stats)` : ''}`);
  }
  const st = await control('/status');
  const out = [`recorder pid ${st.pid} · run ${st.run} · ${st.events} events · up ${fmt.dur(st.uptimeMs)} · mode ${st.mode}`];
  if (st.live) {
    const t = st.live.target || {};
    out.push(`target ${st.live.kind}: ${fmt.clip(t.title || t.url || '?', 70)}  buffered=${st.live.buffered ?? '?'}`);
    if (st.live.logpoints && st.live.logpoints.length) {
      out.push('logpoints:');
      for (const l of st.live.logpoints) {
        out.push(`  ${fmt.pad(l.id, 5)} ${fmt.pad(l.label, 28)} hits=${fmt.padl(l.hits || 0, 6)}${l.bound ? '' : '  UNBOUND (file/line never loaded)'}${l.snapshot ? '  [snapshot]' : ''}${l.when ? '  when=' + l.when : ''}`);
      }
    } else {
      out.push('logpoints: none  (dbg lp add \'file.js:42 var\')');
    }
  }
  console.log(out.join('\n'));
}

async function cmdLp(args) {
  const sub = args._[0];
  if (sub === 'add') {
    const spec = args._.slice(1).join(' ');
    if (!spec) throw new Error("usage: dbg lp add 'src/file.js:42 varA varB' [--when 'i>5'] [--max 20] [--snapshot]");
    const cfg = parseLpSpec(spec, {
      when: args.when, max: num(args.max, args.snapshot || args.snap ? 5 : undefined),
      snapshot: !!(args.snapshot || args.snap), label: args.label, url: args.url,
    });
    const r = await control('/lp', { method: 'POST', body: cfg });
    const bound = r.lp.bound;
    console.log(`${r.lp.id} → ${r.lp.label}${cfg.exprs.length ? ' capturing ' + cfg.exprs.join(', ') : ' (hit counts only)'}`);
    if (!bound) {
      console.log('  warning: not bound to any loaded script yet — it will bind if that file loads later.');
      console.log("  if it never binds, see what URLs the runtime actually has:  dbg scripts");
      console.log("  then target one directly:  dbg lp add '<file>:<line> vars' --url '<regex>'");
    }
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const id = args._[1];
    if (!id) throw new Error('usage: dbg lp rm <id|all>');
    await control(`/lp/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return void console.log(`removed ${id}`);
  }
  if (sub === 'ls' || sub === 'list' || !sub) {
    const r = await control('/lp');
    if (!r.logpoints.length) return void console.log("no logpoints.  add one: dbg lp add 'src/file.js:42 someVar'");
    for (const l of r.logpoints) {
      console.log(`${fmt.pad(l.id, 5)} ${fmt.pad(l.label, 30)} hits=${fmt.padl(l.hits || 0, 6)}${l.bound ? '' : '  UNBOUND'}${l.snapshot ? '  [snapshot]' : ''}${l.when ? '  when=' + l.when : ''}${l.max ? '  max=' + l.max : ''}`);
    }
    return;
  }
  throw new Error('usage: dbg lp add|ls|rm');
}

// What the runtime actually loaded. The answer to "why didn't my probe bind?"
async function cmdScripts(args) {
  const r = await control('/scripts');
  const filter = args._[0];
  let list = r.scripts || [];
  if (filter) list = list.filter((x) => x.url.includes(filter) || new RegExp(filter).test(x.url));
  if (!list.length) {
    return void console.log(filter ? `no loaded scripts matching "${filter}"` : 'no scripts seen yet (has the code run?)');
  }
  list.sort((a, b) => (b.length || 0) - (a.length || 0));
  const n = num(args.limit, 30);
  console.log(`${list.length} script(s) loaded in the target:`);
  for (const x of list.slice(0, n)) {
    console.log(`  ${fmt.padl(x.length != null ? fmt.human(x.length) + 'B' : '-', 8)}  ${x.url}`);
  }
  if (list.length > n) console.log(`  … ${list.length - n} more (dbg scripts <filter>)`);
  console.log("\ntarget one with:  dbg lp add 'anything:<line> vars' --url '<regex matching the url above>'");
}

async function cmdEval(args) {
  const expr = args._.join(' ');
  if (!expr) throw new Error("usage: dbg eval '<expression evaluated inside the live process>'");
  const r = await control('/eval', { method: 'POST', body: { expression: expr } });
  if (!r.ok) return void console.log(`error: ${r.error}`);
  console.log(typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2));
}

// ---- queries ----

function qopts(args) {
  return {
    run: args.run, limit: num(args.limit, undefined), label: args.label,
    producer: args.producer, corr: args.corr, kind: args.kind,
    since: num(args.since, undefined), last: !!args.last, expr: args.expr,
  };
}

async function flushFirst() {
  const s = await alive();
  if (s) { try { await control('/flush', { method: 'POST', session: s }); } catch {} }
}

async function cmdStats(args) { await flushFirst(); console.log(query.stats(CWD, qopts(args))); }
async function cmdTail(args) {
  await flushFirst();
  if (args.follow) return followLoop(args);
  console.log(query.tail(CWD, qopts(args)));
}
async function cmdHead(args) { await flushFirst(); console.log(query.head(CWD, qopts(args))); }
async function cmdTimeline(args) { await flushFirst(); console.log(query.timeline(CWD, qopts(args))); }
async function cmdSlow(args) { await flushFirst(); console.log(query.slow(CWD, qopts(args))); }
async function cmdAround(args) { await flushFirst(); console.log(query.around(CWD, args._[0], qopts(args))); }
async function cmdShow(args) { await flushFirst(); console.log(query.show(CWD, args._[0], qopts(args))); }
async function cmdWhere(args) {
  await flushFirst();
  const expr = args._.join(' ');
  if (!expr) throw new Error("usage: dbg where '<js predicate>'   e.g.  dbg where 'd.qty > 10'   dbg where 'n.includes(\"entry\")'");
  console.log(query.where(CWD, expr, qopts(args)));
}

async function followLoop(args) {
  let since = 0;
  const t0 = Date.now();
  for (;;) {
    await flushFirst();
    const { events } = query.load(CWD, args.run);
    const fresh = events.filter((e) => e.q > since);
    if (fresh.length) {
      since = fresh[fresh.length - 1].q;
      console.log(fmt.listing(fresh.slice(-50), { total: fresh.length, t0: query.t0of(events) }));
    }
    if (args.for && Date.now() - t0 > num(args.for, 0) * 1000) return;
    await sleep(500);
  }
}

async function cmdNet(args) {
  await flushFirst();
  const { id, events } = query.load(CWD, args.run);
  const nets = query.filterEvents(events, { ...qopts(args), kind: 'net' })
    .filter((e) => e.d && (e.d.status != null || e.d.error));
  if (!nets.length) {
    return void console.log(`run ${id}: no network events.\n`
      + 'capture them with:  dbg attach --chrome --net   |   dbg run --net -- node app.js   |   dbg import <file.har>');
  }
  const n = num(args.limit, 25);
  const failed = nets.filter((e) => !e.d.status || e.d.status >= 400 || e.d.error);
  const list = args.all ? nets : (failed.length ? failed : nets);
  const rows = list.slice(0, n).map((e) => {
    const d = e.d || {};
    const status = d.error ? `ERR` : (d.status || '---');
    return `${fmt.padl(e.q, 5)} ${fmt.pad(d.method || '?', 6)} ${fmt.padl(status, 4)} ${fmt.padl(d.ms != null ? fmt.dur(d.ms) : '-', 9)} ${fmt.padl(d.size != null ? fmt.human(d.size) + 'B' : '-', 8)}  ${fmt.clip(d.url || '', 62)}${d.error ? '  ' + d.error : ''}${d.cors ? '  CORS:' + d.cors : ''}`;
  });
  const out = [
    `run ${id} · ${nets.length} requests · ${failed.length} failed/4xx/5xx${args.all ? '' : failed.length ? '  (showing failures; --all for everything)' : ''}`,
    `${fmt.padl('#', 5)} ${fmt.pad('method', 6)} ${fmt.padl('code', 4)} ${fmt.padl('time', 9)} ${fmt.padl('size', 8)}  url`,
    ...rows,
  ];
  if (list.length > n) out.push(`… ${list.length - n} more`);
  const withBody = list.slice(0, n).find((e) => e.d && e.d.body);
  if (withBody) out.push(`\nresponse body of #${withBody.q}: ${fmt.clip(String(withBody.d.body).replace(/\s+/g, ' '), 300)}`);
  console.log(out.join('\n'));
}

async function cmdRuns(args) {
  const runs = store.listRuns(CWD);
  if (!runs.length) return void console.log('no recorded runs yet');
  const out = runs.slice(-num(args.limit, 20)).map((r) => {
    const m = r.meta || {};
    return `${fmt.pad(r.id, 34)} ${fmt.padl(r.count, 7)} ev  ${fmt.padl(m.durationMs != null ? fmt.dur(m.durationMs) : '-', 9)}  ${m.exitCode != null ? 'exit=' + m.exitCode : fmt.pad(m.mode || '', 6)}  ${fmt.clip(m.cmd || m.label || '', 46)}`;
  });
  console.log([`${fmt.pad('run', 34)} ${fmt.padl('events', 10)}  ${fmt.padl('dur', 9)}  status  cmd`, ...out].join('\n'));
}

async function cmdDiff(args) {
  const a = args._[0], b = args._[1];
  if (!a) throw new Error('usage: dbg diff <runA> [runB]   (defaults: previous run vs latest)');
  console.log(diff.diffRuns(CWD, a, b, { limit: num(args.limit, 25), values: !args.shape }));
}

async function cmdImport(args) {
  const file = args._[0];
  if (!file) throw new Error('usage: dbg import <file.har>');
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);
  const s = await alive();
  if (s) {
    const r = await control('/import-har', { method: 'POST', body: { file: path.resolve(file) }, session: s });
    return void console.log(`imported ${r.imported} network events into the active run (dbg net)`);
  }
  // no live recorder: create a standalone run from the HAR
  const evs = har.importHar(path.resolve(file));
  const run = store.createRun(CWD, { label: path.basename(file), mode: 'har', cmd: `import ${file}` });
  const w = new store.Writer(CWD, run.id);
  for (const e of evs) w.write(e);
  w.close();
  store.writeMeta(CWD, run.id, { count: evs.length, endedAt: new Date().toISOString() });
  console.log(`imported ${evs.length} requests as run ${run.id}`);
  console.log(query.stats(CWD, { run: run.id }));
}

async function cmdExport(args) {
  const what = args._[0] || 'har';
  await flushFirst();
  const { id, events, meta } = query.load(CWD, args.run);
  if (what === 'har') {
    const doc = har.exportHar(events, { version: VERSION });
    const out = args.out || path.join(store.runDir(CWD, id), 'network.har');
    fs.writeFileSync(out, JSON.stringify(doc, null, 2));
    return void console.log(`wrote ${doc.log.entries.length} requests to ${out}\nopen it in Chrome DevTools → Network → import, or any HAR viewer`);
  }
  if (what === 'jsonl' || what === 'json') {
    const out = args.out || path.join(store.runDir(CWD, id), 'events.export.jsonl');
    fs.writeFileSync(out, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return void console.log(`wrote ${events.length} events to ${out}`);
  }
  throw new Error('usage: dbg export har|jsonl [-o file]');
}

async function cmdClean(args) {
  const s = await alive();
  if (s && !args.force) throw new Error('a recorder is still running — stop it first (dbg stop) or use --force');
  if (s) await control('/stop', { method: 'POST', session: s }).catch(() => {});
  const root = store.root(CWD);
  if (!fs.existsSync(root)) return void console.log('nothing to clean');
  const runs = store.listRuns(CWD);
  if (args.keep !== undefined) {
    const keep = num(args.keep, 3);
    const drop = runs.slice(0, Math.max(0, runs.length - keep));
    for (const r of drop) store.removeRun(CWD, r.id);
    return void console.log(`removed ${drop.length} run(s), kept ${Math.min(keep, runs.length)}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`removed ${root} (${runs.length} run(s))`);
  const left = probe.verify(CWD, args.path || '.');
  if (left.length) {
    console.log(`\nWARNING: ${left.length} source probe(s) still in your code — remove with: dbg probe strip`);
    for (const l of left.slice(0, 10)) console.log(`  ${l.file}:${l.line}`);
  }
}

async function cmdProbe(args) {
  const sub = args._[0];
  if (sub === 'add') {
    const spec = args._.slice(1).join(' ');
    const s = await alive();
    const r = probe.add(CWD, spec, {
      label: args.label,
      url: s ? `http://127.0.0.1:${s.controlPort}/e` : null,
      token: s ? s.token : null,
    });
    console.log(`inserted probe at ${r.file}:${r.line}  (marked ${r.mark} — remove all with: dbg probe strip)`);
    if (r.addedRecorder) {
      console.log(`  also inserted the ${r.lang === 'py' ? 'python' : 'node'} recorder at the top of ${r.file} (same marker, removed by the same strip)`);
      console.log(`  run the program normally — events land in the active recording (dbg tail)`);
    }
    // The inserted line calls a recorder the program does not define yet.
    // Without this the next run dies on NameError/ReferenceError, which reads
    // like the tool is broken rather than like a missing step.
    if (!r.addedRecorder && !probe.definesRecorder(CWD, r.file)) {
      // no recorder in the file and no sink to point one at
      console.log(`\nthat file has no recorder and no sink is running — the probe would throw.`);
      console.log(`  dbg sink                     # start one, then re-add the probe`);
    }
    return;
  }
  if (sub === 'strip') {
    const r = probe.strip(CWD, args.path || '.', { dryRun: !!args['dry-run'] });
    console.log(`${args['dry-run'] ? 'would remove' : 'removed'} ${r.removed} probe line(s) across ${r.files} file(s)`);
    return;
  }
  if (sub === 'verify' || !sub) {
    const left = probe.verify(CWD, args.path || '.');
    if (!left.length) return void console.log('clean: no debug probes left in source');
    console.log(`${left.length} probe(s) still present:`);
    for (const l of left.slice(0, 40)) console.log(`  ${l.file}:${l.line}`);
    process.exitCode = 1;
    return;
  }
  throw new Error('usage: dbg probe add|strip|verify');
}

async function cmdSnippet(args) {
  const kind = args._[0] || 'python';
  const s = store.readSession(CWD);
  if (!s) throw new Error('start a recorder first: dbg sink  (or dbg run / dbg attach)');
  const url = `http://127.0.0.1:${s.controlPort}/e`;
  console.log(probe.snippet(kind, url, s.token));
}

async function cmdRepeat(args) {
  const rest = args.rest && args.rest.length ? args.rest : args._;
  if (!rest.length) throw new Error("usage: dbg repeat -N --until-fail -- <command>    e.g. dbg repeat -n 20 --until-fail -- node test.js");
  const times = num(args.limit, 10);
  const untilFail = !!args['until-fail'];
  const results = [];
  console.log(`running ${times}× ${untilFail ? 'or until failure ' : ''}: ${rest.join(' ')}`);
  for (let i = 1; i <= times; i++) {
    const existing = await alive();
    if (existing) await control('/stop', { method: 'POST', session: existing }).catch(() => {});
    const port = await freePort();
    const isNode = /(^|\/)(node|nodejs)$/.test(rest[0]);
    const spawnArgs = isNode ? [`--inspect-brk=${port}`, ...rest.slice(1)] : rest.slice(1);
    const env = isNode ? { DBG: '1' } : { DBG: '1', NODE_OPTIONS: `--inspect-brk=${port}` };
    const logpoints = asArray(args.lp).map((sp) => parseLpSpec(sp, { when: args.when, max: num(args.max, undefined), snapshot: !!(args.snapshot || args.snap) }));
    const ready = await launchDaemon({
      mode: 'run', port, brk: true, kind: 'node', label: `iter${i}`,
      cmd: rest.join(' '), spawn: { cmd: rest[0], args: spawnArgs }, env,
      logpoints, network: !!(args.network || args.net), cap: num(args.cap, 20000), exitWithChild: true,
    });
    const s = store.readSession(CWD);
    await waitForDaemonExit(s);
    const meta = store.readMeta(CWD, ready.run);
    const failed = meta.exitCode !== 0;
    results.push({ run: ready.run, exit: meta.exitCode, events: meta.count || 0, failed });
    console.log(`  ${fmt.padl(i, 3)}/${times}  run ${ready.run}  exit=${meta.exitCode}  ${meta.count || 0} events${failed ? '   <-- FAILED' : ''}`);
    if (failed && untilFail) break;
  }
  const bad = results.filter((r) => r.failed);
  const good = results.filter((r) => !r.failed);
  console.log('');
  console.log(`${results.length} iterations · ${bad.length} failed · ${good.length} passed`);
  if (bad.length && good.length) {
    console.log(`\ncompare a failing run against a passing one:`);
    console.log(`  dbg diff ${good[good.length - 1].run} ${bad[bad.length - 1].run}`);
    console.log('');
    console.log(diff.diffRuns(CWD, good[good.length - 1].run, bad[bad.length - 1].run, { limit: 15, values: true }));
  } else if (!bad.length) {
    console.log('no failures reproduced — raise -n, or add --lp probes to capture more state.');
  }
}

// Run another process INTO the active recording, so a client, a worker or a
// second service lands on the same timeline as the target already being
// recorded. This is what makes cross-process traces possible.
async function cmdExec(args) {
  const rest = args.rest && args.rest.length ? args.rest : args._;
  if (!rest.length) throw new Error('usage: dbg exec -- <command>   (runs it into the active recording)');
  const s = await alive();
  if (!s) throw new Error('no active recorder — start one first (dbg run --bg / dbg sink)');
  const preloadPath = path.join(__dirname, '..', 'agents', 'node-preload.js');
  const env = {
    ...process.env,
    DBG: '1',
    DBG_URL: `http://127.0.0.1:${s.controlPort}/e`,
    DBG_TOKEN: s.token,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${preloadPath}`.trim(),
  };
  const child = spawn(rest[0], rest.slice(1), { stdio: 'inherit', env });
  const code = await new Promise((res) => child.on('exit', res));
  await control('/flush', { method: 'POST', session: s }).catch(() => {});
  if (code) process.exitCode = code;
}

async function cmdEnv(args) {
  const s = await alive();
  if (!s) throw new Error('no active recorder — start one first (dbg run --bg / dbg sink)');
  const preloadPath = path.join(__dirname, '..', 'agents', 'node-preload.js');
  console.log(`export DBG_URL=http://127.0.0.1:${s.controlPort}/e`);
  console.log(`export DBG_TOKEN=${s.token}`);
  console.log(`export NODE_OPTIONS="$NODE_OPTIONS --require ${preloadPath}"   # node targets only`);
}

// ---------------------------------------------------------------- usage

function usage(topic) {
  return `dbg ${VERSION} — a flight recorder for debugging, built for agents.

Record, then interrogate. Nothing dumps unbounded output into your context.

CAPTURE
  dbg run [--lp 'f.js:42 x'] -- <cmd>   run a program under the recorder (pauses at
                                        start so probes bind before any code runs)
  dbg run --bg -- <cmd>                 same, but leave it running (servers)
  dbg attach --pid <pid>                attach to an ALREADY RUNNING node process
                                        (no restart, no source edits)
  dbg attach --chrome [--net]           attach to Chrome (--remote-debugging-port=9222)
  dbg sink                              just listen; for python/shell/browser producers
  dbg exec -- <cmd>                     run another process INTO the active recording
                                        (this is how you get cross-process traces)
  dbg env                               same, as env vars you can export yourself
  dbg stop                              stop, remove every probe, finalise the run

PROBES (zero source edits, on a live process)
  dbg lp add 'src/a.js:42 orderId, qty' capture expressions each time line 42 runs
  dbg lp add 'src/a.js:42' --snapshot   capture the ENTIRE local+closure scope
  dbg lp add '...' --when 'i>5' --max 20  only when true; stop after N hits
  dbg lp ls | dbg lp rm <id|all>
  dbg lp add '...' --url '<regex>'      target bundled/transpiled/inline scripts
  dbg scripts [filter]                  what the runtime actually loaded
                                        (start here when a probe won't bind)
  dbg eval '<expr>'                     evaluate inside the live process right now

READ  (all bounded; start with stats)
  dbg stats                             what happened: errors, labels, gaps, traces
  dbg tail [-n 20] [--follow]           latest events
  dbg where 'd.qty > 10'                filter with a JS predicate over event data
  dbg timeline [--corr <id>]            merged, cross-process, in execution order
  dbg around <#> | dbg show <#>         context around / full detail of one event
  dbg slow                              spans ranked by duration
  dbg net [--all]                       requests; failures first
  dbg runs | dbg diff <runA> <runB>     list runs / first divergence between two

NETWORK
  dbg import <file.har>                 merge a DevTools/Charles/mitmproxy HAR
  dbg export har [-o out.har]           write captured traffic back out as HAR

FLAKY BUGS
  dbg repeat -n 20 --until-fail -- <cmd>   run until it fails, then diff a passing
                                           run against the failing one automatically

FALLBACK (when the runtime has no inspector)
  dbg snippet python|browser|shell|node    producer to paste in
  dbg probe add 'f.py:42 x' / strip / verify   marked source edits, guaranteed removable

Filters accepted by most read commands:
  --run <id|-2|last>  --limit/-n N  --label <regex>  --producer <s>  --corr <id>  --kind <k>
`;
}

main().catch((e) => {
  console.error(`dbg: ${e.message}`);
  process.exit(1);
});
