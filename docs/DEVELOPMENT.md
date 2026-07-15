# Development

How to run, exercise, and debug runnerize locally across platforms. For the *why*
behind the design see [`ARCHITECTURE.md`](ARCHITECTURE.md); for the invariants you
must not break see [`../AGENTS.md`](../AGENTS.md).

## Prerequisites

| | Requirement |
|---|---|
| Runtime | **Node.js ≥ 20** (built-in `fetch`; no npm deps to install) |
| Container runtime (linux flavor) | `podman` (preferred) or `docker` |
| Token | `$GH_TOKEN` / `$GITHUB_TOKEN`, or a logged-in `gh` CLI |

runnerize has **no dependencies to install** — `npm install` is a no-op. You run it
straight from a checkout with `node bin/runnerize.js ...`.

Token resolution order (`src/github.js` → `getToken`): `$GH_TOKEN` → `$GITHUB_TOKEN`
→ `gh auth token`. The token needs access to your private repos and `actions:write`
to mint/deregister runners. It is held only in the dispatcher's memory and sent only
in the `Authorization` header — never on a command line.

## Per-platform setup

### Native Linux

The simplest case. Install `podman` (or `docker`), make sure your user can run
rootless containers, and go:

```bash
export GH_TOKEN=...            # or: gh auth login
node bin/runnerize.js status
node bin/runnerize.js run --dry-run
node bin/runnerize.js run
```

### Windows 11 + WSL2 (the live-validated path)

The dispatcher runs as a normal Windows Node process; the containers run inside a WSL2
distro. runnerize shells out to `wsl.exe -d <distro> -e <podman|docker> ...` and
stages the runner + inner script into the distro for you.

1. Install WSL2 and a distro (e.g. Ubuntu). **Docker Desktop is not required.**
2. Inside the distro, install `podman` (or `docker`) and confirm rootless containers
   work: `wsl -d Ubuntu -e podman --version`.
3. On the Windows side, provide a token (`$env:GH_TOKEN` in PowerShell, or `gh auth
   login`) and run `node bin/runnerize.js status`.

If you have more than one distro, pin the one to use with `RUNNERIZE_WSL_DISTRO`
(otherwise the launcher probes each distro from `wsl.exe -l -q` for a working
runtime).

> **git-bash gotcha — `MSYS_NO_PATHCONV=1`.** If you drive runnerize from Git Bash
> (MSYS) rather than PowerShell/cmd, MSYS silently rewrites anything that looks like a
> Unix path (`/tmp/...`, `/home/...`, `/mnt/c/...`) into a Windows path before the
> child process sees it. That mangles the WSL-side paths runnerize passes to
> `wsl.exe`. Prefix such commands with `MSYS_NO_PATHCONV=1`:
>
> ```bash
> MSYS_NO_PATHCONV=1 node bin/runnerize.js run
> ```
>
> PowerShell and cmd don't have this problem.

### macOS

Linux-container jobs need a Linux VM: `colima start` or `podman machine init && podman
machine start`. Once `podman`/`docker` responds, the flow is the same as native Linux.
(The native `macos` flavor that would boot a `tart` VM per job is still a stub.)

## Everyday commands

```bash
node bin/runnerize.js --help
node bin/runnerize.js status            # auth identity, owned-private repos, live runners
node bin/runnerize.js run --dry-run     # count demand per repo/flavor, mint nothing
node bin/runnerize.js run               # start the dispatcher (foreground)
node bin/runnerize.js run --max 2 --interval 10000 --idle-timeout 60000
node bin/runnerize.js remove            # one pass: delete offline runnerize-* runners
node bin/runnerize.js service install   # install as a boot service (see below)
```

`--dry-run` is your friend: it exercises the entire GitHub read path (auth, repo
enumeration, demand counting, flavor detection) against your real account **without
minting anything**. Start here when validating a change to `src/github.js` or the
demand math.

### Flags and env knobs

| Flag | Default | Meaning |
|---|---|---|
| `--max <n>` | 4 | max concurrent runners (the semaphore capacity) |
| `--interval <ms>` | 15000 | base poll interval; scales up with repo count, capped at 60s |
| `--idle-timeout <ms>` | 120000 | kill an unclaimed runner after this |
| `--dry-run` | off | count demand, mint nothing |

