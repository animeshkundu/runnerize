import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { guardStatus, installGuard, isHyperVGuest, uninstallGuard } from '../../src/guard.js';

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

test('--shutdown-guard scaffold prints its Tier-2 message without probing or elevating', async () => {
  let called = false;
  const logs = await logsDuring(() => installGuard({
    shutdownGuard: true,
    platformName: 'win32',
    spawnChild: () => { called = true; throw new Error('not called'); },
    runElevatedOperation: async () => { called = true; return { ok: true }; },
  }));
  assert.equal(called, false);
  assert.deepEqual(logs, ['shutdown-guard (Tier 2) is not yet implemented']);
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
