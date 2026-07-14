import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureImage, ensureRunnerBinary } from '../runner.js';

const DEFAULT_IMAGE = 'catthehacker/ubuntu:full-latest';
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;

function collect(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)));
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
destination="$HOME/.cache/runnerize/runner"
if [[ ! -x "$destination/run.sh" ]]; then
  mkdir -p "$(dirname "$destination")"
  temporary="$(mktemp -d "$HOME/.cache/runnerize/.runner.XXXXXX")"
  trap 'rm -rf "$temporary"' EXIT
  cp -a "$source_dir"/. "$temporary"/
  [[ -x "$temporary/run.sh" ]] || { echo 'runner source is missing run.sh' >&2; exit 1; }
  rm -rf "$destination"
  mv "$temporary" "$destination"
  trap - EXIT
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
chmod 700 "$script"
printf '%s' "$script"
`, [encoded]);
  return stdout;
}

async function removeWslFile(distro, file) {
  if (!file) return;
  try {
    await collect('wsl.exe', ['-d', distro, '-e', 'rm', '-f', '--', file]);
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
    await collect(call.command, call.args, { env: call.env });
  } catch {
    // It may have exited between the watchdog firing and cleanup.
  }
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

  async launch(encodedJitConfig, { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS } = {}) {
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
      await writeFile(mountedScript, INNER_SCRIPT, { mode: 0o700 });
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
        let stderr = '';
        let timedOut = false;
        let settled = false;

        const timer = setTimeout(() => {
          if (startedJob) return;
          timedOut = true;
          void stopContainer(target, name);
        }, idleTimeoutMs);
        timer.unref?.();

        child.stdout.on('data', (chunk) => {
          stdoutRemainder += chunk.toString();
          const lines = stdoutRemainder.split(/\r?\n/);
          stdoutRemainder = lines.pop() || '';
          if (lines.some((line) => /Running job/i.test(line)) || /Running job/i.test(stdoutRemainder)) {
            startedJob = true;
            clearTimeout(timer);
          }
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.once('error', (error) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (timedOut) resolve({ startedJob: false });
          else if (code === 0) resolve({ startedJob });
          else reject(new Error(`${target.runtime} runner container exited with code ${code}: ${stderr.trim()}`));
        });
      });
    } finally {
      if (target.distro) await removeWslFile(target.distro, mountedScript);
      else await rm(temporary, { recursive: true, force: true });
    }
  },
};
