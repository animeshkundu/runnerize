import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_NAME = 'runnerize';
const binPath = fileURLToPath(new URL('../bin/runnerize.js', import.meta.url));

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

function installWindows() {
  if (!commandExists('nssm.exe')) {
    throw new Error(
      'Windows service installation requires nssm.exe on PATH. Install NSSM, then rerun `runnerize service install`.',
    );
  }

  const logDir = join(process.env.LOCALAPPDATA ?? homedir(), 'runnerize');
  mkdirSync(logDir, { recursive: true });
  spawnSync('nssm.exe', ['stop', SERVICE_NAME], { stdio: 'ignore' });
  spawnSync('nssm.exe', ['remove', SERVICE_NAME, 'confirm'], { stdio: 'ignore' });
  run('nssm.exe', ['install', SERVICE_NAME, process.execPath, `"${binPath}" run`]);
  run('nssm.exe', ['set', SERVICE_NAME, 'Start', 'SERVICE_AUTO_START']);
  run('nssm.exe', ['set', SERVICE_NAME, 'AppExit', 'Default', 'Restart']);
  run('nssm.exe', ['set', SERVICE_NAME, 'AppStdout', join(logDir, 'runnerize.log')]);
  run('nssm.exe', ['set', SERVICE_NAME, 'AppStderr', join(logDir, 'runnerize.log')]);
  run('nssm.exe', ['start', SERVICE_NAME]);
  console.log(`Installed and started Windows service ${SERVICE_NAME}.`);
  console.log(`View status: sc.exe query ${SERVICE_NAME}`);
}

function uninstallWindows() {
  if (!commandExists('nssm.exe')) {
    throw new Error('Uninstall requires nssm.exe on PATH (the same tool used to install the service).');
  }
  spawnSync('nssm.exe', ['stop', SERVICE_NAME], { stdio: 'inherit' });
  run('nssm.exe', ['remove', SERVICE_NAME, 'confirm']);
  console.log(`Removed Windows service ${SERVICE_NAME}.`);
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
