import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollDelay, runDispatcher } from '../../src/dispatcher.js';
import { runnerNamePrefix } from '../../src/github.js';
import { GitHubStub, githubResponse } from '../helpers/github-stub.js';
import { FakeFlavor, installFakeFlavor, waitFor, tick } from '../helpers/dispatcher-harness.js';

// A dispatcher test session: installs the GitHub stub + a controllable linux flavor,
// runs the real dispatcher against them, and guarantees teardown (settle held launches,
// abort, await the drain) so nothing leaks into the next test through the shared
// singletons / module state.
async function runSession({ github, flavor, options = {} }, body) {
  const drainWaiters = [];
  const drainDelay = () => new Promise((resolve) => { drainWaiters.push(resolve); });
  const expireDrain = async () => {
    for (const resolve of drainWaiters.splice(0)) resolve();
    await Promise.resolve();
  };
  const prevToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'test-token';
  // 304s would let stale cached bodies leak across tests that reuse repo names; the mint
  // algorithm (not the ETag cache) is what these tests exercise, so serve fresh 200s.
  const stub = new GitHubStub({ enable304: false, ...github }).install();
  const restoreFlavor = installFakeFlavor(flavor);
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => { try { logs.push(JSON.parse(line)); } catch { /* ignore */ } };

  const controller = new AbortController();
  let dispatcherPromise;
  const start = (extra = {}) => {
    dispatcherPromise = runDispatcher({
      maxConcurrent: 4,
      pollIntervalMs: 20,
      idleTimeoutMs: 120_000,
      reconcileMs: 10_000_000, // effectively "reconcile once at startup" unless overridden
      signal: controller.signal,
      drainDelay,
      ...options,
      ...extra,
    });
    return dispatcherPromise;
  };

  try {
    return await body({
      stub,
      flavor,
      controller,
      start,
      expireDrain,
      logs,
      events: (name) => logs.filter((l) => l.event === name),
    });
  } finally {
    console.log = originalLog;
    controller.abort();
    // Release any launches the test left holding so the drain can complete.
    for (const launch of flavor.launches) {
      if (!launch.settledForCleanup) {
        launch.settledForCleanup = true;
        try { launch.succeed(); } catch { /* already settled */ }
      }
    }
    try {
      if (dispatcherPromise) {
        await Promise.race([
          dispatcherPromise.catch(() => {}),
          tick(3000).then(() => { throw new Error('dispatcher did not drain within 3s'); }),
        ]);
      }
    } finally {
      // Always restore shared state, even if the drain timed out or threw, so
      // globalThis.fetch / the flavor singletons / GH_TOKEN never leak into the next test.
      restoreFlavor();
      stub.restore();
      if (prevToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = prevToken;
    }
  }
}

// A flavor behavior that holds every launch open (started, but not settled) until the
// test releases it — the tool for observing the mint counters at a fixed point.
function holdingBehavior({ markStarted = false } = {}) {
  return (launch) => { if (markStarted) launch.markStarted(); /* never settle */ };
}

test('runDispatcher validates its numeric options', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(() => runDispatcher({ maxConcurrent: 0, signal }), TypeError);
  await assert.rejects(() => runDispatcher({ maxConcurrent: 1.5, signal }), TypeError);
  await assert.rejects(() => runDispatcher({ pollIntervalMs: 0, signal }), TypeError);
  await assert.rejects(() => runDispatcher({ pollIntervalMs: 20, pollMaxIntervalMs: 19, signal }), TypeError);
  await assert.rejects(() => runDispatcher({ pollMaxIntervalMs: 0, signal }), TypeError);
  await assert.rejects(() => runDispatcher({ idleTimeoutMs: -1, signal }), TypeError);
  await assert.rejects(() => runDispatcher({ reconcileMs: 0, signal }), TypeError);
});

