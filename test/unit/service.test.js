import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { freshImport } from '../helpers/fresh-module.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const os = require('node:os');

function installStubs({ exec, spawn }) {
  const originalExec = childProcess.execFileSync;
  const originalSpawn = childProcess.spawnSync;
  const originalPlatform = os.platform;
  childProcess.execFileSync = exec;
  childProcess.spawnSync = spawn;
  os.platform = () => 'win32';
  syncBuiltinESMExports();
  return () => {
    childProcess.execFileSync = originalExec;
    childProcess.spawnSync = originalSpawn;
    os.platform = originalPlatform;
    syncBuiltinESMExports();
  };
}

function successfulHarness(options = {}) {
  const calls = [];
  let cachedNodeChecks = 0;
  const registeredActions = new Map();
  const exec = (file, args, execOptions = {}) => {
    calls.push({ kind: 'exec', file, args, options: execOptions });
    if (file.toLowerCase().endsWith('powershell.exe')) {
      const command = args.at(-1);
      if (command.includes('WindowsIdentity]::GetCurrent().User.Value')) return 'S-1-5-21-1234\n';
      const elevatedLaunch = command.includes('Start-Process -FilePath');
      const confirmation = command.includes('[Console]::Out.Write($task.Principal.UserId)');
      const specMatch = command.includes('$a = $task.Actions | Select-Object -First 1');
      if (specMatch) {
        const taskNameMatch = command.match(/-TaskName '([^']*)'/);
        const taskName = taskNameMatch?.[1];
        // A genuinely-failed registration (as opposed to a powershell.exe crash-after-success)
        // must not be resurrected by the post-failure confirmation check: the task was never
        // actually registered, so this must report a mismatch/absence for that specific task.
        if (options.windowsTaskFails && taskName === 'runnerize-windows') {
          const error = new Error('no match');
          error.status = 1;
          error.stdout = '';
          error.stderr = '';
          throw error;
        }
        if (registeredActions.get(taskName) === true) return '';
        const error = new Error('no match');
        error.status = 1;
        error.stdout = '';
        error.stderr = '';
        throw error;
      }
      if (confirmation) {
        if (options.taskMissing || (options.accessDenied && (

          options.noElevateExpected || options.elevationDeclined || options.elevationError || options.elevationTimeout || options.nullExitCode
        ))) {
          const error = new Error('task missing');
          error.status = 1;
          error.stdout = '';
          error.stderr = '';
          throw error;
        }
        if (options.taskStillPresent || !options.uninstallAccessDenied) return 'S-1-5-21-1234';
        const error = new Error('task missing');
        error.status = 1;
        error.stdout = '';
        error.stderr = '';
        throw error;
      }
      if ((options.windowsTaskFails || options.registrationCrashesAfterSuccess) && command.includes("$taskName = 'runnerize-windows'") && command.includes('Register-ScheduledTask')) {
        // Simulates the powershell.exe child that dies at teardown (signal-less, empty
        // stdout/stderr) right after the CIM cmdlets already registered the task successfully.
        if (options.registrationCrashesAfterSuccess) registeredActions.set('runnerize-windows', true);
        const error = new Error('windows task registration failed');
        error.status = 1;
        error.stdout = '';
        error.stderr = options.registrationCrashesAfterSuccess ? '' : error.message;
        throw error;
      }
      const unregister = command.includes('Unregister-ScheduledTask') && !elevatedLaunch;
      if ((options.accessDenied && !elevatedLaunch) || (options.uninstallAccessDenied && unregister)) {
        const error = new Error(options.localizedDenied ? 'Zugriff verweigert' : 'Access is denied');
        error.status = options.localizedDenied ? 77 : 1;
        error.stderr = error.message;
        error.stdout = '';
        throw error;
      }
      if (elevatedLaunch) {
        assert.match(command, /-ErrorAction Stop/);
        assert.match(command, /-Wait -PassThru/);
        assert.match(command, /\$null -eq \$p -or \$null -eq \$p\.ExitCode/);
        assert.match(command, /exit \$p\.ExitCode/);
        assert.match(command, /catch \{ Write-Error \$_; exit 1 \}/);
        const error = new Error(options.elevationDeclined
          ? 'The operation was canceled by the user. (1223)'
          : options.elevationTimeout
            ? 'elevation prompt timed out'
            : 'elevated operation failed');
        if (options.elevationDeclined || options.elevationError || options.elevationTimeout || options.nullExitCode) {
          error.status = options.elevationError || options.nullExitCode ? 1 : null;
          error.stderr = options.nullExitCode ? 'elevated process exit code unavailable' : options.elevationError ? 'elevated operation failed' : '';
          error.stdout = '';
          if (options.elevationTimeout) {
            error.code = 'ETIMEDOUT';
            error.killed = true;
          }
          throw error;
        }
        const encodedMatch = command.match(/-EncodedCommand','([^']+)'/);
        assert.ok(encodedMatch, 'elevated payload passed as an encoded command');
        const elevatedScript = Buffer.from(encodedMatch[1], 'base64').toString('utf16le');
        assert.doesNotMatch(elevatedScript, /Set-Content/);
        assert.match(elevatedScript, /exit 0/);
        assert.match(elevatedScript, /exit 1/);
        const elevatedTaskNameMatch = elevatedScript.match(/\$taskName = '([^']*)'/);
        if (elevatedTaskNameMatch && !options.taskMissing) registeredActions.set(elevatedTaskNameMatch[1], true);
      }
      const registerMatch = !elevatedLaunch && command.includes('Register-ScheduledTask') && command.match(/\$taskName = '([^']*)'/);
      if (registerMatch) registeredActions.set(registerMatch[1], true);
      return '';
    }
    if (file !== 'wsl.exe') return '';
    if (args[0] === '--status') return options.status ?? 'Default Distribution: Ubuntu\r\n';
    if (args[0] === '-l') return options.distros ?? 'docker-desktop\0\r\nUbuntu\0\r\n';
    const command = args.slice(args.indexOf('-e') + 1);
    if (command[0] === 'whoami') return 'ani\n';
    if (command[0] === 'ps') return options.noSystemd ? 'init' : 'systemd';
    if (command[0] === 'sh' && command.includes('printf %s "$HOME"')) return '/home/ani';
    if (command[0] === 'sh' && command[1] === '-c' && command[2].includes('/etc/os-release')) return options.osRelease ?? 'ubuntu debian';
    if (command[0] === 'sh' && command[1] === '-c' && command[2].includes('command -v node')) {
      if (options.nodeAbsent) throw new Error('node missing');
      return options.nodeOutput ?? '/usr/bin/node\nv24.18.0\n';
    }
    if (command[0] === 'bash' && command[1] === '-lc' && command[2] === 'sudo -n apt-get update && sudo -n apt-get install -y podman') {
      if (options.podmanInstallFails) throw new Error('sudo: a password is required');
      return '';
    }
    if (command[0] === 'podman') {
      if (options.noRuntime && !(options.podmanInstallSucceeds && command[1] === '--version')) throw new Error('podman missing');
      return command[1] === '--version' ? 'podman version 4.9.3' : 'host: podman';
    }
    if (command[0] === 'docker') {
      if (options.noRuntime) throw new Error('docker missing');
      throw new Error('docker missing');
    }
    if (command[0] === 'gh') {
      if (options.noGh) throw new Error('not authenticated');
      return command[2] === 'token' ? 'test-gh-token' : 'Logged in';
    }
    if (command[0] === 'wslpath') return '/mnt/c/Users/Ani/runnerize';
    if (command[0]?.endsWith('/bin/node') && command[1] === '--version') {
      cachedNodeChecks += 1;
      if (options.cachedNode === false && cachedNodeChecks === 1) throw new Error('cached node missing');
      return 'v24.18.0';
    }
    return '';
  };
  const spawn = (file, args, spawnOptions = {}) => {
    calls.push({ kind: 'spawn', file, args, options: spawnOptions });
    if (file === 'whoami.exe') return { status: 0, stdout: 'DESKTOP\\ani\n', stderr: '' };
    if (file === 'where.exe' && args[0] === 'wsb.exe') {
      return { status: options.noWsb ? 1 : 0, stdout: options.noWsb ? '' : 'C:\\Windows\\System32\\wsb.exe\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, exec, spawn };
}

async function withWindowsService(options, action) {
  const harness = successfulHarness(options);
  const appData = mkdtempSync(join(tmpdir(), 'runnerize-service-'));
  const oldAppData = process.env.APPDATA;
  const oldToken = process.env.GH_TOKEN;
  const oldGitHubToken = process.env.GITHUB_TOKEN;
  const oldLocalAppData = process.env.LOCALAPPDATA;
  const oldNoElevate = process.env.RUNNERIZE_NO_ELEVATE;
  process.env.APPDATA = appData;
  process.env.LOCALAPPDATA = appData;
  if (options.noElevateEnv) process.env.RUNNERIZE_NO_ELEVATE = options.noElevateEnv;
  else delete process.env.RUNNERIZE_NO_ELEVATE;
  delete process.env.GITHUB_TOKEN;
  if (options.token) process.env.GH_TOKEN = options.token;
  else if (!options.noWsb && !options.noNativeToken) process.env.GH_TOKEN = 'test-native-token';
  else delete process.env.GH_TOKEN;
  const restore = installStubs(harness);
  try {
    const service = await freshImport('../../src/service.js');
    await action(service, harness, appData);
  } finally {
    restore();
    rmSync(appData, { recursive: true, force: true });
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
    if (oldGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldGitHubToken;
    if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocalAppData;
    if (oldNoElevate === undefined) delete process.env.RUNNERIZE_NO_ELEVATE;
    else process.env.RUNNERIZE_NO_ELEVATE = oldNoElevate;
  }
}

function commandOf(call) {
  return call.args.slice(call.args.indexOf('-e') + 1);
}

test('Windows install skips docker-desktop, reuses PATH Node, and delegates service install', async () => {
  await withWindowsService({ cachedNode: false }, async (service, harness, appData) => {
    await service.installService();
    const whoami = harness.calls.find((call) => commandOf(call)[0] === 'whoami');
    assert.ok(whoami.args.includes('Ubuntu'));
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command[0] === 'bash' && command[1] === '-lc'
        && command.includes('/usr/bin/node')
        && command.includes('/home/ani/.local/share/runnerize/bin/runnerize.js')
        && command.includes('install');
    }));
    assert.ok(harness.calls.some((call) => commandOf(call).includes('enable-linger')));
    const task = harness.calls.find((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('New-ScheduledTaskTrigger'));
    assert.equal(task.kind, 'exec', 'task registration output is captured and drained');
    assert.equal(task.options.encoding, 'utf8');
    assert.equal(task.options.windowsHide, true);
    assert.match(task.args.at(-1), /New-ScheduledTaskTrigger -AtLogOn/);
    assert.match(task.args.at(-1), /-d "Ubuntu" -u "ani"/);
    assert.match(task.args.at(-1), /systemctl --user start runnerize/);
    assert.ok(harness.calls.some((call) => commandOf(call).includes('RUNNERIZE_SERVICE_RUN_ONLY=linux')));
    const tasks = harness.calls.filter((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('New-ScheduledTaskTrigger'));
    assert.equal(tasks.length, 2);
    assert.ok(tasks.some((call) => call.args.at(-1).includes("$taskName = 'runnerize-windows'")));
    for (const call of tasks) {
      // A trailing Remove-Item run in the same powershell.exe process right after the
      // ScheduledTasks module's CIM cmdlets (Get-/Register-ScheduledTask) reliably crashes
      // that process on exit, even though the registration itself already succeeded. Startup
      // fallback cleanup is done from Node (rmSync) instead — the script must stay clear of it.
      assert.doesNotMatch(call.args.at(-1), /Remove-Item/);
    }
    const launcher = readFileSync(join(appData, 'runnerize', 'runnerize-windows.ps1'), 'utf8');
    assert.match(launcher, /Local\\runnerize-windows/);
    // A raw 0x80000001 literal parses as a negative Int32 in PowerShell (high bit set), which
    // then fails to bind to the uint esFlags P/Invoke parameter — Convert.ToUInt32 avoids that.
    assert.match(launcher, /SetThreadExecutionState\(\[Convert\]::ToUInt32\('80000001', 16\)\)/);
    assert.match(launcher, /run --only windows/);
    assert.match(launcher, /runnerize-windows\.log/);
    assert.ok(existsSync(join(appData, 'runnerize', 'app', 'bin', 'runnerize.js')));
  });
});

test('Windows install adds the WSL keep-awake holder when the Windows backend fails', async () => {
  await withWindowsService({ windowsTaskFails: true }, async (service, harness, appData) => {
    await service.installService();
    const taskCommands = harness.calls
      .filter((call) => call.file.toLowerCase().endsWith('powershell.exe'))
      .map((call) => call.args.at(-1));
    assert.ok(taskCommands.some((command) => command.includes("$taskName = 'runnerize-wsl-keepawake'")));
    assert.ok(existsSync(join(appData, 'runnerize', 'runnerize-wsl-keepawake.ps1')));
  });
});

test('Windows install treats a post-success powershell.exe crash as registered, not failed', async () => {
  await withWindowsService({ registrationCrashesAfterSuccess: true }, async (service, harness, appData) => {
    await service.installService();
    const taskCommands = harness.calls
      .filter((call) => call.file.toLowerCase().endsWith('powershell.exe'))
      .map((call) => call.args.at(-1));
    // No UAC elevation, no wsl-keepawake fallback, and no Startup-folder fallback: the
    // registration is confirmed via Get-ScheduledTask and treated as a success outright.
    assert.ok(!taskCommands.some((command) => command.includes('Start-Process')));
    assert.ok(!taskCommands.some((command) => command.includes("$taskName = 'runnerize-wsl-keepawake'")));
    assert.equal(existsSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize-windows.vbs')), false);
  });
});

test('Windows install skips Podman installation when a runtime is present', async () => {
  await withWindowsService({}, async (service, harness) => {
    await service.installService();
    assert.ok(!harness.calls.some((call) => commandOf(call)[2] === 'sudo -n apt-get update && sudo -n apt-get install -y podman'));
  });
});

test('Windows dry-run preflight never installs a missing Podman runtime', async () => {
  await withWindowsService({ noRuntime: true }, async (service, harness) => {
    await assert.rejects(service.preflightRun({ install: false }), /sudo -n apt-get update && sudo -n apt-get install -y podman/);
    assert.ok(!harness.calls.some((call) => commandOf(call)[2] === 'sudo -n apt-get update && sudo -n apt-get install -y podman'));
  });
});

test('Windows install installs and re-probes Podman non-interactively when absent', async () => {
  await withWindowsService({ noRuntime: true, podmanInstallSucceeds: true }, async (service, harness) => {
    await service.installService();
    assert.ok(harness.calls.some((call) => commandOf(call)[2] === 'sudo -n apt-get update && sudo -n apt-get install -y podman'));
    assert.ok(harness.calls.some((call) => commandOf(call)[0] === 'podman' && commandOf(call)[1] === '--version'));
  });
});

test('Windows install guides a manual Podman install when non-interactive sudo fails', async () => {
  await withWindowsService({ noRuntime: true, podmanInstallFails: true, noWsb: true }, async (service, harness) => {
    await assert.rejects(service.installService(), /sudo -n apt-get update && sudo -n apt-get install -y podman/);
    const install = harness.calls.find((call) => commandOf(call)[2] === 'sudo -n apt-get update && sudo -n apt-get install -y podman');
    assert.equal(install.options.timeout, 120_000);
  });
});

test('Windows install guides GitHub login when no credential is available', async () => {
  await withWindowsService({ noGh: true, noWsb: true }, async (service) => {
    await assert.rejects(service.installService(), /Run: gh auth login[\s\S]*Administration, Actions, and Metadata/);
  });
});

test('Windows install guides WSL installation when no distro exists', async () => {
  await withWindowsService({ distros: '', noWsb: true }, async (service) => {
    await assert.rejects(service.installService(), /elevated PowerShell: wsl --install -d Ubuntu/);
  });
});

test('Windows install reuses the cached Node without downloading on reinstall', async () => {
  await withWindowsService({}, async (service, harness) => {
    await service.installService();
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command[0] === '/home/ani/.cache/runnerize/node/v24.18.0/bin/node'
        && command[1] === '--version';
    }));
    assert.ok(!harness.calls.some((call) => commandOf(call)[2]?.includes('sha256sum -c')));
    assert.ok(harness.calls.some((call) => commandOf(call).includes('/home/ani/.cache/runnerize/node/v24.18.0/bin/node')));
  });
});

