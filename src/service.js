import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'runnerize';
const DEFAULT_WSL_NODE_VERSION = 'v24.18.0';
const DEFAULT_WSL_NODE_SHA256 = '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742';
const binPath = fileURLToPath(new URL('../bin/runnerize.js', import.meta.url));
const packageRoot = dirname(dirname(binPath));
const ELEVATION_TIMEOUT_MS = 55_000;
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

function installSystemd() {
  const unitPath = join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  const environmentFile = process.env.RUNNERIZE_SYSTEMD_ENV_FILE
    ? `EnvironmentFile=-${process.env.RUNNERIZE_SYSTEMD_ENV_FILE}\n`
    : '';
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, `[Unit]
Description=runnerize ephemeral GitHub Actions dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(process.execPath)} ${quoteSystemd(binPath)} run
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

function installLaunchd() {
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
    status = cleanWslOutput(capture('wsl.exe', ['--status']));
  } catch {
    // Some older WSL versions do not support --status; listing distros remains authoritative.
  }

  let output;
  try {
    output = cleanWslOutput(capture('wsl.exe', ['-l', '-q']));
  } catch (error) {
    throw new Error(`WSL is required. Install WSL and a Linux distro, then rerun this command. (${error.message})`);
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
  if (!distro) throw new Error('No usable WSL distro was found. Install Ubuntu or set RUNNERIZE_WSL_DISTRO.');
  return distro;
}

function resolveWslContext() {
  const distro = resolveWslDistro();
  let user;
  let home;
  try {
    user = wslCapture(distro, null, ['whoami']);
    home = wslCapture(distro, user, ['sh', '-c', 'printf %s "$HOME"']);
  } catch (error) {
    throw new Error(`Could not start WSL distro ${distro}: ${error.message}`);
  }
  if (!user || !home.startsWith('/')) throw new Error(`Could not determine the Linux user and home directory in ${distro}.`);
  return { distro, user, home };
}

function preflightWsl({ distro, user }) {
  const init = wslCapture(distro, user, ['ps', '-p', '1', '-o', 'comm=']);
  if (init !== 'systemd') {
    throw new Error(`systemd is not running in WSL distro ${distro}. Enable it in /etc/wsl.conf, run \`wsl.exe --shutdown\`, then retry.`);
  }

  let runtime;
  for (const candidate of ['podman', 'docker']) {
    try {
      wslCapture(distro, user, [candidate, 'info']);
      runtime = candidate;
      break;
    } catch {
      // Try the other supported runtime.
    }
  }
  if (!runtime) {
    throw new Error(`No working container runtime was found in WSL distro ${distro}. Install rootless Podman inside WSL, verify \`podman info\`, then rerun this command.`);
  }

  try {
    wslCapture(distro, user, ['gh', 'auth', 'status']);
    return { runtime, token: null };
  } catch {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) return { runtime, token };
    throw new Error(`GitHub authentication is not available in WSL distro ${distro}. Run \`gh auth login\` inside that distro, or set GH_TOKEN/GITHUB_TOKEN, then retry.`);
  }
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

function windowsStartupPath() {
  return join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'runnerize.vbs',
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

function taskSchedulerScript(distro, wslUser, windowsUser) {
  const argumentsValue = `-d ${windowsCommandLineArg(distro)} -u ${windowsCommandLineArg(wslUser)} -e bash -lc ${windowsCommandLineArg(systemdStartCommand())}`;
  return [
    `$taskName = ${powershellLiteral(SERVICE_NAME)}`,
    `$user = ${powershellLiteral(windowsUser)}`,
    `$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument ${powershellLiteral(argumentsValue)}`,
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

function writeStartupLauncher(distro, user) {
  const startupPath = windowsStartupPath();
  mkdirSync(dirname(startupPath), { recursive: true });
  const command = `wsl.exe -d ${windowsCommandLineArg(distro)} -u ${windowsCommandLineArg(user)} -e bash -lc ${windowsCommandLineArg(systemdStartCommand())}`;
  writeFileSync(startupPath, `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`);
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
  const startProcess = `$p = Start-Process -FilePath ${powershellLiteral(powershellPath)} -Verb RunAs -Wait -PassThru -ErrorAction Stop -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand',${powershellLiteral(encodedCommand)}); exit $p.ExitCode`;
  const launchCommand = `try { ${startProcess} } catch { Write-Error $_; exit 1 }`;
  const launched = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', launchCommand,
  ], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  if (launched.error?.code === 'ETIMEDOUT' || launched.error?.killed || launched.error?.signal) {
    return { ok: false, reason: 'elevation prompt was not answered' };
  }
  if (launched.status !== 0 || launched.error) {
    return { ok: false, reason: launched.stderr?.trim() || launched.stdout?.trim() || launched.error?.message || `elevated ${operation} failed` };
  }
  return { ok: true };
}

async function installLogonTrigger(distro, user, { noElevate = false, elevationTimeoutMs } = {}) {
  const windowsUser = currentWindowsUser();
  const script = taskSchedulerScript(distro, user, windowsUser);
  console.log('Registering logon task...');
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerAttemptScript(script),
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    rmSync(windowsStartupPath(), { force: true });
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
      rmSync(windowsStartupPath(), { force: true });
      console.log('Registered auto-start task (elevated).');
      return { kind: 'Task Scheduler (elevated)', detail: `task ${SERVICE_NAME} for ${windowsUser}` };
    }
    console.warn(`Elevated task registration did not complete: ${elevated.reason}`);
  }

  console.log('Falling back to a Startup-folder entry (login-only, no auto-restart).');
  return { kind: 'Startup folder fallback', detail: writeStartupLauncher(distro, user) };
}

