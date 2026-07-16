import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFlavors, linux, windows, macos } from '../../src/sandbox/index.js';

// detectFlavors returns the exported flavor singletons whose `available()` resolves
// truthy, and swallows a throwing `available()` as "not available". We drive it by
// temporarily overriding the singletons' `available` methods.
async function withAvailability({ linux: l, windows: w, macos: m }, fn) {
  const saved = { l: linux.available, w: windows.available, m: macos.available };
  linux.available = l;
  windows.available = w;
  macos.available = m;
  try {
    return await fn();
  } finally {
    linux.available = saved.l;
    windows.available = saved.w;
    macos.available = saved.m;
  }
}

test('stub flavors expose the frozen FLAVOR shape', () => {
  for (const flavor of [linux, windows, macos]) {
    assert.equal(typeof flavor.key, 'string');
    assert.ok(Array.isArray(flavor.labels) && flavor.labels.length > 0);
    assert.equal(typeof flavor.available, 'function');
    assert.equal(typeof flavor.launch, 'function');
    assert.ok(flavor.labels.includes('self-hosted'), 'every flavor advertises self-hosted');
  }
  assert.equal(linux.key, 'linux');
  assert.equal(windows.key, 'windows');
  assert.equal(macos.key, 'macos');
});

test('native VM flavors expose their host concurrency caps', async () => {
  assert.equal(windows.maxConcurrent, 1, 'Windows Sandbox has a single-instance cap');
  assert.equal(macos.maxConcurrent, 2, 'macOS licensing permits two concurrent guests');
});

test('detectFlavors returns only available flavors, by reference', async () => {
  await withAvailability({
    linux: async () => true,
    windows: async () => true,
    macos: async () => false,
  }, async () => {
    const flavors = await detectFlavors();
    assert.deepEqual(flavors.map((f) => f.key), ['linux', 'windows']);
    assert.equal(flavors[0], linux, 'returns the singleton by reference');
    assert.equal(flavors[1], windows);
  });
});

test('detectFlavors filters candidates before probing availability', async () => {
  let linuxProbes = 0;
  await withAvailability({
    linux: async () => { linuxProbes += 1; return true; },
    windows: async () => true,
    macos: async () => true,
  }, async () => {
    assert.deepEqual((await detectFlavors(new Set(['windows']))).map((flavor) => flavor.key), ['windows']);
    assert.equal(linuxProbes, 0);
  });
});

test('detectFlavors treats a throwing available() as unavailable', async () => {
  await withAvailability({
    linux: async () => { throw new Error('runtime probe blew up'); },
    windows: async () => false,
    macos: async () => false,
  }, async () => {
    assert.deepEqual(await detectFlavors(), [], 'a flavor whose probe throws is excluded, not fatal');
  });
});

test('detectFlavors returns [] when the host can serve nothing', async () => {
  await withAvailability({
    linux: async () => false,
    windows: async () => false,
    macos: async () => false,
  }, async () => {
    assert.deepEqual(await detectFlavors(), []);
  });
});
