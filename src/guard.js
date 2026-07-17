import { spawn } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { powershellLiteral, runElevated, systemStartupTaskScript, windowsPowerShellPath } from './service.js';

const WINDOWS_UPDATE_KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';
const AU_KEY = `${WINDOWS_UPDATE_KEY}\\AU`;
const POWER_KEY = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power';
const DEFAULT_ACTIVE_HOURS = '6-0';
const PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_LEASE_TIMEOUT_MS = 20_000;
const DEFAULT_RECOVERY_GRACE_MS = 30_000;
const WATCH_TASK = 'runnerize-guard-watch';
const RECOVER_TASK = 'runnerize-guard-recover';
const binPath = fileURLToPath(new URL('../bin/runnerize.js', import.meta.url));
const packageRoot = dirname(dirname(binPath));

function guardRoot() {
  return join(process.env.ProgramData || 'C:\\ProgramData', 'runnerize', 'guard');
}

function tier1StatePath() {
  return join(guardRoot(), 'tier1-state.json');
}

function shutdownStatePath() {
  return join(guardRoot(), 'state.json');
}

function leasesPath() {
  return join(guardRoot(), 'leases');
}

function captureSpawn(command, args, { spawnChild = spawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawnChild(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on?.('data', (chunk) => { stdout += chunk; });
    child.stderr?.on?.('data', (chunk) => { stderr += chunk; });
    child.on?.('error', (error) => finish({ status: 1, stdout, stderr, error }));
    child.on?.('close', (status) => finish({ status: status ?? 1, stdout, stderr }));
    timer = setTimeout(() => {
      child.kill?.();
      finish({ status: 1, stdout, stderr, error: new Error('PowerShell probe timed out') });
    }, timeoutMs);
    timer.unref?.();
  });
}

async function capturePowerShell(script, options) {
  return captureSpawn(windowsPowerShellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], options);
}

export async function isHyperVGuest(options = {}) {
  if ((options.platformName ?? platform()) !== 'win32') return false;
  const script = "$c = Get-CimInstance Win32_ComputerSystem; [Console]::Out.Write((($c.Model -eq 'Virtual Machine') -and ($c.Manufacturer -like '*Microsoft*') -and [bool]$c.HypervisorPresent).ToString().ToLowerInvariant())";
  const result = await capturePowerShell(script, options);
  return result.status === 0 && result.stdout.trim().toLowerCase() === 'true';
}

function activeHours(value = process.env.RUNNERIZE_GUARD_ACTIVE_HOURS || DEFAULT_ACTIVE_HOURS) {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(value);
  const start = Number(match?.[1]);
  const end = Number(match?.[2]);
  if (!match || start > 23 || end > 23 || start === end) {
    throw new Error('RUNNERIZE_GUARD_ACTIVE_HOURS must be two different hours from 0-23, such as 6-0.');
  }
  return { start, end };
}

function stateCaptureScript(path) {
  return [
    `$statePath = ${powershellLiteral(path)}`,
    'if (-not (Test-Path -LiteralPath $statePath)) {',
    `  $settings = @(@{ path = ${powershellLiteral(AU_KEY)}; name = 'NoAutoRebootWithLoggedOnUsers' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'SetActiveHours' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'ActiveHoursStart' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'ActiveHoursEnd' })`,
    '  $captured = foreach ($setting in $settings) {',
    '    $key = Get-Item -LiteralPath $setting.path -ErrorAction SilentlyContinue',
    '    $exists = $null -ne $key -and $null -ne $key.GetValue($setting.name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)',
    '    if ($exists) { [pscustomobject]@{ path = $setting.path; name = $setting.name; existed = $true; data = $key.GetValue($setting.name); kind = $key.GetValueKind($setting.name).ToString() } } else { [pscustomobject]@{ path = $setting.path; name = $setting.name; existed = $false; data = $null; kind = $null } }',
    '  }',
    `  $power = Get-Item -LiteralPath ${powershellLiteral(POWER_KEY)} -ErrorAction SilentlyContinue`,
    "  $hibernateOn = $null -ne $power -and [int]$power.GetValue('HibernateEnabled', 0) -ne 0",
    '  $state = [pscustomobject]@{ version = 1; settings = @($captured); hibernateOn = $hibernateOn }',
    '  New-Item -ItemType Directory -Path (Split-Path -Parent $statePath) -Force | Out-Null',
    '  $json = $state | ConvertTo-Json -Depth 5',
    '  [System.IO.File]::WriteAllText($statePath, $json, [System.Text.UTF8Encoding]::new($false))',
    '}',
  ].join('\r\n');
}

