const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number.parseInt(process.argv[2] || '3333', 10);
const logDir = '.claude-debug';
const logFile = path.join(logDir, 'debug.log');

if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (req.url === '/debug' && req.method === 'POST') {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const { label, data } = JSON.parse(body);
        const line = `[${new Date().toISOString()}] ${label}${data ? ` | ${JSON.stringify(data)}` : ''}\n`;
        fs.appendFileSync(logFile, line);
        res.writeHead(200);
        res.end('ok');
      } catch {
        res.writeHead(400);
        res.end('bad json');
      }
    });

    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, () => {
  console.log(`Debug server on :${port}`);
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