test('default poll maximum derives from the configured base interval', { concurrency: false }, async () => {
  const previous = process.env.RUNNERIZE_POLL_MAX_INTERVAL_MS;
  delete process.env.RUNNERIZE_POLL_MAX_INTERVAL_MS;
  const controller = new AbortController();
  controller.abort();

  try {
    await assert.doesNotReject(() => runDispatcher({
      pollIntervalMs: 5_000,
      signal: controller.signal,
      keepAwake: false,
    }));
  } finally {
    if (previous === undefined) delete process.env.RUNNERIZE_POLL_MAX_INTERVAL_MS;
    else process.env.RUNNERIZE_POLL_MAX_INTERVAL_MS = previous;
  }
});

test('poll delay follows the geometric active-job interval table', () => {
  const cases = [
    { activeJobs: 0, expected: 100 },
    { activeJobs: 1, expected: 400 },
    { activeJobs: 2, expected: 800 },
    { activeJobs: 3, expected: 1600 },
    { activeJobs: 4, expected: 3200 },
  ];

  for (const { activeJobs, expected } of cases) {
    assert.equal(pollDelay({
      baseMilliseconds: 100,
      capMilliseconds: 3200,
      activeJobs,
      random: () => 0.5,
    }), expected, `${activeJobs} active jobs`);
  }
});

test('poll delay stops at five active jobs', () => {
  assert.equal(pollDelay({
    baseMilliseconds: 100,
    capMilliseconds: 3200,
    activeJobs: 5,
    random: () => 0.5,
  }), null);
});

test('poll delay jitters regular and post-claim intervals within the configured cap', () => {
  const idle = [0, 0.5, 1].map((random) => pollDelay({
    baseMilliseconds: 100,
    capMilliseconds: 3200,
    activeJobs: 0,
    random: () => random,
  }));
  const regular = [0, 0.5, 1].map((random) => pollDelay({
    baseMilliseconds: 100,
    capMilliseconds: 3200,
    activeJobs: 2,
    random: () => random,
  }));
  const claimed = [0, 0.5, 1].map((random) => pollDelay({
    baseMilliseconds: 100,
    capMilliseconds: 3200,
    activeJobs: 1,
    claimed: true,
    random: () => random,
  }));

  assert.deepEqual(idle, [75, 100, 125]);
  assert.deepEqual(regular, [600, 800, 1000]);
  assert.deepEqual(claimed, [1500, 2000, 2500]);
  assert.equal(pollDelay({
    baseMilliseconds: 100,
    capMilliseconds: 500,
    activeJobs: 4,
    random: () => 1,
  }), 500);
});

test('claims at most one job per poll even when demand and capacity are higher', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: false });
  let repoPolls = 0;
  await runSession({
    flavor,
    options: { maxConcurrent: 5, pollIntervalMs: 1000, random: () => 0.5 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/cap', private: true }],
      runs: { 'me/cap': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 5 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
      onRequest: (method, pathname) => {
        if (method === 'GET' && pathname === '/user/repos') repoPolls += 1;
        return undefined;
      },
    },
  }, async ({ start, flavor }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 1));
    assert.equal(repoPolls, 1, 'the first poll cycle claims exactly one job');
    assert.equal(flavor.launches.length, 1, 'free capacity does not cause a mint loop');
  });
});

test('hard cap stops polling at five active jobs even when configured concurrency is higher', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: true });
  await runSession({
    flavor,
    options: { maxConcurrent: 6, pollIntervalMs: 1, pollMaxIntervalMs: 32, random: () => 0.5 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/hard-cap', private: true }],
      runs: { 'me/hard-cap': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 8 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
    },
  }, async ({ start, flavor, stub }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 5, { timeoutMs: 2000 }));
    const pollsAtCap = stub.countCalls('GET', '/user/repos');
    await tick(100);
    assert.equal(flavor.launches.length, 5, 'the machine never exceeds five active jobs');
    assert.equal(stub.countCalls('GET', '/user/repos'), pollsAtCap, 'polling stops completely at the cap');
  });
});

