import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { overrideProcess } from '../helpers/platform-override.js';
import { SpawnStub } from '../helpers/process-stub.js';
import { freshImport } from '../helpers/fresh-module.js';
import { withKeepAlive } from '../helpers/dispatcher-harness.js';

async function withWindowsLaunch(fn) {
  const restoreProcess = overrideProcess({ platform: 'win32' });
  const runnerDir = await mkdtemp(path.join(os.tmpdir(), 'rz-win-runner-'));
  const previous = process.env.RUNNERIZE_RUNNER_DIR;
  process.env.RUNNERIZE_RUNNER_DIR = runnerDir;
  await writeFile(path.join(runnerDir, 'run.cmd'), '@exit /b 0\r\n');
  try {
    const { windows } = await freshImport('../../src/sandbox/windows.js');
    return await fn(windows, path.resolve(runnerDir));
  } finally {
    if (previous === undefined) delete process.env.RUNNERIZE_RUNNER_DIR;
    else process.env.RUNNERIZE_RUNNER_DIR = previous;
    await rm(runnerDir, { recursive: true, force: true });
    restoreProcess();
  }
}

function commandOf(child) {
  return child.args[child.args.indexOf('--command') + 1];
}

function createLaunchStub({ onRunnerExec } = {}) {
  let controlDir;
  const stub = new SpawnStub((child) => {
    if (child.args.includes('list')) {
      child.emitStdout('{"WindowsSandboxEnvironments":[]}');
      child.close(0);
    } else if (child.args.includes('share')) {
      if (child.args.includes('C:\\runnerize\\control')) {
        controlDir = child.args[child.args.indexOf('--host-path') + 1];
      }
      child.close(0);
    } else if (child.args.includes('exec') && commandOf(child) === 'cmd.exe /c exit 0') {
      child.close(0);
    } else if (child.args.includes('exec')) {
      onRunnerExec?.(child, controlDir);
    } else {
      child.close(0);
    }
  }).install();
  return stub;
}

async function assertMissing(file) {
  await assert.rejects(() => access(file), { code: 'ENOENT' });
}

test('windows.available returns false outside Windows without spawning', async () => {
  const restoreProcess = overrideProcess({ platform: 'linux' });
  const stub = new SpawnStub(() => { throw new Error('must not spawn'); }).install();
  try {
    const { windows } = await freshImport('../../src/sandbox/windows.js');
    assert.equal(await windows.available(), false);
    assert.equal(stub.children.length, 0);
  } finally {
    stub.restore();
    restoreProcess();
  }
});

test('windows.available returns true when wsb.exe responds', async () => {
  const restoreProcess = overrideProcess({ platform: 'win32' });
  const stub = new SpawnStub((child) => {
    child.emitStdout('{"WindowsSandboxEnvironments":[]}\n');
    child.close(0);
  }).install();
  try {
    const { windows } = await freshImport('../../src/sandbox/windows.js');
    assert.equal(await windows.available(), true);
    assert.ok(stub.find('list', '--raw'));
  } finally {
    stub.restore();
    restoreProcess();
  }
});

test('windows.launch validates inputs before spawning', async () => {
  const { windows } = await freshImport('../../src/sandbox/windows.js');
  await assert.rejects(() => windows.launch('', { idleTimeoutMs: 1000 }), TypeError);
  await assert.rejects(() => windows.launch(42, { idleTimeoutMs: 1000 }), TypeError);
  await assert.rejects(() => windows.launch('cfg', { idleTimeoutMs: 0 }), RangeError);
  await assert.rejects(() => windows.launch('cfg', { idleTimeoutMs: Infinity }), RangeError);
});

