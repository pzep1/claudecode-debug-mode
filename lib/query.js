'use strict';
const store = require('./store');
const fmt = require('./fmt');
const { renderFull, render } = require('./serialize');

function load(cwd, runSpec) {
  const id = store.resolveRun(cwd, runSpec);
  if (!id) throw new Error('no recorded runs (start one with: dbg run <cmd> | dbg attach | dbg sink)');
  return { id, meta: store.readMeta(cwd, id), events: store.readEvents(cwd, id) };
}

// Reduce, never spread: `Math.min(...arr)` throws RangeError once a recording
// grows past ~100k events, which is exactly when you most need these commands.
function t0of(events) {
  let min = Infinity;
  for (const e of events) { const t = e.t || 0; if (t < min) min = t; }
  return min === Infinity ? 0 : min;
}

function t1of(events) {
  let max = -Infinity;
  for (const e of events) { const t = e.t || 0; if (t > max) max = t; }
  return max === -Infinity ? 0 : max;
}

function makePredicate(expr) {
  if (!expr) return () => true;
  let fn;
  try {
    // `d` is the captured payload, `n` label, `p` producer, `c` correlation id,
    // `ms` span duration, `e` the whole event.
    fn = new Function('e', 'd', 'n', 'p', 'c', 'ms', 'k', 'q', `return (${expr});`);
  } catch (err) {
    throw new Error(`bad filter expression: ${err.message}`);
  }
  return (e) => {
    try { return !!fn(e, e.d || {}, e.n || '', e.p || '', e.c, e.ms, e.k, e.q); } catch { return false; }
  };
}

function filterEvents(events, opts = {}) {
  let out = events;
  if (opts.label) {
    const rx = new RegExp(opts.label);
    out = out.filter((e) => rx.test(e.n || ''));
  }
  if (opts.producer) out = out.filter((e) => String(e.p || '').includes(opts.producer));
  if (opts.corr) out = out.filter((e) => e.c === opts.corr);
  if (opts.kind) out = out.filter((e) => e.k === opts.kind);
  if (opts.since != null) out = out.filter((e) => e.q >= opts.since);
  if (opts.expr) out = out.filter(makePredicate(opts.expr));
  return out;
}

function tail(cwd, opts) {
  const { id, events } = load(cwd, opts.run);
  const sel = filterEvents(events, opts);
  const n = opts.limit || 20;
  const shown = sel.slice(-n);
  return header(id, events) + '\n' + fmt.listing(shown, { total: sel.length, t0: t0of(events) });
}

function head(cwd, opts) {
  const { id, events } = load(cwd, opts.run);
  const sel = filterEvents(events, opts);
  const n = opts.limit || 20;
  return header(id, events) + '\n' + fmt.listing(sel.slice(0, n), { total: sel.length, t0: t0of(events) });
}

function around(cwd, q, opts) {
  const { id, events } = load(cwd, opts.run);
  const n = opts.limit || 8;
  const i = events.findIndex((e) => e.q === Number(q));
  if (i < 0) throw new Error(`event #${q} not found in run ${id}`);
  const slice = events.slice(Math.max(0, i - n), i + n + 1);
  const t0 = t0of(events);
  const lines = slice.map((e) => (e.q === Number(q) ? '>' : ' ') + fmt.eventLine(e, t0).slice(1));
  return header(id, events) + `\ncontext around #${q}:\n` + lines.join('\n');
}

function show(cwd, q, opts) {
  const { id, events } = load(cwd, opts.run);
  const e = events.find((x) => x.q === Number(q));
  if (!e) throw new Error(`event #${q} not found in run ${id}`);
  const out = [
    `run      ${id}`,
    `#${e.q}  seq=${e.s} producer=${e.p}`,
    `label    ${e.n}`,
    `time     ${new Date(e.t).toISOString()} (+${(e.t - t0of(events)).toFixed(1)}ms)`,
  ];
  if (e.l) out.push(`loc      ${e.l}`);
  if (e.c) out.push(`corr     ${e.c}`);
  if (e.ms != null) out.push(`duration ${fmt.dur(e.ms)}`);
  if (e.stack) out.push(`stack\n${String(e.stack).split('\n').map((l) => '  ' + l).join('\n')}`);
  out.push('data');
  out.push(indentJson(e.d));
  return out.join('\n');
}

function indentJson(v) {
  try { return JSON.stringify(v, null, 2).split('\n').map((l) => '  ' + l).join('\n'); }
  catch { return '  ' + renderFull(v); }
}

function where(cwd, expr, opts) {
  const { id, events } = load(cwd, opts.run);
  const sel = filterEvents(events, { ...opts, expr });
  const n = opts.limit || 20;
  const shown = opts.last ? sel.slice(-n) : sel.slice(0, n);
  return header(id, events) + `\nfilter: ${expr}  → ${sel.length} match${sel.length === 1 ? '' : 'es'}\n`
    + fmt.listing(shown, { total: sel.length, t0: t0of(events), empty: 'no events matched' });
}

function timeline(cwd, opts) {
  const { id, events } = load(cwd, opts.run);
  const sel = filterEvents(events, opts);
  const n = opts.limit || 40;
  const t0 = t0of(events);
  if (opts.corr) {
    return header(id, events) + `\ntrace ${opts.corr} (${sel.length} events across `
      + new Set(sel.map((e) => e.p)).size + ' processes)\n'
      + fmt.listing(sel.slice(0, n), { total: sel.length, t0 });
  }
  return header(id, events) + '\n' + fmt.listing(sel.slice(0, n), { total: sel.length, t0 });
}

