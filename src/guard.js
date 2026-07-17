import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { powershellLiteral, runElevated, windowsPowerShellPath } from './service.js';

const WINDOWS_UPDATE_KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate';
const AU_KEY = `${WINDOWS_UPDATE_KEY}\\AU`;
const POWER_KEY = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power';
const DEFAULT_ACTIVE_HOURS = '6-0';
const PROBE_TIMEOUT_MS = 10_000;

function guardStatePath() {
  return join(process.env.ProgramData || 'C:\\ProgramData', 'runnerize', 'guard', 'tier1-state.json');
}

function captureSpawn(command, args, { spawnChild = spawn, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawnChild(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
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
  // Keep this CIM-only process minimal. Appending unrelated cmdlets after CIM-backed cmdlets can
  // make Windows PowerShell crash while exiting on affected hosts.
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
  // Microsoft Windows Update policy CSP registry mappings: SetActiveHours,
  // ActiveHoursStart, and ActiveHoursEnd under the WindowsUpdate policy key.
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
    'if (-not (Test-Path -LiteralPath $statePath)) { exit 0 }',
    '$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json',
    `$expected = @(@{ path = ${powershellLiteral(AU_KEY)}; name = 'NoAutoRebootWithLoggedOnUsers' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'SetActiveHours' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'ActiveHoursStart' }, @{ path = ${powershellLiteral(WINDOWS_UPDATE_KEY)}; name = 'ActiveHoursEnd' })`,
    'foreach ($target in $expected) {',
    '  $setting = $state.settings | Where-Object { $_.path -eq $target.path -and $_.name -eq $target.name } | Select-Object -First 1',
    "  if ($null -eq $setting) { throw ('Saved guard state is missing ' + $target.name) }",
    '  if ($setting.existed) {',
    "    if ($setting.kind -notin @('String', 'ExpandString', 'Binary', 'DWord', 'MultiString', 'QWord')) { throw ('Saved guard state has an invalid registry kind for ' + $target.name) }",
    '    New-Item -Path $target.path -Force | Out-Null',
    '    New-ItemProperty -Path $target.path -Name $target.name -PropertyType $setting.kind -Value $setting.data -Force | Out-Null',
    '  } else {',
    '    Remove-ItemProperty -LiteralPath $target.path -Name $target.name -ErrorAction SilentlyContinue',
    '  }',
    '}',
    'if ($state.hibernateOn) {',
    '  & powercfg.exe /hibernate on',
    "  if ($LASTEXITCODE -ne 0) { throw 'powercfg /hibernate on failed' }",
    '}',
    'Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue',
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
  if (options.shutdownGuard) {
    console.log('shutdown-guard (Tier 2) is not yet implemented');
    return;
  }
  if (!await requireSupportedHost('install', options)) return;
  const hours = activeHours(options.activeHours);
  console.log('Administrator access is needed to apply the host-stability guard.');
  console.log('A UAC prompt will appear. Approve it to update Windows Update and power settings.');
  const result = await (options.runElevatedOperation ?? runElevated)(
    'install host-stability guard',
    applyScript(options.statePath ?? guardStatePath(), hours),
    { timeoutMs: options.elevationTimeoutMs },
  );
  if (!result.ok) throw new Error(`Host-stability guard could not be installed: ${result.reason}`);
  console.log(`Host-stability guard installed (active hours ${hours.start}:00-${hours.end}:00; hibernate off).`);
}

export async function uninstallGuard(options = {}) {
  if (!await requireSupportedHost('uninstall', options)) return;
  const path = options.statePath ?? guardStatePath();
  if (!(options.stateExists ?? existsSync)(path)) {
    console.log('Host-stability guard uninstall: no saved Tier-1 state; nothing to restore.');
    return;
  }
  console.log('Administrator access is needed to restore the prior host settings.');
  const result = await (options.runElevatedOperation ?? runElevated)(
    'uninstall host-stability guard',
    restoreScript(path),
    { timeoutMs: options.elevationTimeoutMs },
  );
  if (!result.ok) throw new Error(`Host-stability guard could not be uninstalled: ${result.reason}`);
  console.log('Host-stability guard uninstalled; prior Tier-1 settings restored.');
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
  const path = options.statePath ?? guardStatePath();
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
}
