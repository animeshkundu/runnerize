import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToken } from './github.js';

const SERVICE_NAME = 'runnerize';
const DEFAULT_WSL_NODE_VERSION = 'v24.18.0';
const DEFAULT_WSL_NODE_SHA256 = '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742';
const binPath = fileURLToPath(new URL('../bin/runnerize.js', import.meta.url));
const packageRoot = dirname(dirname(binPath));
const ELEVATION_TIMEOUT_MS = 55_000;
const PROBE_TIMEOUT_MS = 10_000;
const INSTALL_TIMEOUT_MS = 120_000;
const WSL_INSTALL_GUIDANCE = 'In an elevated PowerShell: wsl --install -d Ubuntu\nThen restart Windows if prompted and rerun this command.';
const GITHUB_AUTH_GUIDANCE = 'Run: gh auth login\nOr set GH_TOKEN/GITHUB_TOKEN. The credential needs Administration, Actions, and Metadata access across all owned private repositories.';
const windowsPowerShellPath = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
);
const powershellPath = existsSync(windowsPowerShellPath) ? windowsPowerShellPath : 'powershell.exe';

function quoteSystemd(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function capture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, ...options }).trim();
}

function captureResult(command, args, options = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, { encoding: 'utf8', windowsHide: true, ...options }),
      stderr: '',
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
      error,
    };
  }
}

function commandExists(command) {
  const probe = platform() === 'win32'
    ? spawnSync('where.exe', [command], { stdio: 'ignore' })
    : spawnSync('sh', ['-c', `command -v "$1" >/dev/null 2>&1`, 'sh', command], {
      stdio: 'ignore',
    });
  return probe.status === 0;
}

async function installSystemd(options = {}) {
  await preflightRun({ only: options.only });
  const unitPath = join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  const environmentFile = process.env.RUNNERIZE_SYSTEMD_ENV_FILE
    ? `EnvironmentFile=-${process.env.RUNNERIZE_SYSTEMD_ENV_FILE}\n`
    : '';
  const onlyArgs = options.only?.size ? ` --only ${[...options.only].join(',')}` : '';
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, `[Unit]
Description=runnerize ephemeral GitHub Actions dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(process.execPath)} ${quoteSystemd(binPath)} run${onlyArgs}
${environmentFile}Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=infinity

[Install]
WantedBy=default.target
`, { mode: 0o644 });

  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`]);
  console.log(`Installed and started ${unitPath}`);
  console.log('To run before login, enable user lingering: loginctl enable-linger "$USER"');
  console.log(`View logs: journalctl --user -u ${SERVICE_NAME} -f`);
}

function uninstallSystemd() {
  const unitPath = join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  if (commandExists('systemctl')) {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], {
      stdio: 'inherit',
    });
  }
  rmSync(unitPath, { force: true });
  if (commandExists('systemctl')) run('systemctl', ['--user', 'daemon-reload']);
  console.log(`Removed ${unitPath}`);
}

async function installLaunchd() {
  await preflightRun();
  const agentPath = join(homedir(), 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist');
  mkdirSync(dirname(agentPath), { recursive: true });
  writeFileSync(agentPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.runnerize.dispatcher</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(binPath)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(join(homedir(), 'Library', 'Logs', 'runnerize.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(homedir(), 'Library', 'Logs', 'runnerize.log'))}</string>
</dict>
</plist>
`, { mode: 0o644 });

  const domain = `gui/${process.getuid()}`;
  spawnSync('launchctl', ['bootout', domain, agentPath], { stdio: 'ignore' });
  run('launchctl', ['bootstrap', domain, agentPath]);
  console.log(`Installed and started ${agentPath}`);
  console.log(`View logs: tail -f ${join(homedir(), 'Library', 'Logs', 'runnerize.log')}`);
}

function uninstallLaunchd() {
  const agentPath = join(homedir(), 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist');
  if (existsSync(agentPath)) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, agentPath], { stdio: 'inherit' });
  }
  rmSync(agentPath, { force: true });
  console.log(`Removed ${agentPath}`);
}

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cleanWslOutput(value) {
  return String(value).replaceAll('\0', '').replaceAll('\r', '').replace(/^[﻿�]+/, '').trim();
}