function slow(cwd, opts) {
  const { id, events } = load(cwd, opts.run);
  const spans = filterEvents(events, opts).filter((e) => e.ms != null);
  if (!spans.length) return header(id, events) + '\nno duration-bearing events (spans) recorded';
  spans.sort((a, b) => b.ms - a.ms);
  const n = opts.limit || 15;
  const max = spans[0].ms;
  const lines = spans.slice(0, n).map((e) =>
    `${fmt.padl(e.q, 5)} ${fmt.padl(fmt.dur(e.ms), 9)} ${fmt.pad(fmt.bar(e.ms, max, 20), 20)} ${fmt.clip(e.n, 40)} ${render(e.d, 40)}`);
  const total = spans.reduce((a, e) => a + e.ms, 0);
  return header(id, events) + `\nslowest spans (${spans.length} total, sum ${fmt.dur(total)})\n` + lines.join('\n');
}

function header(id, events) {
  return `run ${id} · ${events.length} events`;
}

// The headline command: "what happened?" in a fixed, small number of lines
// regardless of how large the run is.
function stats(cwd, opts) {
  const { id, meta, events } = load(cwd, opts.run);
  if (!events.length) {
    return `run ${id}: no events recorded.\n`
      + 'nothing was captured — check that a producer was attached (dbg lp ls / dbg sink) and that the code path actually ran.';
  }
  const t0 = t0of(events);
  const t1 = t1of(events);
  const out = [];
  out.push(`run       ${id}`);
  if (meta.cmd) out.push(`cmd       ${meta.cmd}`);
  if (meta.exitCode != null) out.push(`exit      ${meta.exitCode}${meta.signal ? ' signal=' + meta.signal : ''}`);
  out.push(`events    ${events.length} over ${fmt.dur(t1 - t0)}`);

  const producers = {};
  for (const e of events) producers[e.p || '?'] = (producers[e.p || '?'] || 0) + 1;
  out.push(`producers ${Object.entries(producers).map(([k, v]) => `${k}(${v})`).join(' ')}`);

  const dropped = events.reduce((a, e) => a + (e.dropped || 0), 0);
  if (dropped) out.push(`DROPPED   ${dropped} events lost to ring-buffer overflow — narrow with --when or raise --cap`);

  const errs = events.filter((e) => e.k === 'err');
  if (errs.length) {
    out.push('');
    out.push(`errors    ${errs.length}`);
    for (const e of errs.slice(0, 5)) out.push(`  #${e.q} ${fmt.clip(e.n, 28)} ${render(e.d, 90)}`);
    if (errs.length > 5) out.push(`  … ${errs.length - 5} more (dbg where 'k==="err"')`);
  }

  const nets = events.filter((e) => e.k === 'net' && (e.d && (e.d.status != null || e.d.error)));
  if (nets.length) {
    const bad = nets.filter((e) => !e.d || !e.d.status || e.d.status >= 400 || e.d.failed);
    out.push('');
    out.push(`network   ${nets.length} requests, ${bad.length} failed/4xx/5xx  (dbg net)`);
    for (const e of bad.slice(0, 4)) {
      out.push(`  #${e.q} ${fmt.clip((e.d && e.d.method) || '?', 6)} ${(e.d && e.d.status) || (e.d && e.d.error) || 'no-response'} ${fmt.clip((e.d && e.d.url) || '', 70)}`);
    }
  }

  // label histogram
  const byLabel = {};
  for (const e of events) byLabel[e.n || '?'] = (byLabel[e.n || '?'] || 0) + 1;
  const labels = Object.entries(byLabel).sort((a, b) => b[1] - a[1]);
  const maxc = labels.length ? labels[0][1] : 0;
  out.push('');
  out.push(`labels    ${labels.length}`);
  for (const [l, c] of labels.slice(0, 12)) {
    out.push(`  ${fmt.pad(fmt.clip(l, 32), 32)} ${fmt.padl(fmt.human(c), 6)} ${fmt.bar(c, maxc, 18)}`);
  }
  if (labels.length > 12) out.push(`  … ${labels.length - 12} more labels`);

  // largest execution gaps — bugs frequently live in the stall
  if (events.length > 2) {
    const gaps = [];
    for (let i = 1; i < events.length; i++) {
      gaps.push({ ms: (events[i].t || 0) - (events[i - 1].t || 0), a: events[i - 1], b: events[i] });
    }
    gaps.sort((x, y) => y.ms - x.ms);
    const top = gaps.filter((g) => g.ms > 1).slice(0, 3);
    if (top.length) {
      out.push('');
      out.push('gaps      largest stalls between consecutive events');
      for (const g of top) out.push(`  ${fmt.padl(fmt.dur(g.ms), 9)} between #${g.a.q} ${fmt.clip(g.a.n, 24)} → #${g.b.q} ${fmt.clip(g.b.n, 24)}`);
    }
  }

  const corrs = new Set(events.map((e) => e.c).filter(Boolean));
  if (corrs.size) {
    out.push('');
    out.push(`traces    ${corrs.size} correlation ids (dbg timeline --corr <id>)`);
    for (const c of [...corrs].slice(0, 3)) {
      const evs = events.filter((e) => e.c === c);
      const procs = new Set(evs.map((e) => e.p)).size;
      out.push(`  ${fmt.pad(c, 22)} ${fmt.padl(evs.length, 4)} events / ${procs} process${procs === 1 ? '' : 'es'}`);
    }
  }
  return out.join('\n');
}

module.exports = { load, tail, head, where, timeline, around, show, stats, slow, filterEvents, makePredicate, t0of, t1of, header };
