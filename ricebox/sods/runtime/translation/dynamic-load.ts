// Versioned output of the Rust ELF load-spec reader. This capability only
// describes loadable files; it is not authorization or translated code.
export const DYNAMIC_FILE_LIMIT = 64 << 20;
export const DYNAMIC_ROLES = {main: 1, interpreter: 2, library: 3} as const;
export type DynamicRole = keyof typeof DYNAMIC_ROLES;

export interface ElfLoadSegment {
  readonly offset: number;
  readonly vaddr: number;
  readonly fileSize: number;
  readonly memSize: number;
  readonly align: number;
  readonly flags: number;
}

export interface ElfLoadSpec {
  readonly role: DynamicRole;
  readonly entry: number;
  readonly phdr: number;
  readonly phent: 56;
  readonly phnum: number;
  readonly interpreter: string | null;
  readonly loads: readonly ElfLoadSegment[];
}

const HEADER = 28, LOAD = 24;
const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

export function dynamicLoadSpec(bytes: Uint8Array, role: DynamicRole): ElfLoadSpec {
  const bad = (): never => { throw new Error('Invalid dynamic load-spec result from Sods'); };
  if (bytes.length < HEADER || bytes[0] !== 83 || bytes[1] !== 76 || bytes[2] !== 68 || bytes[3] !== 49) bad(); // SLD1
  const words = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const word = (at: number): number => words.getUint32(at, true);
  const entries = word(20), length = word(24), phnum = word(16);
  const pathAt = HEADER + entries * LOAD;
  if (word(4) !== DYNAMIC_ROLES[role] || !phnum || phnum * 56 > 65536 || !entries || entries > phnum ||
      length > 4095 || pathAt + length !== bytes.length || (role === 'main') !== (length > 0)) bad();
  const loads: ElfLoadSegment[] = [];
  for (let at = HEADER; at < pathAt; at += LOAD) {
    loads.push({offset: word(at), vaddr: word(at + 4), fileSize: word(at + 8), memSize: word(at + 12),
      align: word(at + 16), flags: word(at + 20)});
  }
  const interpreter = length ? text.decode(bytes.subarray(pathAt)) : null;
  if (interpreter !== null && (!interpreter.startsWith('/') || interpreter.includes('\0'))) bad();
  return {role, entry: word(8), phdr: word(12), phent: 56, phnum, interpreter, loads};
}
