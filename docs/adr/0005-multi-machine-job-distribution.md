# ADR 0005 — Multi-machine job distribution

## Status

Proposed (2026-07-17).

## Context

runnerize runs one independent, stateless dispatcher per machine. When multiple machines share a GitHub account they poll the **same** owned-private repos with **zero cross-machine coordination**: each computes the same queued-job demand and independently mints a JIT runner. Confirmed in the code (`src/dispatcher.js` poll/mint loop, `src/github.js` `countQueuedMatchingJobs`/`generateJitConfig`; no `Math.random`, no shared state; `CONTRACTS.md` even documents the over-mint race as "accepted" — reasoning written for one process across polls, but the mechanics are identical across machines).

Failure modes:
- **Thundering herd.** N dispatchers → up to N runners minted per job, N−1 wasted (boot, idle, reaped by the 120s watchdog). Cost is **flavor-dominated**: linux container (seconds) ≪ windows sandbox (VM boot; `maxConcurrent=1`, so a wasted mint blocks the whole host for its lifetime) < macOS tart VM (clone+boot minutes + idle + cleanup).
- **No fairness.** GitHub hands a queued job to the first matching **online+idle** runner; selection among several simultaneously-idle runners is undocumented (no round-robin/weighting). The fastest-polling / fastest-booting machine (containers beat VMs) tends to win repeatedly; load does not balance.
- **Job "theft."** A co-polling machine's identically-labeled runner claims a job intended for another (verified in this project's own CI via the raw jobs API). This is a **fungibility** problem — GitHub intentionally cannot distinguish identically-labeled runners — **not** a race, and it is not fixable by jitter/backoff/re-reads.

**GitHub assignment semantics (sourced).** Assignment is a *push over a per-runner long-poll session*: the backend delivers each job to exactly one online+idle+matching runner's session; other eligible idle runners never see it. This gives **single-assignment** (no double execution on the happy path) but **no documented fairness** and, under failure (60s re-queue, lease expiry, watchdog kill), **at-least-once** effects. JIT/ephemeral changes provisioning, not routing. Runner groups are access-control + a concurrency ceiling, not load distribution. Crucially, GitHub assigns **only to online runners** — an offline JIT-registered runner is peer-visible via `listRunners` but not yet assignable, which is the lever for reservation-based coordination.

**Reframe that makes this tractable:** because GitHub guarantees single-assignment (+ happy-path single-execution), **no distribution scheme risks correctness**. The problem is purely **wasted mints + fairness + theft** — so a weak, eventually-consistent, decentralized coordination layer suffices; no consensus/leader-election is required.

**Hard constraints that bound every design:**
- **REST rate limits are first-order.** N machines × M repos × (runs + per-run job calls) every P seconds overruns a personal PAT (~1,000/hr sustained) quickly; there is also a 1,500-registrations / 5-min cap. This argues **against** "idle polls fastest."
- **`listRunners` is eventually consistent and ambiguous.** `online && !busy` is not reserved capacity; a fresh JIT runner is `offline` until it connects (indistinguishable from dead/hung). Counting `offline` as supply risks 24h starvation from a crashed registration; not counting it risks over-provision during multi-minute boots. Any use of it must **fail open** (on error, prefer to mint — never starve).
- **Fungibility → theft is only fixable by labels/groups.**
- **Load must be capacity-normalized** (free slots as a fraction of real capacity; a linux slot ≠ a macOS slot).
- **Local correctness:** consume the capacity cap **atomically at mint-decision** (before async JIT generation); start the idle watchdog only **after** the runner is genuinely online+idle; make "full ⇒ don't poll" a **completion-triggered wakeup + periodic fallback** so a lost completion event can't permanently disable polling.

## Decision

A tiered, independent, additive design. Ship Layer 0 now; validate-then-adopt Layer 1; expose Layer 2 as opt-in; lean on Layer 3.

