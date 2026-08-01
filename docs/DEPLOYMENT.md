# Deploying runnerize on a host

This is the operational handoff for running the runnerize dispatcher on a machine
so your private-repo CI runs on your own hardware. It covers the current live host,
and how to bring up a fresh **Windows** or **macOS** host and pick up where this
left off. For a fast Windows setup, see [QUICKSTART-windows.md](QUICKSTART-windows.md).

## How runnerize works (the one thing to internalize)

A single long-running **dispatcher** polls every repo you own that is **private +
non-fork**, and for each *queued* job whose `runs-on:` labels are a **subset** of a
flavor it offers, it mints an **ephemeral just-in-time runner**, runs that one job
inside a **throwaway rootless container**, then destroys everything. Nothing is
pre-registered; nothing persists between jobs.

The `linux` flavor mints runners labelled `[self-hosted, linux, x64]` and runs
jobs in rootless **podman/docker** containers. On Windows 11 24H2+, the native
`windows` flavor uses Windows Sandbox for disposable `[self-hosted, windows,
x64]` runners. On Apple Silicon, the native `macos` flavor uses disposable tart
VMs for `[self-hosted, macos, arm64]` runners.

## Prerequisites (any host)

- **Node >= 20** on PATH.
- **A container runtime**: rootless **podman** (preferred) or docker, reachable the
  way the host's flavor expects (native on Linux; via WSL on Windows; via a Linux VM
  on macOS — see per-host sections).
- **A GitHub credential** for the account that owns the repos. Either:
  - `gh` authenticated as that account (the dispatcher calls `gh auth token`), or
  - `GH_TOKEN` / `GITHUB_TOKEN` in the environment.
  - Scope needed, across **all** your owned private repos: **Administration** (mint
    /list/delete runners) + **Actions** (read runs/jobs) + **Metadata** (list repos).
    A classic token / gh OAuth token with the `repo` scope covers all of it; a
    fine-grained PAT must target *All repositories* with those three permissions.

## Automatic prerequisite preflight

`runnerize run`, `runnerize run --dry-run`, and `runnerize service install` verify the container runtime and GitHub credential before doing work. On Windows, full runs and service installs select a working WSL distro and, when Podman is absent in Debian/Ubuntu, try `sudo -n apt-get update && sudo -n apt-get install -y podman`. The non-interactive sudo flag and bounded probes prevent password or consent hangs. Dry runs only probe and print guidance; they never install anything. Everything already present is a fast no-op.

Prerequisites that require a person remain guided rather than silently attempted. With no working WSL distro, run `wsl --install -d Ubuntu` in an elevated PowerShell. With no GitHub credential, run `gh auth login` or set `GH_TOKEN`/`GITHUB_TOKEN`; the credential needs Administration, Actions, and Metadata access across all owned private repositories. If Podman installation needs sudo authentication, runnerize prints the exact install command to run inside the selected distro.

On native Linux and macOS, the same commands verify a working rootless Podman/Docker runtime and GitHub credential, then print platform-appropriate installation guidance when one is absent.

## Quick start (any host)

```sh
npm i -g runnerize          # or:  npx github:animeshkundu/runnerize
runnerize run --dry-run     # auth + flavor detection + per-repo demand, mints nothing
runnerize run               # start the dispatcher in the foreground
runnerize status            # list runners currently registered across your repos
runnerize remove            # clean up any offline ephemeral runnerize-* runners
```

Flags: `--max <n>` (concurrent runners, default 5), `--interval <ms>` (base poll, default
15000), `--idle-timeout <ms>` (kill an unclaimed runner, default 120000), `--only
<linux,windows,macos>` (serve selected flavors), and `--no-keep-awake` (allow the
host to sleep while the dispatcher runs). `status` always reports every available
flavor.

---

## Windows host

A Windows host can serve Linux jobs through WSL and native Windows jobs through Windows Sandbox.

### Runtime
- Install **WSL2** with a distro, and **rootless podman inside WSL**
  (`wsl -e podman --version` must work). runnerize on Windows shells out to
  `wsl.exe -e podman ...` and stages the runner into a WSL-native cache.
- Node >= 20 on the **Windows** side (the dispatcher process is Windows-Node; it
  drives WSL podman). `gh` authenticated on Windows, or `GH_TOKEN` set.
