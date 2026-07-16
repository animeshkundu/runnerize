import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overrideProcess } from '../helpers/platform-override.js';
import { SpawnStub } from '../helpers/process-stub.js';
import { freshImport } from '../helpers/fresh-module.js';
import { withKeepAlive } from '../helpers/dispatcher-harness.js';

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function launchStub({ runnerCode = 0, runnerOutput = '', runnerError = '' } = {}) {
  return new SpawnStub((child) => {
    if (child.command === 'tart' && child.args[0] === 'run') return;
    if (child.command === 'tart' && child.args[0] === 'ip') {
      child.emitStdout('192.0.2.10\n');
      child.close(0);
      return;
    }
    if (child.command === 'ssh' && child.args.at(-1) === 'true') {
      child.close(0);
      return;
    }
    if (child.command === 'ssh' && child.args.at(-1) === 'bash -s') {
      if (runnerOutput) child.emitStdout(runnerOutput);
      if (runnerError) child.emitStderr(runnerError);
      child.close(runnerCode);
      return;
    }
    child.close(0);
  }).install();
}

async function withMacos(fn, env = {}) {
  const restore = overrideProcess({ platform: 'darwin', arch: 'arm64' });
  try {
    return await withEnv({
      RUNNERIZE_MACOS_IMAGE: 'base-image',
      RUNNERIZE_MACOS_RUNNER_DIR: '/opt/actions-runner',
      RUNNERIZE_MACOS_RUNNER_VERSION: undefined,
      RUNNERIZE_MACOS_SSH_KEY: undefined,
      ...env,
    }, async () => {
      const { macos } = await freshImport('../../src/sandbox/macos.js');
      return fn(macos);
    });
  } finally {
    restore();
  }
}

test('macos.available returns false outside macOS without spawning', async () => {
  const restore = overrideProcess({ platform: 'linux', arch: 'arm64' });
  const stub = new SpawnStub(() => { throw new Error('must not spawn'); }).install();
  try {
    const { macos } = await freshImport('../../src/sandbox/macos.js');
    assert.equal(await macos.available(), false);
    assert.equal(stub.children.length, 0);
  } finally {
    stub.restore();
    restore();
  }
});

test('macos.available returns false on Intel macOS without spawning', async () => {
  const restore = overrideProcess({ platform: 'darwin', arch: 'x64' });
  const stub = new SpawnStub(() => { throw new Error('must not spawn'); }).install();
  try {
    const { macos } = await freshImport('../../src/sandbox/macos.js');
    assert.equal(await macos.available(), false);
  } finally {
    stub.restore();
    restore();
  }
});

test('macos.available returns false without a configured image and does not spawn', async () => {
  const restore = overrideProcess({ platform: 'darwin', arch: 'arm64' });
  const previous = process.env.RUNNERIZE_MACOS_IMAGE;
  delete process.env.RUNNERIZE_MACOS_IMAGE;
  const stub = new SpawnStub(() => { throw new Error('must not spawn'); }).install();
  try {
    const { macos } = await freshImport('../../src/sandbox/macos.js');
    assert.equal(await macos.available(), false);
    assert.equal(stub.children.length, 0);
  } finally {
    stub.restore();
    if (previous === undefined) delete process.env.RUNNERIZE_MACOS_IMAGE;
    else process.env.RUNNERIZE_MACOS_IMAGE = previous;
    restore();
  }
});

test('macos.available returns false when tart is missing', async () => {
  const restore = overrideProcess({ platform: 'darwin', arch: 'arm64' });
  const previous = process.env.RUNNERIZE_MACOS_IMAGE;
  process.env.RUNNERIZE_MACOS_IMAGE = 'base-image';
  const stub = new SpawnStub((child) => child.fail(new Error('ENOENT'))).install();
  try {
    const { macos } = await freshImport('../../src/sandbox/macos.js');
    assert.equal(await macos.available(), false);
  } finally {
    stub.restore();
    if (previous === undefined) delete process.env.RUNNERIZE_MACOS_IMAGE;
    else process.env.RUNNERIZE_MACOS_IMAGE = previous;
    restore();
  }
});

test('macos.available returns true on configured Apple Silicon when tart responds', async () => {
  const restore = overrideProcess({ platform: 'darwin', arch: 'arm64' });
  const previous = process.env.RUNNERIZE_MACOS_IMAGE;
  process.env.RUNNERIZE_MACOS_IMAGE = 'base-image';
  const stub = new SpawnStub((child) => child.close(0)).install();
  try {
    const { macos } = await freshImport('../../src/sandbox/macos.js');
    assert.equal(await macos.available(), true);
    assert.ok(stub.find('--version'));
  } finally {
    stub.restore();
    if (previous === undefined) delete process.env.RUNNERIZE_MACOS_IMAGE;
    else process.env.RUNNERIZE_MACOS_IMAGE = previous;
    restore();
  }
});

