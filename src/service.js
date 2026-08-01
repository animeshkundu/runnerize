import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToken, listOwnedPrivateRepos, listRunners, sanitizeHostname } from './github.js';
import { installGuard, uninstallGuard } from './guard.js';
import { DEFAULT_LINUX_IMAGE, kvmStatus } from './sandbox/container.js';
import { RUNNERIZE_VERSION } from './version.js';

const SERVICE_NAME = 'runnerize';
const DEFAULT_WSL_NODE_VERSION = 'v24.18.0';
const DEFAULT_WSL_NODE_SHA256 = '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742';
const binPath = fileURLToPath(new URL('../bin/runnerize.js', import.meta.url));
const packageRoot = dirname(dirname(binPath));
const SERVICE_PACKAGE_ENTRIES = ['bin', 'src', 'package.json'];
const ELEVATION_TIMEOUT_MS = 55_000;
const PROBE_TIMEOUT_MS = 10_000;
const SYSTEMD_VERIFY_TIMEOUT_MS = 5_000;
const SYSTEMD_VERIFY_RETRY_MS = 100;
const INSTALL_TIMEOUT_MS = 120_000;
const NPM_LOOKUP_TIMEOUT_MS = 10_000;
const KEEPAWAKE_POLL_SECONDS = 30;
const KEEPAWAKE_RETRY_SECONDS = 15;
// 20 consecutive failures at 15s apart, so roughly five minutes of sustained unavailability
// before the holder retires. Long enough to ride out a restarting unit or a booting distro,
// short enough that an uninstalled runnerize stops holding the host awake.
const KEEPAWAKE_MAX_CONSECUTIVE_FAILURES = 20;
const KEEPAWAKE_PROBE_TIMEOUT_MS = 60_000;
const WSL_BOOT_DEADLINE_SECONDS = 600;
const WSL_BOOT_RETRY_SECONDS = 15;
const WSL_BOOT_ATTEMPT_TIMEOUT_MS = 120_000;
const WSL_INSTALL_GUIDANCE = 'In an elevated PowerShell: wsl --install -d Ubuntu\nThen restart Windows if prompted and rerun this command.';
const GITHUB_AUTH_GUIDANCE = 'Run: gh auth login\nOr set GH_TOKEN/GITHUB_TOKEN. The credential needs Administration, Actions, and Metadata access across all owned private repositories.';
const DEFAULT_MACOS_IMAGE = 'ghcr.io/cirruslabs/macos-sequoia-base:latest';
const HOMEBREW_INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
const TART_INSTALL_COMMAND = 'brew install cirruslabs/cli/tart';
const MACOS_ENVIRONMENT_KEYS = [
  'RUNNERIZE_LINUX_IMAGE',
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

function systemdAppPath(...parts) {
  return join(homedir(), '.local', 'share', `${SERVICE_NAME}-service`, ...parts);
}

function servicePackageManifest() {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (!SEMVER_PATTERN.test(manifest.version)) {
    throw new Error('runnerize package version is invalid.');
  }
  const runtimeDependencies = [manifest.dependencies, manifest.optionalDependencies]
    .flatMap((dependencies) => Object.keys(dependencies ?? {}));
  if (runtimeDependencies.length) {
    throw new Error(`runnerize service installation does not support runtime dependencies: ${runtimeDependencies.join(', ')}`);
  }
  return manifest;
}

function copyServicePackage(destination, manifest = servicePackageManifest()) {
  for (const entry of SERVICE_PACKAGE_ENTRIES) {
    cpSync(join(packageRoot, entry), join(destination, entry), { recursive: true });
  }
  return manifest;
}

function readInstalledVersion(root) {
  if (!root) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function systemdUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function executableRoot(spec, pathApi = { dirname }) {
  const normalized = spec?.replaceAll('\\\\', '\\');
  const match = normalized?.match(/(?:^|\s)"?([^"\s]*[\\/]bin[\\/]runnerize\.js)"?(?:\s|$)/);
  if (!match) return null;
  return pathApi.dirname(pathApi.dirname(match[1]));
}

function systemdServiceState() {
  let unit = '';
  try {
    unit = readFileSync(systemdUnitPath(), 'utf8');
  } catch {
    // Missing units are reported as not installed below.
  }
  const installedRoot = executableRoot(unit.split(/\r?\n/).find((line) => line.startsWith('ExecStart=')));
  const hasSystemctl = commandExists('systemctl');
  const effectiveEnvironment = hasSystemctl
    ? captureResult('systemctl', [
      '--user', 'show', `${SERVICE_NAME}.service`, '--property=Environment', '--value',
    ])
    : { status: 1, stdout: '' };
  return {
    backend: platform() === 'darwin' ? 'launchd' : 'linux',
    installed: Boolean(installedRoot),
    version: readInstalledVersion(installedRoot),
    running: hasSystemctl
      && captureResult('systemctl', ['--user', 'is-active', '--quiet', `${SERVICE_NAME}.service`]).status === 0,
    root: installedRoot,
    environment: systemdServiceEnvironment(
      unit,
      (fileName) => readFileSync(fileName, 'utf8'),
      effectiveEnvironment.status === 0 ? effectiveEnvironment.stdout : '',
    ),
  };
}

function launchdServiceState() {
  const agentPath = join(homedir(), 'Library', 'LaunchAgents', 'io.runnerize.dispatcher.plist');
  let installedRoot = null;
  try {
    const plist = readFileSync(agentPath, 'utf8');
    const binMatch = plist.match(/<string>([^<]*[\\/]bin[\\/]runnerize\.js)<\/string>/);
    if (binMatch) installedRoot = dirname(dirname(binMatch[1]));
  } catch {
    // Missing or unreadable launchd agents are reported as not installed.
  }
  const environment = new Map();
  try {
    const plist = readFileSync(agentPath, 'utf8');
    for (const match of plist.matchAll(/<key>(RUNNERIZE_[^<]+)<\/key><string>([^<]*)<\/string>/g)) {
      environment.set(match[1], match[2]
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&'));
    }
  } catch {
    // Missing or unreadable launchd agents have no configured environment.
  }
  return {
    backend: 'macos',
    installed: Boolean(installedRoot),
    version: readInstalledVersion(installedRoot),
    running: captureResult('launchctl', ['print', `gui/${process.getuid()}/io.runnerize.dispatcher`]).status === 0,
    root: installedRoot,
    environment,
  };
}

function windowsServiceState() {
  let installedRoot = null;
  try {
    installedRoot = readFileSync(windowsDataPath('current-release'), 'utf8').trim();
  } catch {
    // Backward compatibility with the original mutable materialization layout.
    const legacyRoot = windowsDataPath('app');
    if (existsSync(join(legacyRoot, 'package.json'))) installedRoot = legacyRoot;
  }
  const installed = Boolean(installedRoot && existsSync(join(installedRoot, 'package.json')));
  return {
    backend: 'windows',
    installed,
    version: installed ? readInstalledVersion(installedRoot) : null,
    running: scheduledTaskIsRunning('runnerize-windows'),
    root: installed ? installedRoot : null,
  };
}

function wslServiceState(context) {
  const unitPath = `${context.home}/.config/systemd/user/${SERVICE_NAME}.service`;
  let unit = '';
  let root = null;
  let version = null;
  try {
    unit = wslCapture(context.distro, context.user, ['cat', unitPath], { timeout: PROBE_TIMEOUT_MS });
    const execStart = unit.split('\n').find((line) => line.startsWith('ExecStart='));
    root = executableRoot(execStart, posix);
    version = root
      ? JSON.parse(wslCapture(context.distro, context.user, ['cat', `${root}/package.json`], { timeout: PROBE_TIMEOUT_MS })).version
      : null;
  } catch {
    // A missing or unreadable unit is reported as not installed below.
  }
  const running = Boolean(root) && captureResult('wsl.exe', wslArgs(
    context.distro,
    context.user,
    systemdWslArgs(['systemctl', '--user', 'is-active', '--quiet', `${SERVICE_NAME}.service`]),
  ), { timeout: PROBE_TIMEOUT_MS }).status === 0;
  let effectiveEnvironment = '';
  try {
    effectiveEnvironment = wslCapture(context.distro, context.user, systemdWslArgs([
      'systemctl', '--user', 'show', `${SERVICE_NAME}.service`, '--property=Environment', '--value',
    ]), { timeout: PROBE_TIMEOUT_MS });
  } catch {
    // Inactive or missing units may not expose an effective environment.
  }
  const environment = systemdServiceEnvironment(
    unit,
    (fileName) => wslCapture(context.distro, context.user, ['cat', fileName], { timeout: PROBE_TIMEOUT_MS }),
    effectiveEnvironment,
  );
  return { backend: `linux (WSL ${context.distro})`, installed: Boolean(root), version, running, root, environment };
}

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function latestPublishedVersion({ fetchImpl = globalThis.fetch } = {}) {
  try {
    const response = await fetchImpl('https://registry.npmjs.org/runnerize/latest', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(NPM_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return typeof data.version === 'string' && SEMVER_PATTERN.test(data.version) ? data.version : null;
  } catch {
    return null;
  }
}

function parseEnvironmentAssignments(text) {
  const values = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = assignment.indexOf('=');
    if (separator < 1) continue;
    const key = assignment.slice(0, separator).trim();
    let value = assignment.slice(separator + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

function systemdEnvironmentFile(unit) {
  const directive = String(unit).split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('EnvironmentFile='));
  if (!directive) return null;
  let fileName = directive.slice('EnvironmentFile='.length).trim().replace(/^-/, '');
  if (fileName.startsWith('"') && fileName.endsWith('"')) fileName = fileName.slice(1, -1);
  return fileName || null;
}

function systemdServiceEnvironment(unit, readText, effectiveEnvironment = '') {
  const values = new Map();
  const environmentFile = systemdEnvironmentFile(unit);
  if (environmentFile) {
    try {
      for (const [key, value] of parseEnvironmentAssignments(readText(environmentFile))) {
        if (key === 'RUNNERIZE_LINUX_IMAGE') values.set(key, value);
      }
    } catch {
      // Optional or unreadable environment files do not hide the installed service.
    }
  }
  for (const directive of String(unit).split(/\r?\n/).map((line) => line.trim())) {
    if (!directive.startsWith('Environment=')) continue;
    for (const [key, value] of parseEnvironmentAssignments(directive.slice('Environment='.length))) {
      if (key === 'RUNNERIZE_LINUX_IMAGE') values.set(key, value);
    }
  }
  const effectiveImage = String(effectiveEnvironment)
    .match(/(?:^|\s)"?RUNNERIZE_LINUX_IMAGE=([^"\s]+)"?/)?.[1];
  if (effectiveImage) values.set('RUNNERIZE_LINUX_IMAGE', effectiveImage);
  return values;
}

function configuredLinuxImage(state) {
  return state?.environment?.get('RUNNERIZE_LINUX_IMAGE')
    || process.env.RUNNERIZE_LINUX_IMAGE
    || DEFAULT_LINUX_IMAGE;
}

function nativeContainerRuntime() {
  for (const runtime of ['podman', 'docker']) {
    if (captureResult(runtime, ['--version'], { timeout: PROBE_TIMEOUT_MS }).status === 0) return runtime;
  }
  return null;
}

function imageDetails(raw) {
  try {
    const details = JSON.parse(raw)?.[0] ?? {};
    const digest = details.Digest
      ?? details.RepoDigests?.find((value) => value.includes('@sha256:'))?.split('@')[1]
      ?? details.Id
      ?? null;
    return { digest, created: details.Created ?? null };
  } catch {
    return { digest: null, created: null };
  }
}

function nativeImageState(state) {
  const reference = configuredLinuxImage(state);
  const runtime = nativeContainerRuntime();
  if (!runtime) return { reference, runtime: null, digest: null, created: null };
  const result = captureResult(runtime, ['image', 'inspect', reference], { timeout: PROBE_TIMEOUT_MS });
  const details = result.status === 0 ? imageDetails(result.stdout) : { digest: null, created: null };
  return { reference, runtime, ...details };
}

function wslImageState(context, state) {
  const reference = configuredLinuxImage(state);
  for (const runtime of ['podman', 'docker']) {
    try {
      const raw = wslCapture(context.distro, context.user, [runtime, 'image', 'inspect', reference], { timeout: PROBE_TIMEOUT_MS });
      return { reference, runtime: `${runtime} (WSL ${context.distro})`, ...imageDetails(raw) };
    } catch {
      // Try the other supported runtime.
    }
  }
  return { reference, runtime: null, digest: null, created: null };
}

async function imageStates(states) {
  const serviceStateList = states ?? await serviceStates();
  if (platform() === 'win32') {
    try {
      const context = resolveWslContext();
      const state = serviceStateList.find(({ backend }) => backend.startsWith('linux (WSL'));
      return [wslImageState(context, state)];
    } catch {
      return [{ reference: configuredLinuxImage(), runtime: null, digest: null, created: null }];
    }
  }
  return [await nativeImageState(serviceStateList[0])];
}

function refreshWslImage(context, state) {
  const reference = configuredLinuxImage(state);
  const runtime = ensureWslRuntime(context, { install: false });
  wslRun(context.distro, context.user, [runtime, 'pull', reference], { timeout: 10 * 60_000 });
}

async function refreshLinuxImages(state) {
  if (platform() === 'win32') {
    try {
      refreshWslImage(resolveWslContext(), state);
      return true;
    } catch (error) {
      console.warn(`Linux image refresh unavailable: ${error.message}`);
      return false;
    }
  }
  try {
    const runtime = nativeContainerRuntime();
    if (!runtime) throw new Error('podman or docker is required for the linux flavor');
    run(runtime, ['pull', configuredLinuxImage(state)], { timeout: 10 * 60_000 });
    return true;
  } catch (error) {
    console.warn(`Linux image refresh unavailable: ${error.message}`);
    return false;
  }
}

async function serviceStates() {
  if (platform() === 'win32') {
    const states = [];
    try {
      states.push(wslServiceState(resolveWslContext()));
    } catch {
      states.push({ backend: 'linux (WSL)', installed: false, version: null, running: false, root: null });
    }
    states.push(windowsServiceState());
    return states;
  }
  return [platform() === 'darwin' ? launchdServiceState() : systemdServiceState()];
}

function parseVersion(version) {
  const match = SEMVER_PATTERN.exec(String(version));
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const identifiers = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumeric = /^\d+$/.test(a.prerelease[index]);
    const bNumeric = /^\d+$/.test(b.prerelease[index]);
    if (aNumeric && bNumeric) return Number(a.prerelease[index]) < Number(b.prerelease[index]) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

function versionRelation(installedVersion, latestVersion) {
  if (!installedVersion) return 'NOT INSTALLED';
  if (!latestVersion) return 'LATEST UNKNOWN';
  const comparison = compareVersions(installedVersion, latestVersion);
  if (comparison === 0) return 'CURRENT';
  return comparison < 0 ? 'STALE' : 'AHEAD';
}

export async function serviceStatus({ fetchImpl } = {}) {
  const statesPromise = serviceStates();
  const [states, latestVersion] = await Promise.all([
    statesPromise,
    latestPublishedVersion({ fetchImpl }),
  ]);
  const images = await imageStates(states);
  console.log(`Command package: runnerize ${RUNNERIZE_VERSION}`);
  console.log(`Latest on npm: ${latestVersion ?? 'unknown (offline or unavailable)'}`);
  for (const state of states) {
    const relation = versionRelation(state.version, latestVersion);
    console.log(`${state.backend}: installed=${state.version ?? 'no'} running=${state.running ? 'yes' : 'no'} status=${relation}`);
  }
  for (const image of images) {
    console.log(`Linux image: reference=${image.reference} runtime=${image.runtime ?? 'unavailable'} digest=${image.digest ?? 'not present'} created=${image.created ?? 'unknown'}`);
  }
  return { commandVersion: RUNNERIZE_VERSION, latestVersion, services: states, images };
}

async function serviceRunnerPrefixes() {
  const prefixes = new Set([`${sanitizeHostname()}-`]);
  if (platform() === 'win32') {
    try {
      const context = resolveWslContext();
      const hostname = wslCapture(context.distro, context.user, ['hostname'], { timeout: PROBE_TIMEOUT_MS });
      prefixes.add(`${sanitizeHostname(hostname)}-`);
    } catch {
      // A missing WSL backend has no WSL jobs to protect.
    }
  }
  return prefixes;
}

async function activeRunnerNames() {
  const prefixes = await serviceRunnerPrefixes();
  const repos = await listOwnedPrivateRepos();
  const active = [];
  for (const repo of repos) {
    const runners = await listRunners(repo.full_name);
    for (const runner of runners) {
      if (runner.busy && [...prefixes].some((prefix) => runner.name.startsWith(prefix))) {
        active.push(`${repo.full_name}:${runner.name}`);
      }
    }
  }
  return active;
}

function installPublishedVersion(version, { force = false } = {}) {
  const npm = platform() === 'win32' ? 'npm.cmd' : 'npm';
  run(npm, [
    'exec', '--yes', `--package=runnerize@${version}`, '--',
    'runnerize', 'service', 'install', '--update', ...(force ? ['--force'] : []),
  ], { timeout: 10 * 60_000, env: { ...process.env, RUNNERIZE_SERVICE_UPDATE: '1' } });
}

export async function updateService({ force = false, fetchImpl, installVersion = installPublishedVersion } = {}) {
  const latestVersion = await latestPublishedVersion({ fetchImpl });
  if (!latestVersion) throw new Error('Could not resolve the latest runnerize version from npm. Check the network connection and try again.');

  const states = await serviceStates();
  const installedStates = states.filter((state) => state.installed);
  if (!installedStates.length) {
    throw new Error('No runnerize service is installed on this host. Run `runnerize service install` first.');
  }

  if (!force) {
    const active = await activeRunnerNames();
    if (active.length) {
      throw new Error(`Refusing to update while ${active.length} runnerize job(s) are active: ${active.join(', ')}. Retry after they finish, or use --force to interrupt them.`);
    }
  }

  const linuxState = installedStates.find(({ backend }) => backend === 'linux' || backend.startsWith('linux (WSL'));
  const imageState = linuxState ?? (platform() === 'darwin' ? installedStates[0] : undefined);
  const shouldRefreshLinuxImage = Boolean(linuxState) || platform() === 'darwin' && Boolean(nativeContainerRuntime());
  let imageRefreshed = false;
  if (shouldRefreshLinuxImage) {
    console.log(`Refreshing ${configuredLinuxImage(imageState)} before updating the service...`);
    imageRefreshed = await refreshLinuxImages(imageState);
    if (!imageRefreshed) {
      throw new Error('Could not refresh the configured Linux image. The service was not updated.');
    }
  }
  console.log(`Updating installed runnerize service backend(s) to ${latestVersion}${force ? ' (forced)' : ''}...`);
  await installVersion(latestVersion, { force });
  return { latestVersion, forced: force, imageRefreshed };
}

function materializeSystemdApp() {
  const manifest = servicePackageManifest();
  const releases = systemdAppPath('releases');
  mkdirSync(releases, { recursive: true });
  const destination = mkdtempSync(join(releases, `${manifest.version}.`));
  try {
    copyServicePackage(destination);
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
  return { root: destination, bin: join(destination, 'bin', 'runnerize.js') };
}

function systemdUnitIsActive(unitName) {
  const result = systemdUserResult([
    'systemctl', '--user', 'is-active', '--quiet', unitName,
  ], { timeout: PROBE_TIMEOUT_MS });
  if (result.status === 0) return true;
  if (result.status === 3 || result.status === 4) return false;
  const detail = result.stderr?.trim() || result.stdout?.trim()
    || result.error?.message || `exit code ${result.status}`;
  throw new Error(`Could not determine whether ${unitName} is active: ${detail}`);
}

async function verifySystemdInstall(unitName, expectedArgs) {
  try {
    accessSync(expectedArgs[0], constants.X_OK);
  } catch (error) {
    throw new Error(`${unitName} uses a missing or non-executable interpreter at ${expectedArgs[0]}.`, {
      cause: error,
    });
  }

  const expectedNode = capture('readlink', ['-f', process.execPath], {
    timeout: PROBE_TIMEOUT_MS,
  });
  const deadline = Date.now() + SYSTEMD_VERIFY_TIMEOUT_MS;
  let lastError;

  do {
    try {
      if (!systemdUnitIsActive(unitName)) {
        throw new Error(`${unitName} is not active after installation.`);
      }
      const mainPid = Number.parseInt(systemdUserCapture([
        'systemctl', '--user', 'show', unitName, '--property=MainPID', '--value',
      ], { timeout: PROBE_TIMEOUT_MS }), 10);
      if (!Number.isInteger(mainPid) || mainPid <= 0) {
        throw new Error(`Could not determine the running process for ${unitName}.`);
      }
      const runningNode = capture('readlink', ['-f', `/proc/${mainPid}/exe`], {
        timeout: PROBE_TIMEOUT_MS,
      });
      const runningArgs = capture('bash', [
        '-c', 'cat -- "/proc/$1/cmdline"', 'runnerize-systemd-verify', String(mainPid),
      ], { timeout: PROBE_TIMEOUT_MS }).split('\0').filter(Boolean);
      const argumentsMatch = runningArgs.length === expectedArgs.length
        && runningArgs.every((argument, index) => argument === expectedArgs[index]);
      if (runningNode !== expectedNode || !argumentsMatch) {
        throw new Error(`${unitName} did not start the intended executable ${expectedArgs.join(' ')}; PID ${mainPid} is running ${runningArgs.join(' ') || runningNode || 'an unknown command'}.`);
      }
      return;
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(SYSTEMD_VERIFY_RETRY_MS, remaining));
      });
    }
  } while (Date.now() < deadline);

  throw lastError;
}

async function installSystemd({ force = false } = {}) {
  await preflightRun();
  const unitName = `${SERVICE_NAME}.service`;
  const wasActive = systemdUnitIsActive(unitName);
  // npx runs packages from its disposable cache; keep the service executable independent of it.
  const installation = materializeSystemdApp();
  const unitPath = join(homedir(), '.config', 'systemd', 'user', unitName);
  const environmentFilePath = process.env.RUNNERIZE_SYSTEMD_ENV_FILE;
  if (environmentFilePath && /[\r\n]/.test(environmentFilePath)) {
    throw new Error('RUNNERIZE_SYSTEMD_ENV_FILE cannot contain a newline.');
  }
  const environmentFile = environmentFilePath
    ? `EnvironmentFile=-${quoteSystemd(environmentFilePath)}\n`
    : '';
  const runOnly = process.env.RUNNERIZE_SERVICE_RUN_ONLY;
  const expectedArgs = [
    process.execPath,
    installation.bin,
    'run',
    ...(runOnly ? ['--only', runOnly] : []),
  ];
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, `[Unit]
Description=runnerize ephemeral GitHub Actions dispatcher
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Delegate=yes
ExecStart=${quoteSystemd(process.execPath)} ${quoteSystemd(installation.bin)} run${runOnly ? ` --only ${quoteSystemd(runOnly)}` : ''}
${environmentFile}Restart=always
RestartSec=5
KillMode=mixed
TimeoutStopSec=infinity

[Install]
WantedBy=default.target
`, { mode: 0o644 });

  systemdUserRun(['systemctl', '--user', 'daemon-reload']);
  systemdUserRun(['systemctl', '--user', 'enable', unitName]);
  if (wasActive) {
    console.log('Restarting the running dispatcher to load the new version…');
    if (force) {
      // `systemctl kill` already targets every process in the unit, and naming that
      // explicitly breaks on systemd < 252, where the option is spelled --kill-who.
      // The kill only front-runs the restart below, so a failure must not abort the
      // install — that turned a cosmetic incompatibility into linux=unavailable.
      try {
        systemdUserRun(['systemctl', '--user', 'kill', '--signal=SIGKILL', unitName]);
      } catch (error) {
        console.warn(`Could not force-kill the running dispatcher; restarting instead: ${error.message}`);
      }
    }
    systemdUserRun(['systemctl', '--user', 'restart', unitName]);
  } else {
    systemdUserRun(['systemctl', '--user', 'start', unitName]);
  }
  await verifySystemdInstall(unitName, expectedArgs);
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
  rmSync(systemdAppPath(), { recursive: true, force: true });
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

function forceStopMacosJobs() {
  const runtime = nativeContainerRuntime();
  if (runtime) {
    const listed = captureResult(runtime, [
      'ps', '-a', '--filter', 'name=^runnerize-', '--format', '{{.Names}}',
    ], { timeout: PROBE_TIMEOUT_MS });
    if (listed.status === 0) {
      for (const name of listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)) {
        run(runtime, ['rm', '-f', name], { timeout: PROBE_TIMEOUT_MS });
      }
    }
  }

  if (!commandExists('tart')) return;
  const listed = captureResult('tart', ['list', '--format', 'json'], { timeout: PROBE_TIMEOUT_MS });
  if (listed.status !== 0) throw new Error('Could not list runnerize tart VMs.');
  let entries;
  try {
    const parsed = JSON.parse(listed.stdout);
    entries = Array.isArray(parsed) ? parsed : parsed.vms ?? parsed.VMs ?? [];
  } catch {
    throw new Error('Could not parse the tart VM list.');
  }
  const names = entries.map((entry) => typeof entry === 'string' ? entry : entry.name ?? entry.Name)
    .filter((name) => typeof name === 'string' && name.startsWith('runnerize-'));
  for (const name of names) {
    captureResult('tart', ['stop', name], { timeout: PROBE_TIMEOUT_MS });
    const removed = captureResult('tart', ['delete', name], { timeout: PROBE_TIMEOUT_MS });
    if (removed.status !== 0) throw new Error(`Could not delete tart VM ${name}.`);
  }
}

async function installLaunchd({ force = false } = {}) {
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
  const installation = materializeSystemdApp();
  mkdirSync(dirname(agentPath), { recursive: true });
  writeFileSync(agentPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>io.runnerize.dispatcher</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEscape(process.execPath)}</string><string>${xmlEscape(installation.bin)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
${launchdEnvironmentXml()}  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlEscape(join(homedir(), 'Library', 'Logs', 'runnerize.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(homedir(), 'Library', 'Logs', 'runnerize.log'))}</string>
</dict>
</plist>
`, { mode: 0o644 });

  const domain = `gui/${process.getuid()}`;
  if (force) forceStopMacosJobs();
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
  rmSync(systemdAppPath(), { recursive: true, force: true });
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

async function reportKvmStatus(target, kvmStatusCheck = kvmStatus) {
  const result = await kvmStatusCheck(target);
  console.log(`KVM capability: ${result.status} — ${result.why}`);
  if (result.command) {
    printManualSteps('Optional KVM setup', [{ why: result.why, command: result.command }]);
  }
  return result;
}

async function preflightWsl(context, { requireSystemd = true } = {}) {
  if (requireSystemd) {
    const init = wslCapture(context.distro, context.user, ['ps', '-p', '1', '-o', 'comm='], { timeout: PROBE_TIMEOUT_MS });
    if (init !== 'systemd') {
      throw new Error(`systemd is not running in WSL distro ${context.distro}. Enable it in /etc/wsl.conf, run \`wsl.exe --shutdown\`, then retry.`);
    }
  }

  const runtime = ensureWslRuntime(context);
  const kvm = await reportKvmStatus({ runtime, distro: context.distro });

  try {
    wslCapture(context.distro, context.user, ['gh', 'auth', 'status'], { timeout: PROBE_TIMEOUT_MS });
    return { runtime, token: null, kvm };
  } catch {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (token) return { runtime, token, kvm };
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

export async function preflightRun({ install = true, only, kvmStatusCheck = kvmStatus } = {}) {
  const wantsLinux = !only || only.has('linux');
  const wantsWindows = !only || only.has('windows');
  let runtime;
  let kvm;
  if (platform() === 'win32') {
    if (wantsLinux) {
      const context = resolveWslContext();
      runtime = ensureWslRuntime(context, { install });
      kvm = await reportKvmStatus({ runtime, distro: context.distro }, kvmStatusCheck);
    }
    if (wantsWindows && !commandExists('wsb.exe')) {
      throw new Error('Windows Sandbox is unavailable. Enable the Windows Sandbox optional feature and retry.');
    }
  } else if (wantsLinux) {
    runtime = nativeRuntime();
    if (!runtime) {
      throw new Error('No working rootless Podman or Docker runtime was found. Install Podman, verify `podman info`, then rerun this command.');
    }
    kvm = await reportKvmStatus({ runtime }, kvmStatusCheck);
  }

  try {
    await getToken();
  } catch {
    throw new Error(`GitHub authentication is not available.\n${GITHUB_AUTH_GUIDANCE}`);
  }
  console.log(`Prerequisites ready: ${runtime ? `container runtime ${runtime}; ` : ''}GitHub credential available.`);
  return { runtime, kvm };
}

function persistWslToken({ distro, user, home }, token) {
  if (!token) return false;
  const path = `${home}/.config/runnerize/.env`;
  const script = 'set -eu\npath="$1"\numask 077\nmkdir -p "$(dirname "$path")"\nprintf "GH_TOKEN=%s\\n" "$GH_TOKEN" > "$path"\nchmod 600 "$path"';
  wslRun(distro, user, ['sh', '-c', script, 'runnerize-token', path], { env: { ...process.env, WSLENV: [process.env.WSLENV, 'GH_TOKEN'].filter(Boolean).join(':'), GH_TOKEN: token } });
  return true;
}

function systemdUserShellArgs(command) {
  // npx lacks the user-bus environment, which otherwise turns an active service into a false inactive result.
  const script = 'export XDG_RUNTIME_DIR=/run/user/$(id -u); export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus; exec "$@"';
  return ['-c', script, 'runnerize-systemd', ...command];
}

function systemdUserResult(command, options = {}) {
  return captureResult('bash', systemdUserShellArgs(command), options);
}

function systemdUserCapture(command, options = {}) {
  return capture('bash', systemdUserShellArgs(command), options);
}

function systemdUserRun(command, options = {}) {
  return run('bash', systemdUserShellArgs(command), options);
}

function systemdWslArgs(command) {
  return ['bash', ...systemdUserShellArgs(command)];
}

function validNodeVersion(output) {
  const match = String(output).match(/^v(\d+)\.\d+\.\d+$/);
  return match && Number(match[1]) >= 18;
}

function ensureWslNode({ distro, user, home }) {
  const requestedVersion = process.env.RUNNERIZE_WSL_NODE_VERSION || DEFAULT_WSL_NODE_VERSION;
  if (!/^v\d+\.\d+\.\d+$/.test(requestedVersion)) throw new Error('RUNNERIZE_WSL_NODE_VERSION must look like v24.18.0.');
  const installDir = `${home}/.local/share/runnerize/node/${requestedVersion}`;
  const nodePath = `${installDir}/bin/node`;
  try {
    const installedVersion = wslCapture(distro, user, [nodePath, '--version']);
    if (installedVersion === requestedVersion && validNodeVersion(installedVersion)) {
      return { path: nodePath, version: installedVersion, downloaded: false };
    }
  } catch {
    // Try migrating the previous cache-based installation before downloading again.
  }

  const legacyInstallDir = `${home}/.cache/runnerize/node/${requestedVersion}`;
  const migrationScript = [
    'set -eu',
    'source="$1"',
    'destination="$2"',
    'if [ -x "$source/bin/node" ] && [ ! -e "$destination" ]; then',
    '  mkdir -p "$(dirname "$destination")"',
    '  mv "$source" "$destination"',
    'fi',
    '"$destination/bin/node" --version',
  ].join('\n');
  try {
    const migratedVersion = wslCapture(distro, user, [
      'sh', '-c', migrationScript, 'runnerize-node-migrate', legacyInstallDir, installDir,
    ]);
    if (migratedVersion === requestedVersion && validNodeVersion(migratedVersion)) {
      return { path: nodePath, version: migratedVersion, downloaded: false };
    }
  } catch {
    // Fall through to PATH probing or a fresh verified installation.
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
  const manifest = servicePackageManifest();
  const releases = `${home}/.local/share/runnerize-service/releases`;
  const windowsRoot = capture('wsl.exe', ['-d', distro, '-u', user, '-e', 'wslpath', '-a', packageRoot]);
  const script = [
    'set -eu',
    'source="$1"',
    'releases="$2"',
    'version="$3"',
    'mkdir -p "$releases"',
    'destination="$releases/${version}.$(date +%s).$$"',
    'mkdir "$destination"',
    'trap \'rm -rf "$destination"\' EXIT',
    `cp -R ${SERVICE_PACKAGE_ENTRIES.map((entry) => `"$source/${entry}"`).join(' ')} "$destination/"`,
    'trap - EXIT',
    'printf %s "$destination"',
  ].join('\n');
  const root = wslCapture(distro, user, ['bash', '-c', script, 'runnerize-copy', cleanWslOutput(windowsRoot), releases, manifest.version]);
  if (!root.startsWith(`${releases}/`)) throw new Error('Could not materialize the runnerize WSL service release.');
  return { root, bin: `${root}/bin/runnerize.js` };
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

function isolatedScheduledTasksScript(command) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; ${command}`, 'utf16le').toString('base64');
  return `& ${powershellLiteral(windowsPowerShellPath)} -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${powershellLiteral(encoded)}; if ($LASTEXITCODE -ne 0) { throw 'Scheduled task operation failed' }`;
}

export function systemTasksRemovalScript(taskNames) {
  return isolatedScheduledTasksScript(taskNames.flatMap((taskName) => [
    `Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue | Stop-ScheduledTask -ErrorAction SilentlyContinue`,
    `Get-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue`,
  ]).join('; '));
}

export function systemStartupTaskScript(spec) {
  const registration = [
    `$taskName = ${powershellLiteral(spec.taskName)}`,
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(spec.execute)} -Argument ${powershellLiteral(spec.argument)}`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    '$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\\SYSTEM" -LogonType ServiceAccount -RunLevel Highest',
    '$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
    'Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null',
  ].join('; ');
  // Isolate the CIM-backed ScheduledTasks cmdlets in their own PowerShell process. Commands
  // appended after them can crash Windows PowerShell while it exits on affected hosts.
  return isolatedScheduledTasksScript(registration);
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

function stopScheduledTask(taskName) {
  const script = `Stop-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction Stop`;
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  if (result.status !== 0) throw new Error(`Could not stop ${taskName}.`);
}

function startScheduledTask(taskName) {
  const script = `Start-ScheduledTask -TaskName ${powershellLiteral(taskName)} -ErrorAction Stop`;
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ]);
  if (result.status !== 0) throw new Error(`Could not start ${taskName}.`);
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
  const argument = wslCommandLine(context, systemdStartCommand());
  return {
    taskName: SERVICE_NAME,
    startupFileName: 'runnerize.vbs',
    execute: 'wsl.exe',
    argument,
    startupCommand: `wsl.exe ${argument}`,
  };
}

function materializeWindowsApp() {
  const manifest = servicePackageManifest();
  const root = windowsDataPath();
  const releases = windowsDataPath('releases');
  const temporary = join(releases, `${manifest.version}.new.${process.pid}`);
  const destination = join(releases, `${manifest.version}.${Date.now()}.${process.pid}`);
  mkdirSync(releases, { recursive: true });
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true });
  try {
    copyServicePackage(temporary);
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
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

function writeWindowsLauncher(appBin, { keepAwake = true } = {}) {
  const launcherPath = windowsDataPath('runnerize-windows.ps1');
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

// Arguments embedded in a generated .ps1 need PowerShell quoting, NOT the Win32 quoting used for
// wsl.exe does NOT strip surrounding double quotes from -d/-u values. Passing `-d "Ubuntu"` on a
// raw command line fails with WSL_E_DISTRO_NOT_FOUND and exit -1 (verified against WSL 2.6.3), so
// a Task Scheduler task built that way never starts anything. The spawnSync call sites are
// unaffected because they pass an argv array and Node leaves a bare word bare; only code that
// builds a command-line STRING is exposed - a Task Scheduler -Argument, or
// ProcessStartInfo.Arguments. The trailing -lc command is the exception: wsl.exe does honour
// quoting there, and it must stay quoted because it contains spaces and semicolons.
function wslCommandLine(context, command) {
  for (const [label, value] of [['distro', context.distro], ['user', context.user]]) {
    if (/[\s"]/.test(value)) {
      throw new Error(`The WSL ${label} name ${JSON.stringify(value)} contains whitespace or a quote. wsl.exe cannot receive that on a generated command line, so the auto-start task would silently fail.`);
    }
  }
  return `-d ${context.distro} -u ${context.user} -e bash -lc ${windowsCommandLineArg(command)}`;
}

// Emits a PowerShell helper that runs wsl.exe under a hard timeout. Without it a wedged wsl.exe
// blocks the caller forever: the keep-awake holder would stop probing while never advancing its
// failure counter, and the boot launcher would never reach its own deadline check. Windows
// PowerShell 5.1 runs on .NET Framework, whose ProcessStartInfo has no ArgumentList, so the
// argument string has to be a pre-built command line.
function powershellWslInvoker(timeoutMs) {
  return [
    'function Invoke-Wsl([string]$argumentString) {',
    '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
    "  $psi.FileName = 'wsl.exe'",
    '  $psi.Arguments = $argumentString',
    '  $psi.UseShellExecute = $false',
    '  $psi.CreateNoWindow = $true',
    '  $p = [System.Diagnostics.Process]::Start($psi)',
    '  if ($null -eq $p) { return 1 }',
    `  if (-not $p.WaitForExit(${timeoutMs})) { try { $p.Kill() } catch { }; return 1 }`,
    '  return $p.ExitCode',
    '}',
  ];
}

function wslKeepAwakeSpec(context) {
  const launcherPath = windowsDataPath('runnerize-wsl-keepawake.ps1');
  const activeArgs = wslCommandLine(context, 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active --quiet runnerize');
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, [
    "$ErrorActionPreference = 'SilentlyContinue'",
    'Add-Type -Namespace Runnerize -Name Native -MemberDefinition \'[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);\'',
    "[Runnerize.Native]::SetThreadExecutionState([Convert]::ToUInt32('80000001', 16)) | Out-Null",
    ...powershellWslInvoker(KEEPAWAKE_PROBE_TIMEOUT_MS),
    `$probeArgs = ${powershellLiteral(activeArgs)}`,
    '$failures = 0',
    'try {',
    '  while ($true) {',
    '    if ((Invoke-Wsl $probeArgs) -eq 0) {',
    '      $failures = 0',
    `      Start-Sleep -Seconds ${KEEPAWAKE_POLL_SECONDS}`,
    '      continue',
    '    }',
    // A single probe failure is not proof runnerize is gone: the unit may be restarting, or the
    // distro may still be booting. Retiring on the first failure leaves the distro to be idle-
    // terminated seconds later, which is the whole problem this holder exists to prevent.
    '    $failures++',
    `    if ($failures -ge ${KEEPAWAKE_MAX_CONSECUTIVE_FAILURES}) { exit 1 }`,
    `    Start-Sleep -Seconds ${KEEPAWAKE_RETRY_SECONDS}`,
    '  }',
    '} finally {',
    "  [Runnerize.Native]::SetThreadExecutionState([Convert]::ToUInt32('80000000', 16)) | Out-Null",
    '}',
    '',
  ].join('\r\n'));
  const argument = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsCommandLineArg(launcherPath)}`;
  return {
    taskName: 'runnerize-wsl-keepawake',
    startupFileName: 'runnerize-wsl-keepawake.vbs',
    execute: powershellPath,
    argument,
    launcherPath,
    startupCommand: `${windowsCommandLineArg(powershellPath)} ${argument}`,
  };
}

function wslBootSpec(context) {
  const launcherPath = windowsDataPath('runnerize-wsl-boot.ps1');
  const logPath = windowsDataPath('runnerize-wsl-boot.log');
  const startArgs = wslCommandLine(context, systemdStartCommand());
  mkdirSync(dirname(launcherPath), { recursive: true });
  writeFileSync(launcherPath, [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$log = ${powershellLiteral(logPath)}`,
    'function Write-Diag($message) { "$([DateTime]::UtcNow.ToString(\'o\')) $message" | Add-Content -LiteralPath $log }',
    ...powershellWslInvoker(WSL_BOOT_ATTEMPT_TIMEOUT_MS),
    `$startArgs = ${powershellLiteral(startArgs)}`,
    // S4U runs without an interactive profile, and a WSL2 distro is registered in its owning
    // user's hive. Recording the effective identity and whether that hive is actually visible is
    // the difference between a diagnosable cold-boot failure and a silent one that looks
    // identical to WSL merely being slow to come up.
    'Write-Diag "boot task running as $(whoami)"',
    'Write-Diag "Lxss registrations visible: $((Get-ChildItem \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\' -ErrorAction SilentlyContinue | Measure-Object).Count)"',
    `$deadline = (Get-Date).AddSeconds(${WSL_BOOT_DEADLINE_SECONDS})`,
    'while ((Get-Date) -lt $deadline) {',
    '  Write-Diag "wsl --list --verbose: $(& wsl.exe --list --verbose 2>&1)"',
    '  $code = Invoke-Wsl $startArgs',
    "  if ($code -eq 0) { Write-Diag 'dispatcher start succeeded'; exit 0 }",
    '  Write-Diag "dispatcher start failed with exit code $code; retrying"',
    `  Start-Sleep -Seconds ${WSL_BOOT_RETRY_SECONDS}`,
    '}',
    // Exit non-zero so Task Scheduler's restart policy engages. Falling out of the loop silently
    // would record a successful run and retire the task until the next boot.
    "Write-Diag 'giving up: WSL did not become ready before the deadline'",
    'exit 1',
    '',
  ].join('\r\n'));
  // A finite limit, unlike the keep-awake holder's unlimited one: this launcher is expected to
  // exit once WSL answers or the deadline passes. If wsl.exe hangs, the loop never reaches its own
  // deadline check, so Task Scheduler killing the run is what lets the restart policy retry.
  return bootCompanionSpec(`${SERVICE_NAME}-boot`, launcherPath, { executionTimeLimit: '(New-TimeSpan -Minutes 15)' });
}

function bootCompanionSpec(taskName, launcherPath, { executionTimeLimit = '([TimeSpan]::Zero)' } = {}) {
  return {
    taskName,
    execute: powershellPath,
    executionTimeLimit,
    argument: `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${windowsCommandLineArg(launcherPath)}`,
  };
}

// The generic scheduledTaskMatchesSpec only compares the action, which is not enough to confirm a
// startup companion: a same-named task carrying the same action but an at-logon trigger or the
// wrong principal would report success while unattended start stays broken.
function startupTaskMatchesSpec(spec) {
  const script = [
    `$task = Get-ScheduledTask -TaskName ${powershellLiteral(spec.taskName)} -ErrorAction SilentlyContinue`,
    'if ($null -eq $task) { exit 1 }',
    '$a = $task.Actions | Select-Object -First 1',
    `if ($a.Execute -ne ${powershellLiteral(spec.execute)} -or $a.Arguments -ne ${powershellLiteral(spec.argument)}) { exit 1 }`,
    "if (-not ($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' })) { exit 1 }",
    "if ($task.Principal.LogonType -ne 'S4U') { exit 1 }",
    'exit 0',
  ].join('; ');
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true });
  return result.status === 0;
}

