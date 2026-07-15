# 1. Windows Sandbox backend for the native `windows` flavor

Status: Accepted (2026-07-15)

## Context

runnerize mints ephemeral, one-job JIT runners. The `linux` flavor runs each job in a throwaway rootless podman/docker container. The `windows` and `macos` flavors are stubs whose `launch()` throws, so every host serves Linux-container jobs only.

Native Windows jobs (`runs-on: [self-hosted, windows, x64]`) need a disposable, one-job Windows execution environment. Windows Sandbox is the natural fit: a lightweight, disposable Windows VM that resets on every start. The blocker had been lifecycle control — the classic `WindowsSandbox.exe` launches a GUI with no programmatic wait/stop.

Research (validated end to end on a Windows 11 build 26200 host) found that Windows 11 24H2+ ships a `wsb.exe` CLI with a real programmatic lifecycle (`start` / `exec` / `stop`), and confirmed a real `actions-runner-win-x64` JIT runner connects to GitHub and reaches "Listening for Jobs" inside a disposable sandbox, then tears down cleanly with `wsb stop`.

## Decision

Implement the `windows` flavor (`src/sandbox/windows.js`) on the `wsb.exe` CLI, mirroring the `linux` flavor's `launch()` contract: `launch(encodedJitConfig, { idleTimeoutMs, onStarted }) -> { startedJob }`.

- `available()` gates on `process.platform === 'win32'` AND the `wsb.exe` CLI being resolvable and responsive (Windows 11 24H2 / build 26100+). It never throws.
- `launch()` stages the Windows runner binary, writes a per-job control folder (JIT config + a runner wrapper script + a mapped log), generates a one-job `.wsb` mapping those in and running the wrapper, `wsb start`s the sandbox, tails the mapped log for the job-start line to fire `onStarted()`, enforces `idleTimeoutMs` (tear down + `{ startedJob: false }` if no job starts), and `wsb stop`s in `finally`.

The single-instance limit is a hard constraint: a second `wsb start` fails with `CO_E_APPSINGLEUSE`. The dispatcher gains a per-flavor in-flight concurrency cap; `windows` declares `maxConcurrent: 1`. The global `--max` semaphore still applies on top.

## Consequences

- Native Windows CI on a 24H2+ host, one job per disposable sandbox, no persistence.
- At most one Windows job runs at a time per host (single-instance limit). Linux jobs are unaffected and still run up to `--max` in parallel.
- No nested virtualization inside the sandbox (no Docker-in-Docker for Windows jobs).
- Requires Windows 11 24H2 (build 26100+); older hosts report the flavor unavailable and keep serving Linux-container jobs.
