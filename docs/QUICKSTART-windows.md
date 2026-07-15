# Run runnerize on a fresh Windows 11 machine

For operational details and other hosts, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Prerequisites

These must be installed before runnerize can set itself up:

1. **WSL2 and a Linux distro with systemd enabled.** Inside the distro, add:

   ```ini
   # /etc/wsl.conf
   [boot]
   systemd=true
   ```

   Then run `wsl --shutdown` from Windows. Verify systemd from PowerShell or Command Prompt:

   ```powershell
   wsl -e bash -lc 'ps -p 1 -o comm='
   ```

   The command must print `systemd`.

2. **Rootless Podman inside WSL.** For an Ubuntu or Debian distro:

   ```bash
   sudo apt-get update && sudo apt-get install -y podman
   podman info
   ```

3. **GitHub CLI authentication inside WSL.** Authenticate as the personal account that owns the private repositories runnerize will serve:

   ```bash
   gh auth login
   gh auth status
   ```

   The token needs access to all those private repositories. A classic token with `repo` scope covers the required repository, Actions, and runner-administration APIs. An enterprise-managed-user identity cannot own personal repositories. Alternatively, set `GH_TOKEN` or `GITHUB_TOKEN` in Windows before installation; runnerize persists it for the WSL service.

4. **Node.js 20 or newer on Windows**, so `npx` can run. Node does not need to be preinstalled in WSL: runnerize reuses a suitable WSL Node if present, otherwise downloads its checksum-verified pinned version (`v24.18.0`) into its own cache.

## Install

Run from PowerShell or Command Prompt on Windows:

```powershell
npx runnerize service install
```

Or install the CLI globally first:

```powershell
npm i -g runnerize
runnerize service install
```

The installer checks WSL, systemd, the container runtime, and GitHub authentication; prepares Node and runnerize inside WSL; installs a restarting systemd user service; enables user lingering where permitted; and adds a Windows logon trigger. It first registers the per-user Task Scheduler task without elevation. If Windows requires administrator access, it requests one UAC approval and registers the same task elevated. The prompt and elevated command share a 55-second timeout and report success through the elevated process exit code. If elevation is declined, unavailable, fails, or times out, runnerize falls back to the current user's Startup folder (login-only, without automatic restart).

For scripted installs or managed machines where you do not want a UAC prompt, pass `--no-elevate` or set `RUNNERIZE_NO_ELEVATE` to any non-empty value:

```powershell
npx runnerize service install --no-elevate
# Equivalent:
$env:RUNNERIZE_NO_ELEVATE = '1'
npx runnerize service install
```

The flag and environment variable are additive: either one skips elevation and sends an access-denied Task Scheduler registration directly to the Startup-folder fallback. The same controls apply to uninstall; if an elevated task cannot be removed without UAC, runnerize prints manual removal instructions and continues cleaning up the other components.

If you have multiple WSL distros, select one before installing:

```powershell
$env:RUNNERIZE_WSL_DISTRO = 'Ubuntu'
npx runnerize service install
```

## Target runnerize from a workflow

runnerize currently offers the Linux flavor with exactly these labels:

```yaml
jobs:
  build:
    runs-on: [self-hosted, linux, x64]
    steps:
      - uses: actions/checkout@v4
      - run: echo "running in runnerize"
```

## Tune the service

The default image is `docker.io/catthehacker/ubuntu:full-latest`. Its first pull can consume roughly 52 GB. To use the lighter `docker.io/catthehacker/ubuntu:act-latest` image or exclude repositories served elsewhere, create this file inside WSL:

```ini
# ~/.config/systemd/user/runnerize.service.d/override.conf
[Service]
Environment=RUNNERIZE_LINUX_IMAGE=docker.io/catthehacker/ubuntu:act-latest
Environment=RUNNERIZE_EXCLUDE_REPOS=owner/repo
```

`RUNNERIZE_EXCLUDE_REPOS` accepts comma- or whitespace-separated `owner/repo` names. Apply changes inside WSL:

```bash
systemctl --user daemon-reload
systemctl --user restart runnerize
```

## Verify

Follow the service log (replace `Ubuntu` if you selected another distro):

```powershell
wsl -d Ubuntu -e journalctl --user -u runnerize -f
```

Push or manually trigger a workflow using `[self-hosted, linux, x64]`, then confirm its job moves from queued to successful.

## Uninstall

Run on Windows using the same CLI installation method:

```powershell
runnerize service uninstall
```

With no global install, use `npx runnerize service uninstall`.
