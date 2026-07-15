# runnerize

On-demand, **stateless** self-hosted GitHub Actions runners for your **private** repos — so you can run private-repo CI on your own machine instead of paying for GitHub-hosted minutes, without leaving standing runners registered.

A single **dispatcher** watches your owned-private repos for queued jobs and, per job, mints a **just-in-time (JIT) runner** and runs it inside a **throwaway rootless container**. The runner takes exactly one job, then auto-deregisters and the container is destroyed. Nothing persists; the job never sees your host credentials or caches.

> Status: **v0.1**, live-validated on Windows 11 + WSL2 (rootless Podman). The macOS (`tart`) and native-Windows (Windows Sandbox) backends are detected-and-stubbed opt-ins, not yet exercised end to end.

## Why

- A **personal** GitHub account has no account-level runner scope, so each private repo needs its own runner. `runnerize` gives you all of them from one always-on dispatcher.
- **Stateless by design:** each job runs in a fresh container from a fat image, so there's no cross-job state, no persistent-workspace collisions, and no long-lived runner credentials on disk.
- **Count-based, not job-pinned:** it scales the *number* of runners to match queued demand and lets GitHub assign jobs — the correct model for ephemeral runners.

## How it works

```
dispatcher (one always-on process)
  every ~15s, per owned-private repo:
    count queued jobs (scanning queued + in_progress runs) whose labels a flavor can serve
    → mint min(demand, free slots) JIT runners  (re-checking the repo is still private, fail-closed)
    → run each in a throwaway rootless container (fat image)  → one job → auto-deregister → destroy
  reconcile on startup + periodically: remove stale runnerize-* registrations
```

## Requirements

- **Node.js ≥ 20** (uses built-in `fetch`; zero npm dependencies).
- A **container runtime** for the default linux flavor:
  - **Linux:** `podman` (preferred) or `docker`, native.
  - **Windows:** WSL2 with `podman`/`docker` inside a distro (no Docker Desktop needed).
  - **macOS:** `colima` or `podman machine` (a Lima Linux VM) for linux-container jobs.
- A **GitHub token** with access to your repos. v0.1 resolves it from `$GH_TOKEN` / `$GITHUB_TOKEN`, else `gh auth token`. (A scoped **GitHub App** — short-lived, `actions:write` only — is the recommended production credential and is on the roadmap.)

## Usage

For a fresh Windows 11 setup, see [docs/QUICKSTART-windows.md](docs/QUICKSTART-windows.md).

```bash
# from a checkout:
node bin/runnerize.js run          # start the dispatcher (foreground)
node bin/runnerize.js status       # show flavors, owned-private repos, live runners
node bin/runnerize.js run --dry-run  # enumerate demand, mint nothing
node bin/runnerize.js remove       # one reconcile/cleanup pass
node bin/runnerize.js service install   # install as a boot service

# once published:
npx github:animeshkundu/runnerize#<tag> run
```

Point a repo's workflow at the runner (always name the OS/arch labels — a bare `[self-hosted]` is ambiguous across flavors):

```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, x64]
```

### Flags & env

| | |
|---|---|
| `--max <n>` | max concurrent runners (default 4) |
| `--interval <ms>` | poll interval (default 15000; adapts with repo count) |
| `--idle-timeout <ms>` | kill an unclaimed runner after this (default 120000) |
| `RUNNERIZE_LINUX_IMAGE` | fat image (default `catthehacker/ubuntu:full-latest`) |
| `RUNNERIZE_RUNNER_DIR` | use a preinstalled runner dir instead of downloading |
| `RUNNERIZE_WSL_DISTRO` | pin the WSL distro (Windows host) |

## Security model

- **Private-only:** only repos that are `private`, owned by you, and `type==User` are ever dispatched; forks excluded by default. Privacy is re-checked immediately before every mint and **fails closed**.
- **Isolation:** each job runs in a throwaway rootless container that cannot read the host keychain, credential file, or process memory — validated (a job could not read a host secret).
- **Credential:** held only by the dispatcher; passed to the runner via env, never on a command line; runner binary is SHA-256-verified before use.

## Backends

| Flavor | Host | Mechanism | Status |
|---|---|---|---|
| `linux` | any (Linux / WSL / Colima) | rootless container, fat image | **working** |
| `windows` | Windows 11 Pro/Enterprise | Windows Sandbox (disposable) | stub; auto-detects when the feature is enabled |
| `macos` | Apple hardware | `tart` VM | stub; requires `tart` |

## Known limitations

- One dispatcher is a single always-on process; if it's down, jobs queue up to GitHub's 24h timeout. WSL/macOS aren't guaranteed always-on across a headless reboot.
- Per-job latency = poll interval + container start; great for occasional private-repo CI, not for tight edit-run loops.
- Native Windows/macOS statelessness needs VMs (heavier than Linux containers).

## License

MIT.