function applyScript(path, { start, end }) {
  return [
    stateCaptureScript(path),
    `New-Item -Path ${powershellLiteral(AU_KEY)} -Force | Out-Null`,
    `New-ItemProperty -Path ${powershellLiteral(AU_KEY)} -Name 'NoAutoRebootWithLoggedOnUsers' -PropertyType DWord -Value 1 -Force | Out-Null`,
    `New-Item -Path ${powershellLiteral(WINDOWS_UPDATE_KEY)} -Force | Out-Null`,
    `New-ItemProperty -Path ${powershellLiteral(WINDOWS_UPDATE_KEY)} -Name 'SetActiveHours' -PropertyType DWord -Value 1 -Force | Out-Null`,
    `New-ItemProperty -Path ${powershellLiteral(WINDOWS_UPDATE_KEY)} -Name 'ActiveHoursStart' -PropertyType DWord -Value ${start} -Force | Out-Null`,
    `New-ItemProperty -Path ${powershellLiteral(WINDOWS_UPDATE_KEY)} -Name 'ActiveHoursEnd' -PropertyType DWord -Value ${end} -Force | Out-Null`,
    '& powercfg.exe /hibernate off',
    "if ($LASTEXITCODE -ne 0) { throw 'powercfg /hibernate off failed' }",
  ].join('\r\n');
}

function restoreScript(path) {
  return [
    `$statePath = ${powershellLiteral(path)}`,
    'if (Test-Path -LiteralPath $statePath) {',
    '  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json',
    `  $expected = @(@{ path = ${powershellLiteral(AU_KEY)}; name = 'NoAutoRebootWithLoggedOnUsers' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'SetActiveHours' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'ActiveHoursStart' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'ActiveHoursEnd' })`,
    '  foreach ($target in $expected) {',
    '    $setting = $state.settings | Where-Object { $_.path -eq $target.path -and $_.name -eq $target.name } | Select-Object -First 1',
    "    if ($null -eq $setting) { throw ('Saved guard state is missing ' + $target.name) }",
    '    if ($setting.existed) {',
    "      if ($setting.kind -notin @('String', 'ExpandString', 'Binary', 'DWord', 'MultiString', 'QWord')) { throw ('Saved guard state has an invalid registry kind for ' + $target.name) }",
    '      New-Item -Path $target.path -Force | Out-Null',
    '      New-ItemProperty -Path $target.path -Name $target.name -PropertyType $setting.kind -Value $setting.data -Force | Out-Null',
    '    } else { Remove-ItemProperty -LiteralPath $target.path -Name $target.name -ErrorAction SilentlyContinue }',
    '  }',
    '  if ($state.hibernateOn) { & powercfg.exe /hibernate on; if ($LASTEXITCODE -ne 0) { throw \'powercfg /hibernate on failed\' } }',
    '  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue',
    '}',
  ].join('\r\n');
}

function taskSpec(taskName, command, options = {}) {
  const quote = (value) => `"${value.replaceAll('"', '\\"')}"`;
  const root = options.guardAppRoot ?? join(guardRoot(), 'app');
  return { taskName, execute: process.execPath, argument: `${quote(join(root, 'bin', 'runnerize.js'))} ${command}` };
}

