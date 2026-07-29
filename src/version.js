import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error('runnerize package version is invalid.');
}

export const RUNNERIZE_VERSION = manifest.version;
export const RUNNERIZE_VERSION_LABEL = `runnerize-${RUNNERIZE_VERSION}`;