function wslArgs(distro, user, args) {
  return ['-d', distro, ...(user ? ['-u', user] : []), '-e', ...args];
}

function wslCapture(distro, user, args, options = {}) {
  return cleanWslOutput(capture('wsl.exe', wslArgs(distro, user, args), options));
}

function wslRun(distro, user, args, options = {}) {
  return run('wsl.exe', wslArgs(distro, user, args), options);
}

function resolveWslDistro() {
  let status = '';
  try {
    status = cleanWslOutput(capture('wsl.exe', ['--status'], { timeout: PROBE_TIMEOUT_MS }));
  } catch {
    // Some older WSL versions do not support --status; listing distros remains authoritative.
  }

  let output;
  try {
    output = cleanWslOutput(capture('wsl.exe', ['-l', '-q'], { timeout: PROBE_TIMEOUT_MS }));
  } catch (error) {
    throw new Error(`WSL2 and a working Linux distro are required.\n${WSL_INSTALL_GUIDANCE}\n(${error.message})`);
  }

  const available = output.split('\n').map((line) => line.replace(/^[﻿�]+/, '').trim()).filter(Boolean);
  const requested = process.env.RUNNERIZE_WSL_DISTRO;
  if (requested) {
    const matched = available.find((name) => name.toLowerCase() === requested.toLowerCase());
    if (!matched) throw new Error(`WSL distro ${requested} was not found. Available distros: ${available.join(', ') || 'none'}`);
    return matched;
  }

  const defaultName = status.match(/Default Distribution:\s*(.+)/i)?.[1]?.trim();
  const preferred = defaultName && !/^docker-desktop(?:-data)?$/i.test(defaultName)
    ? available.find((name) => name.toLowerCase() === defaultName.toLowerCase())
    : null;
  const distro = preferred || available.find((name) => !/^docker-desktop(?:-data)?$/i.test(name));
  if (!distro) throw new Error(`No usable WSL distro was found.\n${WSL_INSTALL_GUIDANCE}`);
  return distro;
}

function resolveWslContext() {
  const distro = resolveWslDistro();
  let user;
  let home;
  try {
    user = wslCapture(distro, null, ['whoami'], { timeout: PROBE_TIMEOUT_MS });
    home = wslCapture(distro, user, ['sh', '-c', 'printf %s "$HOME"'], { timeout: PROBE_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`Could not start WSL distro ${distro}: ${error.message}`);
  }
  if (!user || !home.startsWith('/')) throw new Error(`Could not determine the Linux user and home directory in ${distro}.`);
  return { distro, user, home };
}

function ensureWslRuntime({ distro, user }, { install = true } = {}) {
  for (const candidate of ['podman', 'docker']) {
    try {
      wslCapture(distro, user, [candidate, 'info'], { timeout: PROBE_TIMEOUT_MS });
      return candidate;
    } catch {
      // Try the other supported runtime before installing anything.
    }
  }

  let debianLike = false;
  try {
    const family = wslCapture(distro, user, ['sh', '-c', '. /etc/os-release; printf "%s %s" "$ID" "$ID_LIKE"'], { timeout: PROBE_TIMEOUT_MS });
    debianLike = /(?:^|\s)(?:debian|ubuntu)(?:\s|$)/i.test(family);
  } catch {
    // Give manual guidance when the distro cannot be identified.
  }

  const installCommand = 'sudo -n apt-get update && sudo -n apt-get install -y podman';
  if (!install) {
    throw new Error(`No working container runtime was found in WSL distro ${distro}. Run this inside that distro:\n${installCommand}\nThen verify \`podman info\` and rerun this command.`);
  }
  if (debianLike) {
    console.log(`Podman was not found in WSL distro ${distro}; attempting a non-interactive install...`);
    try {
      wslCapture(distro, user, ['bash', '-lc', installCommand], { timeout: INSTALL_TIMEOUT_MS });
      wslCapture(distro, user, ['podman', '--version'], { timeout: PROBE_TIMEOUT_MS });
      return 'podman';
    } catch {
      throw new Error(`Podman could not be installed non-interactively in WSL distro ${distro}. Run this inside that distro:\n${installCommand}\nThen verify \`podman info\` and rerun this command.`);
    }
  }

  throw new Error(`No working container runtime was found in WSL distro ${distro}. Install rootless Podman, verify \`podman info\`, then rerun this command. On Debian/Ubuntu run:\n${installCommand}`);
}

function preflightWsl(context, { requireSystemd = true } = {}) {
  if (requireSystemd) {
    const init = wslCapture(context.distro, context.user, ['ps', '-p', '1', '-o', 'comm='], { timeout: PROBE_TIMEOUT_MS });
    if (init !== 'systemd') {
      throw new Error(`systemd is not running in WSL distro ${context.distro}. Enable it in /etc/wsl.conf, run \`wsl.exe --shutdown\`, then retry.`);
    }
  }

  const runtime = ensureWslRuntime(context);

  try {
    wslCapture(context.distro, context.user, ['gh', 'auth', 'status'], { timeout: PROBE_TIMEOUT_MS });
    return { runtime, token: null };
  } catch {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) return { runtime, token };
    throw new Error(`GitHub authentication is not available in WSL distro ${context.distro}.\n${GITHUB_AUTH_GUIDANCE}`);
  }
}

