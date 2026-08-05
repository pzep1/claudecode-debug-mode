# dbg — a flight recorder for debugging

Runtime debugging for Claude Code and for humans. Record what a program actually
did, then interrogate the recording — instead of adding `console.log`, re-running,
and reading a wall of output.

Zero dependencies. One file to run: `bin/dbg.js` (Node ≥ 22).

```bash
# capture a race condition without touching a single line of source
dbg run --lp 'bank.js:8 who, cur, amt' -- node bank.js
dbg timeline
```
```
    #         t src       label        data
    1    +0.0ms node:812  bank.js:8    {who="A" amt=60}
    2    +0.2ms node:812  bank.js:8    {who="B" amt=60}
    3    +6.2ms node:812  bank.js:10   {who="A" cur=100 amt=60}
    4    +8.6ms node:812  bank.js:10   {who="B" cur=100 amt=60}   <-- both read 100
```

## Why not just add log statements

| | `console.log` | `dbg` |
|---|---|---|
| Requires editing source | yes | no |
| Can leave debug code behind | yes | nothing to leave behind |
| Works on an already-running process | no | `dbg attach --pid` |
| Preserves true execution order | mostly | yes, sequenced at capture time |
| Survives a process that exits immediately | often not | yes |
| Follows a request across processes | no | yes, correlation ids |
| Output size | grows without bound | bounded by design |
| Comparing two runs | by eye | `dbg diff` |
| Changes the program's behaviour | no | no — and it is tested |

## Install

```bash
# as a Claude Code plugin
claude plugin marketplace add pzep1/claudecode-debug-mode
claude plugin install claude-debug-plugin@pzep1-claudecode-debug-mode

# or as a skill
npx skills add pzep1/claudecode-debug-mode

# or just use it directly
git clone https://github.com/pzep1/claudecode-debug-mode
ln -s "$PWD/claudecode-debug-mode/bin/dbg.js" /usr/local/bin/dbg
```

## Capture

```bash
dbg run --lp 'src/a.js:42 x, y' -- node a.js   # run a program under the recorder
dbg run --bg --agent -- node server.js         # a server, with HTTP tracing
dbg attach --pid 4821                          # an ALREADY RUNNING node process
dbg attach --chrome --net                      # a Chrome page, with network capture
dbg exec -- node client.js                     # another process, same recording
dbg sink                                       # listen for python/shell/browser
dbg stop                                       # detach, remove every probe
```

`dbg attach --pid` works on a process that was **not** started with `--inspect` —
your dev server does not have to be restarted.

## Probe

Logpoints are breakpoints whose condition has a side effect and always evaluates
false, so the program never pauses and its stdout stays clean.

```bash
dbg lp add 'src/order.js:42 orderId, qty'      # capture named expressions
dbg lp add 'src/order.js:42' --snapshot        # capture the whole local+closure scope
dbg lp add 'src/order.js:42' --when 'qty > 100' --max 20
dbg lp ls                                      # hits, and whether each probe bound
dbg scripts                                    # what the runtime actually loaded
dbg eval '<expr>'                              # evaluate in the live process
```

## Read

Everything is bounded. `dbg stats` stays under 40 lines whether the run captured
12 events or 500,000.

```bash
dbg stats                  # errors, label counts, stalls, network failures, traces
dbg tail -n 20             # latest events
dbg where 'd.qty > 100'    # JS predicate over event data
dbg timeline --corr <id>   # one request across every process, in order
dbg around 42 / dbg show 42
dbg slow                   # spans by duration
dbg net --all              # requests; failures first, with response bodies
dbg diff <runA> <runB>     # first divergence between two runs
```

## Flaky bugs

```bash
dbg repeat -n 20 --until-fail --lp 'flaky.js:5 jitter' -- node flaky.js
```

Runs until it fails, then diffs a passing run against the failing one:

```
  context (A):   1  +0.0ms  flaky.js:5  {jitter=7.535}    exit=0
  context (B):   1  +0.0ms  flaky.js:5  {jitter=17.563}   exit=1
```

## Network and HAR

```bash
dbg attach --chrome --net       # live capture from Chrome
dbg import session.har          # merge a DevTools / Charles / mitmproxy HAR
dbg export har -o out.har       # write captured traffic back out
dbg net
```

Imported and live traffic land on the **same timeline** as your logpoints, so
"the request never went out" and "the handler never ran" stop looking identical.

## Other languages

`dbg sink`, then paste a producer:

```bash
dbg snippet python   # also: browser, shell, node
```

```python
dbg("row", i=i, raw=r, kind=type(r).__name__)
```

Non-blocking, ordered, with uncaught exceptions captured automatically.

## Source probes (fallback)

For runtimes with no inspector. Every inserted line is marked, so removal is
mechanical and verifiable — the failure mode of hand-written debug statements is
that they ship.

```bash
dbg sink                               # so the inserted recorder has somewhere to send
dbg probe add 'app.py:42 total'        # inserts the probe AND a recorder if the file lacks one
python3 app.py                         # run normally; events land in the recording
dbg probe strip && dbg probe verify    # verify exits non-zero if anything remains
```

## Security

The collector binds `127.0.0.1` only and requires a per-session token. Browser
producers get CORS on the ingest path only, still token-gated. Recordings live in
`.claude-debug/`, which is self-ignoring.

## The recorder does not change your program

Attaching a listener to `uncaughtException`, `unhandledRejection` or `SIGTERM`
*suppresses Node's default handling* — an observer that does so naively turns a
program that exits 1 into one that sails past the error, masking the very bug it
was attached to find. The preload agent observes via `uncaughtExceptionMonitor`
and reinstates the default behaviour it displaces, deferring to the application's
own handlers when it has them. Five tests assert that exit codes, graceful
shutdowns and app-owned handlers are byte-identical with and without the agent.

## Tests

```bash
node test/run.js
```

43 tests, no framework, no network. End-to-end cases drive the real CLI against
real buggy programs — a race condition, a crash, a hot loop, a flaky test, HAR
import/export, and probe cleanup.

## Layout

```
bin/dbg.js              CLI
lib/
  cdp.js                Chrome DevTools Protocol client (WebSocket, no deps)
  bootstrap.js          the recorder injected into the target process
  live.js               logpoints, snapshots, drain
  daemon.js             long-lived session: holds the attachment, owns the store
  store.js  query.js    event store and the bounded query engine
  har.js                network capture, HAR import/export
  diff.js  probe.js     run comparison; source-probe insert/strip
agents/node-preload.js  cross-process correlation, HTTP spans, crash capture
skills/runtime-debugging/SKILL.md
```

## Upgrading from 2.x

The old flow (start `scripts/debug-server.js`, hand-insert `fetch()` calls, delete
them afterwards) is replaced by `dbg run` / `dbg attach` with logpoints, which
require no source edits at all. `scripts/debug-server.js` still works but is
deprecated; `dbg sink` supersedes it.

## License

MIT
