'use strict';
// Loaded with `node --require`. Adds the things an inspector attachment cannot
// give you on its own:
//   - a correlation id that follows a request across process boundaries
//   - spans for inbound and outbound HTTP, with durations
//   - crash capture that fires before the process dies
// Everything here is defensive: this file must never be the reason an app breaks.

const URL_ = process.env.DBG_URL;
const TOKEN = process.env.DBG_TOKEN;
if (URL_ && !globalThis.__dbgAgentInstalled) {
  globalThis.__dbgAgentInstalled = true;
  install();
}

function install() {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const http = require('node:http');
  const https = require('node:https');
  const crypto = require('node:crypto');

  const als = new AsyncLocalStorage();
  // Never instrument traffic to the collector itself. Matching on the full
  // ingest URL was too narrow: the CLI's own health checks hit the same host
  // on a different path and showed up as phantom traces.
  const SELF_ORIGIN = (() => { try { return new URL(URL_).origin; } catch { return null; } })();
  const isSelf = (u) => {
    if (!SELF_ORIGIN || !u) return false;
    try { return new URL(u, SELF_ORIGIN).origin === SELF_ORIGIN; } catch { return false; }
  };
  const PRODUCER = `node:${process.pid}`;
  const HDR = 'x-dbg-corr';
  let seq = 0;
  let buf = [];
  let timer = null;
  let sending = false;

  const origin = performance.timeOrigin || Date.now();
  const now = () => origin + performance.now();

  // Batches handed to fetch but not yet confirmed. A crashing process can exit
  // before an async POST completes, which would lose exactly the events that
  // explain the crash — so anything unconfirmed is re-sent synchronously at exit.
  const inflight = new Set();

  function post(batch) {
    const body = JSON.stringify({ producer: PRODUCER, events: batch });
    inflight.add(batch);
    // keepalive so in-flight telemetry survives a process that is shutting down
    return fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dbg-token': TOKEN || '' },
      body,
      keepalive: true,
    }).then(() => { inflight.delete(batch); }, () => { inflight.delete(batch); });
  }

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buf.length || sending) return;
    const batch = buf;
    buf = [];
    sending = true;
    post(batch).finally(() => { sending = false; if (buf.length) flush(); });
  }

  function schedule() {
    if (timer || sending) return;
    timer = setTimeout(flush, 120);
    if (timer.unref) timer.unref();
  }

  function safe(v, depth = 0) {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'undefined') return { __t: 'undefined' };
    if (t === 'number') return Number.isFinite(v) ? v : { __t: 'number', v: String(v) };
    if (t === 'boolean') return v;
    if (t === 'bigint') return { __t: 'bigint', v: v.toString() };
    if (t === 'function') return { __t: 'function', v: v.name || '(anonymous)' };
    if (t === 'string') return v.length > 240 ? { __t: 'string', v: v.slice(0, 240), len: v.length } : v;
    if (v instanceof Error) {
      return { __t: 'error', name: v.name, message: v.message, code: v.code,
               stack: String(v.stack || '').split('\n').slice(0, 6).join('\n') };
    }
    if (depth >= 3) return { __t: 'truncated' };
    try {
      if (Array.isArray(v)) return v.slice(0, 30).map((x) => safe(x, depth + 1));
      const o = {};
      let i = 0;
      for (const k of Object.keys(v)) {
        if (i++ >= 30) { o.__more = true; break; }
        o[k] = safe(v[k], depth + 1);
      }
      return o;
    } catch { return { __t: 'uncapturable' }; }
  }

  function record(name, data, extra) {
    const ev = { s: ++seq, t: now(), n: name };
    if (data !== undefined) ev.d = safe(data);
    const ctx = als.getStore();
    if (ctx && ctx.corr) ev.c = ctx.corr;
    if (extra) Object.assign(ev, extra);
    buf.push(ev);
    if (buf.length >= 64) flush(); else schedule();
    return false;
  }

  globalThis.__dbg = record;
  globalThis.__dbg.corr = () => (als.getStore() || {}).corr;
  globalThis.__dbg.flush = flush;
  globalThis.__dbg.span = (name, fn) => {
    const t0 = now();
    const done = (d) => record(name, d, { ms: now() - t0 });
    try {
      const r = fn();
      if (r && typeof r.then === 'function') {
        return r.then((v) => { done({ ok: true }); return v; }, (e) => { done({ ok: false, error: e }); throw e; });
      }
      done({ ok: true });
      return r;
    } catch (e) { done({ ok: false, error: e }); throw e; }
  };

  // ---- inbound HTTP: adopt or mint a correlation id ----
  function wrapServerFactory(mod, name) {
    const orig = mod[name];
    if (typeof orig !== 'function') return;
    mod[name] = function (...args) {
      const server = orig.apply(this, args);
      server.on('request', (req, res) => {
        // Adopt the id the emit wrapper already established for this request.
        // Minting a second one here split every trace in two: the inbound
        // events carried one id and the handler's outbound calls another.
        const corr = (als.getStore() || {}).corr
          || req.headers[HDR] || crypto.randomBytes(6).toString('hex');
        const t0 = now();
        als.run({ corr }, () => {
          record('http:in', { method: req.method, url: req.url, from: req.socket && req.socket.remoteAddress });
          res.on('finish', () => {
            record('http:in:done', { method: req.method, url: req.url, status: res.statusCode },
              { ms: now() - t0, k: 'net' });
          });
        });
      });
      return server;
    };
  }
  wrapServerFactory(http, 'createServer');
  wrapServerFactory(https, 'createServer');

  // The 'request' listener above runs outside the handler's own async context,
  // so also bind the context for the duration of each request handler.
  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, ...rest) {
    if (event !== 'request') return origEmit.call(this, event, ...rest);
    const req = rest[0];
    const corr = (req && req.headers && req.headers[HDR]) || (als.getStore() || {}).corr || require('node:crypto').randomBytes(6).toString('hex');
    return als.run({ corr }, () => origEmit.call(this, event, ...rest));
  };

  // ---- outbound HTTP: propagate the id and time the call ----
  function wrapRequest(mod, name, scheme) {
    const orig = mod[name];
    if (typeof orig !== 'function') return;
    mod[name] = function (...args) {
      // No ambient trace (e.g. a CLI or test making the first call)? Start one,
      // otherwise every hop gets its own id and the chain cannot be reassembled.
      const probe = args[0];
      const host = typeof probe === 'object' && probe !== null
        ? `${scheme}://${probe.host || probe.hostname || ''}` : probe;
      if (isSelf(typeof probe === 'string' ? probe : host)) return orig.apply(this, args);
      let ctx = als.getStore();
      if (!ctx || !ctx.corr) {
        ctx = { corr: crypto.randomBytes(6).toString('hex') };
        return als.run(ctx, () => mod[name].apply(this, args));
      }
      let opts = args[0];
      // inject the header into whichever argument carries options
      const target = typeof opts === 'object' && opts !== null ? opts
        : (typeof args[1] === 'object' && args[1] !== null ? args[1] : null);
      if (ctx && ctx.corr && target) {
        target.headers = { ...(target.headers || {}), [HDR]: ctx.corr };
      }
      const t0 = now();
      const desc = typeof opts === 'string' ? opts
        : `${scheme}://${(target && (target.host || target.hostname)) || '?'}${(target && target.path) || ''}`;
      const req = orig.apply(this, args);
      try {
        req.on('response', (res) => {
          record('http:out', { url: desc, method: (target && target.method) || 'GET', status: res.statusCode },
            { ms: now() - t0, k: 'net' });
        });
        req.on('error', (e) => {
          record('http:out', { url: desc, method: (target && target.method) || 'GET', error: e.message },
            { ms: now() - t0, k: 'net' });
        });
      } catch {}
      return req;
    };
  }
  wrapRequest(http, 'request', 'http');
  wrapRequest(http, 'get', 'http');
  wrapRequest(https, 'request', 'https');
  wrapRequest(https, 'get', 'https');

  // ---- outbound fetch ----
  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (input, init = {}) {
      // never instrument our own telemetry
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (isSelf(url)) return origFetch.call(this, input, init);
      let ctx = als.getStore();
      if (!ctx || !ctx.corr) {
        ctx = { corr: crypto.randomBytes(6).toString('hex') };
        return als.run(ctx, () => globalThis.fetch(input, init));
      }
      let opts = init;
      if (ctx && ctx.corr) {
        const h = new Headers((init && init.headers) || (input && input.headers) || {});
        h.set(HDR, ctx.corr);
        opts = { ...init, headers: h };
      }
      const t0 = now();
      return origFetch.call(this, input, opts).then(
        (res) => { record('fetch', { url, method: (opts && opts.method) || 'GET', status: res.status }, { ms: now() - t0, k: 'net' }); return res; },
        (e) => { record('fetch', { url, method: (opts && opts.method) || 'GET', error: e.message }, { ms: now() - t0, k: 'net' }); throw e; }
      );
    };
  }

  // ---- crash capture ----
  //
  // Observing a failure must not change it. Attaching a listener to any of
  // these events *suppresses Node's default handling*, so a naive
  // `process.on('unhandledRejection', record)` turns a program that exits 1
  // into one that sails past the error — the recorder would mask the very bug
  // it was attached to find, and `dbg repeat --until-fail` would never
  // reproduce anything. Each handler below restores the behaviour it displaced.

  // Purpose-built for exactly this: observe without becoming the handler.
  process.on('uncaughtExceptionMonitor', (e) => {
    record('uncaughtException', { error: e }, { k: 'err' });
    flush();
  });

  // There is no monitor variant for rejections, so restore the default by hand.
  const rejectionMode = (() => {
    const flags = [...(process.execArgv || []), ...String(process.env.NODE_OPTIONS || '').split(/\s+/)];
    const f = flags.find((a) => a && a.startsWith('--unhandled-rejections='));
    return f ? f.split('=')[1] : 'throw';   // Node's default since v15
  })();
  const onRejection = (reason) => {
    record('unhandledRejection', { reason }, { k: 'err' });
    flush();
    // If the application registered its own handler, it owns the outcome.
    if (process.listenerCount('unhandledRejection') > 1) return;
    if (rejectionMode !== 'throw' && rejectionMode !== 'strict') return;
    // Sole listener: we suppressed the crash, so reinstate it.
    process.nextTick(() => { throw reason; });
  };
  process.on('unhandledRejection', onRejection);

  process.on('beforeExit', flush);

  // A server almost always dies by signal rather than by running out of work,
  // so without this the tail of every long-lived process is lost.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const onSignal = () => {
      const pending = buf.length > 0;
      flush();
      // If the app handles this signal itself, do not interfere with its
      // shutdown — just get the buffered events out.
      if (process.listenerCount(sig) > 1) return;
      // Sole listener: our presence suppressed the default (terminate), so
      // reinstate it, removing only our own handler.
      const done = () => {
        process.removeListener(sig, onSignal);
        process.kill(process.pid, sig);
      };
      if (!pending) return done();
      setTimeout(done, 150);   // deliberately not unref'd: hold the process open long enough to send
    };
    process.on(sig, onSignal);
  }
  process.on('exit', () => {
    // Last chance, and the only synchronous one: everything still buffered plus
    // every batch whose POST never confirmed.
    const leftover = [...buf];
    for (const batch of inflight) leftover.push(...batch);
    if (!leftover.length) return;
    leftover.sort((a, b) => a.s - b.s);
    try {
      const { execFileSync } = require('node:child_process');
      const payload = JSON.stringify(JSON.stringify({ producer: PRODUCER, events: leftover }));
      execFileSync(process.execPath, ['-e',
        `fetch(${JSON.stringify(URL_)},{method:'POST',headers:{'content-type':'application/json','x-dbg-token':${JSON.stringify(TOKEN || '')}},body:${payload}}).catch(()=>{})`],
        { timeout: 1500, stdio: 'ignore' });
    } catch {}
  });
}
