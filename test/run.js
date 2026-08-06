#!/usr/bin/env node
'use strict';
// Regression suite. No dependencies, no test framework: `node test/run.js`.
// Every end-to-end case drives the real CLI against a real buggy program.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const DBG = path.join(ROOT, 'bin', 'dbg.js');
let pass = 0, fail = 0;
const failures = [];
const pending = [];

function test(name, fn) {
  const t0 = Date.now();
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(
        () => { pass++; console.log(`  ok   ${name}  (${Date.now() - t0}ms)`); },
        (e) => { fail++; failures.push({ name, e }); console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }));
      return;
    }
    pass++;
    console.log(`  ok   ${name}  (${Date.now() - t0}ms)`);
  } catch (e) {
    fail++;
    failures.push({ name, e });
    console.log(`  FAIL ${name}  (${Date.now() - t0}ms)`);
    console.log(`       ${e.message.split('\n')[0]}`);
  }
}

function section(s) { console.log(`\n${s}`); }

function dbg(args, opts = {}) {
  const r = spawnSync(process.execPath, [DBG, ...args], {
    cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeout || 90000,
    env: { ...process.env, DBG_WIDTH: '200' },
  });
  if (r.error) throw r.error;
  return (r.stdout || '') + (r.stderr || '');
}

function tmpdir(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `dbgtest-${name}-`));
  return d;
}

