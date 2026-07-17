import {
  countQueuedMatchingJobs,
  deleteRunner,
  generateJitConfig,
  isStillPrivate,
  listOwnedPrivateRepos,
  listRunners,
  runnerNamePrefix,
} from './github.js';
import { detectFlavors } from './sandbox/index.js';
import { keepHostAwake } from './keepawake.js';
import { createGuardLease } from './guard.js';

const RUNNER_NAME_PREFIX = runnerNamePrefix();
const LAUNCH_FAILURE_BACKOFF_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_RUNNER_MAX_LIFETIME_MS = 6 * 60 * 60_000;
const DRAIN_HOOK_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MAX_INTERVAL_MS = 120_000;
const POLL_JITTER = 0.25;

function environmentDuration(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (Number.isFinite(value)) return value;
  console.warn(`${name} must be numeric; using ${fallback}ms.`);
  return fallback;
}

class Semaphore {
  #capacity;
  #active = 0;

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new TypeError('maxConcurrent must be a positive integer');
    }
    this.#capacity = capacity;
  }

  free() {
    return this.#capacity - this.#active;
  }

  acquire() {
    if (this.#active >= this.#capacity) {
      throw new Error('semaphore capacity exceeded');
    }
    this.#active += 1;
  }

  release() {
    if (this.#active === 0) {
      throw new Error('semaphore released more than once');
    }
    this.#active -= 1;
  }
}

function log(event, fields = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

function errorFields(error) {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

function createNotifier() {
  const listeners = new Set();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      const pending = [...listeners];
      listeners.clear();
      for (const listener of pending) listener();
    },
  };
}

function interruptibleDelay(milliseconds, notifier, signal) {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    let unsubscribe = () => {};
    let wakeTimer;
    const timer = setTimeout(done, milliseconds);

    function done() {
      clearTimeout(timer);
      clearTimeout(wakeTimer);
      unsubscribe();
      signal?.removeEventListener('abort', done);
      resolve();
    }

    unsubscribe = notifier?.subscribe(() => {
      wakeTimer = setTimeout(done, 0);
    }) ?? unsubscribe;
    signal?.addEventListener('abort', done, { once: true });
  });
}

function abortableDelay(milliseconds, signal) {
  return interruptibleDelay(milliseconds, undefined, signal);
}

function runnerLabels(runner) {
  return new Set(runner.labels.map((label) => (
    typeof label === 'string' ? label : label.name
  ).toLowerCase()));
}

function belongsToFlavor(runner, flavors) {
  const labels = runnerLabels(runner);
  return flavors.some((flavor) => flavor.labels.every((label) => labels.has(label.toLowerCase())));
}

async function reconcile(repos, flavors, signal, { host = false } = {}) {
  let removed = 0;
  const protectedRunnerNames = new Set();

  for (const repo of repos) {
    if (signal?.aborted) break;

    try {
      const runners = await listRunners(repo.full_name, { signal });
      const hostRunners = runners.filter(
        (runner) => runner.name.startsWith(RUNNER_NAME_PREFIX)
          && belongsToFlavor(runner, flavors),
      );
      for (const runner of hostRunners) {
        if (runner.status !== 'offline') protectedRunnerNames.add(runner.name);
      }
      const stale = hostRunners.filter((runner) => runner.status === 'offline');

      for (const runner of stale) {
        if (signal?.aborted) break;
        await deleteRunner(repo.full_name, runner.id, { signal });
        removed += 1;
        log('runner_reconciled', { repo: repo.full_name, runnerId: runner.id });
      }
    } catch (error) {
      log('reconcile_error', { repo: repo.full_name, ...errorFields(error) });
    }
  }

  if (host) {
    for (const flavor of flavors) {
      try {
        const count = await flavor.reapOrphans?.({ protectedRunnerNames });
        removed += count ?? 0;
      } catch (error) {
        log('host_reconcile_error', { flavor: flavor.key, ...errorFields(error) });
      }
    }
  }

  log('reconcile_complete', { repos: repos.length, removed });
}

