---
name: runtime-debugging
description: Debug runtime issues by capturing data from instrumented fetch calls. Use when debugging async issues, state problems, race conditions, or when console.log isn't sufficient.
allowed-tools: Bash, Read, Write, Edit, Grep
---

# Runtime Debugging Skill

Capture runtime data from instrumented fetch calls. Use when you need to understand what's happening at runtime - variable values, execution flow, timing, or state changes.

## When to Use

- Debugging async/await issues or race conditions
- Tracing state changes across function calls
- Capturing variable values at specific execution points
- Understanding control flow through complex code paths

## Workflow

### Step 1: Create Debug Server

Write the server to `.claude-debug/server.js`:

```javascript
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.argv[2]) || 3333;
const LOG_DIR = '.claude-debug';
const LOG_FILE = path.join(LOG_DIR, 'debug.log');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }

  if (req.url === '/debug' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { label, data } = JSON.parse(body);
        const line = `[${new Date().toISOString()}] ${label}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
        fs.appendFileSync(LOG_FILE, line);
        res.writeHead(200); res.end('ok');
      } catch (e) { res.writeHead(400); res.end('bad json'); }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`Debug server on :${PORT}`));
process.on('SIGINT', () => { server.close(); process.exit(0); });
```

Start it:
```bash
node .claude-debug/server.js 3333 &
```

Verify:
```bash
curl http://localhost:3333/health
```

### Step 2: Instrument Code

Insert fetch calls at strategic locations:

```javascript
fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "your-label", data: { key: value } }) }).catch(() => {});
```

**Placement examples:**

Function entry/exit:
```javascript
async function processOrder(orderId) {
  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "processOrder-entry", data: { orderId } }) }).catch(() => {});
  // ...
  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "processOrder-exit", data: { result } }) }).catch(() => {});
  return result;
}
```

Error handling:
```javascript
catch (error) {
  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "error", data: { message: error.message, stack: error.stack } }) }).catch(() => {});
  throw error;
}
```

### Step 3: Ask User to Reproduce

Tell the user:
> "I've added debug instrumentation. Please reproduce the issue now, then let me know when done."

### Step 4: Analyze Logs

```bash
cat .claude-debug/debug.log
```

Look for:
- Timestamps showing execution order
- Unexpected values
- Missing entries (code paths not taken)
- State inconsistencies

### Step 5: Cleanup

```bash
pkill -f ".claude-debug/server.js"
rm -rf .claude-debug/
```

Remove the fetch instrumentation from the code.

## Label Conventions

| Pattern | Example | Use For |
|---------|---------|---------|
| `fn-entry` | `processOrder-entry` | Function start |
| `fn-exit` | `processOrder-exit` | Function end |
| `error` | `error-auth` | Caught errors |
| `state` | `state-before` | State changes |
| `branch` | `branch-early-return` | Control flow |