test('post-claim quiet period is twenty base intervals and remains jittered', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: true });
  const pollTimes = [];
  await runSession({
    flavor,
    options: { maxConcurrent: 5, pollIntervalMs: 10, pollMaxIntervalMs: 320, random: () => 0 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/quiet', private: true }],
      runs: { 'me/quiet': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 2 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
      onRequest: (method, pathname) => {
        if (method === 'GET' && pathname === '/user/repos') pollTimes.push(Date.now());
        return undefined;
      },
    },
  }, async ({ start, flavor }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 1));
    await tick(100);
    assert.equal(flavor.launches.length, 1, 'no second claim before the jittered 15x quiet period');
    assert.ok(await waitFor(() => flavor.launches.length === 2, { timeoutMs: 200 }));
    assert.ok(pollTimes[1] - pollTimes[0] >= 140, `quiet period was ${pollTimes[1] - pollTimes[0]}ms`);
    assert.ok(pollTimes[1] - pollTimes[0] < 260, `quiet period was ${pollTimes[1] - pollTimes[0]}ms`);
  });
});

test('repo-count scaling remains additive and preserves jitter at the cap', () => {
  const capped = [0, 0.5, 1].map((random) => pollDelay({
    baseMilliseconds: 100,
    capMilliseconds: 800,
    activeJobs: 2,
    repoCount: 21,
    random: () => random,
  }));
  const uncapped = [0, 0.5, 1].map((random) => pollDelay({
    baseMilliseconds: 100,
    capMilliseconds: 3200,
    activeJobs: 1,
    repoCount: 21,
    random: () => random,
  }));

  assert.deepEqual(capped, [600, 800, 800]);
  assert.deepEqual(uncapped, [600, 800, 1000]);
});

test('repo-count scaling does not alter the post-claim quiet period', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: true });
  const repos = Array.from({ length: 21 }, (_, index) => ({
    full_name: `me/quiet-repo-${index}`,
    private: true,
  }));
  const pollTimes = [];
  await runSession({
    flavor,
    options: { pollIntervalMs: 10, pollMaxIntervalMs: 320, random: () => 0.5 },
    github: {
      user: { login: 'me', type: 'User' },
      repos,
      runs: { 'me/quiet-repo-0': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 2 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
      onRequest: (method, pathname) => {
        if (method === 'GET' && pathname === '/user/repos') pollTimes.push(Date.now());
        return undefined;
      },
    },
  }, async ({ start, flavor }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 2, { timeoutMs: 300 }));
    const elapsed = pollTimes[1] - pollTimes[0];
    assert.ok(elapsed >= 180 && elapsed < 300, `post-claim delay was ${elapsed}ms`);
  });
});

test('polling resumes when a job completes at the hard cap', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: true });
  await runSession({
    flavor,
    options: { maxConcurrent: 6, pollIntervalMs: 1, pollMaxIntervalMs: 32, random: () => 0.5 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/recovery', private: true }],
      runs: { 'me/recovery': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 8 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
    },
  }, async ({ start, flavor, stub }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 5, { timeoutMs: 2000 }));
    const pollsAtCap = stub.countCalls('GET', '/user/repos');

    flavor.launches[0].succeed({ startedJob: true });

    assert.ok(await waitFor(
      () => stub.countCalls('GET', '/user/repos') > pollsAtCap,
      { timeoutMs: 200 },
    ), 'slot completion wakes the capped dispatcher');
    assert.ok(await waitFor(() => flavor.launches.length === 6, { timeoutMs: 200 }),
      'the resumed poll can claim one replacement job');
  });
});

test('per-flavor cap remains held after assignment until the launch exits', async () => {
  const flavor = new FakeFlavor({ maxConcurrent: 1 });
  flavor.behavior = holdingBehavior({ markStarted: true });
  await runSession({
    flavor,
    options: { maxConcurrent: 4 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/windows', private: true }],
      runs: { 'me/windows': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 3 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
    },
  }, async ({ start, flavor }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 1), 'the first runner launches');
    await tick(120);
    assert.equal(flavor.launches.length, 1, 'assignment does not free the flavor slot');
  });
});

test('a flavor without maxConcurrent remains limited only by the global semaphore', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: true });
  await runSession({
    flavor,
    options: { maxConcurrent: 3 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/uncapped', private: true }],
      runs: { 'me/uncapped': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 3 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
    },
  }, async ({ start, flavor }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 3), 'all global slots remain usable');
  });
});

