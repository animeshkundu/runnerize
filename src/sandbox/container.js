import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
const RUNTIME_PROBE_TIMEOUT_MS = 10_000;
const WSL_OPERATION_TIMEOUT_MS = 30_000;
const IMAGE_OPERATION_TIMEOUT_MS = 300_000;
const CAPABILITY_PROBE_TIMEOUT_MS = 60_000;
const CAPABILITY_PROBE_TTL_MS = 5 * 60_000;
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
command -v find >/dev/null
command -v grep >/dev/null
command -v realpath >/dev/null
command -v runuser >/dev/null
command -v sed >/dev/null
command -v sudo >/dev/null
command -v tar >/dev/null
command -v visudo >/dev/null
awk '($1 == 0 && $2 != 0) { mapped=1 } END { exit mapped ? 0 : 1 }' /proc/self/uid_map
install -d -m 0755 /opt/runnerize/bin /opt/runnerize/libexec
install -d -m 0711 /tmp/runnerize-build
install -d -m 0700 /tmp/runnerize-build/home /tmp/runnerize-build/run /tmp/runnerize-build/runroot /tmp/runnerize-build/storage
printf '{}' > /tmp/runnerize-build/auth.json
printf '[storage]\\ndriver="vfs"\\ngraphroot="/tmp/runnerize-build/storage"\\nrunroot="/tmp/runnerize-build/runroot"\\n[storage.options.vfs]\\nignore_chown_errors="true"\\n' > /tmp/runnerize-build/storage.conf
cat > /opt/runnerize/libexec/buildah-build <<'RUNNERIZE_BUILD_HELPER'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 && "\${SUDO_USER:-}" == runner ]] || {
  echo "runnerize: the build helper must be invoked by runner through sudo" >&2
  exit 125
}
args=()
context=
expect_value=
while [[ "$#" -gt 0 ]]; do
  arg="$1"
  shift
  if [[ "$expect_value" ]]; then
    if [[ "$expect_value" == file ]]; then
      [[ "$arg" ]] || exit 125
      args+=(--file "$arg")
    else
      args+=("$arg")
    fi
    expect_value=
    continue
  fi
  case "$arg" in
    --authfile|--build-arg-file|--build-context|--cache-from|--cache-to|--cap-add|--cap-drop|--cdi-config-dir|--cdi-spec-dir|--cert-dir|--cgroup-parent|--cgroupns|--cni-config-dir|--cni-plugin-path|--decryption-key|--device|--from|--group-add|--hooks-dir|--ignorefile|--iidfile|--ipc|--isolation|--logfile|--network|--output|--pid|--runtime|--runtime-flag|--secret|--security-opt|--sign-by|--ssh|--userns|--userns-gid-map|--userns-gid-map-group|--userns-uid-map|--userns-uid-map-user|--uts|--volume|-o|-v)
      echo "runnerize: unsupported build option: $arg" >&2
      exit 125
      ;;
    --authfile=*|--build-arg-file=*|--build-context=*|--cache-from=*|--cache-to=*|--cap-add=*|--cap-drop=*|--cdi-config-dir=*|--cdi-spec-dir=*|--cert-dir=*|--cgroup-parent=*|--cgroupns=*|--cni-config-dir=*|--cni-plugin-path=*|--decryption-key=*|--device=*|--from=*|--group-add=*|--hooks-dir=*|--ignorefile=*|--iidfile=*|--ipc=*|--isolation=*|--logfile=*|--network=*|--output=*|--pid=*|--runtime=*|--runtime-flag=*|--secret=*|--security-opt=*|--sign-by=*|--ssh=*|--userns=*|--userns-gid-map=*|--userns-gid-map-group=*|--userns-uid-map=*|--userns-uid-map-user=*|--uts=*|--volume=*|-o?*|-v?*)
      echo "runnerize: unsupported build option: $arg" >&2
      exit 125
      ;;
    -f|--file)
      args+=(--file)
      expect_value=file
      ;;
    -f?*)
      file="\${arg#-f}"
      [[ "$file" ]] || exit 125
      args+=(--file "$file")
      ;;
    --file=*)
      file="\${arg#--file=}"
      [[ "$file" ]] || exit 125
      args+=(--file "$file")
      ;;
    --add-host|--annotation|--arch|--build-arg|--cache-ttl|--cpu-period|--cpu-quota|--cpu-shares|-c|--cpuset-cpus|--cpuset-mems|--creds|--cw|--dns|--dns-option|--dns-search|--env|--format|--jobs|--label|--layer-label|--manifest|--memory|-m|--memory-swap|--os|--os-feature|--os-version|--platform|--retry|--retry-delay|--shm-size|--tag|-t|--target|--timestamp|--ulimit|--unsetenv|--unsetlabel|--variant)
      args+=("$arg")
      expect_value=value
      ;;
    --add-host=*|--annotation=*|--arch=*|--build-arg=*|--cache-ttl=*|--cpu-period=*|--cpu-quota=*|--cpu-shares=*|--cpuset-cpus=*|--cpuset-mems=*|--creds=*|--cw=*|--dns=*|--dns-option=*|--dns-search=*|--env=*|--format=*|--jobs=*|--label=*|--layer-label=*|--manifest=*|--memory=*|--memory-swap=*|--os=*|--os-feature=*|--os-version=*|--platform=*|--retry=*|--retry-delay=*|--shm-size=*|--tag=*|--target=*|--timestamp=*|--ulimit=*|--unsetenv=*|--unsetlabel=*|--variant=*|-c?*|-m?*|-t?*)
      args+=("$arg")
      ;;
    --compress|--disable-compression|--disable-content-trust|--force-rm|--help|-h|--http-proxy|--layers|--no-cache|--pull|--pull-always|--pull-never|--quiet|-q|--rm|--squash|--tls-verify)
      args+=("$arg")
      ;;
    --compress=*|--disable-compression=*|--disable-content-trust=*|--force-rm=*|--http-proxy=*|--layers=*|--no-cache=*|--pull=*|--quiet=*|--rm=*|--squash=*|--tls-verify=*)
      value="\${arg#*=}"
      [[ "$value" == true || "$value" == false ]] || {
        echo "runnerize: unsupported build option value: $arg" >&2
        exit 125
      }
      args+=("$arg")
      ;;
    -*)
      echo "runnerize: unsupported build option: $arg" >&2
      exit 125
      ;;
    *)
      if [[ "$context" ]]; then
        echo "runnerize: only one local build context is supported" >&2
        exit 125
      fi
      context="$arg"
      ;;
  esac