test('Windows install persists a Windows token and downloads pinned Node when absent', async () => {
  await withWindowsService({ noGh: true, token: 'test-token', nodeAbsent: true, cachedNode: false }, async (service, harness) => {
    await service.installService();
    const tokenWrite = harness.calls.find((call) => {
      const command = commandOf(call);
      return command[0] === 'sh' && command[2]?.includes('GH_TOKEN=%s');
    });
    assert.ok(tokenWrite, 'token persisted into the WSL service environment file');
    assert.equal(tokenWrite.options.env.GH_TOKEN, 'test-token');
    const download = harness.calls.find((call) => {
      const command = commandOf(call);
      return command[0] === 'bash' && command[1] === '-c' && command[2].includes('sha256sum -c');
    });
    assert.ok(download, 'pinned Node download script invoked');
    assert.equal(download.options.encoding, 'utf8');
    assert.equal(download.options.windowsHide, true);
    assert.ok(download.args.includes('55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742'));
    const protect = harness.calls.find((call) => call.file.toLowerCase().endsWith('powershell.exe')
      && call.args.at(-1).includes('RUNNERIZE_INSTALL_TOKEN'));
    assert.match(protect.args.at(-1), /^\$ErrorActionPreference = 'Stop';/);
  });
});

test('Windows install downloads Node when PATH points to Node 16 even if its path says v20', async () => {
  await withWindowsService({ nodeOutput: '/opt/node-v20/bin/node\nv16.20.2\n', cachedNode: false }, async (service, harness) => {
    await service.installService();
    assert.ok(harness.calls.some((call) => commandOf(call)[2]?.includes('sha256sum -c')));
  });
});

