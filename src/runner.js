import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const API_URL = 'https://api.github.com/repos/actions/runner/releases/latest';
const USER_AGENT = 'runnerize/0.1';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function releaseMetadata() {
  const response = await fetch(API_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`failed to fetch actions runner release: HTTP ${response.status}`);
  return response.json();
}

export async function latestRunnerVersion() {
  const release = await releaseMetadata();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('actions runner release returned an invalid tag');
  return version;
}

function assetPlatform(osName) {
  if (osName === 'darwin') return { name: 'osx', extension: 'tar.gz' };
  if (osName === 'win32') return { name: 'win', extension: 'zip' };
  if (osName === 'linux') return { name: 'linux', extension: 'tar.gz' };
  throw new Error(`unsupported runner operating system: ${osName}`);
}

function bodyDigest(body, assetName) {
  const escaped = assetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = new RegExp(`([a-fA-F0-9]{64})\\s+[* ]?${escaped}`);
  const after = new RegExp(`${escaped}[^a-fA-F0-9]+([a-fA-F0-9]{64})`);
  return body?.match(before)?.[1] || body?.match(after)?.[1];
}

async function publishedDigest(release, asset, assetName) {
  if (typeof asset.digest === 'string' && /^sha256:[a-fA-F0-9]{64}$/.test(asset.digest)) {
    return asset.digest.slice(7).toLowerCase();
  }

  const checksumAsset = release.assets?.find(({ name }) => name === `${assetName}.sha256`);
  if (checksumAsset) {
    const response = await fetch(checksumAsset.browser_download_url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`failed to download runner checksum: HTTP ${response.status}`);
    const match = (await response.text()).match(/[a-fA-F0-9]{64}/);
    if (match) return match[0].toLowerCase();
  }

  const digest = bodyDigest(release.body, assetName);
  if (digest) return digest.toLowerCase();
  throw new Error(`release does not publish a SHA-256 digest for ${assetName}`);
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(300_000),
  });
  if (!response.ok) throw new Error(`failed to download actions runner: HTTP ${response.status}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Windows' System32 tar.exe is bsdtar (libarchive): it extracts both .zip and .tar.gz and
// handles drive-letter paths. A git-provided MSYS/GNU tar earlier on PATH would misread a
// "C:\..." archive path as a remote "host:path" and cannot read the .zip runner asset, so
// pin the system bsdtar by absolute path on Windows. Other hosts use tar from PATH.
export function extractionCommand(hostPlatform = process.platform) {
  if (hostPlatform === 'win32') {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

export async function ensureRunnerBinary({ os: osName, arch }) {
  if (arch !== 'x64' && arch !== 'arm64') throw new Error(`unsupported runner architecture: ${arch}`);
  const release = await releaseMetadata();
  const version = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('actions runner release returned an invalid tag');

  const platform = assetPlatform(osName);
  const assetName = `actions-runner-${platform.name}-${arch}-${version}.${platform.extension}`;
  const asset = release.assets?.find(({ name }) => name === assetName);
  if (!asset) throw new Error(`release asset not found: ${assetName}`);

  const cacheRoot = path.join(os.homedir(), '.runnerize', 'runners');
  const destination = path.join(cacheRoot, `${version}-${osName}-${arch}`);
  const executable = path.join(destination, osName === 'win32' ? 'run.cmd' : 'run.sh');
  if (await exists(executable)) return destination;

  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(cacheRoot, '.download-'));
  const archive = path.join(temporary, assetName);
  const extracted = path.join(temporary, 'extracted');
  try {
    await mkdir(extracted);
    const expected = await publishedDigest(release, asset, assetName);
    await download(asset.browser_download_url, archive);
    const actual = createHash('sha256').update(await readFile(archive)).digest('hex');
    if (actual !== expected) throw new Error(`SHA-256 verification failed for ${assetName}`);

    await run(extractionCommand(), ['-xf', archive, '-C', extracted]);
    if (osName === 'darwin') await run('xattr', ['-c', '-r', extracted]);
    if (!(await exists(path.join(extracted, osName === 'win32' ? 'run.cmd' : 'run.sh')))) {
      throw new Error('extracted actions runner is missing its run script');
    }

    try {
      await rename(extracted, destination);
    } catch (error) {
      if (!(await exists(executable))) throw error;
    }
    return destination;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function commandAvailable(command) {
  try {
    await run(command, ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function ensureImage(image) {
  if (!image || typeof image !== 'string') throw new TypeError('image must be a non-empty string');
  const runtime = await commandAvailable('podman') ? 'podman' : await commandAvailable('docker') ? 'docker' : null;
  if (!runtime) throw new Error('podman or docker is required for the linux flavor');
  try {
    await run(runtime, ['image', 'inspect', image]);
  } catch {
    await run(runtime, ['pull', image]);
  }
}