done
[[ ! "$expect_value" ]] || { echo "runnerize: missing build option value" >&2; exit 125; }
context="\${context:-.}"
context="$(runuser -u runner -- realpath -e -- "$context")"
[[ -d "$context" ]] || { echo "runnerize: build context must be a local directory" >&2; exit 125; }
stage_wrapper="$(mktemp -d /tmp/runnerize-build/wrapper.XXXXXX)"
source_context=
trap 'rm -rf -- "$stage_wrapper" "\${source_context:-/nonexistent}"' EXIT
staged_context="$stage_wrapper/context"
mkdir "$staged_context"
source_context="$(mktemp -d /tmp/runnerize-build/source.XXXXXX)"
chown runner:runner "$source_context"
chmod 0700 "$source_context"
runuser -u runner -- tar --create --file=- --directory="\${context:?}" . | runuser -u runner -- tar --extract --file=- --directory="\${source_context:?}"
cp -a --no-dereference -- "\${source_context:?}/." "\${staged_context:?}/"
chown -R root:root "$staged_context"
chmod 0700 "$staged_context"
rm -rf "$source_context"
if find "$staged_context" -xdev \\( -type b -o -type c -o -type p -o -type s \\) -print -quit | grep -q .; then
  echo "runnerize: build contexts may not contain special files" >&2
  exit 125
