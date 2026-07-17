// A harness for driving the real dispatcher against the in-memory GitHub stub with a
// fully controllable "linux" flavor. It mutates the exported flavor singletons (which
// `detectFlavors()` returns by reference) instead of spawning containers, so the real
// count-based mint algorithm, semaphore, two-counter bookkeeping, backoff, and drain
// logic all execute for real — no podman, no network, cross-platform.

import { linux, windows, macos } from '../../src/sandbox/index.js';

/**
 * A fake flavor whose `launch` is scripted by the test. Each launch is recorded and its
 * settlement is controlled via a returned deferred, so the harness can assert on
 * concurrency and the unassigned/semaphore counters at precise moments.
 */
export class FakeFlavor {
  constructor({ key = 'linux', labels = ['self-hosted', 'linux', 'x64'], maxConcurrent } = {}) {
    this.key = key;
    this.labels = labels;
    this.maxConcurrent = maxConcurrent;
    this.launches = [];
    this.available = async () => true;
    // Default behavior: report a started job, then settle successfully on next tick.
    this.behavior = (launch) => { launch.markStarted(); launch.succeed(); };
    this.launch = this.launch.bind(this);
  }

  async launch(encodedJitConfig, { idleTimeoutMs, maxLifetimeMs, onStarted, onControl } = {}) {
    let resolve;
    let reject;
    const done = new Promise((res, rej) => { resolve = res; reject = rej; });
    const launch = {
      encodedJitConfig,
      idleTimeoutMs,
      maxLifetimeMs,
      stopped: false,
      started: false,
      markStarted() { if (!this.started) { this.started = true; onStarted?.(); } },
      succeed(result = { startedJob: true }) { resolve(result); },
      settle(result) { resolve(result); },
      fail(error) { reject(error instanceof Error ? error : new Error(String(error))); },
    };
    this.launches.push(launch);
    onControl?.({
      name: `runnerize-fake-${this.launches.length}`,
      stop: async () => {
        launch.stopped = true;
        launch.succeed({ startedJob: launch.started });
      },
    });
    // Run the scripted behavior on a microtask so the dispatcher can register the launch.
    queueMicrotask(() => this.behavior(launch, this));
    return done;
  }
}

/**
 * Install a fake flavor as the only available one. Returns a restore fn that puts the
 * real flavor methods back.
 */
export function installFakeFlavor(fake) {
  const saved = {
    linux: {
      available: linux.available,
      launch: linux.launch,
      labels: linux.labels,
      maxConcurrent: linux.maxConcurrent,
      reapOrphans: linux.reapOrphans,
    },
    windows: windows.available,
    macos: macos.available,
  };
  // Route the linux singleton through the fake (detectFlavors returns the singleton).
  linux.available = fake.available;
  linux.launch = fake.launch;
  linux.labels = fake.labels;
  linux.maxConcurrent = fake.maxConcurrent;
  linux.reapOrphans = fake.reapOrphans?.bind(fake) ?? (async () => 0);
  windows.available = async () => false;
  macos.available = async () => false;

  return () => {
    linux.available = saved.linux.available;
    linux.launch = saved.linux.launch;
    linux.labels = saved.linux.labels;
    if (saved.linux.maxConcurrent === undefined) delete linux.maxConcurrent;
    else linux.maxConcurrent = saved.linux.maxConcurrent;
    linux.reapOrphans = saved.linux.reapOrphans;
    windows.available = saved.windows;
    macos.available = saved.macos;
  };
}

/** Resolve on the next macrotask, letting queued microtasks and timers drain. */
export function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Keep the event loop alive with a ref'd timer while awaiting `promise`. `container.js`
 * arms its idle-watchdog and force-settle timers with `.unref()`, so a test that only
 * awaits such a launch has no ref'd work to keep the loop alive; Node's test runner
 * can then report "event loop resolved while promise pending" and cancel the test.
 * A ref'd heartbeat holds the loop open until settlement.
 */
export async function withKeepAlive(promise, intervalMs = 50) {
  const heartbeat = setInterval(() => {}, intervalMs);
  try {
    return await promise;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Wait until `predicate()` is true or `timeoutMs` elapses. Polls on the macrotask
 * queue so pending dispatcher async work can progress.
 */
export async function waitFor(predicate, { timeoutMs = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await tick(interval);
  }
}
