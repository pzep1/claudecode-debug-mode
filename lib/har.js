'use strict';
const fs = require('fs');

// Network capture. Three ways in:
//   1. live from Chrome via the CDP Network domain
//   2. live from Node via the preload agent's http/fetch hooks
//   3. imported from a .har exported by DevTools, Charles, mitmproxy, etc.
// All three land as `k:'net'` events on the same timeline as logpoints, which
// is the point: "the request never went out" and "the handler never ran" look
// identical in a log and completely different on a merged timeline.

const BODY_CAP = 4000;

function attachNetwork(cdp, emit, opts = {}) {
  const inflight = new Map();

  function enable() {
    return cdp.send('Network.enable', { maxTotalBufferSize: 10e6, maxResourceBufferSize: 5e6 });
  }

  cdp.on('Network.requestWillBeSent', (p) => {
    const r = p.request || {};
    // Chrome reuses the requestId across a redirect chain and delivers the
    // previous hop's response here. Emit that hop from the entry it actually
    // belongs to, BEFORE overwriting it with the new destination.
    if (p.redirectResponse) {
      const prev = inflight.get(p.requestId);
      if (prev) {
        emitNet({
          ...prev,
          status: p.redirectResponse.status,
          statusText: p.redirectResponse.statusText,
          resHeaders: p.redirectResponse.headers || {},
          ms: p.timestamp && prev.mono ? (p.timestamp - prev.mono) * 1000 : 0,
          note: 'redirect',
          location: (p.redirectResponse.headers || {}).location || (p.redirectResponse.headers || {}).Location,
        });
      }
    }
    inflight.set(p.requestId, {
      id: p.requestId,
      method: r.method,
      url: r.url,
      headers: r.headers || {},
      postData: r.postData,
      t: p.wallTime ? p.wallTime * 1000 : Date.now(),
      mono: p.timestamp,
      type: p.type,
      initiator: p.initiator && p.initiator.type,
      corr: pickCorr(r.headers),
      redirect: !!p.redirectResponse,
    });
  });

  cdp.on('Network.responseReceived', (p) => {
    const e = inflight.get(p.requestId);
    if (!e) return;
    const r = p.response || {};
    e.status = r.status;
    e.statusText = r.statusText;
    e.mime = r.mimeType;
    e.resHeaders = r.headers || {};
    e.remote = r.remoteIPAddress;
    e.fromCache = r.fromDiskCache || r.fromServiceWorker;
    e.timing = r.timing;
  });

  cdp.on('Network.loadingFinished', async (p) => {
    const e = inflight.get(p.requestId);
    if (!e) return;
    inflight.delete(p.requestId);
    e.size = p.encodedDataLength;
    e.ms = p.timestamp && e.mono ? (p.timestamp - e.mono) * 1000 : undefined;
    // pull the body for failures — "it returned 500" is not actionable, the
    // body usually is
    if (opts.bodies !== false && e.status >= 400) {
      try {
        const b = await cdp.send('Network.getResponseBody', { requestId: p.requestId });
        if (b && b.body) e.body = String(b.body).slice(0, BODY_CAP);
      } catch {}
    }
    emitNet(e);
  });

  cdp.on('Network.loadingFailed', (p) => {
    const e = inflight.get(p.requestId);
    if (!e) return;
    inflight.delete(p.requestId);
    e.ms = p.timestamp && e.mono ? (p.timestamp - e.mono) * 1000 : undefined;
    e.failed = true;
    e.error = p.errorText;
    e.blocked = p.blockedReason;
    e.corsError = p.corsErrorStatus && p.corsErrorStatus.corsError;
    emitNet(e);
  });

  function emitNet(e) {
    const u = safeUrl(e.url);
    emit({
      n: `${e.method || 'GET'} ${u.short}`,
      k: 'net',
      t: e.t,
      ms: e.ms,
      c: e.corr,
      d: compact({
        method: e.method,
        url: e.url,
        status: e.status,
        statusText: e.statusText,
        ms: e.ms != null ? round(e.ms) : undefined,
        size: e.size,
        type: e.type,
        mime: e.mime,
        from: e.initiator,
        cached: e.fromCache || undefined,
        error: e.error,
        blocked: e.blocked,
        cors: e.corsError,
        note: e.note,
        location: e.location,
        body: e.body,
        reqBody: e.postData ? String(e.postData).slice(0, BODY_CAP) : undefined,
      }),
      har: harEntry(e),
    });
  }

  return { enable, inflight };
}

function pickCorr(headers) {
  if (!headers) return undefined;
  for (const k of Object.keys(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'x-dbg-corr' || lk === 'x-request-id' || lk === 'traceparent') {
      const v = String(headers[k]);
      return lk === 'traceparent' ? v.split('-')[1] : v;
    }
  }
  return undefined;
}

function safeUrl(u) {
  try {
    const p = new URL(u);
    const short = p.pathname.length > 1 ? p.pathname : p.host;
    return { short: short.length > 48 ? '…' + short.slice(-47) : short, host: p.host, path: p.pathname };
  } catch {
    return { short: String(u || '').slice(0, 48), host: '', path: String(u || '') };
  }
}

