// Import a production module with fresh module-level state (token cache, ETag cache,
// rate-limit gate) by cache-busting the specifier. Each call returns a new namespace.

let seq = 0;

export function freshImport(specifier) {
  seq += 1;
  const sep = specifier.includes('?') ? '&' : '?';
  return import(`${specifier}${sep}__fresh=${seq}`);
}
