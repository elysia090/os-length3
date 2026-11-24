import {readImages} from '../../sods/runtime/linux.ts';
import {prepare} from '../../sods/runtime/translate.ts';
import type {ExecutableArtifact} from '../format/manifest.ts';
import {digest} from './download.ts';

export async function compilePublished(wasm: Uint8Array, shared: boolean) {
  const image = prepare(wasm, {shared});
  return {module: await WebAssembly.compile(image.wasm), segments: image.segments, size: image.wasm.byteLength, more: []};
}

/** Load only code that the deployment bound to a canonical inode. */
export function deployedCode(programs: ReadonlyMap<string, {program: ExecutableArtifact}>, base: string,
                             shared: boolean, ready: () => void, begin: () => {release(): void}) {
  const retiring = new AbortController();
  const reader = readImages(origin => programs.has(origin), async origin => {
    const {program} = programs.get(origin)!;
    const operation = begin(), asset = program.wasm;
    try {
      const signal = AbortSignal.any([retiring.signal, AbortSignal.timeout(60_000)]);
      const response = await fetch(new URL(asset.path, base), {signal});
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const stored = new Uint8Array(await response.arrayBuffer());
      if (stored.byteLength !== asset.size || await digest(stored) !== asset.sha256) throw new Error('stored bytes failed verification');
      signal.throwIfAborted();
      // The stored bytes were authenticated as a whole. Decompression can
      // borrow that buffer without a second digest of the expanded module.
      const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({
        start(controller) { controller.enqueue(stored); controller.close(); },
      });
      const wasm = new Uint8Array(await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      if (wasm.byteLength !== asset.bytes) throw new Error('decoded size disagrees with the index');
      signal.throwIfAborted();
      return await compilePublished(wasm, shared);
    } catch (cause) {
      throw new Error(`ricebox: could not load deployed Wasm for ${program.path}`, {cause});
    } finally { operation.release(); }
  }, ready);
  return {...reader, close() { reader.close(); retiring.abort(); }};
}
