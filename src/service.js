import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'runnerize';
const DEFAULT_WSL_NODE_VERSION = 'v20.18.1';
const binPath = fileURLToPath(new URL('../bin/runnerize.js', import.meta.url));
const packageRoot = dirname(dirname(binPath));

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
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, `[Unit]
Description=runnerize ephemeral GitHub Actions dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(process.execPath)} ${quoteSystemd(binPath)} run
Restart=always
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
  return String(value).replaceAll('\0', '').replaceAll('\r', '').trim();
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
  try {
    capture('wsl.exe', ['--status']);
  } catch {
    // Some older WSL versions do not support --status; listing distros remains authoritative.
  }

  let output;
  try {
    output = cleanWslOutput(capture('wsl.exe', ['-l', '-q']));
  } catch (error) {
    throw new Error(`WSL is required. Install WSL and a Linux distro, then rerun this command. (${error.message})`);
  }

  const available = output.split('\n').map((line) => line.trim()).filter(Boolean);
  const requested = process.env.RUNNERIZE_WSL_DISTRO;
  if (requested) {
    const matched = available.find((name) => name.toLowerCase() === requested.toLowerCase());
    if (!matched) throw new Error(`WSL distro ${requested} was not found. Available distros: ${available.join(', ') || 'none'}`);
    return matched;
  }

  const distro = available.find((name) => !/^docker-desktop(?:-data)?$/i.test(name));
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
  let runtime;
  for (const candidate of ['podman', 'docker']) {
    try {
      wslCapture(distro, user, [candidate, '--version']);
      runtime = candidate;
      break;
    } catch {
      // Try the other supported runtime.
    }
  }
  if (!runtime) {
    throw new Error(`No container runtime was found in WSL distro ${distro}. Install rootless Podman inside WSL, verify \`podman --version\`, then rerun this command.`);
  }

  let githubAuth = false;
  try {
    wslCapture(distro, user, ['gh', 'auth', 'status']);
    githubAuth = true;
  } catch {
    githubAuth = Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN);
  }
  if (!githubAuth) {
    throw new Error(`GitHub authentication is not available in WSL distro ${distro}. Run \`gh auth login\` inside that distro, or set GH_TOKEN/GITHUB_TOKEN, then retry.`);
  }
  return runtime;
}

function validNodeVersion(output) {
  const match = String(output).match(/v(\d+)\./);
  return match && Number(match[1]) >= 18;
}

function ensureWslNode({ distro, user, home }) {
  try {
    const output = wslCapture(distro, user, ['bash', '-lc', 'command -v node && node --version']);
    const [nodePath] = output.split('\n').map((line) => line.trim()).filter(Boolean);
    if (nodePath?.startsWith('/') && validNodeVersion(output)) return { path: nodePath, version: output.split('\n').at(-1), downloaded: false };
  } catch {
    // Install the pinned runnerize-owned Node below.
  }

  const version = process.env.RUNNERIZE_WSL_NODE_VERSION || DEFAULT_WSL_NODE_VERSION;
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('RUNNERIZE_WSL_NODE_VERSION must look like v20.18.1.');
  const installDir = `${home}/.cache/runnerize/node/${version}`;
  const nodePath = `${installDir}/bin/node`;
  const script = [
    'set -eu',
    'version="$1"',
    'destination="$2"',
    'archive="node-${version}-linux-x64.tar.xz"',
    'base="https://nodejs.org/dist/${version}"',
    'temporary="$(mktemp -d)"',
    "trap 'rm -rf \"$temporary\"' EXIT",
    'mkdir -p "$(dirname "$destination")"',
    'if command -v curl >/dev/null 2>&1; then curl -fsSL "$base/$archive" -o "$temporary/$archive"; curl -fsSL "$base/SHASUMS256.txt" -o "$temporary/SHASUMS256.txt"; elif command -v wget >/dev/null 2>&1; then wget -q "$base/$archive" -O "$temporary/$archive"; wget -q "$base/SHASUMS256.txt" -O "$temporary/SHASUMS256.txt"; else echo "curl or wget is required to download Node.js" >&2; exit 1; fi',
    '(cd "$temporary" && grep "  $archive$" SHASUMS256.txt | sha256sum -c -)',
    'mkdir -p "$destination"',
    'tar -xJf "$temporary/$archive" --strip-components=1 -C "$destination"',
  ].join('\n');
  wslRun(distro, user, ['bash', '-c', script, 'runnerize-node-install', version, installDir]);
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
    'rm -rf "$destination"',
    'mv "$temporary" "$destination"',
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
  const result = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true });
  const detected = result.status === 0 ? result.stdout?.trim() : '';
  if (detected) return detected;
  if (!process.env.USERNAME) throw new Error('Unable to determine the current Windows user.');
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
}