function startupTaskScript(spec, windowsUser) {
  return [
    `$taskName = ${powershellLiteral(spec.taskName)}`,
    `$user = ${powershellLiteral(windowsUser)}`,
    `$action = New-ScheduledTaskAction -Execute ${powershellLiteral(spec.execute)} -Argument ${powershellLiteral(spec.argument)}`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    // Deliberately not the SYSTEM principal systemStartupTaskScript uses: a WSL2 distro is
    // registered under the owning user's HKCU hive, so SYSTEM cannot resolve it at all. S4U runs
    // as that user with no stored password and no interactive session.
    '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited',
    `$settings = New-ScheduledTaskSettingsSet -Hidden -ExecutionTimeLimit ${spec.executionTimeLimit} -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries`,
    'Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Unregister-ScheduledTask -Confirm:$false -ErrorAction Stop',
    'Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null',
  ].join('; ');
}

// Best-effort by design: this only adds unattended-boot coverage on top of the logon trigger, so a
// host that refuses the registration keeps working exactly as it did before. Reports instead of
// throwing so a failure here never fails an otherwise good install.
async function installStartupCompanion(spec, { noElevate = false, elevationTimeoutMs } = {}) {
  const windowsUser = currentWindowsUser();
  const script = startupTaskScript(spec, windowsUser);
  console.log(`Registering startup task ${spec.taskName}...`);
  const result = captureResult(powershellPath, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', taskSchedulerAttemptScript(script),
  ], { encoding: 'utf8', windowsHide: true });
  // Same post-success powershell.exe crash tolerance as installLogonTrigger: confirm against Task
  // Scheduler itself rather than trusting the exit code alone.
  if (result.status === 0 || startupTaskMatchesSpec(spec)) {
    return { ok: true, detail: `task ${spec.taskName} for ${windowsUser}` };
  }
  if (isAccessDenied(result) && !noElevate) {
    const elevated = await runElevated('install', script, { timeoutMs: elevationTimeoutMs });
    if (elevated.ok && startupTaskMatchesSpec(spec)) {
      return { ok: true, detail: `task ${spec.taskName} for ${windowsUser} (elevated)` };
    }
    return { ok: false, reason: elevated.ok ? 'registration could not be confirmed' : elevated.reason };
  }
  return {
    ok: false,
    reason: result.stderr?.trim() || result.stdout?.trim() || result.error?.message || `exit code ${result.status}`,
  };
}

