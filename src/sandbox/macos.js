import { spawn } from 'node:child_process';

function tartAvailable() {
  return new Promise((resolve) => {
    const child = spawn('tart', ['--version'], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
  });
}

export const macos = {
  key: 'macos',
  labels: ['self-hosted', 'macos', 'arm64'],

  async available() {
    return process.platform === 'darwin' && tartAvailable();
  },

  async launch() {
    // TODO: Clone and boot a throwaway tart VM for exactly one JIT-configured job.
    throw new Error('macos flavor is a v1.x opt-in; requires tart');
  },
};
