# Architecture

This document explains **how runnerize works and why it's built this way**. The
"what" lives in `README.md`; the frozen signatures live in `CONTRACTS.md`; the
invariants an agent must preserve live in `AGENTS.md`. Here we cover the data flow
and the reliability/security decisions — most of which came directly out of
adversarial review, and each of which encodes a failure mode we chose to design out.

## The problem

A personal (non-org) GitHub account has **no account-level runner scope**, so every
private repo needs its own runner. Standing self-hosted runners are a liability: they
hold long-lived registration credentials, accumulate cross-job state, and keep
running when idle. runnerize replaces all of that with one always-on dispatcher that
mints **ephemeral, just-in-time** runners on demand and lets nothing persist.

## Components and data flow

```
                    ┌─────────────────────────────────────────────┐
                    │  bin/runnerize.js  (CLI)                     │
                    │  run / status / remove / service             │
                    │  SIGINT|SIGTERM → AbortController.abort()    │
                    └───────────────────┬─────────────────────────┘
                                        │ signal
                                        ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │  src/dispatcher.js — runDispatcher()                                     │
   │                                                                          │
   │  every poll (adaptive, base 15s):                                        │
   │    repos ← github.listOwnedPrivateRepos()   (private, User-owned, !fork) │
   │    (startup + every reconcileMs) reconcile stale offline runnerize-*     │
   │    flavors ← sandbox.detectFlavors()                                     │
   │    for each flavor:                                                      │
   │      demand   = Σ github.countQueuedMatchingJobs(repo, flavor.labels)    │
   │      toMint   = clamp(demand − unassigned, 0, semaphore.free())          │
   │      repeat toMint times, picking a repo with unmet demand:              │
   │        if !github.isStillPrivate(repo): skip     ── FAIL-CLOSED          │
   │        semaphore.acquire(); mark unassigned                              │
   │        jit ← github.generateJitConfig(repo, labels)                      │
   │        flavor.launch(jit).finally(release + unmark)                      │
   │    sleep(pollDelay)                                                      │
   │                                                                          │
   │  on abort: stop minting; await Promise.allSettled(in-flight launches)    │
   └───────────┬───────────────────────────────────────────┬────────────────┘
               │                                            │
               ▼                                            ▼
   ┌───────────────────────────┐             ┌──────────────────────────────────┐
   │ src/github.js             │             │ src/sandbox/container.js (linux)  │
   │ fetch + AbortController   │             │ backend: native podman/docker or  │
   │ ETag LRU cache            │             │          wsl.exe -d <distro> ...  │
   │ rate-limit pause gate     │             │ ensure fat image                  │
   │ token: env → gh, off-argv │             │ stage runner (ro) + INNER_SCRIPT  │
   └───────────────────────────┘             │ spawn `run --rm -e JITCFG ...`    │
                                             │ idle watchdog (idleTimeoutMs)     │
   src/runner.js: download + SHA-256 verify  │ detect job-start line → onStarted │
   the actions/runner, ensure fat image      │ one job → auto-deregister → --rm  │
   src/platform.js: OS/arch/WSL, machineId   └──────────────────────────────────┘
```

A single job's life: dispatcher counts demand → re-checks the repo is private →
acquires a slot → mints a JIT config → the `linux` flavor pulls/uses the fat image,
copies the read-only runner into a throwaway writable dir inside a `--rm` container,
wipes any stale runner state, and execs `run.sh --jitconfig $JITCFG` → the runner
takes exactly one job → it auto-deregisters and exits → the container is destroyed →
the slot is released.

## Decision log — the *why*

### Count-based dispatch, never job-pinned

**Decision:** scale the *number* of runners to queued demand; never mint "a runner
for job X" keyed on a `job.id`.

**Why (adversarial review finding):** GitHub's scheduler assigns any label-matching
queued job to any available fresh runner. If you pinned a runner to job A, GitHub
might hand it job B instead; a naive "I already have a runner for job A" dedup would
then never mint again and **starve A indefinitely**. Counting demand and letting the
scheduler match sidesteps the whole class of assignment races. The cost — an
occasional over-mint when two polls both see the same demand — is cheap and
self-correcting: the extra runner idles and the watchdog reaps it. `unassignedByFlavor`
/ `unassignedByRepoFlavor` damp the common case so it rarely happens.

