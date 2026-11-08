// A kernel running BusyBox as the Prompt has it (os/scripts/userland.sh
// stages it), for tests: `have` says whether it is staged; `shell(script)`
// starts `sh -c script` with what is typed held in `input` and what is
// written collected in `out()`; on an `interactive` console (a terminal, as
// the app's Prompt has it), each change in how it is set kept in `modes`.
import {existsSync, readFileSync} from 'node:fs';
import {Vfs} from '../runtime/fs.ts';
import {Kernel} from '../runtime/process.ts';
import type {Termios} from '../runtime/parts.ts';
import {loadTranslator} from '../../sods/runtime/translator.ts';

const stage = new URL('../../os/target/userland/', import.meta.url);
export const have = ['busybox', 'busybox.wasm', 'xlat.wasm'].every((f) => existsSync(new URL(f, stage)));

/** A shell run: its kernel, what is to be typed, how its terminal was set at each change, and what it wrote. */
export interface Shell { kernel: Kernel; input: Uint8Array[]; modes: Pick<Termios, 'iflag' | 'oflag' | 'lflag'>[]; out: () => string }

export async function shell(script: string, applets = ['sh', 'cat', 'sleep'], {interactive = false, argv = null}: {interactive?: boolean; argv?: string[] | null} = {}): Promise<Shell> {
  const vfs = new Vfs();
  const busybox = vfs.writeFile('/bin/busybox', readFileSync(new URL('busybox', stage)), 0o755);
  for (const a of applets) vfs.symlink('busybox', `/bin/${a}`);
  const input: Uint8Array[] = [];
  const modes: Shell['modes'] = [];
  let out = '';
  const kernel = new Kernel({
    vfs, translate: await loadTranslator(readFileSync(new URL('xlat.wasm', stage))),
    console: {
      interactive,
      screen: interactive, cols: 80, rows: 24,
      mode: (tio) => modes.push(tio),
      write: (_, b) => { out += new TextDecoder().decode(b); },
      read: () => input.shift() ?? null,
      ready: () => input.length > 0,
    },
  });
  kernel.prebuilt(busybox, new WebAssembly.Module(readFileSync(new URL('busybox.wasm', stage))));
  kernel.start('/bin/sh', argv ?? ['/bin/sh', '-c', script], ['PATH=/bin'], '/');
  return {kernel, input, modes, out: () => out};
}
