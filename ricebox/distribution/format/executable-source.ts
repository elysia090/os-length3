// Pure stored-descriptor selection. No execution authority, I/O, or runtime objects.
import type {ExecutableArtifact, Index, Translation} from './manifest.ts';
import {LINE} from './pack.ts';

/** The canonical source named by a translation, not a prepared executable. */
export interface CanonicalExecutableSource {
  path: string;
  origin: string;
  sha256: string;
  size: number;
  binding: 'explicit' | 'legacy-derived';
}
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalPath = (value: unknown): value is string => typeof value === 'string' && value.startsWith('/') &&
  value.length > 1 && !value.includes('\0') && value.slice(1).split('/').every(part => part !== '' && part !== '.' && part !== '..');
type Inventory = Pick<Index, 'packs' | 'files'>;
type PackedSource = Pick<CanonicalExecutableSource, 'path' | 'origin' | 'size'>;
const inventory = (index: unknown): index is Inventory => object(index) && Array.isArray(index.files) && Array.isArray(index.packs);

function packedOrigin(index: Inventory, file: Inventory['files'][number], fail: (why: string) => never): string {
  const {path, size, at, len, raw} = file;
  if (!natural(file.pack) || !natural(at) || !natural(len) || !natural(size)) fail(`${path} has unsafe file coordinates`);
  const pack = index.packs[file.pack];
  if (!object(pack) || typeof pack.name !== 'string' || !/^[0-9a-f]{64}\.pack$/.test(pack.name)) fail(`${path} names an unknown or invalid pack`);
  if (!natural(pack.bytes) || at > pack.bytes || len > pack.bytes - at) fail(`${path} is outside its pack`);
  if (len ? at < LINE || !size : at !== 0 || size !== 0) fail(`${path} has invalid stored source bounds`);
  if (raw !== undefined && typeof raw !== 'boolean') fail(`${path} has an invalid storage mode`);
  if (raw && len !== size) fail(`${path} raw source length disagrees with its size`);
  return `${pack.name.slice(0, -5)}_${at}_${len}`;
}

/** Pick a reviewed set of literal regular-file paths from one already
 * authenticated root index. These are capture coordinates, not evidence
 * of authentication or inode grants. Mount that same root before capture;
 * the normal pack reader still verifies payloads on demand. */
export function canonicalPackedFileSet(index: Inventory, paths: readonly string[]): readonly Readonly<PackedSource>[] {
  function fail(why: string): never { throw new Error(`ricebox: invalid executable file set: ${why}`); }
  if (!inventory(index)) fail('missing canonical file inventory');
  if (!Array.isArray(paths) || !paths.length || paths.length > index.files.length) fail('expected an explicit list of canonical files');
  const selected = new Map<string, Inventory['files'][number] | undefined>();
  for (const path of paths) {
    if (!canonicalPath(path) || selected.has(path)) fail('paths must be canonical and distinct');
    selected.set(path, undefined);
  }
  for (const file of index.files) if (selected.has(file?.path)) {
    if (selected.get(file.path)) fail(`${file.path} must name exactly one canonical file`);
    selected.set(file.path, file);
  }
  const sources: Readonly<PackedSource>[] = [], origins = new Set<string>();
  for (const [path, file] of selected) {
    if (!file) fail(`${path} must name exactly one canonical file`);
    const origin = packedOrigin(index, file, fail), {size} = file;
    if (!size || origins.has(origin)) fail(`${path} must name a distinct nonempty source`);
    origins.add(origin);
    sources.push(Object.freeze({path, origin, size}));
  }
  return Object.freeze(sources);
}

/**
 * Select one exact canonical index file (no symlink resolution or hardlink alias
 * substitution), and check the producer's source association. A missing association
 * derives the same descriptor under the legacy trusted-producer contract; a present
 * unsupported, malformed or contradictory association always throws.
 *
 * This is consistency checking of a trusted, authenticated manifest, not an
 * independent proof that AOT output implements these bytes. A compressed pack table
 * authenticates stored bytes, not their expanded source digest: this helper neither
 * derives that digest nor fetches an ELF to verify it. The caller still owns manifest
 * authentication, source-byte verification, translator/artifact identity and runtime
 * preparation, including any generation or live-file identity checks.
 */
export function canonicalExecutableSource(index: Inventory, translation: ExecutableArtifact | Translation): CanonicalExecutableSource {
  function fail(why: string): never { throw new Error(`ricebox: invalid executable source: ${why}`); }
  if (!object(translation) || !canonicalPath(translation.path)) fail('translation path must be canonical and absolute');
  if (!inventory(index)) fail('missing canonical file inventory');
  const matches = index.files.filter(file => file?.path === translation.path);
  if (matches.length !== 1) fail(`${translation.path} must name exactly one canonical file`);
  const file = matches[0], origin = packedOrigin(index, file, fail);
  return describeExecutable(translation, origin, file.size, fail);
}

function describeExecutable(translation: ExecutableArtifact | Translation, origin: string, size: number,
                            fail: (why: string) => never): CanonicalExecutableSource {
  if (!digest(translation.sha256)) fail(`${translation.path} has an invalid source digest`);
  const binding = 'association' in translation ? 'explicit' : 'legacy-derived';
  if ('elf' in translation) {
    if (!object(translation.elf) || translation.elf.bytes !== size) fail(`${translation.path} source length disagrees with its ELF descriptor`);
  } else if (binding === 'legacy-derived') fail(`${translation.path} has no source association`);
  if (binding === 'explicit') {
    const association = translation.association;
    if (!object(association) || association.version !== 1 || association.mode !== 'whole') fail(`${translation.path} has an unsupported source association`);
    if (association.origin !== origin) fail(`${translation.path} source origin disagrees with its canonical file`);
    if (!digest(association.sourceSha256) || association.sourceSha256 !== translation.sha256) fail(`${translation.path} source digest disagrees with its translation`);
    if (!natural(association.sourceBytes) || association.sourceBytes !== size) fail(`${translation.path} source length disagrees with its canonical file`);
  }
  return {path: translation.path, origin, sha256: translation.sha256, size, binding};
}

/** Web deploys emit one program per canonical source. Validate them in one file inventory pass. */
export function webExecutableSources(index: Index): Map<string, {source: CanonicalExecutableSource; program: ExecutableArtifact}> {
  const programs = index.execution?.programs ?? [];
  const sources = new Map<string, {source: CanonicalExecutableSource; program: ExecutableArtifact}>();
  if (!programs.length) return sources;
  const files = canonicalPackedFileSet(index, programs.map(program => program.path));
  for (const [i, file] of files.entries()) {
    const program = programs[i]!;
    const source = describeExecutable(program, file.origin, file.size, why => { throw new Error(`ricebox: invalid executable source: ${why}`); });
    sources.set(file.origin, {source, program});
  }
  return sources;
}
