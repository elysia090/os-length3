// Types for fs.mjs, as os/scripts reads them (l3-runnable.ts: a root mounted as the browser's Prompt mounts it).
export class Node {
  /** 0 while it is the root's own file, as its pack has it (what a kept translation is for). */
  version: number;
  origin?: string | null;
}
export class Vfs {
  lookup(path: string, cwd: string, follow?: boolean): Node;
  mkdirp(path: string): void;
}