test('macos.launch validates inputs and requires its image', async () => {
  const { macos } = await freshImport('../../src/sandbox/macos.js');
  await assert.rejects(() => macos.launch(''), TypeError);
  await assert.rejects(() => macos.launch(42), TypeError);
  await assert.rejects(() => macos.launch('cfg', { idleTimeoutMs: 0 }), RangeError);
  await assert.rejects(() => macos.launch('cfg', { idleTimeoutMs: Infinity }), RangeError);

  await withMacos(async (flavor) => {
    await assert.rejects(() => flavor.launch('cfg'), /RUNNERIZE_MACOS_IMAGE.*ghcr\.io/);
  }, { RUNNERIZE_MACOS_IMAGE: undefined });
});

test('macos.launch observes a job once, keeps the config off argv, and deletes the VM', async () => {
  await withMacos(async (macos) => {
    let started = 0;
    const stub = launchStub({ runnerOutput: 'Running job: build\nRunning job: duplicate\n' });
    try {
      assert.deepEqual(await withKeepAlive(macos.launch('secret-jit-config', {
        idleTimeoutMs: 1000,
        onStarted: () => { started += 1; },
      })), { startedJob: true });
      assert.equal(started, 1);
      const clone = stub.find('clone');
      const vmName = clone.args[2];
      assert.match(vmName, /^runnerize-/);
      assert.ok(stub.find('run', '--no-graphics', '--no-audio', vmName));
      assert.ok(stub.find('delete', vmName));
      assert.ok(stub.find('stop', vmName));
      assert.ok(stub.children.every((child) => !child.args.includes('secret-jit-config')));

      const ssh = stub.children.find((child) => child.command === 'ssh' && child.args.at(-1) === 'bash -s');
      const stdin = Buffer.concat(ssh.stdin.chunks).toString();
      assert.ok(stdin.startsWith('#!/usr/bin/env bash'));
      assert.match(stdin, /\.\/run\.sh --jitconfig/);
      assert.match(stdin, /printf '%s'.*> "\$jitfile"/);
      assert.ok(!ssh.args.join(' ').includes('secret-jit-config'));
      assert.ok(ssh.args.includes('ServerAliveInterval=15'));
      assert.ok(ssh.args.includes('ServerAliveCountMax=3'));
    } finally {
      stub.restore();
    }
  });
});

test('macos.launch idle timeout kills SSH before sequential stop and delete', async () => {
  await withMacos(async (macos) => {
    const events = [];
    let runner;
    const stub = new SpawnStub((child) => {
      if (child.command === 'tart' && child.args[0] === 'run') return;
      if (child.command === 'tart' && child.args[0] === 'ip') {
        child.emitStdout('192.0.2.10\n');
        child.close(0);
      } else if (child.command === 'ssh' && child.args.at(-1) === 'true') child.close(0);
      else if (child.command === 'ssh' && child.args.at(-1) === 'bash -s') {
        runner = child;
        const kill = child.kill.bind(child);
        child.kill = (signal) => { events.push(`kill:${signal}`); return kill(signal); };
      } else if (child.command === 'tart' && child.args[0] === 'stop') {
        events.push('stop');
        setTimeout(() => { events.push('stop-complete'); child.close(0); }, 5);
      } else if (child.command === 'tart' && child.args[0] === 'delete') {
        events.push('delete');
        child.close(0);
      } else child.close(0);
    }).install();
    try {
      assert.deepEqual(await withKeepAlive(macos.launch('cfg', { idleTimeoutMs: 20 })), {
        startedJob: false,
      });
      assert.ok(runner.signals.includes('SIGKILL'));
      assert.deepEqual(events, ['kill:SIGKILL', 'stop', 'stop-complete', 'delete']);
    } finally {
      stub.restore();
    }
  });
});

test('macos.launch tolerates SSH stdin EPIPE and reports the child exit', async () => {
  await withMacos(async (macos) => {
    const stub = new SpawnStub((child) => {
      if (child.command === 'tart' && child.args[0] === 'run') return;
      if (child.command === 'tart' && child.args[0] === 'ip') {
        child.emitStdout('192.0.2.10\n');
        child.close(0);
      } else if (child.command === 'ssh' && child.args.at(-1) === 'true') child.close(0);
      else if (child.command === 'ssh' && child.args.at(-1) === 'bash -s') {
        child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
        child.emitStderr('connection lost');
        child.close(255);
      } else child.close(0);
    }).install();
    try {
      await assert.rejects(
        withKeepAlive(macos.launch('cfg', { idleTimeoutMs: 1000 })),
        /macos runner exited before starting a job: connection lost/,
      );
    } finally {
      stub.restore();
    }
  });
});

test('macos.launch surfaces SSH failure before a job and still deletes the VM', async () => {
  await withMacos(async (macos) => {
    const stub = launchStub({ runnerCode: 1, runnerError: 'runner failed' });
    try {
      await assert.rejects(
        withKeepAlive(macos.launch('cfg', { idleTimeoutMs: 1000 })),
        /macos runner exited before starting a job: runner failed/,
      );
      const vmName = stub.find('clone').args[2];
      assert.ok(stub.find('delete', vmName));
    } finally {
      stub.restore();
    }
  });
});
