import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStub, githubResponse } from '../helpers/github-stub.js';
import { freshImport } from '../helpers/fresh-module.js';
import { ExecFileStub } from '../helpers/process-stub.js';

// Each test gets a fresh github.js so the module-level token cache, ETag cache, and
// rate-limit gate never leak between cases. GH_TOKEN short-circuits `getToken`.
async function withGithub(config, fn) {
  const prevToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  const stub = new GitHubStub(config).install();
  const gh = await freshImport('../../src/github.js');
  try {
    return await fn(gh, stub);
  } finally {
    stub.restore();
    if (prevToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevToken;
  }
}

test('findRunnerJob correlates a runner across active and completed workflow jobs', async () => {
  await withGithub({
    onRequest: (method, pathname, { url }) => {
      if (method === 'GET' && pathname === '/repos/me/repo/actions/runs') {
        const status = url.searchParams.get('status');
        return githubResponse({
          workflow_runs: status === 'in_progress'
            ? [{ id: 91, workflow_id: 93, name: 'CI' }]
            : [{ id: 94, workflow_id: 95, name: 'Release' }],
        });
      }
      if (method === 'GET' && pathname === '/repos/me/repo/actions/runs/91/jobs') {
        return githubResponse({ jobs: [{ id: 92, name: 'build', runner_name: 'runnerize-gen-1' }] });
      }
      if (method === 'GET' && pathname === '/repos/me/repo/actions/runs/94/jobs') {
        return githubResponse({ jobs: [] });
      }
      return undefined;
    },
  }, async (gh) => {
    assert.deepEqual(await gh.findRunnerJob('me/repo', 'runnerize-gen-1'), {
      workflowRunId: 91,
      workflowId: 93,
      workflowName: 'CI',
      workflowJobId: 92,
      workflowJobName: 'build',
    });
  });
});

test('findRunnerJob returns null when no job used the runner', async () => {
  await withGithub({
    onRequest: (method, pathname) => {
      if (method === 'GET' && pathname === '/repos/me/repo/actions/runs') {
        return githubResponse({ workflow_runs: [] });
      }
      return undefined;
    },
  }, async (gh) => {
    assert.equal(await gh.findRunnerJob('me/repo', 'missing-runner'), null);
    assert.equal(await gh.findRunnerJob('me/repo', ''), null);
  });
});

test('getToken resolves from GH_TOKEN and caches', async () => {
  const prev = process.env.GH_TOKEN;
  process.env.GH_TOKEN = '  env-token  ';
  const gh = await freshImport('../../src/github.js');
  try {
    assert.equal(await gh.getToken(), 'env-token', 'trims whitespace');
    process.env.GH_TOKEN = 'changed';
    assert.equal(await gh.getToken(), 'env-token', 'result is cached, not re-read');
  } finally {
    if (prev === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prev;
  }
});

test('getToken falls back to `gh auth token` when no env token', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const exec = new ExecFileStub((file, args) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['auth', 'token']);
    return { stdout: 'gh-cli-token\n', stderr: '' };
  }).install();
  const gh = await freshImport('../../src/github.js');
  try {
    assert.equal(await gh.getToken(), 'gh-cli-token');
    assert.equal(exec.calls.length, 1);
  } finally {
    exec.restore();
    if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
    if (prevGithub !== undefined) process.env.GITHUB_TOKEN = prevGithub;
  }
});

test('getToken re-resolves a CLI token after the cache TTL', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  const originalNow = Date.now;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  let now = 1_000;
  let tokenNumber = 0;
  Date.now = () => now;
  const exec = new ExecFileStub(() => {
    tokenNumber += 1;
    return { stdout: `gh-cli-token-${tokenNumber}\n`, stderr: '' };
  }).install();
  const gh = await freshImport('../../src/github.js');
  try {
    assert.equal(await gh.getToken(), 'gh-cli-token-1');
    now += 4 * 60_000;
    assert.equal(await gh.getToken(), 'gh-cli-token-1');
    now += 2 * 60_000;
    assert.equal(await gh.getToken(), 'gh-cli-token-2');
    assert.equal(exec.calls.length, 2);
  } finally {
    exec.restore();
    Date.now = originalNow;
    if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithub;
  }
});

