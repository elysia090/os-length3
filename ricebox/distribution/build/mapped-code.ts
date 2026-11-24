import {canonicalPackedFileSet} from '../format/executable-source.ts';
import {releaseIndexAsset, type About, type Index} from '../format/manifest.ts';
import type {MappedCodeArtifact, MappedCodeManifest} from '../format/mapped-code.ts';
import {sha256} from '../host/node/hash.ts';

type MappedText = MappedCodeArtifact['text'];
type Replay = (elf: Uint8Array, text: MappedText, pcs: readonly number[]) => Uint8Array<ArrayBuffer>;
type LoadTranslator = (wasm: Uint8Array<ArrayBuffer>) => Promise<{readonly mapped?: {readonly replay?: Replay}}>;

export interface MappedCodeTrace {
  readonly path: string;
  readonly sourceSha256: string;
  readonly text: MappedText;
  readonly pcs: readonly number[];
}

interface MappedCodeSource {
  readonly about: Pick<About, 'index'>;
  readonly index: Pick<Index, 'packs' | 'files'>;
  read(file: Index['files'][number]): Uint8Array;
}

/** Replay observed VM misses for canonical files of this distribution. The
 * caller supplies the translator loader and stores the content-addressed blobs. */
export async function buildMappedCode(root: MappedCodeSource,
    translator: Uint8Array<ArrayBuffer>, loadTranslator: LoadTranslator, trace: readonly MappedCodeTrace[],
    store: (sha256: string, wasm: Uint8Array<ArrayBuffer>) => void): Promise<MappedCodeManifest> {
  const translatorBytes = new Uint8Array(translator);
  const generation = releaseIndexAsset(root.about).sha256, translatorSha256 = sha256(translatorBytes);
  const replay = (await loadTranslator(translatorBytes)).mapped?.replay;
  if (!replay) throw new Error('This Sods translator cannot replay mapped code');
  const byPath = new Map<string, MappedCodeTrace[]>();
  for (const row of trace) {
    const rows = byPath.get(row.path);
    if (rows) rows.push(row);
    else byPath.set(row.path, [row]);
  }
  const pieces: MappedCodeArtifact[] = [];
  if (byPath.size) {
    const files = new Map(root.index.files.map(file => [file.path, file]));
    for (const source of canonicalPackedFileSet(root.index, [...byPath.keys()])) {
      const elf = root.read(files.get(source.path)!);
      const digest = sha256(elf), addresses = new Set<number>();
      for (const {sourceSha256, text, pcs} of byPath.get(source.path)!) {
        if (elf.length !== source.size || digest !== sourceSha256) throw new Error(`Mapped code trace source changed at ${source.path}`);
        if (addresses.has(text.address)) throw new Error(`Duplicate mapped code placement for ${source.path}`);
        addresses.add(text.address);
        const wasm = replay(elf, text, pcs), hash = sha256(wasm);
        store(hash, wasm);
        pieces.push({origin: source.origin, sourceSize: elf.length, sourceSha256, text: {...text}, entry: pcs[0],
          sha256: hash, bytes: wasm.byteLength});
      }
    }
  }
  return {version: 1, generation, translator: translatorSha256, pieces};
}
