// Diagnostic immutable-object transport, not a guest VFS or a production root.
// C selects object kind/extent. One authenticated delivery chunk is retained;
// 4 KiB residency and 64 KiB transport granularity deliberately differ.
export function diagnosticExtents(objects,root,fetcher = fetch) {
  const stats = {fetches:0,fetchedBytes:0,requestedBytes:0,cacheHighWaterBytes:0,cachedBytes:0};
  let cached;
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),
    byte => byte.toString(16).padStart(2,'0')).join('');
  async function chunk(kind,row,rank) {
    if (cached?.kind === kind && cached.rank === rank) return cached.bytes;
    const start = rank * row.chunkBytes, length = Math.min(row.chunkBytes,row.bytes - start), end = start + length - 1;
    const reply = await fetcher(new URL(row.name,root),{headers:{Range:`bytes=${start}-${end}`}});
    ++stats.fetches;
    if (reply.status !== 206 || reply.headers.get('Content-Range') !== `bytes ${start}-${end}/${row.bytes}`) {
      await reply.body?.cancel();
      throw new Error('diagnostic object must return the exact C-requested delivery range');
    }
    const bytes = new Uint8Array(length), stream = reply.body?.getReader();
    if (!stream) throw new Error('missing range stream');
    let used = 0;
    try {
      for (;;) {
        const next = await stream.read();
        if (next.done) break;
        stats.fetchedBytes += next.value.length;
        if (next.value.length > length - used) throw new Error('oversized delivery chunk');
        bytes.set(next.value,used); used += next.value.length;
      }
    } finally { await stream.cancel(); stream.releaseLock(); }
    if (used !== length || await digest(bytes) !== row.chunks[rank]) throw new Error('corrupt/short delivery chunk');
    cached = {kind,rank,bytes}; stats.cachedBytes = bytes.length;
    stats.cacheHighWaterBytes = Math.max(stats.cacheHighWaterBytes,bytes.length);
    return bytes;
  }
  async function read(kind,offset,length) {
    const row = objects[kind];
    if (!row || !/^[a-z0-9.-]+$/.test(row.name) || !Number.isSafeInteger(row.bytes) || row.bytes < 1
        || row.chunkBytes !== 65536 || !Array.isArray(row.chunks) || row.chunks.length !== Math.ceil(row.bytes / 65536)
        || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1
        || length > 4096 || offset > row.bytes - length) throw new Error('invalid C object extent');
    const result = new Uint8Array(length); stats.requestedBytes += length;
    for (let copied = 0; copied < length;) {
      const at = offset + copied, rank = Math.floor(at / row.chunkBytes), local = at % row.chunkBytes;
      const bytes = await chunk(kind,row,rank), count = Math.min(length - copied,bytes.length - local);
      result.set(bytes.subarray(local,local + count),copied); copied += count;
    }
    return result;
  }
  return {read,stats};
}