test('getToken shares one CLI resolution across concurrent cache misses', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  let release;
  const exec = new ExecFileStub(() => new Promise((resolve) => { release = resolve; })).install();
  const gh = await freshImport('../../src/github.js');
  try {
    const first = gh.getToken();
    const second = gh.getToken();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(exec.calls.length, 1, 'concurrent callers share the same credential subprocess');
    release({ stdout: 'shared-token', stderr: '' });
    assert.deepEqual(await Promise.all([first, second]), ['shared-token', 'shared-token']);
  } finally {
    exec.restore();
    if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithub;
  }
});

test('api refreshes a CLI token once after 401 and retries the request', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  let tokenNumber = 0;
  const exec = new ExecFileStub(() => {
    tokenNumber += 1;
    return { stdout: `token-${tokenNumber}`, stderr: '' };
  }).install();
  const authorizations = [];
  let requestCount = 0;
  const stub = new GitHubStub({
    onRequest: (_method, _path, { headers }) => {
      requestCount += 1;
      authorizations.push(headers.get('authorization'));
      if (requestCount === 1) return githubResponse({ message: 'Bad credentials' }, { status: 401 });
      return githubResponse({ login: 'alice', type: 'User' });
    },
  }).install();
  const gh = await freshImport('../../src/github.js');
  try {
    assert.deepEqual(await gh.getUser(), { login: 'alice', type: 'User' });
    assert.equal(exec.calls.length, 2, 'the credential is resolved once initially and once after 401');
    assert.deepEqual(authorizations, ['Bearer token-1', 'Bearer token-2']);
  } finally {
    stub.restore();
    exec.restore();
    if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithub;
  }
});

test('api surfaces a second 401 after one token refresh', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  let tokenNumber = 0;
  const exec = new ExecFileStub(() => {
    tokenNumber += 1;
    return { stdout: `token-${tokenNumber}`, stderr: '' };
  }).install();
  const stub = new GitHubStub({
    onRequest: () => githubResponse({ message: 'Bad credentials' }, { status: 401 }),
  }).install();
  const gh = await freshImport('../../src/github.js');
  try {
    await assert.rejects(
      () => gh.getUser(),
      (error) => error.status === 401 && /after refreshing the token once/.test(error.message),
    );
    assert.equal(stub.calls.length, 2, 'the API request is attempted at most twice');
    assert.equal(exec.calls.length, 2, 'the credential is refreshed exactly once');
  } finally {
    stub.restore();
    exec.restore();
    if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithub;
  }
});

test('api reports that an environment token cannot be refreshed after 401', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  process.env.GH_TOKEN = 'env-token';
  delete process.env.GITHUB_TOKEN;
  const stub = new GitHubStub({
    onRequest: () => githubResponse({ message: 'Bad credentials' }, { status: 401 }),
  }).install();
  const gh = await freshImport('../../src/github.js');
  try {
    await assert.rejects(
      () => gh.getUser(),
      (error) => error.status === 401 && /GH_TOKEN\/GITHUB_TOKEN.*automatic refresh cannot help/.test(error.message),
    );
    assert.equal(stub.calls.length, 1, 'an environment credential is not retried pointlessly');
  } finally {
    stub.restore();
    if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithub;
  }
});

test('getToken makes DPAPI decrypt failures terminating PowerShell errors', async () => {
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  const prevLocal = process.env.LOCALAPPDATA;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const local = mkdtempSync(join(tmpdir(), 'runnerize-github-'));
  const tokenPath = join(local, 'runnerize', 'windows.token');
  mkdirSync(join(local, 'runnerize'));
  writeFileSync(tokenPath, 'encrypted');
  process.env.LOCALAPPDATA = local;
  const exec = new ExecFileStub((file, args) => {
    if (file === 'gh') throw new Error('not authenticated');
    assert.equal(file, 'powershell.exe');
    assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-NonInteractive']);
    assert.match(args.at(-1), /^\$ErrorActionPreference = 'Stop';/);
    return { stdout: 'decrypted-token', stderr: '' };
  }).install();
  const restorePlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  const gh = await freshImport('../../src/github.js');
  try {
    assert.equal(await gh.getToken(), 'decrypted-token');
  } finally {
    exec.restore();
    Object.defineProperty(process, 'platform', restorePlatform);
    rmSync(local, { recursive: true, force: true });
    if (prevGh === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevGh;
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prevGithub;
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = prevLocal;
  }
});

test('getUser returns login and type', async () => {
  await withGithub({ user: { login: 'alice', type: 'User' } }, async (gh) => {
    assert.deepEqual(await gh.getUser(), { login: 'alice', type: 'User' });
  });
});

test('listOwnedPrivateRepos filters to private, owned, User, non-fork, non-archived', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    repos: [
      { full_name: 'alice/keep', private: true },
      { full_name: 'alice/public', private: false },
      { full_name: 'alice/forked', private: true, fork: true },
      { full_name: 'alice/archived', private: true, archived: true },
      { full_name: 'org/owned', private: true, owner: { login: 'alice', type: 'Organization' } },
      { full_name: 'bob/other', private: true, owner: { login: 'bob', type: 'User' } },
      { full_name: 'alice/keep2', private: true },
    ],
  }, async (gh) => {
    const repos = await gh.listOwnedPrivateRepos();
    assert.deepEqual(repos.map((r) => r.full_name).sort(), ['alice/keep', 'alice/keep2']);
    assert.deepEqual(repos[0], { full_name: 'alice/keep', private: true, fork: false, archived: false });
  });
});

