// Realm-local, metadata-only dependency authority for a single Vfs.
// The embedding must authenticate package bytes before issuing source tokens.
import {DYNAMIC_FILE_LIMIT} from '../translation/dynamic-load.ts';
import {executableSourceFor, unchangedExecutableSource, type ExecutableSource} from './executable-source.ts';
import {E, FsError, type File, type Vfs} from './fs.ts';

const MAX_LIBRARIES = 4096;
declare const libraries: unique symbol;
export interface MappedLibraries { readonly [libraries]: true }
export interface MappedLibrary {
  readonly grant: ExecutableSource;
  readonly captured: ReturnType<typeof executableSourceFor>;
}
export interface MappedLibraryView {
  member(file: File): MappedLibrary | undefined;
  check(): void;
}
const catalogues = new WeakMap<MappedLibraries, {vfs: Vfs; view: MappedLibraryView}>();

export function checkMappedLibrary({captured}: MappedLibrary): void {
  const {node, size} = captured;
  if (!size || size > DYNAMIC_FILE_LIMIT || !unchangedExecutableSource(captured) ||
      node.mode & 0o6000 || node.maps?.size) throw new FsError(E.ACCES);
}

/** Snapshot authorized inodes, not names, payloads or caller-owned lists. */
export function captureMappedLibraries(vfs: Vfs, input: readonly ExecutableSource[]): MappedLibraries {
  if (!Array.isArray(input)) throw new TypeError('Expected an explicit mapped library list');
  const count = input.length;
  if (count > MAX_LIBRARIES) throw new FsError(E.NOMEM);
  const members = new Map<File, MappedLibrary>();
  for (let i = 0; i < count; i++) {
    const grant = input[i], captured = executableSourceFor(grant, vfs);
    if (members.has(captured.node)) throw new TypeError('Duplicate mapped library inode');
    const member = Object.freeze({grant, captured});
    checkMappedLibrary(member);
    members.set(captured.node, member);
  }
  const view: MappedLibraryView = Object.freeze({
    member: (file: File) => members.get(file),
    check() { for (const member of members.values()) checkMappedLibrary(member); },
  });
  const token = Object.freeze(Object.create(null)) as MappedLibraries;
  catalogues.set(token, {vfs, view});
  return token;
}

export function mappedLibrariesFor(catalogue: MappedLibraries, vfs: Vfs): MappedLibraryView {
  const found = catalogues.get(catalogue);
  if (!found || found.vfs !== vfs) throw new TypeError('Mapped library catalogue belongs to another Vfs or is not authentic');
  return found.view;
}
