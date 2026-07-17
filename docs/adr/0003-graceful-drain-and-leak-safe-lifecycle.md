# 0003 — Graceful drain on shutdown and leak-safe runner lifecycle

## Status

Proposed (2026-07-16).

## Context

The dispatcher mints ephemeral, single-job JIT runners on demand: it polls the
operator's owned private repos, and when a queued job matches a flavor it mints a
runner (a rootless container for `linux`, a Windows Sandbox for `windows`, a tart
VM for `macos`) that runs exactly one job and then exits. Between jobs nothing is
registered — that statelessness is the design's core property (see ADR 0001/0002).

Two robustness gaps surfaced during live operation on the Windows 11 + WSL host:

1. **Shutdown has no bounded drain — it aborts or hangs.** `systemctl --user stop
   runnerize` (or any SIGTERM) has no well-defined drain semantics. Observed: the
   unit sat in `deactivating` for 90s+ waiting on an in-flight runner, with no
   timeout to force progress. In practice a stop / restart / upgrade can either
   hang effectively indefinitely, or — if forced — abort a job mid-execution.

2. **Runners leak across dispatcher restarts.** A runner container was observed
   `Listening for Jobs` idle for ~48 minutes — far past the 120s idle-teardown —
   before eventually claiming a job. Root cause: the idle-teardown timer lives
   inside the dispatcher process (`observeRunner`). When the dispatcher is
   restarted / killed / paused while a runner is in flight, that timer dies with
   the process, but the container (or VM) keeps running, orphaned. The orphan
   stays registered and online and can claim later jobs unpredictably. This is a
   likely contributor to CI E2E flakiness: an orphan on the account races the CI's
   own JIT runner for the queued smoke job, and when the orphan wins the CI test
   sees `startedJob: false`.

Operator requirements, stated directly: never abort a running job; restart /
refresh / upgrade only when idle, or after a bounded graceful drain; never leak
runners.

## Decision

### 1. Graceful drain on SIGTERM/SIGINT

On signal, enter a `draining` state instead of exiting abruptly:

- Immediately stop minting new runners (halt the poll/mint loop).
- Track every in-flight `launch()` lifecycle in a live registry.
- Wait for in-flight runners to finish their single job, bounded by a **drain
  deadline** (`RUNNERIZE_DRAIN_TIMEOUT_MS`, default 15 min; a single job is itself
  capped by GitHub's per-job timeout).
- On deadline expiry, force-reap any remaining runners (stop the container/VM,
  deregister the runner) with a loud warning naming each, then exit — never hang.
- Set systemd `TimeoutStopSec` just above the drain deadline and `KillMode=mixed`
  (and the equivalent on the Windows launcher) so a genuinely wedged process is
  eventually force-killed rather than sitting in `deactivating` forever.

### 2. Leak-safe lifecycle across restarts and crashes

- **Startup reconciliation.** On boot, before polling, enumerate `runnerize-*`
  containers/VMs on the host and offline/stale `runnerize-*` runners on the
  account, and reap orphans (stop the container/VM, deregister the runner). This
  heals orphans left by a prior hard crash, kill, or restart. Reconciliation must
  be scoped so it does not reap a *legitimately busy* runner owned by a
  concurrently-running second dispatcher (scope by host ownership and/or a short
  `busy` grace check).
- **Per-runner hard max lifetime.** Every runner (container/VM) self-terminates
  after a bounded lifetime regardless of the dispatcher, so an orphan can never
  listen indefinitely even if startup reconciliation misses it. This is the
  crash-proof backstop the in-process idle timer cannot be.
- Keep the existing in-process idle-teardown as the fast path; startup
  reconciliation and max-lifetime are the durability backstops.

### 3. Zero-abort upgrades

- `service` upgrade / reinstall triggers the same drain: stop minting, let
  in-flight jobs finish (bounded), then swap the materialized app and restart.
  Because each runner is already one-job-and-done, the daemon is inherently safe
  to restart *between* jobs; the drain simply closes the mid-job window.

## Consequences

- **Pros:** restart / refresh / upgrade never aborts a running job; no orphaned or
  leaked runners across restarts or crashes; shutdown always terminates in bounded
  time; removes a likely source of CI E2E flakiness (orphans racing for queued
  jobs).
- **Cons:** restart latency is bounded by in-flight job duration — mitigated by
  stopping minting immediately, the drain deadline capping the wait, and force-reap
  as the escape hatch. Added complexity: an in-flight lifecycle registry, startup
  reconciliation, and a per-runner max-lifetime that must be implemented for each
  flavor (container / sandbox / VM).
- **Testing:** drain and reconciliation are hermetically unit-testable with the
  existing spawn stubs (SIGTERM while a fake runner is in flight → no new mints,
  bounded wait, force-reap on deadline; startup with a pre-existing `runnerize-*`
  container → reaped before polling). Validate end to end on the live Windows +
  WSL host, and on the macOS/tart flavor once Apple hardware is available.
- **Release:** internal robustness only, no public API change — this can ship
  without a version bump; it rides the next tag-driven release.