export function pollDelay({
  floorMilliseconds,
  capMilliseconds,
  repoCount,
  freeCapacity,
  maxCapacity,
  random = Math.random,
}) {
  const repoMultiplier = Math.max(1, Math.ceil(repoCount / 20));
  const scaledFloor = Math.min(floorMilliseconds * repoMultiplier, capMilliseconds);
  const load = 1 - freeCapacity / maxCapacity;
  const adaptive = scaledFloor + (capMilliseconds - scaledFloor) * load;
  const jittered = adaptive * (1 - POLL_JITTER + random() * POLL_JITTER * 2);
  return Math.max(floorMilliseconds, Math.min(jittered, capMilliseconds));
}

/**
 * Continuously counts queued work and mints unpinned ephemeral runners.
 */
export async function runDispatcher({
  maxConcurrent = 4,
  pollIntervalMs = 15_000,
  pollMaxIntervalMs = Number(
    process.env.RUNNERIZE_POLL_MAX_INTERVAL_MS ?? DEFAULT_POLL_MAX_INTERVAL_MS,
  ),
  idleTimeoutMs = 120_000,
  reconcileMs = 300_000,
  drainTimeoutMs = environmentDuration('RUNNERIZE_DRAIN_TIMEOUT_MS', DEFAULT_DRAIN_TIMEOUT_MS),
  runnerMaxLifetimeMs = environmentDuration('RUNNERIZE_RUNNER_MAX_LIFETIME_MS', DEFAULT_RUNNER_MAX_LIFETIME_MS),
  only,
  keepAwake = true,
  random = Math.random,
  signal,
  onDrain,
  hostGuard = process.env.RUNNERIZE_GUARD_HOST === '1',
  acquireGuardLease = createGuardLease,
  drainDelay = abortableDelay,
} = {}) {
  for (const [name, value] of Object.entries({
    pollIntervalMs,
    pollMaxIntervalMs,
    idleTimeoutMs,
    reconcileMs,
    drainTimeoutMs,
    runnerMaxLifetimeMs,
  })) {
    if (!Number.isFinite(value) || value < 1) {
      throw new TypeError(`${name} must be a positive number`);
    }
  }
  if (pollMaxIntervalMs < pollIntervalMs) {
    throw new TypeError('pollMaxIntervalMs must be at least pollIntervalMs');
  }
  if (typeof random !== 'function') throw new TypeError('random must be a function');

  const semaphore = new Semaphore(maxConcurrent);
  const launches = new Map();
  const activeByFlavor = new Map();
  const unassignedByFlavor = new Map();
  const unassignedByRepoFlavor = new Map();
  const repoBackoffUntil = new Map();
  const slotFreed = createNotifier();
  let lastReconcile = 0;
  let lastRepoCount = 0;
  const waitForNextPoll = (repoCount) => interruptibleDelay(pollDelay({
    floorMilliseconds: pollIntervalMs,
    capMilliseconds: pollMaxIntervalMs,
    repoCount,
    freeCapacity: semaphore.free(),
    maxCapacity: maxConcurrent,
    random,
  }), slotFreed, signal);

  const unassignedKey = (repo, flavor) => `${flavor}\0${repo}`;
  const incrementUnassigned = (repo, flavor) => {
    unassignedByFlavor.set(flavor, (unassignedByFlavor.get(flavor) ?? 0) + 1);
    const key = unassignedKey(repo, flavor);
    unassignedByRepoFlavor.set(key, (unassignedByRepoFlavor.get(key) ?? 0) + 1);
  };
  const decrementUnassigned = (repo, flavor) => {
    const flavorCount = Math.max(0, (unassignedByFlavor.get(flavor) ?? 1) - 1);
    if (flavorCount === 0) unassignedByFlavor.delete(flavor);
    else unassignedByFlavor.set(flavor, flavorCount);

    const key = unassignedKey(repo, flavor);
    const repoFlavorCount = Math.max(0, (unassignedByRepoFlavor.get(key) ?? 1) - 1);
    if (repoFlavorCount === 0) unassignedByRepoFlavor.delete(key);
    else unassignedByRepoFlavor.set(key, repoFlavorCount);
  };

  const wakeLock = keepAwake ? keepHostAwake() : null;
  const guardLease = hostGuard ? await acquireGuardLease() : null;
  log('dispatcher_started', { maxConcurrent, pollIntervalMs, idleTimeoutMs });

  try {
    while (!signal?.aborted) {
      let repos;
      try {
        repos = await listOwnedPrivateRepos({ signal });
        lastRepoCount = repos.length;
      } catch (error) {
        log('repo_poll_error', errorFields(error));
        await waitForNextPoll(lastRepoCount);
        continue;
      }

      let flavors;
      try {
        flavors = await detectFlavors(only);
      } catch (error) {
        log('flavor_detection_error', errorFields(error));
        await waitForNextPoll(repos.length);
        continue;
      }

      const now = Date.now();
      if (lastReconcile === 0 || now - lastReconcile >= reconcileMs) {
        await reconcile(repos, flavors, signal, { host: lastReconcile === 0 });
        lastReconcile = Date.now();
      }
      if (signal?.aborted) break;

      for (const flavor of flavors) {
        if (signal?.aborted || semaphore.free() === 0) break;

        const perRepo = [];
        for (const repo of repos) {
          if (signal?.aborted) break;
          try {
            const queued = await countQueuedMatchingJobs(
              repo.full_name,
              flavor.labels,
              { isDefault: flavor.key === 'linux' },
              { signal },
            );
            const alreadyUnassigned = unassignedByRepoFlavor.get(
              unassignedKey(repo.full_name, flavor.key),
            ) ?? 0;
            perRepo.push({
              repo: repo.full_name,
              queued,
              unmet: Math.max(0, queued - alreadyUnassigned),
            });
          } catch (error) {
            log('demand_count_error', {
              repo: repo.full_name,
              flavor: flavor.key,
              ...errorFields(error),
            });
          }
        }

        const demand = perRepo.reduce((sum, entry) => sum + entry.queued, 0);
        const unassigned = unassignedByFlavor.get(flavor.key) ?? 0;
        const flavorCap = flavor.maxConcurrent ?? Infinity;
        const flavorActive = activeByFlavor.get(flavor.key) ?? 0;
        const toMint = Math.max(0, Math.min(
          demand - unassigned,
          semaphore.free(),
          flavorCap - flavorActive,
        ));
        log('demand_counted', { flavor: flavor.key, demand, unassigned, toMint });

        for (let minted = 0; minted < toMint && !signal?.aborted; minted += 1) {
          const target = perRepo.find(
            (entry) => entry.unmet > 0 && (repoBackoffUntil.get(entry.repo) ?? 0) <= Date.now(),
          );
          if (!target) break;
          target.unmet -= 1;

          if (!(await isStillPrivate(target.repo, { signal }))) {
            log('mint_skipped_not_private', { repo: target.repo, flavor: flavor.key });
            continue;
          }
          if (signal?.aborted || semaphore.free() === 0) break;

          semaphore.acquire();
          incrementUnassigned(target.repo, flavor.key);
          activeByFlavor.set(flavor.key, (activeByFlavor.get(flavor.key) ?? 0) + 1);

          let launchPromise;
          launchPromise = (async () => {
            let unassigned = true;
            let runnerId;
            const decrementUnassignedOnce = () => {
              if (!unassigned) return;
              unassigned = false;
              decrementUnassigned(target.repo, flavor.key);
            };

            try {
              const {
                encodedJitConfig,
                runnerId: generatedRunnerId,
                runnerName,
              } = await generateJitConfig(target.repo, flavor.labels);
              // JIT creation is deliberately non-abortable: if GitHub creates a runner,
              // the response must arrive so this process can launch or deregister it.
              runnerId = generatedRunnerId;
              // Once registered, the runner must launch even if shutdown arrived while
              // GitHub was generating its config; otherwise an orphan is left behind.
              log('runner_launching', { repo: target.repo, flavor: flavor.key, runnerName });

              const lifecycle = launches.get(launchPromise);
              lifecycle.runnerName = runnerName;
              lifecycle.runnerId = runnerId;

              let result;
              try {
                result = await flavor.launch(encodedJitConfig, {
                  idleTimeoutMs,
                  maxLifetimeMs: runnerMaxLifetimeMs,
                  onStarted: decrementUnassignedOnce,
                  onControl: ({ name, stop }) => {
                    lifecycle.resourceName = name;
                    lifecycle.stop = stop;
                  },
                });
                if (!result?.startedJob) {
                  throw new Error('runner exited without starting a job');
                }
              } catch (error) {
                repoBackoffUntil.set(target.repo, Date.now() + LAUNCH_FAILURE_BACKOFF_MS);
                try {
                  await deleteRunner(target.repo, runnerId);
                } catch (deleteError) {
                  log('runner_deregister_error', {
                    repo: target.repo,
                    flavor: flavor.key,
                    runnerId,
                    ...errorFields(deleteError),
                  });
                }
                throw error;
              }

              log('runner_exited', {
                repo: target.repo,
                flavor: flavor.key,
                startedJob: true,
              });
            } catch (error) {
              log('runner_launch_error', {
                repo: target.repo,
                flavor: flavor.key,
                ...errorFields(error),
              });
            } finally {
              decrementUnassignedOnce();
              const flavorActive = Math.max(0, (activeByFlavor.get(flavor.key) ?? 1) - 1);
              if (flavorActive === 0) activeByFlavor.delete(flavor.key);
              else activeByFlavor.set(flavor.key, flavorActive);
              semaphore.release();
              slotFreed.notify();
              launches.delete(launchPromise);
            }
          })();
          launches.set(launchPromise, {
            repo: target.repo,
            flavor: flavor.key,
            runnerName: 'registration pending',
          });
        }
      }

      await waitForNextPoll(repos.length);
    }
  } finally {
    log('dispatcher_draining', { inflight: launches.size, timeoutMs: drainTimeoutMs });
    // Extension point for releasing external ownership leases before waiting on jobs.
    const drainHook = async () => {
      try {
        guardLease?.release();
      } catch (error) {
        log('guard_release_error', errorFields(error));
      }
      await onDrain?.();
    };
    if (guardLease || onDrain) {
      const hookAbort = new AbortController();
      try {
        await Promise.race([
          Promise.resolve().then(drainHook),
          abortableDelay(Math.min(DRAIN_HOOK_TIMEOUT_MS, drainTimeoutMs), hookAbort.signal)
            .then(() => { throw new Error('drain hook timed out'); }),
        ]);
      } catch (error) {
        log('drain_hook_error', errorFields(error));
      } finally {
        hookAbort.abort();
      }
    }

    const pending = [...launches.keys()];
    if (pending.length) {
      let deadlineExpired = false;
      const drainAbort = new AbortController();
      await Promise.race([
        Promise.allSettled(pending).then(() => drainAbort.abort()),
        drainDelay(drainTimeoutMs, drainAbort.signal).then(() => {
          if (!drainAbort.signal.aborted) deadlineExpired = true;
        }),
      ]);

      if (deadlineExpired && launches.size) {
        const remaining = [...launches.entries()];
        for (const [, lifecycle] of remaining) {
          console.warn(`Drain deadline expired; force-reaping ${lifecycle.runnerName} (${lifecycle.resourceName ?? lifecycle.flavor})`);
          try {
            await lifecycle.stop?.();
          } catch (error) {
            log('runner_force_reap_error', {
              runner: lifecycle.runnerName,
              ...errorFields(error),
            });
          }
          if (lifecycle.runnerId) {
            try {
              await deleteRunner(lifecycle.repo, lifecycle.runnerId);
            } catch (error) {
              log('runner_deregister_error', {
                repo: lifecycle.repo,
                flavor: lifecycle.flavor,
                runnerId: lifecycle.runnerId,
                ...errorFields(error),
              });
            }
          }
        }
        const reapAbort = new AbortController();
        await Promise.race([
          Promise.allSettled(remaining.map(([promise]) => promise))
            .then(() => reapAbort.abort()),
          abortableDelay(5_000, reapAbort.signal),
        ]);
      }
    }
    wakeLock?.dispose();
    log('dispatcher_stopped');
  }
}
