import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepHostAwake } from '../../src/keepawake.js';

function childStub(calls) {
  return (command, args, options) => {
    const child = {
      killed: false,
      on() {},
      unref() {},
      kill() { this.killed = true; },
    };
    calls.push({ command, args, options, child });
    return child;
  };
}

test('keepHostAwake uses caffeinate on macOS and disposes it', () => {
  const calls = [];
  const lock = keepHostAwake({ platform: 'darwin', spawnChild: childStub(calls) });
  assert.equal(calls[0].command, 'caffeinate');
  assert.deepEqual(calls[0].args, ['-s', '-w', String(process.pid)]);
  lock.dispose();
  assert.equal(calls[0].child.killed, true);
});

test('keepHostAwake uses systemd-inhibit on native Linux', () => {
  const calls = [];
  const lock = keepHostAwake({
    platform: 'linux',
    spawnChild: childStub(calls),
    readVersion: () => 'Linux version 6.8.0',
  });
  assert.equal(calls[0].command, 'systemd-inhibit');
  assert.ok(calls[0].args.includes('--what=sleep'));
  assert.ok(calls[0].args.includes('--mode=block'));
  lock.dispose();
  assert.equal(calls[0].child.killed, true);
});

test('keepHostAwake is a no-op inside WSL and on Windows', () => {
  for (const platform of ['linux', 'win32']) {
    const calls = [];
    keepHostAwake({
      platform,
      spawnChild: childStub(calls),
      readVersion: () => 'Linux Microsoft WSL2',
    }).dispose();
    assert.equal(calls.length, 0);
  }
});