test('is count-based, never job-pinned: mints one runner per unit of demand, no job id in the request', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior();
  await runSession({
    flavor,
    options: { maxConcurrent: 10 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/a', private: true }, { full_name: 'me/b', private: true }],
      runs: { 'me/a': [{ id: 11, status: 'queued' }], 'me/b': [{ id: 22, status: 'queued' }] },
      jobs: {
        11: [
          { status: 'queued', labels: ['self-hosted', 'linux', 'x64'] },
          { status: 'queued', labels: ['self-hosted', 'linux', 'x64'] },
        ],
        22: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }],
      },
    },
  }, async ({ start, flavor, stub }) => {
    start();
    // Total demand = 3 (2 in repo a + 1 in repo b). Count-based => exactly 3 runners.
    const reached = await waitFor(() => flavor.launches.length === 3);
    assert.ok(reached, `expected 3 launches, saw ${flavor.launches.length}`);
    await tick(80);
    assert.equal(flavor.launches.length, 3, 'mints exactly demand, no more');

    // Every JIT request carries only { name, runner_group_id, labels, work_folder } —
    // never a job id (the count model never pins a runner to a specific job).
    const jitPosts = stub.callsMatching('POST', '/generate-jitconfig');
    assert.equal(jitPosts.length, 3);
    for (const post of jitPosts) {
      const body = JSON.parse(post.body);
      assert.deepEqual(Object.keys(body).sort(), ['labels', 'name', 'runner_group_id', 'work_folder']);
      assert.ok(!('job_id' in body) && !('job' in body));
    }
  });
});

test('KVM capability is one linux flavor: demand is counted once and labels reach JIT minting', async () => {
  const flavor = new FakeFlavor({ labels: ['self-hosted', 'linux', 'x64', 'kvm'] });
  flavor.behavior = holdingBehavior();
  await runSession({
    flavor,
    options: { maxConcurrent: 10 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/kvm', private: true }],
      runs: { 'me/kvm': [{ id: 1, status: 'queued' }] },
      jobs: {
        1: [
          { status: 'queued', labels: ['self-hosted', 'linux', 'x64'] },
          { status: 'queued', labels: ['self-hosted', 'linux', 'x64', 'kvm'] },
        ],
      },
    },
  }, async ({ start, flavor, stub }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 2));
    await tick(80);
    assert.equal(flavor.launches.length, 2, 'the capable linux flavor does not double-count either job');
    const jitPosts = stub.callsMatching('POST', '/generate-jitconfig');
    assert.equal(jitPosts.length, 2);
    for (const post of jitPosts) {
      assert.deepEqual(JSON.parse(post.body).labels, ['self-hosted', 'linux', 'x64', 'kvm']);
    }
  });
});

test('damps double-mint across polls: inflight unassigned is subtracted from demand', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior(); // hold launches so unassigned stays elevated
  await runSession({
    flavor,
    options: { maxConcurrent: 10 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/damp', private: true }],
      runs: { 'me/damp': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
    },
  }, async ({ start, flavor }) => {
    start();
    // Demand is 1; after the first mint, unassigned=1 so toMint=0 forever after.
    await waitFor(() => flavor.launches.length === 1);
    await tick(120); // many poll cycles
    assert.equal(flavor.launches.length, 1, 'a single queued job mints exactly one runner across many polls');
  });
});

test('two-counter model: onStarted decrements unassigned exactly once (settle does not double-count)', async () => {
  // Repo has 2 queued jobs, capacity 3. Cycle 1 mints 2 (both held, unstarted).
  // Then start+settle launch #1. If `unassigned` were decremented by BOTH onStarted and
  // settle, it would drop to 0 and the next cycle would over-mint 2 more. The correct
  // exactly-once behavior leaves unassigned at 1, so the next cycle mints exactly 1.
  const flavor = new FakeFlavor();
  const held = [];
  flavor.behavior = (launch) => { held.push(launch); /* hold: neither start nor settle */ };
  await runSession({
    flavor,
    options: { maxConcurrent: 3 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/two', private: true }],
      runs: { 'me/two': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 2 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
    },
  }, async ({ start, flavor }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 2), 'first epoch mints 2');
    await tick(80);
    assert.equal(flavor.launches.length, 2, 'stable at 2 while both are held');

    // Consume launch #1: it starts a job (onStarted) and then settles successfully.
    held[0].markStarted();
    held[0].succeed({ startedJob: true });

    // Exactly one unit of unassigned freed => exactly one additional mint (total 3),
    // and then stable. A double-decrement bug would push this to 4.
    assert.ok(await waitFor(() => flavor.launches.length === 3), 'freeing one started runner mints exactly one more');
    await tick(100);
    assert.equal(flavor.launches.length, 3, 'no over-mint: settle did not double-decrement unassigned');
  });
});

