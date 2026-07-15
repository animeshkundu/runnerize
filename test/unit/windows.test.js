import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    return await fn(windows);
  } finally {
    if (previous === undefined) delete process.env.RUNNERIZE_RUNNER_DIR;
    else process.env.RUNNERIZE_RUNNER_DIR = previous;
    await rm(runnerDir, { recursive: true, force: true });
    restoreProcess();
  }
}

function controlDirFromStart(child) {
  const config = child.args[child.args.indexOf('--config') + 1];
  const mapped = [...config.matchAll(/<HostFolder>(.*?)<\/HostFolder>/g)];
  return mapped[1][1]
    .replaceAll('&apos;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&amp;', '&');
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

test('windows.launch observes a job, calls onStarted once, and stops the sandbox', async () => {
  await withWindowsLaunch(async (windows) => {
    let started = 0;
    const stub = new SpawnStub((child) => {
      if (child.args.includes('start')) {
        const controlDir = controlDirFromStart(child);
        void Promise.all([
          writeFile(path.join(controlDir, 'runner.log'), 'Running job: build\nRunning job: duplicate\n'),
          writeFile(path.join(controlDir, 'runner.done'), '0\n'),
        ]).then(() => child.close(0));
      } else if (child.args.includes('list')) {
        child.emitStdout('{"WindowsSandboxEnvironments":[]}');
        child.close(0);
      } else child.close(0);
    }).install();
    try {
      const result = await withKeepAlive(windows.launch('deadbeef', {
        idleTimeoutMs: 5000,
        onStarted: () => { started += 1; },
      }));
      assert.deepEqual(result, { startedJob: true });
      assert.equal(started, 1);
      assert.ok(stub.find('stop'), 'the sandbox is stopped in finally');
      const start = stub.find('start');
      assert.ok(!start.args.includes('deadbeef'), 'the JIT config is not exposed on argv');
      assert.match(start.args[start.args.indexOf('--config') + 1], /run-runner\.ps1/);
    } finally {
      stub.restore();
    }
  });
});

test('windows.launch times out before assignment and stops the sandbox', async () => {
  await withWindowsLaunch(async (windows) => {
    const stub = new SpawnStub((child) => {
      if (child.args.includes('list')) child.emitStdout('{"WindowsSandboxEnvironments":[]}');
      child.close(0);
    }).install();
    try {
      const result = await withKeepAlive(windows.launch('cfg', { idleTimeoutMs: 30 }));
      assert.deepEqual(result, { startedJob: false });
      assert.ok(stub.find('stop'), 'idle timeout tears the sandbox down');
    } finally {
      stub.restore();
    }
  });
});