test('Windows install strips a BOM and prefers the WSL default distro', async () => {
  await withWindowsService({
    status: 'Default Distribution: Debian\r\n',
    distros: '﻿docker-desktop\0\r\nUbuntu\0\r\nDebian\0\r\n',
  }, async (service, harness) => {
    await service.installService();
    const whoami = harness.calls.find((call) => commandOf(call)[0] === 'whoami');
    assert.ok(whoami.args.includes('Debian'));
  });
});

test('Windows install fails actionably before runtime installation when systemd is unavailable', async () => {
  await withWindowsService({ noSystemd: true, noRuntime: true, noWsb: true }, async (service, harness) => {
    await assert.rejects(service.installService(), /Enable it in \/etc\/wsl\.conf/);
    assert.ok(!harness.calls.some((call) => commandOf(call)[2] === 'sudo -n apt-get update && sudo -n apt-get install -y podman'));
  });
});

test('Windows install completes preflight before probing or installing Node', async () => {
  await withWindowsService({ noGh: true, nodeAbsent: true, cachedNode: false, noWsb: true }, async (service, harness) => {
    await assert.rejects(service.installService(), /Run: gh auth login/);
    assert.ok(!harness.calls.some((call) => commandOf(call)[2]?.includes('sha256sum -c')));
  });
});

