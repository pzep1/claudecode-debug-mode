#!/usr/bin/env node
/**
 * Debug Server - Captures runtime data from instrumented fetch calls
 *
 * Usage:
 *   node debug-server.js [port]
 *   node debug-server.js 3333
 *
 * The server listens for POST requests to /debug with JSON body:
 *   { "label": "descriptive-label", "data": { ... } }
 *
 * Logs are written to .claude-debug/debug.log
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2]) || 3333;
const LOG_DIR = '.claude-debug';
const LOG_FILE = path.join(LOG_DIR, 'debug.log');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendLog(label, data) {
  const timestamp = new Date().toISOString();
  const line = data !== undefined
    ? `[${timestamp}] ${label} | ${JSON.stringify(data)}\n`
    : `[${timestamp}] ${label}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

const server = http.createServer((req, res) => {
  // CORS headers for browser fetch calls
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', port: PORT }));
    return;
  }

  // Debug endpoint
  if (req.url === '/debug' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const json = JSON.parse(body);
        if (!json.label) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: label' }));
          return;
        }
        appendLog(json.label, json.data);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // 404 for everything else
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Debug server running on http://localhost:${PORT}`);
  console.log(`Log file: ${LOG_FILE}`);
  console.log('');
  console.log('Fetch template:');
  console.log(`fetch("http://localhost:${PORT}/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "your-label", data: { key: value } }) }).catch(() => {});`);
  console.log('');
  console.log('Press Ctrl+C to stop');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down debug server...');
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
