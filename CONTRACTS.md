# runnerize — frozen build contracts (v0.1)

Zero-dependency **Node ESM** (`type:module`, Node ≥18). No npm deps — use built-in `fetch`, `node:crypto`, `node:child_process`, `node:fs`, `node:os`, `node:readline`, `node:util`. Wraps the official `actions/runner` via **JIT** runners. Architecture: one always-on **dispatcher** + ephemeral one-job runners in throwaway sandboxes. **COUNT-BASED, never job-pinned.**

These contracts are FROZEN. Implement to these signatures exactly so modules integrate. Do not invent new cross-module APIs.

## Spike-validated primitives (build on these; already proven on Win11+WSL — do not re-derive)

- **JIT mint:** `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`, body `{ name, runner_group_id: 1, labels: [...], work_folder: "_work" }` → `{ encoded_jit_config }`. `runner_group_id` is **required and `1` is accepted for personal (User) repos**. A repo-scoped token authorizes.
- **Launch:** `./run.sh --jitconfig <b64>` (linux/mac) or `run.cmd --jitconfig <b64>` (win). Runs exactly **one** job, then auto-deregisters and removes `.credentials`/`.runner`. Fully stateless.
- **CONFIRMED:** an **unassigned** JIT runner **hangs** on "Listening for Jobs" — it does NOT self-exit. → **REQUIRED: an idle watchdog** kills the runner process after `idleTimeoutMs` (default 120000) if no job has started; the concurrency slot is released when the process exits (single `finally`, guaranteed-once).
- **Linux backend (default, validated):** run the runner **inside a rootless Podman `--rm` container** from a fat image so the job cannot read host credentials/caches (isolation validated: a job could not read a host secret). Validated recipe:
  ```
  podman run --rm -e JITCFG -v <runnerBinDir>:/rsrc:ro -v <innerScript>:/inner.sh:ro <image> bash /inner.sh
  # inner.sh: copy /rsrc → fresh writable dir; cd; rm -rf _work _diag .runner .credentials*; export RUNNER_ALLOW_RUNASROOT=1; run.sh --jitconfig "$JITCFG"
  ```
  Pass the JIT config via `-e JITCFG` (env), never as an argv token on the host side. Fat image default `catthehacker/ubuntu:full-latest` (configurable); the runner binary is mounted read-only and copied in.

## THE CORE ALGORITHM — count-based dispatcher (reliability-review corrected)

**NEVER pin a runner to a `job.id`.** GitHub's scheduler assigns any label-matching queued job to a fresh runner, so a "runner for job A" may consume job B; job.id dedup then starves A. Instead scale **count**:

```
every POLL_INTERVAL (default 15s, adaptive with repo count):
  repos = listOwnedPrivateRepos()                 // private && owner==me && type==User && !fork
  for each FLAVOR the host can serve (linux always; windows if Windows Sandbox enabled; macos if on a Mac):
    demand = sum over repos of countQueuedMatchingJobs(repo, flavor.labels)
             // POLL COMPLETENESS: scan runs with status IN {queued, in_progress}, then their /jobs where status=="queued";
             //   count jobs whose runs-on labels ⊆ flavor.labels. bare [self-hosted] → the linux (default) flavor only.
    inflight = runnersRecentlyMintedNotYetConsumed(flavor)     // damp double-mint across polls
    toMint = clamp(demand - inflight, 0, semaphore.free())
    repeat toMint times:
      repo = a repo with unmet queued demand for this flavor
      if not (await isStillPrivate(repo)) : continue           // FAIL-CLOSED re-check right before mint
      semaphore.acquire()
      jit = await generateJitConfig(repo, flavor.labels)
      flavor.launch(jit, { idleTimeoutMs }).finally(() => { semaphore.release(); markConsumed(flavor) })
  Reconcile (startup + every RECONCILE_INTERVAL, default 5min): per repo listRunners() → deleteRunner() for offline/stale
    ephemeral registrations; reap orphaned run.sh PIDs + leftover temp dirs from a prior crash.
```

Over-mint race (two polls both mint for the same demand) is acceptable: the loser runner idles and the **watchdog** kills it, releasing the slot. `inflight`/`markConsumed` damps it.

