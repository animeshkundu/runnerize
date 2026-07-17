import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToken } from './github.js';
import { installGuard, uninstallGuard } from './guard.js';

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
const DEFAULT_MACOS_IMAGE = 'ghcr.io/cirruslabs/macos-sequoia-base:latest';
const HOMEBREW_INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const TART_INSTALL_COMMAND = 'brew install cirruslabs/cli/tart';
const MACOS_ENVIRONMENT_KEYS = [
  'RUNNERIZE_MACOS_IMAGE',
  'RUNNERIZE_MACOS_SSH_USER',
  'RUNNERIZE_MACOS_SSH_KEY',
  'RUNNERIZE_MACOS_RUNNER_DIR',
  'RUNNERIZE_MACOS_RUNNER_VERSION',
];
export const windowsPowerShellPath = join(
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
  // Capture and drain the child's output rather than inheriting the parent's stdio. An
  // inherited-stdio child (notably wsl.exe) left this process exiting via SIGSEGV (139) on
  // some runs; draining instead of inheriting avoids that. Echo the captured output so install
  // progress stays visible. (The Task Scheduler registration crash is a separate, unrelated
  // issue — see the comment on taskSchedulerScript.)
  const output = execFileSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
  if (output) process.stdout.write(output);
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

function printManualSteps(title, steps) {
  if (!steps.length) return;
  console.log(`\n${title}`);
  console.log('='.repeat(title.length));
  steps.forEach((step, index) => {
    console.log(`${index + 1}. ${step.why}`);
    console.log(`   ${step.command}`);
  });
  console.log('');
}

function windowsBuildNumber() {
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write([System.Environment]::OSVersion.Version.Build)',
  ], { timeout: PROBE_TIMEOUT_MS });
  const build = Number.parseInt(result.stdout?.trim(), 10);
  return result.status === 0 && Number.isInteger(build) ? build : null;
}