function copyShutdownGuardAppScript(options = {}) {
  const root = options.guardAppRoot ?? join(guardRoot(), 'app');
  const source = options.packageRoot ?? packageRoot;
  return [
    `New-Item -ItemType Directory -Path ${powershellLiteral(root)} -Force | Out-Null`,
    `Copy-Item -LiteralPath ${powershellLiteral(join(source, 'bin'))} -Destination ${powershellLiteral(root)} -Recurse -Force`,
    `Copy-Item -LiteralPath ${powershellLiteral(join(source, 'src'))} -Destination ${powershellLiteral(root)} -Recurse -Force`,
    `Copy-Item -LiteralPath ${powershellLiteral(join(source, 'package.json'))} -Destination ${powershellLiteral(root)} -Force`,
  ].join('\r\n');
}

export function shutdownGuardInstallScript(options = {}) {
  const root = options.guardRoot ?? guardRoot();
  const leases = options.leasesPath ?? join(root, 'leases');
  const state = options.shutdownStatePath ?? join(root, 'state.json');
  const watch = taskSpec(WATCH_TASK, 'guard-watch', options);
  const recover = taskSpec(RECOVER_TASK, 'guard-recover', options);
  return [
    copyShutdownGuardAppScript(options),
    `New-Item -ItemType Directory -Path ${powershellLiteral(leases)} -Force | Out-Null`,
    `$rootAcl = New-Object System.Security.AccessControl.DirectorySecurity`,
    `$rootAcl.SetAccessRuleProtection($true, $false)`,
    `$rootAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow')))`,
    `$rootAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl','ContainerInherit,ObjectInherit','None','Allow')))`,
    `$rootAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Authenticated Users','ReadAndExecute','None','None','Allow')))`,
    `Set-Acl -LiteralPath ${powershellLiteral(root)} -AclObject $rootAcl`,
    `$leaseAcl = New-Object System.Security.AccessControl.DirectorySecurity`,
    `$leaseAcl.SetAccessRuleProtection($true, $false)`,
    `$leaseAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('SYSTEM','FullControl','ContainerInherit,ObjectInherit','None','Allow')))`,
    `$leaseAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl','ContainerInherit,ObjectInherit','None','Allow')))`,
    `$leaseAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('Authenticated Users','ListDirectory,CreateFiles,ReadAttributes,ReadExtendedAttributes,ReadPermissions,Synchronize','None','None','Allow')))`,
    `$leaseAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule('CREATOR OWNER','Modify','ObjectInherit','InheritOnly','Allow')))`,
    `Set-Acl -LiteralPath ${powershellLiteral(leases)} -AclObject $leaseAcl`,
    `if (-not (Test-Path -LiteralPath ${powershellLiteral(state)})) { [System.IO.File]::WriteAllText(${powershellLiteral(state)}, '{"version":1,"service":null}', [System.Text.UTF8Encoding]::new($false)) }`,
    systemStartupTaskScript(watch),
    systemStartupTaskScript(recover),
    `& schtasks.exe /Run /TN ${powershellLiteral(WATCH_TASK)} | Out-Null`,
  ].join('\r\n');
}

function restoreShutdownServiceScript(path = shutdownStatePath()) {
  return [
    `$statePath = ${powershellLiteral(path)}`,
    'if (Test-Path -LiteralPath $statePath) {',
    '  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json',
    '  if ($null -ne $state.service) {',
    "    Set-Service -Name 'vmicshutdown' -StartupType $state.service.startupType",
    "    if ($state.service.wasRunning) { Start-Service -Name 'vmicshutdown' } else { Stop-Service -Name 'vmicshutdown' -Force -ErrorAction SilentlyContinue }",
    '  }',
    '}',
  ].join('\r\n');
}

