# AGENTS.md

Guide for an AI agent (or any newcomer) working in **runnerize**. Read this first,
then `CONTRACTS.md`, then the `src/` file you're touching. The prime directive:
**leave the repo better than you found it and never regress an invariant.**

---

## What this is

runnerize gives you on-demand, **stateless** self-hosted GitHub Actions runners for
your **private** repos, so private-repo CI runs on your own machine instead of
GitHub-hosted minutes, with no standing runners left registered.

One always-on **dispatcher** polls your owned-private repos. When it sees queued
jobs whose labels a sandbox flavor can serve, it mints a **just-in-time (JIT)**
runner per unit of demand and launches each inside a **throwaway rootless
container**. The runner takes exactly one job, auto-deregisters, and the container
is destroyed. Nothing persists; the job never sees your host credentials or caches.

Status: **v0.1**, live-validated on Windows 11 + WSL2 (rootless Podman). The
`macos` (`tart`) and native `windows` (Windows Sandbox) flavors are detected-and-
stubbed opt-ins, not yet exercised end to end.

**Zero runtime dependencies.** Node ESM, `>=18`, built-ins only (`fetch`,
`node:crypto`, `node:child_process`, `node:fs`, `node:os`, `node:util`, ...).

---

## Orientation: read in this order

1. `README.md` — user-facing intent, security model, backend matrix, limitations.
2. `CONTRACTS.md` — the **frozen** cross-module signatures. Do not invent new
   cross-module APIs; implement to these exactly.
3. This file — invariants and the module map.
4. `docs/ARCHITECTURE.md` — the *why* behind the reliability/security decisions.
5. The specific `src/` module you're changing.

---

## Architecture in one diagram

```
bin/runnerize.js        CLI: run | status | remove | service | --help
      │                 parses flags, installs SIGINT/SIGTERM → AbortController
      ▼
src/dispatcher.js       runDispatcher(): the count-based loop
      │                 semaphore · inflight damping · reconcile · SIGTERM drain
      ├──────────────► src/github.js      all GitHub REST I/O (token, ETag, backoff)
      └──────────────► src/sandbox/index.js  detectFlavors()
                              │
                              ├── container.js  linux flavor (WORKING): rootless
                              │                 podman/docker, native or via WSL,
                              │                 idle watchdog, INNER_SCRIPT
                              ├── windows.js    stub flavor (Windows Sandbox)
                              └── macos.js      stub flavor (tart VM)
      src/runner.js     download + SHA-256-verify actions/runner; ensure fat image
      src/platform.js   OS/arch/WSL detection; stable machineId
      src/service.js    install/uninstall boot service (systemd/launchd/nssm)
```

## Module map

| File | Owns | Key exports |
|---|---|---|
| `src/github.js` | All GitHub REST. Token resolution, `fetch` client with per-request `AbortController` timeout, ETag/`If-None-Match` LRU cache, rate-limit backoff via a shared pause gate. | `getToken`, `api`, `getUser`, `listOwnedPrivateRepos`, `isStillPrivate`, `countQueuedMatchingJobs`, `generateJitConfig`, `listRunners`, `deleteRunner` |
| `src/dispatcher.js` | The core loop. `Semaphore` class, count-based demand math, `unassignedBy*` inflight maps, per-repo launch-failure backoff, startup + periodic reconcile, graceful drain. | `runDispatcher` |
| `src/sandbox/index.js` | Flavor registry. | `detectFlavors`, re-exports `linux`/`windows`/`macos` |
| `src/sandbox/container.js` | The `linux` flavor (the only working one). Picks a backend (native podman/docker, or WSL distro on Windows), pulls the fat image, stages the runner + `INNER_SCRIPT`, spawns the `--rm` container, runs the **idle watchdog**, detects job start from runner output. | `linux` |
| `src/sandbox/windows.js`, `macos.js` | Stub flavors: `available()` returns `false`, `launch()` throws. Fill these in to add a backend. | `windows`, `macos` |
| `src/runner.js` | Fetch `actions/runner` latest release, **SHA-256-verify** the asset (digest field → `.sha256` asset → release body), extract, `xattr -c` on mac, atomic-rename into `~/.runnerize/runners`; ensure the fat image is present. | `latestRunnerVersion`, `ensureRunnerBinary`, `ensureImage` |
| `src/platform.js` | `detectOS`/`detectArch`/`isWSL`; a stable `machineId` (sha256 of `/etc/machine-id`, `IOPlatformUUID`, or `MachineGuid`; falls back to a hostname hash). | `detectOS`, `detectArch`, `isWSL`, `machineId` |
| `src/service.js` | Boot-service install/uninstall: systemd **user** unit (`KillMode=mixed` so a daemon restart does not kill in-flight `run.sh` children), launchd LaunchAgent, Windows service via `nssm.exe`. | `installService`, `uninstallService` |
| `bin/runnerize.js` | CLI entry. Subcommands, flag parsing, `--dry-run`, signal handling. | (executable) |

