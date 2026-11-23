import type {MappedText, MappedTranslate} from '../../translation/mapped.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from '../executable-source.ts';
import type {File, Vfs} from '../fs.ts';

declare const preparedCode: unique symbol;
export interface PreparedMappedCode { readonly [preparedCode]: true }

export interface PreparedMappedPiece {
  readonly entry: number;
  readonly bytes: number;
  /** Supply the authenticated bytes if locally available. Runs before publication. */
  read(): Uint8Array<ArrayBuffer> | undefined;
}

export interface PreparedMappedInput extends PreparedMappedPiece {
  readonly source: ExecutableSource;
  readonly origin: string;
  readonly sourceSize: number;
  readonly text: MappedText;
}

export type PreparedMappedLookup = (file: File, text: MappedText) => PreparedMappedPiece | undefined;
const prepared = new WeakMap<PreparedMappedCode, {vfs: Vfs; compiler: MappedTranslate; lookup: PreparedMappedLookup}>();

/** Capture a trusted build's pieces for the exact inodes of this root. The
 * caller verifies the producer and bytes. The VM still authorizes mappings. */
export function capturePreparedMappedCode(vfs: Vfs, compiler: MappedTranslate,
    pieces: readonly PreparedMappedInput[]): PreparedMappedCode {
  const byFile = new Map<File, Map<number, {text: MappedText; piece: PreparedMappedPiece}>>();
  for (const {source, origin, sourceSize, text, entry, bytes, read} of pieces) {
    const file = executableSourceFor(source, vfs);
    if (file.origin !== origin || file.size !== sourceSize) throw new Error('Prepared mapped code disagrees with the authenticated root');
    if (!unchangedExecutableSource(file) || !Number.isInteger(entry) || entry < text.address || entry >= text.address + text.length ||
        !Number.isSafeInteger(bytes) || bytes <= 0 || typeof read !== 'function') throw new Error('Invalid prepared mapped code');
    let places = byFile.get(file.node);
    if (!places) byFile.set(file.node, places = new Map());
    if (places.has(text.address)) throw new Error('Duplicate prepared mapped address');
    places.set(text.address, {text: Object.freeze({...text}), piece: Object.freeze({entry, bytes, read})});
  }
  const token = Object.freeze(Object.create(null)) as PreparedMappedCode;
  prepared.set(token, {vfs, compiler, lookup(file, text) {
    const found = byFile.get(file)?.get(text.address);
    if (found && found.text.role === text.role && found.text.bias === text.bias &&
        found.text.offset === text.offset && found.text.length === text.length) return found.piece;
  }});
  return token;
}

export function preparedMappedCodeFor(token: PreparedMappedCode, vfs: Vfs, compiler: MappedTranslate | undefined): PreparedMappedLookup | undefined {
  const found = prepared.get(token);
  if (!found || found.vfs !== vfs) throw new Error('Prepared mapped code belongs to another Vfs or is not authentic');
  if (found.compiler === compiler) return found.lookup;
}
