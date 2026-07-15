import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { freshImport } from '../helpers/fresh-module.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const os = require('node:os');

async function withWindowsService(spawnImpl, callback) {
  const root = mkdtempSync(join(tmpdir(), 'runnerize-service-'));
  const originalSpawnSync = childProcess.spawnSync;
  const originalPlatform = os.platform;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  const originalAppData = process.env.APPDATA;
  const originalUsername = process.env.USERNAME;
  const originalUserDomain = process.env.USERDOMAIN;
  const calls = [];

  process.env.LOCALAPPDATA = join(root, 'Local');
  process.env.APPDATA = join(root, 'Roaming');
  process.env.USERNAME = 'testuser';
  process.env.USERDOMAIN = 'TESTDOMAIN';
  os.platform = () => 'win32';
  childProcess.spawnSync = (file, args = [], options = {}) => {
    calls.push({ file, args, options });
    if (file === 'whoami.exe') return { status: 0, stdout: 'TESTDOMAIN\\testuser\r\n', stderr: '' };
    return spawnImpl(file, args, options, calls);
  };
  syncBuiltinESMExports();

  try {
    const service = await freshImport('../../src/service.js');
    await callback({ service, calls, root });
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    os.platform = originalPlatform;
    syncBuiltinESMExports();
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalUsername === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = originalUsername;
    if (originalUserDomain === undefined) delete process.env.USERDOMAIN;
    else process.env.USERDOMAIN = originalUserDomain;
    rmSync(root, { recursive: true, force: true });
  }
}

const success = () => ({ status: 0, stdout: '', stderr: '' });

test('Windows install registers and starts a Task Scheduler task', async () => {
  await withWindowsService(success, async ({ service, calls, root }) => {
    await service.installService();

    const powershell = calls.find((call) => call.file === 'powershell.exe');
    assert.ok(powershell, 'invoked PowerShell');
    const script = powershell.args.at(-1);
    assert.match(script, /Register-ScheduledTask/);
    assert.match(script, /New-ScheduledTaskTrigger -AtLogOn -User \$user/);
    assert.match(script, /-LogonType Interactive -RunLevel Limited/);
    assert.match(script, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
    assert.match(script, /-MultipleInstances IgnoreNew/);
    assert.match(script, /Start-ScheduledTask/);

    const launcher = readFileSync(join(root, 'Local', 'runnerize', 'runnerize-launch.cmd'), 'utf8');
    assert.match(launcher, /cd \/d /);
    assert.match(launcher, /runnerize\.js" run >> /);
    assert.match(launcher, /runnerize\.log" 2>&1/);
  });
});

test('Windows install falls back to the Startup folder when task registration is denied', async () => {
  for (const message of [
    'Register-ScheduledTask: Access is denied. (0x80070005)',
    'Register-ScheduledTask: A required privilege is not held by the client.',
  ]) {
    const denied = (file) => file === 'powershell.exe'
      ? { status: 1, stdout: '', stderr: message }
      : success();

    await withWindowsService(denied, async ({ service, root }) => {
      await assert.doesNotReject(() => service.installService());

      const launcherPath = join(root, 'Local', 'runnerize', 'runnerize-launch.cmd');
      const startupPath = join(
        root,
        'Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
        'runnerize.vbs',
      );
      assert.match(readFileSync(launcherPath, 'utf8'), /runnerize\.js" run/);
      const vbs = readFileSync(startupPath, 'utf8');
      assert.match(vbs, /CreateObject\("WScript\.Shell"\)\.Run/);
      assert.match(vbs, /, 0, False/);
      assert.match(vbs, /runnerize-launch\.cmd/);
    });
  }
});

test('Windows install surfaces non-privilege Task Scheduler failures', async () => {
  const failure = (file) => file === 'powershell.exe'
    ? { status: 1, stdout: '', stderr: 'Register-ScheduledTask: The RPC server is unavailable.' }
    : success();

  await withWindowsService(failure, async ({ service }) => {
    await assert.rejects(() => service.installService(), /RPC server is unavailable/);
  });
});

test('Windows uninstall removes both Task Scheduler and Startup launchers', async () => {
  await withWindowsService(success, async ({ service, calls, root }) => {
    const launcherPath = join(root, 'Local', 'runnerize', 'runnerize-launch.cmd');
    const startupPath = join(
      root,
      'Roaming',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'runnerize.vbs',
    );
    mkdirSync(join(root, 'Local', 'runnerize'), { recursive: true });
    mkdirSync(join(root, 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true });
    writeFileSync(launcherPath, 'launcher');
    writeFileSync(startupPath, 'startup');

    await service.uninstallService();

    const powershell = calls.find((call) => call.file === 'powershell.exe');
    assert.match(powershell.args.at(-1), /Unregister-ScheduledTask -Confirm:\$false/);
    assert.throws(() => readFileSync(launcherPath), /ENOENT/);
    assert.throws(() => readFileSync(startupPath), /ENOENT/);
  });
});