### Layer 0 — load-adaptive polling backoff + phase jitter (this ADR ships)
A purely local load-shaping heuristic (no shared state, churn-trivial):
- **Phase jitter** on every poll (randomize *when* each machine polls) to break cross-machine lock-step. (There is no randomness in the scheduler today.)
- **Load-adaptive interval:** the poll interval **increases with load** — the fewer free slots, the longer the wait — so idle machines observe queued jobs first and work drifts to the least-loaded host. Bounded by a **rate-safe floor** (the idle interval; explicitly *not* "fastest possible", which aggravates the herd at scale and blows the rate budget) and a cap.
- **Capacity-normalized load:** scale on free-slots-as-fraction-of-real-capacity.
- **Atomic capacity cap** at mint-decision; watchdog started only after online+idle; a full host polls at the long fallback with a **completion-triggered immediate wakeup** + periodic fallback.
- **Honest framing:** this is a heuristic, not a protocol. It changes which machine *tends* to act; it does not prevent duplicate mints (GitHub still resolves the winner). Big win for the common small, heterogeneous, container-heavy fleet; residual herd persists among *equally-idle* machines and at large N.

### Layer 1 — reservation-before-boot (validate → adopt)
The real decentralized anti-duplication primitive. Split minting into **register, then boot**:
1. **Cheap claim:** `generate-jitconfig` to *register* a runner (no boot), encoding a demand-epoch bucket + a random/`machineId` priority in the name. It is peer-visible via `listRunners` but, being `offline`, not yet assignable by GitHub.
2. **Elect, then boot:** read `listRunners`; only the **highest-priority contender per demand slot** boots the expensive VM/sandbox; losers immediately `deleteRunner` (a cheap DELETE). Reap expired reservations; fail over if a winner never connects.

This makes the *expensive* resource (VM boot) the coordinated thing, using a cheap API pair as the lease token — membership-free, GitHub-as-authority. Not perfectly atomic (list read is eventually consistent), so a small residual remains, but materially better than "everyone boots." **Gated on the validation spike below.**

### Layer 2 — labels / static partition (opt-in)
Distinct per-machine labels, or static `FLEET_SIZE`+`INSTANCE_ID` job-id hashing / runner scale sets. The **only true fix for job theft** (affinity must live in `runs-on` labels or runner groups) and the right call for large or VM-heavy fleets. The E2E unique-per-run-label fix already merged is exactly this pattern.

### Layer 3 — existing backstops
GitHub's 60s re-queue, the 120s idle watchdog, and ephemeral one-job-then-deregister bound the blast radius of anything that leaks through. Keep them as safety nets, not primary mechanisms.

## Consequences
- **Pros:** cheap immediate fairness + herd reduction (Layer 0); a real anti-duplication primitive once validated (Layer 1); a definitive theft fix (Layer 2); zero correctness risk (GitHub single-assignment).
- **Cons / caveats:** Layer 0 is a heuristic (residual herd among equal-idle machines and at scale); Layer 1 adds `listRunners` + register/deregister calls and depends on the spike; rate limits and `listRunners` eventual-consistency must be respected (fail *open*). Because effects are **at-least-once under failure**, CI steps must remain idempotent — state this in the docs.

## Validation spike (blocking Layer 1)
1. Does a JIT-registered runner appear in `listRunners` (as `offline`) before its process connects, and how fast does it propagate? 2. Can register-then-`deleteRunner` be done cheaply without ever booting and without side effects? 3. Confirm GitHub never assigns a queued job to an `offline` registered runner. 4. List-propagation latency A→B (bounds the residual election race). 5. Rate-limit headroom for the extra calls at target fleet sizes. 6. Whether any real deployment has runners satisfying multiple flavors' label subsets (breaks scalar deficit math → needs disjoint capability classes).

## Sources
- GitHub Docs — self-hosted runners reference (routing precedence, autoscaling): https://docs.github.com/en/actions/reference/runners/self-hosted-runners
- GitHub Docs — runner groups / runner scale sets / ARC: https://docs.github.com/en/actions/concepts/runners/runner-groups
- GitHub Docs — REST self-hosted-runners / `generate-jitconfig`: https://docs.github.com/en/rest/actions/self-hosted-runners
- GitHub Docs — Actions limits (24h queue timeout; 1,500 registrations/5min): https://docs.github.com/en/actions/reference/limits
- actions/runner — `MessageListener.cs`, `Runner.cs` (`/acquirejob`, 409 already-acquired), `JobDispatcher.cs` (lease/renew): https://github.com/actions/runner
- actions/actions-runner-controller — gha-runner-scale-set (AcquireJobs session model): https://github.com/actions/actions-runner-controller
- github-aws-runners/terraform-aws-github-runner — webhook→SQS→Lambda dedup/debounce architecture: https://github.com/github-aws-runners/terraform-aws-github-runner