test('Windows install uses Tier 1 Task Scheduler without elevation when registration succeeds', async () => {
  await withWindowsService({}, async (service, harness) => {
    await service.installService();
    const powershell = harness.calls.filter((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('New-ScheduledTaskTrigger'));
    assert.equal(powershell.length, 2);
    assert.equal(powershell[0].kind, 'exec');
    assert.doesNotMatch(powershell[0].args.at(-1), /Start-Process/);
  });
});

test('Windows install elevates Task Scheduler registration after Tier 1 access denied', async () => {
  await withWindowsService({ accessDenied: true }, async (service, harness, appData) => {
    await service.installService();
    const elevated = harness.calls.find((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Start-Process'));
    assert.ok(elevated, 'UAC elevation attempted');
    assert.equal(elevated.kind, 'exec', 'elevation launcher output is captured and drained');
    assert.equal(elevated.options.encoding, 'utf8');
    assert.equal(elevated.options.windowsHide, true);
    assert.match(elevated.args.at(-1), /-Wait -PassThru/);
    assert.doesNotMatch(elevated.args.at(-1), /-File(?:\s|')/);
    assert.match(elevated.args.at(-1), /-EncodedCommand/);
    assert.equal(existsSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs')), false, 'Startup fallback was not written');
  });
});

test('Windows install falls back promptly when elevation is declined', async () => {
  await withWindowsService({ accessDenied: true, elevationDeclined: true }, async (service, _harness, appData) => {
    const started = Date.now();
    await service.installService();
    assert.ok(Date.now() - started < 1_000, 'decline does not enter marker polling');
    const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs');
    const launcher = readFileSync(startup, 'utf8');
    assert.match(launcher, /wsl\.exe/);
    assert.match(launcher, /systemctl --user start runnerize/);
  });
});

test('Windows install falls back when the elevated exit code is unavailable', async () => {
  await withWindowsService({ accessDenied: true, nullExitCode: true }, async (service, _harness, appData) => {
    await service.installService();
    assert.match(readFileSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs'), 'utf8'), /wsl\.exe/);
  });
});

test('Windows install falls back when elevated success cannot be confirmed', async () => {
  await withWindowsService({ accessDenied: true, taskMissing: true }, async (service, _harness, appData) => {
    const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs');
    await service.installService();
    assert.match(readFileSync(startup, 'utf8'), /wsl\.exe/);
  });
});

test('Windows install falls back when the elevated command exits nonzero', async () => {
  await withWindowsService({ accessDenied: true, elevationError: true }, async (service, _harness, appData) => {
    await service.installService();
    assert.match(readFileSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs'), 'utf8'), /wsl\.exe/);
    assert.equal(existsSync(join(appData, 'runnerize', 'elevation-marker')), false, 'elevation does not create marker files');
  });
});

test('Windows install writes no fallback when elevated registration times out', async () => {
  await withWindowsService({ accessDenied: true, elevationTimeout: true }, async (service, harness, appData) => {
    const started = Date.now();
    await assert.rejects(
      service.installService({ elevationTimeoutMs: 10 }),
      /no Startup fallback was written because the elevated task may still complete/,
    );
    assert.ok(Date.now() - started < 1_000, 'test timeout remains bounded');
    const elevated = harness.calls.find((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Start-Process'));
    assert.equal(elevated.options.timeout, 10);
    assert.equal(existsSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs')), false);
  });
});

test('Windows install recognizes localized access denied by its stable exit code', async () => {
  await withWindowsService({ accessDenied: true, localizedDenied: true }, async (service, harness) => {
    await service.installService({ noElevate: true });
    assert.ok(!harness.calls.some((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Start-Process')));
  });
});

test('Windows install skips elevation when --no-elevate is set', async () => {
  await withWindowsService({ accessDenied: true, noElevateExpected: true }, async (service, harness, appData) => {
    await service.installService({ noElevate: true });
    assert.ok(!harness.calls.some((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Start-Process')));
    assert.match(readFileSync(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs'), 'utf8'), /wsl\.exe/);
  });
});

test('Windows install skips elevation when RUNNERIZE_NO_ELEVATE is non-empty', async () => {
  await withWindowsService({ accessDenied: true, noElevateEnv: '1' }, async (service, harness) => {
    await service.installService();
    assert.ok(!harness.calls.some((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Start-Process')));
  });
});

test('Windows uninstall elevates task removal after non-elevated access denied', async () => {
  await withWindowsService({ uninstallAccessDenied: true }, async (service, harness, appData) => {
    await service.uninstallService();
    const elevated = harness.calls.find((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Start-Process'));
    assert.ok(elevated, 'elevated task removal attempted');
    assert.equal(elevated.kind, 'exec', 'elevated removal output is captured and drained');
    assert.match(elevated.args.at(-1), /-EncodedCommand/);
    assert.doesNotMatch(elevated.args.at(-1), /-File(?:\s|')/);
    assert.equal(existsSync(join(appData, 'runnerize', 'elevation-marker')), false, 'elevated removal creates no marker files');
  });
});

test('Windows uninstall warns when elevated removal cannot be confirmed', async () => {
  await withWindowsService({ uninstallAccessDenied: true, taskStillPresent: true }, async (service, harness) => {
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(message);
    try {
      await service.uninstallService();
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(harness.calls.some((call) => call.args.at(-1)?.includes('[Console]::Out.Write($task.Principal.UserId)')));
    assert.ok(warnings.some((message) => /removal could not be confirmed/.test(message)));
  });
});

test('Windows uninstall removes the WSL service, task, package, and cache', async () => {
  await withWindowsService({}, async (service, harness) => {
    await service.uninstallService();
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command.includes('service') && command.includes('uninstall')
        && command[2]?.includes('XDG_RUNTIME_DIR');
    }));
    assert.ok(harness.calls.some((call) => commandOf(call).includes('disable-linger')));
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command[0] === 'rm' && command.includes('/home/ani/.local/share/runnerize');
    }));
    assert.ok(harness.calls.some((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Unregister-ScheduledTask')));
  });
});