function compact(o) {
  const out = {};
  for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}
function round(n) { return Math.round(n * 10) / 10; }

// ---- HAR ----------------------------------------------------------------

function headerPairs(h) {
  if (!h) return [];
  return Object.keys(h).map((name) => ({ name, value: String(h[name]) }));
}

function harEntry(e) {
  const t = e.ms != null ? e.ms : 0;
  let queryString = [];
  try { queryString = [...new URL(e.url).searchParams].map(([name, value]) => ({ name, value })); } catch {}
  return {
    startedDateTime: new Date(e.t || Date.now()).toISOString(),
    time: round(t),
    request: {
      method: e.method || 'GET',
      url: e.url,
      httpVersion: 'HTTP/1.1',
      headers: headerPairs(e.headers),
      queryString,
      cookies: [],
      headersSize: -1,
      bodySize: e.postData ? Buffer.byteLength(String(e.postData)) : 0,
      ...(e.postData ? { postData: { mimeType: (e.headers && (e.headers['content-type'] || e.headers['Content-Type'])) || 'application/octet-stream', text: String(e.postData).slice(0, BODY_CAP) } } : {}),
    },
    response: {
      status: e.status || 0,
      statusText: e.statusText || (e.error ? 'Failed' : ''),
      httpVersion: 'HTTP/1.1',
      headers: headerPairs(e.resHeaders),
      cookies: [],
      content: { size: e.size || 0, mimeType: e.mime || '', ...(e.body ? { text: e.body } : {}) },
      redirectURL: e.location || '',
      headersSize: -1,
      bodySize: e.size || 0,
      ...(e.error ? { _error: e.error } : {}),
    },
    cache: {},
    timings: harTimings(e),
    serverIPAddress: e.remote || '',
    _initiator: e.initiator,
    _corr: e.corr,
  };
}

function harTimings(e) {
  const t = e.timing;
  const total = e.ms != null ? e.ms : 0;
  if (!t) return { send: 0, wait: round(total), receive: 0 };
  const wait = t.receiveHeadersEnd != null && t.sendEnd != null ? Math.max(0, t.receiveHeadersEnd - t.sendEnd) : total;
  return {
    blocked: -1,
    dns: t.dnsStart >= 0 && t.dnsEnd >= 0 ? round(t.dnsEnd - t.dnsStart) : -1,
    connect: t.connectStart >= 0 && t.connectEnd >= 0 ? round(t.connectEnd - t.connectStart) : -1,
    ssl: t.sslStart >= 0 && t.sslEnd >= 0 ? round(t.sslEnd - t.sslStart) : -1,
    send: t.sendStart >= 0 && t.sendEnd >= 0 ? round(t.sendEnd - t.sendStart) : 0,
    wait: round(wait),
    receive: round(Math.max(0, total - wait)),
  };
}

// Merge a HAR file onto the timeline.
function importHar(file, opts = {}) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = (raw.log && raw.log.entries) || [];
  const out = [];
  let s = 0;
  for (const en of entries) {
    const req = en.request || {};
    const res = en.response || {};
    const t = Date.parse(en.startedDateTime) || Date.now();
    const u = safeUrl(req.url);
    const hdrs = {};
    for (const h of req.headers || []) hdrs[h.name] = h.value;
    const body = res.content && res.content.text ? String(res.content.text).slice(0, BODY_CAP) : undefined;
    out.push({
      s: ++s,
      t,
      p: opts.producer || 'har',
      n: `${req.method || 'GET'} ${u.short}`,
      k: 'net',
      ms: en.time,
      c: pickCorr(hdrs),
      d: compact({
        method: req.method,
        url: req.url,
        status: res.status,
        statusText: res.statusText,
        ms: en.time != null ? round(en.time) : undefined,
        size: res.bodySize > 0 ? res.bodySize : (res.content && res.content.size),
        mime: res.content && res.content.mimeType,
        error: res._error,
        // 0 means the request never got a response — the single most useful
        // thing a HAR tells you and the easiest to miss by eye
        note: !res.status ? 'no response' : undefined,
        body: res.status >= 400 ? body : undefined,
        server: en.serverIPAddress || undefined,
      }),
      har: en,
    });
  }
  return out;
}

function exportHar(events, meta = {}) {
  const entries = events
    .filter((e) => e.k === 'net')
    .map((e) => e.har || harEntry({
      t: e.t, ms: e.ms, method: e.d && e.d.method, url: e.d && e.d.url,
      status: e.d && e.d.status, statusText: e.d && e.d.statusText,
      size: e.d && e.d.size, mime: e.d && e.d.mime, error: e.d && e.d.error,
      body: e.d && e.d.body, headers: {}, resHeaders: {},
    }))
    .sort((a, b) => Date.parse(a.startedDateTime) - Date.parse(b.startedDateTime));
  return {
    log: {
      version: '1.2',
      creator: { name: 'dbg', version: meta.version || '3.0.0' },
      browser: meta.browser || undefined,
      pages: [],
      entries,
    },
  };
}

module.exports = { attachNetwork, importHar, exportHar, harEntry, safeUrl };
