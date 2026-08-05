'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { LiveSession } = require('./live');
const har = require('./har');

// One long-lived process per debugging session. It owns:
//   - the CDP attachment (so logpoints survive between CLI invocations)
//   - the drain loop (so the in-process ring buffer never overflows silently)
//   - the loopback ingest endpoint for non-JS producers
//   - a small control API the `dbg` CLI drives
// Bound to 127.0.0.1 and token-gated: this endpoint can write to disk, so it
// must never be reachable off-host or by a random page in the user's browser.

async function startDaemon(cfg) {
  const cwd = cfg.cwd || process.cwd();
  const run = cfg.run || store.createRun(cwd, {
    label: cfg.label,
    cmd: cfg.cmd,
    mode: cfg.mode,
    target: cfg.target,
    inspectPort: cfg.port,
  });
  const writer = new store.Writer(cwd, run.id);
  let count = 0;
  const startedAt = Date.now();

  const emit = (ev) => {
    if (!ev.t) ev.t = Date.now();
    if (!ev.p) ev.p = 'dbg';
    if (ev.s == null) ev.s = ++localSeq;
    writer.write(ev);
    count++;
  };
  let localSeq = 0;

  let live = null;
  // the CLI may pre-generate these so the target's env can point at the
  // collector before the daemon itself finishes starting
  const token = cfg.token || crypto.randomBytes(12).toString('hex');

  // ---- control + ingest server ----
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(cfg.controlPort || 0, '127.0.0.1', resolve);
  });
  const controlPort = server.address().port;

  function json(res, code, body) {
    const b = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
    res.end(b);
  }

  function authed(req, url) {
    const t = req.headers['x-dbg-token'] || url.searchParams.get('k');
    return t === token;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Browser producers need CORS, but only for the ingest path and only with
    // a valid token — never a blanket allow-origin on the control API.
    if (req.method === 'OPTIONS' && url.pathname === '/e') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin || '*',
        'access-control-allow-headers': 'content-type,x-dbg-token',
        'access-control-allow-methods': 'POST,OPTIONS',
        'access-control-max-age': '600',
      });
      return res.end();
    }
    if (url.pathname === '/health') return json(res, 200, { ok: true, run: run.id, events: count });
    if (!authed(req, url)) return json(res, 403, { error: 'bad or missing token' });

    try {
      if (url.pathname === '/e' && req.method === 'POST') {
        const body = await readBody(req, 4e6);
        const payload = JSON.parse(body || '{}');
        const evs = Array.isArray(payload) ? payload : (payload.events || [payload]);
        const producer = payload.producer || req.headers['x-dbg-producer'] || 'ext';
        for (const ev of evs) {
          emit(normalizeIngest(ev, producer));
        }
        res.writeHead(204, { 'access-control-allow-origin': req.headers.origin || '*' });
        return res.end();
      }

      if (url.pathname === '/status') {
        const st = live ? await live.status().catch((e) => ({ error: e.message })) : null;
        return json(res, 200, {
          run: run.id, runDir: run.dir, events: count, pid: process.pid,
          controlPort, uptimeMs: Date.now() - startedAt, mode: cfg.mode, live: st,
        });
      }

      if (url.pathname === '/lp' && req.method === 'POST') {
        if (!live) return json(res, 409, { error: 'no live target attached (use: dbg attach / dbg run)' });
        const body = JSON.parse(await readBody(req, 1e6));
        const c = await live.add(body);
        return json(res, 200, { ok: true, lp: { id: c.id, label: c.resolvedLabel, bound: c.locations } });
      }
      if (url.pathname === '/scripts') {
        if (!live) return json(res, 200, { scripts: [] });
        return json(res, 200, { scripts: [...live.scripts.values()] });
      }

      if (url.pathname === '/lp' && req.method === 'GET') {
        if (!live) return json(res, 200, { logpoints: [] });
        const st = await live.status();
        return json(res, 200, { logpoints: st.logpoints });
      }
      if (url.pathname.startsWith('/lp/') && req.method === 'DELETE') {
        if (!live) return json(res, 200, { ok: true });
        const id = url.pathname.slice(4);
        const ok = id === 'all' ? (await live.clear(), true) : await live.remove(id);
        return json(res, 200, { ok });
      }

      if (url.pathname === '/flush' && req.method === 'POST') {
        let n = 0;
        if (live) n = await live.drain().catch(() => 0);
        writer.flush();
        store.writeMeta(cwd, run.id, { count });
        return json(res, 200, { drained: n, events: count });
      }

      if (url.pathname === '/eval' && req.method === 'POST') {
        if (!live) return json(res, 409, { error: 'no live target attached' });
        const { expression } = JSON.parse(await readBody(req, 1e6));
        try {
          const v = await live.cdp.evaluate(expression, { await: true });
          return json(res, 200, { ok: true, value: v });
        } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
      }

      if (url.pathname === '/import-har' && req.method === 'POST') {
        const { file } = JSON.parse(await readBody(req, 1e6));
        const evs = har.importHar(file);
        for (const ev of evs) emit(ev);
        return json(res, 200, { imported: evs.length });
      }

      if (url.pathname === '/stop' && req.method === 'POST') {
        json(res, 200, { ok: true, run: run.id, events: count });
        return shutdown(0);
      }

      return json(res, 404, { error: 'unknown endpoint' });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ---- live attachment ----
  if (cfg.port) {
    live = new LiveSession({
      cwd, port: cfg.port, target: cfg.target, emit, cap: cfg.cap,
      network: cfg.network, console: cfg.console !== false, kind: cfg.kind || 'node',
      pid: cfg.childPid || cfg.pid || null,
    });
    await live.connect();
    store.writeMeta(cwd, run.id, { target: live.targetInfo });
  }

  // ---- drain loop ----
  const interval = Number(cfg.drainMs || 250);
  const timer = setInterval(async () => {
    if (!live) return;
    try { await live.drain(); } catch (e) {
      if (/closed/i.test(e.message)) {
        // A target that finished normally is not a detachment worth reporting.
        if (!live.exiting) emit({ n: '__detached', k: 'meta', d: { why: e.message } });
        live = null;
        if (cfg.exitOnDetach) shutdown(0);
      }
    }
    writer.flush();
    store.writeMeta(cwd, run.id, { count });
  }, interval);

  store.writeSession(cwd, {
    runId: run.id, pid: process.pid, controlPort, token,
    mode: cfg.mode, inspectPort: cfg.port, startedAt: new Date().toISOString(),
  });

  let stopping = false;
  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    try { if (live) await live.drain(); } catch {}
    try { if (live) { await live.clear(); live.close(); } } catch {}
    writer.flush();
    writer.close();
    store.writeMeta(cwd, run.id, { count, endedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
    const s = store.readSession(cwd);
    if (s && s.pid === process.pid) store.clearSession(cwd);
    server.close();
    setTimeout(() => process.exit(code || 0), 60);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (e) => {
    try { emit({ n: '__daemon_error', k: 'err', d: { message: e.message, stack: e.stack } }); } catch {}
    shutdown(1);
  });

  return { run, controlPort, token, shutdown, emit, get live() { return live; }, setLive: (l) => { live = l; } };
}

function normalizeIngest(ev, producer) {
  const out = {
    s: ev.s != null ? ev.s : undefined,
    t: ev.t || Date.now(),
    p: ev.p || producer,
    n: ev.n || ev.label || 'event',
    o: 't',   // producer-assigned sequence, from inside the target
  };
  if (ev.d !== undefined) out.d = ev.d;
  else if (ev.data !== undefined) out.d = ev.data;
  if (ev.k) out.k = ev.k;
  if (ev.c || ev.corr) out.c = ev.c || ev.corr;
  if (ev.l || ev.loc) out.l = ev.l || ev.loc;
  if (ev.ms != null) out.ms = ev.ms;
  if (ev.stack) out.stack = ev.stack;
  if (ev.har) out.har = ev.har;
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { startDaemon, normalizeIngest };