test('windows.launch shares folders, observes a job once, and cleans up', async () => {
  await withWindowsLaunch(async (windows, runnerDir) => {
    let started = 0;
    let controlDir;
    const stub = createLaunchStub({
      onRunnerExec(child, dir) {
        controlDir = dir;
        void writeFile(path.join(dir, 'runner.log'), 'Running job: build\nRunning job: duplicate\n')
          .then(() => child.close(0));
      },
    });
    try {
      const result = await withKeepAlive(windows.launch('deadbeef', {
        idleTimeoutMs: 5000,
        onStarted: () => { started += 1; },
      }));
      assert.deepEqual(result, { startedJob: true });
      assert.equal(started, 1);

      const start = stub.find('start');
      assert.deepEqual(start.args.slice(0, 3), ['start', '--id', start.args[2]]);
      assert.ok(!start.args.includes('--config'));
      assert.ok(!start.args.includes('deadbeef'), 'the JIT config is not exposed on argv');

      const readiness = stub.children.find((child) => child.args.includes('exec')
        && commandOf(child) === 'cmd.exe /c exit 0');
      const runnerExec = stub.children.find((child) => child.args.includes('exec')
        && commandOf(child)?.startsWith('powershell.exe'));
      assert.ok(readiness.args.includes('System'));
      assert.ok(runnerExec.args.includes('System'));

      const runnerShare = stub.children.find((child) => child.args.includes('share')
        && child.args.includes('C:\\runnerize\\runner'));
      const controlShare = stub.children.find((child) => child.args.includes('share')
        && child.args.includes('C:\\runnerize\\control'));
      assert.equal(runnerShare.args[runnerShare.args.indexOf('--host-path') + 1], runnerDir);
      assert.ok(!runnerShare.args.includes('--allow-write'));
      assert.ok(controlShare.args.includes('--allow-write'));
      assert.ok(stub.find('stop'), 'the sandbox is stopped in finally');
      await assertMissing(controlDir);
    } finally {
      stub.restore();
    }
  });
});

test('windows.launch times out before assignment, stops, and removes control files', async () => {
  await withWindowsLaunch(async (windows) => {
    let controlDir;
    const stub = createLaunchStub({ onRunnerExec(_child, dir) { controlDir = dir; } });
    try {
      const result = await withKeepAlive(windows.launch('cfg', { idleTimeoutMs: 30 }));
      assert.deepEqual(result, { startedJob: false });
      assert.ok(stub.find('stop'), 'idle timeout tears the sandbox down');
      await assertMissing(controlDir);
    } finally {
      stub.restore();
    }
  });
});

test('windows.launch surfaces an exec failure before a job starts', async () => {
  await withWindowsLaunch(async (windows) => {
    const stub = createLaunchStub({ onRunnerExec(child) { child.emitStderr('runner failed'); child.close(1); } });
    try {
      await assert.rejects(
        withKeepAlive(windows.launch('cfg', { idleTimeoutMs: 1000 })),
        (error) => {
          assert.equal(error.message, 'windows runner exited before starting a job');
          assert.match(error.cause?.message, /runner failed/);
          return true;
        },
      );
      assert.ok(stub.find('stop'));
    } finally {
      stub.restore();
    }
  });
});

test('windows.launch resolves false when exec exits cleanly before a job starts', async () => {
  await withWindowsLaunch(async (windows) => {
    const stub = createLaunchStub({ onRunnerExec(child) { child.close(0); } });
    try {
      assert.deepEqual(await withKeepAlive(windows.launch('cfg', { idleTimeoutMs: 1000 })), {
        startedJob: false,
      });
    } finally {
      stub.restore();
    }
  });
});

test('windows.launch stop polling normalizes IDs and waits for a lingering sandbox', async () => {
  await withWindowsLaunch(async (windows) => {
    let sandboxId;
    let listCalls = 0;
    const stub = new SpawnStub((child) => {
      if (child.args.includes('start')) {
        sandboxId = child.args[child.args.indexOf('--id') + 1];
        child.close(0);
      } else if (child.args.includes('exec') && commandOf(child) === 'cmd.exe /c exit 0') {
        child.close(0);
      } else if (child.args.includes('share')) {
        child.close(0);
      } else if (child.args.includes('exec')) {
        child.close(0);
      } else if (child.args.includes('list')) {
        listCalls += 1;
        const environments = listCalls < 3 ? [{ Id: `{${sandboxId.toUpperCase()}}` }] : [];
        child.emitStdout(JSON.stringify({ WindowsSandboxEnvironments: environments }));
        child.close(0);
      } else child.close(0);
    }).install();
    try {
      assert.deepEqual(await withKeepAlive(windows.launch('cfg', { idleTimeoutMs: 1000 })), {
        startedJob: false,
      });
      assert.equal(listCalls, 3, 'polls until the normalized sandbox ID disappears');
    } finally {
      stub.restore();
    }
  });
});
