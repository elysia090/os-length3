/** A translation's data segment: bytes for guest memory at an offset. */
export interface Segment { offset: number; bytes: Uint8Array }

/** A translation as the kernel runs it: its memory import shared (when asked) and its data outside the module (when it can be). */
export function prepare(wasm: Uint8Array, options?: {shared?: boolean}): {wasm: Uint8Array; segments: Segment[] | null};

/** Write `segments` into a memory's bytes. */
export function lay(bytes: Uint8Array, segments: Segment[]): void;
