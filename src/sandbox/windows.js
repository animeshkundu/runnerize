import path from 'node:path';
import { access } from 'node:fs/promises';

export const windows = {
  key: 'windows',
  labels: ['self-hosted', 'windows', 'x64'],

  async available() {
    if (process.platform !== 'win32') return false;
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    try {
      await access(path.join(systemRoot, 'System32', 'WindowsSandbox.exe'));
      return true;
    } catch {
      return false;
    }
  },

  async launch() {
    // TODO: Generate a one-job .wsb file that copies and launches an ephemeral runner.
    throw new Error('windows flavor is a v1.x opt-in; enable Windows Sandbox first');
  },
};
