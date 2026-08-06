'use strict';
const store = require('./store');
const fmt = require('./fmt');
const { shape, render } = require('./serialize');

// Comparing two recordings is how you actually find a regression or a flake:
// "it worked before" becomes a concrete first point of divergence.

function sig(e, withValues) {
  const base = `${e.n}`;
  if (!withValues) return `${base}|${shape(e.d)}`;
  return `${base}|${stableValue(e.d)}`;
}

// Values that legitimately differ between runs (timestamps, ids, ports, paths
// with pids) are normalised away so they do not drown the real divergence.
function stableValue(v) {
  const s = JSON.stringify(v, (k, val) => {
    if (typeof val === 'number') {
      if (!Number.isInteger(val)) return '<f>';
      if (val > 1e12) return '<ts>';
      return val;
    }
    if (typeof val === 'string') {
      if (/^[0-9a-f]{8,}$/i.test(val)) return '<hex>';
      if (/^\d{4}-\d{2}-\d{2}T/.test(val)) return '<date>';
      if (/^https?:\/\/[^/]*:\d+/.test(val)) return val.replace(/:\d+/, ':<port>');
      return val;
    }
    return val;
  });
  return s === undefined ? '' : s;
}

function diffRuns(cwd, aSpec, bSpec, opts = {}) {
  const runs = store.listRuns(cwd);
  const aId = store.resolveRun(cwd, aSpec);
  const bId = bSpec ? store.resolveRun(cwd, bSpec) : (runs.length ? runs[runs.length - 1].id : null);
  if (!aId) throw new Error(`run not found: ${aSpec}`);
  if (!bId) throw new Error(`run not found: ${bSpec || 'latest'}`);
  if (aId === bId) throw new Error('both sides resolve to the same run');

  const A = store.readEvents(cwd, aId);
  const B = store.readEvents(cwd, bId);
  const ma = store.readMeta(cwd, aId);
  const mb = store.readMeta(cwd, bId);
  const withValues = opts.values !== false;

  const out = [];
  out.push(`A  ${aId}  ${A.length} events${ma.exitCode != null ? `  exit=${ma.exitCode}` : ''}`);
  out.push(`B  ${bId}  ${B.length} events${mb.exitCode != null ? `  exit=${mb.exitCode}` : ''}`);
  out.push('');

  // 1. label-level differences — the coarse "what changed at all" view
  const ca = countBy(A), cb = countBy(B);
  const labels = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  const deltas = [];
  for (const l of labels) {
    const x = ca[l] || 0, y = cb[l] || 0;
    if (x !== y) deltas.push({ l, x, y });
  }
  if (deltas.length) {
    deltas.sort((p, q) => Math.abs(q.y - q.x) - Math.abs(p.y - p.x));
    out.push(`label counts differ (${deltas.length}):`);
    for (const d of deltas.slice(0, 12)) {
      const marker = d.x === 0 ? 'only in B' : d.y === 0 ? 'only in A' : '';
      out.push(`  ${fmt.pad(fmt.clip(d.l, 34), 34)} A=${fmt.padl(d.x, 6)}  B=${fmt.padl(d.y, 6)}  ${marker}`);
    }
    if (deltas.length > 12) out.push(`  … ${deltas.length - 12} more`);
    out.push('');
  } else {
    out.push('label counts identical');
    out.push('');
  }

  // 2. first divergence in execution order — usually the actual bug site
  const n = Math.min(A.length, B.length);
  let i = 0;
  for (; i < n; i++) {
    if (sig(A[i], withValues) !== sig(B[i], withValues)) break;
  }
  if (i === n && A.length === B.length) {
    out.push(`no divergence: both runs produced the same ${n} events${withValues ? ' with the same values' : ' in the same shape'}`);
    return out.join('\n');
  }
  if (i === n) {
    out.push(`identical for the first ${n} events, then ${A.length > B.length ? 'A continues' : 'B continues'}:`);
    const longer = A.length > B.length ? A : B;
    const side = A.length > B.length ? 'A' : 'B';
    const t0 = longer.length ? longer[0].t : 0;
    for (const e of longer.slice(n, n + 6)) out.push(`  ${side} ${fmt.eventLine(e, t0)}`);
    return out.join('\n');
  }

  out.push(`first divergence at event ${i + 1} of ${n}:`);
  const t0a = A.length ? A[0].t : 0, t0b = B.length ? B[0].t : 0;
  out.push(`  A ${fmt.eventLine(A[i], t0a)}`);
  out.push(`  B ${fmt.eventLine(B[i], t0b)}`);
  const fd = fieldDiff(A[i].d, B[i].d);
  if (fd.length) {
    out.push('  differing fields:');
    for (const f of fd.slice(0, 10)) out.push(`    ${fmt.pad(f.path, 26)} A=${fmt.clip(f.a, 40)}   B=${fmt.clip(f.b, 40)}`);
  }
  out.push('');
  out.push('  context (A):');
  for (const e of A.slice(Math.max(0, i - 3), i + 3)) {
    out.push(`    ${e.q === A[i].q ? '>' : ' '} ${fmt.eventLine(e, t0a).trim()}`);
  }
  out.push('  context (B):');
  for (const e of B.slice(Math.max(0, i - 3), i + 3)) {
    out.push(`    ${e.q === B[i].q ? '>' : ' '} ${fmt.eventLine(e, t0b).trim()}`);
  }
  out.push('');
  out.push(`inspect: dbg show ${A[i].q} --run ${aId}   |   dbg show ${B[i].q} --run ${bId}`);
  return out.join('\n');
}

function countBy(events) {
  const o = {};
  for (const e of events) o[e.n || '?'] = (o[e.n || '?'] || 0) + 1;
  return o;
}

function fieldDiff(a, b, prefix = '', depth = 0, acc = []) {
  if (depth > 4 || acc.length > 40) return acc;
  const ta = typeof a, tb = typeof b;
  if (a === null || b === null || ta !== 'object' || tb !== 'object' || Array.isArray(a) !== Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) acc.push({ path: prefix || '(value)', a: render(a, 60), b: render(b, 60) });
    return acc;
  }
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const va = a ? a[k] : undefined, vb = b ? b[k] : undefined;
    if (JSON.stringify(va) === JSON.stringify(vb)) continue;
    if (va && vb && typeof va === 'object' && typeof vb === 'object') fieldDiff(va, vb, p, depth + 1, acc);
    else acc.push({ path: p, a: render(va, 60), b: render(vb, 60) });
  }
  return acc;
}

module.exports = { diffRuns, fieldDiff };
