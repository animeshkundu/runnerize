# ADR 0004: Opt-in host shutdown guard

## Context

Runnerize's Tier-1 host-stability guard addresses the observed causes of guest downtime by deferring Windows Update restarts and disabling hibernation. A Hyper-V host can also request a graceful guest shutdown through the `vmicshutdown` integration service. That failure mode has not been observed, and permanently disabling the service would make normal host administration unsafe.

Tier-2 therefore needs to be explicit defense in depth. It must coordinate concurrent, non-elevated runnerize sessions without repeated UAC prompts, survive process crashes and power loss, and always restore the service when protection is no longer actively leased.

## Decision

`runnerize guard install --shutdown-guard` installs Tier-1 and, in the same elevation, creates an authoritative `%ProgramData%\runnerize\guard\state.json`, a user-writable `leases` directory, and a hidden SYSTEM scheduled task.

`runnerize-guard-watch` starts at boot and immediately after installation. It runs `runnerize guard-watch`, waits through the recovery grace interval, reaps expired leases, snapshots the original `vmicshutdown` startup and running state on the first live lease, disables and stops the service while leases remain, and restores the snapshot after the final lease disappears. Its Task Scheduler policy restarts it after failure. A single reconciler owns state transitions, avoiding competing startup recovery and watchdog snapshots.

Each session owns one unpredictable lease filename and refreshes only that file. The lease directory ACL grants ordinary authenticated users create-file, write-data, and owner/delete-child capabilities without granting access to authoritative state. Lease documents contain a format version, session identifier, and heartbeat timestamp. The SYSTEM watchdog treats malformed, symlinked, or stale files as dead and removes them. Authoritative state is written only by SYSTEM.

The foreground dispatcher engages Tier-2 only when `RUNNERIZE_GUARD_HOST=1`. It creates a lease on startup, refreshes it periodically, and releases it through the existing bounded `onDrain` hook. The command remains off by default. `runnerize guard on` and `runnerize guard off` expose the same lease lifecycle for explicit use.

`runnerize guard uninstall --shutdown-guard` stops and unregisters the watchdog before restoring `vmicshutdown`, then removes Tier-2 state. A full guard uninstall also removes Tier-2 when installed. Every operation is gated to Windows guests whose CIM identity identifies Microsoft Hyper-V; other systems report a no-op.

The state transition invariant is:

- no live leases and no saved snapshot: service is unmanaged;
- first live lease: snapshot exactly once, then disable and stop;
- one or more live leases: continuously enforce disabled and stopped;
- last lease removed or expired: restore the exact saved startup/running state, then clear the snapshot.

## Status

Accepted

## Consequences

Tier-2 adds a long-running SYSTEM task and cross-privilege filesystem protocol, so its implementation and tests must treat lease input as untrusted. A crashed session remains protected only until its heartbeat expires. Recovery favors restoring host shutdown capability over indefinite protection. Task installation requires one UAC approval, but normal sessions never elevate. Tier-1 remains unchanged when Tier-2 is not requested.
