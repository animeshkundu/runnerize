---
name: Feature request
about: Suggest an idea or a new backend for runnerize
title: ""
labels: enhancement
assignees: ""
---

## Problem

<!-- What are you trying to do that runnerize can't do today? Focus on the need, not the solution. -->

## Proposed change

<!-- What you'd like to see. If it's a new sandbox flavor, say which host and isolation mechanism. -->

## Does it hold the invariants?

runnerize keeps a small set of non-negotiable properties (see `AGENTS.md` → Invariants).
If your idea touches dispatch or sandboxing, note how it stays:

- Count-based, never pinned to a `job.id`.
- Private-only, fail-closed before every mint.
- Stateless: one job per runner, no persisted credentials or workspace.

## Alternatives considered

<!-- Other approaches, and why they fall short. -->

## Additional context

<!-- Links, prior art (e.g. how another runner project solves this), constraints. -->
