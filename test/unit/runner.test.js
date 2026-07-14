import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubResponse } from '../helpers/github-stub.js';
import { SpawnStub } from '../helpers/process-stub.js';
import { freshImport } from '../helpers/fresh-module.js';

// runner.js talks to the actions/runner releases API via `fetch` and shells out to a
// container runtime via `spawn`. Both are stubbed, so version parsing / validation and
// the ensureImage inspect-then-pull flow run for real without touching the network or a
// real podman/docker.

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = original; });
}

test('latestRunnerVersion strips the leading v and validates semver', async () => {
  const runner = await freshImport('../../src/runner.js');
  await withFetch(async () => githubResponse({ tag_name: 'v2.317.0' }), async () => {
    assert.equal(await runner.latestRunnerVersion(), '2.317.0');
  });
});

test('latestRunnerVersion rejects a non-semver tag', async () => {
  const runner = await freshImport('../../src/runner.js');
  await withFetch(async () => githubResponse({ tag_name: 'nightly' }), async () => {
    await assert.rejects(() => runner.latestRunnerVersion(), /invalid tag/);
  });
});

test('latestRunnerVersion surfaces a non-OK release response', async () => {
  const runner = await freshImport('../../src/runner.js');
  await withFetch(async () => githubResponse({ message: 'rate limited' }, { status: 403 }), async () => {
    await assert.rejects(() => runner.latestRunnerVersion(), /HTTP 403/);
  });
});

test('ensureImage inspects first and does not pull when the image is present', async () => {
  const runner = await freshImport('../../src/runner.js');
  const stub = new SpawnStub((child) => {
    const args = child.args ?? [];
    if (args.includes('--version')) { child.emitStdout('podman 5\n'); child.close(0); return; }
    if (args.includes('inspect')) { child.emitStdout('[{}]\n'); child.close(0); return; } // present
    child.close(0);
  }).install();
  try {
    await runner.ensureImage('example/image:latest');
    assert.ok(stub.find('inspect'), 'inspected the image');
    assert.ok(!stub.find('pull'), 'did not pull because inspect succeeded');
  } finally {
    stub.restore();
  }
});

test('ensureImage pulls when inspect fails (image absent)', async () => {
  const runner = await freshImport('../../src/runner.js');
  const stub = new SpawnStub((child) => {
    const args = child.args ?? [];
    if (args.includes('--version')) { child.emitStdout('podman 5\n'); child.close(0); return; }
    if (args.includes('inspect')) { child.emitStderr('no such image\n'); child.close(1); return; } // absent
    if (args.includes('pull')) { child.emitStdout('pulled\n'); child.close(0); return; }
    child.close(0);
  }).install();
  try {
    await runner.ensureImage('example/image:latest');
    assert.ok(stub.find('pull'), 'pulled the missing image');
  } finally {
    stub.restore();
  }
});

test('ensureImage rejects when no container runtime is available', async () => {
  const runner = await freshImport('../../src/runner.js');
  const stub = new SpawnStub((child) => { child.fail(new Error('ENOENT')); }).install();
  try {
    await assert.rejects(() => runner.ensureImage('example/image:latest'), /podman or docker is required/);
  } finally {
    stub.restore();
  }
});

test('ensureImage validates its argument', async () => {
  const runner = await freshImport('../../src/runner.js');
  await assert.rejects(() => runner.ensureImage(''), TypeError);
  await assert.rejects(() => runner.ensureImage(null), TypeError);
});