- When invoking through git-bash, export `MSYS_NO_PATHCONV=1` and
  `MSYS2_ARG_CONV_EXCL='*'` so bash does not mangle WSL paths. (Not needed when
  Node is launched directly, e.g. from Task Scheduler or a Startup launcher.)

### Native Windows jobs with Windows Sandbox

The native `windows` flavor requires Windows 11 24H2 (build 26100+) with the
Windows Sandbox optional feature enabled and `wsb.exe` available on PATH. A repo
opts in with:

```yaml
runs-on: [self-hosted, windows, x64]
```

Windows Sandbox permits only one active instance, so runnerize runs at most one
Windows job at a time on each host even when `--max` is higher. Every job gets a
fresh, visible sandbox window. Windows jobs require an interactive, unlocked local
desktop; locked or disconnected RDP sessions are unsupported. runnerize waits for
`wsb exec` readiness, shares the runner read-only
and a writable control folder with `wsb share`, and runs the JIT wrapper with
`wsb exec --run-as System` (`ExistingLogin` is unavailable before an interactive
login). The sandbox is stopped after the runner exits. Nested virtualization is not
available inside Windows Sandbox, so Windows jobs cannot use Docker-in-Docker.

### Boot persistence on Windows

`runnerize service install` detects and independently installs every available
backend. Linux runs through the WSL systemd user service pinned to `--only linux`;
Windows Sandbox runs through a native hidden PowerShell launcher pinned to `--only
windows`. The native launcher uses a process mutex, keeps the system awake without
forcing the display on, and writes `%LOCALAPPDATA%\runnerize\runnerize-windows.log`.
If only WSL is available, a small Windows-side holder keeps the host awake while its
systemd service is active.

Each backend uses a three-tier Windows logon trigger:

1. It first registers a hidden, per-user Task Scheduler task without elevation.
2. If registration is access-denied, it requests one UAC approval and registers the
   same task elevated. The prompt and elevated command share a 55-second timeout.
3. Only when the task is confirmed absent, it writes a distinct hidden Startup-folder
   `.vbs` launcher for the current user. A task and its fallback are never intentionally
   left active together.

These triggers resume at the next interactive logon, not before login. Unattended
restart requires Windows AutoLogon, which stores reusable credentials and is a
security trade-off. Windows Sandbox remains unsupported on locked or disconnected
RDP desktops.

Pass `--no-elevate`, or set `RUNNERIZE_NO_ELEVATE` to any non-empty value, to skip
Tier 2 for scripted installs and managed machines. Either setting is sufficient:

```powershell
runnerize service install --no-elevate
$env:RUNNERIZE_NO_ELEVATE = '1'; runnerize service install
```

Uninstall first removes the task without elevation. If an elevated task is
access-denied, it uses the same bounded UAC flow unless elevation is disabled. When
removal cannot be elevated, it prints manual Task Scheduler instructions and still
removes the Startup entry and WSL materialized files where present.

---

## macOS host

An Apple Silicon host can serve both Linux-container jobs and native macOS jobs.

### Runtime
- For the **linux** flavor, provide a Linux container engine: **Colima** (`brew
  install colima && colima start`) or `podman machine` (`podman machine init &&
  podman machine start`).
- For the native **macos** flavor, install **tart** (`brew install cirruslabs/cli/tart`)
  and provide a macOS base VM image. The flavor is unavailable on Intel Macs.
- Node >= 20 (`brew install node`), and `gh` authenticated or `GH_TOKEN` set.

### Native macOS jobs with tart

A repo opts in with:

```yaml
runs-on: [self-hosted, macos, arm64]
```

`npx runnerize service install` audits the Mac first. On Apple Silicon it installs
tart automatically through Homebrew when possible, without sudo. It does not pull
a base image automatically because macOS images are tens of gigabytes; instead it
prints numbered copy-paste commands for Homebrew/tart gaps, the one-time image
pull, SSH credentials, and GitHub login. The launchd agent is still installed when
another backend is usable, so completing a guided step later enables the macOS
flavor without reinstalling.

