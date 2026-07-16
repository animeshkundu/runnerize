import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

async function isWsl() {
  if (process.platform !== 'linux') return false;
  try {
    return /microsoft/i.test(await readFile('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

function childInhibitor(command, args) {
  const child = spawn(command, args, { stdio: 'ignore' });
  child.once('error', () => {});
  return {
    dispose() {
      if (!child.killed) child.kill();
    },
  };
}

export async function keepHostAwake({ enabled = true } = {}) {
  if (!enabled || process.platform === 'win32') return { dispose() {} };
  if (process.platform === 'darwin') {
    return childInhibitor('caffeinate', ['-s', '-w', String(process.pid)]);
  }
  if (process.platform === 'linux' && !await isWsl()) {
    return childInhibitor('systemd-inhibit', [
      '--what=sleep', '--why=runnerize', '--mode=block',
      'sh', '-c', 'while kill -0 "$1" 2>/dev/null; do sleep 60; done',
      'runnerize-inhibit', String(process.pid),
    ]);
  }
  return { dispose() {} };
}
