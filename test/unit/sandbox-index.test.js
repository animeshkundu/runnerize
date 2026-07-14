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

test('windows/macos stubs are unavailable and throw a clear opt-in message on launch', async () => {
  assert.equal(await windows.available(), false);
  assert.equal(await macos.available(), false);
  await assert.rejects(() => windows.launch('cfg', {}), /windows flavor is a v1\.x opt-in/);
  await assert.rejects(() => macos.launch('cfg', {}), /macos flavor is a v1\.x opt-in/);
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