Set `RUNNERIZE_MACOS_IMAGE` to a local tart VM name or remote image reference,
for example `ghcr.io/cirruslabs/macos-sequoia-base:latest`, then run `tart pull
"$RUNNERIZE_MACOS_IMAGE"`. runnerize clones the image for every job, boots the
clone without a graphical console, connects over SSH, runs one JIT-configured
runner, then stops and deletes the clone. No runner workspace or registration
state persists. The per-host cap is two concurrent macOS VMs, even when `--max`
is higher.

Configuration:

- `RUNNERIZE_MACOS_IMAGE` (required): tart base image name or reference.
- `RUNNERIZE_MACOS_SSH_USER` (default `admin`): SSH user in the base image.
- `RUNNERIZE_MACOS_SSH_KEY` (optional): path to a private SSH key. Without it,
  SSH uses the agent and default identity files.
- `RUNNERIZE_MACOS_RUNNER_DIR` (optional): actions-runner directory inside the
  VM. Baking the runner into the base image is faster than downloading it for
  every job.
- `RUNNERIZE_MACOS_RUNNER_VERSION` (optional): actions-runner version to use;
  otherwise runnerize resolves the latest version before launch.

The base image must boot unattended, provide network access, accept SSH for the
configured user, and include `bash`, `curl`, and `tar`. If
`RUNNERIZE_MACOS_RUNNER_DIR` is set, that directory must contain `run.sh`.

### Boot persistence on macOS
- `runnerize service install` writes a **launchd** agent
  (`~/Library/LaunchAgents/io.runnerize.dispatcher.plist`, `RunAtLoad` +
  `KeepAlive`) and bootstraps it. Logs go to `~/Library/Logs/runnerize.log`.
  No admin needed for a user LaunchAgent.

---

## Linux host

The native case. Node >= 20, rootless podman, `gh`/`GH_TOKEN`. Persistence:
`runnerize service install` writes a **systemd user unit**
(`~/.config/systemd/user/runnerize.service`, `Restart=always`) and enables it. For
it to run before/without an interactive login: `loginctl enable-linger "$USER"`.
Logs: `journalctl --user -u runnerize -f`. This is also the cleanest path *inside
WSL* (systemd runs there) once Node is installed in the WSL distro.

### Isolated container image builds

Enabled by default. Set `RUNNERIZE_CONTAINER_BUILDS=0` in the dispatcher's environment to
switch it off; for a systemd service, add that to the file referenced by
`RUNNERIZE_SYSTEMD_ENV_FILE` before installing or restarting the service. A capable host
advertises the additional label only
after the configured Linux image completes real `docker build`, `podman build`, and
`buildah build` commands with a `RUN` instruction as the non-root runner user:

```yaml
runs-on: [self-hosted, linux, x64, container-build]
```

Jobs can use `docker build`, `podman build`, or `buildah build`. These build-only shims invoke
Buildah with chroot isolation and VFS storage under `/tmp`; other Docker, Podman, and Buildah
subcommands return exit 125. The root helper applies a fail-closed option allowlist even when
invoked directly. Only local-directory contexts are accepted; they are snapshotted without root
privileges, special files are rejected, and symlinks must resolve inside the root-owned result.
Flags that override namespaces, runtimes, capabilities, devices, security settings, or bind
mounts are rejected, and every `RUN` instruction receives an empty Linux capability set. The
Actions runner stays non-root and receives passwordless sudo only for one immutable root-owned
Buildah helper. The outer container starts as UID 0 to install that profile, but the capability
probe rejects a runtime whose container root maps to host root. No `--privileged`, `/dev/fuse`, or host Docker/Podman socket is used.

The default image already contains the required tools, so opt-in does not add image bytes.
Custom images must include `bash`, `awk`, `buildah`, a statically linked `busybox`, `find`,
`grep`, `realpath`, `runuser`, `sed`, `sudo`/`visudo`, `tar`, and the `runner` user. The
functional probe adds a real scratch image build at first detection and when the runtime, WSL
distro, or configured image changes. VFS
copies layers instead of sharing overlay layers, so builds use more temporary disk and can be
slower. All nested images and layers live in the ephemeral job container and are deleted with
it; no cross-job cache accumulates and no host cleanup is required.