function nativeRuntime() {
  for (const candidate of ['podman', 'docker']) {
    const probe = spawnSync(candidate, ['info'], { stdio: 'ignore', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  return null;
}

export async function preflightRun({ install = true, only } = {}) {
  const wantsLinux = !only || only.has('linux');
  const wantsWindows = !only || only.has('windows');
  let runtime;

  if (wantsLinux) {
    if (platform() === 'win32') {
      const context = resolveWslContext();
      runtime = ensureWslRuntime(context, { install });
    } else {
      runtime = nativeRuntime();
      if (!runtime) {
        throw new Error('No working rootless Podman or Docker runtime was found. Install Podman, verify `podman info`, then rerun this command.');
      }
    }
  }
  if (wantsWindows && platform() === 'win32' && !commandExists('wsb.exe')) {
    throw new Error('Windows Sandbox is required for the windows flavor. Enable Windows Sandbox, then rerun this command.');
  }

  try {
    await getToken();
  } catch {
    throw new Error(`GitHub authentication is not available.\n${GITHUB_AUTH_GUIDANCE}`);
  }
  const ready = [runtime && `container runtime ${runtime}`, wantsWindows && platform() === 'win32' && 'Windows Sandbox', 'GitHub credential available'].filter(Boolean);
  console.log(`Prerequisites ready: ${ready.join('; ')}.`);
  return { runtime };
}

function persistWslToken({ distro, user, home }, token) {
  if (!token) return false;
  const path = `${home}/.config/runnerize/.env`;
  const script = 'set -eu\npath="$1"\numask 077\nmkdir -p "$(dirname "$path")"\nprintf "GH_TOKEN=%s\\n" "$GH_TOKEN" > "$path"\nchmod 600 "$path"';
  wslRun(distro, user, ['sh', '-c', script, 'runnerize-token', path], { env: { ...process.env, WSLENV: [process.env.WSLENV, 'GH_TOKEN'].filter(Boolean).join(':'), GH_TOKEN: token } });
  return true;
}

function systemdWslArgs(command) {
  const script = 'export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; exec "$@"';
  return ['bash', '-lc', script, 'runnerize-systemd', ...command];
}

function validNodeVersion(output) {
  const match = String(output).match(/^v(\d+)\.\d+\.\d+$/);
  return match && Number(match[1]) >= 18;
}

function ensureWslNode({ distro, user, home }) {
  const requestedVersion = process.env.RUNNERIZE_WSL_NODE_VERSION || DEFAULT_WSL_NODE_VERSION;
  if (!/^v\d+\.\d+\.\d+$/.test(requestedVersion)) throw new Error('RUNNERIZE_WSL_NODE_VERSION must look like v24.18.0.');
  const installDir = `${home}/.cache/runnerize/node/${requestedVersion}`;
  const cachedNodePath = `${installDir}/bin/node`;
  try {
    const cachedVersion = wslCapture(distro, user, [cachedNodePath, '--version']);
    if (cachedVersion === requestedVersion && validNodeVersion(cachedVersion)) {
      return { path: cachedNodePath, version: cachedVersion, downloaded: false };
    }
  } catch {
    // Fall through to PATH probing or installation.
  }

  try {
    const output = wslCapture(distro, user, ['sh', '-c', 'command -v node && node --version']);
    const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
    const nodePath = lines.at(-2);
    const version = lines.at(-1);
    if (nodePath?.startsWith('/') && validNodeVersion(version)) return { path: nodePath, version, downloaded: false };
  } catch {
    // Install the pinned runnerize-owned Node below.
  }

  const version = requestedVersion;
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('RUNNERIZE_WSL_NODE_VERSION must look like v24.18.0.');
  const expectedHash = version === DEFAULT_WSL_NODE_VERSION
    ? DEFAULT_WSL_NODE_SHA256
    : process.env.RUNNERIZE_WSL_NODE_SHA256;
  if (!/^[a-fA-F0-9]{64}$/.test(expectedHash || '')) {
    throw new Error('Custom RUNNERIZE_WSL_NODE_VERSION requires RUNNERIZE_WSL_NODE_SHA256.');
  }
  const nodePath = cachedNodePath;
  const script = [
    'set -eu',
    'version="$1"',
    'destination="$2"',
    'expected="$3"',
    'archive="node-${version}-linux-x64.tar.xz"',
    'base="https://nodejs.org/dist/${version}"',
    'temporary="$(mktemp -d)"',
    "trap 'rm -rf \"$temporary\" \"${destination}.new.$$\"' EXIT",
    'mkdir -p "$(dirname "$destination")"',
    'if command -v curl >/dev/null 2>&1; then curl -fsSL "$base/$archive" -o "$temporary/$archive"; elif command -v wget >/dev/null 2>&1; then wget -q "$base/$archive" -O "$temporary/$archive"; else echo "curl or wget is required to download Node.js" >&2; exit 1; fi',
    'printf "%s  %s\\n" "$expected" "$temporary/$archive" | sha256sum -c -',
    'staging="${destination}.new.$$"',
    'mkdir -p "$staging"',
    'tar -xJf "$temporary/$archive" --strip-components=1 -C "$staging"',
    'rm -rf "$destination"',
    'mv "$staging" "$destination"',
  ].join('\n');
  wslCapture(distro, user, ['bash', '-c', script, 'runnerize-node-install', version, installDir, expectedHash.toLowerCase()]);
  const verified = wslCapture(distro, user, [nodePath, '--version']);
  if (!validNodeVersion(verified)) throw new Error(`Installed Node at ${nodePath}, but version verification failed.`);
  return { path: nodePath, version: verified, downloaded: true };
}

function materializeRunnerize({ distro, user, home }) {
  const destination = `${home}/.local/share/runnerize`;
  const windowsRoot = capture('wsl.exe', ['-d', distro, '-u', user, '-e', 'wslpath', '-a', packageRoot]);
  const script = [
    'set -eu',
    'source="$1"',
    'destination="$2"',
    'temporary="${destination}.new.$$"',
    'rm -rf "$temporary"',
    'mkdir -p "$temporary"',
    'cp -R "$source/bin" "$source/src" "$source/package.json" "$temporary/"',
    'old="${destination}.old.$$"',
    'rm -rf "$old"',
    'if [ -e "$destination" ]; then mv "$destination" "$old"; fi',
    'if ! mv "$temporary" "$destination"; then if [ -e "$old" ]; then mv "$old" "$destination"; fi; exit 1; fi',
    'rm -rf "$old"',
  ].join('\n');
  wslRun(distro, user, ['bash', '-c', script, 'runnerize-copy', cleanWslOutput(windowsRoot), destination]);
  return { root: destination, bin: `${destination}/bin/runnerize.js` };
}

function windowsStartupPath(fileName = 'runnerize.vbs') {
  return join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', fileName,
  );
}

function currentWindowsUser() {
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  ]);
  const sid = result.status === 0 ? result.stdout?.trim() : '';
  if (sid) return sid;
  throw new Error('Unable to determine the current Windows user SID.');
}

