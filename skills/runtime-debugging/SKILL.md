---
name: runtime-debugging
description: Record and interrogate what a program actually did at runtime — variable values, execution order, cross-process request traces, network traffic. Use when logs and stack traces are not enough: async/race bugs, intermittent failures, "works locally but not here", a request that fails somewhere across services, a browser page whose console you cannot see, a server already running that you must not restart, or any bug where you need real values rather than a guess about them.
version: 3.0.0
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Runtime debugging

`dbg` is a flight recorder. You **record** an execution, then **query** the recording
as many times as you like without re-running anything.

The CLI lives at `bin/dbg.js` in this skill's directory. Either add it to PATH or
call it directly:

```bash
DBG="node ${CLAUDE_PLUGIN_ROOT}/bin/dbg.js"
$DBG help
```

## The one rule

**Never `cat` the event log.** Every command is bounded and answers a question.
Dumping a recording into your context is how you lose the ability to reason about it.

Always start with `dbg stats`. It tells you what happened — errors, label counts,
the largest stalls, network failures, how many traces exist — in under 40 lines
regardless of whether the run captured 12 events or 500,000.

Then narrow: `dbg where '<js predicate>'` → `dbg around <#>` → `dbg show <#>`.

## Pick a capture mode

| Situation | Command |
|---|---|
| A script or test you can re-run | `dbg run --lp 'src/a.js:42 x, y' -- node a.js` |
| A **server already running** (do not restart it) | `dbg attach --pid <pid>` |
| A long-running server you are starting | `dbg run --bg --agent -- node server.js` |
| A request crossing several processes | `dbg run --bg --agent …` then `dbg exec -- <client cmd>` |
| A browser page | `dbg attach --chrome --net` (Chrome needs `--remote-debugging-port=9222`) |
| Network only, already captured elsewhere | `dbg import session.har` |
| Python / Go / shell / anything else | `dbg sink` then `dbg snippet python` |
| Intermittent, fails maybe 1 run in 10 | `dbg repeat -n 20 --until-fail -- node test.js` |

`dbg run` starts the target paused, so probes are installed before any code runs.
That matters for short programs — without it they finish before you can attach.

## Probes: no source edits

A logpoint is a breakpoint whose condition has a side effect and always evaluates
false, so **execution never pauses**. Nothing is written to the program's stdout,
and nothing is written to your source files.

```bash
dbg lp add 'src/order.js:42 orderId, qty, cart.total'   # capture expressions
dbg lp add 'src/order.js:42' --snapshot                 # capture the ENTIRE scope
dbg lp add 'src/order.js:42' --when 'qty > 100'         # only when true
dbg lp add 'src/order.js:42' --max 20                   # stop after 20 hits
dbg lp ls          # hit counts, and whether each probe actually bound
dbg eval '<expr>'  # evaluate inside the live process right now
```

Use `--snapshot` when you do **not know what the variables are called** — it grabs
every local and closure variable at that line. It briefly pauses the process, so
pair it with `--max` and don't use it when chasing a timing bug.

Use `--when`/`--max` inside hot loops. A probe in a 100k-iteration loop with
`--when 'i % 10000 === 0' --max 5` costs almost nothing.

## Reading a recording

```bash
dbg stats                      # ALWAYS START HERE
dbg tail -n 20                 # most recent events
dbg where 'd.qty > 100'        # filter: d=data, n=label, p=producer, c=trace id, ms=duration
dbg timeline --corr <id>       # one request across every process, in order
dbg around 42                  # what happened either side of event 42
dbg show 42                    # full untruncated detail of one event
dbg slow                       # spans ranked by duration
dbg net [--all]                # requests, failures first, with response bodies
dbg diff <runA> <runB>         # first point where two runs diverged
```

## Workflows that work

**A value is wrong and you don't know why.**
Probe the function that produces it, run, then `dbg where` on the wrong value and
`dbg around` it to see what led there.

**Intermittent / flaky.**
`dbg repeat -n 20 --until-fail --lp 'file.js:N var' -- <cmd>`. It runs until a
failure, then automatically diffs a passing run against the failing one and shows
the first diverging value. This finds flakes without you guessing what to log.

**"It worked before."**
Record the good case and the bad case, then `dbg diff <good> <bad>`. Values that
legitimately change between runs (timestamps, ids, ports) are normalised away.

**A request fails somewhere across services.**
Start each service with the agent (`--agent`, or `dbg exec`), reproduce, then
`dbg stats` to list traces and `dbg timeline --corr <id>` to see every hop in
execution order. A correlation id is minted at the first call and propagated
via the `x-dbg-corr` header.

**A front-end shows a generic error.**
`dbg attach --chrome --net`, reproduce, `dbg net`. Response bodies of failing
requests are captured — that is usually where the real message is.

## When a probe doesn't fire

`dbg lp ls` shows `hits=0`. In order of likelihood:

1. **It never bound** — the line isn't in a loaded script. Run `dbg scripts` to see
   the URLs the runtime actually has, then re-add with `--url '<regex>'`. Bundled,
   transpiled, and inline-in-HTML scripts almost never match their filename.
2. **Wrong line granularity** — a breakpoint on `for (const x of xs) { f(x); }` binds
   to the loop *initializer*, where `x` doesn't exist yet. Target the body, or give a
   column: `dbg lp add 'file.js:6:28 x'`.
3. **The code genuinely never ran.** That is itself the finding.

If a captured value shows `{__t: "oos"}`, that name wasn't in scope at that point
(often a `const` on the very line you probed — probe the line *after* it).

## Cleanup

`dbg stop` removes every probe and detaches. Probes are runtime-only, so there is
nothing to leave behind in source.

The exception is `dbg probe add`, the fallback for runtimes with no inspector.
It edits files, marking every inserted line — including the recorder it adds
when the file has none, so the program runs without a separate setup step.
Always finish with:

```bash
dbg probe strip && dbg probe verify   # verify exits non-zero if anything remains
```

`dbg clean` removes all recordings and warns if any source probes survive.

## The recorder does not change your program

Exit codes, crashes, graceful shutdowns and the application's own
`unhandledRejection`/`SIGTERM` handlers behave identically with and without `dbg`
attached. This is asserted by tests, because the opposite — an observer that
suppresses the failure it was attached to find — is both easy to write and
invisible in practice.

## Cost

Attaching enables the V8 debugger, which disables some optimisations — expect a
modest slowdown on hot code. Recording is cheap (roughly an array push per hit).
`--snapshot` is the only mode that actually pauses the process.
