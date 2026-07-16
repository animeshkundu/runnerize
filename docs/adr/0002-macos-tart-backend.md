# 2. Tart backend for the native `macos` flavor

Status: Accepted (2026-07-16)

## Context

runnerize mints ephemeral, one-job JIT runners. Native macOS jobs (`runs-on: [self-hosted, macos, arm64]`) need an isolated, disposable macOS environment rather than running workflow code directly on the host.

Tart provides Apple Virtualization.framework-backed macOS virtual machines on Apple Silicon. It can clone a prepared base image, run the clone without a graphical console, expose its IP address, and stop and delete it after use. The backend requires an Apple Silicon Mac, the `tart` CLI, and either a local base VM or a remote image reference such as `ghcr.io/cirruslabs/macos-sequoia-base:latest`.

## Decision

Implement the `macos` flavor on tart, with one disposable VM per JIT runner and `maxConcurrent: 2`. Apple's Virtualization.framework and macOS licensing permit at most two concurrent macOS guests per host.

Each launch has this lifecycle:

1. Clone the configured base image to a unique `runnerize-*` VM.
2. Start it detached with `tart run --no-graphics --no-audio`.
3. Poll `tart ip`, then SSH, until the guest is reachable.
4. Send a bootstrap script and the JIT config over SSH standard input. The script copies a pre-baked actions runner when configured, or downloads the selected `actions-runner-osx-arm64` release into a temporary directory.
5. Run the JIT runner and observe SSH output for the job-start signal. The runner takes one job and auto-deregisters.
6. In `finally`, stop and delete the VM, including on boot failure, SSH failure, or idle timeout.

Configuration is supplied through environment variables:

- `RUNNERIZE_MACOS_IMAGE` is required and names the tart base image.
- `RUNNERIZE_MACOS_SSH_USER` defaults to `admin`.
- `RUNNERIZE_MACOS_SSH_KEY` optionally selects a private key; otherwise SSH uses its agent and default key search.
- `RUNNERIZE_MACOS_RUNNER_DIR` optionally names a pre-baked runner directory inside the VM and avoids a per-job download.
- `RUNNERIZE_MACOS_RUNNER_VERSION` optionally pins the runner version; otherwise runnerize resolves the latest release before connecting.

The VM is always disposable. No runner state, workspace, or registration material persists between jobs.

## Consequences

- Native Apple Silicon macOS CI can run without exposing the dispatcher host filesystem to workflow code.
- At most two macOS guests run concurrently per host, even when the global `--max` is higher.
- Startup includes clone and boot latency. A base image with a pre-baked actions runner substantially reduces per-job setup time.
- Hosts without Apple Silicon or a working tart installation never advertise the flavor.
- The implementation was validated with hermetic process-lifecycle tests but was not tested on macOS hardware when accepted. A real Apple Silicon Mac is required to confirm tart image, networking, SSH, runner bootstrap, job execution, and cleanup behavior.
