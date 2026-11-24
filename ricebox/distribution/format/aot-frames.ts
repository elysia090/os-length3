// One published asset over one HTTP stream, independently authenticated gzip
// members. The authenticated index binds file order, both first-code variants,
// and the ordered writes that initialize the guest after every frame is checked.
export const FRAME_BYTES = 4 << 20;
export const FIRST_FRAME_BYTES = 64 << 10;
export const MAX_AOT_SHARD_BYTES = 16 << 20;
export const FIRST_AOT_SHARD_BYTES = 1 << 20;
const FRAME_STORED = FRAME_BYTES + (64 << 10);
const MAX_CODE_BYTES = 512 << 20, MAX_DATA_BYTES = 256 << 20, MAX_FRAMES = 256;
const ADDRESS_LIMIT = 2 ** 32;

export interface AotFrame {
  /** Position within the stored asset, not within the Wasm or guest memory. */
  at: number;
  size: number;
  bytes: number;
  sha256: string;
}
export interface AotShard {
  /** Logical range in the concatenation, independent of the physical object's URL. */
  at: number;
  path: string;
  size: number;
  sha256: string;
}
export interface AotFraming {
  version: 'sods-framed-v1' | 'sods-framed-v2';
  /** v2 names independent static objects, with no physical aggregate object. */
  shards?: AotShard[];
  code: AotFrame[];
  /** If present, immediately after code[0] on the wire; same size after decoding. */
  sharedHead?: AotFrame;
  /** Ordered, nonoverlapping initialization writes. */
  data: (AotFrame & {address: number})[];
}

const natural = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** The stored digest still names the entire asset for publication/staging.
 * Streaming needs only authenticated frame digests, plus an exact outer EOF. */
export function aotFraming(asset: {size: number; bytes: number; framing?: AotFraming}): AotFraming | undefined {
  if (!('framing' in asset)) return undefined;
  const f = asset.framing;
  const fail = (why = ''): never => { throw new Error('ricebox: invalid framed AOT layout' + why); };
  if (!f || (f.version !== 'sods-framed-v1' && f.version !== 'sods-framed-v2') || !Array.isArray(f.code) || !Array.isArray(f.data) ||
      !f.code.length || f.code.length + f.data.length + (f.sharedHead !== undefined ? 1 : 0) > MAX_FRAMES ||
      !natural(asset.size) || !natural(asset.bytes)) return fail();

  let at = 0;
  const ends = new Set<number>();
  function consume(chunk: AotFrame, max: number): number {
    if (!chunk || chunk.at !== at || !natural(chunk.size) || chunk.size === 0 || chunk.size > FRAME_STORED ||
        !natural(chunk.bytes) || chunk.bytes === 0 || chunk.bytes > max ||
        typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256)) return fail();
    at += chunk.size;
    if (at > asset.size) return fail();
    ends.add(at);
    return chunk.bytes;
  }
  const headBytes = consume(f.code[0]!, FIRST_FRAME_BYTES);
  if (headBytes < 8 || ('sharedHead' in f && (!f.sharedHead || consume(f.sharedHead, FIRST_FRAME_BYTES) !== headBytes))) return fail();
  let code = headBytes, data = 0;
  const destinations: {start: number; end: number}[] = [];
  for (let i = 1; i < f.code.length; ++i) code += consume(f.code[i]!, FRAME_BYTES);
  for (const chunk of f.data) {
    const size = consume(chunk, FRAME_BYTES);
    if (!natural(chunk.address) || chunk.address >= ADDRESS_LIMIT || size > ADDRESS_LIMIT - chunk.address) return fail();
    data += size;
    destinations.push({start: chunk.address, end: chunk.address + size});
  }
  destinations.sort((a,b) => a.start - b.start);
  if (destinations.some((p,i) => i > 0 && destinations[i-1]!.end > p.start)) {
    return fail(': overlapping initial data');
  }
  if (at !== asset.size || code + data !== asset.bytes || code > MAX_CODE_BYTES || data > MAX_DATA_BYTES) return fail();
  if (f.version === 'sods-framed-v1') {
    if ('shards' in f) return fail(': legacy envelope has physical shards');
  } else {
    if (!Array.isArray(f.shards) || !f.shards.length || f.shards.length > MAX_FRAMES) return fail(': missing physical shards');
    let end = 0;
    for (const shard of f.shards) {
      if (!shard || shard.at !== end || !natural(shard.size) || !shard.size || shard.size > MAX_AOT_SHARD_BYTES ||
          typeof shard.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(shard.sha256) ||
          shard.path !== `blobs/${shard.sha256}.bin`) return fail(': invalid physical shard');
      end += shard.size;
      if (!ends.has(end)) return fail(': shard splits a frame');
    }
    if (end !== asset.size) return fail(': incomplete physical shard inventory');
  }
  return f;
}

/** Ordinary blobs and v1 have a physical object at their own path. The
 * v2 artifact's path is only a digest identity for the logical concatenation. */
export function aotObjects<T extends {path: string; sha256: string; size: number; bytes: number; framing?: AotFraming}>(asset: T) {
  return aotFraming(asset)?.shards ?? [asset];
}

export function orderedAotFrames(f: AotFraming): AotFrame[] {
  return [f.code[0]!, ...(f.sharedHead ? [f.sharedHead] : []), ...f.code.slice(1), ...f.data];
}
