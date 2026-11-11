// What the browser's core keeps in IndexedDB, as both its worker (core/worker.ts) and its loader (core/loader.ts) know
// it. Each node of its files by its path in one store (what a listing needs: kind, size, times, a link's target),
// a file's bytes by the same path in another, so a page reads what it lists without reading what it never opens.

export const NAME = 'length3-core';
/** 2: a file's bytes kept apart from it (1 kept them in the node). */
export const VERSION = 2;
export const NODES = 'nodes';
export const DATA = 'data';
export const META = 'meta';
export const GENERATION = 'generation';

/**
 * How the core's worker and its loader hand a file's bytes over (loader.ts): [0] of their shared Int32Array is which
 * question it is and how it stands, in one word (`stand`), so the two never change in steps the other could see apart.
 */
export const ASKED = 1, READ = 2, TOO_BIG = 3, NONE = 4;
export const stand = (seq: number, state: number) => ((seq & 0xfffffff) << 3) | state;
