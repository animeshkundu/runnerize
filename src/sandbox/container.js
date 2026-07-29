import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ensureImage, ensureRunnerBinary } from '../runner.js';
import { RUNNERIZE_VERSION_LABEL } from '../version.js';

// Fully qualified so rootless podman resolves it without needing an
// unqualified-search-registries entry in registries.conf (podman errors 125 on a
// bare short name; docker is lenient, so this stays correct there too).
export const DEFAULT_LINUX_IMAGE = 'docker.io/catthehacker/ubuntu:full-latest';
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 1_000;
const FORCE_SETTLE_MS = 7_000;
const DIAGNOSTICS_MAX_BYTES = 64 * 1024;
const CAPABILITY_PROBE_TIMEOUT_MS = 60_000;
const KVM_PROBE_TIMEOUT_MS = 5_000;
const BASE_LINUX_LABELS = ['self-hosted', 'linux', 'x64', RUNNERIZE_VERSION_LABEL];
const BUILD_CAPABILITY_LABEL = 'container-build';
const BUILD_BIN_DIR = '/opt/runnerize/bin';
const BUILD_SETUP_SCRIPT = `
set -euo pipefail
[[ "$(id -u)" == 0 && -d /home/runner ]]
[[ -x /usr/bin/buildah ]]
command -v awk >/dev/null
command -v busybox >/dev/null
command -v runuser >/dev/null
command -v sed >/dev/null
command -v sudo >/dev/null
command -v visudo >/dev/null
awk '($1 == 0 && $2 != 0) { mapped=1 } END { exit mapped ? 0 : 1 }' /proc/self/uid_map
install -d -m 0755 /opt/runnerize/bin /opt/runnerize/libexec
install -d -m 0700 /tmp/runnerize-build/home /tmp/runnerize-build/run /tmp/runnerize-build/runroot /tmp/runnerize-build/storage
printf '{}' > /tmp/runnerize-build/auth.json
printf '[storage]\\ndriver="vfs"\\ngraphroot="/tmp/runnerize-build/storage"\\nrunroot="/tmp/runnerize-build/runroot"\\n[storage.options.vfs]\\nignore_chown_errors="true"\\n' > /tmp/runnerize-build/storage.conf
cat > /opt/runnerize/libexec/buildah-build <<'RUNNERIZE_BUILD_HELPER'
#!/bin/sh
export BUILDAH_ISOLATION=chroot
export CONTAINERS_STORAGE_CONF=/tmp/runnerize-build/storage.conf
export HOME=/tmp/runnerize-build/home
export REGISTRY_AUTH_FILE=/tmp/runnerize-build/auth.json
export STORAGE_DRIVER=vfs
export XDG_RUNTIME_DIR=/tmp/runnerize-build/run
exec /usr/bin/buildah build "$@"
RUNNERIZE_BUILD_HELPER
cat > /opt/runnerize/bin/container-build <<'RUNNERIZE_BUILD_WRAPPER'
#!/bin/sh
if [ "$#" -eq 0 ] || [ "$1" != build ]; then
  echo "runnerize: only the build subcommand is available" >&2
  exit 125
fi
shift
for arg in "$@"; do
  case "$arg" in
    --cap-add|--cap-add=*|--cap-drop|--cap-drop=*|--cdi-config-dir|--cdi-config-dir=*|--cgroupns|--cgroupns=*|--device|--device=*|--group-add|--group-add=*|--hooks-dir|--hooks-dir=*|--ipc|--ipc=*|--isolation|--isolation=*|--network|--network=*|--pid|--pid=*|--runtime|--runtime=*|--runtime-flag|--runtime-flag=*|--security-opt|--security-opt=*|--userns|--userns=*|--userns-gid-map|--userns-gid-map=*|--userns-gid-map-group|--userns-gid-map-group=*|--userns-uid-map|--userns-uid-map=*|--userns-uid-map-user|--userns-uid-map-user=*|--uts|--uts=*|--volume|--volume=*|-v|-v*)
      echo "runnerize: unsupported build option: $arg" >&2
      exit 125
      ;;
  esac
done
exec sudo -n /opt/runnerize/libexec/buildah-build "$@"
RUNNERIZE_BUILD_WRAPPER
chmod 0755 /opt/runnerize/libexec/buildah-build /opt/runnerize/bin/container-build
ln -sf container-build /opt/runnerize/bin/buildah
ln -sf container-build /opt/runnerize/bin/docker
ln -sf container-build /opt/runnerize/bin/podman
for sudoers_file in /etc/sudoers /etc/sudoers.d/*; do
  [[ "$sudoers_file" == /etc/sudoers.d/runnerize-container-build ]] && continue
  [[ -f "$sudoers_file" ]] || continue
  sed -i -E '/^[[:space:]]*%?(runner|sudo|wheel)[[:space:]].*NOPASSWD/d' "$sudoers_file"
done
printf 'runner ALL=(root) NOPASSWD: /opt/runnerize/libexec/buildah-build\\n' > /etc/sudoers.d/runnerize-container-build
chmod 0440 /etc/sudoers.d/runnerize-container-build
visudo -cf /etc/sudoers >/dev/null
`;

