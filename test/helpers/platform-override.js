// Helpers for overriding `process.platform` / `process.arch` and patching the
// `node:fs/promises` and `node:os` bindings that `src/platform.js` reads, so its
// OS/arch/WSL/machine-id logic can be exercised on any host.

import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * Temporarily set `process.platform` and/or `process.arch`. Returns a restore fn.
 * `process.platform` is a non-writable own property, so we redefine it.
 */
export function overrideProcess({ platform, arch } = {}) {
  const restores = [];
  for (const [key, value] of Object.entries({ platform, arch })) {
    if (value === undefined) continue;
    const original = Object.getOwnPropertyDescriptor(process, key);
    Object.defineProperty(process, key, { value, configurable: true, enumerable: true });
    restores.push(() => Object.defineProperty(process, key, original));
  }
  return () => { for (const r of restores.reverse()) r(); };
}

/** Patch `fs/promises.readFile` with `impl`. Returns a restore fn. */
export function patchReadFile(impl) {
  const fsp = require('node:fs/promises');
  const original = fsp.readFile;
  fsp.readFile = impl;
  syncBuiltinESMExports();
  return () => { fsp.readFile = original; syncBuiltinESMExports(); };
}

/** Patch `os.hostname` with `impl`. Returns a restore fn. */
export function patchHostname(impl) {
  const os = require('node:os');
  const original = os.hostname;
  os.hostname = impl;
  syncBuiltinESMExports();
  return () => { os.hostname = original; syncBuiltinESMExports(); };
}
