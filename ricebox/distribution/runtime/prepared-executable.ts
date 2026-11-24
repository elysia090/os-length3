/** Distribution association checks. Linux inode/revision authority stays in sods. */
import {canonicalExecutableSource, webExecutableSources, type CanonicalExecutableSource} from '../format/executable-source.ts';
import {aotFraming} from '../format/aot-frames.ts';
import type {ExecutableArtifact, Index} from '../format/manifest.ts';
import type {PreparedExecutable} from './root-types.ts';

export function executableKey(generation: string, source: CanonicalExecutableSource, translation: ExecutableArtifact, translator: string, shared: boolean): string {
  return JSON.stringify(['canonical-aot-v1', generation, source.origin, source.sha256, source.size,
    translation.wasm.sha256, translator, 'whole', shared]);
}
export function validateExecutable(index: Index, generation: string, executable: PreparedExecutable): CanonicalExecutableSource {
  if (!/^[0-9a-f]{64}$/.test(generation) || !executable || typeof executable !== 'object') throw new Error('Invalid prepared executable generation');
  const translations = (index.execution?.programs ?? index.translations).filter(t => t.path === executable.path);
  if (translations.length !== 1) throw new Error('Prepared executable is not uniquely named by this root');
  const translation = translations[0]!, source = canonicalExecutableSource(index, translation);
  if (executable.generation !== generation || !executable.source || executable.source.origin !== source.origin || executable.source.sha256 !== source.sha256 || executable.source.size !== source.size || executable.source.binding !== source.binding
      || !executable.artifact || executable.artifact.sha256 !== translation.wasm.sha256 || executable.artifact.translator !== index.translator.sha256 || executable.artifact.mode !== 'whole'
      || typeof executable.shared !== 'boolean' || executable.key !== executableKey(generation, source, translation, index.translator.sha256, executable.shared)
      || !(executable.module instanceof WebAssembly.Module) || (executable.segments !== null && !Array.isArray(executable.segments))) {
    throw new Error('Prepared executable does not match this root source and artifact');
  }
  // These bytes and the module are one trusted producer/host preparation result.
  // Shape validation does not prove arbitrary Module semantics or digest it again.
  for (const segment of executable.segments ?? []) {
    if (!segment || !Number.isSafeInteger(segment.offset) || segment.offset < 0 || !(segment.bytes instanceof Uint8Array)) throw new Error('Invalid prepared executable segment');
  }
  const framing = aotFraming(translation.wasm);
  if (framing && (!executable.segments || executable.segments.length !== framing.data.length ||
      framing.data.some((part, i) => executable.segments![i]!.offset !== part.address ||
        executable.segments![i]!.bytes.byteLength !== part.bytes))) {
    throw new Error('Prepared executable does not match its framed initial data');
  }
  return source;
}

/** One canonical inode may have several hot hardlink names, never conflicting artifacts. */
export function canonicalHotSources(index: Index): CanonicalExecutableSource[] {
  if (index.execution) return [...webExecutableSources(index).values()].map(value => value.source);
  const sources = new Map<string, {source: CanonicalExecutableSource; artifact: string}>();
  for (const translation of index.translations) {
    const source = canonicalExecutableSource(index, translation), previous = sources.get(source.origin);
    if (previous && (previous.source.sha256 !== source.sha256 || previous.source.size !== source.size || previous.artifact !== translation.wasm.sha256)) {
      throw new Error('Conflicting prepared artifacts for one canonical source inode');
    }
    if (!previous) sources.set(source.origin, {source, artifact: translation.wasm.sha256});
  }
  return [...sources.values()].map(value => value.source);
}