export function shutdownGuardUninstallScript(options = {}) {
  const root = options.guardRoot ?? guardRoot();
  const state = options.shutdownStatePath ?? join(root, 'state.json');
  return [
    restoreShutdownServiceScript(state),
    `Get-ScheduledTask -TaskName ${powershellLiteral(WATCH_TASK)} -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue`,
    `Get-ScheduledTask -TaskName ${powershellLiteral(WATCH_TASK)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`,
    `Get-ScheduledTask -TaskName ${powershellLiteral(RECOVER_TASK)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`,
    `Remove-Item -LiteralPath ${powershellLiteral(root)} -Recurse -Force -ErrorAction SilentlyContinue`,
  ].join('\r\n');
}

async function requireSupportedHost(action, options) {
  const platformName = options.platformName ?? platform();
  if (platformName !== 'win32') {
    console.log(`Host-stability guard ${action}: NOOP (Windows Hyper-V guests only).`);
    return false;
  }
  if (!await isHyperVGuest(options)) {
    console.log(`Host-stability guard ${action}: NOOP (this host is not a Microsoft Hyper-V guest).`);
    return false;
  }
  return true;
}

export async function installGuard(options = {}) {
  if (!await requireSupportedHost('install', options)) return;
  const hours = activeHours(options.activeHours);
  const scripts = [applyScript(options.statePath ?? tier1StatePath(), hours)];
  if (options.shutdownGuard) scripts.push(shutdownGuardInstallScript(options));
  console.log('Administrator access is needed to apply the host-stability guard.');
  console.log('A UAC prompt will appear. Approve it to update Windows Update and power settings.');
  const result = await (options.runElevatedOperation ?? runElevated)(
    'install host-stability guard', scripts.join('\r\n'), { timeoutMs: options.elevationTimeoutMs },
  );
  if (!result.ok) throw new Error(`Host-stability guard could not be installed: ${result.reason}`);
  console.log(`Host-stability guard installed (active hours ${hours.start}:00-${hours.end}:00; hibernate off${options.shutdownGuard ? '; shutdown guard enabled' : ''}).`);
}

export async function uninstallGuard(options = {}) {
  if (!await requireSupportedHost('uninstall', options)) return;
  const tier1Path = options.statePath ?? tier1StatePath();
  const hasTier1 = (options.stateExists ?? existsSync)(tier1Path);
  const hasTier2 = options.shutdownGuard || (options.stateExists ?? existsSync)(options.shutdownStatePath ?? shutdownStatePath());
  if (!hasTier1 && !hasTier2) {
    console.log('Host-stability guard uninstall: no saved state; nothing to restore.');
    return;
  }
  console.log('Administrator access is needed to restore the prior host settings.');
  const scripts = [];
  if (hasTier1) scripts.push(restoreScript(tier1Path));
  if (hasTier2) scripts.push(shutdownGuardUninstallScript(options));
  const result = await (options.runElevatedOperation ?? runElevated)(
    'uninstall host-stability guard', scripts.join('\r\n'), { timeoutMs: options.elevationTimeoutMs },
  );
  if (!result.ok) throw new Error(`Host-stability guard could not be uninstalled: ${result.reason}`);
  console.log('Host-stability guard uninstalled; prior settings restored.');
}

function atomicWriteJson(path, value, options = {}) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  (options.writeFile ?? writeFileSync)(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  (options.rename ?? renameSync)(temporary, path);
}

export function readLiveLeases(options = {}) {
  const directory = options.leasesPath ?? leasesPath();
  const now = options.now ?? Date.now();
  const timeoutMs = options.leaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
  const live = [];
  let names;
  try { names = (options.readdir ?? readdirSync)(directory); } catch { return live; }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
    const path = join(directory, name);
    try {
      if ((options.lstat ?? lstatSync)(path).isSymbolicLink()) throw new Error('symbolic link');
      const lease = JSON.parse((options.readFile ?? readFileSync)(path, 'utf8'));
      if (lease.version !== 1 || lease.sessionId !== basename(name, '.json') || !Number.isFinite(lease.heartbeat)
        || lease.heartbeat > now + timeoutMs || now - lease.heartbeat > timeoutMs) {
        throw new Error('invalid or stale lease');
      }
      live.push(lease);
    } catch {
      try { (options.unlink ?? unlinkSync)(path); } catch { /* retry next pass */ }
    }
  }
  return live;
}

