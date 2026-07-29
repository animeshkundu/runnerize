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
import { RUNNERIZE_VERSION_LABEL } from '../../src/version.js';

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
    // KVM is absent unless a test opts in; all other probe / teardown calls succeed.
    if (child.command === 'bash' && args.includes('exec 3<>/dev/kvm')) {
      child.close(1);
      return;
    }
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
  const prevContainerBuilds = process.env.RUNNERIZE_CONTAINER_BUILDS;
  process.env.RUNNERIZE_RUNNER_DIR = runnerDir;
  process.env.RUNNERIZE_LINUX_IMAGE = 'example/image:latest';
  delete process.env.RUNNERIZE_CONTAINER_BUILDS;
  try {
    const { linux } = await freshImport('../../src/sandbox/container.js');
    return await fn(linux);
  } finally {
    if (prevDir === undefined) delete process.env.RUNNERIZE_RUNNER_DIR; else process.env.RUNNERIZE_RUNNER_DIR = prevDir;
    if (prevImage === undefined) delete process.env.RUNNERIZE_LINUX_IMAGE; else process.env.RUNNERIZE_LINUX_IMAGE = prevImage;
    if (prevContainerBuilds === undefined) delete process.env.RUNNERIZE_CONTAINER_BUILDS; else process.env.RUNNERIZE_CONTAINER_BUILDS = prevContainerBuilds;
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

test('linux passes through usable KVM and advertises the capability', async () => {
  await withLinuxLaunch(async (linux) => {
    const stub = new SpawnStub((child) => {
      const args = child.args ?? [];
      if (args.includes('--name')) {
        child.startJob();
        child.close(0);
        return;
      }
      child.emitStdout('ok\n');
      child.close(0);
    }).install();
    try {
      assert.equal(await linux.available(), true);
      assert.deepEqual(linux.labels, ['self-hosted', 'linux', 'x64', RUNNERIZE_VERSION_LABEL, 'kvm']);
      await linux.launch('cfg', { idleTimeoutMs: 5000 });
      const container = stub.find('--name');
      assert.deepEqual(
        container.args.slice(container.args.indexOf('--device'), container.args.indexOf('--device') + 2),
        ['--device', '/dev/kvm'],
      );
    } finally {
      stub.restore();
    }
  });
});

test('linux advertises functional opt-in container builds and configures the job container', async () => {
  await withLinuxLaunch(async (linux) => {
    process.env.RUNNERIZE_CONTAINER_BUILDS = '1';
    const stub = new SpawnStub((child) => {
      const args = child.args ?? [];
      if (args.includes('--name')) {
        child.startJob();
        child.close(0);
        return;
      }
      if (args.includes('exec 3<>/dev/kvm')) {
        child.close(1);
        return;
      }
      child.emitStdout('ok\n');
      child.close(0);
    }).install();
    try {
      assert.equal(await linux.available(), true);
      assert.deepEqual(linux.labels, ['self-hosted', 'linux', 'x64', 'container-build']);
      const probe = stub.children.find((child) => (child.args ?? []).some((arg) => String(arg).includes('runnerize-capability-probe')));
      assert.ok(probe, 'runs a real image-build probe before advertising the label');
      assert.ok(probe.args.includes('--user'));
      assert.ok(probe.args.includes('0'));
      assert.ok(probe.args.includes('RUNNERIZE_CONTAINER_BUILD_PROFILE=1'));
      const probeScript = probe.args.find((arg) => String(arg).includes('runnerize-capability-probe'));
      assert.match(probeScript, /\/proc\/self\/uid_map/, 'rejects an outer container whose root maps to host root');
      assert.match(probeScript, /for command in docker podman buildah/, 'probes every documented build shim');
      assert.match(probeScript, /runuser -u runner .* "\$command" build/, 'probes the user-facing commands as the runner user');
      assert.match(probeScript, /sudo -n \/usr\/bin\/id -u/, 'proves broad passwordless sudo is unavailable');
      assert.match(probeScript, /docker build --volume \/:\/host/, 'proves dangerous build options are rejected');
      assert.match(probeScript, /sudo -n \/opt\/runnerize\/libexec\/buildah-build "\$option"/,
        'proves direct helper calls cannot bypass the option policy');
      assert.match(probeScript, /--runtime=\/bin\/sh.*--userns=host/s,
        'probes runtime and namespace overrides at the privilege boundary');
      assert.match(probeScript, /BUILDAH_ISOLATION=chroot/);
      assert.match(probeScript, /build --cap-drop all/, 'removes capabilities from hostile RUN instructions');
      assert.match(probeScript, /CapBnd:\[\[:space:\]\]\*0000000000000000/,
        'functionally proves RUN instructions have an empty capability set');
      assert.match(probeScript, /STORAGE_DRIVER=vfs/);
      assert.ok(!probe.args.includes('--privileged'));
      assert.ok(!probe.args.includes('--device'));
      assert.ok(!probe.args.some((arg) => /docker\.sock|podman\.sock/.test(arg)));

      const probesBeforeLaunch = stub.children.filter((child) =>
        (child.args ?? []).some((arg) => String(arg).includes('runnerize-capability-probe'))).length;
      await linux.launch('cfg', { idleTimeoutMs: 5000 });
      const probesAfterLaunch = stub.children.filter((child) =>
        (child.args ?? []).some((arg) => String(arg).includes('runnerize-capability-probe'))).length;
      assert.equal(probesAfterLaunch, probesBeforeLaunch, 'reuses the successful probe for this runtime and image');
      const container = stub.find('--name');
      assert.ok(container.args.includes('--user'));
      assert.ok(container.args.includes('0'));
      assert.ok(container.args.includes('RUNNERIZE_CONTAINER_BUILD_PROFILE=1'));
      assert.ok(!container.args.includes('--privileged'));
      assert.ok(!container.args.includes('--device'));
      assert.ok(!container.args.some((arg) => /docker\.sock|podman\.sock/.test(arg)));
    } finally {
      stub.restore();
    }
  });
});

test('linux does not advertise container builds when the functional probe fails', async () => {
  await withLinuxLaunch(async (linux) => {
    process.env.RUNNERIZE_CONTAINER_BUILDS = '1';
    const stub = new SpawnStub((child) => {
      const args = child.args ?? [];
      if (args.includes('exec 3<>/dev/kvm') || args.some((arg) => String(arg).includes('runnerize-capability-probe'))) {
        child.close(1);
        return;
      }
      child.emitStdout('ok\n');
      child.close(0);
    }).install();
    try {
      assert.equal(await linux.available(), true);
      assert.deepEqual(linux.labels, ['self-hosted', 'linux', 'x64']);
      assert.equal(linux.containerBuild, false);
    } finally {
      stub.restore();
    }
  });
});

test('linux keeps labels and spawn args unchanged when optional capabilities are unusable', async () => {
  await withLinuxLaunch(async (linux) => {
    const stub = containerStub((child) => {
      child.startJob();
      child.close(0);
    }).install();
    try {
      assert.equal(await linux.available(), true);
      assert.deepEqual(linux.labels, ['self-hosted', 'linux', 'x64', RUNNERIZE_VERSION_LABEL]);
      await linux.launch('cfg', { idleTimeoutMs: 5000 });
      const container = stub.find('--name');
      const name = container.args[container.args.indexOf('--name') + 1];
      const runnerMount = container.args[container.args.indexOf('-v') + 1];
      const scriptMount = container.args[container.args.lastIndexOf('-v') + 1];
      assert.deepEqual(container.args, [
        'run', '--rm', '--name', name, '-e', 'JITCFG', '-e', 'MAX_LIFETIME_SECONDS',
        '-v', runnerMount,
        '-v', scriptMount,
        'example/image:latest', 'bash', '/inner.sh',
      ]);
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
      linux.containerBuild = true;
      assert.equal(await linux.available(), false);
      assert.deepEqual(linux.labels, ['self-hosted', 'linux', 'x64', RUNNERIZE_VERSION_LABEL], 'stale capability labels are removed');
      assert.equal(linux.containerBuild, false);
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
  assert.match(inner, /run\.sh" --jitconfig "\$JITCFG"|run\.sh --jitconfig "\$JITCFG"/,
    'launches run.sh with the jit config from env');
});

test('INNER_SCRIPT gives a non-root runner only the isolated image-build helper', async () => {
  const source = await readContainerSource();
  assert.match(source, /sed -i -E .*NOPASSWD\/d.*runner ALL=\(root\) NOPASSWD: \/opt\/runnerize\/libexec\/buildah-build/s,
    'existing broad passwordless sudo is removed before allowing only the fixed Buildah helper');
  assert.doesNotMatch(source, /runner ALL=\(ALL\) NOPASSWD: ALL/, 'does not grant broad passwordless sudo');
  assert.match(source, /driver="vfs"/, 'uses the VFS storage driver inside the outer user namespace');
  assert.match(source, /ignore_chown_errors="true"/, 'supports image ownership within the outer user namespace');
  assert.match(source, /awk .*\/proc\/self\/uid_map/, 'requires mapped outer-container root');
  assert.match(source, /if \[\[ "\$#" -eq 0 \|\| "\$1" != build \]\]/,
    'docker, podman, and buildah wrappers expose only image builds');
  assert.match(source, /--runtime-flag.*--volume.*--runtime-flag=\*.*--volume=\*/s,
    'the root Buildah helper rejects namespace, runtime, and bind-mount overrides itself');
  assert.match(source, /exec sudo -n \/opt\/runnerize\/libexec\/buildah-build "\$@"/,
    'the user-facing wrapper delegates validation to the privilege-boundary helper');
  assert.match(source, /SUDO_USER:-.*runner.*unsupported build option/s,
    'direct helper calls remain subject to the same fail-closed option parser');
  assert.match(source, /stage_wrapper=.*mktemp.*staged_context="\$stage_wrapper\/context".*source_context=.*mktemp/s,
    'the final context stays beneath a root-only wrapper during staging');
  assert.match(source, /source_context=.*mktemp.*runuser -u runner -- tar --create/s,
    'the helper snapshots a local context as the runner user before the root build');
  assert.match(source, /cp -a --no-dereference -- "\\\$\{source_context:\?\}\/\." "\\\$\{staged_context:\?\}\/"/,
    'root copies into a final directory the runner never owned or traversed');
  assert.match(source, /build contexts may not contain special files/,
    'device, socket, pipe, and block files are rejected before the root build');
  assert.match(source, /build context symlinks must resolve inside the context/,
    'symlinks cannot escape the staged context');
  assert.match(source, /\| runuser -u runner -- tar --extract/,
    'untrusted archives are extracted without root privileges');
  assert.match(source, /source_context=\ntrap 'rm -rf -- "\$stage_wrapper".*' EXIT/s,
    'cleanup is armed immediately after the first allocation');
  assert.doesNotMatch(source, /exec \/usr\/bin\/buildah build/,
    'the helper returns through its EXIT trap after Buildah finishes');
  assert.match(source, /\$\{source_context:\?\}\/\./,
    'empty staging paths fail closed before copying');
  assert.match(source, /build --cap-drop all/,
    'hostile RUN instructions receive no Linux capabilities');
  assert.match(source, /chown -R root:root "\$staged_context"/,
    'the staged context is root-owned before validation and the root build');
  assert.doesNotMatch(source, /chmod -R a-w "\$staged_context"/,
    'context modes are preserved for COPY and ADD');
  assert.match(source, /realpath -e -- "\$staged_context\/\$file"/,
    'Containerfiles must resolve inside the staged context');
  assert.doesNotMatch(source, /grep -RIEq .*\/proc\|\/sys\|\/dev/s,
    'security does not depend on heuristic Dockerfile scanning');
  assert.match(source, /ln -sf container-build \/opt\/runnerize\/bin\/docker/);
  assert.match(source, /ln -sf container-build \/opt\/runnerize\/bin\/podman/);
  assert.match(source, /exec runuser -u runner -- env/, 'the Actions runner remains non-root');
});

test('WSL forwards the max lifetime and the inner script has a defensive default', async () => {
  const source = await readContainerSource();
  assert.match(source, /WSLENV: `\$\{existing\}JITCFG:MAX_LIFETIME_SECONDS`/);
  assert.match(extractInnerScript(source), /MAX_LIFETIME_SECONDS:-604800/);
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
