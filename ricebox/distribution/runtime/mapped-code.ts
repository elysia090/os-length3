import {capturePreparedMappedCode, type ExecutableSource, type PreparedMappedCode, type PreparedMappedTrace, type Vfs} from '../../sods/runtime/linux.ts';
import {loadTranslator, type Translate} from '../../sods/runtime/translate.ts';
import type {MappedCodeManifest} from '../format/mapped-code.ts';

interface CapturedMappedRoot {
  readonly generation: string;
  readonly vfs: Vfs;
  readonly sources: ReadonlyMap<string, ExecutableSource>;
}

/** The embedding authenticates the manifest and the root index that issued
 * these source tokens. Artifacts can be fetched asynchronously before launch;
 * `read` lends one available blob at its first unresolved PC. */
export async function loadMappedCode(root: CapturedMappedRoot, translator: Uint8Array<ArrayBuffer>, manifest: MappedCodeManifest,
    read: (sha256: string) => Uint8Array<ArrayBuffer> | undefined,
    digest?: (bytes: Uint8Array) => string, trace?: PreparedMappedTrace): Promise<{translate: Translate; preparedCode?: PreparedMappedCode}> {
  // Compilation is asynchronous. Check the same bytes that the engine saw.
  const translatorBytes = new Uint8Array(translator);
  const translate = await loadTranslator(translatorBytes);
  const sha256 = digest ?? ((bytes: Uint8Array) => Array.from(translate.sha256(bytes), b => b.toString(16).padStart(2, '0')).join(''));
  if (manifest.version !== 1 || manifest.generation !== root.generation || !translate.mapped || manifest.translator !== sha256(translatorBytes))
    return {translate};
  const pieces = [];
  for (const {origin, sourceSize, sourceSha256, text, entry, sha256: hash, bytes} of manifest.pieces) {
    const source = root.sources.get(origin);
    if (!source) continue;
    if (!/^[0-9a-f]{64}$/.test(sourceSha256) || !/^[0-9a-f]{64}$/.test(hash))
      throw new Error('Prepared mapped code disagrees with the authenticated root');
    pieces.push({source, origin, sourceSize, text, entry, bytes, read: () => {
      const wasm = read(hash);
      if (wasm === undefined) return;
      if (!(wasm.buffer instanceof ArrayBuffer) || wasm.byteLength !== bytes || sha256(wasm) !== hash)
        throw new Error('Prepared mapped code does not match its artifact digest');
      return wasm;
    }});
  }
  return {translate, preparedCode: capturePreparedMappedCode(root.vfs, translate.mapped, pieces, trace)};
}
