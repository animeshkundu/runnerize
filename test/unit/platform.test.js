import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { overrideProcess, patchReadFile, patchHostname } from '../helpers/platform-override.js';
import { ExecFileStub } from '../helpers/process-stub.js';
import { freshImport } from '../helpers/fresh-module.js';

const sha256 = (value) => createHash('sha256').update(value.trim()).digest('hex');

test('detectOS returns the platform for supported systems', async () => {
  const platform = await freshImport('../../src/platform.js');
  for (const os of ['linux', 'darwin', 'win32']) {
    const restore = overrideProcess({ platform: os });
    try {
      assert.equal(platform.detectOS(), os);
    } finally {
      restore();
    }
  }
});

test('detectOS throws on an unsupported platform', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restore = overrideProcess({ platform: 'aix' });
  try {
    assert.throws(() => platform.detectOS(), /unsupported operating system/);
  } finally {
    restore();
  }
});

test('detectArch accepts x64/arm64 and rejects others', async () => {
  const platform = await freshImport('../../src/platform.js');
  for (const arch of ['x64', 'arm64']) {
    const restore = overrideProcess({ arch });
    try {
      assert.equal(platform.detectArch(), arch);
    } finally {
      restore();
    }
  }
  const restore = overrideProcess({ arch: 'ia32' });
  try {
    assert.throws(() => platform.detectArch(), /unsupported architecture/);
  } finally {
    restore();
  }
});

test('isWSL: false on non-linux without touching the filesystem', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restore = overrideProcess({ platform: 'win32' });
  try {
    assert.equal(await platform.isWSL(), false);
  } finally {
    restore();
  }
});

test('isWSL: true when /proc/version advertises microsoft/WSL', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restoreProc = overrideProcess({ platform: 'linux' });
  const restoreRead = patchReadFile(async (file) => {
    assert.equal(file, '/proc/version');
    return 'Linux version 5.15.0 microsoft-standard-WSL2 ...';
  });
  try {
    assert.equal(await platform.isWSL(), true);
  } finally {
    restoreRead();
    restoreProc();
  }
});

test('isWSL: false on a bare-metal linux kernel', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restoreProc = overrideProcess({ platform: 'linux' });
  const restoreRead = patchReadFile(async () => 'Linux version 6.1.0-generic (gcc ...)');
  try {
    assert.equal(await platform.isWSL(), false);
  } finally {
    restoreRead();
    restoreProc();
  }
});

test('isWSL: false when /proc/version is unreadable', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restoreProc = overrideProcess({ platform: 'linux' });
  const restoreRead = patchReadFile(async () => { throw new Error('ENOENT'); });
  try {
    assert.equal(await platform.isWSL(), false);
  } finally {
    restoreRead();
    restoreProc();
  }
});

test('machineId: linux hashes /etc/machine-id (stable across calls)', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restoreProc = overrideProcess({ platform: 'linux' });
  const restoreRead = patchReadFile(async (file) => {
    assert.equal(file, '/etc/machine-id');
    return 'abcdef0123456789\n';
  });
  try {
    const id = await platform.machineId();
    assert.equal(id, sha256('abcdef0123456789'), 'sha256 of the trimmed machine-id');
    assert.equal(await platform.machineId(), id, 'deterministic across calls');
  } finally {
    restoreRead();
    restoreProc();
  }
});

test('machineId: darwin hashes the IOPlatformUUID from ioreg', async () => {
  const restoreProc = overrideProcess({ platform: 'darwin' });
  const exec = new ExecFileStub((file, args) => {
    assert.equal(file, 'ioreg');
    assert.deepEqual(args, ['-rd1', '-c', 'IOPlatformExpertDevice']);
    return { stdout: '  "IOPlatformUUID" = "DEAD-BEEF-UUID"\n', stderr: '' };
  }).install();
  // Import after the stub is installed: platform.js binds promisify(execFile) at load.
  const platform = await freshImport('../../src/platform.js');
  try {
    assert.equal(await platform.machineId(), sha256('DEAD-BEEF-UUID'));
  } finally {
    exec.restore();
    restoreProc();
  }
});

test('machineId: win32 hashes the registry MachineGuid', async () => {
  const restoreProc = overrideProcess({ platform: 'win32' });
  const exec = new ExecFileStub((file) => {
    assert.equal(file, 'reg.exe');
    return { stdout: '\r\nHKEY_LOCAL_MACHINE\\...\\Cryptography\r\n    MachineGuid    REG_SZ    1234-GUID\r\n', stderr: '' };
  }).install();
  const platform = await freshImport('../../src/platform.js');
  try {
    assert.equal(await platform.machineId(), sha256('1234-GUID'));
  } finally {
    exec.restore();
    restoreProc();
  }
});

test('machineId: falls back to a hashed hostname when the identifier lookup fails', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restoreProc = overrideProcess({ platform: 'linux' });
  const restoreRead = patchReadFile(async () => { throw new Error('permission denied'); });
  const restoreHost = patchHostname(() => 'fallback-host');
  try {
    assert.equal(await platform.machineId(), sha256('fallback-host'), 'hostname fallback is hashed');
  } finally {
    restoreHost();
    restoreRead();
    restoreProc();
  }
});

test('machineId: falls back to hostname when the identifier is blank', async () => {
  const platform = await freshImport('../../src/platform.js');
  const restoreProc = overrideProcess({ platform: 'linux' });
  const restoreRead = patchReadFile(async () => '   \n');
  const restoreHost = patchHostname(() => 'blank-fallback');
  try {
    assert.equal(await platform.machineId(), sha256('blank-fallback'));
  } finally {
    restoreHost();
    restoreRead();
    restoreProc();
  }
});

test('machineId: real host produces a stable 64-hex digest', async () => {
  // No overrides: exercise the genuine code path on this host and assert shape/stability.
  const platform = await freshImport('../../src/platform.js');
  const id = await platform.machineId();
  assert.match(id, /^[a-f0-9]{64}$/, 'a sha256 hex digest');
  assert.equal(await platform.machineId(), id, 'stable across calls');
  // Sanity: it is a hash of *something*, not the empty string.
  assert.notEqual(id, sha256(''));
  // If the host lookup failed it would be the hashed hostname; either way it is 64 hex.
  assert.ok(id === (await platform.machineId()));
  void hostname; // referenced for documentation of the fallback source
});
