import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStub } from '../helpers/github-stub.js';
import { freshImport } from '../helpers/fresh-module.js';

async function withGithub(config, fn) {
  const previousToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  const stub = new GitHubStub(config).install();
  const github = await freshImport('../../src/github.js');
  try {
    return await fn(github, stub);
  } finally {
    stub.restore();
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
  }
}

test('sanitizeHostname normalizes hostnames for runner registration', async () => {
  const { sanitizeHostname } = await import('../../src/github.js');

  assert.equal(sanitizeHostname('buildbox.example.com'), 'buildbox');
  assert.equal(sanitizeHostname('--build___box!!--'), 'build-box');
  assert.equal(sanitizeHostname('...'), 'runner');
  assert.equal(sanitizeHostname('a'.repeat(50)), 'a'.repeat(40));
});

test('runnerNamePrefix uses the sanitized local hostname', async () => {
  const { runnerNamePrefix, sanitizeHostname } = await import('../../src/github.js');
  assert.equal(runnerNamePrefix(), `${sanitizeHostname()}-`);
});

test('generateJitConfig reuses the smallest free runner number', async () => {
  await withGithub({
    runners: {
      'alice/repo': [
        { id: 1, name: 'host-1', status: 'online', labels: [] },
        { id: 2, name: 'host-3', status: 'offline', labels: [] },
        { id: 3, name: 'other-2', status: 'online', labels: [] },
      ],
    },
    jitConfig: () => ({ encoded_jit_config: 'ENCODED', runner: { id: 55, name: 'host-2' } }),
  }, async (github, stub) => {
    const prefix = github.runnerNamePrefix();
    stub.runners.set('alice/repo', [
      { id: 1, name: `${prefix}1`, status: 'online', labels: [] },
      { id: 2, name: `${prefix}3`, status: 'offline', labels: [] },
      { id: 3, name: 'other-2', status: 'online', labels: [] },
    ]);

    await github.generateJitConfig('alice/repo', ['self-hosted']);

    const post = stub.callsMatching('POST', '/generate-jitconfig')[0];
    assert.equal(JSON.parse(post.body).name, `${prefix}2`);
  });
});

test('generateJitConfig increments when the first runner numbers are occupied', async () => {
  await withGithub({
    jitConfig: () => ({ encoded_jit_config: 'ENCODED', runner: { id: 56, name: 'host-3' } }),
  }, async (github, stub) => {
    const prefix = github.runnerNamePrefix();
    stub.runners.set('alice/repo', [
      { id: 1, name: `${prefix}1`, status: 'online', labels: [] },
      { id: 2, name: `${prefix}2`, status: 'offline', labels: [] },
    ]);

    await github.generateJitConfig('alice/repo', ['self-hosted']);

    const post = stub.callsMatching('POST', '/generate-jitconfig')[0];
    assert.equal(JSON.parse(post.body).name, `${prefix}3`);
  });
});
