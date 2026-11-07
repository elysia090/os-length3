// A kernel running BusyBox as the Prompt has it (os/scripts/userland.sh
// stages it), for tests: `have` says whether it is staged; `shell(script)`
// starts `sh -c script` with what is typed held in `input` and what is
// written collected in `out()`; on an `interactive` console (a terminal, as
// the app's Prompt has it), each change in how it is set kept in `modes`.
import {existsSync, readFileSync} from 'node:fs';
import {Vfs} from '../runtime/fs.mjs';
import {Kernel} from '../runtime/process.mjs';
import {loadTranslator} from '../runtime/translator.mjs';

const stage = new URL('../../os/target/userland/', import.meta.url);
export const have = ['busybox', 'busybox.wasm', 'xlat.wasm'].every((f) => existsSync(new URL(f, stage)));

export async function shell(script, applets = ['sh', 'cat', 'sleep'], {interactive = false, argv = null} = {}) {
  const vfs = new Vfs();
  vfs.writeFile('/bin/busybox', readFileSync(new URL('busybox', stage)), 0o755);
  for (const a of applets) vfs.symlink('busybox', `/bin/${a}`);
  const input = [];
  const modes = [];
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
  kernel.prebuilt(vfs.lookup('/bin/busybox', '/'), new WebAssembly.Module(readFileSync(new URL('busybox.wasm', stage))));
  kernel.start('/bin/sh', argv ?? ['/bin/sh', '-c', script], ['PATH=/bin'], '/');
  return {kernel, input, modes, out: () => out};
}
