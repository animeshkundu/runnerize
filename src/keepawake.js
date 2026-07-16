import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NOOP = Object.freeze({ dispose() {} });

function isWsl(readVersion) {
  try {
    return /microsoft/i.test(readVersion('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

export function keepHostAwake({
  platform = process.platform,
  spawnChild = spawn,
  readVersion = readFileSync,
} = {}) {
  if (platform === 'win32' || (platform === 'linux' && isWsl(readVersion))) return NOOP;

  let child;
  if (platform === 'darwin') {
    child = spawnChild('caffeinate', ['-s', '-w', String(process.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else if (platform === 'linux') {
    child = spawnChild('systemd-inhibit', [
      '--what=sleep', '--why=runnerize', '--mode=block',
      'sh', '-c', 'while :; do sleep 3600; done',
    ], { stdio: 'ignore', windowsHide: true });
  } else {
    return NOOP;
  }

  child.on?.('error', (error) => {
    console.warn(`Could not inhibit host sleep: ${error.message}`);
  });
  child.unref?.();
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      child.kill?.();
    },
  };
}