**Where:** demand math in `runDispatcher` (`src/dispatcher.js`);
`countQueuedMatchingJobs` (`src/github.js`).

### JIT runners for statelessness

**Decision:** use `generate-jitconfig` ephemeral runners, one job each, over
long-lived registered runners.

**Why:** a JIT runner carries no persistent registration credential on disk, takes a
single job, then auto-deregisters and removes `.credentials`/`.runner`. There is no
standing runner to compromise, no registration token to leak, and no cross-job
workspace to poison. Statelessness is the product.

**Consequence — the idle-watchdog requirement:** an **unassigned** JIT runner does
not self-exit; it hangs on "Listening for Jobs". Confirmed on Win11+WSL. So the
launcher must arm a timer (`idleTimeoutMs`, default 120s) and force-stop a runner
that never picks up a job, otherwise the concurrency slot leaks and the dispatcher
eventually wedges. The `linux` flavor watches runner stdout/stderr for a job-start
line; seeing one cancels the timer and fires `onStarted` (which clears the runner's
"unassigned" bookkeeping). Not seeing one before the timeout stops the container and
resolves `{ startedJob: false }`.

**Where:** `linux.launch` timer/`isJobStartLine`/`stopContainer` in
`src/sandbox/container.js`.

### Container isolation so a job can't read host credentials

**Decision:** run each linux job inside a **throwaway rootless container** from a fat
image (`catthehacker/ubuntu:full-latest` by default), not directly on the host.

**Why:** a self-hosted runner executes arbitrary workflow code. On a bare host that
code could read your keychain, `~/.aws`, `gh` token, SSH keys, or other repos'
caches. A rootless `--rm` container gives the job its own filesystem and process
namespace; it cannot see the host's secrets or the dispatcher's memory. This was
**validated** — a test job could not read a host secret. The runner binary is mounted
**read-only** and copied into a fresh writable dir by `INNER_SCRIPT`, which also wipes
`_work _diag .runner .credentials*` before launch so nothing leaks in from a prior
build of the image layer.

**JIT config delivery:** the encoded config is passed via the `JITCFG` **environment
variable** (`-e JITCFG`; `WSLENV` carries it across the Windows→WSL boundary), never
as an argv token — so it never appears in the host process table or a log.

**Where:** `INNER_SCRIPT`, the `podman run --rm -e JITCFG -v ...:ro` invocation, and
`invocation()`/WSL staging in `src/sandbox/container.js`; `ensureImage`/
`ensureRunnerBinary` in `src/runner.js`.

### Fail-closed privacy

**Decision:** only `private`, User-owned, non-fork, non-archived repos are eligible,
and privacy is **re-checked immediately before every mint**, returning "not private"
on any error.

**Why:** there is a window between the poll that enumerated repos and the moment we
mint. A repo could flip public in that window; running CI for a now-public repo on
your machine, with your token, is exactly what we must not do. `isStillPrivate`
re-confirms private + User-owned right before minting and returns `false` on any
exception or non-2xx (`src/github.js`), so ambiguity denies the mint rather than
allowing it. Forks are excluded because a fork's workflow can be attacker-authored.

**Where:** `listOwnedPrivateRepos` / `isStillPrivate` (`src/github.js`); the pre-mint
guard in `runDispatcher` (`src/dispatcher.js`).

### Deregister on failure, reconcile always

**Decision:** if a runner is registered but its launch fails, delete the registration
(and back the repo off briefly). Independently, on startup and every `reconcileMs`
(default 5min), delete any **offline** `runnerize-*` runner registration.

**Why:** a JIT config that was generated but never successfully launched would
otherwise leave an orphan registration on the repo. The launch-failure path deletes
it immediately; the periodic reconcile is the backstop that cleans up anything left
by a crash or a machine that was powered off mid-job. Both only ever touch
registrations named `runnerize-*`, so they never disturb a user's own runners.

**Where:** the launch `catch` in `runDispatcher` and `reconcile()`
(`src/dispatcher.js`); `deleteRunner` tolerates a 404 (`src/github.js`).

### Semaphore released exactly once

**Decision:** a single `Semaphore` bounds concurrency; each `acquire()` has exactly
one `release()` on one `finally`, and the class throws if released more than acquired.

