# runnerize tests

Zero-dependency tests using Node's built-in runner (`node:test`) and `node:assert/strict`.
No npm dependencies, no test framework.

```bash
npm test          # unit suite   -> node --test test/unit
npm run test:e2e  # e2e suite    -> node --test test/e2e   (skips cleanly without infra)
npm run test:all  # both
```

> Node version note: the frozen scripts pass a **directory** (`test/unit`) to
> `node --test`. Directory arguments are discovered recursively on **Node 18 and 20**
> (the CI matrix). On **Node 21+** a bare directory is instead resolved as a module, so
> `node --test test/unit` errors there. To run locally on a newer Node, use a glob:
> `node --test "test/unit/**/*.test.js"`. The CI matrix (Node 18, 20) runs the frozen
> command as-is.

## Layout

```
test/
  unit/         # hermetic, no network / no containers (one .test.js per module)
  e2e/          # real end-to-end; skips unless E2E_GH_TOKEN + E2E_REPO + a runtime exist
  helpers/      # shared stubs and harnesses (not test files)
```

## How the unit tests stay hermetic

The production modules are imported unchanged; only their external seams are swapped, so
the real logic (HTTP client, pagination, backoff, cache, the count-based mint algorithm,
the container launch state machine) executes for real.

- **`helpers/github-stub.js`** — installs an in-memory GitHub REST API as `globalThis.fetch`.
  Models the exact endpoints `src/github.js` calls, paginates at 100/page, honors
  ETag / `If-None-Match` (304s), and records every request for assertions. Fault hooks
  inject non-2xx responses and rate-limit headers.
- **`helpers/process-stub.js`** — `SpawnStub` / `ExecFileStub` swap the live
  `node:child_process` exports and call `module.syncBuiltinESMExports()` so already-imported
  ESM code (`src/sandbox/container.js`, the `gh auth token` path, `src/platform.js`) sees the
  scripted fakes. `ExecFileStub` carries the `util.promisify.custom` hook so
  `promisify(execFile)` resolves to `{ stdout, stderr }` exactly like the real binding.
- **`helpers/platform-override.js`** — redefines `process.platform` / `process.arch` and
  patches `fs/promises.readFile` / `os.hostname` for `src/platform.js`.
- **`helpers/dispatcher-harness.js`** — `FakeFlavor` + `installFakeFlavor` mutate the
  exported flavor singletons that `detectFlavors()` returns, so the **real** dispatcher
  drives a controllable flavor instead of spawning containers. Launch settlement is
  gated by the test, so the mint counters can be observed at exact fixed points.
- **`helpers/fresh-module.js`** — cache-busts an import so each test gets fresh
  module-level state (token cache, ETag cache, rate-limit gate) with no cross-test leak.

## What each unit file covers

- **`github.test.js`** — token resolution (env + `gh auth token` fallback, caching);
  owned-private-repo filtering + pagination; `countQueuedMatchingJobs` label-subset
  matching, the bare-`[self-hosted]`→default-flavor rule, case-insensitivity, run dedup by
  id across the queued+in_progress scans, and needs-gated/matrix queued jobs surfaced from
  in_progress runs; ETag 304 → cached data; the bounded ETag cache evicting past its cap;
  secondary-rate-limit retry (capped) and abortability; `isStillPrivate` failing **closed**
  on error / public repo but **rethrowing** a caller abort; `generateJitConfig` shape +
  incomplete-response rejection; `listRunners` label normalization; `deleteRunner` 404
  tolerance and non-404 throw.
- **`dispatcher.test.js`** — option validation; `toMint = min(demand - unassigned, free)`
  capped by the semaphore; count-based / never job-pinned (no job id in any JIT request);
  double-mint damping via inflight `unassigned`; the two-counter model decrementing
  `unassigned` **exactly once** (onStarted OR settle, not both); the semaphore released on
  every path so later demand is still served; deregister-on-launch-failure calling
  `deleteRunner` + per-repo backoff; fail-closed privacy re-check right before mint;
  reconcile removing only offline `runnerize-*` runners; SIGTERM/abort **draining** assigned
  runners without cancelling them; a poll error not wedging the loop.
- **`container.test.js`** — input validation; the happy path (job-start line → clean exit
  → `{ startedJob: true }`, JIT config passed via env never argv); `onStarted` firing
  exactly once; the idle watchdog **force-settling** a hung child (never hangs) and tearing
  the container down; non-zero exit rejection; runtime availability. The embedded
  `mv -T` staging script and `INNER_SCRIPT` are extracted from source and checked for their
  no-`rm -rf`-destination safety invariants, plus a **real concurrency race** in bash (runs
  on POSIX with `mv -T` + exec-bit preservation; skips on git-bash/NTFS).
- **`platform.test.js`** — OS/arch detection + unsupported rejections; WSL detection from
  `/proc/version`; `machineId` on linux/darwin/win32 and its hashed-hostname fallback,
  proven stable across calls; plus one real-host `machineId` shape check.
- **`runner.test.js`** — `latestRunnerVersion` semver parse/validate + non-OK handling;
  `ensureImage` inspect-then-pull flow and no-runtime rejection.
- **`sandbox-index.test.js`** — the frozen FLAVOR shape; stub flavors unavailable + their
  opt-in launch errors; `detectFlavors` returning available singletons by reference and
  treating a throwing `available()` as unavailable.

## The real E2E (`test/e2e/dispatch.e2e.test.js`)

Actually exercises the tool end to end. It **skips cleanly** (green) unless all of:

| env / requirement | meaning |
|---|---|
| `E2E_GH_TOKEN` | token with `repo` + `workflow` scope for a throwaway **private** repo |
| `E2E_REPO` | `owner/name` of that throwaway private repo |
| `podman` (or `docker`) | a working rootless runtime on PATH (native or in WSL) |
| `RUNNERIZE_LINUX_IMAGE` | optional: override the fat image (a smaller image speeds CI) |
| `RUNNERIZE_RUNNER_DIR` | optional: preinstalled runner dir instead of downloading |
| `E2E_TIMEOUT_MS` | optional: overall budget (default 900000) |

When present it: queues exactly one `[self-hosted, linux, x64]` job by pushing a workflow to
a fresh branch, confirms the tool counts the demand, drives the real mint + JIT-launch path
(one runner in a throwaway container), asserts the run reaches `success`, and asserts the
ephemeral runner **auto-deregistered** with **0 leaked registrations**. An `after` hook
deletes every branch, run, and runner it created, so re-runs are idempotent. It only ever
mutates the throwaway `E2E_REPO`.
