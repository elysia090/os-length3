import type {DynamicRole} from './dynamic-load.ts';

/** Exact initialized file bytes of one RX PT_LOAD at its actual guest bias. */
export interface MappedText {
  readonly role: DynamicRole;
  readonly bias: number;
  readonly address: number;
  readonly offset: number;
  readonly length: number;
}

/** An experimental code generator, not authority to map or execute a file. */
export interface MappedTranslate {
  core(): Uint8Array<ArrayBuffer>;
  more(elf: Uint8Array, text: MappedText, address: bigint, known: Set<bigint>): Uint8Array<ArrayBuffer>;
  close(known: Set<bigint>): void;
  /** Build a module from ordered demand requests for one exact text extent. */
  replay?(elf: Uint8Array, text: MappedText, pcs: readonly number[]): Uint8Array<ArrayBuffer>;
}