fi
if find "$staged_context" -xdev -type l -print0 | while IFS= read -r -d '' link; do
  resolved="$(realpath -e -- "$link")" || exit 1
  [[ "$resolved" == "$staged_context"/* ]] || exit 1
done; then
  :
else
  echo "runnerize: build context symlinks must resolve inside the context" >&2
  exit 125
fi
for ((index = 0; index < \${#args[@]}; index += 1)); do
  [[ "\${args[$index]}" == --file ]] || continue
  index=$((index + 1))
  file="\${args[$index]}"
  [[ "$file" != /* ]]
  resolved="$(realpath -e -- "$staged_context/$file")"
  [[ "$resolved" == "$staged_context"/* && -f "$resolved" ]]
  args[$index]="$resolved"
done
export BUILDAH_ISOLATION=chroot
export CONTAINERS_STORAGE_CONF=/tmp/runnerize-build/storage.conf
export HOME=/tmp/runnerize-build/home
export REGISTRY_AUTH_FILE=/tmp/runnerize-build/auth.json
export STORAGE_DRIVER=vfs
export XDG_RUNTIME_DIR=/tmp/runnerize-build/run
/usr/bin/buildah build --cap-drop all "\${args[@]}" "$staged_context"
RUNNERIZE_BUILD_HELPER
cat > /opt/runnerize/bin/container-build <<'RUNNERIZE_BUILD_WRAPPER'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -eq 0 || "$1" != build ]]; then
  echo "runnerize: only the build subcommand is available" >&2
  exit 125
fi
shift
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
const STOPPED_CONTAINER_STATES = new Set(['configured', 'created', 'dead', 'exited', 'stopped']);
const INSPECT_EVIDENCE_FIELDS = ['OOMKilled', 'ExitCode', 'Status', 'Error', 'StartedAt', 'FinishedAt'];
const activeRunnerContainers = new Set();

function appendBounded(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= DIAGNOSTICS_MAX_BYTES
    ? combined
    : combined.subarray(combined.length - DIAGNOSTICS_MAX_BYTES);
}

function collect(command, args, options = {}) {
  const { timeoutMs = WSL_OPERATION_TIMEOUT_MS, ...spawnOptions } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('subprocess timeoutMs must be a positive finite number');
  }
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
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new Error(`${command} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref?.();
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
      await collect(runtime, ['--version'], { timeoutMs: RUNTIME_PROBE_TIMEOUT_MS });
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
    const { stdout } = await collect('wsl.exe', ['-l', '-q'], {
      timeoutMs: WSL_OPERATION_TIMEOUT_MS,
    });
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
        await collect('wsl.exe', ['-d', distro, '-e', runtime, '--version'], {
          timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
        });
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

const KVM_STATUS_SCRIPT = `
if [[ ! -e /dev/kvm ]]; then
  if grep -Eqm1 '(^|[[:space:]])(vmx|svm)([[:space:]]|$)' /proc/cpuinfo; then
    printf 'missing-device'
  else
    printf 'no-virtualization'
  fi
elif exec 3<>/dev/kvm 2>/dev/null; then
  printf 'usable'
else
  printf 'permission-denied'
fi
`;

// A boolean made a one-command permission fix indistinguishable from unsupported hardware.
export async function kvmStatus(target) {
  if (!target) return {
    status: 'unavailable',
    usable: false,
    why: 'KVM was not checked because no Linux container runtime is available.',
  };
  const command = target.distro ? 'wsl.exe' : 'bash';
  const args = target.distro
    ? ['-d', target.distro, '-e', 'bash', '-c', KVM_STATUS_SCRIPT]
    : ['-c', KVM_STATUS_SCRIPT];
  try {
    const { stdout } = await collect(command, args, { timeoutMs: KVM_PROBE_TIMEOUT_MS });
    switch (stdout.trim()) {
      case 'usable':
        return {
          status: 'usable',
          usable: true,
          why: 'KVM acceleration is available; Linux runners advertise the kvm label.',
        };
      case 'permission-denied':
        return {
          status: 'permission-denied',
          usable: false,
          why: '/dev/kvm exists but the dispatcher user cannot open it for reading and writing.',
          command: target.distro
            ? 'sudo usermod -aG kvm "$USER"  # then run `wsl.exe --shutdown` from Windows and restart WSL'
            : 'sudo usermod -aG kvm "$USER"  # then log out and back in',
        };
      case 'missing-device':
        return {
          status: 'missing-device',
          usable: false,
          why: 'CPU virtualization extensions are present, but /dev/kvm is missing; enable nested virtualization or expose KVM to this Linux environment.',
        };
      case 'no-virtualization':
        return {
          status: 'no-virtualization',
          usable: false,
          why: 'CPU virtualization extensions (vmx/svm) are not exposed to this Linux environment.',
        };
      default:
        throw new Error(`unexpected KVM probe result: ${stdout.trim() || 'empty output'}`);
    }
  } catch (error) {
    return {
      status: 'probe-failed',
      usable: false,
      why: `KVM capability could not be determined: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function hasUsableKvm(target) {
  return (await kvmStatus(target)).usable;
}

function buildContainerArgs(image) {
  return ['--user', '0', '-e', 'RUNNERIZE_CONTAINER_BUILD_PROFILE=1', image];
}

// Enabled unless explicitly switched off. Reading the raw variable for truthiness would treat
// RUNNERIZE_CONTAINER_BUILDS=0 as "on", which is the opposite of what anyone setting it means.
function containerBuildsRequested() {
  const raw = process.env.RUNNERIZE_CONTAINER_BUILDS;
  if (raw === undefined || raw.trim() === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

async function hasUsableContainerBuild(target, image) {
  if (!target || !containerBuildsRequested()) {
    invalidateContainerBuildProbe();
    return false;
  }
  const probeKey = `${target.runtime}\0${target.distro || ''}\0${image}`;
  if (linux.containerBuildProbeKey === probeKey
    && Date.now() - linux.containerBuildProbeResolvedAt < CAPABILITY_PROBE_TTL_MS) {
    return true;
  }
  const args = ['run', '--rm', ...buildContainerArgs(image), 'bash', '-lc', `
set -euo pipefail
${BUILD_SETUP_SCRIPT}
context="$(runuser -u runner -- mktemp -d)"
cp "$(command -v busybox)" "$context/busybox"
printf 'FROM scratch\\nCOPY busybox /busybox\\nRUN ["/busybox", "true"]\\n' > "$context/Containerfile"
for command in docker podman buildah; do
  runuser -u runner -- env "PATH=${BUILD_BIN_DIR}:$PATH" "$command" build -t "localhost/runnerize-capability-probe-$command" "$context" >/dev/null
done
printf 'FROM scratch\nCOPY busybox /busybox\nRUN ["/busybox", "grep", "-q", "CapBnd:[[:space:]]*0000000000000000", "/proc/self/status"]\n' > "$context/Containerfile"
runuser -u runner -- env "PATH=${BUILD_BIN_DIR}:$PATH" docker build -t localhost/runnerize-capability-probe-no-chroot "$context" >/dev/null
if runuser -u runner -- sudo -n /usr/bin/id -u >/dev/null 2>&1; then
  exit 1
fi
set +e
runuser -u runner -- env "PATH=${BUILD_BIN_DIR}:$PATH" docker build --volume /:/host "$context" >/dev/null 2>&1
blocked_status=$?
set -e
[[ "$blocked_status" == 125 ]]
for option in '--volume=/tmp:/host' '--runtime=/bin/sh' '--userns=host'; do
  set +e
  runuser -u runner -- sudo -n /opt/runnerize/libexec/buildah-build "$option" "$context" >/dev/null 2>&1
  blocked_status=$?
  set -e
  [[ "$blocked_status" == 125 ]]
done
mkdir -p "$context/escape"
ln -s /etc/passwd "$context/escape/Dockerfile"
set +e
runuser -u runner -- env "PATH=${BUILD_BIN_DIR}:$PATH" docker build -f escape/Dockerfile "$context" >/dev/null 2>&1
symlink_status=$?
set -e
[[ "$symlink_status" != 0 ]]
rm -rf "$context/escape"
rm -f "$context/Containerfile"
rm -rf "$context"
`];
  const call = invocation(target, args, process.env);
  try {
    await collect(call.command, call.args, { env: call.env, timeoutMs: CAPABILITY_PROBE_TIMEOUT_MS });
    linux.containerBuildProbeKey = probeKey;
    linux.containerBuildProbeResolvedAt = Date.now();
    return true;
  } catch {
    invalidateContainerBuildProbe();
    return false;
  }
}

function invalidateContainerBuildProbe() {
  linux.containerBuildProbeKey = null;
  linux.containerBuildProbeResolvedAt = 0;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function wslPath(distro, windowsPath) {
  const { stdout } = await collect(
    'wsl.exe',
    ['-d', distro, '-e', 'wslpath', '-a', windowsPath],
    { timeoutMs: WSL_OPERATION_TIMEOUT_MS },
  );
  return stdout.trim();
}

function wslShell(distro, script, args = []) {
  return collect(
    'wsl.exe',
    ['-d', distro, '-e', 'bash', '-lc', script, 'runnerize', ...args],
    { timeoutMs: WSL_OPERATION_TIMEOUT_MS },
  );
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
  move_error="$(mktemp "$HOME/.cache/runnerize/runners/.move-error.XXXXXX")"
  if mv -T "$temporary" "$destination" 2>"$move_error"; then
    rm -f "$move_error"
  elif [[ ! -x "$destination/run.sh" ]]; then
    cat "$move_error" >&2
    rm -f "$move_error"
    exit 1
  else
    rm -f "$move_error"
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

async function killContainer(target, name, signal) {
  const call = invocation(target, ['kill', '--signal', signal, name], process.env);
  try {
    await collect(call.command, call.args, { env: call.env, timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch {
    // The container may already have exited.
  }
}

async function inspectContainer(target, name) {
  const call = invocation(target, ['inspect', '--format', '{{json .State}}', name], process.env);
  const { stdout } = await collect(call.command, call.args, {
    env: call.env,
    timeoutMs: CLEANUP_TIMEOUT_MS,
  });
  return JSON.parse(stdout.trim());
}

function normalizeObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('observation.json did not contain an object');
  }
  const observation = {};
  if (value.memoryMetricsAvailable === true) {
    if (![1, 2].includes(value.memoryCgroupVersion)) {
      throw new Error('observation.json contained an invalid memory cgroup version');
    }
    if (!Number.isSafeInteger(value.memoryPeakBytes) || value.memoryPeakBytes < 0) {
      throw new Error('observation.json contained an invalid memory peak');
    }
    observation.memoryMetricsAvailable = true;
    observation.memoryCgroupVersion = value.memoryCgroupVersion;
    observation.memoryPeakBytes = value.memoryPeakBytes;
    if (value.memoryEvents && typeof value.memoryEvents === 'object' && !Array.isArray(value.memoryEvents)) {
      observation.memoryEvents = Object.fromEntries(Object.entries(value.memoryEvents).filter(
        ([key, count]) => key && Number.isSafeInteger(count) && count >= 0,
      ));
    }
  } else {
    observation.memoryMetricsAvailable = false;
    if (typeof value.memoryMetricsUnavailableReason === 'string' && value.memoryMetricsUnavailableReason) {
      observation.memoryMetricsUnavailableReason = value.memoryMetricsUnavailableReason;
    }
  }
  if (Number.isSafeInteger(value.workdirDiskPeakBytes) && value.workdirDiskPeakBytes >= 0) {
    observation.workdirDiskPeakBytes = value.workdirDiskPeakBytes;
  }
  return observation;
}

async function readObservation(target, observationDir) {
  let contents;
  if (target.distro) {
    contents = await readTextFile(target, `${observationDir}/observation.json`);
  } else {
    contents = await readFile(path.join(observationDir, 'observation.json'), 'utf8');
  }
  return normalizeObservation(JSON.parse(contents));
}

async function readTextFile(target, file) {
  const command = target.distro ? 'wsl.exe' : 'cat';
  const args = target.distro
    ? ['-d', target.distro, '-e', 'cat', '--', file]
    : ['--', file];
  const { stdout } = await collect(command, args, { timeoutMs: CLEANUP_TIMEOUT_MS });
  return stdout;
}

async function createWslObservationDir(distro) {
  const { stdout } = await wslShell(distro, `
set -euo pipefail
directory="$(mktemp -d /tmp/runnerize-observation.XXXXXX)"
chmod 0777 "$directory"
printf '%s' "$directory"
`);
  return stdout.trim();
}

async function removeWslDirectory(distro, directory) {
  if (!directory) return;
  try {
    await collect('wsl.exe', ['-d', distro, '-e', 'rm', '-rf', '--', directory], {
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
  } catch {
    // Best-effort cleanup after the observation has been consumed.
  }
}

async function waitForContainerExit(target, name) {
  const call = invocation(target, ['wait', name], process.env);
  try {
    await collect(call.command, call.args, { env: call.env, timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch {
    // Inspection below remains useful if waiting is unsupported or times out.
  }
}

async function removeContainer(target, name) {
  const call = invocation(target, ['rm', '-f', name], process.env);
  try {
    await collect(call.command, call.args, { env: call.env, timeoutMs: CLEANUP_TIMEOUT_MS });
    return true;
  } catch (error) {
    console.warn(JSON.stringify({
      time: new Date().toISOString(),
      event: 'container_remove_error',
      container: name,
      error: error instanceof Error ? error.message : String(error),
    }));
    // A later orphan-reaping pass can retry failed cleanup.
    return false;
  }
}

async function listRunnerContainers(target, { stoppedOnly = false } = {}) {
  const call = invocation(target, [
    'ps', '-a', '--filter', 'name=^runnerize-', '--format', '{{.Names}}\t{{.State}}',
  ], process.env);
  const { stdout } = await collect(call.command, call.args, {
    env: call.env,
    timeoutMs: CLEANUP_TIMEOUT_MS,
  });
  return stdout.split(/\r?\n/).map((line) => {
    const [name, state] = line.trim().split(/\t/, 2);
    return { name, state: state?.toLowerCase() };
  }).filter(({ name, state }) => (
    name.startsWith('runnerize-')
      && (!stoppedOnly || STOPPED_CONTAINER_STATES.has(state))
  )).map(({ name }) => name);
}

// Keep runner-output heuristics here so lifecycle wording changes have one update point.
function isJobStartLine(line) {
  return /\bRunning job(?:\s*:|\b)|\bJob\s+.+?\s+(?:started|running)\b/i.test(line);
}

const INNER_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail
observation_dir="\${RUNNERIZE_OBSERVE:-}"
workdir=
runner_pid=
runner_pgid=
disk_monitor_pid=
finished=0

sample_disk() {
  local current
  [[ "$observation_dir" && "$workdir" ]] || return 0
  current="$(du -sk -- "$workdir/_work" 2>/dev/null | awk '{print $1}' || true)"
  if [[ "$current" =~ ^[0-9]+$ ]]; then
    local previous=0
    [[ -f "$observation_dir/disk-peak-kib" ]] && previous="$(cat "$observation_dir/disk-peak-kib" 2>/dev/null || printf 0)"
    if [[ ! "$previous" =~ ^[0-9]+$ || "$current" -gt "$previous" ]]; then
      printf '%s\n' "$current" > "$observation_dir/disk-peak-kib.tmp"
      mv -f "$observation_dir/disk-peak-kib.tmp" "$observation_dir/disk-peak-kib"
    fi
  fi
}

monitor_disk() {
  local sleep_pid=
  trap 'if [[ "$sleep_pid" ]]; then kill "$sleep_pid" 2>/dev/null || true; fi; exit 0' TERM INT HUP
  while [[ "$workdir" && -d "$workdir" ]]; do
    sample_disk
    sleep 5 &
    sleep_pid=$!
    wait "$sleep_pid" || break
    sleep_pid=
  done
}

write_observation() {
  [[ "$observation_dir" ]] || return 0
  mkdir -p "$observation_dir"
  sample_disk

  local cgroup_version=
  local cgroup_path=
  local memory_peak=
  local memory_available=false
  local unavailable_reason=
  local memory_events_json='{}'
  local disk_peak_kib=
  local hierarchy controllers candidate
  while IFS=: read -r hierarchy controllers candidate; do
    if [[ "$hierarchy" == 0 && -z "$controllers" ]]; then
      cgroup_version=2
      cgroup_path="$candidate"
    fi
    if [[ ",\${controllers}," == *,memory,* ]]; then
      cgroup_version=1
      cgroup_path="$candidate"
    fi
  done < /proc/self/cgroup

  if [[ "$cgroup_version" == 2 ]]; then
    local cgroup_root="/sys/fs/cgroup/\${cgroup_path#/}"
    memory_peak="$(cat "$cgroup_root/memory.peak" 2>/dev/null || true)"
    if [[ "$memory_peak" =~ ^[0-9]+$ ]]; then
      memory_available=true
      local separator=
      local key value
      memory_events_json='{'
      if [[ -r "$cgroup_root/memory.events" ]]; then
        while read -r key value; do
          [[ "$key" && "$value" =~ ^[0-9]+$ ]] || continue
          local entry
          printf -v entry '%s"%s":%s' "$separator" "$key" "$value"
          memory_events_json+="$entry"
          separator=,
        done < "$cgroup_root/memory.events"
      fi
      memory_events_json+='}'
    else
      unavailable_reason='cgroup v2 memory.peak is unavailable; rootless runtimes may require systemd Delegate=yes and a delegated memory controller'
    fi
  elif [[ "$cgroup_version" == 1 ]]; then
    local cgroup_root="/sys/fs/cgroup/memory/\${cgroup_path#/}"
    memory_peak="$(cat "$cgroup_root/memory.max_usage_in_bytes" 2>/dev/null || true)"
    if [[ "$memory_peak" =~ ^[0-9]+$ ]]; then
      memory_available=true
    else
      unavailable_reason='cgroup v1 memory.max_usage_in_bytes is unavailable; rootless runtimes may require systemd Delegate=yes and a delegated memory controller'
    fi
  else
    unavailable_reason='no cgroup memory controller was exposed; rootless runtimes may require systemd Delegate=yes and a delegated memory controller'
  fi

  disk_peak_kib="$(cat "$observation_dir/disk-peak-kib" 2>/dev/null || true)"
  local tmp="$observation_dir/observation.json.tmp"
  {
    printf '{"memoryMetricsAvailable":%s' "$memory_available"
    if [[ "$memory_available" == true ]]; then
      printf ',"memoryCgroupVersion":%s,"memoryPeakBytes":%s' "$cgroup_version" "$memory_peak"
      [[ "$cgroup_version" == 2 ]] && printf ',"memoryEvents":%s' "$memory_events_json"
    else
      printf ',"memoryMetricsUnavailableReason":"%s"' "$unavailable_reason"
    fi
    if [[ "$disk_peak_kib" =~ ^[0-9]+$ ]]; then
      printf ',"workdirDiskPeakBytes":%s' "$((disk_peak_kib * 1024))"
    fi
    printf '}\n'
  } > "$tmp"
  mv -f "$tmp" "$observation_dir/observation.json"
}

finish() {
  local status=$?
  [[ "$finished" == 0 ]] || return "$status"
  finished=1
  trap - EXIT TERM INT HUP
  if [[ "$runner_pid" && "$runner_pid" != "$BASHPID" ]]; then
    if [[ "$runner_pgid" =~ ^[0-9]+$ ]]; then
      kill -TERM -- "-$runner_pgid" 2>/dev/null || true
    else
      kill -TERM "$runner_pid" 2>/dev/null || true
    fi
    for _ in 1 2 3 4 5; do
      kill -0 "$runner_pid" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$runner_pid" 2>/dev/null; then
      if [[ "$runner_pgid" =~ ^[0-9]+$ ]]; then
        kill -KILL -- "-$runner_pgid" 2>/dev/null || true
      else
        kill -KILL "$runner_pid" 2>/dev/null || true
      fi
    fi
  fi
  if [[ "$disk_monitor_pid" ]]; then
    kill -TERM "$disk_monitor_pid" 2>/dev/null || true
    wait "$disk_monitor_pid" 2>/dev/null || true
  fi
  write_observation || true
  [[ "$workdir" ]] && rm -rf -- "$workdir"
  return "$status"
}
trap finish EXIT
terminate_runner() {
  local signal="$1"
  local status="$2"
  if [[ "$runner_pid" && "$runner_pid" != "$BASHPID" ]]; then
    if [[ "$runner_pgid" =~ ^[0-9]+$ ]]; then
      kill -"$signal" -- "-$runner_pgid" 2>/dev/null || true
    else
      kill -"$signal" "$runner_pid" 2>/dev/null || true
    fi
  fi
  exit "$status"
}
trap 'terminate_runner TERM 143' TERM
trap 'terminate_runner INT 130' INT
trap 'terminate_runner HUP 129' HUP

if [[ "\${RUNNERIZE_CONTAINER_BUILD_PROFILE:-}" ]]; then
${BUILD_SETUP_SCRIPT}
  workdir="$(runuser -u runner -- mktemp -d)"
  cp -a /rsrc/. "$workdir/"
  chown -R runner:runner "$workdir"
  rm -rf "$workdir"/_work "$workdir"/_diag "$workdir"/.runner "$workdir"/.credentials*
  monitor_disk &
  disk_monitor_pid=$!
  setsid runuser -u runner -- env \
    JITCFG="$JITCFG" \
    MAX_LIFETIME_SECONDS="\${MAX_LIFETIME_SECONDS:-604800}" \
    PATH="${BUILD_BIN_DIR}:$PATH" \
    timeout --signal=TERM --kill-after=10s "\${MAX_LIFETIME_SECONDS:-604800}s" \
    "$workdir/run.sh" --jitconfig "$JITCFG" &
else
  workdir="$(mktemp -d)"
  cp -a /rsrc/. "$workdir/"
  cd "$workdir"
  rm -rf _work _diag .runner .credentials*
  export RUNNER_ALLOW_RUNASROOT=1
  monitor_disk &
  disk_monitor_pid=$!
  setsid timeout --signal=TERM --kill-after=10s "\${MAX_LIFETIME_SECONDS:-604800}s" \
    ./run.sh --jitconfig "$JITCFG" &
fi
runner_pid=$!
runner_pgid=$runner_pid
set +e
wait "$runner_pid"
runner_status=$?
set -e
runner_pid=
runner_pgid=
exit "$runner_status"
`;

export const linux = {
  key: 'linux',
  labels: [...BASE_LINUX_LABELS],
  kvm: false,
  containerBuild: false,
  containerBuildProbeKey: null,
  containerBuildProbeResolvedAt: 0,

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

  async reapOrphans({
    protectedRunnerNames = new Set(),
    reconciliationComplete = false,
  } = {}) {
    if (!reconciliationComplete || protectedRunnerNames.size) return 0;
    const target = await backend();
    if (!target) return 0;
    const names = (await listRunnerContainers(target))
      .filter((name) => !activeRunnerContainers.has(name));
    const removed = await Promise.all(names.map((name) => removeContainer(target, name)));
    return removed.filter(Boolean).length;
  },

  async launch(encodedJitConfig, {
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
    onStarted,
    onControl,
    onFailureDiagnostics,
    onTeardownObservation,
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
    let containerBuild = false;
    if (linux.containerBuild) {
      containerBuild = await hasUsableContainerBuild(target, image);
      if (!containerBuild) {
        linux.containerBuild = false;
        linux.labels = linux.labels.filter((label) => label !== BUILD_CAPABILITY_LABEL);
      }
    }
    try {
      if (target.distro) {
        const inspect = invocation(target, ['image', 'inspect', image], process.env);
        try {
          await collect(inspect.command, inspect.args, {
            env: inspect.env,
            timeoutMs: IMAGE_OPERATION_TIMEOUT_MS,
          });
        } catch {
          const pull = invocation(target, ['pull', image], process.env);
          await collect(pull.command, pull.args, {
            env: pull.env,
            timeoutMs: IMAGE_OPERATION_TIMEOUT_MS,
          });
        }
      } else {
        await ensureImage(image);
      }
    } catch (error) {
      if (containerBuild) invalidateContainerBuildProbe();
      throw error;
    }

    let temporary;
    let mountedScript;
    let observationDir;
    let name;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let failed = false;
    let startedJob = false;
    let termination;
    let forceKill;
    let cleanupDoneResolve;
    const cleanupDone = new Promise((resolve) => { cleanupDoneResolve = resolve; });
    let containerStartedAt;

    try {
      const runnerDir = process.env.RUNNERIZE_RUNNER_DIR || await ensureRunnerBinary({ os: 'linux', arch: 'x64' });
      let mountedRunner;
      if (target.distro) {
        mountedRunner = await stageWslRunner(target.distro, runnerDir);
        mountedScript = await createWslInnerScript(target.distro);
        observationDir = await createWslObservationDir(target.distro);
      } else {
        temporary = await mkdtemp(path.join(os.tmpdir(), 'runnerize-'));
        mountedScript = path.join(temporary, 'inner.sh');
        observationDir = path.join(temporary, 'observation');
        await mkdir(observationDir, { mode: 0o777 });
        await chmod(observationDir, 0o777);
        await writeFile(mountedScript, INNER_SCRIPT, { mode: 0o644 });
        await chmod(mountedScript, 0o644);
        mountedRunner = runnerDir;
      }

      name = `runnerize-${randomUUID()}`;
      activeRunnerContainers.add(name);
      const args = [
        'run', '--name', name, '-e', 'JITCFG', '-e', 'MAX_LIFETIME_SECONDS',
        '-e', 'RUNNERIZE_OBSERVE=/runnerize-observation',
        '-v', `${mountedRunner}:/rsrc:ro`,
        '-v', `${mountedScript}:/inner.sh:ro`,
        '-v', `${observationDir}:/runnerize-observation`,
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

      return await new Promise((resolve, reject) => {
        const child = spawn(call.command, call.args, {
          env: call.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdoutRemainder = '';
        let stderrRemainder = '';
        let timedOut = false;
        let settled = false;
        let forceTimer;
        let killTimer;
        let lifetimeExpired = false;

        const settle = (callback, { failed: didFail = false } = {}) => {
          if (settled) return;
          settled = true;
          failed = didFail;
          clearTimeout(timer);
          clearTimeout(lifetimeTimer);
          if (forceTimer) clearTimeout(forceTimer);
          if (killTimer) clearTimeout(killTimer);
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
          if (settled) return Promise.resolve();
          if (termination) return termination;
          termination = killContainer(target, name, 'TERM');
          child.kill('SIGTERM');
          killTimer = setTimeout(() => {
            forceKill = killContainer(target, name, 'KILL');
            child.kill('SIGKILL');
          }, KILL_GRACE_MS);
          killTimer.unref?.();
          forceTimer = setTimeout(() => settle(
            () => lifetimeExpired
              ? reject(new Error(`runner exceeded maximum lifetime of ${maxLifetimeMs}ms`))
              : resolve({ startedJob: false }),
            { failed: true },
          ), FORCE_SETTLE_MS);
          forceTimer.unref?.();
          return termination;
        };
        onControl?.({
          name,
          stop: async () => {
            await terminate();
            await cleanupDone;
          },
        });
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
          try {
            stdout = appendBounded(stdout, chunk);
            stdoutRemainder = observeOutput(chunk.toString(), stdoutRemainder);
          } catch (error) {
            settle(() => reject(error), { failed: true });
          }
        });
        child.stderr.on('data', (chunk) => {
          try {
            stderr = appendBounded(stderr, chunk);
            stderrRemainder = observeOutput(chunk.toString(), stderrRemainder);
          } catch (error) {
            settle(() => reject(error), { failed: true });
          }
        });
        const markContainerStarted = () => { containerStartedAt ??= Date.now(); };
        child.once('error', (error) => settle(() => reject(error), { failed: true }));
        child.once('spawn', markContainerStarted);
        if (child.pid !== undefined) markContainerStarted();
        child.once('close', (code) => settle(() => {
          if (lifetimeExpired) reject(new Error(`runner exceeded maximum lifetime of ${maxLifetimeMs}ms`));
          else if (timedOut) resolve({ startedJob: false });
          else if (code === 0) resolve({ startedJob });
          else reject(new Error(`${target.runtime} runner container exited with code ${code}: ${stderr.toString().trim()}`));
        }, { failed: lifetimeExpired || timedOut || code !== 0 }));
      });
    } catch (error) {
      failed = true;
      if (containerBuild) invalidateContainerBuildProbe();
      throw error;
    } finally {
      try {
        if (termination) await termination;
        if (forceKill) await forceKill;
        let inspect;
        try {
          inspect = await inspectContainer(target, name);
          if (!STOPPED_CONTAINER_STATES.has(inspect.Status?.toLowerCase())) {
            await waitForContainerExit(target, name);
            inspect = await inspectContainer(target, name);
          }
        } catch {
          // Inspection is best-effort and must not change the launch outcome.
        }
        if (failed) {
          try {
            onFailureDiagnostics?.({
              stdout: stdout.toString(),
              stderr: stderr.toString(),
              ...(inspect ? { inspect } : {}),
            });
          } catch {
            // Diagnostics must not change the launch outcome.
          }
        }
        if (name) {
          let measured;
          try {
            measured = await readObservation(target, observationDir);
          } catch (error) {
            measured = {
              memoryMetricsAvailable: false,
              memoryMetricsUnavailableReason:
                `final cgroup observation unavailable (${error.message}); rootless runtimes may require systemd Delegate=yes and a delegated memory controller`,
            };
          }
          const observation = {
            container: name,
            runtime: target.runtime,
            startedJob,
            failed,
            durationMs: Math.max(0, Date.now() - (containerStartedAt ?? Date.now())),
            ...measured,
          };
          if (inspect) {
            observation.inspect = inspect;
            for (const field of INSPECT_EVIDENCE_FIELDS) {
              if (Object.hasOwn(inspect, field)) observation[field] = inspect[field];
            }
          }
          try {
            await onTeardownObservation?.(observation);
          } catch {
            // Observability must not change the launch outcome.
          } finally {
            await removeContainer(target, name);
          }
        }
        if (target.distro) {
          await removeWslFile(target.distro, mountedScript);
          await removeWslDirectory(target.distro, observationDir);
        } else if (temporary) {
          await rm(temporary, { recursive: true, force: true });
        }
      } finally {
        if (name) activeRunnerContainers.delete(name);
        cleanupDoneResolve();
      }
    }
  },
};