function windowsCommandLineArg(value) {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function systemdStartCommand() {
  return 'export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; systemctl --user start runnerize';
}

function wslTriggerSpec(distro, wslUser) {
  const argument = `-d ${windowsCommandLineArg(distro)} -u ${windowsCommandLineArg(wslUser)} -e bash -lc ${windowsCommandLineArg(systemdStartCommand())}`;
  return {
    taskName: SERVICE_NAME,
    startupFileName: 'runnerize.vbs',
    execute: 'wsl.exe',
    argument,
    startupCommand: `wsl.exe ${argument}`,
  };
}

function taskSchedulerScript(spec, windowsUser) {
  return [
    `$taskName = ${powershellLiteral(spec.taskName)}`,
    `$user = ${powershellLiteral(windowsUser)}`,
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(spec.execute)} -Argument ${powershellLiteral(spec.argument)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    '$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 10 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    'Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null',
  ].join('; ');
}

function taskSchedulerAttemptScript(command) {
  return `$ErrorActionPreference = 'Stop'; try { ${command} } catch { $codes = @($_.Exception.HResult, $_.Exception.ErrorCode, $_.Exception.NativeErrorCode, $_.Exception.InnerException.HResult); if ($codes -contains -2147024891 -or $_.CategoryInfo.Category -eq 'PermissionDenied') { exit 77 }; throw }`;
}

function isAccessDenied(result) {
  if (result.status === 77) return true;
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
  return /access (?:is )?denied|unauthorizedaccess|insufficient privilege|privilege.*not held|requires elevation|permission denied|0x80070005/i.test(output);
}

function writeStartupLauncher(spec) {
  const startupPath = windowsStartupPath(spec.startupFileName);
  mkdirSync(dirname(startupPath), { recursive: true });
  writeFileSync(startupPath, `CreateObject("WScript.Shell").Run "${spec.startupCommand.replaceAll('"', '""')}", 0, False\r\n`);
  return startupPath;
}

async function runElevated(operation, command, { timeoutMs = ELEVATION_TIMEOUT_MS } = {}) {
  const elevatedScript = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    command,
    'exit 0',
    '} catch {',
    'Write-Error $_',
    'exit 1',
    '}',
  ].join('\r\n');
  const encodedCommand = Buffer.from(elevatedScript, 'utf16le').toString('base64');
  const startProcess = `$p = Start-Process -FilePath ${powershellLiteral(powershellPath)} -Verb RunAs -Wait -PassThru -ErrorAction Stop -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',${powershellLiteral(encodedCommand)}); if ($null -eq $p -or $null -eq $p.ExitCode) { Write-Error 'elevated process exit code unavailable'; exit 1 }; exit $p.ExitCode`;
  const launchCommand = `try { ${startProcess} } catch { Write-Error $_; exit 1 }`;
  const launched = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launchCommand,
  ], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  if (launched.error?.code === 'ETIMEDOUT' || launched.error?.killed || launched.error?.signal) {
    // If approval lands at the timeout boundary, Windows may let the detached elevated
    // child finish after fallback. Both triggers only start the idempotent systemd unit.
    return { ok: false, reason: 'elevation prompt was not answered' };
  }
  if (launched.status !== 0 || launched.error) {
    return { ok: false, reason: launched.stderr?.trim() || launched.stdout?.trim() || launched.error?.message || `elevated ${operation} failed` };
  }
  return { ok: true };
}