async function installWindows({ noElevate = false, elevationTimeoutMs } = {}) {
  const context = resolveWslContext();
  console.log(`WSL distro: ${context.distro} (user ${context.user})`);
  const preflight = preflightWsl(context);
  console.log(`Container runtime: ${preflight.runtime}`);
  const persistedToken = persistWslToken(context, preflight.token);
  console.log(`GitHub authentication: ${persistedToken ? 'Windows token persisted for the service' : 'WSL gh credential store'}`);
  const linger = spawnSync('wsl.exe', wslArgs(context.distro, context.user, ['loginctl', 'enable-linger', context.user]), { encoding: 'utf8', windowsHide: true });
  if (linger.status === 0) console.log(`User lingering: enabled for ${context.user}`);
  else console.warn(`Could not enable user lingering for ${context.user}; run \`sudo loginctl enable-linger ${context.user}\` inside WSL.`);
  const node = ensureWslNode(context);
  console.log(`Linux Node: ${node.path} (${node.version}${node.downloaded ? ', installed and checksum-verified' : ', reused'})`);
  const installation = materializeRunnerize(context);
  console.log(`runnerize package: ${installation.root}`);
  const installCommand = preflight.token
    ? ['env', `RUNNERIZE_SYSTEMD_ENV_FILE=${context.home}/.config/runnerize/.env`, node.path, installation.bin, 'service', 'install']
    : [node.path, installation.bin, 'service', 'install'];
  wslRun(context.distro, context.user, systemdWslArgs(installCommand));
  console.log('systemd user service: installed and enabled');
  const trigger = await installLogonTrigger(context.distro, context.user, { noElevate, elevationTimeoutMs });
  console.log(`Windows logon trigger: ${trigger.kind} (${trigger.detail})`);
  console.log(`View logs: wsl.exe -d ${context.distro} -u ${context.user} -e journalctl --user -u runnerize -f`);
  console.log('Uninstall: runnerize service uninstall');
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

  const script = `Get-ScheduledTask -TaskName ${powershellLiteral(SERVICE_NAME)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop`;
  const taskRemoval = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerAttemptScript(script),
  ], { encoding: 'utf8', windowsHide: true });
  if (taskRemoval.status !== 0 && isAccessDenied(taskRemoval)) {
    if (noElevate) {
      console.warn(`Could not remove the elevated ${SERVICE_NAME} task without administrator access. Remove it manually in Task Scheduler or rerun uninstall elevated.`);
    } else {
      console.log('Task removal needs administrator access — requesting elevation...');
      const elevated = await runElevated('uninstall', script, { timeoutMs: elevationTimeoutMs });
      if (!elevated.ok) {
        console.warn(`Could not remove the elevated ${SERVICE_NAME} task: ${elevated.reason}. Remove it manually in Task Scheduler or rerun uninstall elevated.`);
      } else {
        console.log('Removed auto-start task (elevated).');
      }
    }
  } else if (taskRemoval.status !== 0) {
    const detail = taskRemoval.stderr?.trim() || taskRemoval.stdout?.trim() || taskRemoval.error?.message || `exit code ${taskRemoval.status}`;
    console.warn(`Could not remove the ${SERVICE_NAME} task: ${detail}. Remove it manually in Task Scheduler if it still exists.`);
  }
  rmSync(windowsStartupPath(), { force: true });
  console.log('Removed the WSL systemd service, Windows logon trigger, package copy, and Node cache where present.');
}

function elevationDisabled(options) {
  return Boolean(options.noElevate || process.env.RUNNERIZE_NO_ELEVATE);
}

export async function installService(options = {}) {
  if (platform() === 'darwin') return installLaunchd();
  if (platform() === 'win32') return installWindows({ noElevate: elevationDisabled(options), elevationTimeoutMs: options.elevationTimeoutMs });
  if (!commandExists('systemctl')) {
    throw new Error('systemd is required to install runnerize as a Linux/WSL service.');
  }
  return installSystemd();
}

export async function uninstallService(options = {}) {
  if (platform() === 'darwin') return uninstallLaunchd();
  if (platform() === 'win32') return uninstallWindows({ noElevate: elevationDisabled(options), elevationTimeoutMs: options.elevationTimeoutMs });
  return uninstallSystemd();
}
