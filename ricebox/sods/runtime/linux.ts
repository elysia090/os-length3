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
//                    distribution/mount.ts), a file given with its bytes put over what is there
//   keeper           translations kept from earlier runs, read when a program is first run
//   Mirror           what a program changed under one directory, said to whoever keeps a copy outside
//   said             a kernel that ran as far as it could: ended, or waiting, and for what
import {canRunApart, said as told} from './host.ts';
import {Image, Kernel} from './linux/process.ts';
import {RemoteKernel, type Apart} from './linux/remote.ts';
import {Vfs, type File} from './linux/fs.ts';
import {executableSourceFor, type ExecutableSource} from './linux/executable-source.ts';
import type {Segment} from './translation/share.ts';
export {Vfs, mountTarget, provide, type File} from './linux/fs.ts';
export {loadFileScope, type FileScope} from './linux/file-scope.ts';
export {captureExecutableSource, type ExecutableSource} from './linux/executable-source.ts';
export {prepareFileStore} from './file-store.ts';
export {Mirror} from './linux/mirror.ts';
export {Kernel, type Image, type Pumped} from './linux/process.ts';
export {RemoteKernel, warmThreads} from './linux/remote.ts';
export {keeper, type Kept, type Reading, type RetirableReading} from './linux/keeper.ts';
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

/** A trusted artifact paired with a realm-local source captured before overlays. */
export interface SourceBoundExecutable {
  key: string;
  source: ExecutableSource;
  module: WebAssembly.Module;
  segments?: Segment[] | null;
  /** The compiled module's memory-import mode, supplied by its trusted preparer. */
  shared?: boolean;
}
export interface PreparedLinuxOptions extends Omit<Options, 'translated' | 'vfs'> {
  vfs: Vfs;
  executables: readonly SourceBoundExecutable[];
}
export interface PreparedLinux { kernel: Kernel; attached: ReadonlyMap<string, Image> }

/**
 * An attachment failed after kernel construction. This owner remains available
 * for explicit retirement; neither rollback nor a physical Worker stop is
 * implied. Constructor failures remain ordinary linux() constructor failures.
 */
export class PreparedLinuxError extends Error {
  readonly kernel: Kernel;
  readonly attached: ReadonlyMap<string, Image>;
  constructor(cause: unknown, kernel: Kernel, attached: ReadonlyMap<string, Image>) {
    super('Prepared Linux attachment failed; kernel ownership retained', {cause});
    this.name = 'PreparedLinuxError'; this.kernel = kernel; this.attached = attached;
  }
}

/**
 * Additive prepared-tree profile. No source payload is demanded. The release
 * owner authenticates source/artifact identity; this API protects the captured
 * inode/revision association, not the correctness of a claimed translation.
 * Invalid admissions are rejected before constructing a kernel. Changed sources
 * are simply absent from attached and keep the ordinary exec fallback.
 *
 * All artifacts must have one compiled memory mode. linux() still owns backend
 * choice. Shared artifacts also work inline, with a shared guest Memory, when
 * Workers are disabled/unavailable. Compiled-module import limits are not
 * introspectable here: shared is trusted preparation metadata, not a rewrite.
 */
export function preparedLinux({vfs, executables, inline = false, ...made}: PreparedLinuxOptions): PreparedLinux {
  if (!(vfs instanceof Vfs) || !Array.isArray(executables) || 'translated' in made) throw new TypeError('Invalid prepared Linux input');
  const keys = new Set<string>(), nodes = new Set<File>();
  const admitted = executables.map(({key, source, module, segments = null, shared = false}) => {
    if (typeof key !== 'string' || !key || keys.has(key)) throw new TypeError('Duplicate or invalid executable key');
    keys.add(key);
    const {node} = executableSourceFor(source, vfs);
    if (nodes.has(node)) throw new TypeError('Duplicate executable source inode');
    nodes.add(node);
    if (!(module instanceof WebAssembly.Module) || typeof shared !== 'boolean') throw new TypeError('Invalid executable artifact');
    if (segments !== null && (!Array.isArray(segments) || segments.some((s) => !s || !Number.isSafeInteger(s.offset)
      || s.offset < 0 || !(s.bytes instanceof Uint8Array)))) throw new TypeError('Invalid executable segments');
    // Exercise the existing Image parser before the backend can start Workers.
    // This does not prove its facts/segments correspond to the claimed ELF.
    new Image(module, null, 0, segments);
    return {key, source, module, segments, shared};
  });
  if (admitted.some((p) => p.shared !== admitted[0].shared)) throw new TypeError('Mixed executable memory modes');
  const shared = admitted.length ? admitted[0].shared : null;
  const kernel = linux({...made, vfs, inline: inline || shared === false});
  if (shared === true) kernel.shared = true;
  const attached = new Map<string, Image>();
  try {
    for (const p of admitted) {
      const image = kernel.prebuiltSource(p.source, p.module, p.segments);
      if (image) attached.set(p.key, image);
    }
  } catch (cause) { throw new PreparedLinuxError(cause, kernel, attached); }
  return {kernel, attached};
}