function scheduledTaskPrincipal(taskName) {
  const script = `$task = Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue; if ($null -eq $task) { exit 1 }; [Console]::Out.Write($task.Principal.UserId)`;
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  return result.status === 0 ? result.stdout.trim() : null;
}

async function installLogonTrigger(spec, { noElevate = false, elevationTimeoutMs } = {}) {
  const windowsUser = currentWindowsUser();
  const script = taskSchedulerScript(spec, windowsUser);
  console.log('Registering logon task...');
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerAttemptScript(script),
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    rmSync(windowsStartupPath(spec.startupFileName), { force: true });
    console.log('Registered auto-start task.');
    return { kind: 'Task Scheduler', detail: `task ${SERVICE_NAME} for ${windowsUser}` };
  }
  if (!isAccessDenied(result)) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit code ${result.status}`;
    throw new Error(`Failed to register Task Scheduler task ${SERVICE_NAME}: ${detail}`);
  }

  if (!noElevate) {
    console.log('Task registration needs administrator access — requesting elevation (decline to use a login-only Startup entry)...');
    const elevated = await runElevated('install', script, { timeoutMs: elevationTimeoutMs });
    if (elevated.ok) {
      const principal = scheduledTaskPrincipal(spec.taskName);
      if (principal?.toLowerCase() === windowsUser.toLowerCase()) {
        rmSync(windowsStartupPath(spec.startupFileName), { force: true });
        console.log('Registered auto-start task (elevated).');
        return { kind: 'Task Scheduler (elevated)', detail: `task ${SERVICE_NAME} for ${windowsUser}` };
      }
      console.warn(`Elevated task registration could not be confirmed${principal ? ` for ${windowsUser}` : ''}.`);
    } else {
      console.warn(`Elevated task registration did not complete: ${elevated.reason}`);
    }
  }

  console.log('Falling back to a Startup-folder entry (login-only, no auto-restart).');
  return { kind: 'Startup folder fallback', detail: writeStartupLauncher(spec) };
}

async function installWslBackend({ noElevate = false, elevationTimeoutMs } = {}) {
  const context = resolveWslContext();
  console.log(`WSL distro: ${context.distro} (user ${context.user})`);
  const preflight = preflightWsl(context);
  console.log(`Container runtime: ${preflight.runtime}`);
  const node = ensureWslNode(context);
  console.log(`Linux Node: ${node.path} (${node.version}${node.downloaded ? ', installed and checksum-verified' : ', reused'})`);
  const persistedToken = persistWslToken(context, preflight.token);
  console.log(`GitHub authentication: ${persistedToken ? 'Windows token persisted for the service' : 'WSL gh credential store'}`);
  const linger = spawnSync('wsl.exe', wslArgs(context.distro, context.user, ['loginctl', 'enable-linger', context.user]), { encoding: 'utf8', windowsHide: true, timeout: PROBE_TIMEOUT_MS });
  if (linger.status === 0) console.log(`User lingering: enabled for ${context.user}`);
  else console.warn(`Could not enable user lingering for ${context.user}; run \`sudo loginctl enable-linger ${context.user}\` inside WSL.`);
  const installation = materializeRunnerize(context);
  console.log(`runnerize package: ${installation.root}`);
  const installCommand = preflight.token
    ? ['env', `RUNNERIZE_SYSTEMD_ENV_FILE=${context.home}/.config/runnerize/.env`, node.path, installation.bin, 'service', 'install', '--only', 'linux']
    : [node.path, installation.bin, 'service', 'install', '--only', 'linux'];
  wslRun(context.distro, context.user, systemdWslArgs(installCommand));
  console.log('systemd user service: installed and enabled');
  const trigger = await installLogonTrigger(wslTriggerSpec(context.distro, context.user), { noElevate, elevationTimeoutMs });
  console.log(`Windows logon trigger: ${trigger.kind} (${trigger.detail})`);
  console.log(`View logs: wsl.exe -d ${context.distro} -u ${context.user} -e journalctl --user -u runnerize -f`);
  console.log('Uninstall: runnerize service uninstall');
}

