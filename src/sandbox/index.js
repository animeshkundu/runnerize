import { linux } from './container.js';
import { windows } from './windows.js';
import { macos } from './macos.js';

export { linux, windows, macos };

export async function detectFlavors() {
  const flavors = [linux, windows, macos];
  const availability = await Promise.all(flavors.map(async (flavor) => {
    try {
      return await flavor.available();
    } catch {
      return false;
    }
  }));
  return flavors.filter((_, index) => availability[index]);
}