function nativeGitHubCredentialAvailable() {
  if (process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()) return true;
  const result = captureResult('gh', ['auth', 'token'], { timeout: PROBE_TIMEOUT_MS });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

async function installSystemd() {
  await preflightRun();
  const unitName = `${SERVICE_NAME}.service`;
  const wasActive = captureResult('systemctl', ['--user', 'is-active', '--quiet', unitName]).status === 0;
  const unitPath = join(homedir(), '.config', 'systemd', 'user', unitName);
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
ExecStart=${quoteSystemd(process.execPath)} ${quoteSystemd(binPath)} run${process.env.RUNNERIZE_SERVICE_RUN_ONLY ? ` --only ${process.env.RUNNERIZE_SERVICE_RUN_ONLY}` : ''}
${environmentFile}Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=infinity

[Install]
WantedBy=default.target
`, { mode: 0o644 });

  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', unitName]);
  if (wasActive) {
    console.log('Restarting the running dispatcher to load the new version…');
    run('systemctl', ['--user', 'restart', unitName]);
  } else {
    run('systemctl', ['--user', 'start', unitName]);
  }
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

function tartImageAvailable(image) {
  if (!image) return false;
  const result = captureResult('tart', ['list', '--format', 'json'], { timeout: PROBE_TIMEOUT_MS });
  if (result.status !== 0) return false;
  try {
    const listed = JSON.parse(result.stdout);
    const images = Array.isArray(listed) ? listed : listed.vms ?? listed.VMs ?? [];
    return images.some((entry) => {
      if (typeof entry === 'string') return entry === image;
      const name = entry.Name ?? entry.name;
      const source = entry.Source ?? entry.source;
      return name === image || source === image;
    });
  } catch {
    return result.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/).includes(image));
  }
}

async function auditMacosPrerequisites() {
  const manualSteps = [];
  let tartReady = process.arch === 'arm64';

  if (!tartReady) {
    manualSteps.push({
      why: 'The native macOS backend requires Apple Silicon; this Mac can still serve Linux-container jobs.',
      command: 'uname -m  # tart requires arm64',
    });
  } else if (!commandExists('tart')) {
    if (commandExists('brew')) {
      console.log('tart was not found; installing it with Homebrew...');
      try {
        run('brew', ['install', 'cirruslabs/cli/tart'], { timeout: INSTALL_TIMEOUT_MS });
        tartReady = commandExists('tart');
      } catch (error) {
        tartReady = false;
        console.warn(`tart could not be installed automatically: ${error.message}`);
      }
    } else {
      tartReady = false;
      manualSteps.push({
        why: 'Install Homebrew; runnerize uses it to install tart without sudo.',
        command: HOMEBREW_INSTALL_COMMAND,
      });
    }
    if (!tartReady) {
      manualSteps.push({
        why: 'Install the tart CLI for disposable macOS virtual machines.',
        command: TART_INSTALL_COMMAND,
      });
    }
  }

  const image = process.env.RUNNERIZE_MACOS_IMAGE;
  const imageReady = Boolean(image && tartReady && tartImageAvailable(image));
  if (!imageReady) {
    const selected = image || DEFAULT_MACOS_IMAGE;
    manualSteps.push({
      why: 'Choose and pull a tart base image. This is a large one-time download; baking actions-runner into it makes jobs faster.',
      command: `export RUNNERIZE_MACOS_IMAGE=${selected} && tart pull "$RUNNERIZE_MACOS_IMAGE"`,
    });
  }
  manualSteps.push({
    why: 'Confirm the base image accepts SSH and configure non-default credentials when needed.',
    command: 'export RUNNERIZE_MACOS_SSH_USER=admin  # optionally export RUNNERIZE_MACOS_SSH_KEY=~/.ssh/id_ed25519',
  });
  if (!nativeGitHubCredentialAvailable()) {
    manualSteps.push({
      why: 'Authenticate the GitHub CLI interactively, or set GH_TOKEN/GITHUB_TOKEN.',
      command: 'gh auth login',
    });
  }

  printManualSteps('macOS setup steps', manualSteps);
  return { tartReady, imageReady };
}

function launchdEnvironmentXml() {
  const entries = MACOS_ENVIRONMENT_KEYS
    .filter((key) => process.env[key])
    .map((key) => `    <key>${key}</key><string>${xmlEscape(process.env[key])}</string>`);
  if (!entries.length) return '';
  return `  <key>EnvironmentVariables</key>\n  <dict>\n${entries.join('\n')}\n  </dict>\n`;
}

async function installLaunchd() {
  const audit = await auditMacosPrerequisites();
  let runnable = false;
  try {
    await preflightRun();
    runnable = true;
  } catch (error) {
    if (audit.tartReady && audit.imageReady) {
      if (!nativeGitHubCredentialAvailable()) throw error;
      runnable = true;
      console.warn(`Linux backend unavailable: ${error.message}`);
    } else {
      throw error;
    }
  }
  if (!runnable) throw new Error('No runnerize backend is available on this macOS host.');
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
${launchdEnvironmentXml()}  <key>ProcessType</key><string>Background</string>
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

export function powershellLiteral(value) {
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
  if (platform() === 'win32') {
    if (wantsLinux) {
      const context = resolveWslContext();
      runtime = ensureWslRuntime(context, { install });
    }
    if (wantsWindows && !commandExists('wsb.exe')) {
      throw new Error('Windows Sandbox is unavailable. Enable the Windows Sandbox optional feature and retry.');
    }
  } else if (wantsLinux) {
    runtime = nativeRuntime();
    if (!runtime) {
      throw new Error('No working rootless Podman or Docker runtime was found. Install Podman, verify `podman info`, then rerun this command.');
    }
  }

  try {
    await getToken();
  } catch {
    throw new Error(`GitHub authentication is not available.\n${GITHUB_AUTH_GUIDANCE}`);
  }
  console.log(`Prerequisites ready: ${runtime ? `container runtime ${runtime}; ` : ''}GitHub credential available.`);
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

function windowsDataPath(...parts) {
  return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'runnerize', ...parts);
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

export function systemStartupTaskScript(spec) {
  const registration = [
    `$taskName = ${powershellLiteral(spec.taskName)}`,
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(spec.execute)} -Argument ${powershellLiteral(spec.argument)}`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    '$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\\SYSTEM" -LogonType ServiceAccount -RunLevel Highest',
    '$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    'Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null',
  ].join('; ');
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; ${registration}`, 'utf16le').toString('base64');
  // Isolate the CIM-backed ScheduledTasks cmdlets in their own PowerShell process. Commands
  // appended after them can crash Windows PowerShell while it exits on affected hosts.
  return `& ${powershellLiteral(windowsPowerShellPath)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${powershellLiteral(encoded)}; if ($LASTEXITCODE -ne 0) { throw 'Scheduled task registration failed' }`;
}

function taskSchedulerScript(spec, windowsUser) {
  // Deliberately does NOT remove the Startup-folder fallback file here (the caller already
  // does that via rmSync once it sees the registration succeed). A trailing Remove-Item run
  // in the same PowerShell process right after Register-ScheduledTask/Get-ScheduledTask (the
  // ScheduledTasks module's CIM-backed cmdlets) reliably crashes this powershell.exe on exit:
  // signal-less, code-less, output-less non-zero exit, even though the task registration
  // itself already succeeded. Reproduced deterministically with no WSL involvement at all;
  // reordering Remove-Item before the CIM cmdlets, or dropping it entirely and cleaning up in
  // Node instead, avoids the crash. See installLogonTrigger's rmSync calls for the real cleanup.
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

export async function runElevated(operation, command, { timeoutMs = ELEVATION_TIMEOUT_MS } = {}) {
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

async function auditWindowsPrerequisites({ noElevate = false, elevationTimeoutMs } = {}) {
  const manualSteps = [];
  const enabled = [];
  let rebootRequired = false;

  if (!commandExists('wsb.exe')) {
    const build = windowsBuildNumber();
    if (build !== null && build >= 26100) {
      const command = "Enable-WindowsOptionalFeature -Online -FeatureName 'Containers-DisposableClientVM' -All -NoRestart | Out-Null";
      if (noElevate) {
        manualSteps.push({
          why: 'Enable Windows Sandbox from an Administrator PowerShell, then restart Windows.',
          command,
        });
      } else {
        console.log('Administrator access is needed to enable the Windows Sandbox feature.');
        console.log('A UAC prompt will appear. Approve it to enable the native Windows backend.');
        const result = await runElevated('enable Windows Sandbox', command, { timeoutMs: elevationTimeoutMs });
        if (result.ok) {
          enabled.push('Windows Sandbox');
          rebootRequired = true;
        } else {
          console.warn(`Windows Sandbox could not be enabled automatically: ${result.reason}`);
          manualSteps.push({
            why: 'Enable Windows Sandbox from an Administrator PowerShell, then restart Windows.',
            command,
          });
        }
      }
    } else {
      manualSteps.push({
        why: build === null
          ? 'Windows Sandbox was not found and the Windows build could not be detected. The native backend requires Windows 11 24H2 or newer.'
          : `The native backend requires Windows 11 24H2 (build 26100) or newer. This host is build ${build}.`,
        command: 'Settings > Windows Update > Check for updates',
      });
    }
  }

  let wslAvailable = true;
  try {
    resolveWslDistro();
  } catch {
    wslAvailable = false;
  }
  if (!wslAvailable) {
    const command = 'wsl --install -d Ubuntu';
    if (noElevate) {
      manualSteps.push({
        why: 'Install WSL2 and Ubuntu from an Administrator PowerShell, then restart Windows.',
        command,
      });
    } else {
      console.log('Administrator access is needed to install WSL2 and Ubuntu.');
      console.log('A UAC prompt will appear. Approve it to enable the Linux backend.');
      const result = await runElevated('install WSL2 and Ubuntu', command, { timeoutMs: elevationTimeoutMs });
      if (result.ok) {
        enabled.push('WSL2 and Ubuntu');
        rebootRequired = true;
      } else {
        console.warn(`WSL2 and Ubuntu could not be installed automatically: ${result.reason}`);
        manualSteps.push({
          why: 'Install WSL2 and Ubuntu from an Administrator PowerShell, then restart Windows.',
          command,
        });
      }
    }
  }

  if (!nativeGitHubCredentialAvailable()) {
    manualSteps.push({
      why: 'Authenticate the GitHub CLI interactively, or set GH_TOKEN/GITHUB_TOKEN, then rerun the installer.',
      command: 'gh auth login',
    });
  }

  printManualSteps('Manual steps', manualSteps);
  if (rebootRequired) {
    printManualSteps('Restart required', [
      {
        why: `Restart Windows to finish enabling ${enabled.join(' and ')}.`,
        command: 'Restart-Computer',
      },
      {
        why: 'Run the installer again after signing in to finish setup.',
        command: 'npx runnerize service install',
      },
    ]);
  }
  return { rebootRequired };
}

function scheduledTaskIsRunning(taskName) {
  const script = `$task = Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue; if ($null -eq $task -or $task.State -ne 'Running') { exit 1 }`;
  return captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]).status === 0;
}

function deferScheduledTaskRestart(taskName) {
  console.warn(`${taskName} is running; Windows Task Scheduler cannot signal a graceful drain. The new version will load after the dispatcher next exits or the host restarts.`);
}

function scheduledTaskPrincipal(taskName) {
  const script = `$task = Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue; if ($null -eq $task) { exit 1 }; [Console]::Out.Write($task.Principal.UserId)`;
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function scheduledTaskMatchesSpec(spec) {
  // Confirms the registered task is actually THIS spec's task (not merely a same-named leftover
  // from something else): compares the action's Execute/Arguments against what we asked for.
  // Deliberately avoids comparing Principal.UserId against the SID passed to -UserId — Task
  // Scheduler normalizes that property to a friendly account name on readback, so a SID
  // comparison never matches even for a correctly-registered task.
  const script = [
    `$task = Get-ScheduledTask -TaskName ${powershellLiteral(spec.taskName)} -ErrorAction SilentlyContinue`,
    'if ($null -eq $task) { exit 1 }',
    '$a = $task.Actions | Select-Object -First 1',
    `if ($a.Execute -eq ${powershellLiteral(spec.execute)} -and $a.Arguments -eq ${powershellLiteral(spec.argument)}) { exit 0 } else { exit 1 }`,
  ].join('; ');
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  return result.status === 0;
}

async function installLogonTrigger(spec, { noElevate = false, elevationTimeoutMs } = {}) {
  const windowsUser = currentWindowsUser();
  const script = taskSchedulerScript(spec, windowsUser);
  console.log(`Registering logon task ${spec.taskName}...`);
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerAttemptScript(script),
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status === 0) {
    rmSync(windowsStartupPath(spec.startupFileName), { force: true });
    console.log('Registered auto-start task.');
    return { kind: 'Task Scheduler', detail: `task ${spec.taskName} for ${windowsUser}` };
  }
  if (!isAccessDenied(result)) {
    // The powershell child can still register the task successfully and then die on its own
    // way out (a silent, signal-less non-zero exit with empty stdout/stderr), which otherwise
    // gets misreported as a registration failure. Confirm against Task Scheduler itself before
    // giving up — a fresh powershell.exe running only Get-ScheduledTask doesn't hit that crash.
    // Compares the actual registered action, not just existence (a stale same-named task with
    // different content shouldn't be mistaken for success) or an identity-string match (Task
    // Scheduler normalizes $task.Principal.UserId to a friendly account name on readback even
    // when a SID was passed to -UserId, so comparing it back against currentWindowsUser()'s SID
    // never matches).
    if (scheduledTaskMatchesSpec(spec)) {
      rmSync(windowsStartupPath(spec.startupFileName), { force: true });
      console.log('Registered auto-start task.');
      return { kind: 'Task Scheduler', detail: `task ${spec.taskName} for ${windowsUser}` };
    }
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit code ${result.status}`;
    throw new Error(`Failed to register Task Scheduler task ${spec.taskName}: ${detail}`);
  }

  if (!noElevate) {
    console.log(`Administrator access is needed to register the ${spec.taskName} auto-start task.`);
    console.log('A UAC prompt will appear. Approve it for Task Scheduler; declining uses a login-only Startup entry.');
    const elevated = await runElevated('install', script, { timeoutMs: elevationTimeoutMs });
    if (elevated.ok) {
      // Same action-content confirmation as above, for the same reasons.
      if (scheduledTaskMatchesSpec(spec)) {
        rmSync(windowsStartupPath(spec.startupFileName), { force: true });
        console.log('Registered auto-start task (elevated).');
        return { kind: 'Task Scheduler (elevated)', detail: `task ${spec.taskName} for ${windowsUser}` };
      }
      console.warn(`Elevated task registration could not be confirmed for ${windowsUser}.`);
    } else {
      console.warn(`Elevated task registration did not complete: ${elevated.reason}`);
      if (elevated.reason === 'elevation prompt was not answered') {
        throw new Error(`Task registration for ${spec.taskName} timed out. Rerun the install after the elevation prompt closes; no Startup fallback was written because the elevated task may still complete.`);
      }
      printManualSteps('Administrator step declined or unavailable', [{
        why: 'The installer will use a login-only Startup entry. Rerun this command later to retry Task Scheduler registration.',
        command: 'npx runnerize service install',
      }]);
    }
  }

  if (scheduledTaskPrincipal(spec.taskName) !== null) {
    rmSync(windowsStartupPath(spec.startupFileName), { force: true });
    return { kind: 'Task Scheduler', detail: `existing task ${spec.taskName}` };
  }
  console.log('Falling back to a Startup-folder entry (login-only, no auto-restart).');
  return { kind: 'Startup folder fallback', detail: writeStartupLauncher(spec) };
}