function windowsLocalRoot() {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'runnerize');
}

function materializeWindowsApp() {
  const root = join(windowsLocalRoot(), 'app');
  const staging = `${root}.new.${process.pid}`;
  const previous = `${root}.old.${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const entry of ['bin', 'src', 'package.json']) {
    cpSync(join(packageRoot, entry), join(staging, entry), { recursive: true });
  }
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(root)) renameSync(root, previous);
  try {
    renameSync(staging, root);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, root);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  return { root, bin: join(root, 'bin', 'runnerize.js') };
}

function persistWindowsToken() {
  const envToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!envToken) return null;
  const tokenPath = join(windowsLocalRoot(), 'windows.token');
  mkdirSync(dirname(tokenPath), { recursive: true });
  const script = '$bytes=[Text.Encoding]::UTF8.GetBytes($env:RUNNERIZE_PLAIN_TOKEN); $encrypted=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($encrypted))';
  const encrypted = capture(powershellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, RUNNERIZE_PLAIN_TOKEN: envToken }, timeout: PROBE_TIMEOUT_MS,
  });
  if (!encrypted) throw new Error('DPAPI encryption returned no credential data.');
  writeFileSync(tokenPath, `${encrypted}\n`, { mode: 0o600 });
  console.log(`GitHub authentication: encrypted session token persisted for native Windows dispatcher (${tokenPath})`);
  return tokenPath;
}

function writeWindowsLauncher(appBin) {
  const root = windowsLocalRoot();
  const launcher = join(root, 'runnerize-windows.ps1');
  const log = join(root, 'runnerize-windows.log');
  mkdirSync(root, { recursive: true });
  writeFileSync(launcher, `$ErrorActionPreference = 'Stop'
$mutex = [Threading.Mutex]::new($false, 'Local\\runnerize-windows')
if (-not $mutex.WaitOne(0)) { exit 0 }
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class RunnerizePower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }
'@
try {
  [void][RunnerizePower]::SetThreadExecutionState(0x80000001)
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  & $node ${powershellLiteral(appBin)} run --only windows *>> ${powershellLiteral(log)}
  exit $LASTEXITCODE
} finally {
  [void][RunnerizePower]::SetThreadExecutionState(0x80000000)
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
`);
  return { launcher, log };
}

function windowsTriggerSpec(launcher) {
  const argument = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsCommandLineArg(launcher)}`;
  return {
    taskName: `${SERVICE_NAME}-windows`,
    startupFileName: `${SERVICE_NAME}-windows.vbs`,
    execute: powershellPath,
    argument,
    startupCommand: `${windowsCommandLineArg(powershellPath)} ${argument}`,
  };
}