async function windowsServiceController(options = {}) {
  const run = async (script) => {
    const result = await capturePowerShell(script, options);
    if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || 'vmicshutdown operation failed');
    return result.stdout.trim();
  };
  return {
    async inspect() {
      const output = await run("$s = Get-CimInstance Win32_Service -Filter \"Name='vmicshutdown'\"; if ($null -eq $s) { throw 'vmicshutdown was not found' }; [Console]::Out.Write(([ordered]@{ startupType = $s.StartMode; wasRunning = ($s.State -eq 'Running') } | ConvertTo-Json -Compress))");
      const value = JSON.parse(output);
      const startupType = { Auto: 'Automatic', Manual: 'Manual', Disabled: 'Disabled' }[value.startupType];
      if (!startupType) throw new Error(`Unsupported vmicshutdown startup type: ${value.startupType}`);
      return { startupType, wasRunning: value.wasRunning };
    },
    disable: () => run("Set-Service -Name 'vmicshutdown' -StartupType Disabled; Stop-Service -Name 'vmicshutdown' -Force -ErrorAction SilentlyContinue"),
    restore: (state) => run(`Set-Service -Name 'vmicshutdown' -StartupType ${state.startupType}; ${state.wasRunning ? "Start-Service -Name 'vmicshutdown'" : "Stop-Service -Name 'vmicshutdown' -Force -ErrorAction SilentlyContinue"}`),
  };
}