test('listOwnedPrivateRepos honors RUNNERIZE_EXCLUDE_REPOS (case-insensitive, comma/space)', async () => {
  const prior = process.env.RUNNERIZE_EXCLUDE_REPOS;
  process.env.RUNNERIZE_EXCLUDE_REPOS = 'Alice/KEEP2  alice/absent';
  try {
    await withGithub({
      user: { login: 'alice', type: 'User' },
      repos: [
        { full_name: 'alice/keep', private: true },
        { full_name: 'alice/keep2', private: true },
      ],
    }, async (gh) => {
      const repos = await gh.listOwnedPrivateRepos();
      assert.deepEqual(repos.map((r) => r.full_name), ['alice/keep'], 'excluded repo dropped case-insensitively');
    });
  } finally {
    if (prior === undefined) delete process.env.RUNNERIZE_EXCLUDE_REPOS;
    else process.env.RUNNERIZE_EXCLUDE_REPOS = prior;
  }
});

test('listOwnedPrivateRepos paginates across 100-item pages', async () => {
  const repos = Array.from({ length: 150 }, (_, i) => ({ full_name: `alice/repo-${i}`, private: true }));
  await withGithub({ user: { login: 'alice', type: 'User' }, repos }, async (gh, stub) => {
    const result = await gh.listOwnedPrivateRepos();
    assert.equal(result.length, 150, 'collects both pages');
    // page 1 (100) + page 2 (50) => two /user/repos GETs
    assert.equal(stub.countCalls('GET', '/user/repos'), 2);
  });
});

test('countQueuedMatchingJobs: label subset with OS-label requirement for non-default flavor', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    repos: [{ full_name: 'alice/repo', private: true }],
    runs: { 'alice/repo': [{ id: 1, status: 'queued' }] },
    jobs: {
      1: [
        { status: 'queued', labels: ['self-hosted', 'windows', 'x64'] }, // matches windows
        { status: 'queued', labels: ['self-hosted', 'x64'] },            // no os label -> excluded for windows
        { status: 'queued', labels: ['self-hosted', 'linux', 'x64'] },   // wrong os -> excluded
        { status: 'in_progress', labels: ['self-hosted', 'windows', 'x64'] }, // not queued
      ],
    },
  }, async (gh) => {
    const windowsLabels = ['self-hosted', 'windows', 'x64'];
    const count = await gh.countQueuedMatchingJobs('alice/repo', windowsLabels, { isDefault: false });
    assert.equal(count, 1, 'only the fully-labeled queued windows job counts');
  });
});

test('countQueuedMatchingJobs: bare [self-hosted] counts only for the default flavor', async () => {
  const config = {
    user: { login: 'alice', type: 'User' },
    repos: [{ full_name: 'alice/repo', private: true }],
    runs: { 'alice/repo': [{ id: 7, status: 'queued' }] },
    jobs: { 7: [{ status: 'queued', labels: ['self-hosted'] }] },
  };
  const linuxLabels = ['self-hosted', 'linux', 'x64'];

  await withGithub(config, async (gh) => {
    const asDefault = await gh.countQueuedMatchingJobs('alice/repo', linuxLabels, { isDefault: true });
    assert.equal(asDefault, 1, 'bare self-hosted is served by the default (linux) flavor');
  });
  await withGithub(config, async (gh) => {
    const nonDefault = await gh.countQueuedMatchingJobs('alice/repo', linuxLabels, { isDefault: false });
    assert.equal(nonDefault, 0, 'bare self-hosted requires the OS label when not default');
  });
});

