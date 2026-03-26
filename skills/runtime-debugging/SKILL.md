---
name: runtime-debugging
description: This skill should be used when the user asks to "debug a runtime issue", "trace an async bug", "inspect state changes", "track a race condition", or otherwise needs runtime instrumentation because logs or stack traces are not enough.
version: 2.0.0
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

Run the bundled server script:

Start it:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/debug-server.js" 3333 &
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
pkill -f "debug-server.js"
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
