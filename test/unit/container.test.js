import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir, rm, access, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { overrideProcess } from '../helpers/platform-override.js';
import { SpawnStub } from '../helpers/process-stub.js';
import { freshImport } from '../helpers/fresh-module.js';
import { withKeepAlive } from '../helpers/dispatcher-harness.js';

const CONTAINER_SRC = fileURLToPath(new URL('../../src/sandbox/container.js', import.meta.url));

// Helper handler: auto-completes the incidental probe spawns (`--version`, `image
// inspect`, `rm -f`) so only the main runner container (`--name ...`) is left for the
// test to drive. Returns the SpawnStub.
function containerStub(onContainer) {
  return new SpawnStub((child, stub) => {
    const args = child.args ?? [];
    const isContainer = args.includes('--name');
    if (isContainer) {
      onContainer?.(child, stub);
      return;
    }
    // Probe / teardown calls (podman --version, image inspect, rm -f name): succeed.
    child.emitStdout('ok\n');
    child.close(0);
  });
}

async function makeRunnerDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rz-runner-'));
  await writeFile(path.join(dir, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

async function withLinuxLaunch(fn) {
  const restoreProc = overrideProcess({ platform: 'linux' });
  const runnerDir = await makeRunnerDir();
  const prevDir = process.env.RUNNERIZE_RUNNER_DIR;
  const prevImage = process.env.RUNNERIZE_LINUX_IMAGE;
  process.env.RUNNERIZE_RUNNER_DIR = runnerDir;
  process.env.RUNNERIZE_LINUX_IMAGE = 'example/image:latest';
  try {
    const { linux } = await freshImport('../../src/sandbox/container.js');
    return await fn(linux);
  } finally {
    if (prevDir === undefined) delete process.env.RUNNERIZE_RUNNER_DIR; else process.env.RUNNERIZE_RUNNER_DIR = prevDir;
    if (prevImage === undefined) delete process.env.RUNNERIZE_LINUX_IMAGE; else process.env.RUNNERIZE_LINUX_IMAGE = prevImage;
    await rm(runnerDir, { recursive: true, force: true });
    restoreProc();
  }
}

test('linux.launch validates its inputs before spawning anything', async () => {
  const { linux } = await freshImport('../../src/sandbox/container.js');
  await assert.rejects(() => linux.launch('', { idleTimeoutMs: 1000 }), TypeError);
  await assert.rejects(() => linux.launch(42, { idleTimeoutMs: 1000 }), TypeError);
  await assert.rejects(() => linux.launch('cfg', { idleTimeoutMs: 0 }), RangeError);
  await assert.rejects(() => linux.launch('cfg', { idleTimeoutMs: -5 }), RangeError);
  await assert.rejects(() => linux.launch('cfg', { idleTimeoutMs: Infinity }), RangeError);
});

test('linux.launch resolves { startedJob: true } after a job-start line and clean exit', async () => {
  await withLinuxLaunch(async (linux) => {
    const stub = containerStub((child) => {
      child.startJob();
      child.close(0);
    }).install();
    try {
      const result = await linux.launch('deadbeef', { idleTimeoutMs: 5000 });
      assert.deepEqual(result, { startedJob: true });
      const container = stub.find('--name');
      assert.ok(container, 'the runner container was spawned');
      // JIT config is passed via env, never on argv.
      assert.equal(container.options.env.JITCFG, 'deadbeef');
      assert.ok(!container.args.includes('deadbeef'), 'the jit config never appears as an argv token');
    } finally {
      stub.restore();
    }
  });
});

test('linux.launch: onStarted fires exactly once and failure diagnostics stay silent on success', async () => {
  await withLinuxLaunch(async (linux) => {
    let started = 0;
    let diagnostics = 0;
    const stub = containerStub((child) => {
      child.startJob();
      child.emitStdout('Running job: another\n');
      child.startJob();
      child.close(0);
    }).install();
    try {
      const result = await linux.launch('cfg', {
        idleTimeoutMs: 5000,
        onStarted: () => { started += 1; },
        onFailureDiagnostics: () => { diagnostics += 1; },
      });
      assert.deepEqual(result, { startedJob: true });
      assert.equal(Object.keys(result).length, 1, 'the return contract stays exact');
      assert.equal(started, 1, 'onStarted is invoked exactly once');
      assert.equal(diagnostics, 0, 'failure diagnostics are not emitted on success');
    } finally {
      stub.restore();
    }
  });
});

test('linux.launch: idle watchdog force-settles and releases when a job never starts', async () => {
  // The container child never prints a job line and never closes (an unkillable/hung
  // process). The launch MUST still settle (never hang) via the force-settle backstop,
  // reporting startedJob:false so the caller can release its slot.
  await withLinuxLaunch(async (linux) => {
    const stub = containerStub((child) => {
      // Deliberately do nothing: no output, no close, ignore SIGTERM/SIGKILL.
    }).install();
    // Compress the 7s FORCE_SETTLE_MS backstop so this test doesn't block the suite
    // for its full duration. The behavior under test — force-settle when the child
    // hangs — is unchanged; only the backstop wait is shortened.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === 7000 ? 5 : ms, ...rest);
    try {
      const start = Date.now();
      const result = await withKeepAlive(linux.launch('cfg', { idleTimeoutMs: 30 }));
      assert.deepEqual(result, { startedJob: false }, 'settles without a started job');
      const container = stub.find('--name');
      assert.ok(container.signals.includes('SIGTERM'), 'watchdog signalled the hung child');
      assert.ok(Date.now() - start >= 30, 'waited at least the idle timeout');
    } finally {
      global.setTimeout = realSetTimeout;
      stub.restore();
    }
  });
});

test('linux.launch: idle watchdog reports bounded diagnostics and preserves its return contract', async () => {
  await withLinuxLaunch(async (linux) => {
    const stdout = `${'o'.repeat(70 * 1024)}stdout-tail`;
    const stderr = `${'e'.repeat(70 * 1024)}stderr-tail`;
    const diagnostics = [];
    const stub = containerStub((child) => {
      child.emitStdout(stdout);
      child.emitStderr(stderr);
      // No job line. When the watchdog signals us, exit like a real container would.
      const origKill = child.kill.bind(child);
      child.kill = (sig) => { const r = origKill(sig); queueMicrotask(() => child.close(143)); return r; };
    }).install();
    try {
      const result = await withKeepAlive(linux.launch('cfg', {
        idleTimeoutMs: 30,
        onFailureDiagnostics: (output) => diagnostics.push(output),
      }));
      assert.deepEqual(result, { startedJob: false });
      assert.equal(Object.keys(result).length, 1, 'diagnostics are not added to the return object');
      assert.equal(diagnostics.length, 1, 'failure diagnostics are emitted once');
      assert.ok(Buffer.byteLength(diagnostics[0].stdout) <= 64 * 1024, 'stdout is bounded');
      assert.ok(Buffer.byteLength(diagnostics[0].stderr) <= 64 * 1024, 'stderr is bounded');
      assert.match(diagnostics[0].stdout, /stdout-tail$/, 'stdout retains the most recent output');
      assert.match(diagnostics[0].stderr, /stderr-tail$/, 'stderr retains the most recent output');
      // stopContainer issued `rm -f <name>` against the runtime.
      const teardown = stub.children.find((c) => (c.args ?? []).includes('rm') && (c.args ?? []).includes('-f'));
      assert.ok(teardown, 'watchdog force-removed the container');
    } finally {
      stub.restore();
    }
  });
});

test('linux.launch: rejects with diagnostics when the container exits non-zero', async () => {
  await withLinuxLaunch(async (linux) => {
    const diagnostics = [];
    const stub = containerStub((child) => {
      child.emitStdout('runner setup started\n');
      child.emitStderr('podman: image pull failed\n');
      child.close(125);
    }).install();
    try {
      await assert.rejects(
        () => linux.launch('cfg', {
          idleTimeoutMs: 5000,
          onFailureDiagnostics: (output) => diagnostics.push(output),
        }),
        /exited with code 125/,
      );
      assert.deepEqual(diagnostics, [{
        stdout: 'runner setup started\n',
        stderr: 'podman: image pull failed\n',
      }]);
    } finally {
      stub.restore();
    }
  });
});

test('linux.available: true when a container runtime is present, false when none is', async () => {
  const restoreProc = overrideProcess({ platform: 'linux' });
  try {
    const { linux } = await freshImport('../../src/sandbox/container.js');

    const present = new SpawnStub((child) => {
      if ((child.args ?? []).includes('--version')) { child.emitStdout('podman 5\n'); child.close(0); }
      else child.close(1);
    }).install();
    try {
      assert.equal(await linux.available(), true);
    } finally {
      present.restore();
    }

    const absent = new SpawnStub((child) => { child.fail(new Error('ENOENT')); }).install();
    try {
      assert.equal(await linux.available(), false);
    } finally {
      absent.restore();
    }
  } finally {
    restoreProc();
  }
});

// ---------------------------------------------------------------------------
// Embedded shell scripts: extract the real snippets from container.js source and
// assert their safety invariants. The behavioral race is gated on a POSIX bash
// with `mv -T`, so it skips cleanly where that is unavailable.
// ---------------------------------------------------------------------------

async function readContainerSource() {
  return readFile(CONTAINER_SRC, 'utf8');
}

// Extract the staging script (the template literal passed to wslShell that contains
// `mv -T`). Kept resilient: we locate the block by its distinctive marker.
function extractStagingScript(source) {
  const match = source.match(/wslShell\(distro,\s*`([\s\S]*?mv -T[\s\S]*?)`/);
  if (!match) throw new Error('could not locate the staging script in container.js');
  return match[1];
}

function extractInnerScript(source) {
  const match = source.match(/const INNER_SCRIPT = `([\s\S]*?)`;/);
  if (!match) throw new Error('could not locate INNER_SCRIPT in container.js');
  return match[1];
}

test('staging script invariant: uses `mv -T` and never rm -rf the destination', async () => {
  const source = await readContainerSource();
  const script = extractStagingScript(source);
  assert.match(script, /mv -T "\$temporary" "\$destination"/, 'atomic move into place');
  assert.doesNotMatch(script, /rm -rf[^\n]*\$destination/, 'the destination is never rm -rf-ed');
  // The only recursive delete targets the throwaway temp dir.
  const rmLines = script.split('\n').filter((l) => /rm -rf/.test(l));
  for (const line of rmLines) {
    assert.match(line, /\$temporary/, `rm -rf only targets $temporary, got: ${line.trim()}`);
  }
});

test('INNER_SCRIPT invariant: operates on a throwaway workdir, never the read-only /rsrc mount', async () => {
  const source = await readContainerSource();
  const inner = extractInnerScript(source);
  assert.match(inner, /workdir="\$\(mktemp -d\)"/, 'a fresh workdir per run');
  assert.match(inner, /trap 'rm -rf "\$workdir"' EXIT/, 'workdir is cleaned on exit');
  assert.doesNotMatch(inner, /rm -rf[^\n]*\/rsrc/, 'never deletes the mounted runner source');
  assert.match(inner, /run\.sh --jitconfig "\$JITCFG"/, 'launches run.sh with the jit config from env');
});

test('WSL forwards the max lifetime and the inner script has a defensive default', async () => {
  const source = await readContainerSource();
  assert.match(source, /WSLENV: `\$\{existing\}JITCFG:MAX_LIFETIME_SECONDS`/);
  assert.match(extractInnerScript(source), /MAX_LIFETIME_SECONDS:-21600/);
});

test('mounted INNER_SCRIPT is readable by a non-owner container user', async () => {
  const source = await readContainerSource();
  assert.match(source, /chmod 644 "\$script"/, 'WSL script is world-readable');
  assert.match(source, /writeFile\(mountedScript, INNER_SCRIPT, \{ mode: 0o644 \}\)/,
    'native script is created world-readable');
  assert.match(source, /chmod\(mountedScript, 0o644\)/,
    'native script mode is not weakened by the host umask');
});

async function bashSupportsMvT() {
  // Requires POSIX bash, `mv -T`, and a filesystem that preserves the executable bit
  // (the staging script guards on `[[ -x run.sh ]]`). Git-bash on NTFS drops the bit,
  // so this correctly skips there and runs for real on Linux/WSL/macOS.
  try {
    await new Promise((resolve, reject) => {
      const probe = 'set -e; d=$(mktemp -d); mkdir "$d/a"; printf x > "$d/a/f"; chmod +x "$d/a/f";'
        + ' mv -T "$d/a" "$d/b"; test -f "$d/b/f"; test -x "$d/b/f"; rm -rf "$d"';
      const child = spawn('bash', ['-c', probe], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    });
    return true;
  } catch {
    return false;
  }
}

test('staging script is race-safe under concurrency (real bash + mv -T)', async (t) => {
  if (!(await bashSupportsMvT())) {
    t.skip('POSIX bash with `mv -T` and exec-bit preservation is unavailable on this host');
    return;
  }

  const source = await readContainerSource();
  const script = extractStagingScript(source);

  // Build a fake runner source tree with a Runner.Listener that reports a version and a
  // sentinel run.sh whose contents we can verify survived the race intact.
  const root = await mkdtemp(path.join(os.tmpdir(), 'rz-stage-'));
  const home = path.join(root, 'home');
  const sourceDir = path.join(root, 'src');
  await mkdir(path.join(sourceDir, 'bin'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(sourceDir, 'bin', 'Runner.Listener'), '#!/bin/sh\necho 2.999.0\n', { mode: 0o755 });
  const sentinel = 'SENTINEL-RUN-SH-CONTENTS\n';
  await writeFile(path.join(sourceDir, 'run.sh'), sentinel, { mode: 0o755 });
  await chmod(path.join(sourceDir, 'bin', 'Runner.Listener'), 0o755);

  const runOnce = () => new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script, 'runnerize', sourceDir], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`stage exited ${code}: ${err}`))));
  });

  try {
    // Fire many concurrent stagers into the same destination.
    const results = await Promise.all(Array.from({ length: 8 }, runOnce));
    const destination = results[0].trim();
    assert.ok(destination.endsWith(path.join('runners', '2.999.0')), `destination is version-pinned: ${destination}`);
    for (const r of results) {
      assert.equal(r.trim(), destination, 'every racer reports the same destination');
    }
    // The destination survived intact — winner's copy is complete and uncorrupted.
    await access(path.join(destination, 'run.sh'), constants.X_OK);
    const finalRunSh = await readFile(path.join(destination, 'run.sh'), 'utf8');
    assert.equal(finalRunSh, sentinel, 'run.sh contents are intact (no torn write)');

    // No leftover temp dirs: the losers cleaned up after themselves.
    const runnersDir = path.dirname(destination);
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(runnersDir)).filter((n) => n.startsWith('.runner.'));
    assert.deepEqual(leftovers, [], 'no leaked .runner.* temp dirs remain');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
