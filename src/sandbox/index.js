import { linux } from './container.js';
import { windows } from './windows.js';
import { macos } from './macos.js';

export { linux, windows, macos };

export const FLAVOR_KEYS = Object.freeze([linux.key, windows.key, macos.key]);

export async function detectFlavors(only) {
  const flavors = [linux, windows, macos].filter((flavor) => !only || only.has(flavor.key));
  const availability = await Promise.all(flavors.map(async (flavor) => {
    try {
      return await flavor.available();
    } catch {
      return false;
    }
  }));
  return flavors.filter((_, index) => availability[index]);
}
