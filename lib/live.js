'use strict';
const path = require('path');
const { CDP, pickTarget } = require('./cdp');
const { bootstrapSource } = require('./bootstrap');
const har = require('./har');

// Name of the injected push channel (Runtime.addBinding).
const BINDING = '__dbgSend';

// A live attachment to one Node or Chrome target: injects the recorder,
// installs/removes logpoints, and drains captured events. Owned by the daemon
// so that breakpoints and the ring buffer survive across CLI invocations.
class LiveSession {
  constructor(opts) {
    this.opts = opts;
    this.cwd = opts.cwd;
    this.emit = opts.emit;            // (event) => void, writes into the store
    this.logpoints = new Map();       // lpId -> config
    this.bpIds = new Map();           // cdp breakpointId -> lpId
    this.producer = opts.producer || 'cdp';
    this.kind = opts.kind || 'node';
    // `process.pid` is not readable from a bare global evaluate, so the pid is
    // passed in when the caller knows it; the inspector port is a stable
    // fallback identity so cross-process ordering still works.
    this.targetPid = opts.pid || null;
    this.ready = false;
    this.netTracker = null;
    this.scripts = new Map();   // url -> {url, hits, first}
  }

  async connect() {
    const targets = await CDP.targets(this.opts.port);
    const t = pickTarget(targets, this.opts.target);
    this.targetInfo = { id: t.id, title: t.title, url: t.url, type: t.type };
    this.cdp = new CDP(t.webSocketDebuggerUrl);
    await this.cdp.connect();
    await this.cdp.send('Runtime.enable');
    await this.cdp.send('Debugger.enable');
    try { await this.cdp.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 }); } catch {}

    // Push channel: the recorder calls this binding and the payload arrives as
    // a protocol event. Without it, anything a short-lived process captured
    // dies with its execution context before we can poll for it.
    this.cdp.on('Runtime.bindingCalled', (p) => {
      if (p.name !== BINDING) return;
      let batch;
      try { batch = JSON.parse(p.payload); } catch { return; }
      for (const ev of batch) this._emitCaptured(ev);
    });
    await this.cdp.send('Runtime.addBinding', { name: BINDING });

    // Every script the runtime loads, so an unbound probe can be diagnosed
    // ("what URL does the runtime actually call this file?") instead of just
    // failing silently. Inline <script> blocks are keyed by page URL, which is
    // the single most common reason a browser logpoint never binds.
    this.cdp.on('Debugger.scriptParsed', (p) => {
      const url = p.url || '(eval)';
      if (!url || url.startsWith('node:') || url.includes('node_modules')) return;
      const prev = this.scripts.get(url);
      if (prev) prev.hits++;
      else this.scripts.set(url, { url, hits: 1, length: p.length, id: p.scriptId });
    });

    // Track which logpoints actually bound to real code. A probe on a line
    // that never loads is silent, and silence is indistinguishable from
    // "the code never ran" unless we report it.
    this.cdp.on('Debugger.breakpointResolved', (p) => {
      const lpId = this.bpIds.get(p.breakpointId);
      const c = lpId && this.logpoints.get(lpId);
      if (c) { c.locations = (c.locations || 0) + 1; c.resolvedAt = p.location; }
    });

    // Node keeps a finished process alive while an inspector is attached
    // ("Waiting for the debugger to disconnect..."). Let go so it can exit.
    this.cdp.on('NodeRuntime.waitingForDisconnect', () => {
      this.exiting = true;
      if (this.onExiting) { try { this.onExiting(); } catch {} }
      setTimeout(() => { try { this.cdp.close(); } catch {} }, 60);
    });
    try { await this.cdp.send('NodeRuntime.notifyWhenWaitingForDisconnect', { enabled: true }); } catch {}

    // uncaught exceptions and unhandled rejections, without touching source
    this.cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      const ex = d.exception || {};
      this.emit({
        n: 'uncaught', k: 'err', t: Date.now(), p: this.producerId, o: 'd',
        d: { message: ex.description || d.text || ex.value, class: ex.className, url: d.url, line: d.lineNumber },
        stack: framesToStack(d.stackTrace),
      });
    });

    if (this.opts.console !== false) {
      this.cdp.on('Runtime.consoleAPICalled', (p) => {
        if (p.type === 'debug' && p.args[0] && p.args[0].value === '__dbg') return;
        this.emit({
          n: `console.${p.type}`, k: p.type === 'error' ? 'err' : 'log', t: p.timestamp || Date.now(), p: this.producerId, o: 'd',
          d: { args: (p.args || []).map(remoteToPlain) },
        });
      });
    }

    // re-inject after a page navigation wipes the context (Chrome)
    this.cdp.on('Runtime.executionContextsCleared', () => {
      this.ready = false;
      this.reinstall().catch(() => {});
    });

    // The CDP Network domain is a browser thing; for Node the preload agent
    // supplies http/fetch spans instead.
    if (this.opts.network && this.kind === 'chrome') {
      this.netTracker = har.attachNetwork(this.cdp, this.emit, this.opts);
      await this.netTracker.enable();
    }

    this.cdp.on('Debugger.paused', (p) => this._onPaused(p));

    await this.bootstrap();
    return this;
  }

  async bootstrap() {
    await this.cdp.evaluate(bootstrapSource({ cap: this.opts.cap }));
    this.ready = true;
  }

  // Distinct from the preload agent's `node:<pid>`. Both can describe the same
  // process, but they keep independent sequence counters — sharing one producer
  // id made the merge sort interleave them by unrelated seq values.
  get producerId() {
    return `cdp:${this.targetPid || this.opts.port || this.kind}`;
  }

  // Normalise a target-side record into the store's event shape.
  _emitCaptured(ev) {
    const out = { s: ev.s, t: ev.t, p: this.producerId, n: ev.n, h: ev.h, o: 't' };
    if (ev.d !== undefined) out.d = ev.d;
    if (ev.c) out.c = ev.c;
    if (ev.k) out.k = ev.k;
    if (ev.l) out.l = ev.l;
    if (ev.ms != null) out.ms = ev.ms;
    this.emit(out);
  }

  async reinstall() {
    await this.bootstrap();
    const configs = [...this.logpoints.values()];
    // Drop the old breakpoints first. Re-installing over them leaves orphans
    // that keep firing and that `dbg lp rm` can no longer address, because the
    // config only remembers the newest id.
    for (const c of configs) {
      if (!c.bpId) continue;
      try { await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: c.bpId }); } catch {}
      c.bpId = null;
    }
    this.bpIds.clear();
    for (const c of configs) {
      try { await this._install(c); } catch {}
    }
  }

  // ---- logpoints ---------------------------------------------------------

  async add(cfg) {
    const id = cfg.id || `lp${this.logpoints.size + 1}`;
    const c = { ...cfg, id, hits: 0 };
    this.logpoints.set(id, c);
    await this._install(c);
    return c;
  }

  async _install(c) {
    const label = c.label || `${path.basename(c.file)}:${c.line}`;
    const params = {
      lineNumber: Math.max(0, c.line - 1),
      // an explicit --url wins: bundled, transpiled and inline-in-HTML scripts
      // rarely match their on-disk filename
      urlRegex: c.url ? c.url : fileToUrlRegex(c.file),
    };
    if (c.col != null) params.columnNumber = c.col;

    if (!c.snapshot) {
      params.condition = buildCondition(c, label);
    } else if (c.when || c.max) {
      // A real (pausing) breakpoint, still gated so it only stops when wanted.
      // --max must use tick(), which increments: snapshots are recorded on this
      // side of the wire, so nothing else ever advances the counter.
      const guards = [];
      if (c.when) guards.push(`__dbg.w(()=>(${c.when}))`);
      if (c.max) guards.push(`__dbg.tick(${JSON.stringify(label)}) <= ${Number(c.max)}`);
      params.condition = guards.map((g) => `(${g})`).join(' && ');
    }

    const r = await this.cdp.send('Debugger.setBreakpointByUrl', params);
    c.bpId = r.breakpointId;
    c.locations = (r.locations || []).length;
    c.resolvedLabel = label;
    this.bpIds.set(r.breakpointId, c.id);
    return c;
  }

  async remove(id) {
    const c = this.logpoints.get(id);
    if (!c) return false;
    if (c.bpId) { try { await this.cdp.send('Debugger.removeBreakpoint', { breakpointId: c.bpId }); } catch {} }
    this.bpIds.delete(c.bpId);
    this.logpoints.delete(id);
    return true;
  }

  async clear() {
    for (const id of [...this.logpoints.keys()]) await this.remove(id);
  }

  // ---- snapshot (pausing) capture ---------------------------------------

  async _onPaused(p) {
    const hit = (p.hitBreakpoints || [])[0];
    const lpId = hit ? this.bpIds.get(hit) : null;
    const c = lpId ? this.logpoints.get(lpId) : null;
    try {
      if (c && c.snapshot && !(c.max && c.hits >= c.max)) {
        const frame = (p.callFrames || [])[0];
        const label = c.resolvedLabel || c.label;
        const scopes = {};
        for (const sc of (frame && frame.scopeChain) || []) {
          if (sc.type === 'global' || !sc.object || !sc.object.objectId) continue;
          try {
            const r = await this.cdp.send('Runtime.callFunctionOn', {
              objectId: sc.object.objectId,
              functionDeclaration: 'function(){return globalThis.__dbg ? globalThis.__dbg.snap(this) : null}',
              returnByValue: true,
            });
            if (r.result && r.result.value) {
              const key = sc.type + (sc.name ? `:${sc.name}` : '');
              scopes[key] = r.result.value;
            }
          } catch {}
        }
        // `this` binding, when it is not the global object
        let self;
        if (frame && frame.this && frame.this.objectId) {
          try {
            const r = await this.cdp.send('Runtime.callFunctionOn', {
              objectId: frame.this.objectId,
              functionDeclaration: 'function(){return (this===globalThis||!globalThis.__dbg) ? null : globalThis.__dbg.snap(this)}',
              returnByValue: true,
            });
            self = r.result && r.result.value;
          } catch {}
        }
        c.hits++;
        this.emit({
          n: label, t: Date.now(), k: 'snap', p: this.producerId, o: 'd',
          d: { ...scopes, ...(self ? { this: self } : {}) },
          l: `${c.file}:${c.line}`,
          stack: framesToStack(p.callFrames && { callFrames: p.callFrames }),
        });
      }
    } finally {
      try { await this.cdp.send('Debugger.resume'); } catch {}
    }
  }

  // ---- draining ----------------------------------------------------------

  // Events normally arrive by push (see Runtime.bindingCalled above). This is
  // the fallback pull for contexts where no binding is installed, and a
  // belt-and-braces sweep of anything still buffered.
  async drain() {
    if (!this.ready || this.exiting) return 0;
    let res;
    try {
      res = await this.cdp.evaluate('globalThis.__dbg ? globalThis.__dbg.drain() : null');
    } catch (e) {
      if (/closed/i.test(e.message)) throw e;
      return 0;
    }
    if (!res || !res.events) return 0;
    if (res.pid && !this.targetPid) this.targetPid = res.pid;
    for (const ev of res.events) this._emitCaptured(ev);
    if (res.dropped) {
      this.emit({ n: '__dropped', k: 'meta', t: Date.now(), p: pid, dropped: res.dropped, d: { dropped: res.dropped } });
    }
    // keep per-logpoint hit counts current for `dbg lp ls`
    for (const c of this.logpoints.values()) {
      const key = c.resolvedLabel || c.label;
      if (res.counts && res.counts[key] != null) c.hits = res.counts[key];
    }
    return res.events.length;
  }

  async status() {
    let stat = null;
    try { stat = await this.cdp.evaluate('globalThis.__dbg ? globalThis.__dbg.stat() : null'); } catch {}
    return {
      target: this.targetInfo,
      kind: this.kind,
      ready: this.ready,
      buffered: stat && stat.buffered,
      scripts: [...this.scripts.values()],
      logpoints: [...this.logpoints.values()].map((c) => ({
        id: c.id, file: c.file, line: c.line, label: c.resolvedLabel || c.label,
        when: c.when, max: c.max, snapshot: !!c.snapshot, hits: c.hits, bound: c.locations,
      })),
    };
  }

  close() { try { this.cdp.close(); } catch {} }
}

