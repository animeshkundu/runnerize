import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { freshImport } from '../helpers/fresh-module.js';
import { RUNNERIZE_VERSION } from '../../src/version.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const os = require('node:os');

function installStubs({ exec, spawn, platformName = 'win32', home }) {
  const originalExec = childProcess.execFileSync;
  const originalSpawn = childProcess.spawnSync;
  const originalPlatform = os.platform;
  const originalHomedir = os.homedir;
  childProcess.execFileSync = exec;
  childProcess.spawnSync = spawn;
  os.platform = () => platformName;
  if (home) os.homedir = () => home;
  syncBuiltinESMExports();
  return () => {
    childProcess.execFileSync = originalExec;
    childProcess.spawnSync = originalSpawn;
    os.platform = originalPlatform;
    os.homedir = originalHomedir;
    syncBuiltinESMExports();
  };
}

function successfulHarness(options = {}) {
  const calls = [];
  let installedNodeChecks = 0;
  const registeredActions = new Map();
  const registeredArguments = new Map();
  for (const taskName of options.installedTasks ?? []) registeredActions.set(taskName, true);
  const exec = (file, args, execOptions = {}) => {
    calls.push({ kind: 'exec', file, args, options: execOptions });
    if (file.toLowerCase().endsWith('powershell.exe')) {
      const command = args.at(-1);
      if (command.includes('WindowsIdentity]::GetCurrent().User.Value')) return 'S-1-5-21-1234\n';
      if (command.includes('[System.Environment]::OSVersion.Version.Build')) return `${options.windowsBuild ?? (options.noWsb ? 26000 : 26100)}\n`;
      const elevatedLaunch = command.includes('Start-Process -FilePath');
      const runningProbe = command.includes("$task.State -ne 'Running'");
      if (runningProbe) {
        if (options.windowsTaskRunning) return '';
        const error = new Error('task is not running');
        error.status = 1;
        error.stdout = '';
        error.stderr = '';
        throw error;
      }
      const confirmation = command.includes('[Console]::Out.Write($task.Principal.UserId)');
      const specMatch = command.includes('$a = $task.Actions | Select-Object -First 1');
      if (options.startTaskFails && command.includes("Start-ScheduledTask -TaskName 'runnerize-windows'")) {
        const error = new Error('could not start task');
        error.status = 1;
        error.stdout = '';
        error.stderr = error.message;
        throw error;
      }
      if (specMatch) {
        const taskNameMatch = command.match(/-TaskName '([^']*)'/);
        const taskName = taskNameMatch?.[1];
        if (options.recordRegisteredArguments) {
          const expectedArgument = command.match(/\$a\.Arguments -eq '([^']*)'/)?.[1]?.replaceAll("''", "'");
          if (expectedArgument !== registeredArguments.get(taskName)) {
            const error = new Error('no match');
            error.status = 1;
            error.stdout = '';
            error.stderr = '';
            throw error;
          }
        }
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
      if (options.startTaskFailsOnce && command.includes("Start-ScheduledTask -TaskName 'runnerize-windows'")) {
        options.startTaskFailsOnce = false;
        const error = new Error('could not start task');
        error.status = 1;
        error.stdout = '';
        error.stderr = error.message;
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
      if (registerMatch) {
        registeredActions.set(registerMatch[1], true);
        if (options.recordRegisteredArguments) {
          const argument = command.match(/New-ScheduledTaskAction .* -Argument '((?:[^']|'')*)'/)?.[1]?.replaceAll("''", "'");
          registeredArguments.set(registerMatch[1], argument);
        }
      }
      return '';
    }
    if (file === 'podman') {
      if (args[0] === '--version') return 'podman 5\n';
      if (args[0] === 'image' && args[1] === 'inspect') {
        return '[{"RepoDigests":["example/image@sha256:abc123"],"Created":"2026-07-01T12:34:56Z"}]\n';
      }
      if (args[0] === 'pull') return 'pulled\n';
    }
    if (file !== 'wsl.exe') return '';
    if (args[0] === '--status') return options.status ?? 'Default Distribution: Ubuntu\r\n';
    if (args[0] === '-l') return options.distros ?? 'docker-desktop\0\r\nUbuntu\0\r\n';
    const command = args.slice(args.indexOf('-e') + 1);
    if (command[0] === 'whoami') return 'ani\n';
    if (command[0] === 'ps') return options.noSystemd ? 'init' : 'systemd';
    if (command[0] === 'sh' && command.includes('printf %s "$HOME"')) return '/home/ani';
    if (command[0] === 'sh' && command[1] === '-c' && command[3] === 'runnerize-node-migrate') {
      if (!options.legacyNode) throw new Error('legacy node missing');
      return 'v24.18.0';
    }
    if (command[0] === 'sh' && command[1] === '-c' && command[2].includes('/etc/os-release')) return options.osRelease ?? 'ubuntu debian';
    if (command[0] === 'cat' && command[1]?.endsWith('/.config/systemd/user/runnerize.service')) {
      if (!options.wslInstalledRoot) throw new Error('unit missing');
      return `ExecStart="/usr/bin/node" "${options.wslInstalledRoot}/bin/runnerize.js" run --only linux\n`;
    }
    if (command[0] === 'cat' && command[1] === `${options.wslInstalledRoot}/package.json`) {
      return JSON.stringify({ version: options.wslInstalledVersion ?? RUNNERIZE_VERSION });
    }
    if (command[0] === 'sh' && command[1] === '-c' && command[2].includes('command -v node')) {
      if (options.nodeAbsent) throw new Error('node missing');
      return options.nodeOutput ?? '/usr/bin/node\nv24.18.0\n';
    }
    if (command[0] === 'bash' && command[1] === '-lc' && command[2] === 'sudo -n apt-get update && sudo -n apt-get install -y podman') {
      if (options.podmanInstallFails) throw new Error('sudo: a password is required');
      return '';
    }
    if (command[0] === 'bash' && command[1] === '-c' && command[3] === 'runnerize-copy') {
      return `${command[5]}/${command[6]}.123.456`;
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
      installedNodeChecks += 1;
      if (options.installedNode === false && installedNodeChecks === 1) throw new Error('installed node missing');
      return 'v24.18.0';
    }
    return '';
  };
  const spawn = (file, args, spawnOptions = {}) => {
    calls.push({ kind: 'spawn', file, args, options: spawnOptions });
    if (file === 'whoami.exe') return { status: 0, stdout: 'DESKTOP\\ani\n', stderr: '' };
    if (file === 'wsl.exe' && args.some((arg) => String(arg).includes('exec 3<>/dev/kvm'))) {
      return { status: 0, stdout: options.kvmStatus ?? 'missing-device', stderr: '' };
    }
    if (file === 'where.exe' && args[0] === 'wsb.exe') {
      return { status: options.noWsb ? 1 : 0, stdout: options.noWsb ? '' : 'C:\\Windows\\System32\\wsb.exe\n', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, exec, spawn, options, registeredArguments, registeredActions };
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
    const serviceWithGuardStubs = {
      ...service,
      installService: (installOptions = {}) => service.installService({ installGuardOperation: async () => {}, ...installOptions }),
      uninstallService: (uninstallOptions = {}) => service.uninstallService({ uninstallGuardOperation: async () => {}, ...uninstallOptions }),
    };
    await action(serviceWithGuardStubs, harness, appData);
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

async function withMacosService({ force = false, linuxRuntime = false } = {}, action) {
  const calls = [];
  const home = mkdtempSync(join(tmpdir(), 'runnerize-macos-service-'));
  const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
  const originalGetuid = process.getuid;
  const oldToken = process.env.GH_TOKEN;
  const oldImage = process.env.RUNNERIZE_MACOS_IMAGE;
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
  process.getuid = () => 501;
  process.env.GH_TOKEN = 'test-token';
  process.env.RUNNERIZE_MACOS_IMAGE = 'registry.example/macos:1';
  const exec = (file, args, options = {}) => {
    calls.push({ kind: 'exec', file, args, options });
    if (file === 'podman') {
      if (linuxRuntime && args[0] === '--version') return 'podman 5\n';
      if (linuxRuntime && args[0] === 'pull') return 'pulled\n';
      if (linuxRuntime && args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{}]);
      const error = new Error('runtime unavailable');
      error.status = 1;
      throw error;
    }
    if (file === 'docker') {
      const error = new Error('runtime unavailable');
      error.status = 1;
      throw error;
    }
    if (file === 'tart' && args[0] === 'list') {
      return force ? JSON.stringify([{ name: 'runnerize-active' }, { name: 'other-vm' }]) : JSON.stringify([]);
    }
    if (file === 'gh' && args[0] === 'auth') return 'test-token';
    return '';
  };
  const spawn = (file, args, options = {}) => {
    calls.push({ kind: 'spawn', file, args, options });
    if (file === 'sh' || file === 'tart') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const restore = installStubs({ exec, spawn, platformName: 'darwin', home });
  try {
    const service = await freshImport('../../src/service.js');
    await action(service, calls, home);
  } finally {
    restore();
    Object.defineProperty(process, 'arch', originalArch);
    if (originalGetuid === undefined) delete process.getuid;
    else process.getuid = originalGetuid;
    rmSync(home, { recursive: true, force: true });
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
    if (oldImage === undefined) delete process.env.RUNNERIZE_MACOS_IMAGE;
    else process.env.RUNNERIZE_MACOS_IMAGE = oldImage;
  }
}

async function withLinuxService({ active = false, imageDetails, imagePullFails = false, image,
  systemdProbeFails = false, staleExecStart = false, transientMainPid = false,
  killFails = false } = {}, action) {
  const calls = [];
  const home = mkdtempSync(join(tmpdir(), 'runnerize-linux-service-'));
  const oldToken = process.env.GH_TOKEN;
  const oldImage = process.env.RUNNERIZE_LINUX_IMAGE;
  let serviceActive = active;
  let installedBin;
  let mainPidChecks = 0;
  process.env.GH_TOKEN = 'test-token';
  if (image) process.env.RUNNERIZE_LINUX_IMAGE = image;
  else delete process.env.RUNNERIZE_LINUX_IMAGE;
  const exec = (file, args, options = {}) => {
    calls.push({ kind: 'exec', file, args, options });
    if (file === 'bash' && args.includes('systemctl')) {
      assert.equal(args[0], '-c', 'systemctl does not source login profiles into captured output');
      assert.match(args[1], /XDG_RUNTIME_DIR=\/run\/user\/\$\(id -u\)/);
      assert.match(args[1], /DBUS_SESSION_BUS_ADDRESS=unix:path=\$XDG_RUNTIME_DIR\/bus/);
      const command = args.slice(3);
      if (command.includes('is-active')) {
        if (systemdProbeFails) {
          const error = new Error('Failed to connect to bus');
          error.status = 1;
          error.stderr = 'Failed to connect to bus: environment unavailable';
          throw error;
        }
        if (serviceActive) return '';
        const error = new Error('inactive');
        error.status = 3;
        throw error;
      }
      if (command.includes('kill') && killFails) {
        const error = new Error("systemctl: unrecognized option '--kill-whom=all'");
        error.status = 1;
        error.stderr = "systemctl: unrecognized option '--kill-whom=all'";
        throw error;
      }
      if (command.includes('start') || command.includes('restart')) serviceActive = true;
      if (command.includes('--property=MainPID')) {
        mainPidChecks += 1;
        return transientMainPid && mainPidChecks === 1 ? '0\n' : '4242\n';
      }
      return '';
    }
    if (file === 'systemctl' && args.includes('is-active')) {
      if (serviceActive) return '';
      const error = new Error('inactive');
      error.status = 3;
      throw error;
    }
    if (file === 'readlink' && args[0] === '-f') return process.execPath;
    if (file === 'bash' && args[1]?.includes('/proc/$1/cmdline')) {
      const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'runnerize.service'), 'utf8');
      installedBin = unit.match(/ExecStart="[^"]+" "([^"]+)"/)?.[1]
        ?.replaceAll('\\\\', '\\');
      return `${process.execPath}\0${staleExecStart ? '/home/ani/.local/share/runnerize/bin/runnerize.js' : installedBin}\0run\0`;
    }
    if (file === 'podman' && args[0] === '--version') return 'podman 5\n';
    if (file === 'podman' && args[0] === 'pull' && imagePullFails) throw new Error('pull failed');
    if (file === 'podman' && args[0] === 'image' && args[1] === 'inspect') {
      return JSON.stringify([imageDetails ?? {}]);
    }
    return '';
  };
  const spawn = (file, args, options = {}) => {
    calls.push({ kind: 'spawn', file, args, options });
    if (file === 'sh') return { status: 0, stdout: '', stderr: '' };
    if (file === 'bash' && args.some((arg) => String(arg).includes('exec 3<>/dev/kvm'))) {
      return { status: 0, stdout: 'missing-device', stderr: '' };
    }
    if (file === 'podman' && args[0] === 'info') return { status: 0, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const restore = installStubs({ exec, spawn, platformName: 'linux', home });
  try {
    const service = await freshImport('../../src/service.js');
    await action(service, calls, home);
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
    if (oldImage === undefined) delete process.env.RUNNERIZE_LINUX_IMAGE;
    else process.env.RUNNERIZE_LINUX_IMAGE = oldImage;
  }
}

test('service status distinguishes a stale installed release and reports image identity', async () => {
  await withLinuxService({
    active: true,
    imageDetails: {
      RepoDigests: ['docker.io/catthehacker/ubuntu@sha256:abc123'],
      Created: '2026-07-01T12:34:56Z',
    },
  }, async (service, _calls, home) => {
    await service.installService();
    const releases = join(home, '.local', 'share', 'runnerize-service', 'releases');
    const releaseRoot = join(releases, readdirSync(releases)[0]);
    const manifestPath = join(releaseRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = '0.6.0';
    writeFileSync(manifestPath, JSON.stringify(manifest));

    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(String(message));
    try {
      await service.serviceStatus({
        fetchImpl: async () => new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
          headers: { 'content-type': 'application/json' },
        }),
      });
    } finally {
      console.log = originalLog;
    }

    assert.ok(logs.includes(`Command package: runnerize ${RUNNERIZE_VERSION}`));
    assert.ok(logs.includes(`Latest on npm: ${RUNNERIZE_VERSION}`));
    assert.ok(logs.some((line) => /linux: installed=0\.6\.0 running=yes status=STALE/.test(line)));
    assert.ok(logs.some((line) => /Linux image: reference=docker\.io\/catthehacker\/ubuntu:full-latest runtime=podman digest=sha256:abc123 created=2026-07-01T12:34:56Z/.test(line)));
  });
});

test('service status and update use the Linux image configured in the service environment file', async () => {
  await withLinuxService({ image: 'registry.example/linux:service' }, async (service, calls, home) => {
    const environmentPath = join(home, 'runnerize.env');
    writeFileSync(environmentPath, 'RUNNERIZE_LINUX_IMAGE=registry.example/linux:service\n');
    process.env.RUNNERIZE_SYSTEMD_ENV_FILE = environmentPath;
    await service.installService();
    delete process.env.RUNNERIZE_SYSTEMD_ENV_FILE;
    delete process.env.RUNNERIZE_LINUX_IMAGE;

    const status = await service.serviceStatus({
      fetchImpl: async () => new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.equal(status.images[0].reference, 'registry.example/linux:service');

    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'me', type: 'User' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user/repos?affiliation=owner&per_page=100&page=1')) {
        return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    try {
      await service.updateService({ installVersion: async () => {} });
    } finally {
      globalThis.fetch = oldFetch;
    }
    assert.ok(calls.some((call) => call.file === 'podman'
      && call.args.join(' ') === 'pull registry.example/linux:service'));
  });
});

test('service status degrades npm latest to unknown while offline', async () => {
  await withLinuxService({}, async (service) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(String(message));
    try {
      await service.serviceStatus({ fetchImpl: async () => { throw new Error('offline'); } });
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.includes('Latest on npm: unknown (offline or unavailable)'));
  });
});

test('npm latest rejects invalid semantic versions', async () => {
  await withLinuxService({}, async (service) => {
    const response = (version) => new Response(JSON.stringify({ version }), {
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(await service.latestPublishedVersion({ fetchImpl: async () => response('01.2.3') }), null);
    assert.equal(await service.latestPublishedVersion({ fetchImpl: async () => response('1.2.3-01') }), null);
    assert.equal(await service.latestPublishedVersion({ fetchImpl: async () => response('1.2.3-beta.1') }), '1.2.3-beta.1');
  });
});

test('service status treats a stable release as newer than its prerelease', async () => {
  await withLinuxService({}, async (service, _calls, home) => {
    await service.installService();
    const releases = join(home, '.local', 'share', 'runnerize-service', 'releases');
    const manifestPath = join(releases, readdirSync(releases)[0], 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.version = '1.0.0-beta.1';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(String(message));
    try {
      await service.serviceStatus({
        fetchImpl: async () => new Response(JSON.stringify({ version: '1.0.0' }), {
          headers: { 'content-type': 'application/json' },
        }),
      });
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => /installed=1\.0\.0-beta\.1 running=yes status=STALE/.test(line)));
  });
});

test('service update refuses while a runnerize job is busy', async () => {
  await withLinuxService({}, async (service, _calls, home) => {
    await service.installService();
    const oldFetch = globalThis.fetch;
    const prefix = (await import('../../src/github.js')).runnerNamePrefix();
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'me', type: 'User' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user/repos?affiliation=owner&per_page=100&page=1')) {
        return new Response(JSON.stringify([{
          full_name: 'me/repo', private: true, fork: false, archived: false,
          owner: { login: 'me', type: 'User' },
        }]), { headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/actions/runners')) {
        return new Response(JSON.stringify({
          runners: [{ id: 1, name: `${prefix}1`, status: 'online', busy: true, labels: [] }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    let installed = false;
    try {
      await assert.rejects(
        () => service.updateService({ installVersion: async () => { installed = true; } }),
        /Refusing to update while 1 runnerize job\(s\) are active.*--force/,
      );
      assert.equal(installed, false);
      assert.ok(existsSync(join(home, '.config', 'systemd', 'user', 'runnerize.service')));
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

test('service update refreshes the image and installs npm latest when idle', async () => {
  await withLinuxService({}, async (service, calls) => {
    await service.installService();
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'me', type: 'User' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user/repos?affiliation=owner&per_page=100&page=1')) {
        return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    let installed;
    try {
      const result = await service.updateService({
        installVersion: async (version, options) => { installed = { version, options }; },
      });
      assert.deepEqual(installed, { version: RUNNERIZE_VERSION, options: { force: false } });
      assert.equal(result.imageRefreshed, true);
      assert.ok(calls.some((call) => call.kind === 'exec'
        && call.file === 'podman' && call.args.join(' ') === 'pull docker.io/catthehacker/ubuntu:full-latest'));
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

test('service update does not install when image refresh fails', async () => {
  await withLinuxService({ imagePullFails: true }, async (service) => {
    await service.installService();
    let installed = false;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'me', type: 'User' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user/repos?affiliation=owner&per_page=100&page=1')) {
        return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    try {
      await assert.rejects(
        service.updateService({ installVersion: async () => { installed = true; } }),
        /Could not refresh the configured Linux image/,
      );
      assert.equal(installed, false);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
});

test('launchd install materializes a private release and status reads its version', async () => {
  await withMacosService({}, async (service, calls, home) => {
    await service.installService();
    const agentPath = join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist');
    const plist = readFileSync(agentPath, 'utf8');
    const releases = join(home, '.local', 'share', 'runnerize-service', 'releases');
    const release = join(releases, readdirSync(releases)[0]);
    assert.ok(plist.includes(join(release, 'bin', 'runnerize.js')));
    assert.ok(calls.some((call) => call.file === 'launchctl' && call.args[0] === 'bootstrap'));

    const status = await service.serviceStatus({
      fetchImpl: async () => new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.equal(status.services[0].backend, 'macos');
    assert.equal(status.services[0].version, RUNNERIZE_VERSION);
  });
});

test('macOS service update refreshes the Linux image configured in launchd', async () => {
  await withMacosService({ linuxRuntime: true }, async (service, calls) => {
    process.env.RUNNERIZE_LINUX_IMAGE = 'registry.example/linux:macos';
    await service.installService();
    delete process.env.RUNNERIZE_LINUX_IMAGE;

    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'me', type: 'User' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/user/repos?affiliation=owner&per_page=100&page=1')) {
        return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected request: ${url}`);
    };
    try {
      await service.updateService({ installVersion: async () => {} });
    } finally {
      globalThis.fetch = oldFetch;
    }
    assert.ok(calls.some((call) => call.file === 'podman'
      && call.args.join(' ') === 'pull registry.example/linux:macos'));
  });
});

test('forced launchd install stops runnerize tart VMs before restarting', async () => {
  await withMacosService({ force: true }, async (service, calls) => {
    await service.installService({ force: true });
    assert.ok(calls.some((call) => call.file === 'tart' && call.args.join(' ') === 'stop runnerize-active'));
    assert.ok(calls.some((call) => call.file === 'tart' && call.args.join(' ') === 'delete runnerize-active'));
    assert.ok(!calls.some((call) => call.file === 'tart' && call.args.includes('other-vm') && ['stop', 'delete'].includes(call.args[0])));
  });
});

test('systemd install materializes a cache-independent package release', async () => {
  await withLinuxService({}, async (service, calls, home) => {
    await service.installService();
    const unit = readFileSync(join(home, '.config', 'systemd', 'user', 'runnerize.service'), 'utf8');
    const releases = join(home, '.local', 'share', 'runnerize-service', 'releases');
    const release = join(releases, readdirSync(releases)[0]);
    assert.ok(unit.replaceAll('\\\\', '\\').includes(join(release, 'bin', 'runnerize.js')));
    assert.match(unit, /^Delegate=yes$/m);
    assert.ok(existsSync(join(release, 'src', 'service.js')));
    assert.ok(existsSync(join(release, 'package.json')));
  });
});

test('systemd reinstall creates a new immutable release and restarts an active dispatcher', async () => {
  await withLinuxService({ active: true }, async (service, calls, home) => {
    await service.installService();
    const releases = join(home, '.local', 'share', 'runnerize-service', 'releases');
    const firstRelease = readdirSync(releases)[0];

    await service.installService();

    const installed = readdirSync(releases);
    assert.equal(installed.length, 2);
    assert.ok(installed.includes(firstRelease));
    assert.ok(calls.some((call) => call.file === 'bash'
      && call.args.slice(3).join(' ') === 'systemctl --user restart runnerize.service'));
    assert.ok(!calls.some((call) => call.file === 'bash'
      && call.args.slice(3).join(' ') === 'systemctl --user start runnerize.service'));
  });
});

test('a failed force-kill does not abort the install; the restart still runs', async () => {
  // systemd < 252 rejects --kill-whom, which once turned a cosmetic incompatibility
  // into linux=unavailable and left the old dispatcher running.
  await withLinuxService({ active: true, killFails: true }, async (service, calls) => {
    await service.installService({ force: true });
    assert.ok(calls.some((call) => call.file === 'bash'
      && call.args.slice(3).join(' ') === 'systemctl --user restart runnerize.service'));
  });
});

test('systemd first install starts without restarting', async () => {
  await withLinuxService({}, async (service, calls) => {
    await service.installService();
    assert.ok(calls.some((call) => call.file === 'bash'
      && call.args.slice(3).join(' ') === 'systemctl --user start runnerize.service'));
    assert.ok(!calls.some((call) => call.file === 'bash'
      && call.args.slice(3).join(' ') === 'systemctl --user restart runnerize.service'));
  });
});

test('systemd install treats a failed user-bus probe as an error, not inactive', async () => {
  await withLinuxService({ systemdProbeFails: true }, async (service, calls, home) => {
    await assert.rejects(
      () => service.installService(),
      /Could not determine whether runnerize\.service is active: Failed to connect to bus/,
    );
    assert.equal(existsSync(join(home, '.config', 'systemd', 'user', 'runnerize.service')), false);
    assert.ok(!calls.some((call) => call.file === 'bash'
      && call.args.slice(3).includes('start')));
  });
});

test('systemd install retries while the restarted unit is acquiring its MainPID', async () => {
  await withLinuxService({ transientMainPid: true }, async (service, calls) => {
    await service.installService();
    const mainPidChecks = calls.filter((call) => call.file === 'bash'
      && call.args.includes('--property=MainPID'));
    assert.equal(mainPidChecks.length, 2);
  });
});

test('systemd install fails when the running process still uses a stale ExecStart', async () => {
  await withLinuxService({ staleExecStart: true }, async (service) => {
    await assert.rejects(
      () => service.installService(),
      /did not start the intended executable.*runnerize\.js.*PID 4242 is running.*\.local\/share\/runnerize\/bin\/runnerize\.js/,
    );
  });
});

test('systemd uninstall removes private package releases', async () => {
  await withLinuxService({}, async (service, _calls, home) => {
    await service.installService();
    const installation = join(home, '.local', 'share', 'runnerize-service');
    assert.ok(existsSync(installation));

    await service.uninstallService();

    assert.equal(existsSync(installation), false);
  });
});

test('Windows status reports independent WSL and native installed versions', async () => {
  await withWindowsService({
    wslInstalledRoot: '/home/ani/.local/share/runnerize-service/releases/0.6.0.1',
    wslInstalledVersion: '0.6.0',
    windowsTaskRunning: true,
  }, async (service, _harness, appData) => {
    const nativeRoot = join(appData, 'runnerize', 'releases', '0.7.0.1');
    mkdirSync(nativeRoot, { recursive: true });
    writeFileSync(join(nativeRoot, 'package.json'), JSON.stringify({ version: '0.7.0' }));
    mkdirSync(join(appData, 'runnerize'), { recursive: true });
    writeFileSync(join(appData, 'runnerize', 'current-release'), nativeRoot);

    const status = await service.serviceStatus({
      fetchImpl: async () => new Response(JSON.stringify({ version: RUNNERIZE_VERSION }), {
        headers: { 'content-type': 'application/json' },
      }),
    });
    assert.deepEqual(status.services.map(({ backend, version, running }) => ({ backend, version, running })), [
      { backend: 'linux (WSL Ubuntu)', version: '0.6.0', running: true },
      { backend: 'windows', version: '0.7.0', running: true },
    ]);
  });
});

test('Windows install skips docker-desktop, reuses PATH Node, and delegates service install', async () => {
  await withWindowsService({ installedNode: false }, async (service, harness, appData) => {
    await service.installService();
    const whoami = harness.calls.find((call) => commandOf(call)[0] === 'whoami');
    assert.ok(whoami.args.includes('Ubuntu'));
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command[0] === 'bash' && command[1] === '-c'
        && command.includes('/usr/bin/node')
        && command.some((value) => String(value).startsWith('/home/ani/.local/share/runnerize-service/releases/'))
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
    const installedRoot = readFileSync(join(appData, 'runnerize', 'current-release'), 'utf8');
    assert.ok(installedRoot.startsWith(join(appData, 'runnerize', 'releases')));
    assert.ok(existsSync(join(installedRoot, 'bin', 'runnerize.js')));
  });
});

test('Windows reinstall never hard-stops an active dispatcher task', async () => {
  await withWindowsService({ windowsTaskRunning: true }, async (service, harness) => {
    await service.installService();
    assert.ok(!harness.calls.some((call) => call.args.at(-1)?.includes('Stop-ScheduledTask')),
      'Task Scheduler stop would bypass graceful drain');
  });
});

test('Windows first install does not restart an inactive dispatcher task', async () => {
  await withWindowsService({}, async (service, harness) => {
    await service.installService();
    assert.ok(!harness.calls.some((call) => call.args.at(-1)?.includes("Stop-ScheduledTask -TaskName 'runnerize-windows'")));
  });
});

test('Windows update restarts the native task after installing its replacement', async () => {
  await withWindowsService({ windowsTaskRunning: true }, async (service, harness) => {
    await service.installService();
    harness.calls.length = 0;
    await service.installService({ update: true });
    const taskCommands = harness.calls
      .filter((call) => call.file.toLowerCase().endsWith('powershell.exe'))
      .map((call) => call.args.at(-1));
    const stop = taskCommands.findIndex((command) => command.includes("Stop-ScheduledTask -TaskName 'runnerize-windows'"));
    const register = taskCommands.findIndex((command) => command.includes("$taskName = 'runnerize-windows'") && command.includes('Register-ScheduledTask'));
    const start = taskCommands.findIndex((command) => command.includes("Start-ScheduledTask -TaskName 'runnerize-windows'"));
    assert.ok(stop >= 0 && register > stop && start > register);
  });
});

test('Windows update fails if an installed native backend cannot restart', async () => {
  await withWindowsService({ windowsTaskRunning: true }, async (service, harness) => {
    await service.installService();
    harness.options.startTaskFails = true;
    await assert.rejects(service.installService({ update: true }), /Could not update every installed runnerize backend: windows/);
  });
});

test('Windows update restores an inactive native task registration when startup fails', async () => {
  await withWindowsService({ recordRegisteredArguments: true }, async (service, harness, appData) => {
    await service.installService();
    const previousRoot = readFileSync(join(appData, 'runnerize', 'current-release'), 'utf8');
    harness.options.startTaskFailsOnce = true;

    await assert.rejects(service.installService({ update: true }), /Could not update every installed runnerize backend: windows/);

    assert.equal(readFileSync(join(appData, 'runnerize', 'current-release'), 'utf8'), previousRoot);
    assert.equal(harness.registeredActions.get('runnerize-windows'), true);
    const registrations = harness.calls.filter((call) => call.file.toLowerCase().endsWith('powershell.exe')
      && call.args.at(-1).includes("$taskName = 'runnerize-windows'")
      && call.args.at(-1).includes('Register-ScheduledTask'));
    assert.ok(registrations.length >= 3, 'initial, replacement, and rollback task registrations run');
    const restoredBin = join(previousRoot, 'bin', 'runnerize.js');
    assert.ok(readFileSync(join(appData, 'runnerize', 'runnerize-windows.ps1'), 'utf8').includes(restoredBin));
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

test('preflight reports KVM permission remediation without applying it', async () => {
  await withWindowsService({ kvmStatus: 'permission-denied' }, async (service, harness) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(String(message));
    try {
      const result = await service.preflightRun();
      assert.equal(result.kvm.status, 'permission-denied');
      assert.equal(result.kvm.usable, false);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.includes('KVM capability: permission-denied')));
    assert.ok(logs.some((line) => line.includes('sudo usermod -aG kvm "$USER"')));
    assert.ok(logs.some((line) => line.includes('restart WSL')));
    assert.ok(logs.some((line) => line.includes('wsl.exe --shutdown')));
    assert.ok(!harness.calls.some((call) => commandOf(call)[0] === 'sudo'));
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

test('Windows install auto-installs WSL and stops cleanly for a restart when no distro exists', async () => {
  await withWindowsService({ distros: '', noWsb: true }, async (service, harness) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(message);
    try {
      await service.installService();
    } finally {
      console.log = originalLog;
    }
    const elevated = harness.calls.find((call) => call.file.toLowerCase().endsWith('powershell.exe')
      && call.args.at(-1).includes('Start-Process'));
    const encoded = elevated.args.at(-1).match(/-EncodedCommand','([^']+)'/)[1];
    assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /wsl --install -d Ubuntu/);
    assert.ok(logs.some((line) => /Administrator access is needed to install WSL2 and Ubuntu/.test(line)));
    assert.ok(logs.some((line) => /A UAC prompt will appear/.test(line)));
    assert.ok(logs.some((line) => line.trim() === 'Restart required'));
    assert.ok(logs.some((line) => /npx runnerize service install/.test(line)));
    assert.ok(!harness.calls.some((call) => call.args.at(-1)?.includes('Register-ScheduledTask')));
  });
});

test('Windows install auto-enables Sandbox on Windows 11 24H2 and stops for a restart', async () => {
  await withWindowsService({ noWsb: true, windowsBuild: 26100 }, async (service, harness) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(message);
    try {
      await service.installService();
    } finally {
      console.log = originalLog;
    }
    const elevated = harness.calls.find((call) => call.file.toLowerCase().endsWith('powershell.exe')
      && call.args.at(-1).includes('Start-Process'));
    const encoded = elevated.args.at(-1).match(/-EncodedCommand','([^']+)'/)[1];
    assert.match(Buffer.from(encoded, 'base64').toString('utf16le'), /Enable-WindowsOptionalFeature[^\r\n]+Containers-DisposableClientVM/);
    assert.ok(logs.some((line) => /Administrator access is needed to enable the Windows Sandbox feature/.test(line)));
    assert.ok(logs.some((line) => /A UAC prompt will appear/.test(line)));
    assert.ok(logs.some((line) => line.trim() === 'Restart required'));
    assert.ok(!harness.calls.some((call) => call.args.at(-1)?.includes('Register-ScheduledTask')));
  });
});

test('Windows install keeps Linux available when Sandbox needs a newer Windows build', async () => {
  await withWindowsService({ noWsb: true, windowsBuild: 26000 }, async (service, harness) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(message);
    try {
      await service.installService();
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => /requires Windows 11 24H2 \(build 26100\)/.test(line)));
    assert.ok(harness.calls.some((call) => call.args.at(-1)?.includes("$taskName = 'runnerize'")));
    assert.ok(!harness.calls.some((call) => call.args.at(-1)?.includes('Enable-WindowsOptionalFeature')));
  });
});

test('Windows install prints an ordered GitHub login fallback when no native credential exists', async () => {
  await withWindowsService({ noGh: true, noWsb: true }, async (service) => {
    const logs = [];
    const originalLog = console.log;
    console.log = (message = '') => logs.push(message);
    try {
      await assert.rejects(service.installService(), /GitHub authentication is not available/);
    } finally {
      console.log = originalLog;
    }
    assert.ok(logs.some((line) => line.trim() === 'Manual steps'));
    assert.ok(logs.some((line) => line === '   gh auth login'));
  });
});

test('Windows install reuses the durable Node without downloading on reinstall', async () => {
  await withWindowsService({}, async (service, harness) => {
    await service.installService();
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command[0] === '/home/ani/.local/share/runnerize/node/v24.18.0/bin/node'
        && command[1] === '--version';
    }));
    assert.ok(!harness.calls.some((call) => commandOf(call)[2]?.includes('sha256sum -c')));
    assert.ok(harness.calls.some((call) => commandOf(call).includes('/home/ani/.local/share/runnerize/node/v24.18.0/bin/node')));
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command[0] === 'rm' && command[1] === '-rf'
        && command[2] === '/home/ani/.cache/runnerize/node';
    }), 'removes the legacy disposable Node copy after service verification');
  });
});

test('Windows install migrates a valid legacy Node into durable storage', async () => {
  await withWindowsService({ installedNode: false, legacyNode: true }, async (service, harness) => {
    await service.installService();
    const migration = harness.calls.find((call) => {
      const command = commandOf(call);
      return command[0] === 'sh' && command[3] === 'runnerize-node-migrate';
    });
    assert.ok(migration, 'the legacy cache location is checked for migration');
    assert.ok(migration.args.includes('/home/ani/.cache/runnerize/node/v24.18.0'));
    assert.ok(migration.args.includes('/home/ani/.local/share/runnerize/node/v24.18.0'));
    assert.ok(!harness.calls.some((call) => commandOf(call)[2]?.includes('sha256sum -c')));
    assert.ok(harness.calls.some((call) => commandOf(call).includes('/home/ani/.local/share/runnerize/node/v24.18.0/bin/node')));
  });
});

test('Windows install persists a Windows token and downloads pinned Node when absent', async () => {
  await withWindowsService({ noGh: true, token: 'test-token', nodeAbsent: true, installedNode: false }, async (service, harness) => {
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
  await withWindowsService({ nodeOutput: '/opt/node-v20/bin/node\nv16.20.2\n', installedNode: false }, async (service, harness) => {
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
  await withWindowsService({ noGh: true, nodeAbsent: true, installedNode: false, noWsb: true }, async (service, harness) => {
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

test('Windows install applies the host-stability guard by default', async () => {
  await withWindowsService({}, async (service) => {
    const calls = [];
    await service.installService({
      elevationTimeoutMs: 1234,
      installGuardOperation: async (options) => calls.push(options),
    });
    assert.deepEqual(calls, [{ elevationTimeoutMs: 1234 }]);
  });
});

test('Windows install skips the host-stability guard with --no-guard', async () => {
  await withWindowsService({}, async (service) => {
    let called = false;
    await service.installService({
      noGuard: true,
      installGuardOperation: async () => { called = true; },
    });
    assert.equal(called, false);
  });
});

test('Windows install prints the guard manual step without elevation', async () => {
  await withWindowsService({}, async (service) => {
    const logs = [];
    const originalLog = console.log;
    let called = false;
    console.log = (message = '') => logs.push(message);
    try {
      await service.installService({
        noElevate: true,
        installGuardOperation: async () => { called = true; },
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(called, false);
    assert.ok(logs.some((line) => line.trim() === 'Host-stability guard (recommended on a Hyper-V guest)'));
    assert.ok(logs.some((line) => line === '   runnerize guard install'));
  });
});

test('Windows uninstall removes the host-stability guard by default', async () => {
  await withWindowsService({}, async (service) => {
    const calls = [];
    await service.uninstallService({
      elevationTimeoutMs: 1234,
      uninstallGuardOperation: async (options) => calls.push(options),
    });
    assert.deepEqual(calls, [{ elevationTimeoutMs: 1234 }]);
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
      return command.includes('systemctl') && command.includes('disable') && command.includes('--now')
        && command[2]?.includes('XDG_RUNTIME_DIR');
    }));
    assert.ok(harness.calls.some((call) => commandOf(call).includes('disable-linger')));
    assert.ok(harness.calls.some((call) => {
      const command = commandOf(call);
      return command[0] === 'rm' && command.includes('/home/ani/.local/share/runnerize-service');
    }));
    assert.ok(harness.calls.some((call) => call.file.toLowerCase().endsWith('powershell.exe') && call.args.at(-1).includes('Unregister-ScheduledTask')));
  });
});