test('runner completion interrupts a full-host backoff and triggers a prompt poll', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: true });
  await runSession({
    flavor,
    options: { maxConcurrent: 1, pollIntervalMs: 20, pollMaxIntervalMs: 2000, random: () => 0.5 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/wakeup', private: true }],
      runs: { 'me/wakeup': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
    },
  }, async ({ start, flavor, stub }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 1), 'the first runner launches');
    await tick(50); // let the poll cycle enter its full-host backoff
    const pollsBeforeCompletion = stub.countCalls('GET', '/user/repos');
    stub.jobs.set('1', []);

    flavor.launches[0].succeed({ startedJob: true });

    assert.ok(await waitFor(
      () => stub.countCalls('GET', '/user/repos') > pollsBeforeCompletion,
      { timeoutMs: 500 },
    ), 'slot release wakes polling well before the 2s full-host fallback');
  });
});

test('semaphore is released on the success path so later demand can still be served', async () => {
  const flavor = new FakeFlavor(); // default behavior: start + settle immediately
  const perLaunch = [];
  flavor.behavior = (launch) => { perLaunch.push(launch); launch.markStarted(); launch.succeed(); };
  await runSession({
    flavor,
    options: { maxConcurrent: 1 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/serial', private: true }],
      runs: { 'me/serial': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
    },
  }, async ({ start, flavor }) => {
    start();
    // With capacity 1 and a persistent single job, each completed launch must release
    // the slot so the next poll can mint again. Several launches over time proves the
    // release path runs (a leaked slot would freeze at 1 forever).
    const reached = await waitFor(() => flavor.launches.length >= 3, { timeoutMs: 3000 });
    assert.ok(reached, `expected repeated mints via slot release, saw ${flavor.launches.length}`);
  });
});

test('deregisters the runner when launch fails, backs the repo off, and keeps the slot reusable', async () => {
  const flavor = new FakeFlavor();
  let failures = 0;
  flavor.behavior = (launch) => { failures += 1; launch.fail(new Error('container refused to start')); };
  await runSession({
    flavor,
    options: { maxConcurrent: 2 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/broken', private: true }],
      runs: { 'me/broken': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
    },
  }, async ({ start, stub, events }) => {
    start();
    // First launch fails => deregister the just-minted runner id (1001).
    assert.ok(await waitFor(() => stub.countCalls('DELETE', /\/actions\/runners\/1001$/) >= 1),
      'a failed launch deletes its own registration');

    // Per-repo backoff (30s) means the repo is not retried within the test window, so
    // only the single failed launch was ever minted despite persistent demand.
    await tick(200);
    assert.equal(failures, 1, 'the backed-off repo is not immediately retried');
    assert.equal(stub.countCalls('POST', '/generate-jitconfig'), 1, 'only one mint attempt within the backoff window');

    const deregistered = events('runner_launch_error');
    assert.ok(deregistered.length >= 1, 'the launch failure was logged');
  });
});

test('deregister-on-failure still runs when GitHub returns a partial config (no leaked runner)', async () => {
  // generateJitConfig throws on an incomplete response *before* a runner id is known, so
  // there is nothing to deregister; assert the dispatcher backs off and does not crash.
  const flavor = new FakeFlavor();
  await runSession({
    flavor,
    options: { maxConcurrent: 2 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/partial', private: true }],
      runs: { 'me/partial': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
      jitConfig: () => ({ encoded_jit_config: 'X' }), // missing runner.id/name
    },
  }, async ({ start, events }) => {
    start();
    assert.ok(await waitFor(() => events('runner_launch_error').length >= 1),
      'the incomplete-config error is caught and logged, not crashed');
  });
});

test('re-checks privacy immediately before mint and fails closed (no mint, no JIT) when public', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior();
  await runSession({
    flavor,
    options: { maxConcurrent: 4 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/leaky', private: true }],
      runs: { 'me/leaky': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
      // The listing said private, but the pre-mint re-check says it went public.
      privateOverrides: { 'me/leaky': false },
    },
  }, async ({ start, stub, flavor, events }) => {
    start();
    assert.ok(await waitFor(() => events('mint_skipped_not_private').length >= 1),
      'mint is skipped when the pre-mint privacy re-check fails closed');
    await tick(80);
    assert.equal(flavor.launches.length, 0, 'no runner launched for a repo that went public');
    assert.equal(stub.countCalls('POST', '/generate-jitconfig'), 0, 'no JIT config generated for a public repo');
  });
});

test('reconcile deletes this host\'s offline registrations but leaves foreign/online ones', async () => {
  const flavor = new FakeFlavor();
  const prefix = runnerNamePrefix();
  flavor.available = async () => true; // active flavor scopes reconcile; there is no demand to mint
  await runSession({
    flavor,
    options: { maxConcurrent: 2, reconcileMs: 10_000_000 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/recon', private: true }],
      runners: {
        'me/recon': [
          { id: 1, name: `${prefix}1`, status: 'offline', labels: ['SELF-HOSTED', 'Linux', 'X64'] },
          { id: 2, name: `${prefix}2`, status: 'online', labels: ['self-hosted', 'linux', 'x64'] },
          { id: 3, name: 'someones-runner', status: 'offline', labels: ['self-hosted', 'linux', 'x64'] },
        ],
      },
    },
  }, async ({ start, stub, events }) => {
    start();
    assert.ok(await waitFor(() => events('reconcile_complete').length >= 1), 'a reconcile pass ran');
    assert.equal(stub.countCalls('DELETE', /\/actions\/runners\/1$/), 1, 'this host\'s offline runner is removed');
    assert.equal(stub.countCalls('DELETE', /\/actions\/runners\/2$/), 0, 'this host\'s online runner is kept');
    assert.equal(stub.countCalls('DELETE', /\/actions\/runners\/3$/), 0, 'a foreign runner is never touched');
  });
});

test('flavor-scoped dispatcher does not mint or reconcile another flavor', async () => {
  const flavor = new FakeFlavor();
  flavor.key = 'windows';
  flavor.labels = ['self-hosted', 'windows', 'x64'];
  await runSession({
    flavor,
    options: { only: new Set(['windows']) },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/scoped', private: true }],
      runs: { 'me/scoped': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
      runners: {
        'me/scoped': [{
          id: 44,
          name: 'runnerize-linux-stale',
          status: 'offline',
          labels: ['self-hosted', 'linux', 'x64'],
        }],
      },
    },
  }, async ({ start, stub, events }) => {
    start();
    assert.ok(await waitFor(() => events('reconcile_complete').length >= 1));
    await tick(80);
    assert.equal(flavor.launches.length, 0);
    assert.equal(stub.countCalls('DELETE', /\/actions\/runners\/44$/), 0);
  });
});

test('abort drains in-flight assigned runners instead of killing them', async () => {
  const flavor = new FakeFlavor();
  const started = [];
  // Launch starts a job (assigned) but does not settle until the test lets it.
  flavor.behavior = (launch) => { launch.markStarted(); started.push(launch); };
  let launchSignals = [];
  const originalLaunch = flavor.launch;
  flavor.launch = (cfg, opts) => {
    // Prove the dispatcher never hands the launch an abort signal (can't cancel a job).
    launchSignals.push(opts?.signal);
    return originalLaunch(cfg, opts);
  };

  await runSession({
    flavor,
    options: { maxConcurrent: 2 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/drain', private: true }],
      runs: { 'me/drain': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
    },
  }, async ({ start, controller, flavor, events }) => {
    const dispatcherPromise = start();
    assert.ok(await waitFor(() => started.length >= 1), 'a runner started a job');

    controller.abort(); // SIGTERM-equivalent

    // The dispatcher must be draining, still awaiting the assigned runner (not killed).
    assert.ok(await waitFor(() => events('dispatcher_draining').length >= 1), 'entered drain on abort');
    await tick(60);
    let drained = false;
    dispatcherPromise.then(() => { drained = true; });
    await tick(30);
    assert.equal(drained, false, 'drain waits for the assigned runner rather than force-terminating it');

    // The launch was never given an abort signal.
    assert.ok(launchSignals.every((s) => s === undefined), 'assigned runners are not cancelled via signal');

    // Now the job finishes on its own; the dispatcher completes its drain and exits.
    started[0].succeed({ startedJob: true });
    await Promise.race([
      dispatcherPromise,
      tick(2000).then(() => { throw new Error('drain never completed'); }),
    ]);
    assert.ok(events('dispatcher_stopped').length >= 1, 'dispatcher stopped cleanly after draining');
  });
});

test('drain deadline stops minting, force-reaps runners, and invokes the drain hook', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: true });
  let hookCalls = 0;
  await runSession({
    flavor,
    options: {
      maxConcurrent: 2,
      drainTimeoutMs: 20,
      onDrain: () => { hookCalls += 1; },
    },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/deadline', private: true }],
      runs: { 'me/deadline': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 4 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
    },
  }, async ({ start, controller, expireDrain, flavor, events }) => {
    const dispatcherPromise = start();
    assert.ok(await waitFor(() => flavor.launches.length === 2));
    controller.abort();
    assert.ok(await waitFor(() => events('dispatcher_draining').length === 1));
    await expireDrain();
    await dispatcherPromise;
    assert.equal(hookCalls, 1);
    assert.equal(flavor.launches.length, 2, 'no runners mint after draining starts');
    assert.ok(flavor.launches.every((launch) => launch.stopped), 'deadline force-stops every in-flight runner');
    assert.equal(events('dispatcher_stopped').length, 1);
  });
});

test('host shutdown guard is off by default and releases its lease through the drain hook', async () => {
  const flavor = new FakeFlavor();
  let acquired = 0;
  let released = 0;
  const github = {
    user: { login: 'me', type: 'User' },
    repos: [{ full_name: 'me/guard', private: true }],
  };
  await runSession({
    flavor,
    options: { acquireGuardLease: async () => { acquired += 1; return { release: () => { released += 1; } }; } },
    github,
  }, async ({ start, controller }) => {
    const dispatcher = start();
    await tick(30);
    controller.abort();
    await dispatcher;
    assert.equal(acquired, 0);
    assert.equal(released, 0);
  });

  await runSession({
    flavor: new FakeFlavor(),
    options: {
      hostGuard: true,
      acquireGuardLease: async () => { acquired += 1; return { release: () => { released += 1; } }; },
    },
    github,
  }, async ({ start, controller }) => {
    const dispatcher = start();
    assert.ok(await waitFor(() => acquired === 1));
    controller.abort();
    await dispatcher;
    assert.equal(released, 1);
  });
});

test('guard release failure does not bypass the caller drain hook', async () => {
  const flavor = new FakeFlavor();
  let drained = 0;
  await runSession({
    flavor,
    options: {
      hostGuard: true,
      acquireGuardLease: async () => ({ release: () => { throw new Error('locked'); } }),
      onDrain: () => { drained += 1; },
    },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/guard-error', private: true }],
    },
  }, async ({ start, controller, events }) => {
    const dispatcher = start();
    await tick(20);
    controller.abort();
    await dispatcher;
    assert.equal(drained, 1);
    assert.equal(events('guard_release_error').length, 1);
  });
});

