// Canonical plaintext for the encrypted physical-page directory. This module
// performs only fixed-width parsing and validation; encryption belongs to the
// metadata boundary in ciphertext-storage.js.

import {
  STORAGE_ALGORITHM_AES_256_GCM, STORAGE_PROTOCOL_VERSION,
} from './ciphertext-storage.js';

const MAGIC = Uint8Array.of(0x43, 0x54, 0x44, 0x31); // CTD1
const HEADER_BYTES = 112;
const RANK_RECORD_BYTES = 12;
const GROUP_BYTES = 16;
const GEOMETRY_BYTES = 12;
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function byteArray(value, length, label) {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new TypeError(`${label} must contain ${length} bytes`);
  }
  return value;
}

function uint(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} is outside its fixed-width field`);
  }
  return value;
}

function equal(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function popcount(value) {
  let count = 0;
  while (value) { value &= value - 1; count += 1; }
  return count;
}

function validateGeometry(geometry) {
  const data = uint(geometry?.dataShards, 16, 'erasure data rows');
  const parity = uint(geometry?.parityShards, 16, 'erasure parity rows');
  const total = data + parity;
  if (!data || !parity || total > 16
      || !(geometry.ordinalByMask instanceof Int16Array)
      || geometry.ordinalByMask.length !== 2 ** total
      || !(geometry.coefficients instanceof Uint8Array)
      || !(geometry.generator instanceof Uint8Array)
      || geometry.generator.length !== total * data) {
    throw new RangeError('erasure recovery geometry is invalid');
  }
  let ordinal = 0;
  for (let mask = 0; mask < geometry.ordinalByMask.length; mask += 1) {
    const expected = popcount(mask) === data ? ordinal++ : -1;
    if (geometry.ordinalByMask[mask] !== expected) {
      throw new RangeError('erasure recovery ordinals are not canonical');
    }
  }
  if (geometry.coefficients.length !== ordinal * data * data) {
    throw new RangeError('erasure recovery coefficients have the wrong extent');
  }
  for (let row = 0; row < data; row += 1) {
    for (let column = 0; column < data; column += 1) {
      if (geometry.generator[row * data + column] !== Number(row === column)) {
        throw new RangeError('erasure generator is not systematic');
      }
    }
  }
  return `${data}:${parity}`;
}

function validateDirectory(directory) {
  byteArray(directory?.objectSalt, 32, 'object salt');
  byteArray(directory?.objectDigest, 32, 'object digest');
  const generation = BigInt(directory.generation);
  if (generation < 0n || generation > 0xffffffffffffffffn) {
    throw new RangeError('object generation is outside uint64');
  }
  const length = uint(directory.length, Number.MAX_SAFE_INTEGER, 'object extent');
  const pageBytes = uint(directory.pageBytes, 0xffffffff, 'page extent');
  const quantum = uint(directory.quantum, 0xffffffff, 'row quantum');
  if (!pageBytes || !quantum || (quantum & (quantum - 1))
      || directory.algorithm !== STORAGE_ALGORITHM_AES_256_GCM
      || !(directory.ranks instanceof Uint32Array)
      || directory.ranks.length !== Math.ceil(length / pageBytes)
      || !Array.isArray(directory.rows) || directory.rows[0] !== null
      || !Array.isArray(directory.groups)
      || !Array.isArray(directory.geometries)) {
    throw new RangeError('ciphertext directory identity is invalid');
  }

  const rankCount = directory.rows.length - 1;
  const usedRanks = new Set();
  for (const rank of directory.ranks) {
    if (rank > rankCount) throw new RangeError('logical rank is outside the directory');
    if (rank) usedRanks.add(rank);
  }
  if (usedRanks.size !== rankCount) {
    throw new RangeError('logical ranks are not a quotient of canonical pages');
  }

  const coordinates = new Set();
  const geometryKeys = new Set();
  let dataRows = 0;
  let previousCapacity = 0;
  directory.groups.forEach((group, groupIndex) => {
    const data = uint(group?.dataShards, 16, 'group data rows');
    const parity = uint(group?.parityShards, 16, 'group parity rows');
    const rowClass = uint(group?.rowClass, 0xffffffff, 'row capacity class');
    const capacity = uint(group?.capacity, 0xffffffff, 'row capacity');
    if (!data || !parity || data + parity > 16 || !rowClass
        || capacity !== rowClass * quantum || capacity < previousCapacity
        || !Array.isArray(group.rows) || group.rows.length !== data + parity) {
      throw new RangeError('ciphertext group is not canonical');
    }
    group.rows.forEach(row => byteArray(row?.locator, 32, 'opaque row locator'));
    previousCapacity = capacity;
    dataRows += data;
    geometryKeys.add(`${data}:${parity}`);
    for (let slot = 0; slot < data; slot += 1) {
      coordinates.add(`${groupIndex}:${slot}`);
    }
  });
  if (dataRows !== rankCount) {
    throw new RangeError('ciphertext group data extent is invalid');
  }

  const seen = new Set();
  for (let rank = 1; rank <= rankCount; rank += 1) {
    const row = directory.rows[rank];
    const group = uint(row?.group, directory.groups.length - 1, 'rank group');
    const slot = uint(row?.slot, 0xffff, 'rank slot');
    const codec = uint(row?.codec, 0xff, 'rank codec');
    const encodedExtent = uint(
      row?.encodedExtent, 0xffffffff, 'rank encoded extent',
    );
    const groupRecord = directory.groups[group];
    const coordinate = `${group}:${slot}`;
    if (slot >= groupRecord.dataShards || codec > 1
        || encodedExtent + 41 > groupRecord.capacity || seen.has(coordinate)) {
      throw new RangeError('ciphertext rank record is not canonical');
    }
    seen.add(coordinate);
  }
  if (seen.size !== coordinates.size
      || Array.from(coordinates).some(value => !seen.has(value))) {
    throw new RangeError('ciphertext rank coordinates are not a bijection');
  }

  const orderedGeometryKeys = directory.geometries.map(validateGeometry);
  const expectedGeometryKeys = Array.from(geometryKeys).sort((left, right) => {
    const [leftData, leftParity] = left.split(':').map(Number);
    const [rightData, rightParity] = right.split(':').map(Number);
    return leftData - rightData || leftParity - rightParity;
  });
  if (orderedGeometryKeys.length !== expectedGeometryKeys.length
      || orderedGeometryKeys.some((value, index) => value !== expectedGeometryKeys[index])) {
    throw new RangeError('ciphertext recovery geometries are not canonical');
  }
  return directory;
}

class Reader {
  constructor(value) {
    this.value = value;
    this.view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    this.at = 0;
  }

  take(length) {
    if (!Number.isSafeInteger(length) || length < 0
        || this.at + length > this.value.length) {
      throw new Error('ciphertext directory is truncated');
    }
    const result = this.value.slice(this.at, this.at + length);
    this.at += length;
    return result;
  }

  u8() { const value = this.view.getUint8(this.at); this.at += 1; return value; }
  u16() { const value = this.view.getUint16(this.at, true); this.at += 2; return value; }
  i16() { const value = this.view.getInt16(this.at, true); this.at += 2; return value; }
  u32() { const value = this.view.getUint32(this.at, true); this.at += 4; return value; }
  u64() { const value = this.view.getBigUint64(this.at, true); this.at += 8; return value; }
}

export function decodeCiphertextDirectory(payload) {
  if (!(payload instanceof Uint8Array) || payload.length < HEADER_BYTES) {
    throw new Error('ciphertext directory is truncated');
  }
  const reader = new Reader(payload);
  if (!equal(reader.take(4), MAGIC)
      || reader.u16() !== STORAGE_PROTOCOL_VERSION) {
    throw new Error('ciphertext directory format is invalid');
  }
  const algorithm = reader.u16();
  const objectSalt = reader.take(32);
  const objectDigest = reader.take(32);
  const generation = reader.u64();
  const length64 = reader.u64();
  if (length64 > MAX_SAFE_BIGINT) throw new RangeError('object extent is not addressable');
  const length = Number(length64);
  const pageBytes = reader.u32();
  const quantum = reader.u32();
  const logicalCount = reader.u32();
  const rankCount = reader.u32();
  const groupCount = reader.u32();
  const geometryCount = reader.u32();
  const ranks = new Uint32Array(logicalCount);
  for (let index = 0; index < ranks.length; index += 1) ranks[index] = reader.u32();
  const rows = [null];
  for (let rank = 0; rank < rankCount; rank += 1) {
    const group = reader.u32();
    const slot = reader.u16();
    const codec = reader.u8();
    if (reader.u8()) throw new Error('ciphertext rank reserved field is nonzero');
    rows.push({ group, slot, codec, encodedExtent: reader.u32() });
  }
  const groups = [];
  for (let index = 0; index < groupCount; index += 1) {
    const dataShards = reader.u16();
    const parityShards = reader.u16();
    const rowClass = reader.u32();
    const capacity = reader.u32();
    const locatorCount = reader.u32();
    const groupRows = [];
    for (let slot = 0; slot < locatorCount; slot += 1) {
      groupRows.push({ locator: reader.take(32) });
    }
    groups.push({ dataShards, parityShards, rowClass, capacity, rows: groupRows });
  }
  const geometries = [];
  for (let index = 0; index < geometryCount; index += 1) {
    const dataShards = reader.u16();
    const parityShards = reader.u16();
    const maskCount = reader.u32();
    const coefficientCount = reader.u32();
    const generator = reader.take((dataShards + parityShards) * dataShards);
    const ordinalByMask = new Int16Array(maskCount);
    for (let mask = 0; mask < maskCount; mask += 1) {
      ordinalByMask[mask] = reader.i16();
    }
    geometries.push({
      dataShards, parityShards, ordinalByMask, generator,
      coefficients: reader.take(coefficientCount),
    });
  }
  if (reader.at !== payload.length) {
    throw new Error('ciphertext directory has trailing bytes');
  }
  return validateDirectory({
    objectSalt, objectDigest, generation, length, pageBytes, quantum,
    algorithm, ranks, rows, groups, geometries,
  });
}

export function encodeCiphertextDirectory(directory) {
  directory = validateDirectory(directory);
  const rankCount = directory.rows.length - 1;
  const length = HEADER_BYTES + directory.ranks.length * 4
    + rankCount * RANK_RECORD_BYTES
    + directory.groups.reduce(
      (total, group) => total + GROUP_BYTES + group.rows.length * 32, 0,
    )
    + directory.geometries.reduce(
      (total, geometry) => total + GEOMETRY_BYTES
        + geometry.generator.length + geometry.ordinalByMask.length * 2
        + geometry.coefficients.length, 0,
    );
  const output = new Uint8Array(length);
  const view = new DataView(output.buffer);
  let at = 0;
  const put = (value) => { output.set(value, at); at += value.length; };
  const u8 = (value) => { view.setUint8(at, value); at += 1; };
  const u16 = (value) => { view.setUint16(at, value, true); at += 2; };
  const i16 = (value) => { view.setInt16(at, value, true); at += 2; };
  const u32 = (value) => { view.setUint32(at, value, true); at += 4; };
  const u64 = (value) => { view.setBigUint64(at, BigInt(value), true); at += 8; };
  put(MAGIC); u16(STORAGE_PROTOCOL_VERSION); u16(directory.algorithm);
  put(directory.objectSalt); put(directory.objectDigest);
  u64(directory.generation); u64(directory.length);
  u32(directory.pageBytes); u32(directory.quantum);
  u32(directory.ranks.length); u32(rankCount);
  u32(directory.groups.length); u32(directory.geometries.length);
  directory.ranks.forEach(u32);
  for (let rank = 1; rank <= rankCount; rank += 1) {
    const row = directory.rows[rank];
    u32(row.group); u16(row.slot); u8(row.codec); u8(0); u32(row.encodedExtent);
  }
  for (const group of directory.groups) {
    u16(group.dataShards); u16(group.parityShards);
    u32(group.rowClass); u32(group.capacity); u32(group.rows.length);
    group.rows.forEach(row => put(row.locator));
  }
  for (const geometry of directory.geometries) {
    u16(geometry.dataShards); u16(geometry.parityShards);
    u32(geometry.ordinalByMask.length); u32(geometry.coefficients.length);
    put(geometry.generator);
    geometry.ordinalByMask.forEach(i16);
    put(geometry.coefficients);
  }
  return output;
}
