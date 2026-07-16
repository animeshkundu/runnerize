# Run runnerize on a fresh Windows 11 machine

For operational details and other hosts, see [DEPLOYMENT.md](DEPLOYMENT.md).

## Prerequisites

`runnerize run` (including `--dry-run`) and `runnerize service install` now preflight their prerequisites. They reuse an existing container runtime. Full runs and service installs attempt to install Podman on Debian/Ubuntu WSL with the bounded, non-interactive command `sudo -n apt-get update && sudo -n apt-get install -y podman`; dry runs only probe and print that command as guidance. This never waits for a password. If non-interactive sudo is unavailable, runnerize prints the exact command for you to run manually.

The remaining interactive or administrator prerequisites are:

1. **WSL2 and a Linux distro with systemd enabled.** If no working distro exists, runnerize prints the copy-pasteable elevated PowerShell command `wsl --install -d Ubuntu`. Inside the distro, add:

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

2. **GitHub CLI authentication.** Authenticate as the personal account that owns the private repositories runnerize will serve:

   ```bash
   gh auth login
   gh auth status
   ```

   The token needs access to all those private repositories. A classic token with `repo` scope covers the required repository, Actions, and runner-administration APIs. An enterprise-managed-user identity cannot own personal repositories. Alternatively, set `GH_TOKEN` or `GITHUB_TOKEN` in Windows before installation; runnerize persists it for the WSL service.

3. **Node.js 20 or newer on Windows**, so `npx` can run. Node does not need to be preinstalled in WSL: runnerize reuses a suitable WSL Node if present, otherwise downloads its checksum-verified pinned version (`v24.18.0`) into its own cache.

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

The installer independently installs every available backend. WSL gets a restarting systemd user service pinned to `--only linux`; Windows Sandbox gets a native dispatcher pinned to `--only windows`. Each gets a distinct logon trigger. Task Scheduler is attempted without elevation, then with one bounded UAC request; only when the task is confirmed absent does runnerize create a Startup-folder fallback. The native dispatcher keeps the system awake without keeping the display on, allows one visible Windows Sandbox job at a time, and logs to `%LOCALAPPDATA%\runnerize\runnerize-windows.log`.

Persistence begins at the next interactive logon. It does not provide pre-login unattended service, and Windows Sandbox is unsupported while the desktop is locked or an RDP session is disconnected. AutoLogon can make reboots unattended but stores reusable credentials and should be evaluated as a security trade-off.

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

Use `[self-hosted, linux, x64]` for a WSL container job or `[self-hosted,
windows, x64]` for a Windows Sandbox job:

```yaml
jobs:
  linux:
    runs-on: [self-hosted, linux, x64]
    steps:
      - uses: actions/checkout@v4
  windows:
    runs-on: [self-hosted, windows, x64]
    steps:
      - uses: actions/checkout@v4
```

For foreground troubleshooting, `runnerize run --only windows` isolates one backend.
Use `--no-keep-awake` if the host should be allowed to sleep. `runnerize status`
always reports all available flavors.

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
