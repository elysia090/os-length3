// Byte verification and cache sealing are the same in the page and its Worker.
import {prepare, type Segment} from '../../sods/runtime/translate.ts';
import {digest} from './download.ts';

export interface CheckedAsset {
  bytes: Uint8Array;
  sha256: string;
  size?: number;
  segments?: Segment[] | null;
}

export async function checkAsset(bytes: Uint8Array, unpack: boolean, translated?: {shared: boolean}): Promise<CheckedAsset> {
  const body = unpack
    ? new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
    : bytes;
  const sha256 = await digest(body);
  if (!translated) return {bytes: body, sha256};
  const result = prepare(body, translated);
  return {bytes: result.wasm, sha256, size: body.byteLength, segments: result.segments};
}

export async function storedParts(parts: readonly Uint8Array[], seal: boolean): Promise<Uint8Array> {
  if (parts.length === 1 && !seal) return parts[0]!;
  const size = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(size + (seal ? 32 : 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.byteLength; }
  if (seal) out.set(new Uint8Array(await crypto.subtle.digest('SHA-256', out.subarray(0, size))), size);
  return out;
}
