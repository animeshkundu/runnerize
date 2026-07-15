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
x64]` runners. The `macos` (tart VM) flavor remains a stub.

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

Flags: `--max <n>` (concurrent runners, default 4), `--interval <ms>` (poll, default
15000), `--idle-timeout <ms>` (kill an unclaimed runner, default 120000).

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
fresh sandbox. runnerize waits for `wsb exec` readiness, shares the runner read-only
and a writable control folder with `wsb share`, and runs the JIT wrapper with
`wsb exec --run-as System` (`ExistingLogin` is unavailable before an interactive
login). The sandbox is stopped after the runner exits. Nested virtualization is not
available inside Windows Sandbox, so Windows jobs cannot use Docker-in-Docker.

### Boot persistence on Windows

`runnerize service install` uses a three-tier Windows logon trigger:

1. It first registers a hidden, per-user Task Scheduler task without elevation. The
   task starts the WSL systemd user service at logon and restarts on failure.
2. If registration is access-denied, it requests one UAC approval and registers the
   same task elevated. The prompt and elevated command share a 55-second timeout;
   success or failure is reported through the elevated process exit code.
3. If elevation is declined, unavailable, times out, or cannot be verified, it writes
   a hidden `...\Start Menu\Programs\Startup\runnerize.vbs` launcher for the current
   user. This fallback starts only at login and cannot automatically restart after a
   crash. Approval at the timeout boundary can leave both triggers if the detached
   elevated child finishes late; both only issue the idempotent `systemctl --user
   start runnerize`, so the overlap is harmless.

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

Runs the **linux** flavor (the `macos`/tart backend is a stub).

### Runtime
- Provide a Linux container engine: **Colima** (`brew install colima && colima start`)
  or `podman machine` (`podman machine init && podman machine start`). Either gives
  a Linux VM whose podman/docker runnerize uses for Linux-container jobs.
- Node >= 20 (`brew install node`), and `gh` authenticated or `GH_TOKEN` set.

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
- **macOS / tart** (`src/sandbox/macos.js`) remains future work: clone and boot a
  throwaway `tart` VM for exactly one JIT-configured job (Apple hardware only).

## Current live host (as of this handoff)

- Windows 11 (corporate-managed, `anikundu_microsoft` enterprise), account
  `animeshkundu`. Node v24 on Windows; **podman 4.9.3 in WSL**; Docker also present.
- Dispatcher runs via the **Startup-folder** launcher above (admin-gated Task
  Scheduler was "Access is denied"). Log: `%LOCALAPPDATA%\runnerize\runnerize.log`.
- Flavor detected: **linux**. 19 owned private repos polled; demand 0 at setup.
- E2E gate lives in a separate throwaway repo `runnerize-e2e` (see the repo's CI).
- Not yet migrated (still on their own persistent runners with custom labels):
  `buffet-pipeline` (`buffet-batch`), `essays-engine` (`wsl`, and a Windows `local`).
