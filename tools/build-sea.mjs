#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const NODE_VERSION = '26.5.1';
const TARGETS = {
  'win-x64': { archive: `node-v${NODE_VERSION}-win-x64.zip`, hash: 'c432c996b95cbf7568f13a0fbb37526de84a27e3a5c520c3be15f05a9a168212', executable: `node-v${NODE_VERSION}-win-x64/node.exe`, output: 'runnerize.exe' },
  'linux-x64': { archive: `node-v${NODE_VERSION}-linux-x64.tar.xz`, hash: 'cc7b3484ade63bd203a9d304f21ec37a3b622b988d7bdecf1dc4d68fc44a91b7', executable: `node-v${NODE_VERSION}-linux-x64/bin/node`, output: 'runnerize' },
  'darwin-arm64': { archive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, hash: 'f4387df0b46556516d19abf2f2d6806481ac8368aa7f9d96bafed422a56a1d01', executable: `node-v${NODE_VERSION}-darwin-arm64/bin/node`, output: 'runnerize' },
};
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function download(url, destination) {
  return new Promise((resolveDownload, reject) => {
    const request = get(url, { headers: { 'user-agent': 'runnerize-sea-builder' } }, (response) => {
      if ([301, 302, 307, 308].includes(response.statusCode)) {
        response.resume();
        download(new URL(response.headers.location, url), destination).then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Node.js download failed with HTTP ${response.statusCode}.`));
        return;
      }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => { writeFileSync(destination, Buffer.concat(chunks)); resolveDownload(); });
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function targetExecutable(targetName, target) {
  const cache = join(homedir(), '.cache', 'runnerize', 'node', NODE_VERSION, targetName);
  const archive = join(cache, target.archive);
  mkdirSync(cache, { recursive: true });
  if (!existsSync(archive) || sha256(archive) !== target.hash) {
    rmSync(archive, { force: true });
    const temporary = `${archive}.${process.pid}.tmp`;
    rmSync(temporary, { force: true });
    await download(`https://nodejs.org/dist/v${NODE_VERSION}/${target.archive}`, temporary);
    if (sha256(temporary) !== target.hash) {
      rmSync(temporary, { force: true });
      throw new Error(`Node.js ${targetName} archive SHA-256 mismatch.`);
    }
    renameSync(temporary, archive);
  }
  if (sha256(archive) !== target.hash) throw new Error(`Cached Node.js ${targetName} archive SHA-256 mismatch.`);
  const extraction = mkdtempSync(join(tmpdir(), 'runnerize-node-'));
  // Branch on the ARCHIVE, not the host. Cross-building the win-x64 target from Linux CI still
  // has to unpack a .zip, and GNU tar cannot read one.
  if (target.archive.endsWith('.zip')) {
    const localExtraction = mkdtempSync(join(cache, 'extract-'));
    try {
      execFileSync('unzip', ['-q', target.archive, '-d', localExtraction.slice(cache.length + 1)], { cwd: cache, stdio: 'inherit' });
      const source = join(localExtraction, ...target.executable.split('/'));
      const extracted = join(extraction, basename(source));
      copyFileSync(source, extracted);
      return { path: extracted, cleanup: extraction };
    } finally {
      rmSync(localExtraction, { recursive: true, force: true });
    }
  }
  // Pin bsdtar by absolute path on Windows. A Git-provided MSYS tar earlier on PATH reads the
  // leading "C:" of an absolute path as a remote host and fails with "Cannot connect to C:".
  // src/runner.js pins System32\tar.exe for exactly this reason.
  const tar = process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', extraction], { stdio: 'inherit' });
  return { path: join(extraction, ...target.executable.split('/')), cleanup: extraction };
}

const targetName = process.argv[2] || 'win-x64';
const target = TARGETS[targetName];
if (!target) throw new Error(`Unsupported SEA target ${targetName}. Choose: ${Object.keys(TARGETS).join(', ')}.`);
const bundle = join(projectRoot, 'dist', 'runnerize.mjs');
if (!existsSync(bundle)) execFileSync(process.execPath, [join(projectRoot, 'tools', 'bundle.mjs')], { cwd: projectRoot, stdio: 'inherit' });
const base = await targetExecutable(targetName, target);
const outputDir = join(projectRoot, 'dist', targetName);
const output = join(outputDir, target.output);
const staging = mkdtempSync(join(tmpdir(), 'runnerize-sea-'));
try {
  mkdirSync(outputDir, { recursive: true });
  const config = join(staging, 'sea.json');
  const temporaryOutput = join(staging, target.output);
  writeFileSync(config, JSON.stringify({
    main: bundle,
    output: temporaryOutput,
    executable: base.path,
    mainFormat: 'module',
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
  }));
  const builder = process.env.RUNNERIZE_SEA_BUILDER || process.execPath;
  execFileSync(builder, ['--build-sea', config], { cwd: projectRoot, stdio: 'inherit' });
  copyFileSync(temporaryOutput, output);
  if (targetName !== 'win-x64') chmodSync(output, 0o755);
  console.log(`Built ${output} from checksum-verified ${basename(base.path)}.`);
} finally {
  rmSync(staging, { recursive: true, force: true });
  rmSync(base.cleanup, { recursive: true, force: true });
}