**Why:** the concurrency slot is the scarce resource. A double-release would let the
dispatcher over-mint past `maxConcurrent`; a missed release would slowly starve it to
zero. Funneling release through a single `finally` on the launch promise, plus a
`Semaphore` that throws on "released more than once", makes both bugs loud instead of
silent.

**Where:** `Semaphore` and the launch `finally` in `src/dispatcher.js`.

### Bounded, resilient GitHub I/O

**Decision:** every request has a per-request timeout via `AbortController` (default
20s); GETs send `If-None-Match` and cache by ETag; rate limits honor `Retry-After` /
`x-ratelimit-*` with exponential backoff behind a shared pause gate; the poll cadence
adapts to repo count.

**Why:** the dispatcher is a single long-running loop. One hung request without a
timeout would wedge the entire loop and silently stop all dispatch — so every await
that can hang is bounded. ETag caching keeps the frequent polls cheap and mostly
exempt from the primary rate limit (a 304 doesn't count against the 5000/hr primary
limit, though it still counts against secondary limits, which is why backoff is still
required). The shared `rateLimitGate` means one throttled request pauses the others
instead of each independently hammering the API. The ETag cache is a **bounded LRU**
(cap 500) because per-run job keys would otherwise grow without limit.

**Where:** `api()`, `pauseRateLimit`/`awaitRateLimit`, the ETag LRU, and
`retryDelayMs`/`isRateLimited` in `src/github.js`; `pollDelay` in `src/dispatcher.js`.

### Runner binary integrity

**Decision:** download the official `actions/runner` release and **verify its SHA-256**
before use; cache the verified copy; extract atomically.

**Why:** the runner binary executes with your permissions. Verifying the published
digest (from the asset's `digest` field, a `.sha256` sidecar asset, or the release
body, in that order) ensures a corrupted or tampered download is rejected. Extraction
goes to a temp dir and is atomically `rename`d into place, so a partial download never
presents as a usable runner; on macOS `xattr -c` clears the quarantine bit.

**Where:** `ensureRunnerBinary` / `publishedDigest` (`src/runner.js`).

### Graceful drain, and services that don't kill in-flight jobs

**Decision:** on `SIGINT`/`SIGTERM` stop minting and await in-flight launches before
exiting. The systemd unit uses `KillMode=mixed` with `TimeoutStopSec=infinity`.

**Why:** killing the dispatcher shouldn't kill a job that's already running. The CLI
aborts a shared `AbortController`; `runDispatcher` breaks its loop and
`Promise.allSettled`s the in-flight launches. For the boot service, the default
systemd behavior would `SIGTERM` the whole cgroup — including the `run.sh` children —
on a restart; `KillMode=mixed` signals only the main process and leaves the job's
process subtree alone to finish.

**Where:** signal handling in `bin/runnerize.js`; the drain `finally` in
`runDispatcher`; unit generation in `src/service.js`.

## Sandbox flavors

`detectFlavors()` returns the flavors the current host can serve *now*
(`available()` true). Today only `linux` is implemented and working; `windows`
(Windows Sandbox `.wsb`) and `macos` (`tart` VM) are stubs whose `available()` returns
`false` and whose `launch()` throws. Adding a backend means implementing the same
`FLAVOR` interface (`key`, `labels`, `available()`, `launch()`), and — critically —
carrying the same invariants into it: statelessness, one job per instance, the idle
watchdog, JIT config via env not argv, and deregister-on-failure.

## Known limitations (by design, for now)

- **Single point of presence.** One dispatcher process; if it's down, jobs queue up
  to GitHub's 24h timeout. WSL/macOS aren't guaranteed always-on across a headless
  reboot.
- **Latency.** Per-job latency is roughly poll interval + container start. Great for
  occasional private-repo CI; not for a tight edit-run loop.
- **Native Windows/macOS statelessness needs VMs**, which are heavier than Linux
  containers — hence those flavors are opt-in and staged behind the working linux one.
- **Auth is dev-grade in v0.1** (PAT/`gh` token). A scoped, short-lived GitHub App
  installation token (`actions:write` + `metadata:read`, no code access) is the
  intended production credential and is on the roadmap.
