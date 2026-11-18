// Pure stored-descriptor selection. No execution authority, I/O, or runtime objects.
import type {Index, Translation} from './manifest.ts';

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
export function canonicalExecutableSource(index: Pick<Index, 'packs' | 'files'>, translation: Translation): CanonicalExecutableSource {
  function fail(why: string): never { throw new Error(`ricebox: invalid executable source: ${why}`); }
  if (!object(translation) || !canonicalPath(translation.path)) fail('translation path must be canonical and absolute');
  if (!object(index) || !Array.isArray(index.files) || !Array.isArray(index.packs)) fail('missing canonical file inventory');
  const matches = index.files.filter(file => file?.path === translation.path);
  if (matches.length !== 1) fail(`${translation.path} must name exactly one canonical file`);
  const file = matches[0];
  if (!natural(file.pack) || !natural(file.at) || !natural(file.len) || !natural(file.size)) fail(`${translation.path} has unsafe file coordinates`);
  const pack = index.packs[file.pack];
  if (!object(pack) || typeof pack.name !== 'string' || !/^[0-9a-f]{64}\.pack$/.test(pack.name)) fail(`${translation.path} names an unknown or invalid pack`);
  if (!natural(pack.bytes) || file.at > pack.bytes || file.len > pack.bytes - file.at) fail(`${translation.path} is outside its pack`);
  if (file.len ? file.at < 32 || !file.size : file.at !== 0 || file.size !== 0) fail(`${translation.path} has invalid stored source bounds`);
  if (file.raw !== undefined && typeof file.raw !== 'boolean') fail(`${translation.path} has an invalid storage mode`);
  if (file.raw && file.len !== file.size) fail(`${translation.path} raw source length disagrees with its size`);
  if (!digest(translation.sha256)) fail(`${translation.path} has an invalid source digest`);
  if (!object(translation.elf) || !natural(translation.elf.bytes) || translation.elf.bytes !== file.size) fail(`${translation.path} source length disagrees with its ELF descriptor`);
  const origin = `${pack.name.slice(0, -5)}_${file.at}_${file.len}`;
  const binding = 'association' in translation ? 'explicit' : 'legacy-derived';
  if (binding === 'explicit') {
    const association = translation.association;
    if (!object(association) || association.version !== 1 || association.mode !== 'whole') fail(`${translation.path} has an unsupported source association`);
    if (association.origin !== origin) fail(`${translation.path} source origin disagrees with its canonical file`);
    if (!digest(association.sourceSha256) || association.sourceSha256 !== translation.sha256) fail(`${translation.path} source digest disagrees with its translation`);
    if (!natural(association.sourceBytes) || association.sourceBytes !== file.size) fail(`${translation.path} source length disagrees with its canonical file`);
  }
  return {path: translation.path, origin, sha256: translation.sha256, size: file.size, binding};
}
