'use strict';
const net = require('net');
const fs = require('fs');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForFile(p, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        if (raw) return JSON.parse(raw);
      } catch {}
    }
    await sleep(60);
  }
  throw new Error('timed out waiting for the recorder to start');
}

// Minimal argv parser: --flag, --key val, --key=val, -n val, and `--` passthrough.
function parseArgs(argv, opts = {}) {
  const bools = new Set(opts.bools || []);
  const alias = opts.alias || {};
  const out = { _: [], rest: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      k = alias[k] || k;
      if (v !== undefined) { pushVal(out, k, v); continue; }
      if (bools.has(k)) { out[k] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && !bools.has(k))) { out[k] = true; continue; }
      pushVal(out, k, next);
      i++;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(a)) {
      const k = alias[a.slice(1)] || a.slice(1);
      if (bools.has(k)) { out[k] = true; continue; }
      pushVal(out, k, argv[++i]);
      continue;
    }
    out._.push(a);
  }
  return out;
}

function pushVal(out, k, v) {
  if (out[k] === undefined) out[k] = v;
  else if (Array.isArray(out[k])) out[k].push(v);
  else out[k] = [out[k], v];
}

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

module.exports = { freePort, sleep, waitForFile, parseArgs, asArray, num };