| Env var | Default | Meaning |
|---|---|---|
| `RUNNERIZE_LINUX_IMAGE` | `catthehacker/ubuntu:full-latest` | the fat image jobs run in |
| `RUNNERIZE_RUNNER_DIR` | (download) | use a preinstalled `actions/runner` dir instead of downloading + SHA-256-verifying one; accepts an absolute Windows or WSL path |
| `RUNNERIZE_WSL_DISTRO` | (probe all) | pin which WSL distro runs the containers |
| `GH_TOKEN` / `GITHUB_TOKEN` | (`gh auth token`) | the credential |

`RUNNERIZE_RUNNER_DIR` speeds up the dev loop by skipping the release download/verify
on every launch. On Windows it may be a `C:\...` path (converted with `wslpath`) or a
`/...` path already inside the distro; either way it must be absolute.

## Exercising it end to end: the throwaway spike-repo pattern

Unit tests cover logic, but the real dispatch path only proves out against GitHub. The
cheap, safe way to test it:

1. Create a **throwaway private repo** under your account (e.g. `runnerize-spike`).
2. Add a workflow that targets the self-hosted labels explicitly — a bare
   `[self-hosted]` is ambiguous across flavors, so always name the OS/arch:

   ```yaml
   # .github/workflows/ci.yml
   name: spike
   on: [push, workflow_dispatch]
   jobs:
     build:
       runs-on: [self-hosted, linux, x64]
       steps:
         - run: echo "ran on $(hostname) at $(date)"
         - run: uname -a
   ```

3. Start the dispatcher (`node bin/runnerize.js run`), then trigger the workflow
   (push, or `gh workflow run ci.yml`).
4. Watch the dispatcher's JSON logs: `demand_counted` → `runner_launching` →
   `runner_exited { startedJob: true }`. The job should complete on your machine and
   the runner should deregister itself.
5. Confirm nothing was left behind: `node bin/runnerize.js status` should show no
   lingering `runnerize-*` runner; `node bin/runnerize.js remove` cleans up any
   offline stragglers.

To exercise the **idle watchdog** specifically, mint against demand that then
disappears (e.g. cancel the run right after it queues, or set a very short
`--idle-timeout`) and confirm you see the runner get force-stopped and the slot
released rather than the dispatcher wedging.

**Tear the spike repo down** when done — it's throwaway by design.

## Reading the logs

The dispatcher emits one JSON object per line (`log()` in `src/dispatcher.js`). Useful
events, roughly in order:

- `dispatcher_started`, `reconcile_complete`
- `demand_counted { flavor, demand, unassigned, toMint }` — the count-based decision
- `mint_skipped_not_private` — the fail-closed privacy re-check denied a mint
- `runner_launching` → `runner_exited { startedJob }` — a normal one-job lifecycle
- `runner_launch_error` / `runner_deregister_error` — failure paths (with backoff)
- `shutdown_requested` → `dispatcher_draining { inflight }` → `dispatcher_stopped`

No log line ever contains a token or the JIT config. If you're adding logging, keep it
that way — event name + non-secret fields only.

## Running as a boot service

`node bin/runnerize.js service install` writes and starts a platform service
(`src/service.js`):

- **Linux/WSL:** a systemd **user** unit at `~/.config/systemd/user/runnerize.service`
  (`KillMode=mixed` so a restart doesn't kill in-flight jobs). To keep it running
  before login: `loginctl enable-linger "$USER"`. Logs: `journalctl --user -u
  runnerize -f`.
- **macOS:** a launchd LaunchAgent at
  `~/Library/LaunchAgents/io.runnerize.dispatcher.plist`. Logs:
  `~/Library/Logs/runnerize.log`.
- **Windows:** a service via `nssm.exe` (must be on `PATH`). Status:
  `sc.exe query runnerize`.

`service uninstall` removes it again.

## Tests

```bash
npm test          # unit  (node --test test/unit) — the required gate
npm run test:e2e  # end-to-end (node --test test/e2e) — needs a runtime + token
npm run test:all  # both
```

Add or update tests with every change; a fix ships with a regression test. If you
can't run the e2e suite in your environment, say so explicitly rather than imply it
passed. See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the PR flow.
