# Claude Debug Plugin

Runtime debugging for Claude Code via instrumented fetch calls.

## Installation

```bash
/plugin marketplace add pzep1/claudecode-debug-mode
/plugin install claude-debug-plugin@pzep1-claudecode-debug-mode
```

## Usage

Claude automatically uses this skill when you ask to debug runtime issues:

- "Can you help me debug why this async function times out?"
- "The state isn't updating correctly, can you trace through the execution?"
- "There's a race condition somewhere in the order processing"

## How It Works

1. **Start Debug Mode** - Claude writes a temp server to `.claude-debug/server.js`
2. **Instrument Code** - Claude inserts `fetch()` calls at strategic locations
3. **Reproduce the Issue** - You run your code and reproduce the bug
4. **Analyze Logs** - Claude reads `.claude-debug/debug.log` to identify the problem
5. **Clean Up** - Claude removes instrumentation and deletes `.claude-debug/`

## Instrumentation

Claude inserts fetch calls like this:

```javascript
fetch("http://localhost:3333/debug", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "function-entry", data: { arg1, arg2 } }),
}).catch(() => {});
```

## License

MIT