export async function reconcileShutdownGuard(options = {}) {
  const statePath = options.shutdownStatePath ?? shutdownStatePath();
  const service = options.service ?? await windowsServiceController(options);
  const live = readLiveLeases(options);
  let state;
  try {
    state = JSON.parse((options.readFile ?? readFileSync)(statePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Invalid shutdown guard state: ${error.message}`);
    state = { version: 1, service: null };
  }
  if (state.version !== 1 || !Object.hasOwn(state, 'service')) throw new Error('Invalid shutdown guard state');

  if (live.length) {
    if (state.service === null) {
      state.service = await service.inspect();
      atomicWriteJson(statePath, state, options);
    }
    await service.disable();
    return { live: live.length, action: 'disabled' };
  }
  if (state.service !== null) {
    await service.restore(state.service);
    state.service = null;
    atomicWriteJson(statePath, state, options);
    return { live: 0, action: 'restored' };
  }
  return { live: 0, action: 'unchanged' };
}

export async function createGuardLease(options = {}) {
  if (!await requireSupportedHost('on', options)) return null;
  const directory = options.leasesPath ?? leasesPath();
  const sessionId = options.sessionId ?? randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw new Error('Invalid guard session identifier');
  (options.mkdir ?? mkdirSync)(directory, { recursive: true });
  const path = join(directory, `${sessionId}.json`);
  const heartbeat = () => atomicWriteJson(path, { version: 1, sessionId, heartbeat: (options.now ?? Date.now)() }, options);
  heartbeat();
  const timer = (options.setInterval ?? setInterval)(heartbeat, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  let released = false;
  return {
    sessionId,
    heartbeat,
    release() {
      if (released) return;
      released = true;
      (options.clearInterval ?? clearInterval)(timer);
      try { (options.unlink ?? unlinkSync)(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

export async function guardOff(sessionId, options = {}) {
  if (!await requireSupportedHost('off', options)) return;
  if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? '')) throw new Error('guard off requires the session identifier printed by guard on');
  try { (options.unlink ?? unlinkSync)(join(options.leasesPath ?? leasesPath(), `${sessionId}.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function delay(milliseconds) {
  return new Promise((resolve) => { const timer = setTimeout(resolve, milliseconds); timer.unref?.(); });
}

export async function runGuardWatch(options = {}) {
  if (!await requireSupportedHost('watch', options)) return;
  const wait = options.delay ?? delay;
  // Let sessions recreate their leases after boot before either task can restore a pending
  // snapshot. Recovery runs at the grace boundary; the watchdog starts one cadence later.
  if (!options.once) await wait((options.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS) + (options.cadenceMs ?? DEFAULT_HEARTBEAT_MS));
  do {
    try { await reconcileShutdownGuard(options); } catch (error) { console.error(`runnerize guard-watch: ${error.message}`); }
    if (options.once) break;
    await wait(options.cadenceMs ?? DEFAULT_HEARTBEAT_MS);
  } while (true);
}

export async function runGuardRecover(options = {}) {
  if (!await requireSupportedHost('recover', options)) return;
  await (options.delay ?? delay)(options.recoveryGraceMs ?? DEFAULT_RECOVERY_GRACE_MS);
  return reconcileShutdownGuard(options);
}

export async function guardStatus(options = {}) {
  const platformName = options.platformName ?? platform();
  if (platformName !== 'win32') {
    console.log('Hyper-V guest: no');
    console.log('Host-stability guard status: NOOP (Windows Hyper-V guests only).');
    return;
  }
  const guest = await isHyperVGuest(options);
  console.log(`Hyper-V guest: ${guest ? 'yes' : 'no'}`);
  if (!guest) {
    console.log('Host-stability guard status: NOOP (this host is not a Microsoft Hyper-V guest).');
    return;
  }
  const path = options.statePath ?? tier1StatePath();
  const script = [
    `function Read-Value($path, $name) { $key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue; if ($null -eq $key) { return $null }; return $key.GetValue($name, $null) }`,
    `$power = Read-Value ${powershellLiteral(POWER_KEY)} 'HibernateEnabled'`,
    `$result = [ordered]@{ noAutoRebootWithLoggedOnUsers = (Read-Value ${powershellLiteral(AU_KEY)} 'NoAutoRebootWithLoggedOnUsers'); setActiveHours = (Read-Value ${powershellLiteral(WINDOWS_UPDATE_KEY)} 'SetActiveHours'); activeHoursStart = (Read-Value ${powershellLiteral(WINDOWS_UPDATE_KEY)} 'ActiveHoursStart'); activeHoursEnd = (Read-Value ${powershellLiteral(WINDOWS_UPDATE_KEY)} 'ActiveHoursEnd'); hibernateOn = ($null -ne $power -and [int]$power -ne 0) }`,
    '[Console]::Out.Write(($result | ConvertTo-Json -Compress))',
  ].join('; ');
  const result = await capturePowerShell(script, options);
  if (result.status !== 0) throw new Error(`Could not read host-stability guard status: ${result.stderr.trim() || result.error?.message || `exit code ${result.status}`}`);
  const state = JSON.parse(result.stdout);
  console.log(`Guard state file: ${(options.stateExists ?? existsSync)(path) ? 'present' : 'absent'}`);
  console.log(`NoAutoRebootWithLoggedOnUsers: ${state.noAutoRebootWithLoggedOnUsers ?? 'absent'}`);
  console.log(`Active hours policy: enabled=${state.setActiveHours ?? 'absent'} start=${state.activeHoursStart ?? 'absent'} end=${state.activeHoursEnd ?? 'absent'}`);
  console.log(`Hibernate: ${state.hibernateOn ? 'on' : 'off'}`);
  console.log(`Shutdown guard: ${(options.stateExists ?? existsSync)(options.shutdownStatePath ?? shutdownStatePath()) ? 'installed' : 'not installed'}`);
}