test('countQueuedMatchingJobs: a KVM-capable linux flavor counts generic and KVM jobs once each', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    repos: [{ full_name: 'alice/repo', private: true }],
    runs: { 'alice/repo': [{ id: 8, status: 'queued' }] },
    jobs: {
      8: [
        { status: 'queued', labels: ['self-hosted', 'linux', 'x64'] },
        { status: 'queued', labels: ['self-hosted', 'linux', 'x64', 'kvm'] },
        { status: 'queued', labels: ['self-hosted', 'windows', 'x64'] },
      ],
    },
  }, async (gh) => {
    const count = await gh.countQueuedMatchingJobs(
      'alice/repo',
      ['self-hosted', 'linux', 'x64', 'kvm'],
      { isDefault: true },
    );
    assert.equal(count, 2, 'the added capability label does not become the OS discriminator');
  });
});

test('countQueuedMatchingJobs: case-insensitive labels', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    repos: [{ full_name: 'alice/repo', private: true }],
    runs: { 'alice/repo': [{ id: 3, status: 'in_progress' }] },
    jobs: { 3: [{ status: 'queued', labels: ['Self-Hosted', 'Linux', 'X64'] }] },
  }, async (gh) => {
    const count = await gh.countQueuedMatchingJobs('alice/repo', ['self-hosted', 'linux', 'x64'], { isDefault: true });
    assert.equal(count, 1, 'label matching is case-insensitive');
  });
});

test('countQueuedMatchingJobs: dedups runs surfaced by both queued and in_progress scans', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    repos: [{ full_name: 'alice/repo', private: true }],
    // Same run id under both scans should be counted once, not twice.
    runs: { 'alice/repo': [{ id: 42, status: 'queued' }, { id: 42, status: 'in_progress' }] },
    jobs: { 42: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
  }, async (gh, stub) => {
    const count = await gh.countQueuedMatchingJobs('alice/repo', ['self-hosted', 'linux', 'x64'], { isDefault: true });
    assert.equal(count, 1, 'run 42 is deduped by id across the two status scans');
    assert.equal(stub.countCalls('GET', '/actions/runs/42/jobs'), 1, 'jobs fetched once for the deduped run');
  });
});

test('countQueuedMatchingJobs: surfaces needs-gated / matrix queued jobs inside in_progress runs', async () => {
  // A matrix or `needs`-gated run is often in_progress while a downstream job is still queued.
  await withGithub({
    user: { login: 'alice', type: 'User' },
    repos: [{ full_name: 'alice/repo', private: true }],
    runs: { 'alice/repo': [{ id: 9, status: 'in_progress' }] },
    jobs: {
      9: [
        { status: 'completed', labels: ['self-hosted', 'linux', 'x64'] },
        { status: 'queued', labels: ['self-hosted', 'linux', 'x64'] },
        { status: 'queued', labels: ['self-hosted', 'linux', 'x64'] },
      ],
    },
  }, async (gh) => {
    const count = await gh.countQueuedMatchingJobs('alice/repo', ['self-hosted', 'linux', 'x64'], { isDefault: true });
    assert.equal(count, 2, 'queued jobs inside an in_progress run are counted');
  });
});

test('api: ETag 304 returns cached data', async () => {
  await withGithub({ user: { login: 'alice', type: 'User' } }, async (gh, stub) => {
    const first = await gh.api('GET', '/user', { etagKey: 'user' });
    assert.equal(first.status, 200);
    assert.equal(first.notModified, false);

    const second = await gh.api('GET', '/user', { etagKey: 'user' });
    assert.equal(second.status, 304);
    assert.equal(second.notModified, true);
    assert.deepEqual(second.data, { login: 'alice', type: 'User' }, 'cached body returned on 304');

    const conditional = stub.callsMatching('GET', '/user').filter((c) => c.ifNoneMatch);
    assert.ok(conditional.length >= 1, 'client sent If-None-Match on the second call');
  });
});