The `FLAVOR` interface every sandbox implements:

```js
flavor = {
  key: 'linux' | 'windows' | 'macos',
  labels: string[],                        // e.g. ['self-hosted','linux','x64']
  async available(): boolean,              // can this host serve this flavor now?
  async launch(encodedJitConfig, { idleTimeoutMs, onStarted }): { startedJob: boolean },
}
```

---

## Invariants — never regress these

These are the reason runnerize is safe and reliable. Every one of them came out of
adversarial review (see `docs/ARCHITECTURE.md`). If a change would weaken one, it is
wrong — stop and reconsider, don't work around it.

1. **Count-based, NEVER job-pinned.** The dispatcher scales the *number* of runners
   to queued demand and lets GitHub's scheduler assign jobs. It must never mint "a
   runner for job X" keyed on a `job.id`. GitHub can hand any label-matching queued
   job to any fresh runner, so a runner "for job A" may consume job B; job-id dedup
   then starves A forever. See `runDispatcher` demand math in `src/dispatcher.js` and
   `countQueuedMatchingJobs` in `src/github.js`.

2. **Fail-closed privacy re-check.** `isStillPrivate(repo)` is called immediately
   before every mint (`src/dispatcher.js`), and `isStillPrivate` (`src/github.js`)
   returns `false` on *any* error or non-2xx. A repo that flipped public between the
   poll and the mint, or any ambiguity, must never get a runner. Only repos that are
   `private` + owner is the authenticated user + `type === 'User'` + not a fork + not
   archived are ever considered (`listOwnedPrivateRepos`).

3. **Tokens off argv, never logged.** The credential travels in the `Authorization`
   header only. The JIT config reaches the container via the `JITCFG` **environment
   variable** (`-e JITCFG`, plus `WSLENV` for WSL) — never as a command-line token on
   the host. Nothing secret is ever written to a log line. The structured `log()`
   helper only ever receives event names and non-secret fields.

4. **Semaphore released exactly once.** Every `semaphore.acquire()` is paired with a
   single `semaphore.release()` in one `finally` on the launch promise
   (`src/dispatcher.js`). The `Semaphore` class throws if released more than acquired
   ("released more than once") or acquired past capacity — a deliberate tripwire.
   Never add a second release path.

5. **Stateless / ephemeral.** Each job runs in a fresh sandbox from a fat image, takes
   exactly one job, then the runner auto-deregisters and the container is `--rm`-
   destroyed. `INNER_SCRIPT` copies the read-only runner into a throwaway writable
   dir and wipes `_work _diag .runner .credentials*` first. No cross-job state, no
   persisted credentials, no long-lived registration.

6. **JIT via env, not argv.** JIT runners are minted with
   `generate-jitconfig` and launched with `run.sh --jitconfig <cfg>` where the config
   value is delivered through the environment (see invariant 3). This keeps it off
   the host process table.

7. **Idle watchdog kills unassigned runners.** An unassigned JIT runner **hangs** on
   "Listening for Jobs" — it does not self-exit. The `linux` flavor arms a timer for
   `idleTimeoutMs` (default 120000); if no job-start line is seen, it force-stops the
   container and resolves `{ startedJob: false }`, which releases the slot. Removing
   or defeating this watchdog leaks slots and wedges the dispatcher.

8. **Deregister on failure.** If a runner is registered (JIT config generated) but the
   launch fails, the dispatcher deletes the runner registration and applies a per-repo
   backoff, so no orphan registration is left behind.

9. **Bounded, defensive I/O.** Every network/subprocess call has a timeout
   (`AbortController` / `AbortSignal.timeout` / spawn timers). A hung request must not
   wedge the loop. Rate limits honor `Retry-After` and `x-ratelimit-*` with backoff;
   GETs send `If-None-Match` and treat 304 as cache hits.

10. **Graceful drain on shutdown.** On `SIGINT`/`SIGTERM` the CLI aborts the shared
    `AbortController`; `runDispatcher` stops minting and `await`s in-flight launches
    (`Promise.allSettled`) before returning. Never `process.exit()` out from under a
    live runner.

