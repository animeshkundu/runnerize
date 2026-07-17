import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createGuardLease,
  guardStatus,
  installGuard,
  isHyperVGuest,
  readLiveLeases,
  reconcileShutdownGuard,
  runGuardRecover,
  shutdownGuardInstallScript,
  uninstallGuard,
} from '../../src/guard.js';

function spawnStub({ stdout = '', stderr = '', status = 0 } = {}) {
  const calls = [];
  const spawnChild = (file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', status);
    });
    return child;
  };
  return { calls, spawnChild };
}

function logsDuring(action) {
  const logs = [];
  const originalLog = console.log;
  console.log = (message = '') => logs.push(message);
  return Promise.resolve()
    .then(action)
    .then(() => logs)
    .finally(() => { console.log = originalLog; });
}

function hyperVOptions(overrides = {}) {
  return {
    platformName: 'win32',
    spawnChild: spawnStub({ stdout: 'true' }).spawnChild,
    ...overrides,
  };
}

test('isHyperVGuest captures the CIM probe and recognizes true and false', async () => {
  const yes = spawnStub({ stdout: 'true' });
  assert.equal(await isHyperVGuest({ platformName: 'win32', spawnChild: yes.spawnChild }), true);
  assert.equal(yes.calls.length, 1);
  assert.deepEqual(yes.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.match(yes.calls[0].args.at(-1), /Get-CimInstance Win32_ComputerSystem/);
  assert.match(yes.calls[0].args.at(-1), /Model -eq 'Virtual Machine'/);
  assert.match(yes.calls[0].args.at(-1), /Manufacturer -like '\*Microsoft\*'/);
  assert.match(yes.calls[0].args.at(-1), /HypervisorPresent/);

  const no = spawnStub({ stdout: 'false' });
  assert.equal(await isHyperVGuest({ platformName: 'win32', spawnChild: no.spawnChild }), false);
  assert.equal(await isHyperVGuest({ platformName: 'linux', spawnChild: () => { throw new Error('not called'); } }), false);
});

test('Tier-1 install captures prior state then applies Windows Update policy and power settings once', async () => {
  const elevated = [];
  await installGuard(hyperVOptions({
    statePath: 'C:\\ProgramData\\runnerize\\guard\\tier1-state.json',
    activeHours: '7-1',
    runElevatedOperation: async (operation, script) => {
      elevated.push({ operation, script });
      return { ok: true };
    },
  }));
  assert.equal(elevated.length, 1, 'all Tier-1 writes share one UAC elevation');
  const script = elevated[0].script;
  assert.match(script, /Test-Path -LiteralPath \$statePath/);
  assert.match(script, /GetValueKind/);
  assert.match(script, /existed = \$false/);
  assert.match(script, /hibernateOn = \$hibernateOn/);
  assert.ok(script.indexOf('ConvertTo-Json') < script.indexOf("NoAutoRebootWithLoggedOnUsers' -PropertyType DWord -Value 1"));
  assert.match(script, /WindowsUpdate\\AU/);
  assert.match(script, /NoAutoRebootWithLoggedOnUsers' -PropertyType DWord -Value 1/);
  assert.match(script, /SetActiveHours' -PropertyType DWord -Value 1/);
  assert.match(script, /ActiveHoursStart' -PropertyType DWord -Value 7/);
  assert.match(script, /ActiveHoursEnd' -PropertyType DWord -Value 1/);
  assert.match(script, /powercfg\.exe \/hibernate off/);
});

test('Tier-1 uninstall restores present values, deletes originally absent values, and hibernates conditionally', async () => {
  let script;
  await uninstallGuard(hyperVOptions({
    stateExists: () => true,
    statePath: 'C:\\ProgramData\\runnerize\\guard\\tier1-state.json',
    runElevatedOperation: async (_operation, command) => {
      script = command;
      return { ok: true };
    },
  }));
  assert.match(script, /if \(\$setting\.existed\)/);
  assert.match(script, /Saved guard state is missing/);
  assert.match(script, /Saved guard state has an invalid registry kind/);
  assert.match(script, /New-ItemProperty -Path \$target\.path -Name \$target\.name -PropertyType \$setting\.kind -Value \$setting\.data -Force/);
  assert.match(script, /Remove-ItemProperty -LiteralPath \$target\.path -Name \$target\.name/);
  assert.match(script, /if \(\$state\.hibernateOn\)/);
  assert.match(script, /powercfg\.exe \/hibernate on/);
  assert.match(script, /Remove-Item -LiteralPath \$statePath/);
});

test('uninstall without saved state is idempotent and does not elevate', async () => {
  let elevated = false;
  const logs = await logsDuring(() => uninstallGuard(hyperVOptions({
    stateExists: () => false,
    runElevatedOperation: async () => { elevated = true; return { ok: true }; },
  })));
  assert.equal(elevated, false);
  assert.ok(logs.some((line) => /nothing to restore/.test(line)));
});

test('install and uninstall NOOP outside Windows and outside Hyper-V', async () => {
  let elevated = false;
  const operation = async () => { elevated = true; return { ok: true }; };
  const nonWindows = await logsDuring(() => installGuard({ platformName: 'linux', runElevatedOperation: operation }));
  const physical = await logsDuring(() => uninstallGuard({
    platformName: 'win32',
    spawnChild: spawnStub({ stdout: 'false' }).spawnChild,
    runElevatedOperation: operation,
  }));
  assert.equal(elevated, false);
  assert.ok(nonWindows.some((line) => /NOOP/.test(line)));
  assert.ok(physical.some((line) => /NOOP/.test(line)));
});

test('--shutdown-guard installs Tier-1 and the SYSTEM startup watchdog in one elevation', async () => {
  let command;
  await installGuard(hyperVOptions({
    shutdownGuard: true,
    runElevatedOperation: async (_operation, script) => { command = script; return { ok: true }; },
  }));
  assert.match(command, /NoAutoRebootWithLoggedOnUsers/);
  assert.match(command, /runnerize-guard-watch/);
  const taskScripts = [...command.matchAll(/-EncodedCommand '([^']+)'/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString('utf16le'));
  const registration = taskScripts.find((script) => /runnerize-guard-watch/.test(script));
  assert.ok(registration);
  assert.match(registration, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(registration, /LogonType ServiceAccount -RunLevel Highest/);
  assert.match(registration, /RestartCount 999/);
  assert.match(registration, /NT AUTHORITY\\SYSTEM/);
  assert.match(command, /CREATOR OWNER/);
  assert.match(command, /Authenticated Users/);
});

test('SYSTEM task script uses startup, highest service-account principals', () => {
  const script = shutdownGuardInstallScript({
    guardRoot: 'C:\\ProgramData\\runnerize\\guard',
    leasesPath: 'C:\\ProgramData\\runnerize\\guard\\leases',
    shutdownStatePath: 'C:\\ProgramData\\runnerize\\guard\\state.json',
    guardAppRoot: 'C:\\ProgramData\\runnerize\\guard\\app',
    packageRoot: 'C:\\runnerize',
  });
  const taskScripts = [...script.matchAll(/-EncodedCommand '([^']+)'/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString('utf16le'));
  const registration = taskScripts.find((value) => /runnerize-guard-watch/.test(value));
  assert.ok(registration);
  assert.match(registration, /-AtStartup/);
  assert.match(registration, /-LogonType ServiceAccount -RunLevel Highest/);
  assert.match(registration, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(registration, /RestartInterval \(New-TimeSpan -Minutes 1\) -RestartCount 999/);
  assert.ok(!taskScripts.some((value) => /Register-ScheduledTask.*runnerize-guard-recover/.test(value)));
  assert.ok(script.indexOf('Set-Acl -LiteralPath') < script.indexOf("Copy-Item -LiteralPath 'C:\\runnerize\\bin'"));
  assert.match(script, /Set-Acl -LiteralPath 'C:\\ProgramData\\runnerize\\guard\\app' -AclObject \$appAcl/);
});

test('shutdown uninstall stops tasks before restoring and deleting state', async () => {
  let script;
  await uninstallGuard(hyperVOptions({
    shutdownGuard: true,
    stateExists: () => false,
    shutdownStatePath: 'C:\\ProgramData\\runnerize\\guard\\state.json',
    runElevatedOperation: async (_operation, command) => { script = command; return { ok: true }; },
  }));
  const taskCommand = [...script.matchAll(/-EncodedCommand '([^']+)'/g)]
    .map((match) => Buffer.from(match[1], 'base64').toString('utf16le'))
    .find((command) => /Stop-ScheduledTask/.test(command));
  const tasks = taskCommand ? script.indexOf('-EncodedCommand') : -1;
  const restore = script.indexOf("Set-Service -Name 'vmicshutdown'");
  const remove = script.indexOf("Remove-Item -LiteralPath 'C:\\ProgramData\\runnerize\\guard\\state.json'");
  assert.ok(tasks >= 0 && tasks < restore && restore < remove);
});

test('reference-count reconcile snapshots on first acquire, enforces, and restores on last release', async () => {
  let leases = [{ version: 1, sessionId: '11111111-1111-1111-1111-111111111111', heartbeat: 100 }];
  let state = JSON.stringify({ version: 1, service: null });
  const calls = [];
  const options = {
    now: 100,
    leasesPath: 'leases',
    shutdownStatePath: 'state.json',
    readdir: () => leases.map((lease) => `${lease.sessionId}.json`),
    open: (path) => path,
    fstat: () => ({ isFile: () => true }),
    close: () => {},
    readFile: (path) => path === 'state.json' ? state : JSON.stringify(leases.find((lease) => path.includes(lease.sessionId))),
    writeFile: (_path, value) => { state = value; },
    rename: () => {},
    service: {
      inspect: async () => { calls.push('inspect'); return { startupType: 'Manual', wasRunning: true }; },
      disable: async () => { calls.push('disable'); },
      restore: async (snapshot) => { calls.push(['restore', snapshot]); },
    },
  };
  await reconcileShutdownGuard(options);
  assert.deepEqual(calls, ['inspect', 'disable']);
  assert.deepEqual(JSON.parse(state).service, { startupType: 'Manual', wasRunning: true });
  await reconcileShutdownGuard(options);
  assert.deepEqual(calls, ['inspect', 'disable', 'disable'], 'additional leases never overwrite the snapshot');
  leases = [];
  await reconcileShutdownGuard(options);
  assert.deepEqual(calls.at(-1), ['restore', { startupType: 'Manual', wasRunning: true }]);
  assert.equal(JSON.parse(state).service, null);
});

test('reconcile refuses a Disabled first snapshot', async () => {
  await assert.rejects(() => reconcileShutdownGuard({
    now: 100,
    leasesPath: 'leases',
    shutdownStatePath: 'state.json',
    readdir: () => ['11111111-1111-1111-1111-111111111111.json'],
    open: (path) => path,
    fstat: () => ({ isFile: () => true }),
    close: () => {},
    readFile: (path) => path === 'state.json'
      ? JSON.stringify({ version: 1, service: null })
      : JSON.stringify({ version: 1, sessionId: '11111111-1111-1111-1111-111111111111', heartbeat: 100 }),
    service: {
      inspect: async () => ({ startupType: 'Disabled', wasRunning: false }),
      disable: async () => { throw new Error('not called'); },
    },
  }), /Refusing to snapshot/);
});

test('stale and malformed leases are reaped and trigger restoration', async () => {
  const removed = [];
  const files = new Map([
    ['11111111-1111-1111-1111-111111111111.json', JSON.stringify({ version: 1, sessionId: '11111111-1111-1111-1111-111111111111', heartbeat: 1 })],
    ['22222222-2222-2222-2222-222222222222.json', '{bad'],
  ]);
  const options = {
    now: 100,
    leaseTimeoutMs: 20,
    leasesPath: 'leases',
    readdir: () => [...files.keys()],
    open: (path) => path,
    fstat: () => ({ isFile: () => true }),
    close: () => {},
    readFile: (path) => files.get(path.split(/[\\/]/).at(-1)),
    unlink: (path) => removed.push(path),
  };
  assert.deepEqual(readLiveLeases(options), []);
  assert.equal(removed.length, 2);
});

test('guard recovery waits for grace then reconciles pending state', async () => {
  const events = [];
  let state = JSON.stringify({ version: 1, service: { startupType: 'Automatic', wasRunning: true } });
  await runGuardRecover(hyperVOptions({
    delay: async (ms) => events.push(['delay', ms]),
    recoveryGraceMs: 123,
    shutdownStatePath: 'state.json',
    leasesPath: 'leases',
    readdir: () => [],
    readFile: () => state,
    writeFile: (_path, value) => { state = value; },
    rename: () => {},
    service: {
      inspect: async () => { throw new Error('not called'); },
      disable: async () => { throw new Error('not called'); },
      restore: async (value) => events.push(['restore', value]),
    },
  }));
  assert.deepEqual(events, [
    ['delay', 123],
    ['restore', { startupType: 'Automatic', wasRunning: true }],
  ]);
  assert.equal(JSON.parse(state).service, null);
});

test('non-elevated lease heartbeat uses one owned file and releases it', async () => {
  const writes = [];
  const removed = [];
  let heartbeat;
  const lease = await createGuardLease(hyperVOptions({
    sessionId: '11111111-1111-1111-1111-111111111111',
    guardRoot: 'C:\\ProgramData\\runnerize\\guard',
    leasesPath: 'C:\\ProgramData\\runnerize\\guard\\leases',
    now: () => 42,
    mkdir: () => {},
    writeFile: (path, value) => writes.push({ path, value }),
    rename: (_source, target) => writes.push({ target }),
    setInterval: (fn) => { heartbeat = fn; return 7; },
    clearInterval: (timer) => assert.equal(timer, 7),
    unlink: (path) => removed.push(path),
  }));
  heartbeat();
  lease.release();
  lease.release();
  assert.equal(writes.filter((entry) => entry.value).length, 2);
  assert.deepEqual(removed, ['C:\\ProgramData\\runnerize\\guard\\leases\\11111111-1111-1111-1111-111111111111.json']);
});

test('status is read-only and reports current Tier-1 state', async () => {
  let call = 0;
  const harness = spawnStub();
  const spawnChild = (file, args, options) => {
    call += 1;
    const output = call === 1
      ? 'true'
      : '{"noAutoRebootWithLoggedOnUsers":1,"setActiveHours":1,"activeHoursStart":6,"activeHoursEnd":0,"hibernateOn":false}';
    return spawnStub({ stdout: output }).spawnChild(file, args, options);
  };
  const logs = await logsDuring(() => guardStatus({
    platformName: 'win32',
    spawnChild,
    stateExists: () => true,
  }));
  assert.ok(logs.includes('Hyper-V guest: yes'));
  assert.ok(logs.includes('Guard state file: present'));
  assert.ok(logs.includes('NoAutoRebootWithLoggedOnUsers: 1'));
  assert.ok(logs.includes('Active hours policy: enabled=1 start=6 end=0'));
  assert.ok(logs.includes('Hibernate: off'));
});