function windowsCommandLineArg(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function taskSchedulerScript(distro, wslUser, windowsUser) {
  const argumentsValue = `-d ${windowsCommandLineArg(distro)} -u ${windowsCommandLineArg(wslUser)} -e bash -lc "systemctl --user start runnerize"`;
  return [
    `$taskName = ${powershellLiteral(SERVICE_NAME)}`,
    `$user = ${powershellLiteral(windowsUser)}`,
    `$action = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument ${powershellLiteral(argumentsValue)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    '$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 10 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    'Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null',
  ].join('; ');
}

function isAccessDenied(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
  return /access (?:is )?denied|unauthorizedaccess|insufficient privilege|privilege.*not held|requires elevation|permission denied|0x80070005/i.test(output);
}

function writeStartupLauncher(distro, user) {
  const startupPath = windowsStartupPath();
  mkdirSync(dirname(startupPath), { recursive: true });
  const command = `wsl.exe -d "${distro.replaceAll('"', '""')}" -u "${user.replaceAll('"', '""')}" -e bash -lc "systemctl --user start runnerize"`;
  writeFileSync(startupPath, `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\r\n`);
  return startupPath;
}

function installLogonTrigger(distro, user) {
  const windowsUser = currentWindowsUser();
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    taskSchedulerScript(distro, user, windowsUser),
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    rmSync(windowsStartupPath(), { force: true });
    return { kind: 'Task Scheduler', detail: `task ${SERVICE_NAME} for ${windowsUser}` };
  }
  if (!isAccessDenied(result)) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit code ${result.status}`;
    throw new Error(`Failed to register Task Scheduler task ${SERVICE_NAME}: ${detail}`);
  }
  return { kind: 'Startup folder fallback', detail: writeStartupLauncher(distro, user) };
}

function installWindows() {
  const context = resolveWslContext();
  console.log(`WSL distro: ${context.distro} (user ${context.user})`);
  const runtime = preflightWsl(context);
  console.log(`Container runtime: ${runtime}`);
  console.log('GitHub authentication: available');
  const node = ensureWslNode(context);
  console.log(`Linux Node: ${node.path} (${node.version}${node.downloaded ? ', installed and checksum-verified' : ', reused'})`);
  const installation = materializeRunnerize(context);
  console.log(`runnerize package: ${installation.root}`);
  wslRun(context.distro, context.user, [node.path, installation.bin, 'service', 'install']);
  console.log('systemd user service: installed and enabled');
  wslRun(context.distro, context.user, ['loginctl', 'enable-linger', context.user]);
  console.log(`User lingering: enabled for ${context.user}`);
  const trigger = installLogonTrigger(context.distro, context.user);
  console.log(`Windows logon trigger: ${trigger.kind} (${trigger.detail})`);
  console.log(`View logs: wsl.exe -d ${context.distro} -u ${context.user} -e journalctl --user -u runnerize -f`);
  console.log('Uninstall: runnerize service uninstall');
}

function bestEffort(command, args) {
  spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
}

function uninstallWindows() {
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
    if (nodePath) bestEffort('wsl.exe', wslArgs(context.distro, context.user, [nodePath, `${installation}/bin/runnerize.js`, 'service', 'uninstall']));
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, ['rm', '-rf', installation, `${context.home}/.cache/runnerize/node`]));
  }

  const script = `Get-ScheduledTask -TaskName ${powershellLiteral(SERVICE_NAME)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`;
  bestEffort('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  rmSync(windowsStartupPath(), { force: true });
  console.log('Removed the WSL systemd service, Windows logon trigger, package copy, and Node cache where present.');
}

export async function installService() {
  if (platform() === 'darwin') return installLaunchd();
  if (platform() === 'win32') return installWindows();
  if (!commandExists('systemctl')) {
    throw new Error('systemd is required to install runnerize as a Linux/WSL service.');
  }
  return installSystemd();
}

export async function uninstallService() {
  if (platform() === 'darwin') return uninstallLaunchd();
  if (platform() === 'win32') return uninstallWindows();
  return uninstallSystemd();
}
