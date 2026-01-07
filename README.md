# Claude Debug Plugin

A debugging plugin for [Claude Code](https://claude.ai/claude-code) that enables runtime debugging by capturing data from instrumented code. Similar to Cursor's debug mode, this plugin teaches Claude to insert fetch calls into your codebase, capture runtime data, and analyze it to identify issues.

## Installation

Add the GitHub repository as a marketplace, then install:

```bash
/plugin marketplace add pzep1/claudecode-debug-mode
/plugin install claude-debug-plugin@pzep1-claudecode-debug-mode
```

## How It Works

The debug plugin enables a powerful debugging workflow:

1. **Start Debug Mode** - Claude starts a local HTTP server to receive debug events
2. **Instrument Code** - Claude inserts `fetch()` calls at strategic locations in your codebase
3. **Reproduce the Issue** - You run your code and reproduce the bug
4. **Analyze Logs** - Claude reads the captured data to identify the problem
5. **Clean Up** - Claude removes the debug fetch calls and stops the server

## Features

- **Runtime Data Capture** - Capture function inputs, outputs, state changes, and errors
- **Local Debug Server** - Simple Node.js HTTP server to receive debug events
- **Persistent Logging** - All debug events are written to `.claude-debug/debug.log`
- **Skill-Based Workflow** - Claude automatically knows how to instrument code and analyze results
- **Zero Dependencies** - Pure Node.js stdlib, no build step required

## Usage

### Slash Command

Run the debug command:

```
/debug the checkout function is returning the wrong total
```

### Automatic Skill Invocation

Claude automatically uses the runtime-debugging skill when you ask to debug runtime issues:

- "Can you help me debug why this async function times out?"
- "The state isn't updating correctly, can you trace through the execution?"
- "There's a race condition somewhere in the order processing"

### Manual Workflow

You can also guide Claude through the steps:

1. **Start the server:**
   ```bash
   node scripts/debug-server.js 3333 &
   ```

2. **Ask Claude to instrument the code** with fetch calls

3. **Reproduce the issue** in your application

4. **Read the logs:**
   ```bash
   cat .claude-debug/debug.log
   ```

5. **Stop the server:**
   ```bash
   pkill -f "debug-server.js"
   ```

## Instrumentation

Claude inserts fetch calls like this at key locations:

```javascript
fetch("http://localhost:3333/debug", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "function-entry", data: { arg1, arg2 } }),
}).catch(() => {});
```

Common instrumentation points:

- Function entry/exit points
- Before/after async operations
- Inside catch blocks for errors
- State changes and variable mutations
- Conditional branches to trace control flow

## Example Workflow

**You:** "The checkout function is returning the wrong total"

**Claude:**

1. Starts the debug server
2. Reads the checkout code
3. Inserts fetch calls to capture cart items, prices, discounts, and the final total
4. Says "I've instrumented the checkout function. Please try checking out now."

**You:** Reproduce the checkout bug

**Claude:**

1. Reads `.claude-debug/debug.log`
2. Sees: `cart-items: [...]`, `discount-applied: 0.15`, `subtotal: 100`, `final-total: 80`
3. Identifies: "The discount is being applied twice. The subtotal shows 100 but the final total is 80 instead of 85."
4. Fixes the bug and stops the debug server
5. Removes the debug fetch calls

## Plugin Structure

```
claude-debug-plugin/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── skills/
│   └── runtime-debugging/
│       └── SKILL.md          # Debug workflow skill
├── scripts/
│   └── debug-server.js       # HTTP server for capturing data
├── commands/
│   └── debug.md              # /debug slash command
└── README.md
```

## Requirements

- Node.js 18+
- Claude Code CLI

## License

MIT
