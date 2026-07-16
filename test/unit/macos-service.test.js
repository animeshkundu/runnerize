import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { overrideProcess } from '../helpers/platform-override.js';
import { freshImport } from '../helpers/fresh-module.js';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const os = require('node:os');

async function withMacosService(options, action) {
  const home = mkdtempSync(join(tmpdir(), 'runnerize-macos-service-'));
  const calls = [];
  const oldExec = childProcess.execFileSync;
  const oldSpawn = childProcess.spawnSync;
  const oldPlatform = os.platform;
  const oldHome = os.homedir;
  const oldImage = process.env.RUNNERIZE_MACOS_IMAGE;
  const oldToken = process.env.GH_TOKEN;
  const oldGetuid = process.getuid;
  process.getuid = () => 501;
  const restoreProcess = overrideProcess({ arch: options.arch || 'arm64' });

  childProcess.execFileSync = (file, args, execOptions = {}) => {
    calls.push({ kind: 'exec', file, args, options: execOptions });
    if (file === 'brew' && options.brewFails) {
      const error = new Error('brew failed');
      error.status = 1;
      throw error;
    }
    if (file === 'tart' && args[0] === 'list') {
      return JSON.stringify(options.imagePresent ? [{ name: options.image || 'local-base' }] : []);
    }
    if (file === 'gh' && args[0] === 'auth') {
      if (options.noCredential) {
        const error = new Error('not logged in');
        error.status = 1;
        throw error;
      }
      return 'test-token';
    }
    if (file === 'launchctl') return '';
    return '';
  };
  let tartInstalled = Boolean(options.tart);
  childProcess.spawnSync = (file, args, spawnOptions = {}) => {
    calls.push({ kind: 'spawn', file, args, options: spawnOptions });
    if (file === 'sh' && args[0] === '-c') {
      const command = args.at(-1);
      if (command === 'tart') return { status: tartInstalled ? 0 : 1 };
      if (command === 'brew') return { status: options.brew ? 0 : 1 };
      return { status: 0 };
    }
    if (file === 'podman' || file === 'docker') {
      return { status: options.runtime === file ? 0 : 1 };
    }
    if (file === 'launchctl') return { status: 0 };
    return { status: 0 };
  };
  if (options.brew && !options.tart && !options.brewFails) {
    const exec = childProcess.execFileSync;
    childProcess.execFileSync = (file, args, execOptions) => {
      const result = exec(file, args, execOptions);
      if (file === 'brew' && args[0] === 'install') tartInstalled = true;
      return result;
    };
  }
  os.platform = () => 'darwin';
  os.homedir = () => home;
  syncBuiltinESMExports();
  if (options.image) process.env.RUNNERIZE_MACOS_IMAGE = options.image;
  else delete process.env.RUNNERIZE_MACOS_IMAGE;
  if (options.noCredential) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = 'test-token';

  const logs = [];
  const warnings = [];
  const oldLog = console.log;
  const oldWarn = console.warn;
  console.log = (message = '') => logs.push(String(message));
  console.warn = (message = '') => warnings.push(String(message));
  try {
    const service = await freshImport('../../src/service.js');
    await action({ service, calls, logs, warnings, home });
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
    childProcess.execFileSync = oldExec;
    childProcess.spawnSync = oldSpawn;
    os.platform = oldPlatform;
    os.homedir = oldHome;
    syncBuiltinESMExports();
    restoreProcess();
    if (oldGetuid === undefined) delete process.getuid;
    else process.getuid = oldGetuid;
    rmSync(home, { recursive: true, force: true });
    if (oldImage === undefined) delete process.env.RUNNERIZE_MACOS_IMAGE;
    else process.env.RUNNERIZE_MACOS_IMAGE = oldImage;
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
  }
}

test('macOS install auto-installs tart with Homebrew and keeps launchd installation running', async () => {
  await withMacosService({ brew: true, runtime: 'podman', image: 'local-base', imagePresent: true }, async ({ service, calls, home }) => {
    await service.installService();
    const install = calls.find((call) => call.kind === 'exec' && call.file === 'brew');
    assert.deepEqual(install.args, ['install', 'cirruslabs/cli/tart']);
    assert.equal(install.options.timeout, 120_000);
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist')));
  });
});

test('macOS install prints ordered Homebrew, tart, image, and SSH fallback steps', async () => {
  await withMacosService({ runtime: 'podman' }, async ({ service, logs }) => {
    await service.installService();
    assert.ok(logs.some((line) => line.trim() === 'macOS setup steps'));
    assert.ok(logs.some((line) => line.includes('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh')));
    assert.ok(logs.some((line) => line === '   brew install cirruslabs/cli/tart'));
    assert.ok(logs.some((line) => line.includes('tart pull "$RUNNERIZE_MACOS_IMAGE"')));
    assert.ok(logs.some((line) => line.includes('RUNNERIZE_MACOS_SSH_USER=admin')));
  });
});

test('macOS install guides after Homebrew tart installation fails', async () => {
  await withMacosService({ brew: true, brewFails: true, runtime: 'podman' }, async ({ service, logs, warnings }) => {
    await service.installService();
    assert.ok(warnings.some((line) => line.includes('tart could not be installed automatically')));
    assert.ok(logs.some((line) => line === '   brew install cirruslabs/cli/tart'));
  });
});

test('macOS install preserves tart environment variables in the launchd agent', async () => {
  await withMacosService({ tart: true, runtime: 'podman', image: 'local-base', imagePresent: true }, async ({ service, home }) => {
    process.env.RUNNERIZE_MACOS_SSH_USER = 'ci';
    try {
      await service.installService();
      const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist'), 'utf8');
      assert.match(plist, /<key>RUNNERIZE_MACOS_IMAGE<\/key><string>local-base<\/string>/);
      assert.match(plist, /<key>RUNNERIZE_MACOS_SSH_USER<\/key><string>ci<\/string>/);
    } finally {
      delete process.env.RUNNERIZE_MACOS_SSH_USER;
    }
  });
});

test('macOS install succeeds with tart alone when the Linux runtime is unavailable', async () => {
  await withMacosService({ tart: true, image: 'local-base', imagePresent: true }, async ({ service, warnings, home }) => {
    await service.installService();
    assert.ok(warnings.some((line) => line.startsWith('Linux backend unavailable:')));
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist')));
  });
});

test('Intel macOS reports tart unavailable but still installs a Linux-backed launchd agent', async () => {
  await withMacosService({ arch: 'x64', runtime: 'podman' }, async ({ service, logs, home }) => {
    await service.installService();
    assert.ok(logs.some((line) => line.includes('tart requires arm64')));
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist')));
  });
});