function appendBounded(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= DIAGNOSTICS_MAX_BYTES
    ? combined
    : combined.subarray(combined.length - DIAGNOSTICS_MAX_BYTES);
}

function collect(command, args, options = {}) {
  const { timeoutMs, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      callback();
    };
    const timer = timeoutMs ? setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs) : null;
    timer?.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code) => settle(() => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`))));
  });
}

async function nativeRuntime() {
  for (const runtime of ['podman', 'docker']) {
    try {
      await collect(runtime, ['--version']);
      return runtime;
    } catch {
      // Try the next runtime.
    }
  }
  return null;
}

async function wslDistributions() {
  const configured = process.env.RUNNERIZE_WSL_DISTRO;
  if (configured) return [configured];
  try {
    const { stdout } = await collect('wsl.exe', ['-l', '-q']);
    return stdout.replaceAll('\0', '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function wslRuntime() {
  if (process.platform !== 'win32') return null;
  for (const distro of await wslDistributions()) {
    for (const runtime of ['podman', 'docker']) {
      try {
        await collect('wsl.exe', ['-d', distro, '-e', runtime, '--version']);
        return { runtime, distro };
      } catch {
        // Keep looking for an available runtime.
      }
    }
  }
  return null;
}

async function backend() {
  if (process.platform === 'win32') return wslRuntime();
  const runtime = await nativeRuntime();
  return runtime ? { runtime } : null;
}

async function hasUsableKvm(target) {
  if (!target) return false;
  const command = target.distro ? 'wsl.exe' : 'bash';
  const args = target.distro
    ? ['-d', target.distro, '-e', 'bash', '-c', 'exec 3<>/dev/kvm']
    : ['-c', 'exec 3<>/dev/kvm'];
  try {
    await collect(command, args, { timeoutMs: KVM_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function buildContainerArgs(image) {
  return ['--user', '0', '-e', 'RUNNERIZE_CONTAINER_BUILD_PROFILE=1', image];
}

async function hasUsableContainerBuild(target, image) {
  if (!target || !process.env.RUNNERIZE_CONTAINER_BUILDS) {
    linux.containerBuildProbeKey = null;
    return false;
  }
  const probeKey = `${target.runtime}\0${target.distro || ''}\0${image}`;
  if (linux.containerBuildProbeKey === probeKey) return true;
  const args = ['run', '--rm', ...buildContainerArgs(image), 'bash', '-lc', `
set -euo pipefail
${BUILD_SETUP_SCRIPT}
context="$(runuser -u runner -- mktemp -d)"
cp "$(command -v busybox)" "$context/busybox"
printf 'FROM scratch\\nCOPY busybox /busybox\\nRUN ["/busybox", "true"]\\n' > "$context/Containerfile"
runuser -u runner -- env "PATH=${BUILD_BIN_DIR}:$PATH" docker build -t localhost/runnerize-capability-probe "$context" >/dev/null
if runuser -u runner -- sudo -n /usr/bin/id -u >/dev/null 2>&1; then
  exit 1
fi
set +e
runuser -u runner -- env "PATH=${BUILD_BIN_DIR}:$PATH" docker build --volume /:/host "$context" >/dev/null 2>&1
blocked_status=$?
set -e
[[ "$blocked_status" == 125 ]]
rm -rf "$context"
`];
  const call = invocation(target, args, process.env);
  try {
    await collect(call.command, call.args, { env: call.env, timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS });
    linux.containerBuildProbeKey = probeKey;
    return true;
  } catch {
    linux.containerBuildProbeKey = null;
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function wslPath(distro, windowsPath) {
  const { stdout } = await collect('wsl.exe', ['-d', distro, '-e', 'wslpath', '-a', windowsPath]);
  return stdout.trim();
}

function wslShell(distro, script, args = []) {
  return collect('wsl.exe', ['-d', distro, '-e', 'bash', '-lc', script, 'runnerize', ...args]);
}

async function stageWslRunner(distro, runnerDir) {
  const source = /^[A-Za-z]:[\\/]/.test(runnerDir)
    ? await wslPath(distro, runnerDir)
    : runnerDir;
  if (!source.startsWith('/')) throw new Error('RUNNERIZE_RUNNER_DIR must be an absolute Windows or WSL path');

  const { stdout } = await wslShell(distro, `
set -euo pipefail
source_dir="$1"
version="$("$source_dir/bin/Runner.Listener" --version)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'runner source returned an invalid version' >&2; exit 1; }
destination="$HOME/.cache/runnerize/runners/$version"
if [[ ! -x "$destination/run.sh" ]]; then
  mkdir -p "$(dirname "$destination")"
  temporary="$(mktemp -d "$HOME/.cache/runnerize/runners/.runner.XXXXXX")"
  trap 'rm -rf "$temporary"' EXIT
  cp -a "$source_dir"/. "$temporary"/
  [[ -x "$temporary/run.sh" ]] || { echo 'runner source is missing run.sh' >&2; exit 1; }
  if mv -T "$temporary" "$destination" 2>/dev/null; then
    trap - EXIT
  fi
fi
printf '%s' "$destination"
`, [source]);
  return stdout;
}

async function createWslInnerScript(distro) {
  const encoded = Buffer.from(INNER_SCRIPT).toString('base64');
  const { stdout } = await wslShell(distro, `
set -euo pipefail
script="$(mktemp /tmp/runnerize-inner.XXXXXX)"
printf '%s' "$1" | base64 -d > "$script"
chmod 644 "$script"
printf '%s' "$script"
`, [encoded]);
  return stdout;
}

async function removeWslFile(distro, file) {
  if (!file) return;
  try {
    await collect('wsl.exe', ['-d', distro, '-e', 'rm', '-f', '--', file], { timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch {
    // Best-effort cleanup after the container exits.
  }
}

function invocation(target, runtimeArgs, env) {
  if (!target.distro) return { command: target.runtime, args: runtimeArgs, env };
  const commandLine = [target.runtime, ...runtimeArgs].map(shellQuote).join(' ');
  const existing = env.WSLENV ? `${env.WSLENV}:` : '';
  return {
    command: 'wsl.exe',
    args: ['-d', target.distro, '-e', 'bash', '-lc', commandLine],
    env: { ...env, WSLENV: `${existing}JITCFG:MAX_LIFETIME_SECONDS` },
  };
}

async function stopContainer(target, name) {
  const args = ['rm', '-f', name];
  const call = invocation(target, args, process.env);
  try {
    await collect(call.command, call.args, { env: call.env, timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch {
    // It may have exited between the watchdog firing and cleanup.
  }
}

async function listRunnerContainers(target) {
  const call = invocation(target, [
    'ps', '-a', '--filter', 'name=^runnerize-', '--format', '{{.Names}}',
  ], process.env);
  const { stdout } = await collect(call.command, call.args, {
    env: call.env,
    timeoutMs: CLEANUP_TIMEOUT_MS,
  });
  return stdout.split(/\r?\n/).map((name) => name.trim()).filter((name) => name.startsWith('runnerize-'));
}

// Keep runner-output heuristics here so lifecycle wording changes have one update point.
function isJobStartLine(line) {
  return /\bRunning job(?:\s*:|\b)|\bJob\s+.+?\s+(?:started|running)\b/i.test(line);
}

const INNER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${RUNNERIZE_CONTAINER_BUILD_PROFILE:-}" ]]; then
${BUILD_SETUP_SCRIPT}
  workdir="$(runuser -u runner -- mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT
  cp -a /rsrc/. "$workdir/"
  chown -R runner:runner "$workdir"
  rm -rf "$workdir"/_work "$workdir"/_diag "$workdir"/.runner "$workdir"/.credentials*
  exec runuser -u runner -- env \
    JITCFG="$JITCFG" \
    MAX_LIFETIME_SECONDS="\${MAX_LIFETIME_SECONDS:-604800}" \
    PATH="${BUILD_BIN_DIR}:$PATH" \
    timeout --signal=TERM --kill-after=10s "\${MAX_LIFETIME_SECONDS:-604800}s" \
    "$workdir/run.sh" --jitconfig "$JITCFG"
fi
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
cp -a /rsrc/. "$workdir/"
cd "$workdir"
rm -rf _work _diag .runner .credentials*
export RUNNER_ALLOW_RUNASROOT=1
exec timeout --signal=TERM --kill-after=10s "\${MAX_LIFETIME_SECONDS:-604800}s" ./run.sh --jitconfig "$JITCFG"
`;

export const linux = {
  key: 'linux',
  labels: [...BASE_LINUX_LABELS],
  kvm: false,
  containerBuild: false,
  containerBuildProbeKey: null,

  async available() {
    const target = await backend();
    const image = process.env.RUNNERIZE_LINUX_IMAGE || DEFAULT_LINUX_IMAGE;
    linux.kvm = await hasUsableKvm(target);
    linux.containerBuild = await hasUsableContainerBuild(target, image);
    linux.labels = [
      ...BASE_LINUX_LABELS,
      ...(linux.kvm ? ['kvm'] : []),
      ...(linux.containerBuild ? [BUILD_CAPABILITY_LABEL] : []),
    ];
    return Boolean(target);
  },

  async reapOrphans({ protectedRunnerNames = new Set() } = {}) {
    if (protectedRunnerNames.size) return 0;
    const target = await backend();
    if (!target) return 0;
    const names = await listRunnerContainers(target);
    await Promise.all(names.map((name) => stopContainer(target, name)));
    return names.length;
  },

  async launch(encodedJitConfig, {
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
    onStarted,
    onControl,
    onFailureDiagnostics,
  } = {}) {
    if (!encodedJitConfig || typeof encodedJitConfig !== 'string') {
      throw new TypeError('encodedJitConfig must be a non-empty string');
    }
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
      throw new RangeError('idleTimeoutMs must be a positive number');
    }
    if (!Number.isFinite(maxLifetimeMs) || maxLifetimeMs <= 0) {
      throw new RangeError('maxLifetimeMs must be a positive number');
    }

    const target = await backend();
    if (!target) throw new Error('podman or docker is required for the linux flavor');
    const kvm = linux.kvm && await hasUsableKvm(target);
    const image = process.env.RUNNERIZE_LINUX_IMAGE || DEFAULT_LINUX_IMAGE;
    const containerBuild = linux.containerBuild && await hasUsableContainerBuild(target, image);
    if (target.distro) {
      const inspect = invocation(target, ['image', 'inspect', image], process.env);
      try {
        await collect(inspect.command, inspect.args, { env: inspect.env });
      } catch {
        const pull = invocation(target, ['pull', image], process.env);
        await collect(pull.command, pull.args, { env: pull.env });
      }
    } else {
      await ensureImage(image);
    }

    const runnerDir = process.env.RUNNERIZE_RUNNER_DIR || await ensureRunnerBinary({ os: 'linux', arch: 'x64' });
    let temporary;
    let mountedRunner;
    let mountedScript;
    if (target.distro) {
      mountedRunner = await stageWslRunner(target.distro, runnerDir);
      mountedScript = await createWslInnerScript(target.distro);
    } else {
      temporary = await mkdtemp(path.join(os.tmpdir(), 'runnerize-'));
      mountedScript = path.join(temporary, 'inner.sh');
      await writeFile(mountedScript, INNER_SCRIPT, { mode: 0o644 });
      await chmod(mountedScript, 0o644);
      mountedRunner = runnerDir;
    }

    const name = `runnerize-${randomUUID()}`;
    const args = [
      'run', '--rm', '--name', name, '-e', 'JITCFG', '-e', 'MAX_LIFETIME_SECONDS',
      '-v', `${mountedRunner}:/rsrc:ro`,
      '-v', `${mountedScript}:/inner.sh:ro`,
      ...(kvm ? ['--device', '/dev/kvm'] : []),
      ...(containerBuild ? buildContainerArgs(image) : [image]),
      'bash', '/inner.sh',
    ];
    const env = {
      ...process.env,
      JITCFG: encodedJitConfig,
      MAX_LIFETIME_SECONDS: String(Math.max(1, Math.ceil(maxLifetimeMs / 1000))),
    };
    const call = invocation(target, args, env);

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(call.command, call.args, {
          env: call.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let startedJob = false;
        let stdoutRemainder = '';
        let stderrRemainder = '';
        let stdout = Buffer.alloc(0);
        let stderr = Buffer.alloc(0);
        let timedOut = false;
        let settled = false;
        let forceTimer;
        let killTimer;
        let lifetimeExpired = false;

        const failureDiagnostics = () => {
          try {
            onFailureDiagnostics?.({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
            });
          } catch {
            // Diagnostics must not change the launch outcome.
          }
        };
        const settle = (callback, { failed = false } = {}) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(lifetimeTimer);
          if (forceTimer) clearTimeout(forceTimer);
          if (killTimer) clearTimeout(killTimer);
          if (failed) failureDiagnostics();
          callback();
        };
        const observeOutput = (text, remainder) => {
          const buffered = remainder + text;
          const lines = buffered.split(/\r?\n/);
          const nextRemainder = lines.pop() || '';
          if (!startedJob && (lines.some(isJobStartLine) || isJobStartLine(nextRemainder))) {
            startedJob = true;
            clearTimeout(timer);
            onStarted?.();
          }
          return nextRemainder;
        };
        const terminate = () => {
          void stopContainer(target, name);
          child.kill('SIGTERM');
          killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
          killTimer.unref?.();
          forceTimer = setTimeout(() => settle(
            () => lifetimeExpired
              ? reject(new Error(`runner exceeded maximum lifetime of ${maxLifetimeMs}ms`))
              : resolve({ startedJob: false }),
            { failed: true },
          ), FORCE_SETTLE_MS);
          forceTimer.unref?.();
        };
        onControl?.({ name, stop: async () => { terminate(); await stopContainer(target, name); } });
        const timer = setTimeout(() => {
          if (startedJob) return;
          timedOut = true;
          terminate();
        }, idleTimeoutMs);
        timer.unref?.();
        const lifetimeTimer = setTimeout(() => {
          lifetimeExpired = true;
          terminate();
        }, maxLifetimeMs);
        lifetimeTimer.unref?.();

        child.stdout.on('data', (chunk) => {
          stdout = appendBounded(stdout, chunk);
          stdoutRemainder = observeOutput(chunk.toString(), stdoutRemainder);
        });
        child.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          stderr = appendBounded(stderr, chunk);
          stderrRemainder = observeOutput(text, stderrRemainder);
        });
        child.once('error', (error) => settle(() => reject(error), { failed: true }));
        child.once('close', (code) => settle(() => {
          if (lifetimeExpired) reject(new Error(`runner exceeded maximum lifetime of ${maxLifetimeMs}ms`));
          else if (timedOut) resolve({ startedJob: false });
          else if (code === 0) resolve({ startedJob });
          else reject(new Error(`${target.runtime} runner container exited with code ${code}: ${stderr.toString().trim()}`));
        }, { failed: lifetimeExpired || timedOut || code !== 0 }));
      });
    } finally {
      if (target.distro) await removeWslFile(target.distro, mountedScript);
      else await rm(temporary, { recursive: true, force: true });
    }
  },
};