async function installNativeWindows(options) {
  await getToken();
  const installation = materializeWindowsApp();
  persistWindowsToken();
  const launcher = writeWindowsLauncher(installation.bin);
  const trigger = await installLogonTrigger(windowsTriggerSpec(launcher.launcher), options);
  console.log(`Native Windows dispatcher: installed (${trigger.kind})`);
  console.log(`Native Windows log: ${launcher.log}`);
  return { installation, launcher, trigger };
}

function bestEffort(command, args) {
  spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
}

async function uninstallWindows({ noElevate = false, elevationTimeoutMs } = {}) {
  let context;
  try {
    context = resolveWslContext();
  } catch (error) {
    console.warn(`Could not reach WSL while uninstalling: ${error.message}`);
  }

  if (context) {
    const installation = `${context.home}/.local/share/runnerize`;
    let nodePath;
    try {
      const version = process.env.RUNNERIZE_WSL_NODE_VERSION || DEFAULT_WSL_NODE_VERSION;
      const cached = `${context.home}/.cache/runnerize/node/${version}/bin/node`;
      nodePath = wslCapture(context.distro, context.user, ['sh', '-c', 'if [ -x "$1" ]; then printf %s "$1"; else command -v node || true; fi', 'sh', cached]);
    } catch {
      nodePath = null;
    }
    if (nodePath) bestEffort('wsl.exe', wslArgs(context.distro, context.user, systemdWslArgs([nodePath, `${installation}/bin/runnerize.js`, 'service', 'uninstall'])));
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, ['loginctl', 'disable-linger', context.user]));
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, ['rm', '-rf', installation, `${context.home}/.cache/runnerize/node`, `${context.home}/.config/runnerize`]));
  }

  const removeTask = async (taskName) => {
    const script = `Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop`;
    const taskRemoval = captureResult(powershellPath, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerAttemptScript(script),
    ], { encoding: 'utf8', windowsHide: true });
    if (taskRemoval.status !== 0 && isAccessDenied(taskRemoval) && !noElevate) {
      const elevated = await runElevated('uninstall', script, { timeoutMs: elevationTimeoutMs });
      if (!elevated.ok) console.warn(`Could not remove the elevated ${taskName} task: ${elevated.reason}.`);
    } else if (taskRemoval.status !== 0 && isAccessDenied(taskRemoval)) {
      console.warn(`Could not remove the elevated ${taskName} task without administrator access.`);
    }
  };
  await removeTask(SERVICE_NAME);
  await removeTask(`${SERVICE_NAME}-windows`);
  rmSync(windowsStartupPath(), { force: true });
  rmSync(windowsStartupPath(`${SERVICE_NAME}-windows.vbs`), { force: true });
  rmSync(join(windowsLocalRoot(), 'app'), { recursive: true, force: true });
  rmSync(join(windowsLocalRoot(), 'runnerize-windows.ps1'), { force: true });
  rmSync(join(windowsLocalRoot(), 'windows.token'), { force: true });
  rmSync(join(windowsLocalRoot(), 'runnerize-windows.log'), { force: true });
  console.log('Removed runnerize service backends and native artifacts where present.');
}

