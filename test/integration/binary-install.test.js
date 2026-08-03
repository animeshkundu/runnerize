// Integration coverage for the compiled single-executable artifact.
//
// The unit suite exercises the binary LAYOUT with a stub file standing in for the executable,
// which proves the release shape and the ExecStart wiring but says nothing about whether the
// compiled artifact actually runs. The first SEA built during this work linked cleanly and then
// died on startup because package-root resolution assumed a file tree — exactly the class of
// fault a stub cannot catch.
//
// CI points RUNNERIZE_BINARY at a freshly built SEA on a host that can execute it. Without that
// the file skips rather than silently passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const binary = process.env.RUNNERIZE_BINARY;
// test/integration/<file> -> up three to the package root.
const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const treeEntry = join(projectRoot, 'bin', 'runnerize.js');
const skip = binary ? false : 'RUNNERIZE_BINARY is not set; build a SEA first (node tools/build-sea.mjs <target>)';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options });
}

test('the compiled executable is executable and behaves exactly like the source tree', { skip }, () => {
  accessSync(binary, constants.X_OK);

  // An unknown subcommand is a good probe: it reaches the CLI's own argument handling rather
  // than being intercepted by Node's flag parser, and it exercises a non-zero exit path.
  for (const args of [['wat'], [], ['guard', 'status']]) {
    const compiled = run(binary, args);
    const tree = run(process.execPath, [treeEntry, ...args]);
    assert.equal(compiled.stdout, tree.stdout, `stdout differs for: ${args.join(' ') || '(no args)'}`);
    assert.equal(compiled.status, tree.status, `exit code differs for: ${args.join(' ') || '(no args)'}`);
  }
});

test('the compiled executable resolves its own package root and version without a file tree', { skip }, () => {
  // This is the regression guard for SEA-awareness. Inside a single executable there is no
  // enclosing package.json, so anything that resolves a package root or reads a version by
  // walking the filesystem throws at startup. Running from a directory that contains no
  // runnerize checkout makes that failure mode reachable.
  const elsewhere = mkdtempSync(join(tmpdir(), 'runnerize-nowhere-'));
  try {
    const result = run(binary, ['service', 'status'], { cwd: elsewhere, timeout: 120_000 });
    const output = `${result.stdout}${result.stderr}`;
    assert.doesNotMatch(output, /Cannot resolve the runnerize package root/,
      'the executable must not look for an enclosing package.json');
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND|Cannot find module/,
      'the executable must not try to load modules from disk');
    assert.match(output, /Command package: runnerize \d+\.\d+\.\d+/,
      'the compiled-in version is reported');
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

// Materialization with a real executable — the copy, the mode bits, the release.json and the
// ExecStart wiring — is covered by test/unit/service.test.js instead. That suite already stubs
// preflight and the service manager, and CI's SEA job runs it with RUNNERIZE_BINARY pointed at
// the compiled artifact, so it exercises the real file rather than a stub. Driving a full
// `service install` from here would additionally need a container runtime and a GitHub
// credential, which would make the test fail for environmental reasons rather than packaging
// ones — a check that is red for the wrong reason is worse than no check.