// Build the never-pausing logpoint condition. Every captured expression is
// individually guarded so an out-of-scope name degrades to a sentinel instead
// of silently killing the whole probe.
function buildCondition(c, label) {
  const parts = (c.exprs || []).map((ex) => {
    const key = JSON.stringify(exprKey(ex));
    return `${key}:__dbg.g(()=>(${ex}))`;
  });
  const data = parts.length ? `{${parts.join(',')}}` : 'undefined';
  const guards = [];
  if (c.when) guards.push(`__dbg.w(()=>(${c.when}))`);
  if (c.max) guards.push(`__dbg.hits(${JSON.stringify(label)})<${Number(c.max)}`);
  const call = `__dbg(${JSON.stringify(label)},${data}${c.file ? `,{l:${JSON.stringify(c.file + ':' + c.line)}}` : ''})`;
  const body = guards.length ? `(${guards.join('&&')})&&${call}` : call;
  // `__dbg` may not exist yet if the recorder was wiped; degrade to no-pause.
  return `(typeof __dbg!=='undefined')&&(${body})`;
}

function exprKey(ex) {
  const s = String(ex).trim();
  return /^[A-Za-z_$][\w$]*$/.test(s) ? s : s.slice(0, 40);
}

// Match a source path regardless of whether the runtime reports it as an
// absolute path, a file:// URL, or a bundler-relative URL.
function fileToUrlRegex(file) {
  const norm = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
  const esc = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(^|/)${esc}$`;
}

function remoteToPlain(a) {
  if (!a) return null;
  if ('value' in a) return a.value;
  if (a.unserializableValue) return a.unserializableValue;
  if (a.preview) {
    const o = {};
    for (const p of a.preview.properties || []) o[p.name] = p.value;
    return o;
  }
  return a.description || a.type;
}

function framesToStack(st) {
  if (!st || !st.callFrames) return undefined;
  return st.callFrames.slice(0, 8)
    .map((f) => {
      const loc = f.location || f;
      const url = f.url || (f.functionLocation && f.functionLocation.url) || '';
      return `  at ${f.functionName || '<anonymous>'} (${url}:${(loc.lineNumber || 0) + 1}:${(loc.columnNumber || 0) + 1})`;
    })
    .join('\n');
}

module.exports = { LiveSession, buildCondition, fileToUrlRegex };
