import {
  countQueuedMatchingJobs,
  deleteRunner,
  generateJitConfig,
  isStillPrivate,
  listOwnedPrivateRepos,
  listRunners,
} from './github.js';
import { detectFlavors } from './sandbox/index.js';

const RUNNER_NAME_PREFIX = 'runnerize-';

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

function abortableDelay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);

    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }

    signal?.addEventListener('abort', done, { once: true });
  });
}

async function reconcile(repos, signal) {
  let removed = 0;

  for (const repo of repos) {
    if (signal?.aborted) break;

    try {
      const runners = await listRunners(repo.full_name);
      const stale = runners.filter(
        (runner) => runner.status === 'offline' && runner.name.startsWith(RUNNER_NAME_PREFIX),
      );

      for (const runner of stale) {
        if (signal?.aborted) break;
        await deleteRunner(repo.full_name, runner.id);
        removed += 1;
        log('runner_reconciled', { repo: repo.full_name, runnerId: runner.id });
      }
    } catch (error) {
      log('reconcile_error', { repo: repo.full_name, ...errorFields(error) });
    }
  }

  log('reconcile_complete', { repos: repos.length, removed });
}

function pollDelay(baseMilliseconds, repoCount) {
  const multiplier = Math.max(1, Math.ceil(repoCount / 20));
  return Math.min(baseMilliseconds * multiplier, 60_000);
}

/**
 * Continuously counts queued work and mints unpinned ephemeral runners.
 */
export async function runDispatcher({
  maxConcurrent = 4,
  pollIntervalMs = 15_000,
  idleTimeoutMs = 120_000,
  reconcileMs = 300_000,
  signal,
} = {}) {
  for (const [name, value] of Object.entries({ pollIntervalMs, idleTimeoutMs, reconcileMs })) {
    if (!Number.isFinite(value) || value < 1) {
      throw new TypeError(`${name} must be a positive number`);
    }
  }

  const semaphore = new Semaphore(maxConcurrent);
  const launches = new Set();
  const inflightByFlavor = new Map();
  const inflightByRepoFlavor = new Map();
  let lastReconcile = 0;
  let lastRepoCount = 0;

  const inflightKey = (repo, flavor) => `${flavor}\0${repo}`;
  const incrementInflight = (repo, flavor) => {
    inflightByFlavor.set(flavor, (inflightByFlavor.get(flavor) ?? 0) + 1);
    const key = inflightKey(repo, flavor);
    inflightByRepoFlavor.set(key, (inflightByRepoFlavor.get(key) ?? 0) + 1);
  };
  const decrementInflight = (repo, flavor) => {
    inflightByFlavor.set(flavor, Math.max(0, (inflightByFlavor.get(flavor) ?? 1) - 1));
    const key = inflightKey(repo, flavor);
    const next = Math.max(0, (inflightByRepoFlavor.get(key) ?? 1) - 1);
    if (next === 0) inflightByRepoFlavor.delete(key);
    else inflightByRepoFlavor.set(key, next);
  };

  log('dispatcher_started', { maxConcurrent, pollIntervalMs, idleTimeoutMs });

  try {
    while (!signal?.aborted) {
      let repos;
      try {
        repos = await listOwnedPrivateRepos();
        lastRepoCount = repos.length;
      } catch (error) {
        log('repo_poll_error', errorFields(error));
        await abortableDelay(pollDelay(pollIntervalMs, lastRepoCount), signal);
        continue;
      }

      const now = Date.now();
      if (lastReconcile === 0 || now - lastReconcile >= reconcileMs) {
        await reconcile(repos, signal);
        lastReconcile = Date.now();
      }
      if (signal?.aborted) break;

      let flavors;
      try {
        flavors = await detectFlavors();
      } catch (error) {
        log('flavor_detection_error', errorFields(error));
        await abortableDelay(pollDelay(pollIntervalMs, repos.length), signal);
        continue;
      }

      for (const flavor of flavors) {
        if (signal?.aborted || semaphore.free() === 0) break;

        const perRepo = [];
        for (const repo of repos) {
          if (signal?.aborted) break;
          try {
            const queued = await countQueuedMatchingJobs(repo.full_name, flavor.labels);
            const alreadyInflight = inflightByRepoFlavor.get(
              inflightKey(repo.full_name, flavor.key),
            ) ?? 0;
            perRepo.push({
              repo: repo.full_name,
              queued,
              unmet: Math.max(0, queued - alreadyInflight),
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
        const inflight = inflightByFlavor.get(flavor.key) ?? 0;
        const toMint = Math.max(0, Math.min(demand - inflight, semaphore.free()));
        log('demand_counted', { flavor: flavor.key, demand, inflight, toMint });

        for (let minted = 0; minted < toMint && !signal?.aborted; minted += 1) {
          const target = perRepo.find((entry) => entry.unmet > 0);
          if (!target) break;
          target.unmet -= 1;

          if (!(await isStillPrivate(target.repo))) {
            log('mint_skipped_not_private', { repo: target.repo, flavor: flavor.key });
            continue;
          }
          if (signal?.aborted || semaphore.free() === 0) break;

          semaphore.acquire();
          incrementInflight(target.repo, flavor.key);

          let launchPromise;
          launchPromise = (async () => {
            try {
              const jit = await generateJitConfig(target.repo, flavor.labels);
              // Once registered, the runner must launch even if shutdown arrived while
              // GitHub was generating its config; otherwise an orphan is left behind.
              log('runner_launching', { repo: target.repo, flavor: flavor.key });
              const result = await flavor.launch(jit, { idleTimeoutMs });
              log('runner_exited', {
                repo: target.repo,
                flavor: flavor.key,
                startedJob: Boolean(result?.startedJob),
              });
            } catch (error) {
              log('runner_launch_error', {
                repo: target.repo,
                flavor: flavor.key,
                ...errorFields(error),
              });
            } finally {
              decrementInflight(target.repo, flavor.key);
              semaphore.release();
              launches.delete(launchPromise);
            }
          })();
          launches.add(launchPromise);
        }
      }

      await abortableDelay(pollDelay(pollIntervalMs, repos.length), signal);
    }
  } finally {
    log('dispatcher_draining', { inflight: launches.size });
    await Promise.allSettled([...launches]);
    log('dispatcher_stopped');
  }
}
