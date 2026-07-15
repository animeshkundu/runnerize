import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const exec = (file, args, execOptions = {}) => {
    calls.push({ kind: 'exec', file, args, options: execOptions });
    if (file !== 'wsl.exe') return '';
    if (args[0] === '--status') return options.status ?? 'Default Distribution: Ubuntu\r\n';
    if (args[0] === '-l') return options.distros ?? 'docker-desktop\0\r\nUbuntu\0\r\n';
    const command = args.slice(args.indexOf('-e') + 1);
    if (command[0] === 'whoami') return 'ani\n';
    if (command[0] === 'ps') return options.noSystemd ? 'init' : 'systemd';
    if (command[0] === 'sh' && command.includes('printf %s "$HOME"')) return '/home/ani';
    if (command[0] === 'sh' && command[1] === '-c' && command[2].includes('command -v node')) {
      if (options.nodeAbsent) throw new Error('node missing');
      return options.nodeOutput ?? '/usr/bin/node\nv24.18.0\n';
    }
    if (command[0] === 'podman') {
      if (options.noRuntime) throw new Error('podman missing');
      return 'host: podman';
    }
    if (command[0] === 'docker') {
      if (options.noRuntime) throw new Error('docker missing');
      throw new Error('docker missing');
    }
    if (command[0] === 'gh') {
      if (options.noGh) throw new Error('not authenticated');
      return 'Logged in';
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
    if (file === 'powershell.exe') {
      if (options.accessDenied) return { status: 1, stdout: '', stderr: 'Access is denied' };
      return { status: 0, stdout: '', stderr: '' };
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
  process.env.APPDATA = appData;
  if (options.token) process.env.GH_TOKEN = options.token;
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
  }
}

function commandOf(call) {
  return call.args.slice(call.args.indexOf('-e') + 1);
}

test('Windows install skips docker-desktop, reuses PATH Node, and delegates service install', async () => {
  await withWindowsService({ cachedNode: false }, async (service, harness) => {
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
    const task = harness.calls.find((call) => call.file === 'powershell.exe');
    assert.match(task.args.at(-1), /New-ScheduledTaskTrigger -AtLogOn/);
    assert.match(task.args.at(-1), /-d "Ubuntu" -u "ani"/);
    assert.match(task.args.at(-1), /systemctl --user start runnerize/);
  });
});

test('Windows install fails when WSL has no container runtime', async () => {
  await withWindowsService({ noRuntime: true }, async (service) => {
    await assert.rejects(service.installService(), /Install rootless Podman inside WSL/);
  });
});

test('Windows install fails when WSL GitHub auth and token are unavailable', async () => {
  await withWindowsService({ noGh: true }, async (service) => {
    await assert.rejects(service.installService(), /gh auth login/);
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

test('Windows install fails actionably when systemd is unavailable', async () => {
  await withWindowsService({ noSystemd: true }, async (service) => {
    await assert.rejects(service.installService(), /Enable it in \/etc\/wsl\.conf/);
  });
});

test('Windows install falls back to a hidden Startup launcher on Task Scheduler access denied', async () => {
  await withWindowsService({ accessDenied: true }, async (service, _harness, appData) => {
    await service.installService();
    const startup = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs');
    const launcher = readFileSync(startup, 'utf8');
    assert.match(launcher, /wsl\.exe/);
    assert.match(launcher, /systemctl --user start runnerize/);
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
    assert.ok(harness.calls.some((call) => call.file === 'powershell.exe' && call.args.at(-1).includes('Unregister-ScheduledTask')));
  });
});
