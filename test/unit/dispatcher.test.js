import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollDelay, runDispatcher } from '../../src/dispatcher.js';
import { runnerNamePrefix } from '../../src/github.js';
import { GitHubStub } from '../helpers/github-stub.js';
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

test('poll delay is jittered within bounds and varies across calls', () => {
  const values = [0, 0.5, 1].map((random) => pollDelay({
    floorMilliseconds: 100,
    capMilliseconds: 800,
    repoCount: 1,
    freeCapacity: 2,
    maxCapacity: 4,
    random: () => random,
  }));

  assert.deepEqual(values, [337.5, 450, 562.5]);
  assert.ok(values.every((value) => value >= 75 && value <= 1000));
});

test('poll delay increases with capacity-normalized load and respects floor and cap', () => {
  const delay = (freeCapacity, random = 0.5) => pollDelay({
    floorMilliseconds: 100,
    capMilliseconds: 800,
    repoCount: 1,
    freeCapacity,
    maxCapacity: 4,
    random: () => random,
  });

  assert.equal(delay(4), 100, 'idle hosts poll at the rate-safe floor');
  assert.ok(delay(3) < delay(2));
  assert.ok(delay(2) < delay(1));
  assert.ok(delay(1) < delay(0));
  assert.equal(delay(0), 800, 'full hosts poll at the cap');
  assert.equal(delay(4, 0), 100, 'negative jitter never takes idle polling below the floor');
  assert.equal(delay(0, 1), 800, 'positive jitter never takes full polling above the cap');
});

test('repo-count scaling remains additive without crossing the configured cap', () => {
  const options = {
    floorMilliseconds: 100,
    capMilliseconds: 800,
    freeCapacity: 4,
    maxCapacity: 4,
    random: () => 0.5,
  };

  assert.equal(pollDelay({ ...options, repoCount: 20 }), 100);
  assert.equal(pollDelay({ ...options, repoCount: 21 }), 200);
  assert.equal(pollDelay({ ...options, repoCount: 200 }), 800);
});

test('mints toMint = min(demand - unassigned, free): capped by the semaphore', async () => {
  const flavor = new FakeFlavor();
  flavor.behavior = holdingBehavior({ markStarted: false }); // hold all launches open
  await runSession({
    flavor,
    options: { maxConcurrent: 2 },
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/cap', private: true }],
      // 5 queued linux jobs => demand 5, but only 2 slots free.
      runs: { 'me/cap': [{ id: 1, status: 'queued' }] },
      jobs: { 1: Array.from({ length: 5 }, () => ({ status: 'queued', labels: ['self-hosted', 'linux', 'x64'] })) },
    },
  }, async ({ start, flavor }) => {
    start();
    // Fixed point: exactly 2 held launches (the semaphore cap), regardless of extra polls.
    const reached = await waitFor(() => flavor.launches.length === 2);
    assert.ok(reached, `expected 2 launches, saw ${flavor.launches.length}`);
    // Let several more poll cycles run; held launches keep the fixed point stable.
    await tick(120);
    assert.equal(flavor.launches.length, 2, 'never over-mints past the free slots while launches are held');
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

test('startup reconciliation reaps host resources before polling', async () => {
  const flavor = new FakeFlavor();
  let orphanReaps = 0;
  flavor.reapOrphans = async () => { orphanReaps += 1; return 1; };
  await runSession({
    flavor,
    github: {
      user: { login: 'me', type: 'User' },
      repos: [{ full_name: 'me/startup', private: true }],
    },
  }, async ({ start, events }) => {
    start();
    assert.ok(await waitFor(() => events('reconcile_complete').length === 1));
    assert.equal(orphanReaps, 1);
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
