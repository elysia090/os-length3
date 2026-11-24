import {createHash} from 'node:crypto';
import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeSync} from 'node:fs';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {deploymentParts} from '../../sods/runtime/translate.ts';
import {
  aotFraming, FIRST_AOT_SHARD_BYTES, FIRST_FRAME_BYTES, FRAME_BYTES, MAX_AOT_SHARD_BYTES,
  type AotFrame, type AotFraming, type AotShard,
} from '../format/aot-frames.ts';
import type {DeployedWasm} from '../format/manifest.ts';

/** Keep small commands on the existing single gzip/compile path. */
export const FRAMED_MIN_BYTES = 32 << 20;

export function writeFramedAot(out: string, wasm: Uint8Array, sharded = false): DeployedWasm {
  const {head, sharedHead, code, segments} = deploymentParts(wasm, FIRST_FRAME_BYTES);
  const blobs = join(out, 'blobs');
  mkdirSync(blobs, {recursive: true});
  const pending = mkdtempSync(join(blobs, '.frames-')), temporary = join(pending, 'active');
  const whole = createHash('sha256'), shards: AotShard[] = [];
  let fd: number | undefined, sha = createHash('sha256'), shardSize = 0, size = 0, bytes = 0;
  const framing: AotFraming = {version: sharded ? 'sods-framed-v2' : 'sods-framed-v1', code: [], data: []};

  function finish() {
    if (fd === undefined) return;
    closeSync(fd);
    fd = undefined;
    const sha256 = sha.digest('hex'), path = `blobs/${sha256}.bin`;
    // Only publish these objects after the complete framed layout is valid.
    renameSync(temporary, join(pending, sha256));
    shards.push({at: size - shardSize, path, sha256, size: shardSize});
    sha = createHash('sha256');
    shardSize = 0;
  }
  try {
    function put(raw: Uint8Array, count = true): AotFrame {
      const gzip = gzipSync(raw, {level: 6});
      if (sharded && shardSize && shardSize + gzip.length > (shards.length ? MAX_AOT_SHARD_BYTES : FIRST_AOT_SHARD_BYTES)) finish();
      fd ??= openSync(temporary, 'wx');
      const frame = {at: size, size: gzip.length, bytes: raw.byteLength, sha256: createHash('sha256').update(gzip).digest('hex')};
      for (let at = 0; at < gzip.length;) {
        const n = writeSync(fd, gzip, at, gzip.length - at, null);
        if (!n) throw new Error('framed AOT output made no progress');
        at += n;
      }
      whole.update(gzip);
      sha.update(gzip);
      size += gzip.length;
      shardSize += gzip.length;
      if (count) bytes += raw.byteLength;
      return frame;
    }
    framing.code.push(put(head));
    if (sharedHead) framing.sharedHead = put(sharedHead, false);
    for (const part of code) {
      for (let i = 0; i < part.length; i += FRAME_BYTES) framing.code.push(put(part.subarray(i, i + FRAME_BYTES)));
    }
    // Overlapping segments are not supported by framed images: the static
    // loader skips some known-clean writes on address-space reuse.
    for (const segment of segments) for (let i = 0; i < segment.bytes.length; i += FRAME_BYTES) {
      framing.data.push({...put(segment.bytes.subarray(i, i + FRAME_BYTES)), address: segment.offset + i});
    }
    finish();
    const sha256 = whole.digest('hex'), path = `blobs/${sha256}.bin`, asset = {path, sha256, size, bytes, framing};
    if (sharded) framing.shards = shards;
    aotFraming(asset);
    for (const object of new Map(shards.map(p => [p.path, p])).values()) {
      if (!existsSync(join(out, object.path))) renameSync(join(pending, object.sha256), join(out, object.path));
    }
    return asset;
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(pending, {recursive: true, force: true});
  }
}
