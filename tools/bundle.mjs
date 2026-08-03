#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const ESBUILD_VERSION = '0.25.12';
const ESBUILD_RELEASES = {
  'darwin-arm64': ['darwin-arm64', '2e0d011f852e45046ca5c107db54cfc56338f77aca49d227a063696d958451d7', 'package/bin/esbuild'],
  'darwin-x64': ['darwin-x64', 'bf56cdf7b330a8605395ee13de805c784c7346d0802c7cced8490b4bfac2291a', 'package/bin/esbuild'],
  'linux-arm64': ['linux-arm64', 'd5e01d210e026823d559e2b82554cdcdab6fd87c4a57b519b392ef183c1f87fd', 'package/bin/esbuild'],
  'linux-x64': ['linux-x64', 'f7efc127658a108dcda9d4210b01804ee8f5d6b3acbd6d63f20aa51d3b50bd5f', 'package/bin/esbuild'],
  'win32-x64': ['win32-x64', 'c77076b48f96323cae6257bd515e5ea96ecf38ab8f7fa34364d4fc4ae5905b74', 'package/esbuild.exe'],
};
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(projectRoot, 'dist', 'runnerize.mjs');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function download(url, destination) {
  return new Promise((resolveDownload, reject) => {
    const request = get(url, { headers: { 'user-agent': 'runnerize-bundler' } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
        response.resume();
        download(new URL(response.headers.location, url), destination).then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`esbuild download failed with HTTP ${response.statusCode}.`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        writeFileSync(destination, Buffer.concat(chunks));
        resolveDownload();
      });
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function ensureEsbuild() {
  const key = `${platform()}-${arch()}`;
  const release = ESBUILD_RELEASES[key];
  if (!release) throw new Error(`unsupported esbuild platform: ${key}`);
  const [packageName, expectedHash, archiveBinary] = release;
  const cacheDir = join(homedir(), '.cache', 'runnerize', 'esbuild', ESBUILD_VERSION, key);
  const archive = join(cacheDir, `${packageName}.tgz`);
  mkdirSync(cacheDir, { recursive: true });

  if (!existsSync(archive) || sha256(archive) !== expectedHash) {
    rmSync(archive, { force: true });
    const temporaryArchive = `${archive}.${process.pid}.tmp`;
    rmSync(temporaryArchive, { force: true });
    await download(`https://registry.npmjs.org/@esbuild/${packageName}/-/${packageName}-${ESBUILD_VERSION}.tgz`, temporaryArchive);
    if (sha256(temporaryArchive) !== expectedHash) {
      rmSync(temporaryArchive, { force: true });
      throw new Error('esbuild archive SHA-256 mismatch.');
    }
    renameSync(temporaryArchive, archive);
  }

  // Recheck the cached archive before extracting its binary for this run.
  if (sha256(archive) !== expectedHash) throw new Error('cached esbuild archive SHA-256 mismatch.');
  const extraction = mkdtempSync(join(tmpdir(), 'runnerize-esbuild-'));
  try {
    if (platform() === 'win32') {
      // Git Bash tar treats drive-letter paths as remote hosts. Extract from the
      // cache directory into a temporary child when running on Windows.
      const localExtraction = mkdtempSync(join(cacheDir, 'extract-'));
      try {
        execFileSync('tar', ['-xzf', `${packageName}.tgz`, '-C', localExtraction.slice(cacheDir.length + 1), archiveBinary], {
          cwd: cacheDir,
          stdio: 'inherit',
        });
        const binary = join(extraction, 'esbuild.exe');
        copyFileSync(join(localExtraction, archiveBinary), binary);
        return { binary, cleanup: extraction };
      } finally {
        rmSync(localExtraction, { force: true, recursive: true });
      }
    }
    execFileSync('tar', ['-xzf', archive, '-C', extraction, archiveBinary], { stdio: 'inherit' });
    const binary = join(extraction, archiveBinary);
    chmodSync(binary, 0o755);
    return { binary, cleanup: extraction };
  } catch (error) {
    rmSync(extraction, { force: true, recursive: true });
    throw error;
  }
}

function packageVersion() {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new Error('runnerize package version is invalid.');
  }
  return manifest.version;
}

function sourceIdentity(version) {
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  const commit = git.status === 0 ? git.stdout.trim() : 'unavailable';
  const sourceHash = createHash('sha256');
  for (const directory of ['bin', 'src']) {
    const files = execFileSync('git', ['ls-files', directory], { cwd: projectRoot, encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).sort();
    for (const file of files) {
      sourceHash.update(file).update('\0').update(readFileSync(join(projectRoot, file))).update('\0');
    }
  }
  return { commit, sourceHash: sourceHash.update(version).digest('hex') };
}

function buildAt(esbuild, parent, version, identity) {
  const tree = join(parent, 'tree');
  const output = join(parent, 'runnerize.mjs');
  mkdirSync(tree, { recursive: true });
  cpSync(join(projectRoot, 'bin'), join(tree, 'bin'), { recursive: true });
  cpSync(join(projectRoot, 'src'), join(tree, 'src'), { recursive: true });
  writeFileSync(join(tree, 'src', 'version.js'), [
    `export const RUNNERIZE_VERSION = ${JSON.stringify(version)};`,
    `export const RUNNERIZE_VERSION_LABEL = ${JSON.stringify(`runnerize-${version}`)};`,
    '',
  ].join('\n'));
  const entry = join(tree, 'bin', 'runnerize.js');
  const entrySource = readFileSync(entry, 'utf8');
  writeFileSync(entry, entrySource.replace(/^#![^\n]*\n/, ''));
  execFileSync(esbuild, [
    join('bin', 'runnerize.js'),
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node20',
    `--outfile=${output}`,
    '--banner:js=#!/usr/bin/env node',
    `--footer:js=// runnerize-build-version: ${version}\n// runnerize-build-commit: ${identity.commit}\n// runnerize-source-sha256: ${identity.sourceHash}`,
    '--log-level=warning',
  ], { cwd: tree, stdio: 'inherit' });
  return output;
}

const esbuild = await ensureEsbuild();
const version = packageVersion();
const identity = sourceIdentity(version);
const firstRoot = mkdtempSync(join(tmpdir(), 'runnerize-bundle-a-'));
const secondRoot = mkdtempSync(join(tmpdir(), 'runnerize-bundle-b-different-path-'));
try {
  const first = buildAt(esbuild.binary, firstRoot, version, identity);
  const second = buildAt(esbuild.binary, secondRoot, version, identity);
  const firstHash = sha256(first);
  if (firstHash !== sha256(second)) throw new Error('bundle is not deterministic across absolute paths.');

  if (process.argv.includes('--check')) {
    if (!existsSync(outputPath)) throw new Error('dist/runnerize.mjs is absent.');
    if (sha256(outputPath) !== firstHash) throw new Error('dist/runnerize.mjs is stale or was built from a different commit/version.');
    console.log(`Verified dist/runnerize.mjs (${firstHash}).`);
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    const temporaryOutput = `${outputPath}.${process.pid}.tmp`;
    copyFileSync(first, temporaryOutput);
    renameSync(temporaryOutput, outputPath);
    chmodSync(outputPath, 0o755);
    console.log(`Built dist/runnerize.mjs (${firstHash}).`);
  }
} finally {
  rmSync(firstRoot, { force: true, recursive: true });
  rmSync(secondRoot, { force: true, recursive: true });
  rmSync(esbuild.cleanup, { force: true, recursive: true });
}
