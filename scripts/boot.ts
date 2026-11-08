// /boot.js, the page's first script: boot.ts beside index.html (what the page says when the app cannot start) with its types
// taken away, as a classic script of its own. It is written as ES5, so it runs where the app cannot; nothing here
// lowers or bundles it. The build emits it (vite.config.ts), the development server answers it, and the test of it
// (boot.test.ts) reads what they serve.
import {readFile} from 'node:fs/promises';
import {transformWithOxc} from 'vite';

export const BOOT = new URL('../src/boot.ts', import.meta.url);

/** The script as the page has it. */
export async function bootScript(): Promise<string> {
  return (await transformWithOxc(await readFile(BOOT, 'utf8'), 'boot.ts', {lang: 'ts'})).code;
}