Socket mounting was rejected because it grants jobs control of the host runtime and makes
sandbox escape straightforward. Privileged Docker-in-Docker has a similarly broad blast
radius and adds a daemon. Rootless Podman-in-Podman was rejected because nested subordinate
user namespaces are not functional on the supported rootless Podman/WSL setup. Buildah is
the smallest mechanism that completed a real image build while retaining the host-runtime
boundary.

### KVM-accelerated Android tests

runnerize enables KVM automatically when the linux execution environment has a
usable `/dev/kvm`. Preflight reports whether CPU virtualization extensions are
absent, `/dev/kvm` is missing, device access is denied, or KVM is usable. The
account running the dispatcher must be able to open the device for both reading
and writing, commonly by membership in the `kvm` group. Follow the printed
`usermod` command when access is denied, then log out and back in; under WSL, run
`wsl.exe --shutdown` from Windows and restart WSL. No privileged command runs
automatically, and unavailable KVM remains an informational optional capability.

A capable host advertises the additional `kvm` label and accepts targeted jobs:

```yaml
runs-on: [self-hosted, linux, x64, kvm]
```

The container receives only `--device /dev/kvm`; runnerize does not use
`--privileged` or expose a host container socket. The rootless runtime must
preserve the dispatcher's effective access to the device. If group-only access is
not preserved by your runtime configuration, grant the dispatcher user direct
read/write access through an appropriate host udev rule rather than broadening the
container's privileges.

The default `docker.io/catthehacker/ubuntu:full-latest` image already includes the
Android SDK, including platform tools, for headless builds, unit tests, and lint.
The opt-in `images/android/Containerfile` layers the emulator and an API 35 Google
APIs x86_64 system image on that unchanged default:

```sh
podman build -t localhost/runnerize-android:latest -f images/android/Containerfile .
export RUNNERIZE_LINUX_IMAGE=localhost/runnerize-android:latest
```

Use Docker instead of Podman if preferred, and tag/push the result to a registry
when the dispatcher cannot use the local tag. The Android additions download about
2.1 GB compressed and occupy roughly 6 GB installed, on top of the approximately
18 GB compressed default image; exact sizes change as the upstream base and Android
packages are revised. Emulator jobs must request `[self-hosted, linux, x64, kvm]`
after applying any KVM remedy reported
by preflight.

---

## Migrating an existing self-hosted repo onto runnerize

runnerize only claims a job when the job's `runs-on:` labels are a **subset** of
`[self-hosted, linux, x64]`. A persistent per-repo runner with a **custom** label
(e.g. `buffet-batch`, `wsl`, `local`) keeps its jobs off runnerize. So per repo:

1. In the repo's workflow(s), set **`runs-on: [self-hosted, linux, x64]`** (drop any
   custom or OS-specific label the old runner advertised).
2. Deregister the old persistent runner (Settings -> Actions -> Runners, or
   `runnerize remove` once it's offline) so it stops competing for jobs.

A **Windows** persistent runner (e.g. `runs-on: [self-hosted, Windows, X64, local]`)
can move to runnerize by dropping its custom label and using
`runs-on: [self-hosted, windows, x64]` on a Windows Sandbox-capable host.

---

## Enabling native flavors

- **Windows Sandbox** (`src/sandbox/windows.js`) is implemented on Windows 11 24H2+
  as described above. `available()` enables it automatically when `wsb.exe` responds.
- **macOS / tart** (`src/sandbox/macos.js`) is implemented on Apple Silicon. It
  enables automatically when `tart` responds and `RUNNERIZE_MACOS_IMAGE` supplies
  the base image used for each throwaway VM.

## Current live host (as of this handoff)

- Windows 11 (corporate-managed, `anikundu_microsoft` enterprise), account
  `animeshkundu`. Node v24 on Windows; **podman 4.9.3 in WSL**; Docker also present.
- Dispatcher runs via the **Startup-folder** launcher above (admin-gated Task
  Scheduler was "Access is denied"). Log: `%LOCALAPPDATA%\runnerize\runnerize.log`.
- Flavor detected: **linux**. 19 owned private repos polled; demand 0 at setup.
- E2E gate lives in a separate throwaway repo `runnerize-e2e` (see the repo's CI).
- Not yet migrated (still on their own persistent runners with custom labels):
  `buffet-pipeline` (`buffet-batch`), `essays-engine` (`wsl`, and a Windows `local`).