function cleanup(d) {
  try { dbg(['stop'], { cwd: d }); } catch {}
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------- unit

section('unit: value capture');
{
  const { capture, render, shape } = require('../lib/serialize');

  test('circular references do not throw', () => {
    const a = { name: 'a' };
    a.self = a;
    const c = capture(a);
    assert.strictEqual(c.self.__t, 'circular');
  });

  test('errors keep name, message and a bounded stack', () => {
    const c = capture(new TypeError('bad thing'));
    assert.strictEqual(c.__t, 'error');
    assert.strictEqual(c.name, 'TypeError');
    assert.strictEqual(c.message, 'bad thing');
    assert.ok(c.stack.split('\n').length <= 6);
  });

  test('long strings are truncated but report true length', () => {
    const c = capture('x'.repeat(5000));
    assert.strictEqual(c.__t, 'string');
    assert.strictEqual(c.len, 5000);
    assert.ok(c.v.length <= 240);
  });

  test('getters are never invoked', () => {
    let called = false;
    const o = { get boom() { called = true; return 1; } };
    const c = capture(o);
    assert.strictEqual(called, false, 'capture must not trigger getters');
    assert.strictEqual(c.boom.__t, 'getter');
  });

  test('Map and Set survive capture', () => {
    const c = capture({ m: new Map([['k', 1]]), s: new Set([1, 2]) });
    assert.strictEqual(c.m.__t, 'map');
    assert.strictEqual(c.m.entries.k, 1);
    assert.strictEqual(c.s.__t, 'set');
  });

  test('deep nesting is bounded', () => {
    let deep = { v: 0 };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    const json = JSON.stringify(capture(deep));
    assert.ok(json.includes('truncated'), 'expected depth truncation');
    assert.ok(json.length < 2000, `capture should stay small, got ${json.length}`);
  });

  test('render produces a compact one-line form', () => {
    const s = render(capture({ a: 1, b: 'two' }), 100);
    assert.ok(s.includes('a=1'), s);
    assert.ok(!s.includes('\n'), 'render must stay on one line');
  });

  test('shape ignores values so runs can be compared structurally', () => {
    assert.strictEqual(shape(capture({ a: 1 })), shape(capture({ a: 999 })));
    assert.notStrictEqual(shape(capture({ a: 1 })), shape(capture({ b: 1 })));
  });
}

section('unit: logpoint condition building');
{
  const { buildCondition, fileToUrlRegex } = require('../lib/live');

  test('condition always evaluates falsy so execution never pauses', () => {
    const cond = buildCondition({ file: 'a.js', line: 3, exprs: ['x'] }, 'a.js:3');
    const __dbg = (...args) => { __dbg.calls.push(args); return false; };
    __dbg.calls = [];
    __dbg.g = (f) => { try { return f(); } catch { return { __t: 'oos' }; } };
    __dbg.hits = () => 0;
    const x = 42;
    const result = new Function('__dbg', 'x', `return (${cond});`)(__dbg, x);
    assert.strictEqual(result, false, 'a logpoint must never pause the program');
    assert.strictEqual(__dbg.calls[0][1].x, 42);
  });

  test('out-of-scope names degrade to a sentinel instead of killing the probe', () => {
    const cond = buildCondition({ file: 'a.js', line: 3, exprs: ['notDefined'] }, 'a.js:3');
    const __dbg = (...args) => { __dbg.calls.push(args); return false; };
    __dbg.calls = [];
    __dbg.g = (f) => { try { return f(); } catch (e) { return { __t: 'oos', why: e.message }; } };
    __dbg.hits = () => 0;
    const result = new Function('__dbg', `return (${cond});`)(__dbg);
    assert.strictEqual(result, false);
    assert.strictEqual(__dbg.calls[0][1].notDefined.__t, 'oos');
  });

  test('--max stops capture after N hits', () => {
    const cond = buildCondition({ file: 'a.js', line: 3, exprs: [], max: 2 }, 'L');
    let hits = 0;
    const __dbg = () => { hits++; return false; };
    __dbg.g = (f) => f();
    __dbg.w = (f) => { try { return !!f(); } catch { return false; } };
    __dbg.hits = () => hits;
    const run = new Function('__dbg', `return (${cond});`);
    for (let i = 0; i < 10; i++) run(__dbg);
    assert.strictEqual(hits, 2, `expected capture to stop at 2, got ${hits}`);
  });

  test('--when gates capture on a predicate', () => {
    const cond = buildCondition({ file: 'a.js', line: 3, exprs: ['i'], when: 'i % 5 === 0' }, 'L');
    const seen = [];
    const __dbg = (n, d) => { seen.push(d.i); return false; };
    __dbg.g = (f) => f();
    __dbg.w = (f) => { try { return !!f(); } catch { return false; } };
    __dbg.hits = () => 0;
    const run = new Function('__dbg', 'i', `return (${cond});`);
    for (let i = 0; i < 12; i++) run(__dbg, i);
    assert.deepStrictEqual(seen, [0, 5, 10]);
  });

  test('file matching tolerates absolute paths and file:// urls', () => {
    const rx = new RegExp(fileToUrlRegex('src/app.js'));
    assert.ok(rx.test('file:///home/me/proj/src/app.js'));
    assert.ok(rx.test('/proj/src/app.js'));
    assert.ok(!rx.test('/proj/other/app.js'));
  });
}

section('unit: HAR');
{
  const har = require('../lib/har');
  test('import maps a DevTools HAR onto the timeline', () => {
    const d = tmpdir('har');
    const file = path.join(d, 'x.har');
    fs.writeFileSync(file, JSON.stringify({
      log: { version: '1.2', entries: [
        { startedDateTime: '2026-01-01T00:00:00.000Z', time: 12,
          request: { method: 'GET', url: 'https://x.test/a', headers: [{ name: 'x-request-id', value: 'r1' }] },
          response: { status: 500, content: { size: 3, mimeType: 'application/json', text: '{"e":1}' } } },
        { startedDateTime: '2026-01-01T00:00:01.000Z', time: 0,
          request: { method: 'GET', url: 'https://x.test/b', headers: [] },
          response: { status: 0, content: {} } },
      ] },
    }));
    const evs = har.importHar(file);
    assert.strictEqual(evs.length, 2);
    assert.strictEqual(evs[0].k, 'net');
    assert.strictEqual(evs[0].d.status, 500);
    assert.strictEqual(evs[0].c, 'r1', 'should adopt x-request-id as the trace id');
    assert.ok(evs[0].d.body.includes('"e":1'), 'failure bodies are kept');
    assert.strictEqual(evs[1].d.note, 'no response', 'a request that never completed must be called out');
    fs.rmSync(d, { recursive: true, force: true });
  });

  test('export produces a HAR a viewer will accept', () => {
    const doc = har.exportHar([
      { k: 'net', t: Date.parse('2026-01-01T00:00:00Z'), ms: 5, d: { method: 'GET', url: 'https://x.test/a', status: 200 } },
      { k: 'log', t: 1, d: {} },
    ]);
    assert.strictEqual(doc.log.version, '1.2');
    assert.strictEqual(doc.log.entries.length, 1, 'non-network events must not leak into the HAR');
    const e = doc.log.entries[0];
    assert.ok(e.request && e.response && e.timings && e.startedDateTime);
  });
}

// ---------------------------------------------------------------- e2e

section('end-to-end: capture from a real program');
{
  const RACE = `
const balances = new Map([['acct', 100]]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withdraw(acct, amt, who) {
  const cur = balances.get(acct);
  await sleep(5 + (who === 'B' ? 3 : 0));
  if (cur < amt) return { ok: false };
  balances.set(acct, cur - amt);
  return { ok: true };
}
Promise.all([withdraw('acct', 60, 'A'), withdraw('acct', 60, 'B')])
  .then(() => console.log('final', balances.get('acct')));
`;

  test('logpoints capture a race condition with no source edits', () => {
    const d = tmpdir('race');
    try {
      const src = path.join(d, 'bank.js');
      fs.writeFileSync(src, RACE);
      const before = fs.readFileSync(src, 'utf8');
      dbg(['run', '--lp', 'bank.js:8 who, cur, amt', '--', 'node', 'bank.js'], { cwd: d });
      const out = dbg(['where', 'n.includes("bank.js")', '-n', '10'], { cwd: d });
      const reads = [...out.matchAll(/cur=(\d+)/g)].map((m) => m[1]);
      assert.strictEqual(reads.length, 2, `expected 2 captures, got ${reads.length}\n${out}`);
      assert.deepStrictEqual(reads, ['100', '100'], 'both writers must be seen reading the same stale balance');
      assert.strictEqual(fs.readFileSync(src, 'utf8'), before, 'source must be untouched');
    } finally { cleanup(d); }
  });

  test('snapshot mode captures the whole scope without naming variables', () => {
    const d = tmpdir('snap');
    try {
      fs.writeFileSync(path.join(d, 'bank.js'), RACE);
      dbg(['run', '--lp', 'bank.js:8', '--snapshot', '--max', '2', '--', 'node', 'bank.js'], { cwd: d });
      const out = dbg(['show', '1'], { cwd: d });
      assert.ok(out.includes('"who"'), `expected locals in snapshot:\n${out}`);
      assert.ok(out.includes('"cur"'), `expected locals in snapshot:\n${out}`);
      assert.ok(out.includes('closure'), `expected closure scope in snapshot:\n${out}`);
    } finally { cleanup(d); }
  });

  test('a crash is captured with its stack', () => {
    const d = tmpdir('crash');
    try {
      fs.writeFileSync(path.join(d, 'boom.js'), `
function inner(x) { return x.missing.deep; }
function outer() { return inner({}); }
setTimeout(outer, 5);
`);
      dbg(['run', '--', 'node', 'boom.js'], { cwd: d });
      const out = dbg(['stats'], { cwd: d });
      assert.ok(/errors\s+\d/.test(out), `expected an error section:\n${out}`);
      assert.ok(out.includes('exit      1'), `expected a non-zero exit:\n${out}`);
    } finally { cleanup(d); }
  });

  test('hot loops stay bounded via --when and --max', () => {
    const d = tmpdir('hot');
    try {
      fs.writeFileSync(path.join(d, 'loop.js'), `
let acc = 0;
for (let i = 0; i < 100000; i++) {
  acc += i;
}
console.log(acc);
`);
      dbg(['run', '--lp', 'loop.js:4 i, acc', '--when', 'i % 20000 === 0', '--max', '4', '--', 'node', 'loop.js'], { cwd: d });
      const out = dbg(['where', 'n.includes("loop.js")', '-n', '20'], { cwd: d });
      const hits = (out.match(/loop\.js:4/g) || []).length;
      assert.ok(hits > 0 && hits <= 4, `expected 1..4 captures from 100k iterations, got ${hits}\n${out}`);
    } finally { cleanup(d); }
  });
}

section('end-to-end: comparing runs');
{
  test('diff finds the first divergence between two runs', () => {
    const d = tmpdir('diff');
    try {
      fs.writeFileSync(path.join(d, 'p.js'), `
const mode = process.env.MODE || 'a';
function step(n) { return n * (mode === 'a' ? 2 : 3); }
let v = 1;
for (let i = 0; i < 3; i++) { v = step(v); }
console.log('v', v);
`);
      dbg(['run', '--label', 'A', '--lp', 'p.js:5 v, i', '--', 'node', 'p.js'], { cwd: d });
      const runA = dbg(['runs'], { cwd: d }).split('\n').filter((l) => l.includes('-A')).pop().split(/\s+/)[0];
      process.env.MODE = 'b';
      dbg(['run', '--label', 'B', '--lp', 'p.js:5 v, i', '--', 'node', 'p.js'], { cwd: d });
      delete process.env.MODE;
      const runB = dbg(['runs'], { cwd: d }).split('\n').filter((l) => l.includes('-B')).pop().split(/\s+/)[0];
      const out = dbg(['diff', runA, runB], { cwd: d });
      assert.ok(out.includes('first divergence'), `expected a divergence:\n${out}`);
      assert.ok(out.includes('differing fields') || out.includes('context'), `expected field-level detail:\n${out}`);
    } finally { cleanup(d); }
  });
}

section('end-to-end: source probes are always removable');
{
  test('probe add then strip restores the file byte for byte', () => {
    const d = tmpdir('probe');
    try {
      const f = path.join(d, 'x.js');
      const original = 'function a(v) {\n  const y = v + 1;\n  return y;\n}\nmodule.exports = a;\n';
      fs.writeFileSync(f, original);
      dbg(['probe', 'add', 'x.js:2 v'], { cwd: d });
      dbg(['probe', 'add', 'x.js:4 y'], { cwd: d });
      const dirty = fs.readFileSync(f, 'utf8');
      assert.notStrictEqual(dirty, original, 'probes should have been inserted');
      const verifyOut = dbg(['probe', 'verify'], { cwd: d });
      assert.ok(verifyOut.includes('x.js:2'), verifyOut);
      dbg(['probe', 'strip'], { cwd: d });
      assert.strictEqual(fs.readFileSync(f, 'utf8'), original, 'strip must restore the original exactly');
      assert.ok(dbg(['probe', 'verify'], { cwd: d }).includes('clean'));
    } finally { cleanup(d); }
  });

  test('python probes use a comment marker python can parse', () => {
    const d = tmpdir('probepy');
    try {
      const f = path.join(d, 'x.py');
      const original = 'def a(v):\n    y = v + 1\n    return y\n';
      fs.writeFileSync(f, original);
      dbg(['probe', 'add', 'x.py:2 v'], { cwd: d });
      const dirty = fs.readFileSync(f, 'utf8');
      assert.ok(dirty.includes('#@dbg'), dirty);
      assert.ok(!dirty.includes('/*@dbg*/'), 'must not put a C comment in python');
      dbg(['probe', 'strip'], { cwd: d });
      assert.strictEqual(fs.readFileSync(f, 'utf8'), original);
    } finally { cleanup(d); }
  });
}

section('end-to-end: non-JS producers');
{
  test('python producer delivers ordered events and catches the crash', () => {
    const py = spawnSync('python3', ['-V'], { encoding: 'utf8' });
    if (py.error) return console.log('       (skipped: no python3)');
    const d = tmpdir('py');
    try {
      dbg(['sink'], { cwd: d });
      const snippet = dbg(['snippet', 'python'], { cwd: d });
      fs.writeFileSync(path.join(d, 'p.py'), `${snippet}
rows = ["1.5", "2.0", {"amount": "3.0"}]
total = 0
for i, r in enumerate(rows):
    dbg("row", i=i, raw=r, kind=type(r).__name__)
    total += float(r)
`);
      spawnSync('python3', ['p.py'], { cwd: d, encoding: 'utf8', timeout: 30000 });
      const out = dbg(['tail', '-n', '10'], { cwd: d });
      assert.ok(out.includes('row'), `expected python events:\n${out}`);
      assert.ok(out.includes('kind="dict"'), `expected the bad row to be visible:\n${out}`);
      assert.ok(out.includes('uncaught'), `expected the crash to be captured:\n${out}`);
    } finally { cleanup(d); }
  });
}

section('end-to-end: output stays bounded');
{
  test('a huge run still produces small, readable output', () => {
    const d = tmpdir('big');
    try {
      fs.writeFileSync(path.join(d, 'big.js'), `
let acc = 0;
for (let i = 0; i < 4000; i++) { acc += i; }
console.log(acc);
`);
      dbg(['run', '--lp', 'big.js:3 i, acc', '--', 'node', 'big.js'], { cwd: d });
      const stats = dbg(['stats'], { cwd: d });
      const tail = dbg(['tail'], { cwd: d });
      assert.ok(stats.split('\n').length < 45, `stats must stay compact, got ${stats.split('\n').length} lines`);
      assert.ok(tail.split('\n').length < 30, `tail must stay compact, got ${tail.split('\n').length} lines`);
      for (const line of tail.split('\n')) {
        assert.ok(line.length <= 210, `line too long (${line.length}): ${line.slice(0, 80)}…`);
      }
    } finally { cleanup(d); }
  });
}

section('the recorder must not change the program it observes');
{
  const AGENT = path.join(ROOT, 'agents', 'node-preload.js');

  // Attaching a listener to uncaughtException/unhandledRejection/SIGTERM
  // suppresses Node's default handling. An observer that does that silently
  // turns failing programs into passing ones — the worst possible failure mode
  // for a debugging tool, and invisible unless tested for directly.
  function runBoth(file, src) {
    const d = tmpdir('perturb');
    fs.writeFileSync(path.join(d, file), src);
    const plain = spawnSync(process.execPath, [file], { cwd: d, encoding: 'utf8', timeout: 20000 });
    const withAgent = spawnSync(process.execPath, ['--require', AGENT, file], {
      cwd: d, encoding: 'utf8', timeout: 20000,
      // a URL that refuses connections: recording must never be load-bearing
      env: { ...process.env, DBG_URL: 'http://127.0.0.1:1/e', DBG_TOKEN: 'x' },
    });
    fs.rmSync(d, { recursive: true, force: true });
    return { plain, withAgent };
  }

  test('an unhandled rejection still exits non-zero', () => {
    const { plain, withAgent } = runBoth('r.js', `
async function boom() { throw new Error('kaboom'); }
boom();
setTimeout(() => console.log('STILL ALIVE'), 200);
`);
    assert.strictEqual(plain.status, 1, 'baseline should exit 1');
    assert.strictEqual(withAgent.status, plain.status,
      `agent changed the exit code: ${plain.status} -> ${withAgent.status}`);
    assert.ok(!withAgent.stdout.includes('STILL ALIVE'),
      'agent let the program continue past a fatal rejection');
  });

  test('an uncaught exception still exits non-zero', () => {
    const { plain, withAgent } = runBoth('e.js', `
setTimeout(() => { throw new Error('sync boom'); }, 5);
setTimeout(() => console.log('STILL ALIVE'), 200);
`);
    assert.strictEqual(plain.status, 1);
    assert.strictEqual(withAgent.status, plain.status,
      `agent changed the exit code: ${plain.status} -> ${withAgent.status}`);
    assert.ok(!withAgent.stdout.includes('STILL ALIVE'));
  });

  test("the application's own rejection handler still wins", () => {
    const { plain, withAgent } = runBoth('o.js', `
process.on('unhandledRejection', (r) => { console.log('APP HANDLED'); process.exit(7); });
Promise.reject(new Error('mine'));
`);
    assert.strictEqual(plain.status, 7);
    assert.strictEqual(withAgent.status, 7, 'agent must not pre-empt an app-owned handler');
    assert.ok(withAgent.stdout.includes('APP HANDLED'));
  });

  test("the application's own SIGTERM shutdown still runs", () => {
    const d = tmpdir('sig');
    try {
      fs.writeFileSync(path.join(d, 's.js'), `
process.on('SIGTERM', () => { console.log('GRACEFUL'); process.exit(3); });
setInterval(() => {}, 1000);
console.log('ready');
`);
      const out = path.join(d, 'out.log');
      const r = spawnSync('sh', ['-c',
        `node --require ${JSON.stringify(AGENT)} s.js > ${JSON.stringify(out)} 2>&1 & P=$!; sleep 1; kill -TERM $P; wait $P; echo "exit=$?"`],
        { cwd: d, encoding: 'utf8', timeout: 25000,
          env: { ...process.env, DBG_URL: 'http://127.0.0.1:1/e', DBG_TOKEN: 'x' } });
      const log = fs.readFileSync(out, 'utf8');
      assert.ok(log.includes('GRACEFUL'), `app SIGTERM handler must still run:\n${log}`);
      assert.ok(/exit=3/.test(r.stdout), `app exit code must survive: ${r.stdout}`);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('a crash is still recorded even though behaviour is unchanged', () => {
    const d = tmpdir('crashrec');
    try {
      dbg(['sink'], { cwd: d });
      const s = JSON.parse(fs.readFileSync(path.join(d, '.claude-debug', 'session.json'), 'utf8'));
      fs.writeFileSync(path.join(d, 'r.js'), `
async function boom() { throw new Error('kaboom'); }
boom();
`);
      const r = spawnSync(process.execPath, ['--require', AGENT, 'r.js'], {
        cwd: d, encoding: 'utf8', timeout: 20000,
        env: { ...process.env, DBG_URL: `http://127.0.0.1:${s.controlPort}/e`, DBG_TOKEN: s.token },
      });
      assert.strictEqual(r.status, 1, 'exit code must still be 1');
      const out = dbg(['tail', '-n', '10'], { cwd: d });
      assert.ok(/unhandledRejection|uncaughtException/.test(out),
        `the crash must still be captured:\n${out}`);
      assert.ok(out.includes('kaboom'), `the reason must be captured:\n${out}`);
    } finally { cleanup(d); }
  });
}

section('regressions found by review');
{
  test('--snapshot honours --max instead of pausing on every hit', () => {
    const d = tmpdir('snapmax');
    try {
      fs.writeFileSync(path.join(d, 'five.js'), `
function step(i) {
  const v = i * 2;
  return v;
}
for (let i = 0; i < 5; i++) step(i);
`);
      dbg(['run', '--lp', 'five.js:4', '--snapshot', '--max', '2', '--', 'node', 'five.js'], { cwd: d });
      const out = dbg(['where', 'k==="snap"', '-n', '20'], { cwd: d });
      const hits = (out.match(/five\.js/g) || []).length;
      assert.strictEqual(hits, 2, `--max 2 over 5 hits should record 2, got ${hits}\n${out}`);
    } finally { cleanup(d); }
  });

  test('a command that cannot start fails fast and leaves no session', () => {
    const d = tmpdir('nocmd');
    try {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [DBG, 'run', '--', 'definitely-not-an-executable-xyz'], {
        cwd: d, encoding: 'utf8', timeout: 30000,
      });
      const elapsed = Date.now() - t0;
      assert.notStrictEqual(r.status, 0, 'must exit non-zero when the target cannot start');
      assert.ok(elapsed < 20000, `must fail fast, took ${elapsed}ms`);
      assert.ok(/could not start/i.test(r.stdout + r.stderr), r.stdout + r.stderr);
      assert.ok(!fs.existsSync(path.join(d, '.claude-debug', 'session.json')),
        'a failed start must not leave an active session behind');
    } finally { cleanup(d); }
  });

  test('half a million events do not blow the stack', () => {
    const d = tmpdir('huge');
    try {
      const run = store.createRun(d, { label: 'huge', cmd: 'synthetic' });
      const w = new store.Writer(d, run.id);
      for (let i = 0; i < 500000; i++) w.write({ s: i + 1, t: 1785900000000 + i, p: 'node:1', n: 'loop:' + (i % 7), d: { i } });
      w.close();
      store.writeMeta(d, run.id, { count: 500000, endedAt: new Date().toISOString() });
      for (const cmd of ['stats', 'tail', 'timeline', 'slow']) {
        const out = dbg([cmd], { cwd: d, timeout: 120000 });
        assert.ok(!/RangeError|call stack/i.test(out), `dbg ${cmd} blew up on 500k events:\n${out.slice(0, 300)}`);
        assert.ok(out.split('\n').length < 60, `dbg ${cmd} must stay bounded, got ${out.split('\n').length} lines`);
      }
    } finally { cleanup(d); }
  });

  test('dbg clean --keep N keeps N runs', () => {
    const d = tmpdir('keep');
    try {
      for (let i = 0; i < 5; i++) store.createRun(d, { label: `r${i}`, cmd: 'x' });
      assert.strictEqual(store.listRuns(d).length, 5);
      dbg(['clean', '--keep', '3'], { cwd: d });
      assert.strictEqual(store.listRuns(d).length, 3, 'should keep exactly 3');
    } finally { cleanup(d); }
  });

  test('a redirect is attributed to the url that was redirected', () => {
    const har = require('../lib/har');
    const got = [];
    const handlers = {};
    const fakeCdp = { on: (m, h) => { (handlers[m] = handlers[m] || []).push(h); }, send: async () => ({}) };
    har.attachNetwork(fakeCdp, (e) => got.push(e), {});
    const fire = (m, p) => (handlers[m] || []).forEach((h) => h(p));
    fire('Network.requestWillBeSent', { requestId: '1', request: { method: 'GET', url: 'https://a.test/old', headers: {} }, wallTime: 1.7e9, timestamp: 1 });
    fire('Network.requestWillBeSent', {
      requestId: '1', request: { method: 'GET', url: 'https://b.test/new', headers: {} }, wallTime: 1.7e9 + 1, timestamp: 2,
      redirectResponse: { status: 301, statusText: 'Moved', headers: { location: 'https://b.test/new' } },
    });
    const hop = got.find((e) => e.d.note === 'redirect');
    assert.ok(hop, 'the redirect hop must be recorded');
    assert.strictEqual(hop.d.url, 'https://a.test/old', 'the 3xx belongs to the original url, not the destination');
    assert.strictEqual(hop.d.status, 301);
  });

  test('one inbound request without a trace header yields one trace, not two', () => {
    const d = tmpdir('corr');
    try {
      dbg(['sink'], { cwd: d });
      const s = JSON.parse(fs.readFileSync(path.join(d, '.claude-debug', 'session.json'), 'utf8'));
      // one process: an inbound request (no x-dbg-corr) whose handler calls out
      fs.writeFileSync(path.join(d, 'srv.js'), `
const http = require('http');
const back = http.createServer((q, r) => { r.writeHead(200); r.end('ok'); });
back.listen(0, () => {
  const port = back.address().port;
  const front = http.createServer(async (q, r) => {
    await fetch('http://127.0.0.1:' + port + '/inner');
    r.writeHead(200); r.end('done');
  });
  front.listen(0, async () => {
    await fetch('http://127.0.0.1:' + front.address().port + '/outer');
    setTimeout(() => process.exit(0), 400);
  });
});
`);
      spawnSync(process.execPath, ['--require', path.join(ROOT, 'agents', 'node-preload.js'), 'srv.js'], {
        cwd: d, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, DBG_URL: `http://127.0.0.1:${s.controlPort}/e`, DBG_TOKEN: s.token },
      });
      dbg(['stop'], { cwd: d });
      const events = store.readEvents(d, store.currentRun(d));
      const inbound = events.filter((e) => e.n === 'http:in' && /outer/.test(JSON.stringify(e.d || {})));
      assert.ok(inbound.length, `expected an inbound event:\n${JSON.stringify(events.map((e) => e.n))}`);
      const corr = inbound[0].c;
      assert.ok(corr, 'the inbound request must carry a correlation id');
      const outbound = events.filter((e) => e.n === 'fetch' && /inner/.test(JSON.stringify(e.d || {})));
      assert.ok(outbound.length, 'expected the handler\'s outbound call to be recorded');
      assert.strictEqual(outbound[0].c, corr,
        'the handler\'s outbound call must share the inbound trace id, not mint a second one');
    } finally { cleanup(d); }
  });
}

section('regressions: second review round');
{
  test('the target exit code is propagated by dbg run', () => {
    const d = tmpdir('exitcode');
    try {
      const r = spawnSync(process.execPath, [DBG, 'run', '--', 'node', '-e', 'process.exit(7)'], {
        cwd: d, encoding: 'utf8', timeout: 60000,
      });
      assert.strictEqual(r.status, 7, `dbg must exit with the target's code, got ${r.status}`);
      const ok = spawnSync(process.execPath, [DBG, 'run', '--', 'node', '-e', '0'], {
        cwd: d, encoding: 'utf8', timeout: 60000,
      });
      assert.strictEqual(ok.status, 0, 'a passing target must still exit 0');
    } finally { cleanup(d); }
  });

  test('the session file holding the control token is owner-only', () => {
    const d = tmpdir('perm');
    try {
      dbg(['sink'], { cwd: d });
      const mode = fs.statSync(path.join(d, '.claude-debug', 'session.json')).mode & 0o777;
      assert.strictEqual(mode, 0o600, `token file must be 0600, got ${mode.toString(8)}`);
    } finally { cleanup(d); }
  });

  test('a source probe says so when there is no recorder and no sink', () => {
    const d = tmpdir('norec');
    try {
      // no sink running: nothing to point a recorder at, so warn rather than
      // insert a call that would throw at runtime
      fs.writeFileSync(path.join(d, 'app.py'), 'def a(v):\n    y = v + 1\n    return y\n');
      const out = dbg(['probe', 'add', 'app.py:2 v'], { cwd: d });
      assert.ok(/no sink is running/i.test(out), `expected a warning:\n${out}`);
      assert.ok(/dbg sink/.test(out), 'should name the exact fix');

      // and it must stay quiet when the file already defines its own recorder
      fs.writeFileSync(path.join(d, 'b.py'), 'def dbg(label, **kw):\n    pass\ndef a(v):\n    return v\n');
      const out2 = dbg(['probe', 'add', 'b.py:4 v'], { cwd: d });
      assert.ok(!/no sink is running/i.test(out2), `should not warn when dbg() is defined:\n${out2}`);
    } finally { cleanup(d); }
  });

  test('debugger and preload events from one pid are not merged by unrelated seq', () => {
    // Both describe the same process; each keeps its own counter, so they must
    // be distinguishable producers or the merge sort interleaves them wrongly.
    const { LiveSession } = require('../lib/live');
    const live = new LiveSession({ pid: 4242, kind: 'node', port: 9229, emit: () => {} });
    assert.notStrictEqual(live.producerId, 'node:4242',
      'the debugger must not claim the same producer id as the preload agent');

    const events = [
      { p: 'node:4242', s: 1, t: 300 },   // preload, later in wall clock
      { p: live.producerId, s: 9, t: 100 },  // debugger, earlier
    ];
    const sorted = [...events].sort(store.cmp);
    assert.strictEqual(sorted[0].t, 100, 'different producers must order by wall clock, not by seq');
  });

  test('two sequence spaces under one producer order by wall clock', () => {
    // Logpoint events carry the target's own counter; console and exception
    // events are numbered by the recorder. Comparing one against the other
    // reorders the timeline — caught by a smoke test, not by the suite.
    const evs = [
      { p: 'cdp:99', o: 't', s: 1, t: 100, n: 'probe:A' },
      { p: 'cdp:99', o: 't', s: 2, t: 300, n: 'probe:B' },
      { p: 'cdp:99', o: 'd', s: 5, t: 200, n: 'console.log' },
    ];
    const order = [...evs].sort(store.cmp).map((e) => e.n);
    assert.deepStrictEqual(order, ['probe:A', 'console.log', 'probe:B'],
      `mixed sequence spaces must fall back to wall clock, got ${order.join(' -> ')}`);

    // and within one space the sequence still wins over a coarse clock
    const same = [
      { p: 'cdp:99', o: 't', s: 2, t: 100, n: 'second' },
      { p: 'cdp:99', o: 't', s: 1, t: 100, n: 'first' },
    ];
    assert.deepStrictEqual([...same].sort(store.cmp).map((e) => e.n), ['first', 'second']);
  });

  test('re-installing after a navigation removes the old breakpoint', async () => {
    const { LiveSession } = require('../lib/live');
    const removed = [];
    let n = 0;
    const live = new LiveSession({ kind: 'chrome', port: 9222, emit: () => {} });
    live.cdp = {
      send: async (method, params) => {
        if (method === 'Debugger.removeBreakpoint') { removed.push(params.breakpointId); return {}; }
        if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: 'bp' + (++n), locations: [{}] };
        return {};
      },
      evaluate: async () => 'ok',
    };
    await live.add({ file: 'a.js', line: 3, exprs: [] });
    const first = [...live.logpoints.values()][0].bpId;
    await live.reinstall();
    const second = [...live.logpoints.values()][0].bpId;
    assert.ok(removed.includes(first), `the pre-navigation breakpoint ${first} must be removed, removed=${JSON.stringify(removed)}`);
    assert.notStrictEqual(second, first, 'a fresh breakpoint should replace it');
    assert.strictEqual(live.bpIds.size, 1, 'exactly one live breakpoint should remain mapped');
  });
}

section('regressions: third review round');
{
  test('a python source probe works end to end without further steps', () => {
    const py = spawnSync('python3', ['-V'], { encoding: 'utf8' });
    if (py.error) return console.log('       (skipped: no python3)');
    const d = tmpdir('pyprobe');
    try {
      const original = '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nfrom __future__ import annotations\n\ndef total(rows):\n    t = 0\n    for r in rows:\n        t += r\n    return t\n\nprint("total:", total([1, 2, 3]))\n';
      const f = path.join(d, 'app.py');
      fs.writeFileSync(f, original);
      dbg(['sink'], { cwd: d });
      dbg(['probe', 'add', 'app.py:8 r, t'], { cwd: d });

      const r = spawnSync('python3', ['app.py'], { cwd: d, encoding: 'utf8', timeout: 30000 });
      assert.ok(!/NameError/.test(r.stderr), `probe must not blow up at runtime:\n${r.stderr}`);
      assert.strictEqual(r.status, 0, `program must still run: ${r.stderr}`);
      assert.ok(r.stdout.includes('total: 6'), 'the program must still produce its own output');

      // __future__ must remain the first statement or python refuses to run
      const patched = fs.readFileSync(f, 'utf8').split('\n');
      const fut = patched.findIndex((l) => l.startsWith('from __future__'));
      const firstCode = patched.findIndex((l) => l.trim() && !l.startsWith('#') && !l.startsWith('from __future__'));
      assert.ok(fut >= 0 && fut < firstCode, 'the __future__ import must stay ahead of inserted code');

      dbg(['stop'], { cwd: d });
      const out = dbg(['tail', '-n', '10'], { cwd: d });
      assert.ok(/app\.py:8/.test(out), `the probe must actually emit events:\n${out}`);
      assert.ok(/r=1/.test(out) && /r=3/.test(out), `every iteration should be captured:\n${out}`);

      dbg(['probe', 'strip'], { cwd: d });
      assert.strictEqual(fs.readFileSync(f, 'utf8'), original,
        'strip must remove the probe AND the inserted recorder, exactly');
    } finally { cleanup(d); }
  });

  test('the recording directory is owner-only even under a permissive umask', () => {
    const d = tmpdir('umask');
    try {
      const r = spawnSync('sh', ['-c', `umask 000 && node ${JSON.stringify(DBG)} sink`], {
        cwd: d, encoding: 'utf8', timeout: 30000,
      });
      assert.ok(/sink listening/.test(r.stdout), r.stdout + r.stderr);
      const mode = fs.statSync(path.join(d, '.claude-debug')).mode & 0o777;
      assert.strictEqual(mode, 0o700, `.claude-debug must be 0700 under umask 000, got ${mode.toString(8)}`);
      const sess = fs.statSync(path.join(d, '.claude-debug', 'session.json')).mode & 0o777;
      assert.strictEqual(sess, 0o600, `session.json must be 0600, got ${sess.toString(8)}`);
    } finally { cleanup(d); }
  });
}

// ---------------------------------------------------------------- report

// a couple of tests are async; settle them before reporting
Promise.all(pending).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nfailures:');
    for (const f of failures) {
      console.log(`\n--- ${f.name}`);
      console.log(f.e.stack.split('\n').slice(0, 6).join('\n'));
    }
    process.exit(1);
  }
});