## Auth

Default: **GitHub App installation token** (short-lived 1h, scoped repos, `actions:write` + `metadata:read`, no code access). Fallback: fine-grained PAT. Resolve order for **dev/spike**: `$GH_TOKEN`/`$GITHUB_TOKEN` → `gh auth token`. Held only by the dispatcher, in memory + encrypted at rest (OS keychain: DPAPI/Keychain/libsecret via shell-out; else `0600` file). Never on argv. Alert/refresh before expiry; on 401 the system must log loudly, not silently go dark.

## Rate limits & resilience

- ETag/`If-None-Match` on every poll GET (304 is exempt from the **primary** 5000/hr limit but **not** secondary limits).
- Honor `Retry-After` + `x-ratelimit-*`; exponential backoff on 403/secondary limits. Adaptive poll cadence scaling with repo count.
- **Per-request HTTP timeout** (default 20s) via `AbortController` — a hung request must not wedge the loop.
- Dispatcher is a boot service; on `SIGTERM` it **stops minting and drains in-flight runners**, then exits.

## Module & file ownership (no two workers touch the same file)

- **Worker A → `src/github.js`**: token provider; HTTP client (built-in `fetch` + `AbortController` timeout, ETag cache, backoff, off-argv); `getUser()`, `listOwnedPrivateRepos()`, `isStillPrivate(fullName)`, `countQueuedMatchingJobs(fullName, flavorLabels)`, `generateJitConfig(fullName, labels)`, `listRunners(fullName)`, `deleteRunner(fullName, id)`.
- **Worker B → `src/platform.js`, `src/runner.js`, `src/sandbox/container.js`, `src/sandbox/index.js`**: OS/arch/WSL detection + stable machine-id; runner download + **SHA-256 verify** (against release metadata) + cache + `xattr -c` on mac; ensure fat image present; the **FLAVOR interface** + the validated rootless-Podman `linux` flavor with the **idle watchdog**. Stub `windows` (Windows Sandbox, `available()` checks the feature) + `macos` (`tart`) flavors.
- **Worker C → `src/dispatcher.js`, `bin/runnerize.js`, `src/service.js`**: the count-based loop + semaphore + reconcile + SIGTERM drain; CLI (`run` [foreground], `status`, `remove`, `service install`); service install (systemd unit `KillMode=mixed` so a daemon restart does NOT kill in-flight `run.sh` children; launchd LaunchAgent; Windows Service).
- **Lead → `package.json`, `CONTRACTS.md`, integration + spike-repo testing.**

## Frozen signatures (ESM)

```js
// src/github.js
export async function getToken();                                  // resolves the dev token (env → gh)
export async function api(method, path, { body, etagKey, timeoutMs } = {}); // {status, data, notModified}
export async function getUser();                                   // { login, type }
export async function listOwnedPrivateRepos();                     // [{ full_name, private, fork, archived }] filtered private+owner+User+!fork
export async function isStillPrivate(fullName);                    // boolean (fail-closed: false on error)
export async function countQueuedMatchingJobs(fullName, flavorLabels); // integer; scans {queued,in_progress} runs → queued jobs, labels ⊆ flavorLabels
export async function generateJitConfig(fullName, labels);         // encoded_jit_config string
export async function listRunners(fullName);                       // [{ id, name, status, labels:[string] }]
export async function deleteRunner(fullName, id);                  // void

// src/sandbox/index.js  — FLAVOR interface
// flavor = { key:'linux'|'windows'|'macos', labels:string[], async available():boolean,
//            async launch(encodedJitConfig, { idleTimeoutMs }):Promise<{ startedJob:boolean }> }
export async function detectFlavors();                             // FLAVOR[] the host can serve now

// src/dispatcher.js
export async function runDispatcher({ maxConcurrent=4, pollIntervalMs=15000, idleTimeoutMs=120000, reconcileMs=300000, signal });
```

Language: modern ESM, small pure functions, defensive (timeouts, try/finally). No secrets in logs. No AI/Anthropic/Claude attribution anywhere.
