// Types for process.mjs, as os/scripts reads them (l3-runnable.ts: a program run as the browser's Prompt runs it).
import type {Node, Vfs} from './fs.mjs';
import type {Translate} from './translator.mjs';
import type {Segment} from './share.mjs';

/** A program's translation as a kernel holds it, and what of it a Prompt keeps (keeper.mjs). */
export interface Image {
  origin?: string | null;
  wasm?: Uint8Array | null;
  segments?: {offset: number; bytes: Uint8Array}[] | null;
  extras: {base: number; bytes: Uint8Array}[];
  told?: number;
}
export interface Held { version: number; image: Image; used: number; kept?: boolean }
export interface Console {
  interactive: boolean;
  write(fd: number, bytes: Uint8Array): void;
  read(): Uint8Array;
  ready(): boolean;
}
export class Kernel {
  constructor(options: {vfs?: Vfs; translate: Translate; console: Console; keeper?: {reading(): number} | null; consolidateIdle?: boolean});
  images: Map<Node, Held>;
  keeper: {reading(): number} | null;
  kick?(): void;
  prepare(wasm: Uint8Array): {wasm: Uint8Array<ArrayBuffer>; segments: Segment[] | null};
  prebuilt(node: Node, module: WebAssembly.Module, segments?: Segment[] | null): void;
  consolidateIfDue(node: Node, held: Held, idle?: boolean): void;
  start(path: string, argv: string[], env: string[], cwd?: string): void;
  /** Runs what can run: the status once all has ended, else that it waits (and until when, if for a time). */
  pump(): {status: number; waiting?: undefined; until?: undefined} | {waiting: true; until?: number; status?: undefined};
}