function wslTriggerSpec(context) {
  const argument = `-d ${windowsCommandLineArg(context.distro)} -u ${windowsCommandLineArg(context.user)} -e bash -lc ${windowsCommandLineArg(systemdStartCommand())}`;
  return {
    taskName: SERVICE_NAME,
    startupFileName: 'runnerize.vbs',
    execute: 'wsl.exe',
    argument,
    startupCommand: `wsl.exe ${argument}`,
  };
}

function materializeWindowsApp() {
  const root = windowsDataPath();
  const destination = join(root, 'app');
  const temporary = join(root, `app.new.${process.pid}`);
  const old = join(root, `app.old.${process.pid}`);
  mkdirSync(root, { recursive: true });
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  for (const entry of ['bin', 'src', 'package.json']) {
    cpSync(join(packageRoot, entry), join(temporary, entry), { recursive: true });
  }
  rmSync(old, { recursive: true, force: true });
  if (existsSync(destination)) renameSync(destination, old);
  try {
    renameSync(temporary, destination);
  } catch (error) {
    if (existsSync(old)) renameSync(old, destination);
    throw error;
  }
  rmSync(old, { recursive: true, force: true });
  return { root: destination, bin: join(destination, 'bin', 'runnerize.js') };
}

function persistWindowsTokenIfNeeded() {
  const envToken = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!envToken) return false;
  const gh = captureResult('gh', ['auth', 'token'], { timeout: PROBE_TIMEOUT_MS });
  if (gh.status === 0 && gh.stdout.trim()) return false;
  const tokenPath = windowsDataPath('windows.token');
  mkdirSync(dirname(tokenPath), { recursive: true });
  const script = `$ErrorActionPreference = 'Stop'; $secure = ConvertTo-SecureString $env:RUNNERIZE_INSTALL_TOKEN -AsPlainText -Force; ConvertFrom-SecureString $secure | Set-Content -LiteralPath ${powershellLiteral(tokenPath)}`;
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { env: { ...process.env, RUNNERIZE_INSTALL_TOKEN: envToken } });
  if (result.status !== 0) throw new Error('Could not protect the GitHub credential with Windows DPAPI.');
  console.log(`GitHub authentication: encrypted fallback credential stored at ${tokenPath}`);
  return true;
}

