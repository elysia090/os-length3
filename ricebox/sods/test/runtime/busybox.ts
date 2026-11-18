// An inline kernel running the same BusyBox as the staged distribution.
// The fixture reports which files are present, and captures console output,
// input, and terminal mode changes for the tests that use it.
import {readFileSync} from 'node:fs';
import {Vfs} from '../../runtime/linux/fs.ts';
import {Kernel} from '../../runtime/linux/process.ts';
import type {Termios} from '../../runtime/linux/parts.ts';
import {loadTranslator} from '../../runtime/translation/translator.ts';

import {requireUserland} from '../fixtures/runtime.ts';
export {hasUserland as have} from '../fixtures/runtime.ts';

/** A shell run: its kernel, what is to be typed, how its terminal was set at each change, and what it wrote. */
export interface Shell { kernel: Kernel; input: Uint8Array[]; modes: Pick<Termios, 'iflag' | 'oflag' | 'lflag'>[]; out: () => string }

export async function shell(script: string, applets = ['sh', 'cat', 'sleep'], {interactive = false, argv = null}: {interactive?: boolean; argv?: string[] | null} = {}): Promise<Shell> {
  const userland = requireUserland();
  const vfs = new Vfs();
  const busybox = vfs.writeFile('/bin/busybox', readFileSync(userland.busybox), 0o755);
  for (const a of applets) vfs.symlink('busybox', `/bin/${a}`);
  const input: Uint8Array[] = [];
  const modes: Shell['modes'] = [];
  let out = '';
  const kernel = new Kernel({
    vfs, translate: await loadTranslator(readFileSync(userland.translator)),
    console: {
      interactive,
      screen: interactive, cols: 80, rows: 24,
      mode: (tio) => modes.push(tio),
      write: (_, b) => { out += new TextDecoder().decode(b); },
      read: () => input.shift() ?? null,
      ready: () => input.length > 0,
    },
  });
  kernel.prebuilt(busybox, new WebAssembly.Module(readFileSync(userland.translated)));
  kernel.start('/bin/sh', argv ?? ['/bin/sh', '-c', script], ['PATH=/bin'], '/');
  return {kernel, input, modes, out: () => out};
}
