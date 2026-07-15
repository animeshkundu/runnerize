import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureRunnerBinary } from '../runner.js';

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const WSB_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const LOG_POLL_MS = 100;
const SANDBOX_LIVENESS_POLL_MS = 5_000;

function collect(command, args, { timeoutMs = WSB_TIMEOUT_MS, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code) => settle(() => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))));
  });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function sandboxConfig(runnerDir, controlDir) {
  return `<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>${xmlEscape(path.resolve(runnerDir))}</HostFolder>
      <SandboxFolder>C:\\runnerize\\runner</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
    <MappedFolder>
      <HostFolder>${xmlEscape(path.resolve(controlDir))}</HostFolder>
      <SandboxFolder>C:\\runnerize\\control</SandboxFolder>
      <ReadOnly>false</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\runnerize\\control\\run-runner.ps1</Command>
  </LogonCommand>
</Configuration>`;
}

const RUNNER_SCRIPT = `$ErrorActionPreference = 'Stop'
$log = 'C:\\runnerize\\control\\runner.log'
$done = 'C:\\runnerize\\control\\runner.done'
$exitCode = 1
try {
  $work = Join-Path $env:TEMP ('runnerize-' + [guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $work | Out-Null
  Copy-Item -Path 'C:\\runnerize\\runner\\*' -Destination $work -Recurse -Force
  Set-Location $work
  Remove-Item -Path '_work', '_diag', '.runner', '.credentials*' -Recurse -Force -ErrorAction SilentlyContinue
  $jitConfig = (Get-Content -LiteralPath 'C:\\runnerize\\control\\jit-config.txt' -Raw).Trim()
  & .\\run.cmd --jitconfig $jitConfig 2>&1 | Out-File -LiteralPath $log -Encoding utf8 -Append
  $exitCode = $LASTEXITCODE
} catch {
  $_ | Out-String | Add-Content -LiteralPath $log
} finally {
  Set-Content -LiteralPath $done -Value $exitCode
}
exit $exitCode
`;

function isJobStartLine(line) {
  return /\bRunning job(?:\s*:|\b)|\bJob\s+.+?\s+(?:started|running)\b/i.test(line);
}

function normalizeSandboxId(id) {
  return String(id).trim().replace(/^\{(.*)\}$/, '$1').toLowerCase();
}

async function runningSandboxIds({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const { stdout } = await collect('wsb.exe', ['list', '--raw'], { timeoutMs });
  const parsed = JSON.parse(stdout);
  return (parsed.WindowsSandboxEnvironments ?? []).map(({ Id }) => normalizeSandboxId(Id));
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

async function stopSandbox(id) {
  const normalizedId = normalizeSandboxId(id);
  let lastError;
  try {
    await collect('wsb.exe', ['stop', '--id', id], { timeoutMs: STOP_TIMEOUT_MS });
  } catch (error) {
    lastError = error;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      if (!(await runningSandboxIds({ timeoutMs: remaining })).includes(normalizedId)) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(LOG_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw lastError ?? new Error(`Windows Sandbox ${id} did not stop`);
}

async function observeRunner(sandboxId, controlDir, idleTimeoutMs, onStarted) {
  const logFile = path.join(controlDir, 'runner.log');
  const doneFile = path.join(controlDir, 'runner.done');
  const deadline = Date.now() + idleTimeoutMs;
  let nextLivenessCheck = Date.now() + SANDBOX_LIVENESS_POLL_MS;
  let startedJob = false;

  while (true) {
    let log = '';
    try {
      log = await readFile(logFile, 'utf8');
    } catch {
      // The mapped log is not visible until the wrapper creates it.
    }
    if (!startedJob && log.split(/\r?\n/).some(isJobStartLine)) {
      startedJob = true;
      onStarted?.();
    }

    try {
      await readFile(doneFile, 'utf8');
      return { startedJob };
    } catch {
      // The wrapper is still running.
    }

    const now = Date.now();
    if (!startedJob && now >= deadline) return { startedJob: false };
    if (now >= nextLivenessCheck) {
      try {
        const ids = await runningSandboxIds();
        if (!ids.includes(normalizeSandboxId(sandboxId))) return { startedJob };
      } catch {
        // A transient list failure must not terminate a live runner.
      }
      nextLivenessCheck = Date.now() + SANDBOX_LIVENESS_POLL_MS;
    }
    await delay(LOG_POLL_MS);
  }
}

export const windows = {
  key: 'windows',
  labels: ['self-hosted', 'windows', 'x64'],
  maxConcurrent: 1,

  async available() {
    if (process.platform !== 'win32') return false;
    try {
      await collect('wsb.exe', ['list', '--raw'], { timeoutMs: 5_000 });
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
    if (process.platform !== 'win32') throw new Error('the windows flavor requires Windows');

    const runnerDir = process.env.RUNNERIZE_RUNNER_DIR
      || await ensureRunnerBinary({ os: 'win32', arch: 'x64' });
    const controlDir = await mkdtemp(path.join(os.tmpdir(), 'runnerize-windows-'));
    const sandboxId = randomUUID();
    try {
      await writeFile(path.join(controlDir, 'jit-config.txt'), encodedJitConfig, { mode: 0o600 });
      await writeFile(path.join(controlDir, 'run-runner.ps1'), RUNNER_SCRIPT, { mode: 0o600 });
      await writeFile(path.join(controlDir, 'runner.log'), '', { mode: 0o600 });
      const config = sandboxConfig(runnerDir, controlDir);
      await collect('wsb.exe', ['start', '--id', sandboxId, '--config', config]);
      return await observeRunner(sandboxId, controlDir, idleTimeoutMs, onStarted);
    } finally {
      try {
        await stopSandbox(sandboxId);
      } finally {
        await rm(controlDir, { recursive: true, force: true });
      }
    }
  },
};