11. **Zero dependencies, no attribution.** No npm runtime deps — Node built-ins only.
    No AI/Claude/Anthropic/Copilot attribution anywhere: not in code, comments, docs,
    commits, or PRs.

---

## Frozen contracts

`CONTRACTS.md` is the source of truth for cross-module signatures and is **frozen**.
Highlights an agent trips over most:

- **JIT mint:** `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig` with
  `{ name, runner_group_id: 1, labels, work_folder: "_work" }`. `runner_group_id` is
  required and `1` is accepted for personal (`User`) repos.
- **Launch:** `run.sh --jitconfig <b64>` (linux/mac) / `run.cmd --jitconfig <b64>`
  (win). Runs one job, then removes `.credentials`/`.runner` and deregisters.
- **`countQueuedMatchingJobs`** scans runs with status in `{queued, in_progress}`,
  then their `queued` jobs, counting those whose labels are a subset of the flavor's
  labels. A bare `[self-hosted]` job matches the **linux (default)** flavor only
  (`isDefault`), so it isn't double-counted across flavors.
- The `FLAVOR` interface and `runDispatcher({ maxConcurrent, pollIntervalMs,
  idleTimeoutMs, reconcileMs, signal })` shape above.

If you genuinely need to change a contract, update `CONTRACTS.md`, this file, the
tests, and every implementer in the same change — and say so explicitly in the PR.

---

## Build, test, run locally

Requirements: **Node ≥ 18**, and for the `linux` flavor a container runtime
(`podman` preferred, or `docker`) — native on Linux, or inside a WSL2 distro on
Windows. A GitHub token via `$GH_TOKEN`/`$GITHUB_TOKEN` or `gh auth token`.

```bash
npm test              # unit tests: node --test test/unit  (the required gate)
npm run test:e2e      # end-to-end: node --test test/e2e   (needs runtime + token)
npm run test:all      # everything

node bin/runnerize.js --help
node bin/runnerize.js status            # who am I, which repos, live runners
node bin/runnerize.js run --dry-run     # enumerate demand, mint nothing (safe)
node bin/runnerize.js run               # start the dispatcher (foreground)
node bin/runnerize.js remove            # one cleanup pass of offline runnerize-* runners
```

`--dry-run` is the safe way to exercise the GitHub read path against a real account
without minting anything. See `docs/DEVELOPMENT.md` for the throwaway spike-repo
pattern, the `RUNNERIZE_*` knobs, and the Windows+WSL path gotchas.

**Tests are a required gate.** Do not mark work done with a failing or skipped test.
If you can't run the e2e path (no runtime/token), say so explicitly rather than
claim it passed.

---

## Conventions

- **ESM, modern JS.** Small pure functions where possible; side effects at the edges.
- **Defensive by default.** Timeouts on every await that can hang; `try/finally` for
  cleanup; validate inputs (see the guards in `runDispatcher` and `linux.launch`).
- **Structured logs only.** One JSON object per line via the `log()` helper. Never
  interpolate secrets. Prefer an event name + fields over prose.
- **No new dependencies.** If you reach for a package, find the built-in instead.
- **Match the surrounding style.** 2-space indent, no semicolizing surprises; read the
  neighboring code and mirror it. LF line endings (`.editorconfig` / `.gitattributes`
  enforce this — a CRLF in an embedded bash heredoc breaks the runner).
- **No attribution to any AI/assistant** anywhere.
- **Commit style:** imperative subject ("Add idle-watchdog force-settle"), no
  attribution trailers. See `CONTRIBUTING.md`.

---

## Leave it better than you found it — checklist

Before you hand off any change:

- [ ] The invariants above still hold. Re-read the numbered list against your diff.
- [ ] `npm test` passes. If you touched the sandbox/dispatcher path and can run it,
      `npm run test:e2e` too — otherwise state that you couldn't and why.
- [ ] Tests were **added or updated** for the behavior you changed. A bug fix ships
      with a test that would have caught it.
- [ ] Docs updated in the same change: this file for module/invariant changes,
      `CONTRACTS.md` for signature changes, `docs/` for architecture/dev-flow changes,
      `README.md` (owned by others — flag it) for user-facing changes.
- [ ] No secrets staged, no token in any log path, no new dependency.
- [ ] No AI/assistant attribution in code, comments, docs, commit messages, or PR.
- [ ] You **verified**, not asserted: you ran the code or the test and observed the
      result. A claim in prose is worth nothing against state you didn't check.

If you fix a lint error, a flaky test, or an obvious nearby defect while you're in
there, good — fold it in. Just keep it scoped and mentioned in the PR.
