// Range-first reader for PGF1/PGB1 physical-page bundles.
//
// A bundle is a disposable projection of one canonical byte object. Its
// authenticated prefix maps logical pages to shared physical shards and holds
// one digest per encoded payload. Only the shard containing a requested byte
// range is fetched, decompressed, verified, and retained in memory.

const BUNDLE_HEADER_BYTES = 20;
const MANIFEST_HEADER_BYTES = 104;
const BUNDLE_RECORD_BYTES = 46;
const BUNDLE_MAGIC = 'PGB1';
const MANIFEST_MAGIC = 'PGF1';
const BUNDLE_VERSION = 4;
const MANIFEST_VERSION = 1;

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function safeInteger(value, label) {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the browser integer range`);
  }
  return number;
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function readUleb(bytes, state) {
  let value = 0;
  let factor = 1;
  let count = 0;
  for (;;) {
    if (state.at >= state.end || count >= 8) {
      throw new Error('page directory integer is truncated');
    }
    const byte = bytes[state.at++];
    value += (byte & 0x7f) * factor;
    if (!Number.isSafeInteger(value)) {
      throw new Error('page directory integer is outside the browser range');
    }
    count += 1;
    if (!(byte & 0x80)) {
      if (count > 1 && byte === 0) {
        throw new Error('page directory integer is not canonical');
      }
      return value;
    }
    factor *= 128;
  }
}

async function sourceRange(source, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0) {
    throw new Error('page bundle range is invalid');
  }
  if (source.blob) {
    const end = offset + length;
    if (end > source.blob.size) throw new Error('page bundle range is truncated');
    const bytes = new Uint8Array(
      await source.blob.slice(offset, end).arrayBuffer(),
    );
    source.requests += 1;
    source.transferredBytes += bytes.length;
    return bytes;
  }
  if (source.full) {
    const end = offset + length;
    if (end > source.full.length) throw new Error('page bundle range is truncated');
    return source.full.subarray(offset, end);
  }
  if (source.reader) {
    const bytes = await source.reader(offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
      throw new Error('page bundle reader returned the wrong extent');
    }
    source.requests += 1;
    source.transferredBytes += bytes.length;
    return bytes;
  }
  if (!source.url) throw new Error('page bundle needs a Blob or URL');
  const response = await fetch(source.url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    cache: 'force-cache',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  source.requests += 1;
  source.transferredBytes += bytes.length;
  if (response.status === 206) {
    if (bytes.length !== length) throw new Error('page bundle range has the wrong extent');
    return bytes;
  }
  if (response.status === 200) {
    // Some static development servers ignore Range. Retain that one response
    // as the cold backing rather than downloading the same bundle again.
    const end = offset + length;
    if (end > bytes.length) throw new Error('page bundle response is truncated');
    source.full = bytes;
    return bytes.subarray(offset, end);
  }
  throw new Error(`page bundle range expected HTTP 206, got ${response.status}`);
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function decodePayload(payload, pageBytes) {
  if (!payload.length) throw new Error('physical shard is empty');
  let raw;
  if (payload[0] === 0) {
    raw = payload.subarray(1);
  } else if (payload[0] === 1) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('this browser cannot decode deflate page shards');
    }
    const stream = new Blob([payload.subarray(1)]).stream()
      .pipeThrough(new DecompressionStream('deflate'));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error('physical shard codec is unknown');
  }
  if (raw.length !== pageBytes) throw new Error('physical shard has the wrong extent');
  return raw;
}

function parseManifest(prefix, start, length) {
  const end = start + length;
  if (length < MANIFEST_HEADER_BYTES || end > prefix.length) {
    throw new Error('page manifest header is truncated');
  }
  const view = new DataView(prefix.buffer, prefix.byteOffset + start, length);
  if (ascii(prefix, start, 4) !== MANIFEST_MAGIC
      || view.getUint16(4, true) !== MANIFEST_VERSION
      || view.getUint16(6, true) !== MANIFEST_HEADER_BYTES) {
    throw new Error('page manifest format is unknown');
  }
  const objectDigest = prefix.slice(start + 8, start + 40);
  const generation = safeInteger(view.getBigUint64(40, true), 'generation');
  const byteLength = safeInteger(view.getBigUint64(48, true), 'object length');
  const pageBytes = view.getUint32(56, true);
  const uniquePages = view.getUint32(60, true);
  const dataShards = view.getUint16(64, true);
  const parityShards = view.getUint16(66, true);
  const shardRoot = prefix.slice(start + 68, start + 100);
  const nonzero = view.getUint32(100, true);
  if (!pageBytes || !dataShards || dataShards + parityShards > 255) {
    throw new Error('page manifest geometry is invalid');
  }
  const pageCount = Math.ceil(byteLength / pageBytes);
  // Preserve the codec's sparse normal form after opening.  Expanding this
  // into `pageCount` slots makes a large zero address space consume linear
  // browser memory even when only a few coordinates exist.
  const coordinates = new Float64Array(nonzero);
  const ranks = new Uint32Array(nonzero);
  const state = { at: start + MANIFEST_HEADER_BYTES, end };
  let previous = -1;
  let nextRank = 1;
  for (let index = 0; index < nonzero; index += 1) {
    const gap = readUleb(prefix, state);
    const rank = readUleb(prefix, state);
    const page = previous + gap + 1;
    if (page >= pageCount || !rank || rank > uniquePages) {
      throw new Error('page manifest coordinate is invalid');
    }
    if (rank === nextRank) {
      nextRank += 1;
    } else if (rank > nextRank) {
      throw new Error('unique pages are not first-coordinate ranked');
    }
    coordinates[index] = page;
    ranks[index] = rank;
    previous = page;
  }
  if (state.at !== end || nextRank - 1 !== uniquePages) {
    throw new Error('page manifest directory is not canonical');
  }
  return {
    objectDigest,
    generation,
    length: byteLength,
    pageBytes,
    pageCount,
    coordinates,
    ranks,
    uniquePages,
    dataShards,
    parityShards,
    shardRoot,
  };
}

function rankAt(manifest, page) {
  let low = 0;
  let high = manifest.coordinates.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (manifest.coordinates[middle] < page) low = middle + 1;
    else high = middle;
  }
  return low < manifest.coordinates.length
      && manifest.coordinates[low] === page ? manifest.ranks[low] : 0;
}

function parseBundle(prefix) {
  if (prefix.length < BUNDLE_HEADER_BYTES) throw new Error('page bundle header is truncated');
  const view = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength);
  if (ascii(prefix, 0, 4) !== BUNDLE_MAGIC
      || view.getUint16(4, true) !== BUNDLE_VERSION
      || view.getUint16(6, true) !== BUNDLE_HEADER_BYTES) {
    throw new Error('page bundle format is unknown');
  }
  const manifestBytes = view.getUint32(8, true);
  const recordCount = view.getUint32(12, true);
  const proofNodes = view.getUint32(16, true);
  if (proofNodes) throw new Error('direct page bundle has a redundant proof directory');
  const expected = BUNDLE_HEADER_BYTES + manifestBytes
    + recordCount * BUNDLE_RECORD_BYTES;
  if (expected !== prefix.length) throw new Error('page bundle prefix has the wrong extent');
  const manifest = parseManifest(prefix, BUNDLE_HEADER_BYTES, manifestBytes);
  let at = BUNDLE_HEADER_BYTES + manifestBytes;
  let previousPosition = -1;
  let previousPayloadEnd = 0;
  const width = manifest.dataShards + manifest.parityShards;
  const groups = Math.ceil(manifest.uniquePages / manifest.dataShards);
  const records = new Map();
  for (let index = 0; index < recordCount; index += 1) {
    const group = view.getUint32(at, true);
    const slot = view.getUint16(at + 4, true);
    const offset = view.getUint32(at + 6, true);
    const bytes = view.getUint32(at + 10, true);
    const digest = prefix.slice(at + 14, at + 46);
    const position = group * width + slot;
    if (group >= groups || slot >= width || position <= previousPosition
        || !bytes || offset !== previousPayloadEnd) {
      throw new Error('page bundle record is not canonical');
    }
    records.set(position, { offset, bytes, digest });
    previousPosition = position;
    previousPayloadEnd = offset + bytes;
    at += BUNDLE_RECORD_BYTES;
  }
  return { manifest, records, payloadBytes: previousPayloadEnd };
}

export class PageBundle {
  constructor(source, prefix, manifest, records, wavePages = 1,
              cachePages = 32) {
    this.source = source;
    this.prefix = prefix;
    this.manifest = manifest;
    this.records = records;
    this.wavePages = wavePages;
    this.cachePages = cachePages;
    // Only pending and resident ranks have host objects.  Cache metadata is
    // bounded by the configured residency plus in-flight waves, rather than
    // by every cold unique page in the artifact.
    this.cache = new Map();
    this.resident = 0;
    this.verifiedShards = 0;
  }

  get length() { return this.manifest.length; }

  get pageBytes() { return this.manifest.pageBytes; }

  record(rank) {
    const zeroBased = rank - 1;
    const group = Math.floor(zeroBased / this.manifest.dataShards);
    const slot = zeroBased % this.manifest.dataShards;
    return this.records.get(
      group * (this.manifest.dataShards + this.manifest.parityShards) + slot
    );
  }

  evictCold() {
    while (this.resident > this.cachePages) {
      let evicted = false;
      for (const [rank, entry] of this.cache) {
        if (entry.state !== 2) continue;
        this.cache.delete(rank);
        this.resident -= 1;
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  async admit(payload, record) {
    const raw = await decodePayload(payload, this.manifest.pageBytes);
    const framed = new Uint8Array(raw.length + 1);
    framed.set(raw, 1);
    const actual = await sha256(framed);
    if (!equalBytes(actual, record.digest)) {
      throw new Error('physical shard digest is invalid');
    }
    this.verifiedShards += 1;
    return raw;
  }

  async physicalPage(rank) {
    if (!rank) return null;
    let entry = this.cache.get(rank);
    if (entry) {
      // Map insertion order is the LRU order.  Refresh without allocating a
      // second per-rank state structure.
      this.cache.delete(rank);
      this.cache.set(rank, entry);
      return entry.pending;
    }
    const selected = [];
    let firstOffset = null;
    let lastOffset = 0;
    for (let current = rank;
      current <= this.manifest.uniquePages
        && current < rank + this.wavePages;
      current += 1) {
      if (this.cache.has(current)) continue;
      const record = this.record(current);
      if (!record) throw new Error(`physical page rank ${current} is not in this bundle`);
      firstOffset = firstOffset == null ? record.offset
        : Math.min(firstOffset, record.offset);
      lastOffset = Math.max(lastOffset, record.offset + record.bytes);
      selected.push({ rank: current, record, index: selected.length });
    }
    const wave = (async () => {
      const payloads = await sourceRange(
        this.source, this.prefix.length + firstOffset, lastOffset - firstOffset,
      );
      const decoded = new Array(selected.length);
      await Promise.all(selected.map(async ({ record, index }) => {
        const start = record.offset - firstOffset;
        decoded[index] = await this.admit(
          payloads.subarray(start, start + record.bytes), record,
        );
      }));
      return decoded;
    })();
    for (const item of selected) {
      const newEntry = { state: 1, pending: null };
      newEntry.pending = wave.then((decoded) => {
        const raw = decoded[item.index];
        if (this.cache.get(item.rank) === newEntry && newEntry.state === 1) {
          newEntry.state = 2;
          this.resident += 1;
          this.evictCold();
        }
        return raw;
      });
      this.cache.set(item.rank, newEntry);
    }
    const pending = this.cache.get(rank)?.pending;
    try {
      return await pending;
    } catch (error) {
      for (const item of selected) {
        const failed = this.cache.get(item.rank);
        if (!failed) continue;
        if (failed.state === 2) this.resident -= 1;
        this.cache.delete(item.rank);
      }
      throw error;
    }
  }

  async read(offset, length) {
    offset = safeInteger(offset, 'read offset');
    length = safeInteger(length, 'read length');
    if (offset + length > this.length) throw new Error('read is outside the canonical object');
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const coordinate = offset + written;
      const page = Math.floor(coordinate / this.pageBytes);
      const within = coordinate % this.pageBytes;
      const count = Math.min(length - written, this.pageBytes - within);
      const rank = rankAt(this.manifest, page);
      const raw = await this.physicalPage(rank);
      if (raw) output.set(raw.subarray(within, within + count), written);
      written += count;
    }
    return output;
  }

  /**
   * Reconstruct a consumer that requires the complete canonical object.
   *
   * Native WebAssembly.compile has this boundary today. Encoded shards arrive
   * in one range wave, while decoded pages are copied directly into the result
   * and are not retained as a second full resident representation.
   */
  async readAll(concurrency = 16, onProgress = null) {
    concurrency = safeInteger(concurrency, 'decode concurrency');
    if (!concurrency) throw new Error('decode concurrency must be positive');
    const coordinates = Array.from(
      { length: this.manifest.uniquePages + 1 }, () => [],
    );
    for (let index = 0; index < this.manifest.coordinates.length; index += 1) {
      coordinates[this.manifest.ranks[index]].push(
        this.manifest.coordinates[index],
      );
    }
    const work = [];
    let payloadBytes = 0;
    for (let rank = 1; rank <= this.manifest.uniquePages; rank += 1) {
      const record = this.record(rank);
      if (!record) throw new Error(`physical page rank ${rank} is not in this bundle`);
      payloadBytes = Math.max(payloadBytes, record.offset + record.bytes);
      work.push({ rank, record });
    }
    const payloads = payloadBytes
      ? await sourceRange(this.source, this.prefix.length, payloadBytes)
      : new Uint8Array();
    const output = new Uint8Array(this.length);
    if (onProgress) onProgress({ decoded: 0, total: work.length });
    for (let start = 0; start < work.length; start += concurrency) {
      const decoded = await Promise.all(
        work.slice(start, start + concurrency).map(async ({ rank, record }) => ({
          rank,
          raw: await this.admit(
            payloads.subarray(record.offset, record.offset + record.bytes), record,
          ),
        })),
      );
      for (const { rank, raw } of decoded) {
        for (const page of coordinates[rank]) {
          const at = page * this.pageBytes;
          output.set(raw.subarray(0, Math.min(this.pageBytes, this.length - at)), at);
        }
      }
      if (onProgress) onProgress({
        decoded: Math.min(start + decoded.length, work.length),
        total: work.length,
      });
    }
    return output;
  }

  releaseResident() {
    const pages = this.resident;
    this.cache.clear();
    this.resident = 0;
    return pages;
  }

  release() {
    const pages = this.releaseResident();
    this.source.full = null;
    return pages;
  }

  layout() {
    return {
      length: this.length,
      pageBytes: this.pageBytes,
      logicalPages: this.manifest.pageCount,
      mappedPages: this.manifest.coordinates.length,
      uniquePages: this.manifest.uniquePages,
      wavePages: this.wavePages,
      cachePages: this.cachePages,
      cacheEntries: this.cache.size,
      residentPages: this.resident,
      rangeRequests: this.source.requests,
      fetchedBytes: this.source.transferredBytes,
      verifiedShards: this.verifiedShards,
    };
  }
}

export async function openPageBundle(options = {}) {
  const prefixBytes = safeInteger(options.prefixBytes, 'page bundle prefix size');
  if (prefixBytes < BUNDLE_HEADER_BYTES) throw new Error('page bundle prefix is too small');
  const source = {
    blob: options.blob || null,
    url: options.url || null,
    reader: typeof options.reader === 'function' ? options.reader : null,
    full: null,
    requests: 0,
    transferredBytes: 0,
  };
  const prefix = await sourceRange(source, 0, prefixBytes);
  if (!options.prefixSha256) throw new Error('page bundle prefix digest is required');
  const expected = String(options.prefixSha256).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected) || hex(await sha256(prefix)) !== expected) {
    throw new Error('page bundle prefix digest is invalid');
  }
  const { manifest, records } = parseBundle(prefix);
  if (options.objectSha256) {
    const expectedObject = String(options.objectSha256).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expectedObject)
        || hex(manifest.objectDigest) !== expectedObject) {
      throw new Error('page bundle canonical object digest is invalid');
    }
  }
  const wavePages = options.wavePages == null
    ? 1 : safeInteger(options.wavePages, 'page range wave');
  if (!wavePages) throw new Error('page range wave must be positive');
  const cachePages = options.cachePages == null
    ? Math.min(32, manifest.uniquePages)
    : safeInteger(options.cachePages, 'resident page capacity');
  if (manifest.uniquePages
      && cachePages < Math.min(wavePages, manifest.uniquePages)) {
    throw new Error('resident page capacity is smaller than one range wave');
  }
  return new PageBundle(
    source, prefix, manifest, records, wavePages, cachePages,
  );
}