test('api: bounded ETag cache evicts past the cap (no unbounded growth)', async () => {
  // All /user calls share one server-side ETag, so whether the client sends
  // If-None-Match is a direct readout of its cache membership. The cache is keyed by
  // the caller's etagKey and capped at 500 (LRU). k0 is inserted first and never
  // reused, so crossing the cap must evict it.
  await withGithub({ user: { login: 'alice', type: 'User' } }, async (gh, stub) => {
    await gh.api('GET', '/user', { etagKey: 'k0' }); // 200, caches k0
    for (let i = 1; i <= 500; i += 1) {
      await gh.api('GET', '/user', { etagKey: `k${i}` }); // inserting k500 pushes size to 501 -> evict k0
    }

    const evicted = await gh.api('GET', '/user', { etagKey: 'k0' });
    assert.equal(evicted.notModified, false, 'k0 was evicted, so it re-fetches fresh (200)');

    const kept = await gh.api('GET', '/user', { etagKey: 'k500' });
    assert.equal(kept.notModified, true, 'k500 is still cached, so it 304s');

    const k0Calls = stub.callsMatching('GET', '/user');
    const lastK0 = k0Calls[k0Calls.length - 2]; // the second-to-last /user call is the k0 re-fetch
    assert.equal(lastK0.ifNoneMatch, null, 'no conditional header on the evicted key');
  });
});

test('api: ETag cache is LRU — a re-touched key survives eviction while a stale one is dropped', async () => {
  // Distinct from the FIFO cap test: this pins down the *recency* bump at
  // `etagCache.delete(etagKey)` (before re-set) in src/github.js. That move only happens
  // on a fresh 200 — a 304 returns early without touching the cache — so we drive it via
  // per-repo listRunners endpoints (each carries its OWN server ETag, unlike the shared
  // /user etag) and bump just the `hot` repo's ETag to force a 200 re-read. In a pure-FIFO
  // cache `hot` (oldest by insertion) evicts first; in the real LRU cache the 200 re-read
  // makes it most-recently-used, so `cold` (inserted second, never re-touched) evicts
  // instead. Removing the production recency re-touch flips this and fails the test.
  const runnersFor = (n) => ({ [`me/${n}`]: [{ id: 1, name: `runnerize-${n}`, status: 'offline', labels: [] }] });
  const fillers = Array.from({ length: 497 }, (_, i) => `f${i}`);
  const runners = Object.assign({}, runnersFor('hot'), runnersFor('cold'),
    ...fillers.map((n) => runnersFor(n)));

  await withGithub({ user: { login: 'me', type: 'User' }, runners }, async (gh, stub) => {
    await gh.listRunners('me/hot');   // caches etagKey runners:me/hot:1 (oldest)
    await gh.listRunners('me/cold');  // caches runners:me/cold:1 (second oldest)
    for (const n of fillers) await gh.listRunners(`me/${n}`); // fill to the cap (499 entries)

    // Force `hot`'s re-read to be a fresh 200 so the recency move fires.
    stub.bumpEtag('runners:me/hot:1');
    const hotReadCallsBefore = stub.countCalls('GET', /\/me\/hot\/actions\/runners$/);
    await gh.listRunners('me/hot'); // 200 -> recency bump to most-recently-used
    assert.equal(stub.countCalls('GET', /\/me\/hot\/actions\/runners$/), hotReadCallsBefore + 1);

    // Cross the cap. FIFO would evict hot then cold; LRU (hot just re-touched) spares hot.
    await gh.listRunners('me/push1'); // size 500
    await gh.listRunners('me/push2'); // size 501 -> evict oldest

    // Whether a cached key survived is read out from whether the next GET is conditional.
    const hotCalls = () => stub.callsMatching('GET', /\/me\/hot\/actions\/runners$/);
    const coldCalls = () => stub.callsMatching('GET', /\/me\/cold\/actions\/runners$/);

    await gh.listRunners('me/hot');
    const lastHot = hotCalls().at(-1);
    assert.ok(lastHot.ifNoneMatch, 'the re-touched (hot) key survived eviction — sends If-None-Match (LRU, not FIFO)');

    await gh.listRunners('me/cold');
    const lastCold = coldCalls().at(-1);
    assert.equal(lastCold.ifNoneMatch, null, 'the never-re-touched (cold) key was evicted — no If-None-Match');
  });
});

test('api: retries on secondary rate limit then succeeds (capped)', async () => {
  let hits = 0;
  await withGithub({
    user: { login: 'alice', type: 'User' },
    faults: {
      user: () => {
        hits += 1;
        if (hits === 1) {
          return githubResponse({ message: 'You have exceeded a secondary rate limit' }, {
            status: 403,
            headers: { 'retry-after': '0' },
          });
        }
        return githubResponse({ login: 'alice', type: 'User' });
      },
    },
  }, async (gh) => {
    const user = await gh.getUser();
    assert.deepEqual(user, { login: 'alice', type: 'User' });
    assert.equal(hits, 2, 'retried once after the secondary-rate-limit 403');
  });
});