function writeWindowsLauncher({ keepAwake = true } = {}) {
  const launcherPath = windowsDataPath('runnerize-windows.ps1');
  const appBin = windowsDataPath('app', 'bin', 'runnerize.js');
  const logPath = windowsDataPath('runnerize-windows.log');
  mkdirSync(dirname(launcherPath), { recursive: true });
  // ES_SYSTEM_REQUIRED | ES_CONTINUOUS (0x80000001) and ES_CONTINUOUS (0x80000000) both have
  // their high bit set, so PowerShell parses the hex literal as a negative Int32 (its default
  // numeric type for a 32-bit-wide hex literal) rather than a UInt32 — which then fails to bind
  // to SetThreadExecutionState's `uint esFlags` P/Invoke parameter with a conversion error.
  // Parsing through Convert.ToUInt32 sidesteps the literal-typing quirk entirely.
  const wakeStart = keepAwake
    ? "Add-Type -Namespace Runnerize -Name Native -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'; [Runnerize.Native]::SetThreadExecutionState([Convert]::ToUInt32('80000001', 16)) | Out-Null"
    : '';
  const wakeStop = keepAwake ? "[Runnerize.Native]::SetThreadExecutionState([Convert]::ToUInt32('80000000', 16)) | Out-Null" : '';
  writeFileSync(launcherPath, `$ErrorActionPreference = 'Stop'\r\n$created = $false\r\n$mutex = [Threading.Mutex]::new($true, 'Local\\runnerize-windows', [ref]$created)\r\nif (-not $created) { $mutex.Dispose(); exit 0 }\r\ntry {\r\n  ${wakeStart}\r\n  $node = (Get-Command node.exe -ErrorAction Stop).Source\r\n  & $node ${powershellLiteral(appBin)} run --only windows *>> ${powershellLiteral(logPath)}\r\n} finally {\r\n  ${wakeStop}\r\n  $mutex.ReleaseMutex()\r\n  $mutex.Dispose()\r\n}\r\n`);
  return launcherPath;
}

