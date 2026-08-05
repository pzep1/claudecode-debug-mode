'use strict';
// Capture arbitrary runtime values without ever throwing, without unbounded
// growth, and without triggering getters (which can have side effects on the
// program under test).

const LIMITS = {
  depth: 4,
  keys: 40,
  items: 40,
  str: 240,
  stack: 6,
};

function tag(v) {
  return Object.prototype.toString.call(v).slice(8, -1);
}

function capture(value, limits = LIMITS) {
  const seen = new WeakSet();

  function walk(v, depth) {
    if (v === null) return null;
    const t = typeof v;

    if (t === 'undefined') return { __t: 'undefined' };
    if (t === 'boolean' || t === 'number') return Number.isFinite(v) || t === 'boolean' ? v : { __t: 'number', v: String(v) };
    if (t === 'bigint') return { __t: 'bigint', v: v.toString() };
    if (t === 'symbol') return { __t: 'symbol', v: String(v) };
    if (t === 'function') return { __t: 'function', v: v.name || '(anonymous)' };
    if (t === 'string') {
      return v.length > limits.str ? { __t: 'string', v: v.slice(0, limits.str), len: v.length } : v;
    }

    // objects
    if (seen.has(v)) return { __t: 'circular' };

    const kind = tag(v);
    if (kind === 'Error' || v instanceof Error) {
      const stack = String(v.stack || '').split('\n').slice(0, limits.stack).join('\n');
      return { __t: 'error', name: v.name, message: v.message, stack, code: v.code };
    }
    if (kind === 'Date') return { __t: 'date', v: isNaN(v) ? 'Invalid Date' : v.toISOString() };
    if (kind === 'RegExp') return { __t: 'regexp', v: String(v) };
    if (kind === 'Promise') return { __t: 'promise' };
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) {
      return { __t: 'buffer', len: v.length, head: v.subarray(0, 16).toString('hex') };
    }
    if (ArrayBuffer.isView(v) && kind !== 'DataView') {
      return { __t: kind, len: v.length, head: Array.from(v.subarray(0, 8)) };
    }

    if (depth >= limits.depth) return { __t: 'truncated', of: kind };

    seen.add(v);
    try {
      if (Array.isArray(v)) {
        const out = v.slice(0, limits.items).map((x) => walk(x, depth + 1));
        if (v.length > limits.items) out.push({ __t: 'more', n: v.length - limits.items });
        return out;
      }
      if (kind === 'Map') {
        const out = {};
        let i = 0;
        for (const [k, val] of v) {
          if (i++ >= limits.keys) { out.__more = v.size - limits.keys; break; }
          out[typeof k === 'object' ? `[${tag(k)}]` : String(k)] = walk(val, depth + 1);
        }
        return { __t: 'map', size: v.size, entries: out };
      }
      if (kind === 'Set') {
        const arr = [];
        let i = 0;
        for (const x of v) {
          if (i++ >= limits.items) break;
          arr.push(walk(x, depth + 1));
        }
        return { __t: 'set', size: v.size, values: arr };
      }

      // plain-ish object: own enumerable data properties only, never invoke getters
      const out = {};
      const descs = Object.getOwnPropertyDescriptors(v);
      let i = 0;
      for (const k of Object.keys(descs)) {
        if (i >= limits.keys) { out.__more = Object.keys(descs).length - limits.keys; break; }
        const d = descs[k];
        if (!d.enumerable) continue;
        if (d.get) { out[k] = { __t: 'getter' }; i++; continue; }
        out[k] = walk(d.value, depth + 1);
        i++;
      }
      const ctor = v.constructor && v.constructor.name;
      if (ctor && ctor !== 'Object') out.__class = ctor;
      return out;
    } catch (e) {
      return { __t: 'uncapturable', why: String(e && e.message) };
    } finally {
      seen.delete(v);
    }
  }

  try {
    return walk(value, 0);
  } catch (e) {
    return { __t: 'uncapturable', why: String(e && e.message) };
  }
}

// Render a captured value back to a short human/agent-readable string.
function render(v, budget = 100) {
  const s = renderFull(v);
  return s.length > budget ? s.slice(0, budget - 1) + '…' : s;
}

function renderFull(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'number' || t === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(renderFull).join(',') + ']';
  if (t === 'object') {
    switch (v.__t) {
      case 'undefined': return 'undefined';
      case 'circular': return '<circular>';
      case 'truncated': return `<${v.of}…>`;
      case 'getter': return '<getter>';
      case 'function': return `fn ${v.v}`;
      case 'bigint': return `${v.v}n`;
      case 'symbol': return v.v;
      case 'string': return JSON.stringify(v.v) + `…(${v.len})`;
      case 'number': return v.v;
      case 'date': return v.v;
      case 'regexp': return v.v;
      case 'promise': return '<Promise>';
      case 'buffer': return `<Buffer ${v.len}B>`;
      case 'more': return `…+${v.n}`;
      case 'error': return `${v.name}: ${v.message}`;
      case 'map': return `Map(${v.size})${renderFull(v.entries)}`;
      case 'set': return `Set(${v.size})[${(v.values || []).map(renderFull).join(',')}]`;
      case 'uncapturable': return '<uncapturable>';
      default: {
        const parts = [];
        for (const k of Object.keys(v)) {
          if (k === '__class') continue;
          parts.push(`${k}=${renderFull(v[k])}`);
        }
        const body = parts.join(' ');
        return v.__class ? `${v.__class}{${body}}` : `{${body}}`;
      }
    }
  }
  return String(v);
}

// Structural signature, used by `dbg diff` to compare runs while ignoring
// values that legitimately change between runs (ids, timings, ports).
function shape(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'number') return 'num';
  if (t === 'boolean') return String(v);
  if (t === 'string') return 'str';
  if (Array.isArray(v)) return `[${v.length ? shape(v[0]) : ''}×${v.length}]`;
  if (t === 'object') {
    if (v.__t) return v.__t === 'error' ? `error:${v.name}` : v.__t;
    return '{' + Object.keys(v).sort().map((k) => `${k}:${shape(v[k])}`).join(',') + '}';
  }
  return t;
}

module.exports = { capture, render, renderFull, shape, LIMITS };