test('api: abortable — a pre-aborted signal rejects promptly', async () => {
  await withGithub({ user: { login: 'alice', type: 'User' } }, async (gh) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => gh.getUser({ signal: controller.signal }),
      (err) => err.name === 'AbortError' || /abort/i.test(err.message),
    );
  });
});

test('isStillPrivate: true for a private, owned, User repo', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    repos: [{ full_name: 'alice/repo', private: true }],
  }, async (gh) => {
    assert.equal(await gh.isStillPrivate('alice/repo'), true);
  });
});

test('isStillPrivate: fails CLOSED (false) when the repo went public', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    privateOverrides: { 'alice/repo': false },
  }, async (gh) => {
    assert.equal(await gh.isStillPrivate('alice/repo'), false);
  });
});

test('isStillPrivate: fails CLOSED (false) on API error', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    faults: { repo: () => githubResponse({ message: 'boom' }, { status: 500 }) },
  }, async (gh) => {
    assert.equal(await gh.isStillPrivate('alice/repo'), false, 'error is treated as not-private');
  });
});

test('isStillPrivate: rethrows a caller abort (does not swallow as false)', async () => {
  await withGithub({ user: { login: 'alice', type: 'User' } }, async (gh) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => gh.isStillPrivate('alice/repo', { signal: controller.signal }),
      (err) => err.name === 'AbortError' || /abort/i.test(err.message),
      'an aborted re-check rethrows rather than reporting a false negative',
    );
  });
});

test('generateJitConfig returns { encodedJitConfig, runnerId, runnerName }', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    jitConfig: (full) => {
      assert.equal(full, 'alice/repo');
      return { encoded_jit_config: 'ENCODED', runner: { id: 55, name: 'runnerize-abcd' } };
    },
  }, async (gh, stub) => {
    const result = await gh.generateJitConfig('alice/repo', ['self-hosted', 'linux', 'x64']);
    assert.deepEqual(result, { encodedJitConfig: 'ENCODED', runnerId: 55, runnerName: 'runnerize-abcd' });

    const post = stub.callsMatching('POST', '/generate-jitconfig')[0];
    const body = JSON.parse(post.body);
    assert.equal(body.runner_group_id, 1, 'runner_group_id 1 is sent');
    assert.equal(body.work_folder, '_work');
    assert.deepEqual(body.labels, ['self-hosted', 'linux', 'x64']);
    assert.equal(body.name, `${gh.runnerNamePrefix()}1`, 'name uses the first available hostname slot');
  });
});

test('generateJitConfig throws on an incomplete response', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    jitConfig: () => ({ encoded_jit_config: 'X' }), // missing runner.id / runner.name
  }, async (gh) => {
    await assert.rejects(
      () => gh.generateJitConfig('alice/repo', ['self-hosted', 'linux', 'x64']),
      /complete JIT runner config/,
    );
  });
});

test('listRunners normalizes id/name/status/labels (string and object labels)', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    runners: {
      'alice/repo': [
        { id: 1, name: 'runnerize-a', status: 'online', busy: true, labels: ['self-hosted', { name: 'linux' }, 'x64'] },
        { id: 2, name: 'other', status: 'offline', labels: undefined },
      ],
    },
  }, async (gh) => {
    const runners = await gh.listRunners('alice/repo');
    assert.deepEqual(runners[0], {
      id: 1, name: 'runnerize-a', status: 'online', busy: true, labels: ['self-hosted', 'linux', 'x64'],
    });
    assert.deepEqual(runners[1].labels, [], 'missing labels normalize to []');
  });
});

test('deleteRunner: succeeds and tolerates a 404 (already gone)', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    runners: { 'alice/repo': [{ id: 9, name: 'runnerize-x', status: 'offline', labels: [] }] },
  }, async (gh, stub) => {
    await gh.deleteRunner('alice/repo', 9);
    assert.equal((stub.runners.get('alice/repo') ?? []).length, 0, 'runner removed');
    // Deleting again hits a 404 in the stub, which deleteRunner must swallow.
    await assert.doesNotReject(() => gh.deleteRunner('alice/repo', 9));
  });
});

test('deleteRunner: throws on a non-404 error status', async () => {
  await withGithub({
    user: { login: 'alice', type: 'User' },
    faults: { deleteRunner: () => githubResponse({ message: 'forbidden' }, { status: 403 }) },
  }, async (gh) => {
    await assert.rejects(() => gh.deleteRunner('alice/repo', 9), /status 403/);
  });
});
