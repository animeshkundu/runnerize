<!--
Keep the description tight. runnerize is a small, invariant-heavy CLI; a reviewer
needs to see WHAT changed, WHY, and proof the invariants still hold.
-->

## What & why

<!-- One or two sentences. What does this change do, and what problem does it solve? -->

## How it was verified

<!-- Required. Prose claims don't count — show the commands you ran. -->

- [ ] `npm test` passes (unit)
- [ ] `npm run test:e2e` passes, or N/A because: <!-- e2e needs podman/WSL + a token -->
- [ ] Ran the affected path end to end (e.g. `node bin/runnerize.js run --dry-run` against a real account) — describe what you observed:

## Invariant checklist

Confirm this change does not regress any of these (see `AGENTS.md` → Invariants):

- [ ] **Count-based, never job-pinned** — no runner is bound to a specific `job.id`.
- [ ] **Fail-closed privacy** — `isStillPrivate` is still re-checked immediately before every mint, and any error path returns "not private".
- [ ] **Tokens off-argv, never logged** — no credential or JIT config passed as a CLI argument or written to a log line.
- [ ] **Semaphore released exactly once** — every `acquire()` has exactly one `release()` on a single `finally`.
- [ ] **Stateless / ephemeral** — each job still runs in a throwaway sandbox, takes one job, and the runner auto-deregisters.
- [ ] **Idle watchdog intact** — an unclaimed runner is still killed after `idleTimeoutMs`.
- [ ] No new runtime dependencies (zero-dep, Node built-ins only).
- [ ] No AI/assistant attribution anywhere in the diff, commits, or this PR.

## Docs

- [ ] Updated `AGENTS.md` / `docs/` / `CONTRACTS.md` if behavior, invariants, or contracts changed — or N/A.
