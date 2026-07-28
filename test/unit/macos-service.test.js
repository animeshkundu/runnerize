import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const savedEnvironment = new Map(['RUNNERIZE_MACOS_IMAGE', 'RUNNERIZE_MACOS_NODE', 'RUNNERIZE_MACOS_HEALTH_POLL_MS', 'RUNNERIZE_MACOS_HEALTH_STABLE_MS', 'RUNNERIZE_MACOS_HEALTH_TIMEOUT_MS', 'GH_TOKEN', 'GITHUB_TOKEN', 'SUDO_USER'].map((key) => [key, process.env[key]]));
  const oldGetuid = process.getuid;
  process.getuid = () => options.root ? 0 : 501;
  const restoreProcess = overrideProcess({ arch: options.arch || 'arm64' });
  const nodePath = join(home, 'node', 'bin', 'node');
  let loaded = false;
  mkdirSync(join(home, 'node', 'bin'), { recursive: true });
  writeFileSync(nodePath, 'test');

  childProcess.execFileSync = (file, args, execOptions = {}) => {
    calls.push({ kind: 'exec', file, args, options: execOptions });
    if (file === nodePath && args[0] === '--version') return 'v24.18.0\n';
    if (file === 'brew' && options.brewFails) {
      const error = new Error('brew failed');
      error.status = 1;
      throw error;
    }
    if (file === 'tart' && args[0] === 'list') {
      return JSON.stringify(options.imagePresent ? [{ Name: options.image || 'local-base', Source: 'local' }] : []);
    }
    if (file === 'gh' && args[0] === 'auth') {
      if (options.noCredential) {
        const error = new Error('not logged in');
        error.status = 1;
        throw error;
      }
      return 'test-token';
    }
    if (file === 'sh' && args[0] === '-c' && args[1].startsWith('command -v')) {
      const tool = args.at(-1);
      if (['gh', 'tart', 'podman', 'docker'].includes(tool)) return `/opt/homebrew/bin/${tool}\n`;
      const error = new Error('missing'); error.status = 1; throw error;
    }
    if (file === 'launchctl' && args[0] === 'print') {
      if (args[1] === 'gui/501' && options.headless) { const error = new Error('no gui'); error.status = 1; throw error; }
      if (args[1] === 'gui/501') return 'domain = gui/501';
      if (!loaded) { const error = new Error('not loaded'); error.status = 1; throw error; }
      return options.crashLoop ? 'last exit code = 1' : 'pid = 987654321';
    }
    if (file === 'launchctl' && args[0] === 'bootstrap') {
      if (options.bootstrapFails && !options.bootstrapFailed) {
        options.bootstrapFailed = true;
        const error = new Error('bootstrap failed'); error.status = 1; throw error;
      }
      loaded = true;
      return '';
    }
    if (file === 'launchctl' && args[0] === 'kickstart') {
      loaded = true;
      if (options.noHealth) return '';
      const plistPath = join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist');
      const plist = readFileSync(plistPath, 'utf8');
      const generation = plist.match(/<key>RUNNERIZE_HEALTH_GENERATION<\/key><string>([^<]+)<\/string>/)[1];
      const healthFile = join(home, 'Library', 'Application Support', 'runnerize', 'state', 'health.json');
      mkdirSync(join(home, 'Library', 'Application Support', 'runnerize', 'state'), { recursive: true });
      writeFileSync(healthFile, JSON.stringify({ generation, pid: 987654321 }));
      return '';
    }
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
    if (file === 'launchctl' && args[0] === 'bootout') {
      if (!options.staysLoaded) loaded = false;
      return { status: options.staysLoaded ? 1 : 0 };
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
  process.env.RUNNERIZE_MACOS_NODE = nodePath;
  process.env.RUNNERIZE_MACOS_HEALTH_POLL_MS = '0';
  process.env.RUNNERIZE_MACOS_HEALTH_STABLE_MS = '0';
  process.env.RUNNERIZE_MACOS_HEALTH_TIMEOUT_MS = '1';
  delete process.env.SUDO_USER;
  delete process.env.GITHUB_TOKEN;
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
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}


test('macOS install auto-installs tart with Homebrew and keeps launchd installation running', async () => {
  await withMacosService({ brew: true, runtime: 'podman', image: 'local-base', imagePresent: true }, async ({ service, calls, home }) => {
    await service.installService();
    const trust = calls.find((call) => call.kind === 'spawn' && call.file === 'brew' && call.args[0] === 'trust');
    assert.deepEqual(trust.args, ['trust', 'cirruslabs/cli']);
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

test('macOS install recovers a prior app backup before materializing', async () => {
  await withMacosService({ runtime: 'podman' }, async ({ service, home }) => {
    const data = join(home, 'Library', 'Application Support', 'runnerize');
    const backup = join(data, 'app.old.42');
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'marker'), 'last-good');
    await service.installService();
    assert.ok(existsSync(join(data, 'app', 'bin', 'runnerize.js')));
    assert.ok(!existsSync(backup));
  });
});

test('macOS plist uses the durable materialized app, explicit PATH, and protected token', async () => {
  await withMacosService({ runtime: 'podman' }, async ({ service, home }) => {
    await service.installService();
    const data = join(home, 'Library', 'Application Support', 'runnerize');
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist'), 'utf8');
    assert.ok(existsSync(join(data, 'app', 'bin', 'runnerize.js')));
    assert.match(plist, new RegExp(join(data, 'app', 'bin', 'runnerize.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(plist, /<key>PATH<\/key><string>[^<]*\/opt\/homebrew\/bin/);
    const tokenPath = join(data, 'credentials', 'gh-token');
    assert.ok(readFileSync(tokenPath, 'utf8').trim());
    assert.equal((await import('node:fs')).statSync(tokenPath).mode & 0o777, 0o600);
    assert.doesNotMatch(plist, new RegExp(readFileSync(tokenPath, 'utf8').trim()));
  });
});


test('macOS bootstrap failure restores the previous plist and app', async () => {
  await withMacosService({ runtime: 'podman', bootstrapFails: true }, async ({ service, home }) => {
    const agentPath = join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist');
    const appPath = join(home, 'Library', 'Application Support', 'runnerize', 'app');
    mkdirSync(join(appPath, 'bin'), { recursive: true });
    writeFileSync(join(appPath, 'old-marker'), 'old');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(agentPath, 'old plist');
    await assert.rejects(() => service.installService(), /bootstrap failed/);
    assert.equal(readFileSync(agentPath, 'utf8'), 'old plist');
    assert.ok(existsSync(join(appPath, 'old-marker')));
  });
});

test('macOS headless install publishes a linted agent without bootstrapping', async () => {
  await withMacosService({ runtime: 'podman', headless: true }, async ({ service, calls, logs, home }) => {
    await service.installService();
    assert.ok(existsSync(join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist')));
    assert.ok(calls.some((call) => call.file === 'plutil' && call.args[0] === '-lint'));
    assert.ok(!calls.some((call) => call.file === 'launchctl' && call.args[0] === 'bootstrap'));
    assert.ok(logs.some((line) => line.includes('next desktop login')));
  });
});

test('macOS uninstall removes launchd and all service-owned data', async () => {
  await withMacosService({ runtime: 'podman' }, async ({ service, calls, home }) => {
    await service.installService();
    const logPath = join(home, 'Library', 'Logs', 'runnerize.log');
    writeFileSync(logPath, 'log');
    await service.uninstallService();
    assert.ok(!existsSync(join(home, 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist')));
    assert.ok(!existsSync(join(home, 'Library', 'Application Support', 'runnerize')));
    assert.ok(!existsSync(logPath));
    assert.ok(calls.some((call) => call.kind === 'spawn' && call.file === 'launchctl' && call.args[0] === 'bootout'));
  });
});

test('macOS uninstall preserves service data while the launchd job remains loaded', async () => {
  await withMacosService({ runtime: 'podman', staysLoaded: true }, async ({ service, warnings, home }) => {
    await service.installService();
    const dataPath = join(home, 'Library', 'Application Support', 'runnerize');
    const logPath = join(home, 'Library', 'Logs', 'runnerize.log');
    writeFileSync(logPath, 'log');
    await service.uninstallService();
    assert.ok(existsSync(dataPath));
    assert.ok(existsSync(logPath));
    assert.ok(warnings.some((line) => line.includes('launchctl bootout gui/501/io.runnerize.dispatcher')));
  });
});
