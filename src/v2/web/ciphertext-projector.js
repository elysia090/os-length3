// Cold construction of one immutable ciphertext page projection. Admission is
// handled elsewhere; this module quotients canonical pages, chooses exact row
// groups, seals each data coordinate once, and computes parity through the
// minimized GF(2^8) artifact running inside vm.wasm.

import {
  ImmutableObjectProjection, STORAGE_ALGORITHM_AES_256_GCM,
  deriveObjectStorageKeys, deriveVolumeStorageKeys,
  encodeCiphertextFrame, encodeObjectMetadataAad, newObjectSalt,
  opaqueRowLocator, sealMetadataObject, storedRowAuthenticator,
} from './ciphertext-storage.js';
import { encodeCiphertextDirectory } from './ciphertext-directory.js';
import { prepareByteCombiner } from './vm.js';

const FRAME_BYTES = 41;
const AEAD_TAG_BYTES = 16;
const ROW_AUTH_BYTES = 16;
const clock = () => globalThis.performance?.now?.() ?? Date.now();

function byteArray(value, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  return value;
}

function positiveInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${label} is outside its physical field`);
  }
  return value;
}

function hex(value) {
  return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
}

function equal(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

async function deflate(raw) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function exactCiphertextGroups(
  extents, quantum, dataShards, parityShards,
) {
  const capacities = extents.map(extent => (
    Math.ceil(extent / quantum) * quantum
  ));
  const order = capacities.map((_value, index) => index + 1).sort(
    (left, right) => capacities[left - 1] - capacities[right - 1] || left - right,
  );
  const best = [{ cost: 0, groups: 0, width: 0, previous: -1 }];
  for (let end = 1; end <= order.length; end += 1) {
    let selected = null;
    for (let start = Math.max(0, end - dataShards); start < end; start += 1) {
      const width = end - start;
      const capacity = capacities[order[end - 1] - 1];
      const candidate = {
        cost: best[start].cost
          + (width + parityShards)
            * (capacity + AEAD_TAG_BYTES + ROW_AUTH_BYTES),
        groups: best[start].groups + 1,
        width: -width,
        previous: start,
      };
      const key = value => [value.cost, value.groups, value.width, value.previous];
      const candidateKey = key(candidate);
      const selectedKey = selected == null ? null : key(selected);
      if (selected == null || candidateKey.some(
        (value, index) => value < selectedKey[index]
          && candidateKey.slice(0, index).every(
            (prefix, prefixIndex) => prefix === selectedKey[prefixIndex],
          ),
      )) selected = candidate;
    }
    best.push(selected);
  }
  const boundaries = [order.length];
  for (let cursor = order.length; cursor;) {
    cursor = best[cursor].previous;
    boundaries.push(cursor);
  }
  boundaries.reverse();
  return boundaries.slice(1).map((end, index) => {
    const start = boundaries[index];
    const ranks = order.slice(start, end);
    return {
      ranks,
      capacity: capacities[ranks[ranks.length - 1] - 1],
    };
  });
}

function geometryMap(geometries) {
  if (!Array.isArray(geometries)) {
    throw new TypeError('ciphertext projection needs recovery geometries');
  }
  const result = new Map();
  for (const geometry of geometries) {
    if (!Number.isInteger(geometry?.dataShards)
        || !Number.isInteger(geometry?.parityShards)
        || !(geometry.generator instanceof Uint8Array)) {
      throw new TypeError('ciphertext recovery geometry is incomplete');
    }
    result.set(`${geometry.dataShards}:${geometry.parityShards}`, geometry);
  }
  return result;
}

async function putEvery(stores, locator, row, authenticator) {
  await Promise.all(stores.map(store => store.put(locator, row, authenticator)));
}

export async function projectCiphertextObject({
  payload, masterKey, volumeSalt, volumeId, generation = 0n,
  stores, gfArtifact, geometries, precompiled = null,
  pageBytes = 4096, quantum = 64, dataShards = 8, parityShards = 2,
  objectSalt = null,
}) {
  payload = byteArray(payload, 'canonical object');
  volumeSalt = byteArray(volumeSalt, 'volume salt');
  volumeId = byteArray(volumeId, 'volume identity');
  gfArtifact = byteArray(gfArtifact, 'GF(2^8) artifact');
  pageBytes = positiveInteger(pageBytes, 0xffffffff, 'page extent');
  quantum = positiveInteger(quantum, 0xffffffff, 'row quantum');
  dataShards = positiveInteger(dataShards, 15, 'maximum data rows');
  parityShards = positiveInteger(parityShards, 15, 'parity rows');
  if ((quantum & (quantum - 1)) || dataShards + parityShards > 16
      || !Array.isArray(stores) || !stores.length
      || stores.some(store => typeof store?.put !== 'function')) {
    throw new RangeError('ciphertext projection geometry or stores are invalid');
  }
  objectSalt = objectSalt == null ? newObjectSalt()
    : byteArray(objectSalt, 'object salt').slice();
  if (objectSalt.length !== 32) throw new RangeError('object salt must be 256 bits');

  const startedAt = clock();
  const objectDigest = await digest(payload);
  const digestAt = clock();
  const volumeKeys = await deriveVolumeStorageKeys(masterKey, volumeSalt, volumeId);
  const objectKeys = await deriveObjectStorageKeys(
    masterKey, objectSalt, volumeId, objectDigest, generation,
  );
  const sealer = new ImmutableObjectProjection({
    rowKey: objectKeys.rowKey, authenticatorKey: objectKeys.authenticatorKey,
    locatorKey: volumeKeys.locatorKey, volumeId, objectSalt, objectDigest,
    generation,
  });
  const keysAt = clock();

  const pageCount = Math.ceil(payload.length / pageBytes);
  const logicalRanks = new Uint32Array(pageCount);
  const zeroPage = new Uint8Array(pageBytes);
  const zeroDigest = await digest(zeroPage);
  const byDigest = new Map();
  const unique = [];
  for (let page = 0; page < pageCount; page += 1) {
    const raw = new Uint8Array(pageBytes);
    raw.set(payload.subarray(page * pageBytes, (page + 1) * pageBytes));
    const pageDigest = await digest(raw);
    if (equal(pageDigest, zeroDigest)) {
      if (!equal(raw, zeroPage)) throw new Error('canonical page digest collision');
      continue;
    }
    const identity = hex(pageDigest);
    const previous = byDigest.get(identity);
    if (previous != null) {
      if (!equal(raw, unique[previous - 1].raw)) {
        throw new Error('canonical page digest collision');
      }
      logicalRanks[page] = previous;
      continue;
    }
    const compressed = await deflate(raw);
    const codec = compressed != null && compressed.length < raw.length ? 1 : 0;
    const encoded = codec ? compressed : raw;
    const frame = encodeCiphertextFrame(codec, pageBytes, pageDigest, encoded);
    const rank = unique.length + 1;
    byDigest.set(identity, rank);
    logicalRanks[page] = rank;
    unique.push({ raw, frame, codec, encodedExtent: encoded.length });
  }
  const pagesAt = clock();

  const grouped = exactCiphertextGroups(
    unique.map(record => record.frame.length),
    quantum, dataShards, parityShards,
  );
  const availableGeometries = geometryMap(geometries);
  const usedGeometries = [];
  const usedGeometryKeys = new Set();
  for (const group of grouped) {
    const key = `${group.ranks.length}:${parityShards}`;
    const geometry = availableGeometries.get(key);
    if (!geometry) throw new Error(`missing direct erasure geometry ${key}`);
    if (!usedGeometryKeys.has(key)) {
      usedGeometryKeys.add(key);
      usedGeometries.push(geometry);
    }
  }
  usedGeometries.sort(
    (left, right) => left.dataShards - right.dataShards
      || left.parityShards - right.parityShards,
  );
  const groupingAt = clock();

  const combiner = unique.length
    ? await prepareByteCombiner(gfArtifact, precompiled) : null;
  const vmAt = clock();
  const rows = new Array(unique.length + 1).fill(null);
  const directoryGroups = [];
  for (let groupIndex = 0; groupIndex < grouped.length; groupIndex += 1) {
    const group = grouped[groupIndex];
    const dataCount = group.ranks.length;
    const geometry = availableGeometries.get(`${dataCount}:${parityShards}`);
    const ciphertextRows = [];
    const storageRows = [];
    for (let slot = 0; slot < dataCount; slot += 1) {
      const rank = group.ranks[slot];
      const record = unique[rank - 1];
      const padded = new Uint8Array(group.capacity);
      padded.set(record.frame);
      const sealed = await sealer.sealRow({
        group: groupIndex, slot, rowClass: group.capacity / quantum,
        capacity: group.capacity, codec: record.codec,
        canonicalExtent: pageBytes, encodedExtent: record.encodedExtent,
        paddedFrame: padded,
      });
      padded.fill(0);
      await putEvery(
        stores, sealed.locator, sealed.ciphertext, sealed.authenticator,
      );
      ciphertextRows.push(sealed.ciphertext);
      storageRows.push({ locator: sealed.locator });
      rows[rank] = {
        group: groupIndex, slot, codec: record.codec,
        encodedExtent: record.encodedExtent,
      };
    }
    for (let parity = 0; parity < parityShards; parity += 1) {
      const slot = dataCount + parity;
      const start = slot * dataCount;
      const coefficients = Array.from(
        geometry.generator.subarray(start, start + dataCount),
      );
      const row = combiner.combine(ciphertextRows, coefficients);
      const locator = await opaqueRowLocator(
        volumeKeys.locatorKey, volumeId, objectSalt, objectDigest,
        generation, groupIndex, slot,
      );
      const authenticator = await storedRowAuthenticator(
        objectKeys.authenticatorKey, locator, row,
      );
      await putEvery(stores, locator, row, authenticator);
      storageRows.push({ locator });
    }
    directoryGroups.push({
      dataShards: dataCount, parityShards,
      rowClass: group.capacity / quantum, capacity: group.capacity,
      rows: storageRows,
    });
  }
  const rowsAt = clock();

  const directory = {
    objectSalt, objectDigest, generation: BigInt(generation),
    length: payload.length, pageBytes, quantum,
    algorithm: STORAGE_ALGORITHM_AES_256_GCM,
    ranks: logicalRanks, rows, groups: directoryGroups,
    geometries: usedGeometries,
  };
  const directoryPlaintext = encodeCiphertextDirectory(directory);
  const metadataAad = encodeObjectMetadataAad({
    volumeId, objectSalt, objectDigest, generation,
  });
  const directoryEnvelope = await sealMetadataObject(
    volumeKeys.metadataKey, directoryPlaintext, metadataAad,
  );
  const directoryDigest = await digest(directoryEnvelope);
  const finishedAt = clock();
  directoryPlaintext.fill(0);
  const profile = {
    objectDigestMs: digestAt - startedAt,
    keyDerivationMs: keysAt - digestAt,
    quotientFrameMs: pagesAt - keysAt,
    groupingMs: groupingAt - pagesAt,
    vmPrepareMs: vmAt - groupingAt,
    sealAndParityMs: rowsAt - vmAt,
    directorySealMs: finishedAt - rowsAt,
    totalMs: finishedAt - startedAt,
    logicalPages: pageCount,
    uniquePages: unique.length,
    ciphertextGroups: grouped.length,
    storedRows: directoryGroups.reduce(
      (total, group) => total + group.rows.length, 0,
    ),
  };
  globalThis.performance?.measure?.('qm:ciphertext-project', {
    start: startedAt, end: finishedAt, detail: profile,
  });
  return {
    directory, directoryEnvelope,
    directoryDigest,
    objectSalt, objectDigest, generation: BigInt(generation),
    rowKey: objectKeys.rowKey,
    authenticatorKey: objectKeys.authenticatorKey,
    metadataKey: volumeKeys.metadataKey,
    metadataAad,
    erasureCalls: combiner == null ? 0 : combiner.calls(),
    erasureMisses: combiner == null ? 0 : combiner.misses(),
    profile,
  };
}