function windowsTriggerSpec(launcherPath) {
  const argument = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsCommandLineArg(launcherPath)}`;
  return {
    taskName: 'runnerize-windows',
    startupFileName: 'runnerize-windows.vbs',
    execute: powershellPath,
    argument,
    startupCommand: `${windowsCommandLineArg(powershellPath)} ${argument}`,
  };
}

function wslKeepAwakeSpec(context) {
  const launcherPath = windowsDataPath('runnerize-wsl-keepawake.ps1');
  const activeArgs = `-d ${windowsCommandLineArg(context.distro)} -u ${windowsCommandLineArg(context.user)} -e bash -lc ${windowsCommandLineArg('export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active --quiet runnerize')}`;
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, `$ErrorActionPreference = 'SilentlyContinue'\r\nAdd-Type -Namespace Runnerize -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'\r\n[Runnerize.Native]::SetThreadExecutionState([Convert]::ToUInt32('80000001', 16)) | Out-Null\r\ntry { while ($true) { & wsl.exe ${activeArgs}; if ($LASTEXITCODE -ne 0) { break }; Start-Sleep -Seconds 30 } } finally { [Runnerize.Native]::SetThreadExecutionState([Convert]::ToUInt32('80000000', 16)) | Out-Null }\r\n`);
  const argument = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsCommandLineArg(launcherPath)}`;
  return {
    taskName: 'runnerize-wsl-keepawake',
    startupFileName: 'runnerize-wsl-keepawake.vbs',
    execute: powershellPath,
    argument,
    startupCommand: `${windowsCommandLineArg(powershellPath)} ${argument}`,
  };
}

async function installWindows({ noElevate = false, elevationTimeoutMs, noGuard = false, installGuardOperation = installGuard } = {}) {
  const audit = await auditWindowsPrerequisites({ noElevate, elevationTimeoutMs });
  if (audit.rebootRequired) return;

  const statuses = [];
  let context;
  let linuxInstalled = false;
  let windowsInstalled = false;
  let linuxError;
  try {
    context = resolveWslContext();
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
    const serviceEnvironment = ['env', 'RUNNERIZE_SERVICE_RUN_ONLY=linux'];
    if (preflight.token) serviceEnvironment.push(`RUNNERIZE_SYSTEMD_ENV_FILE=${context.home}/.config/runnerize/.env`);
    const installCommand = [...serviceEnvironment, node.path, installation.bin, 'service', 'install'];
    wslRun(context.distro, context.user, systemdWslArgs(installCommand));
    const trigger = await installLogonTrigger(wslTriggerSpec(context), { noElevate, elevationTimeoutMs });
    console.log(`Linux logon trigger: ${trigger.kind} (${trigger.detail})`);
    linuxInstalled = true;
    statuses.push('linux=installed');
  } catch (error) {
    linuxError = error;
    console.warn(`Linux backend unavailable: ${error.message}`);
    statuses.push('linux=unavailable');
  }

  if (commandExists('wsb.exe')) {
    try {
      await getToken();
      const windowsTaskName = 'runnerize-windows';
      const wasRunning = scheduledTaskIsRunning(windowsTaskName);
      const installation = materializeWindowsApp();
      persistWindowsTokenIfNeeded();
      const launcher = writeWindowsLauncher();
      const trigger = await installLogonTrigger(windowsTriggerSpec(launcher), { noElevate, elevationTimeoutMs });
      if (wasRunning) deferScheduledTaskRestart(windowsTaskName);
      console.log(`Windows logon trigger: ${trigger.kind} (${trigger.detail})`);
      console.log(`Windows dispatcher log: ${windowsDataPath('runnerize-windows.log')}`);
      console.log(`runnerize package: ${installation.root}`);
      windowsInstalled = true;
      statuses.push('windows=installed');
    } catch (error) {
      console.warn(`Windows backend unavailable: ${error.message}`);
      statuses.push('windows=unavailable');
    }
  } else {
    console.warn('Windows backend unavailable: wsb.exe was not found.');
    statuses.push('windows=unavailable');
  }

  if (!windowsInstalled && context && linuxInstalled) {
    const trigger = await installLogonTrigger(wslKeepAwakeSpec(context), { noElevate, elevationTimeoutMs });
    console.log(`WSL host keep-awake trigger: ${trigger.kind} (${trigger.detail})`);
  }

  console.log(`Backend summary: ${statuses.join(', ')}`);
  if (!statuses.some((status) => status.endsWith('=installed'))) {
    throw linuxError ?? new Error('No runnerize backend is available on this Windows host.');
  }
  if (!noGuard) {
    const manualSteps = [{
      why: 'Windows Update auto-restarts can reboot this guest and kill the dispatcher; the guard defers them and disables hibernation.',
      command: 'runnerize guard install',
    }];
    if (noElevate) {
      printManualSteps('Host-stability guard (recommended on a Hyper-V guest)', manualSteps);
    } else {
      try {
        await installGuardOperation({ elevationTimeoutMs });
      } catch (error) {
        console.warn(`Could not install the host-stability guard: ${error.message}`);
        printManualSteps('Host-stability guard (recommended on a Hyper-V guest)', manualSteps);
      }
    }
  }
  console.log('Uninstall: runnerize service uninstall');
}

function bestEffort(command, args) {
  spawnSync(command, args, { stdio: 'ignore', windowsHide: true });
}

async function uninstallWindows({ noElevate = false, elevationTimeoutMs, noGuard = false, uninstallGuardOperation = uninstallGuard } = {}) {
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

  for (const taskName of [SERVICE_NAME, 'runnerize-windows', 'runnerize-wsl-keepawake']) {
    const script = `Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop`;
    const taskRemoval = captureResult(powershellPath, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerAttemptScript(script),
    ], { encoding: 'utf8', windowsHide: true });
    if (taskRemoval.status !== 0 && isAccessDenied(taskRemoval)) {
      if (noElevate) {
        console.warn(`Could not remove the elevated ${taskName} task without administrator access. Remove it manually in Task Scheduler or rerun uninstall elevated.`);
      } else {
        console.log(`Task removal for ${taskName} needs administrator access — requesting elevation...`);
        const elevated = await runElevated('uninstall', script, { timeoutMs: elevationTimeoutMs });
        if (!elevated.ok) {
          console.warn(`Could not remove the elevated ${taskName} task: ${elevated.reason}. Remove it manually in Task Scheduler or rerun uninstall elevated.`);
        } else if (scheduledTaskPrincipal(taskName) === null) {
          console.log(`Removed auto-start task ${taskName} (elevated).`);
        } else {
          console.warn(`Elevated ${taskName} task removal could not be confirmed. Remove it manually in Task Scheduler or rerun uninstall elevated.`);
        }
      }
    } else if (taskRemoval.status !== 0) {
      const detail = taskRemoval.stderr?.trim() || taskRemoval.stdout?.trim() || taskRemoval.error?.message || `exit code ${taskRemoval.status}`;
      console.warn(`Could not remove the ${taskName} task: ${detail}. Remove it manually in Task Scheduler if it still exists.`);
    }
  }
  for (const fileName of ['runnerize.vbs', 'runnerize-windows.vbs', 'runnerize-wsl-keepawake.vbs']) {
    rmSync(windowsStartupPath(fileName), { force: true });
  }
  for (const artifact of ['app', 'runnerize-windows.ps1', 'runnerize-wsl-keepawake.ps1', 'windows.token', 'runnerize-windows.log']) {
    rmSync(windowsDataPath(artifact), { recursive: true, force: true });
  }
  if (!noGuard && !noElevate) {
    try {
      await uninstallGuardOperation({ elevationTimeoutMs });
    } catch (error) {
      console.warn(`Could not uninstall the host-stability guard: ${error.message}`);
    }
  }
  console.log('Removed the WSL systemd service, Windows logon triggers, package copies, credential, and logs where present.');
}

function elevationDisabled(options) {
  return Boolean(options.noElevate || process.env.RUNNERIZE_NO_ELEVATE);
}

export async function installService(options = {}) {
  if (platform() === 'darwin') return installLaunchd();
  if (platform() === 'win32') return installWindows({
    noElevate: elevationDisabled(options),
    elevationTimeoutMs: options.elevationTimeoutMs,
    noGuard: options.noGuard,
    installGuardOperation: options.installGuardOperation,
  });
  if (!commandExists('systemctl')) {
    throw new Error('systemd is required to install runnerize as a Linux/WSL service.');
  }
  return installSystemd();
}

export async function uninstallService(options = {}) {
  if (platform() === 'darwin') return uninstallLaunchd();
  if (platform() === 'win32') return uninstallWindows({
    noElevate: elevationDisabled(options),
    elevationTimeoutMs: options.elevationTimeoutMs,
    noGuard: options.noGuard,
    uninstallGuardOperation: options.uninstallGuardOperation,
  });
  return uninstallSystemd();
}
