// sods as others take it, the second of three files (translate.ts, this, host.ts): a Linux where there is none. A
// program made a module (translate.ts) asks what a program asks of Linux, and what is here answers it: files,
// processes, threads, signals, pipes, sockets, a terminal, /proc. Which host this is (a page, one of its Workers,
// node) is asked inside, in host.ts: whoever starts a Linux here says what it runs and where its bytes come from,
// and nothing of where it runs.
//
//   linux(options)   a kernel: each thread in a Worker of its own where the host lets threads run apart, else all in
//                    turn on this thread; the programs given with their translations run them from the start
//   Vfs, mountTarget, provide
//                    its tree: made empty, filled through a mount's port (an image's reader fills it: ricebox's
//                    layers/mount.ts), a file given with its bytes put over what is there
//   keeper           translations kept from earlier runs, read when a program is first run
//   Mirror           what a program changed under one directory, said to whoever keeps a copy outside
//   said             a kernel that ran as far as it could: ended, or waiting, and for what
import {canRunApart, said as told} from './host.ts';
import {Kernel} from './linux/process.ts';
import {RemoteKernel, type Apart} from './linux/remote.ts';
import type {Segment} from './translation/share.ts';

export {Vfs, mountTarget, provide, type File} from './linux/fs.ts';
export {Mirror} from './linux/mirror.ts';
export {Kernel, type Image, type Pumped} from './linux/process.ts';
export {RemoteKernel, warmThreads} from './linux/remote.ts';
export {keeper, type Kept, type Reading} from './linux/keeper.ts';
export {said, type Said} from './linux/waiting.ts';
export type {Console, Far, Outside} from './linux/parts.ts';

/** A program of the tree given with its translation: its module, its data beside it, and whether it was made for memory shared between threads. */
export interface Translated { path: string; module?: WebAssembly.Module | null; segments?: Segment[] | null; shared?: boolean }
/** What a Linux is started with: a kernel's own (its tree, its translator, its console, what is kept), and these. */
export interface Options extends Apart {
  /** Programs given with their translations: each runs its own from its first run. */
  translated?: Translated[];
  /** Threads take turns on this thread even where they could run apart (SODS_INLINE=1 says the same from outside). */
  inline?: boolean;
}

/**
 * A Linux on this host. Its threads each run in a Worker of their own, all at once, where the host shares memory
 * between threads and lets one wait on it (host.ts canRunApart) and every translation given was made for shared
 * memory; otherwise they take turns on this thread. Which it is, is the kernel's class (RemoteKernel, or Kernel).
 */
export function linux({translated = [], inline = false, ...made}: Options): Kernel {
  const apart = !inline && !told('SODS_INLINE') && canRunApart() && translated.every((p) => !p.module || p.shared);
  const k = apart ? new RemoteKernel(made) : new Kernel(made);
  for (const p of translated) if (p.module) k.prebuilt(k.vfs.file(p.path), p.module, p.segments ?? null);
  return k;
}
