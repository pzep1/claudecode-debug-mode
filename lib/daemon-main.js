'use strict';
// Entry point for the detached recorder process. Config arrives as one
// base64-encoded JSON blob so nothing has to be quoted through the shell.
const { startDaemon } = require('./daemon');
const store = require('./store');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CDP } = require('./cdp');

function writeExclusive(file, data) {
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // pre-existing path (possibly a planted symlink): remove and retry once
    try { fs.unlinkSync(file); } catch {}
    fd = fs.openSync(file, 'wx', 0o600);
  }
  try { fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}

async function main() {
  const cfg = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
  process.chdir(cfg.cwd);

  let child = null;
  let d;
  let exited = null;        // set if the target dies before we finish wiring up
  let spawnFailed = null;   // set if the target could not be started at all

  // The run directory has to exist before the child starts so its stdout/stderr
  // can be captured alongside the event stream instead of vanishing.
  const run = store.createRun(cfg.cwd, {
    label: cfg.label, cmd: cfg.cmd, mode: cfg.mode, target: cfg.target, inspectPort: cfg.port,
  });
  cfg.run = run;
  const logFile = path.join(run.dir, 'output.log');

  if (cfg.spawn) {
    // start the target first so the inspector port exists, then attach
    const env = { ...process.env, ...(cfg.env || {}) };
    const fd = fs.openSync(logFile, 'a');
    child = spawn(cfg.spawn.cmd, cfg.spawn.args, {
      cwd: cfg.cwd,
      env,
      stdio: ['ignore', fd, fd],
      detached: false,
    });
    cfg.childPid = child.pid;
    let earlyExit = null;
    child.on('error', (e) => {
      // spawn failures ('error') never emit 'exit', so record the outcome here
      // or the recorder waits forever for a process that never existed
      spawnFailed = `could not start "${cfg.spawn.cmd}": ${e.message}`;
      exited = { code: 127, signal: null };
      earlyExit = spawnFailed;
    });
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      if (earlyExit === null) earlyExit = `target exited (code ${code}) before the debugger could attach`;
    });

    if (cfg.port) {
      try {
        // race the inspector coming up against the child dying on us
        await Promise.race([
          CDP.waitForPort(cfg.port, 10000),
          (async () => {
            while (earlyExit === null) await new Promise((r) => setTimeout(r, 50));
            throw new Error(earlyExit);
          })(),
        ]);
      } catch (e) {
        // target may not be a node process with an inspector; continue as a
        // sink-only session rather than failing the whole recording
        cfg.port = null;
        cfg.attachError = e.message;
      }
    }
  }

  d = await startDaemon(cfg);

  if (cfg.childPid) store.writeMeta(cfg.cwd, d.run.id, { childPid: cfg.childPid });
  if (cfg.attachError) d.emit({ n: '__attach_failed', k: 'meta', d: { why: cfg.attachError } });

  // preinstall logpoints requested at launch, then release --inspect-brk
  if (cfg.logpoints && cfg.logpoints.length && d.live) {
    for (const lp of cfg.logpoints) {
      try { await d.live.add(lp); }
      catch (e) { d.emit({ n: '__lp_failed', k: 'err', d: { lp, why: e.message } }); }
    }
  }
  if (d.live && cfg.brk) {
    try { await d.live.cdp.send('Runtime.runIfWaitingForDebugger'); } catch {}
  }

  if (spawnFailed) {
    // Clear the session synchronously, before the CLI is told anything: an
    // async shutdown would race the next command into "a recorder is already
    // running" for a process that never started.
    store.clearSession(cfg.cwd);
  }
  if (cfg.readyFile) {
    // Carries the same token as session.json, in a world-writable tmpdir.
    // 'wx' refuses to follow a pre-planted symlink and fails if the path
    // already exists, so another user cannot redirect the token.
    writeExclusive(cfg.readyFile, JSON.stringify({
      ok: !spawnFailed, error: spawnFailed || undefined,
      run: d.run.id, controlPort: d.controlPort, token: d.token, childPid: cfg.childPid || null,
      attachError: spawnFailed ? null : (cfg.attachError || null),
    }));
  }
  if (spawnFailed) {
    // nothing to record and nothing to wait for: do not leave a session behind
    d.emit({ n: '__spawn_failed', k: 'err', d: { why: spawnFailed } });
    return void setTimeout(() => d.shutdown(1), 50);
  }

  if (child) {
    const onExit = (code, signal) => {
      store.writeMeta(cfg.cwd, d.run.id, { exitCode: code, signal });
      if (cfg.exitWithChild !== false) setTimeout(() => d.shutdown(0), 400); // let the final drain land
    };
    // the target may already be gone (fast script, or it failed to start)
    if (exited) onExit(exited.code, exited.signal);
    else child.on('exit', onExit);
    process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} });
    process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch {} });
  }
}

main().catch((e) => {
  try {
    const cfg = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
    if (cfg.readyFile) fs.writeFileSync(cfg.readyFile, JSON.stringify({ ok: false, error: e.message }));
  } catch {}
  process.stderr.write(`dbg daemon failed: ${e.stack || e.message}\n`);
  process.exit(1);
});
