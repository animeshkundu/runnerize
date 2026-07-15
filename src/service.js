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

function powershellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function cmdQuoted(value) {
  return `"${value.replaceAll('%', '%%')}"`;
}

function windowsPaths() {
  const installDir = join(process.env.LOCALAPPDATA ?? homedir(), SERVICE_NAME);
  const startupDir = join(
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
  return {
    installDir,
    launcherPath: join(installDir, 'runnerize-launch.cmd'),
    logPath: join(installDir, 'runnerize.log'),
    startupDir,
    startupPath: join(startupDir, 'runnerize.vbs'),
  };
}

function writeWindowsLauncher(paths) {
  mkdirSync(paths.installDir, { recursive: true });
  const repoPath = dirname(dirname(binPath));
  writeFileSync(paths.launcherPath, `@echo off\r\ncd /d ${cmdQuoted(repoPath)}\r\n${cmdQuoted(process.execPath)} ${cmdQuoted(binPath)} run >> ${cmdQuoted(paths.logPath)} 2>&1\r\n`);
}

function currentWindowsUser() {
  const result = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true });
  const detected = result.status === 0 ? result.stdout?.trim() : '';
  if (detected) return detected;
  const username = process.env.USERNAME;
  if (!username) throw new Error('Unable to determine the current Windows user.');
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${username}` : username;
}

function taskSchedulerScript(launcherPath, user) {
  const taskName = powershellLiteral(SERVICE_NAME);
  const actionCommand = `& '${launcherPath.replaceAll("'", "''")}'; exit $LASTEXITCODE`;
  const actionArguments = `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${actionCommand}"`;
  return [
    `$taskName = ${taskName}`,
    `$user = ${powershellLiteral(user)}`,
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${powershellLiteral(actionArguments)}`,
    '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 10 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    'Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null',
    'Start-ScheduledTask -TaskName $taskName -ErrorAction Stop',
  ].join('; ');
}

function isAccessDenied(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.message ?? ''}`;
  return /access (?:is )?denied|unauthorizedaccess|insufficient privilege|privilege.*not held|requires elevation|permission denied|0x80070005/i.test(output);
}

function writeStartupLauncher(paths) {
  mkdirSync(paths.startupDir, { recursive: true });
  const launcher = paths.launcherPath.replaceAll('"', '""');
  writeFileSync(
    paths.startupPath,
    `CreateObject("WScript.Shell").Run """${launcher}""", 0, False\r\n`,
  );
}

function installWindows() {
  const paths = windowsPaths();
  writeWindowsLauncher(paths);

  const user = currentWindowsUser();
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerScript(paths.launcherPath, user)],
    { encoding: 'utf8', windowsHide: true },
  );

  if (result.status === 0) {
    rmSync(paths.startupPath, { force: true });
    console.log(`Installed and started Task Scheduler task ${SERVICE_NAME} for ${user}.`);
    console.log(`Verify: Get-ScheduledTask -TaskName ${SERVICE_NAME}`);
    console.log('Uninstall: runnerize service uninstall');
    console.log(`Logs: ${paths.logPath}`);
    return;
  }

  if (!isAccessDenied(result)) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit code ${result.status}`;
    throw new Error(`Failed to register Task Scheduler task ${SERVICE_NAME}: ${detail}`);
  }

  writeStartupLauncher(paths);
  console.log('Task Scheduler registration was denied; installed the user Startup-folder fallback.');
  console.log('It starts at logon and does not automatically restart after a crash.');
  console.log(`Verify: ${paths.startupPath}`);
  console.log('Uninstall: runnerize service uninstall');
  console.log(`Logs: ${paths.logPath}`);
}

function uninstallWindows() {
  const paths = windowsPaths();
  const taskName = powershellLiteral(SERVICE_NAME);
  const script = `Get-ScheduledTask -TaskName ${taskName} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false`;
  spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'ignore', windowsHide: true },
  );
  rmSync(paths.startupPath, { force: true });
  rmSync(paths.launcherPath, { force: true });
  console.log(`Removed Task Scheduler task and Startup launcher for ${SERVICE_NAME} (when present).`);
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
