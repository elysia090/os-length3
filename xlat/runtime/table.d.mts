// Types for table.mjs (what the page imports of it: ahead.ts).
interface Packed { packs: {name: string; bytes: number}[]; files: {pack: number; at: number; len: number}[] }
export const LINE: number;
export function packOf(stored: Uint8Array[], sha256: (b: Uint8Array) => Uint8Array): {bytes: Uint8Array; name: string; at: number[]};
export function entriesOf(index: Packed): Map<number, {line: number; len: number}>[];
export function checkTable(table: Uint8Array, name: string, sha256: (b: Uint8Array) => Uint8Array): void;
export function checkFile(bytes: Uint8Array, table: Uint8Array, line: number | undefined, name: string, sha256: (b: Uint8Array) => Uint8Array): void;
export function checkPacks(index: Packed, read: (name: string, at: number, len: number) => Uint8Array, size: (name: string) => number, sha256: (b: Uint8Array) => Uint8Array): void;
export function checkedRange(index: Packed, range: (name: string, at: number, len: number) => Uint8Array, sha256: (b: Uint8Array) => Uint8Array): (pack: number, at: number, len: number) => Uint8Array;
