export const macos = {
  key: 'macos',
  labels: ['self-hosted', 'macos', 'arm64'],

  async available() {
    return false;
  },

  async launch() {
    // TODO: Clone and boot a throwaway tart VM for exactly one JIT-configured job.
    throw new Error('macos flavor is a v1.x opt-in; requires tart');
  },
};
