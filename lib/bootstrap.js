'use strict';
// Source of the in-process recorder that gets injected into the target
// (Node or Chrome) over CDP. It must be a self-contained expression: no
// require, no imports, no dependency on the app's own globals.
//
// Design constraints:
//  - A logpoint hit must cost ~an array push. Anything heavier (a fetch, a
//    console write) perturbs the timing of the very races we're chasing.
//  - It must always evaluate falsy so V8 never actually pauses.
//  - Ordering is captured at hit time via a local counter, not at delivery.

function bootstrapSource(opts = {}) {
  const cap = Number(opts.cap || 20000);
  return `
(function () {
  if (globalThis.__dbg && globalThis.__dbg.__v === 4) return 'already';
  var buf = [], seq = 0, dropped = 0, counts = {}, CAP = ${cap};
  var origin = (typeof performance !== 'undefined' && performance.timeOrigin) || Date.now();
  var now = function () {
    return (typeof performance !== 'undefined' && performance.now) ? origin + performance.now() : Date.now();
  };

  function cap_(v, depth, seen) {
    if (v === null) return null;
    var t = typeof v;
    if (t === 'undefined') return { __t: 'undefined' };
    if (t === 'boolean') return v;
    if (t === 'number') return isFinite(v) ? v : { __t: 'number', v: String(v) };
    if (t === 'bigint') return { __t: 'bigint', v: v.toString() };
    if (t === 'symbol') return { __t: 'symbol', v: String(v) };
    if (t === 'function') return { __t: 'function', v: v.name || '(anonymous)' };
    if (t === 'string') return v.length > 240 ? { __t: 'string', v: v.slice(0, 240), len: v.length } : v;
    if (seen.indexOf(v) !== -1) return { __t: 'circular' };
    if (v instanceof Error) {
      return { __t: 'error', name: v.name, message: v.message, code: v.code,
               stack: String(v.stack || '').split('\\n').slice(0, 6).join('\\n') };
    }
    var kind = Object.prototype.toString.call(v).slice(8, -1);
    if (kind === 'Date') return { __t: 'date', v: isNaN(v) ? 'Invalid Date' : v.toISOString() };
    if (kind === 'RegExp') return { __t: 'regexp', v: String(v) };
    if (kind === 'Promise') return { __t: 'promise' };
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(v)) {
      return { __t: 'buffer', len: v.length, head: v.subarray(0, 16).toString('hex') };
    }
    if (depth >= 4) return { __t: 'truncated', of: kind };
    seen.push(v);
    try {
      if (Array.isArray(v)) {
        var out = [];
        for (var i = 0; i < v.length && i < 40; i++) out.push(cap_(v[i], depth + 1, seen));
        if (v.length > 40) out.push({ __t: 'more', n: v.length - 40 });
        return out;
      }
      if (kind === 'Map') {
        var m = {}, j = 0;
        v.forEach(function (val, k) { if (j++ < 40) m[typeof k === 'object' ? '[obj]' : String(k)] = cap_(val, depth + 1, seen); });
        return { __t: 'map', size: v.size, entries: m };
      }
      if (kind === 'Set') {
        var arr = [], j2 = 0;
        v.forEach(function (x) { if (j2++ < 40) arr.push(cap_(x, depth + 1, seen)); });
        return { __t: 'set', size: v.size, values: arr };
      }
      var o = {}, keys = Object.keys(v), n = 0;
      for (var ki = 0; ki < keys.length; ki++) {
        if (n >= 40) { o.__more = keys.length - 40; break; }
        var k2 = keys[ki];
        var d = Object.getOwnPropertyDescriptor(v, k2);
        if (!d) continue;
        if (d.get) { o[k2] = { __t: 'getter' }; n++; continue; }
        o[k2] = cap_(d.value, depth + 1, seen);
        n++;
      }
      if (v.constructor && v.constructor.name && v.constructor.name !== 'Object') o.__class = v.constructor.name;
      return o;
    } catch (e) {
      return { __t: 'uncapturable', why: String(e && e.message) };
    } finally {
      seen.pop();
    }
  }

  // Delivery. When the debugger has installed a binding we push events out
  // over the inspector channel: a pull-based drain loses everything captured
  // by a short-lived process, because V8 tears the context down before the
  // final poll can run. Without a binding we fall back to buffering for a
  // pull (browser snippets, sink-only producers).
  var sched = false;
  var flush = function () {
    sched = false;
    if (!buf.length) return;
    if (typeof __dbgSend !== 'function') return;   // no channel: keep buffering
    var batch = buf.splice(0, buf.length);
    try { __dbgSend(JSON.stringify(batch)); }
    catch (e) { /* channel gone: drop rather than grow without bound */ }
  };

  var rec = function (name, data, meta) {
    try {
      counts[name] = (counts[name] || 0) + 1;
      var ev = { s: ++seq, t: now(), n: name, h: counts[name] };
      if (data !== undefined) ev.d = cap_(data, 0, []);
      if (meta) { for (var k in meta) ev[k] = meta[k]; }
      buf.push(ev);
      if (typeof __dbgSend === 'function') {
        // a microtask still runs inside the current tick, so events escape
        // even if the program exits immediately afterwards
        if (buf.length >= 64) flush();
        else if (!sched) { sched = true; (typeof queueMicrotask === 'function' ? queueMicrotask : function (f) { Promise.resolve().then(f); })(flush); }
      } else if (buf.length > CAP) { buf.shift(); dropped++; }
    } catch (e) { /* never let instrumentation break the program */ }
    return false;
  };
  rec.flush = flush;

  rec.__v = 4;   // bump whenever the recorder gains or changes a method
  // guarded evaluation: a variable that is not in scope yields a sentinel
  // instead of throwing out of the breakpoint condition.
  rec.g = function (f) { try { var v = f(); return v === undefined ? { __t: 'undefined' } : v; } catch (e) { return { __t: 'oos', why: String(e && e.message).slice(0, 60) }; } };
  rec.hits = function (name) { return counts[name] || 0; };
  // Increment-and-return, for capping capture modes that record on the client
  // side (--snapshot): there the recorder is never called, so a read-only hit
  // count would stay at zero forever and --max would never bite.
  rec.tick = function (name) { return (counts[name] = (counts[name] || 0) + 1); };
  // boolean guard for --when: an out-of-scope name must mean "do not capture",
  // never "throw out of the breakpoint condition" (which silently disables it)
  rec.w = function (f) { try { return !!f(); } catch (e) { return false; } };
  // capture an arbitrary object graph (used for --snapshot full-scope grabs,
  // where the CLI hands us a scope object it got from the debugger)
  rec.snap = function (o) { try { return cap_(o, 0, []); } catch (e) { return { __t: 'uncapturable' }; } };
  rec.drain = function () {
    var evs = buf.splice(0, buf.length), d = dropped;
    dropped = 0;
    return { events: evs, dropped: d, counts: counts, pid: (typeof process !== 'undefined' && process.pid) || 0 };
  };
  rec.stat = function () { return { buffered: buf.length, dropped: dropped, counts: counts, seq: seq }; };
  rec.reset = function () { buf.length = 0; seq = 0; dropped = 0; counts = {}; };
  globalThis.__dbg = rec;
  return 'ok';
})()`;
}

module.exports = { bootstrapSource };
