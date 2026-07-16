import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { latestRunnerVersion } from '../runner.js';

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 300_000;
const READINESS_TIMEOUT_MS = 120_000;
const READINESS_POLL_MS = 2_000;
const READINESS_ATTEMPT_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 30_000;

function collect(command, args, { timeoutMs = COMMAND_TIMEOUT_MS, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function isJobStartLine(line) {
  return /\bRunning job(?:\s*:|\b)|\bJob\s+.+?\s+(?:started|running)\b/i.test(line);
}

function sshArgs(user, ip) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=10',
  ];
  const key = process.env.RUNNERIZE_MACOS_SSH_KEY;
  if (key) args.push('-i', key);
  args.push(`${user}@${ip}`);
  return args;
}

function startTartVm(vmName) {
  const child = spawn('tart', ['run', '--no-graphics', '--no-audio', vmName], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let outcome;
  const exited = new Promise((resolve) => {
    const finish = (error) => {
      if (outcome) return;
      outcome = { error };
      resolve(outcome);
    };
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', finish);
    child.once('close', (code) => finish(code === 0
      ? null
      : new Error(`tart VM exited with code ${code}: ${stderr.trim()}`)));
  });
  return { child, exited, get outcome() { return outcome; } };
}

async function waitForIp(vmName, tartRun) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (tartRun.outcome) throw tartRun.outcome.error ?? new Error(`tart VM ${vmName} exited before obtaining an IP address`);
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const { stdout } = await collect('tart', ['ip', vmName], {
        timeoutMs: Math.min(READINESS_ATTEMPT_TIMEOUT_MS, remaining),
      });
      const ip = stdout.trim();
      if (ip) return ip;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(READINESS_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`tart VM ${vmName} did not obtain an IP address`, { cause: lastError });
}

async function waitForSsh(args, tartRun) {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    if (tartRun.outcome) throw tartRun.outcome.error ?? new Error('tart VM exited before SSH became ready');
    try {
      const remaining = Math.max(1, deadline - Date.now());
      await collect('ssh', [...args, 'true'], {
        timeoutMs: Math.min(READINESS_ATTEMPT_TIMEOUT_MS, remaining),
      });
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(READINESS_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error('tart VM did not become reachable over SSH', { cause: lastError });
}

function bootstrapScript(encodedJitConfig, runnerDir, version) {
  const source = runnerDir ? `
cp -a ${shellQuote(runnerDir)}/. "$workdir"/
` : `
curl -fsSL -o runner.tar.gz ${shellQuote(`https://github.com/actions/runner/releases/download/v${version}/actions-runner-osx-arm64-${version}.tar.gz`)}
tar xzf runner.tar.gz
rm runner.tar.gz
`;
  return `#!/usr/bin/env bash
set -euo pipefail
jitfile="$(mktemp)"
workdir="$(mktemp -d)"
cleanup() { rm -f "$jitfile"; rm -rf "$workdir"; }
trap cleanup EXIT
printf '%s' ${shellQuote(encodedJitConfig)} > "$jitfile"
cd "$workdir"
${source}
rm -rf _work _diag .runner .credentials*
JITCFG="$(cat "$jitfile")"
rm -f "$jitfile"
export RUNNER_ALLOW_RUNASROOT=1
exec ./run.sh --jitconfig "$JITCFG"
`;
}

async function observeRunner(child, idleTimeoutMs, onStarted, stop) {
  return new Promise((resolve, reject) => {
    let startedJob = false;
    let stdoutRemainder = '';
    let stderrRemainder = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      void stop().finally(() => {
        child.kill('SIGTERM');
        settle(() => resolve({ startedJob: false }));
      });
    }, idleTimeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdoutRemainder = observeOutput(chunk.toString(), stdoutRemainder);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrRemainder = observeOutput(text, stderrRemainder);
    });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code) => settle(() => {
      if (timedOut) resolve({ startedJob: false });
      else if (code === 0) resolve({ startedJob });
      else reject(new Error(startedJob
        ? `macos runner failed after starting a job: ${stderr.trim()}`
        : `macos runner exited before starting a job: ${stderr.trim()}`));
    }));
  });
}

export const macos = {
  key: 'macos',
  labels: ['self-hosted', 'macos', 'arm64'],
  maxConcurrent: 2,

  async available() {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;
    try {
      await collect('tart', ['--version'], { timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  },

  async launch(encodedJitConfig, { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, onStarted } = {}) {
    if (!encodedJitConfig || typeof encodedJitConfig !== 'string') {
      throw new TypeError('encodedJitConfig must be a non-empty string');
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new RangeError('idleTimeoutMs must be a positive number');
    }
    if (process.platform !== 'darwin') throw new Error('the macos flavor requires macOS');
    if (process.arch !== 'arm64') throw new Error('the macos flavor requires Apple Silicon (arm64)');

    const image = process.env.RUNNERIZE_MACOS_IMAGE;
    if (!image) {
      throw new Error('RUNNERIZE_MACOS_IMAGE is required; set it to a tart base image such as ghcr.io/cirruslabs/macos-sequoia-base:latest');
    }
    const user = process.env.RUNNERIZE_MACOS_SSH_USER || 'admin';
    const runnerDir = process.env.RUNNERIZE_MACOS_RUNNER_DIR;
    const configuredVersion = process.env.RUNNERIZE_MACOS_RUNNER_VERSION;
    if (configuredVersion && !/^\d+\.\d+\.\d+$/.test(configuredVersion)) {
      throw new Error('RUNNERIZE_MACOS_RUNNER_VERSION must be a semantic version such as 2.325.0');
    }
    const version = runnerDir ? configuredVersion : configuredVersion || await latestRunnerVersion();
    const vmName = `runnerize-${randomUUID()}`;
    let tartRun;
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try {
        await collect('tart', ['stop', vmName], { timeoutMs: CLEANUP_TIMEOUT_MS });
      } catch {
        // It may already be stopped.
      }
    };

    try {
      await collect('tart', ['clone', image, vmName]);
      tartRun = startTartVm(vmName);
      const ip = await waitForIp(vmName, tartRun);
      const args = sshArgs(user, ip);
      await waitForSsh(args, tartRun);

      const child = spawn('ssh', [...args, 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const script = bootstrapScript(encodedJitConfig, runnerDir, version);
      child.stdin?.end(script);
      return await observeRunner(child, idleTimeoutMs, onStarted, stop);
    } finally {
      await stop();
      try {
        await collect('tart', ['delete', vmName], { timeoutMs: CLEANUP_TIMEOUT_MS });
      } catch {
        // Cleanup is best effort so it does not hide the runner outcome.
      }
      tartRun?.child.kill('SIGTERM');
    }
  },
};