async function installWindows({ noElevate = false, elevationTimeoutMs, noGuard = false, force = false, update = false, installGuardOperation = installGuard } = {}) {
  const audit = await auditWindowsPrerequisites({ noElevate, elevationTimeoutMs });
  if (audit.rebootRequired) return;

  const previousStates = update ? await serviceStates() : [];
  const requiredBackends = new Set(previousStates.filter((state) => state.installed).map((state) => state.backend.startsWith('linux (WSL') ? 'linux' : state.backend));
  const statuses = [];
  let context;
  let linuxInstalled = false;
  let windowsInstalled = false;
  let linuxError;
  let windowsError;
  try {
    context = resolveWslContext();
    console.log(`WSL distro: ${context.distro} (user ${context.user})`);
    const preflight = await preflightWsl(context);
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
    const installCommand = [
      ...serviceEnvironment,
      node.path,
      installation.bin,
      'service',
      'install',
      ...(force ? ['--force'] : []),
    ];
    wslRun(context.distro, context.user, systemdWslArgs(installCommand));
    const legacyNodeDir = `${context.home}/.cache/runnerize/node`;
    try {
      wslRun(context.distro, context.user, ['rm', '-rf', legacyNodeDir]);
    } catch (error) {
      console.warn(`The service is running from durable storage, but the old cached Node installation at ${legacyNodeDir} could not be removed: ${error.message}`);
    }
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
      const previousWindowsRoot = windowsServiceState().root;
      const wasRunning = scheduledTaskIsRunning(windowsTaskName);
      if (wasRunning && (update || force)) stopScheduledTask(windowsTaskName);
      let installation;
      try {
        installation = materializeWindowsApp();
        persistWindowsTokenIfNeeded();
        const launcher = writeWindowsLauncher(installation.bin);
        const trigger = await installLogonTrigger(windowsTriggerSpec(launcher), { noElevate, elevationTimeoutMs });
        if (update || force) startScheduledTask(windowsTaskName);
        writeFileSync(windowsDataPath('current-release'), installation.root, 'utf8');
        console.log(`Windows logon trigger: ${trigger.kind} (${trigger.detail})`);
      } catch (error) {
        if ((update || force) && previousWindowsRoot) {
          try {
            const launcher = writeWindowsLauncher(join(previousWindowsRoot, 'bin', 'runnerize.js'));
            await installLogonTrigger(windowsTriggerSpec(launcher), { noElevate, elevationTimeoutMs });
            if (wasRunning) startScheduledTask(windowsTaskName);
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], `Windows update failed and the previous dispatcher could not be restored: ${error.message}`);
          }
        }
        throw error;
      }
      console.log(`Windows dispatcher log: ${windowsDataPath('runnerize-windows.log')}`);
      console.log(`runnerize package: ${installation.root}`);
      windowsInstalled = true;
      statuses.push('windows=installed');
    } catch (error) {
      windowsError = error;
      console.warn(`Windows backend unavailable: ${error.message}`);
      statuses.push('windows=unavailable');
    }
  } else {
    console.warn('Windows backend unavailable: wsb.exe was not found.');
    statuses.push('windows=unavailable');
  }

  // Required whenever the Linux backend is installed, NOT only when the Windows backend is absent.
  // The Windows dispatcher's own SetThreadExecutionState hold keeps the HOST awake, which is a
  // different thing: nothing else keeps a WSL client session attached, and WSL idle-terminates the
  // distro regardless of whether the host is awake. Gating this on !windowsInstalled left the Linux
  // dispatcher being torn down seconds after every start on hosts that have both backends.
  if (context && linuxInstalled) {
    const keepAwake = wslKeepAwakeSpec(context);
    const trigger = await installLogonTrigger(keepAwake, { noElevate, elevationTimeoutMs });
    console.log(`WSL host keep-awake trigger: ${trigger.kind} (${trigger.detail})`);

    // Companions to the logon triggers, not replacements: an always-on CI host that reboots
    // unattended never sees a logon, so the at-logon tasks alone leave Linux runners dark until
    // somebody signs in. The logon tasks are left exactly as they are, so a host where S4U cannot
    // resolve the distro is no worse off than before.
    for (const companion of [wslBootSpec(context), bootCompanionSpec(`${keepAwake.taskName}-boot`, keepAwake.launcherPath)]) {
      const registered = await installStartupCompanion(companion, { noElevate, elevationTimeoutMs });
      if (registered.ok) console.log(`Unattended startup trigger: ${registered.detail}`);
      else console.warn(`Could not register the unattended startup task ${companion.taskName}: ${registered.reason}. Linux runners will still start at logon.`);
    }
  }

  console.log(`Backend summary: ${statuses.join(', ')}`);
  if (update) {
    const failed = [...requiredBackends].filter((backend) => backend === 'linux' ? !linuxInstalled : !windowsInstalled);
    if (failed.length) {
      throw new AggregateError(
        [linuxError, windowsError].filter(Boolean),
        `Could not update every installed runnerize backend: ${failed.join(', ')}.`,
      );
    }
  }
  if (!statuses.some((status) => status.endsWith('=installed'))) {
    throw linuxError ?? windowsError ?? new Error('No runnerize backend is available on this Windows host.');
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
    const installationRoot = `${context.home}/.local/share/runnerize-service`;
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, systemdWslArgs([
      'systemctl', '--user', 'disable', '--now', `${SERVICE_NAME}.service`,
    ])));
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, ['rm', '-f', `${context.home}/.config/systemd/user/${SERVICE_NAME}.service`]));
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, systemdWslArgs([
      'systemctl', '--user', 'daemon-reload',
    ])));
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, ['loginctl', 'disable-linger', context.user]));
    bestEffort('wsl.exe', wslArgs(context.distro, context.user, [
      'rm',
      '-rf',
      installationRoot,
      `${context.home}/.local/share/runnerize/node`,
      `${context.home}/.cache/runnerize/node`,
      `${context.home}/.config/runnerize`,
    ]));
  }

  for (const taskName of [SERVICE_NAME, `${SERVICE_NAME}-boot`, 'runnerize-windows', 'runnerize-wsl-keepawake', 'runnerize-wsl-keepawake-boot']) {
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
  for (const artifact of ['app', 'releases', 'current-release', 'runnerize-windows.ps1', 'runnerize-wsl-keepawake.ps1', 'runnerize-wsl-boot.ps1', 'runnerize-wsl-boot.log', 'windows.token', 'runnerize-windows.log']) {
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
  if (platform() === 'darwin') return installLaunchd({ force: options.force });
  if (platform() === 'win32') return installWindows({
    noElevate: elevationDisabled(options),
    elevationTimeoutMs: options.elevationTimeoutMs,
    noGuard: options.noGuard,
    force: options.force,
    update: options.update,
    installGuardOperation: options.installGuardOperation,
  });
  if (!commandExists('systemctl')) {
    throw new Error('systemd is required to install runnerize as a Linux/WSL service.');
  }
  return installSystemd({ force: options.force });
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
