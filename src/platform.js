import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function detectOS() {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform;
  }
  throw new Error(`unsupported operating system: ${process.platform}`);
}

export function detectArch() {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch;
  throw new Error(`unsupported architecture: ${process.arch}`);
}

export async function isWSL() {
  if (process.platform !== 'linux') return false;
  try {
    const version = await readFile('/proc/version', 'utf8');
    return /microsoft|wsl/i.test(version);
  } catch {
    return false;
  }
}

function hash(value) {
  return createHash('sha256').update(value.trim()).digest('hex');
}

async function platformIdentifier() {
  if (process.platform === 'linux') {
    return readFile('/etc/machine-id', 'utf8');
  }

  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    const match = stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (!match) throw new Error('IOPlatformUUID was not found');
    return match[1];
  }

  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('reg.exe', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
    ]);
    const match = stdout.match(/MachineGuid\s+REG_SZ\s+(.+)$/im);
    if (!match) throw new Error('MachineGuid was not found');
    return match[1];
  }

  throw new Error('unsupported platform');
}

export async function machineId() {
  try {
    const identifier = await platformIdentifier();
    if (identifier.trim()) return hash(identifier);
  } catch {
    // Hostname is less durable, but gives unsupported and restricted hosts a stable fallback.
  }
  return hash(hostname());
}
