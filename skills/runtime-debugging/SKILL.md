---
name: runtime-debugging
description: Debug runtime issues by capturing data from instrumented fetch calls. Use when debugging async issues, state problems, race conditions, or when console.log isn't sufficient.
allowed-tools: Bash, Read, Write, Edit, Grep
---

# Runtime Debugging Skill

This skill enables runtime debugging by capturing data from instrumented fetch calls. Use it when you need to understand what's happening at runtime - variable values, execution flow, timing, or state changes.

## When to Use This Skill

- Debugging async/await issues or race conditions
- Tracing state changes across function calls
- Capturing variable values at specific execution points
- Understanding control flow through complex code paths
- Debugging issues that only reproduce at runtime

## Debugging Workflow

### Step 1: Start the Debug Server

Run the debug server in background:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/debug-server.js 3333 &
```

Verify it's running:

```bash
curl http://localhost:3333/health
```

### Step 2: Instrument the Code

Insert fetch calls at strategic locations. The fetch call pattern:

```javascript
fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "descriptive-label", data: { key: value } }) }).catch(() => {});
```

#### Placement Guidelines

**Function entry/exit:**
```javascript
async function processOrder(orderId, items) {
  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "processOrder-entry", data: { orderId, items } }) }).catch(() => {});

  // ... function body ...

  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "processOrder-exit", data: { result } }) }).catch(() => {});
  return result;
}
```

**Before/after async operations:**
```javascript
fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "api-call-start", data: { endpoint, payload } }) }).catch(() => {});

const response = await apiClient.post(endpoint, payload);

fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "api-call-complete", data: { status: response.status, data: response.data } }) }).catch(() => {});
```

**Error handling:**
```javascript
try {
  // code
} catch (error) {
  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "error-caught", data: { message: error.message, stack: error.stack } }) }).catch(() => {});
  throw error;
}
```

**State changes:**
```javascript
fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "state-before", data: { state } }) }).catch(() => {});

setState(newState);

fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "state-after", data: { newState } }) }).catch(() => {});
```

**Conditional branches:**
```javascript
if (condition) {
  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "branch-taken-if", data: { condition } }) }).catch(() => {});
  // ...
} else {
  fetch("http://localhost:3333/debug", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: "branch-taken-else", data: { condition } }) }).catch(() => {});
  // ...
}
```

### Step 3: Ask User to Reproduce

After instrumenting the code, tell the user:

> "I've added debug instrumentation. Please reproduce the issue now, then let me know when you're done so I can analyze the captured data."

### Step 4: Read and Analyze Logs

Read the captured logs:

```bash
cat .claude-debug/debug.log
```

For large logs, tail the last N lines:

```bash
tail -n 50 .claude-debug/debug.log
```

**What to look for:**
- Timestamps showing execution order
- Unexpected values in captured data
- Missing log entries (code paths not taken)
- Errors and exceptions
- State inconsistencies between entries

### Step 5: Cleanup

When debugging is complete:

1. Stop the server:
```bash
pkill -f "debug-server.js"
```

2. Remove the fetch instrumentation from the code (use Edit tool)

3. Optionally clear the log:
```bash
rm .claude-debug/debug.log
```

## Label Naming Conventions

Use descriptive, hierarchical labels:

| Pattern | Example | Use For |
|---------|---------|---------|
| `function-entry` | `processOrder-entry` | Function start |
| `function-exit` | `processOrder-exit` | Function end |
| `module-action` | `auth-validate` | Module operations |
| `async-start/complete` | `api-call-start` | Async boundaries |
| `error-location` | `error-processOrder` | Error capture |
| `state-change` | `user-state-updated` | State mutations |
| `branch-name` | `branch-early-return` | Control flow |

## Troubleshooting

**No logs appearing:**
- Verify server is running: `curl http://localhost:3333/health`
- Check fetch calls have correct URL
- Ensure `.catch(() => {})` doesn't hide errors
- Verify the code path is actually executed

**Server won't start (port in use):**
- Use a different port: `node debug-server.js 4444`
- Kill existing process: `pkill -f "debug-server.js"`

**Too many log entries:**
- Use more specific labels
- Only instrument the suspicious code path
- Clear logs before reproducing: `> .claude-debug/debug.log`
