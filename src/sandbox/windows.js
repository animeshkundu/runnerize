export const windows = {
  key: 'windows',
  labels: ['self-hosted', 'windows', 'x64'],

  async available() {
    return false;
  },

  async launch() {
    // TODO: Generate a one-job .wsb file that copies and launches an ephemeral runner.
    throw new Error('windows flavor is a v1.x opt-in; enable Windows Sandbox first');
  },
};
