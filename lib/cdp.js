'use strict';
// Minimal Chrome DevTools Protocol client. Uses the WebSocket + fetch globals
// built into Node >= 22, so the tool has zero npm dependencies.
const { execFileSync } = require('child_process');

class CDP {
  static hostFor = new Map();   // port -> host that actually answered

  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  // Chrome frequently binds ::1 only, and an unrelated service may already own
  // the port, so try both stacks and say plainly which case we hit.
  static async targets(port) {
    const hosts = ['127.0.0.1', '[::1]'];
    let lastStatus = null;
    for (const host of hosts) {
      let res;
      try {
        res = await fetch(`http://${host}:${port}/json/list`, { signal: AbortSignal.timeout(2500) });
      } catch { continue; }
      if (res.ok) {
        const body = await res.json().catch(() => null);
        if (Array.isArray(body)) { CDP.hostFor.set(port, host); return body; }
        lastStatus = 'responded but not a DevTools endpoint';
        continue;
      }
      lastStatus = `HTTP ${res.status}`;
    }
    if (lastStatus) {
      throw new Error(`something is listening on :${port} but it is not a DevTools inspector (${lastStatus}) — is another tool using that port?`);
    }
    throw new Error(`nothing is listening on :${port}`);
  }

  // Ask an already-running Node process to open an inspector port, so we can
  // attach without restarting it (the common case: a dev server is already up).
  static openInspector(pid, port) {
    execFileSync(process.execPath, ['-e', `process._debugProcess(${Number(pid)})`], { stdio: 'pipe' });
    return port || 9229;
  }

  static async waitForPort(port, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
      try { return await CDP.targets(port); } catch (e) { lastErr = e; await sleep(120); }
    }
    throw new Error(`no inspector reachable on :${port} (${lastErr && lastErr.message})`);
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, p] of this.pending) p.rej(new Error('inspector connection closed'));
      this.pending.clear();
      this._emit('__closed');
    });
    this.ws.addEventListener('error', () => {});
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error(`timed out connecting to ${this.wsUrl}`)), 8000);
      this.ws.addEventListener('open', () => { clearTimeout(to); res(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(to); rej(new Error(`cannot connect to ${this.wsUrl}`)); }, { once: true });
    });
    return this;
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${msg.error.message}${msg.error.data ? ': ' + msg.error.data : ''}`));
      else p.res(msg.result);
      return;
    }
    if (msg.method) this._emit(msg.method, msg.params || {});
  }

  _emit(method, params) {
    const hs = this.handlers.get(method);
    if (hs) for (const h of hs) { try { h(params); } catch {} }
    const all = this.handlers.get('*');
    if (all) for (const h of all) { try { h(method, params); } catch {} }
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
    return this;
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('inspector connection closed'));
    return new Promise((res, rej) => {
      const id = ++this.id;
      this.pending.set(id, { res, rej });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this.pending.delete(id); rej(e); }
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} timed out`)); }
      }, 15000);
    });
  }

  // Evaluate in the target and return a plain JS value.
  async evaluate(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: !!opts.await,
      includeCommandLineAPI: false,
      ...opts.params,
    });
    if (r.exceptionDetails) {
      const t = r.exceptionDetails.exception;
      throw new Error(`target threw: ${(t && (t.description || t.value)) || r.exceptionDetails.text}`);
    }
    return r.result ? r.result.value : undefined;
  }

  close() {
    this.closed = true;
    try { this.ws && this.ws.close(); } catch {}
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Pick the most useful target from /json/list.
function pickTarget(targets, want) {
  const usable = targets.filter((t) => t.webSocketDebuggerUrl);
  if (!usable.length) throw new Error('inspector has no attachable targets');
  if (want) {
    const m = usable.find((t) => (t.url || '').includes(want) || (t.title || '').includes(want) || t.id === want);
    if (m) return m;
    throw new Error(`no target matching "${want}" (have: ${usable.map((t) => t.title || t.url).join(', ')})`);
  }
  const page = usable.find((t) => t.type === 'page' && !/^devtools:/.test(t.url || ''));
  return page || usable[0];
}

module.exports = { CDP, pickTarget, sleep };
