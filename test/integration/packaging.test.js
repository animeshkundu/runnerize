// Packaging coverage: the path every real user takes.
//
// `npx runnerize@latest service install` runs from an npm-installed copy inside a cache
// directory, not from a checkout. That layout is where package-root resolution, the runtime
// manifest read and the zero-dependency assertion actually get exercised, and nothing tested it
// — a package that ships without `src/` or resolves its root to the wrong directory would
// install a broken service and only fail on the user's machine.
//
// This packs the real tarball, installs it the way npx does, and drives it from there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// Node refuses to execFile a .cmd shim (CVE-2024-27980), so npm.cmd cannot be spawned directly;
// go through the command processor and let Node escape the arguments.
function npmRun(args, options = {}) {
  return process.platform === 'win32'
    ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], options)
    : run('npm', args, options);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

test('the CLI runs when reached through a symlinked path', { skip: process.platform === 'win32' && 'symlink creation needs elevation on Windows' }, () => {
  // ESM resolves import.meta.url through symlinks while argv[1] keeps the path as typed, so a
  // verbatim comparison of the two decides "was I run directly?" incorrectly and main() never
  // fires — the process exits 0 having printed nothing. On macOS this hits every $TMPDIR path,
  // because /var/folders/... is a symlink to /private/var/folders/....
  const staging = mkdtempSync(join(tmpdir(), 'runnerize-symlink-'));
  try {
    const real = join(staging, 'real');
    const link = join(staging, 'link');
    cpSync(join(projectRoot, 'bin'), join(real, 'bin'), { recursive: true });
    cpSync(join(projectRoot, 'src'), join(real, 'src'), { recursive: true });
    cpSync(join(projectRoot, 'package.json'), join(real, 'package.json'));
    symlinkSync(real, link, 'dir');

    for (const [label, root] of [['real path', real], ['symlink', link]]) {
      const result = run(process.execPath, [join(root, 'bin', 'runnerize.js'), '--help']);
      assert.match(result.stdout, /runnerize - on-demand ephemeral GitHub Actions runners/,
        `the CLI produced no output via its ${label}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test('the published package installs and runs from an npm layout', { timeout: 300_000 }, () => {
  const staging = mkdtempSync(join(tmpdir(), 'runnerize-pack-'));
  try {
    const packed = npmRun(['pack', '--pack-destination', staging], { cwd: projectRoot });
    assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr}`);
    const tarball = packed.stdout.trim().split(/\r?\n/).at(-1);
    assert.ok(tarball, 'npm pack printed no tarball name');

    const install = npmRun(['install', '--no-save', '--silent', '--prefix', staging, join(staging, tarball)], { cwd: staging });
    assert.equal(install.status, 0, `installing the tarball failed: ${install.stderr}`);

    const installed = join(staging, 'node_modules', 'runnerize');
    const entry = join(installed, 'bin', 'runnerize.js');

    // Everything `service install` copies into a release has to survive packing. Losing src/
    // would still produce a working `--help` and a service that dies on first start.
    for (const entryPath of ['package.json', join('bin', 'runnerize.js'), join('src', 'service.js'), join('src', 'sandbox', 'container.js')]) {
      assert.ok(existsSync(join(installed, entryPath)), `${entryPath} is missing from the published package`);
    }

    // The zero-dependency assertion in servicePackageManifest() only holds if the published
    // manifest really declares none; a dependency would need node_modules that is never copied.
    const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies, undefined, 'the published package must declare no runtime dependencies');
    assert.equal(manifest.optionalDependencies, undefined, 'the published package must declare no optional dependencies');

    const help = run(process.execPath, [entry, '--help']);
    assert.equal(help.status, 0, `--help failed from the installed package: ${help.stderr}`);
    assert.match(help.stdout, /runnerize - on-demand ephemeral GitHub Actions runners/);

    // `service install` mutates the host, so drive the read-only sibling instead: it runs the
    // same package-root resolution and manifest read that install depends on. Resolving to the
    // wrong root is the failure this guards, so assert it did not throw looking for one.
    const status = run(process.execPath, [entry, 'service', 'status'], { timeout: 240_000 });
    const output = `${status.stdout}${status.stderr}`;
    assert.doesNotMatch(output, /Cannot resolve the runnerize package root/,
      'the installed copy must resolve its own package root');
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module/,
      'the installed copy must not be missing modules');
    assert.match(output, /Command package: runnerize \d+\.\d+\.\d+/,
      'the installed copy reports its version');
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});