function elevationDisabled(options) {
  return Boolean(options.noElevate || process.env.RUNNERIZE_NO_ELEVATE);
}

async function installWindows(options = {}) {
  const selected = options.only;
  const wantsLinux = !selected || selected.has('linux');
  const wantsWindows = !selected || selected.has('windows');
  const results = [];

  if (wantsLinux) {
    try {
      await installWslBackend(options);
      results.push({ backend: 'linux', status: 'installed' });
    } catch (error) {
      console.warn(`Linux/WSL backend unavailable: ${error.message}`);
      results.push({ backend: 'linux', status: 'unavailable', error });
    }
  } else results.push({ backend: 'linux', status: 'skipped' });

  if (wantsWindows && commandExists('wsb.exe')) {
    try {
      await installNativeWindows(options);
      results.push({ backend: 'windows', status: 'installed' });
    } catch (error) {
      console.warn(`Windows Sandbox backend unavailable: ${error.message}`);
      results.push({ backend: 'windows', status: 'unavailable', error });
    }
  } else results.push({ backend: 'windows', status: wantsWindows ? 'unavailable' : 'skipped' });

  for (const result of results) console.log(`Backend ${result.backend}: ${result.status}`);
  if (!results.some((result) => result.status === 'installed')) {
    throw new Error('No requested runnerize backend could be installed. Install WSL2/Podman or enable Windows Sandbox, then retry.');
  }
  return results;
}

export async function installService(options = {}) {
  if (platform() === 'darwin') return installLaunchd();
  if (platform() === 'win32') return installWindows({ ...options, noElevate: elevationDisabled(options), elevationTimeoutMs: options.elevationTimeoutMs });
  if (!commandExists('systemctl')) {
    throw new Error('systemd is required to install runnerize as a Linux/WSL service.');
  }
  return installSystemd(options);
}

export async function uninstallService(options = {}) {
  if (platform() === 'darwin') return uninstallLaunchd();
  if (platform() === 'win32') return uninstallWindows({ noElevate: elevationDisabled(options), elevationTimeoutMs: options.elevationTimeoutMs });
  return uninstallSystemd();
}
