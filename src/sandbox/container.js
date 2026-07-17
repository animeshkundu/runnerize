import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureImage, ensureRunnerBinary } from '../runner.js';

// Fully qualified so rootless podman resolves it without needing an
// unqualified-search-registries entry in registries.conf (podman errors 125 on a
// bare short name; docker is lenient, so this stays correct there too).
const DEFAULT_IMAGE = 'docker.io/catthehacker/ubuntu:full-latest';
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const FORCE_SETTLE_MS = 7_000;
const DIAGNOSTICS_MAX_BYTES = 64 * 1024;

function appendBounded(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= DIAGNOSTICS_MAX_BYTES
    ? combined
    : combined.subarray(combined.length - DIAGNOSTICS_MAX_BYTES);
}

function collect(command, args, options = {}) {
  const { timeoutMs, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const timer = timeoutMs ? setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs) : null;
    timer?.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code) => settle(() => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))));
  });
}

async function nativeRuntime() {
  for (const runtime of ['podman', 'docker']) {
    try {
      await collect(runtime, ['--version']);
      return runtime;
    } catch {
      // Try the next runtime.
    }
  }
  return null;
}

async function wslDistributions() {
  const configured = process.env.RUNNERIZE_WSL_DISTRO;
  if (configured) return [configured];
  try {
    const { stdout } = await collect('wsl.exe', ['-l', '-q']);
    return stdout.replaceAll('\0', '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function wslRuntime() {
  if (process.platform !== 'win32') return null;
  for (const distro of await wslDistributions()) {
    for (const runtime of ['podman', 'docker']) {
      try {
        await collect('wsl.exe', ['-d', distro, '-e', runtime, '--version']);
        return { runtime, distro };
      } catch {
        // Keep looking for an available runtime.
      }
    }
  }
  return null;
}

async function backend() {
  if (process.platform === 'win32') return wslRuntime();
  const runtime = await nativeRuntime();
  return runtime ? { runtime } : null;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function wslPath(distro, windowsPath) {
  const { stdout } = await collect('wsl.exe', ['-d', distro, '-e', 'wslpath', '-a', windowsPath]);
  return stdout.trim();
}

function wslShell(distro, script, args = []) {
  return collect('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', script, 'runnerize', ...args]);
}

async function stageWslRunner(distro, runnerDir) {
  const source = /^[A-Za-z]:[\\/]/.test(runnerDir)
    ? await wslPath(distro, runnerDir)
    : runnerDir;
  if (!source.startsWith('/')) throw new Error('RUNNERIZE_RUNNER_DIR must be an absolute Windows or WSL path');

  const { stdout } = await wslShell(distro, `
set -euo pipefail
source_dir="$1"
version="$("$source_dir/bin/Runner.Listener" --version)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'runner source returned an invalid version' >&2; exit 1; }
destination="$HOME/.cache/runnerize/runners/$version"
if [[ ! -x "$destination/run.sh" ]]; then
  mkdir -p "$(dirname "$destination")"
  temporary="$(mktemp -d "$HOME/.cache/runnerize/runners/.runner.XXXXXX")"
  trap 'rm -rf "$temporary"' EXIT
  cp -a "$source_dir"/. "$temporary"/
  [[ -x "$temporary/run.sh" ]] || { echo 'runner source is missing run.sh' >&2; exit 1; }
  if mv -T "$temporary" "$destination" 2>/dev/null; then
    trap - EXIT
  fi
fi
printf '%s' "$destination"
`, [source]);
  return stdout;
}

async function createWslInnerScript(distro) {
  const encoded = Buffer.from(INNER_SCRIPT).toString('base64');
  const { stdout } = await wslShell(distro, `
set -euo pipefail
script="$(mktemp /tmp/runnerize-inner.XXXXXX)"
printf '%s' "$1" | base64 -d > "$script"
chmod 644 "$script"
printf '%s' "$script"
`, [encoded]);
  return stdout;
}

async function removeWslFile(distro, file) {
  if (!file) return;
  try {
    await collect('wsl.exe', ['-d', distro, '-e', 'rm', '-f', '--', file], { timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch {
    // Best-effort cleanup after the container exits.
  }
}

function invocation(target, runtimeArgs, env) {
  if (!target.distro) return { command: target.runtime, args: runtimeArgs, env };
  const commandLine = [target.runtime, ...runtimeArgs].map(shellQuote).join(' ');
  const existing = env.WSLENV ? `${env.WSLENV}:` : '';
  return {
    command: 'wsl.exe',
    args: ['-d', target.distro, '-e', 'bash', '-lc', commandLine],
    env: { ...env, WSLENV: `${existing}JITCFG` },
  };
}

async function stopContainer(target, name) {
  const args = ['rm', '-f', name];
  const call = invocation(target, args, process.env);
  try {
    await collect(call.command, call.args, { env: call.env, timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch {
    // It may have exited between the watchdog firing and cleanup.
  }
}

// Keep runner-output heuristics here so lifecycle wording changes have one update point.
function isJobStartLine(line) {
  return /\bRunning job(?:\s*:|\b)|\bJob\s+.+?\s+(?:started|running)\b/i.test(line);
}

const INNER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cp -a /rsrc/. "$workdir/"
cd "$workdir"
rm -rf _work _diag .runner .credentials*
export RUNNER_ALLOW_RUNASROOT=1
exec ./run.sh --jitconfig "$JITCFG"
`;

export const linux = {
  key: 'linux',
  labels: ['self-hosted', 'linux', 'x64'],

  async available() {
    return Boolean(await backend());
  },

  async launch(encodedJitConfig, {
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    onStarted,
    onFailureDiagnostics,
  } = {}) {
    if (!encodedJitConfig || typeof encodedJitConfig !== 'string') {
      throw new TypeError('encodedJitConfig must be a non-empty string');
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new RangeError('idleTimeoutMs must be a positive number');
    }

    const target = await backend();
    if (!target) throw new Error('podman or docker is required for the linux flavor');
    const image = process.env.RUNNERIZE_LINUX_IMAGE || DEFAULT_IMAGE;
    if (target.distro) {
      const inspect = invocation(target, ['image', 'inspect', image], process.env);
      try {
        await collect(inspect.command, inspect.args, { env: inspect.env });
      } catch {
        const pull = invocation(target, ['pull', image], process.env);
        await collect(pull.command, pull.args, { env: pull.env });
      }
    } else {
      await ensureImage(image);
    }

    const runnerDir = process.env.RUNNERIZE_RUNNER_DIR || await ensureRunnerBinary({ os: 'linux', arch: 'x64' });
    let temporary;
    let mountedRunner;
    let mountedScript;
    if (target.distro) {
      mountedRunner = await stageWslRunner(target.distro, runnerDir);
      mountedScript = await createWslInnerScript(target.distro);
    } else {
      temporary = await mkdtemp(path.join(os.tmpdir(), 'runnerize-'));
      mountedScript = path.join(temporary, 'inner.sh');
      await writeFile(mountedScript, INNER_SCRIPT, { mode: 0o644 });
      await chmod(mountedScript, 0o644);
      mountedRunner = runnerDir;
    }

    const name = `runnerize-${randomUUID()}`;
    const args = [
      'run', '--rm', '--name', name, '-e', 'JITCFG',
      '-v', `${mountedRunner}:/rsrc:ro`,
      '-v', `${mountedScript}:/inner.sh:ro`,
      image, 'bash', '/inner.sh',
    ];
    const env = { ...process.env, JITCFG: encodedJitConfig };
    const call = invocation(target, args, env);

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(call.command, call.args, {
          env: call.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let startedJob = false;
        let stdoutRemainder = '';
        let stderrRemainder = '';
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let timedOut = false;
        let settled = false;
        let forceTimer;
        let killTimer;

        const failureDiagnostics = () => {
          try {
            onFailureDiagnostics?.({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
            });
          } catch {
            // Diagnostics must not change the launch outcome.
          }
        };
        const settle = (callback, { failed = false } = {}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (forceTimer) clearTimeout(forceTimer);
          if (killTimer) clearTimeout(killTimer);
          if (failed) failureDiagnostics();
          callback();
        };
        const observeOutput = (text, remainder) => {
          const buffered = remainder + text;
          const lines = buffered.split(/\r?\n/);
          const nextRemainder = lines.pop() || '';
          if (!startedJob && (lines.some(isJobStartLine) || isJobStartLine(nextRemainder))) {
            startedJob = true;
            clearTimeout(timer);
            onStarted?.();
          }
          return nextRemainder;
        };
        const timer = setTimeout(() => {
          if (startedJob) return;
          timedOut = true;
          void stopContainer(target, name);
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
          killTimer.unref?.();
          forceTimer = setTimeout(() => settle(
            () => resolve({ startedJob: false }),
            { failed: true },
          ), FORCE_SETTLE_MS);
          forceTimer.unref?.();
        }, idleTimeoutMs);
        timer.unref?.();

        child.stdout.on('data', (chunk) => {
          stdout = appendBounded(stdout, chunk);
          stdoutRemainder = observeOutput(chunk.toString(), stdoutRemainder);
        });
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          stderr = appendBounded(stderr, chunk);
          stderrRemainder = observeOutput(text, stderrRemainder);
        });
        child.once('error', (error) => settle(() => reject(error), { failed: true }));
        child.once('close', (code) => settle(() => {
          if (timedOut) resolve({ startedJob: false });
          else if (code === 0) resolve({ startedJob });
          else reject(new Error(`${target.runtime} runner container exited with code ${code}: ${stderr.toString().trim()}`));
        }, { failed: timedOut || code !== 0 }));
      });
    } finally {
      if (target.distro) await removeWslFile(target.distro, mountedScript);
      else await rm(temporary, { recursive: true, force: true });
    }
  },
};