test('startup reconciliation reaps host resources after complete runner discovery', async () => {
  const flavor = new FakeFlavor();
  const reapCalls = [];
  flavor.reapOrphans = async (options) => { reapCalls.push(options); return 1; };
  await runSession({
    flavor,
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/startup', private: true }],
    },
  }, async ({ start, events }) => {
    start();
    assert.ok(await waitFor(() => events('reconcile_complete').length === 1));
    assert.equal(reapCalls.length, 1);
    assert.equal(reapCalls[0].reconciliationComplete, true);
    assert.equal(reapCalls[0].protectedRunnerNames.size, 0);
  });
});

test('startup reconciliation skips host reaping when runner discovery is incomplete', async () => {
  const flavor = new FakeFlavor();
  let orphanReaps = 0;
  flavor.reapOrphans = async () => { orphanReaps += 1; return 1; };
  await runSession({
    flavor,
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/startup-failure', private: true }],
      faults: {
        listRunners: () => new Response('{"message":"boom"}', {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      },
    },
  }, async ({ start, events }) => {
    start();
    assert.ok(await waitFor(() => events('reconcile_complete').length === 1));
    assert.equal(orphanReaps, 0);
    assert.equal(events('host_reconcile_skipped').length, 1);
    assert.equal(
      events('host_reconcile_skipped')[0].reason,
      'incomplete_runner_discovery',
    );
    assert.equal(events('reconcile_complete')[0].reconciliationComplete, false);
  });
});

test('failed stale-runner deletion keeps reconciling but prevents host reaping', async () => {
  const flavor = new FakeFlavor();
  let orphanReaps = 0;
  flavor.reapOrphans = async () => { orphanReaps += 1; return 1; };
  let deletionAttempts = 0;
  await runSession({
    flavor,
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/delete-failure', private: true }],
      runners: {
        'me/delete-failure': [
          { id: 1, name: `${runnerNamePrefix()}one`, status: 'offline', labels: flavor.labels },
          { id: 2, name: `${runnerNamePrefix()}two`, status: 'offline', labels: flavor.labels },
        ],
      },
      faults: {
        deleteRunner: () => {
          deletionAttempts += 1;
          return deletionAttempts === 1
            ? githubResponse({ message: 'boom' }, { status: 500 })
            : undefined;
        },
      },
    },
  }, async ({ start, stub, events }) => {
    start();
    assert.ok(await waitFor(() => events('reconcile_complete').length === 1));
    assert.equal(stub.countCalls('DELETE', /\/actions\/runners\//), 2);
    assert.equal(orphanReaps, 0);
    assert.equal(events('reconcile_error').length, 1);
    assert.equal(events('reconcile_error')[0].runnerId, 1);
    assert.equal(events('runner_reconciled').length, 1);
    assert.equal(events('runner_reconciled')[0].runnerId, 2);
    assert.equal(events('reconcile_complete')[0].reconciliationComplete, false);
  });
});

test('dispatcher forwards the configured runner maximum lifetime', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior();
  await runSession({
    flavor,
    options: { runnerMaxLifetimeMs: 1234 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/lifetime', private: true }],
      runs: { 'me/lifetime': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
    },
  }, async ({ start, flavor }) => {
    start();
    assert.ok(await waitFor(() => flavor.launches.length === 1));
    assert.equal(flavor.launches[0].maxLifetimeMs, 1234);
  });
});

test('a repo poll error does not wedge the loop; it recovers on the next cycle', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior();
  let calls = 0;
  await runSession({
    flavor,
    options: { maxConcurrent: 2 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/flaky', private: true }],
      runs: { 'me/flaky': [{ id: 1, status: 'queued' }] },
      jobs: { 1: [{ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] }] },
      onRequest: (method, pathname, ctx) => {
        if (method === 'GET' && pathname === '/user/repos') {
          calls += 1;
          if (calls === 1) return new Response('{"message":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
        }
        return undefined;
      },
    },
  }, async ({ start, flavor, events }) => {
    start();
    // First repo poll fails (logged), but the loop keeps going and eventually mints.
    assert.ok(await waitFor(() => events('repo_poll_error').length >= 1), 'the repo poll error was logged');
    assert.ok(await waitFor(() => flavor.launches.length === 1, { timeoutMs: 3000 }),
      'the dispatcher recovered and minted on a later cycle');
  });
});
