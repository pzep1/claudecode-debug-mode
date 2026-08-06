'use strict';
const { render } = require('./serialize');

// Output discipline: every listing is one bounded line per event. Nothing in
// this file may emit unbounded output — an agent's context is the scarce
// resource, so commands answer questions instead of dumping logs.

const WIDTH = Number(process.env.DBG_WIDTH || 150);

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padl(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function relMs(ev, t0) {
  const d = (ev.t || 0) - t0;
  if (d < 1000) return `+${d.toFixed(1)}ms`;
  return `+${(d / 1000).toFixed(2)}s`;
}

function producerShort(p) {
  if (!p) return '?';
  // cdp:<pid> is the debugger (logpoints); node:<pid> is the preload agent
  return String(p).replace(/^cdp:/, 'lp').replace(/^node:/, 'n').replace(/^py:/, 'py');
}

function eventLine(ev, t0, widths) {
  const w = widths || { q: 5, t: 9, p: 8, n: 26 };
  const dur = ev.ms != null ? ` (${ev.ms.toFixed(1)}ms)` : '';
  const head = [
    padl(ev.q, w.q),
    padl(relMs(ev, t0), w.t),
    pad(clip(producerShort(ev.p), w.p), w.p),
    pad(clip((ev.n || '') + dur, w.n), w.n),
  ].join(' ');
  const budget = Math.max(20, WIDTH - head.length - 1);
  let body = ev.d === undefined ? '' : render(ev.d, budget);
  if (ev.k === 'err') body = 'ERROR ' + body;
  return head + ' ' + body;
}

function listing(events, opts = {}) {
  const { total = events.length, hint, t0 } = opts;
  if (!events.length) return (opts.empty || 'no matching events') + (hint ? `\n${hint}` : '');
  let base = t0;
  if (base == null) { base = Infinity; for (const e of events) { const t = e.t || 0; if (t < base) base = t; } if (base === Infinity) base = 0; }
  let widest = 12;
  for (const e of events) { const w = String(e.n || '').length + (e.ms != null ? 10 : 0); if (w > widest) widest = w; }
  const nw = Math.min(34, widest);
  let pwide = 4;
  for (const e of events) { const w = producerShort(e.p).length; if (w > pwide) pwide = w; }
  const pw = Math.min(14, pwide);
  const widths = { q: 5, t: 9, p: pw, n: nw };
  const lines = events.map((e) => eventLine(e, base, widths));
  const out = [
    padl('#', 5) + ' ' + padl('t', 9) + ' ' + pad('src', pw) + ' ' + pad('label', nw) + ' data',
    ...lines,
  ];
  if (total > events.length) {
    out.push(`… ${total - events.length} more of ${total} (narrow with: dbg where '<js>' | dbg stats | dbg show <#>)`);
  }
  if (hint) out.push(hint);
  return out.join('\n');
}

function bar(n, max, width = 24) {
  if (!max) return '';
  const f = Math.max(1, Math.round((n / max) * width));
  return '█'.repeat(f);
}

function human(n) {
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(1) + 'k';
  return (n / 1e6).toFixed(1) + 'M';
}

function dur(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return ms.toFixed(1) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

module.exports = { listing, eventLine, bar, human, clip, pad, padl, dur, relMs, WIDTH, producerShort };
