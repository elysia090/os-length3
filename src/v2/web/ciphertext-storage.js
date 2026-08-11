// Canonical cryptographic boundary for untrusted physical-page storage.
//
// Storage supplies only opaque locators, authenticated directory bytes, and
// ciphertext rows. A caller reconstructs a missing ciphertext row first, then
// calls admitCiphertextRow. No plaintext is returned until AES-GCM, frame,
// decompression, canonical extent, and page digest have all succeeded.

const encoder = new TextEncoder();
const FRAME_BYTES = 41;
const FRAME_VERSION = 1;
export const STORAGE_PROTOCOL_VERSION = 1;
export const STORAGE_ALGORITHM_AES_256_GCM = 1;
const ROW_AAD_DOMAIN = encoder.encode('physical ciphertext row v1\0');
const ROW_LOCATOR_DOMAIN = encoder.encode('opaque physical row locator v1\0');
const ROW_AUTH_DOMAIN = encoder.encode('authenticated stored row v1\0');
const ROOT_MAGIC = encoder.encode('RTE1');
const METADATA_MAGIC = encoder.encode('MTE1');
const ROOT_AAD_DOMAIN = encoder.encode('volume root metadata v1\0');
const METADATA_AAD_DOMAIN = encoder.encode('object metadata v1\0');
const STORAGE_KDF_DOMAIN = encoder.encode('physical storage key v1\0');
const KDF_ROLES = Object.freeze({
  root: encoder.encode('volume-root'),
  metadata: encoder.encode('volume-metadata'),
  locator: encoder.encode('row-locator'),
  rowAead: encoder.encode('row-aead'),
  rowAuth: encoder.encode('row-auth'),
});

function bytes(value, label) {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  return value;
}

function integer(value, maximum, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new RangeError(`${label} is outside its physical field`);
  }
  return result;
}

function equalBytes(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function hex(value) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function concatenate(...parts) {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) { output.set(part, at); at += part.length; }
  return output;
}

async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

function dataRowNonce(group, slot) {
  group = integer(group, 0xffffffff, 'row group');
  slot = integer(slot, 0xffff, 'row slot');
  const nonce = new Uint8Array(12);
  const view = new DataView(nonce.buffer);
  // A fixed nonzero domain separates data-row nonces from any future use of
  // the same key. The key itself must be fresh for every object generation.
  view.setUint32(0, 0x31574f52, true); // "ROW1"
  view.setUint32(4, group, true);
  view.setUint16(8, slot, true);
  view.setUint16(10, 0, true);
  return nonce;
}

export async function importRowKey(raw, usages = ['encrypt', 'decrypt']) {
  raw = bytes(raw, 'AES-GCM key');
  if (![16, 24, 32].includes(raw.length)) {
    throw new RangeError('AES-GCM key must contain 128, 192, or 256 bits');
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, usages);
}

export async function importStorageMasterKey(raw) {
  raw = bytes(raw, 'storage master key');
  if (raw.length < 32) throw new RangeError('storage master key is too short');
  return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
}

async function deriveStorageKey(masterKey, salt, role, context,
                                algorithm, usages) {
  salt = bytes(salt, 'storage key salt');
  role = bytes(role, 'storage key role');
  context = bytes(context, 'storage key context');
  if (salt.length < 16) throw new RangeError('storage key salt is too short');
  const prefix = new Uint8Array(6);
  const prefixView = new DataView(prefix.buffer);
  prefixView.setUint32(0, STORAGE_PROTOCOL_VERSION, true);
  prefixView.setUint16(4, role.length, true);
  const info = concatenate(STORAGE_KDF_DOMAIN, prefix, role, context);
  return crypto.subtle.deriveKey({
    name: 'HKDF', hash: 'SHA-256', salt,
    info,
  }, masterKey, algorithm, false, usages);
}

function generationBytes(generation) {
  generation = BigInt(generation);
  if (generation < 0n || generation > 0xffffffffffffffffn) {
    throw new RangeError('object generation is outside uint64');
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, generation, true);
  return output;
}

export function newObjectSalt() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function deriveVolumeStorageKeys(masterKey, volumeSalt, volumeId) {
  volumeSalt = bytes(volumeSalt, 'volume salt');
  volumeId = bytes(volumeId, 'volume identity');
  if (volumeSalt.length !== 32 || volumeId.length !== 16) {
    throw new RangeError('volume salt must be 256 bits and identity 128 bits');
  }
  const aes = { name: 'AES-GCM', length: 256 };
  const mac = { name: 'HMAC', hash: 'SHA-256', length: 256 };
  const [rootKey, metadataKey, locatorKey] = await Promise.all([
    deriveStorageKey(masterKey, volumeSalt, KDF_ROLES.root, volumeId, aes,
      ['encrypt', 'decrypt']),
    deriveStorageKey(masterKey, volumeSalt, KDF_ROLES.metadata, volumeId, aes,
      ['encrypt', 'decrypt']),
    deriveStorageKey(masterKey, volumeSalt, KDF_ROLES.locator, volumeId,
      mac, ['sign']),
  ]);
  return { rootKey, metadataKey, locatorKey };
}

export async function deriveObjectStorageKeys(
  masterKey, objectSalt, volumeId, objectDigest, generation,
) {
  objectSalt = bytes(objectSalt, 'object salt');
  volumeId = bytes(volumeId, 'volume identity');
  objectDigest = bytes(objectDigest, 'canonical object digest');
  if (objectSalt.length !== 32 || volumeId.length !== 16
      || objectDigest.length !== 32) {
    throw new RangeError('object key context is invalid');
  }
  const common = concatenate(
    volumeId, objectDigest, generationBytes(generation),
  );
  const [rowKey, authenticatorKey] = await Promise.all([
    deriveStorageKey(masterKey, objectSalt, KDF_ROLES.rowAead, common,
      { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    deriveStorageKey(masterKey, objectSalt, KDF_ROLES.rowAuth, common,
      { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  ]);
  return { rowKey, authenticatorKey };
}

export async function importLocatorKey(raw) {
  raw = bytes(raw, 'row locator key');
  if (raw.length < 32) throw new RangeError('row locator key is too short');
  return crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

export async function importRowAuthenticatorKey(raw) {
  raw = bytes(raw, 'stored row authenticator key');
  if (raw.length < 32) throw new RangeError('row authenticator key is too short');
  return crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

export function encodeCiphertextFrame(codec, canonicalExtent, digest, encoded) {
  codec = integer(codec, 0xff, 'frame codec');
  canonicalExtent = integer(canonicalExtent, 0xffffffff, 'canonical extent');
  digest = bytes(digest, 'canonical page digest');
  encoded = bytes(encoded, 'encoded page');
  if (!canonicalExtent || digest.length !== 32) {
    throw new RangeError('ciphertext frame identity is invalid');
  }
  const output = new Uint8Array(FRAME_BYTES + encoded.length);
  const view = new DataView(output.buffer);
  view.setUint8(0, codec);
  view.setUint32(1, canonicalExtent, true);
  view.setUint32(5, encoded.length, true);
  output.set(digest, 9);
  output.set(encoded, FRAME_BYTES);
  return output;
}

export function decodeCiphertextFrame(padded) {
  padded = bytes(padded, 'decrypted ciphertext frame');
  if (padded.length < FRAME_BYTES) throw new Error('ciphertext frame is truncated');
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const codec = view.getUint8(0);
  const canonicalExtent = view.getUint32(1, true);
  const encodedExtent = view.getUint32(5, true);
  const end = FRAME_BYTES + encodedExtent;
  if (!canonicalExtent || end > padded.length) {
    throw new Error('ciphertext frame extent is invalid');
  }
  let padding = 0;
  for (let index = end; index < padded.length; index += 1) padding |= padded[index];
  if (padding) throw new Error('ciphertext frame padding is not canonical');
  return {
    codec,
    canonicalExtent,
    encodedExtent,
    digest: padded.slice(9, 41),
    encoded: padded.slice(FRAME_BYTES, end),
  };
}

export function encodeCiphertextRowAad({
  objectSalt, objectDigest, generation, group, slot, rowClass, capacity, codec,
  canonicalExtent, encodedExtent,
  algorithm = STORAGE_ALGORITHM_AES_256_GCM,
}) {
  objectSalt = bytes(objectSalt, 'object salt');
  objectDigest = bytes(objectDigest, 'canonical object digest');
  if (objectSalt.length !== 32 || objectDigest.length !== 32) {
    throw new RangeError('object salt and digest must be 256 bits');
  }
  generation = BigInt(generation);
  if (generation < 0n || generation > 0xffffffffffffffffn) {
    throw new RangeError('object generation is outside uint64');
  }
  group = integer(group, 0xffffffff, 'row group');
  slot = integer(slot, 0xffff, 'row slot');
  rowClass = integer(rowClass, 0xffffffff, 'row capacity class');
  capacity = integer(capacity, 0xffffffff, 'row capacity');
  algorithm = integer(algorithm, 0xffffffff, 'row algorithm');
  codec = integer(codec, 0xff, 'frame codec');
  canonicalExtent = integer(canonicalExtent, 0xffffffff, 'canonical extent');
  encodedExtent = integer(encodedExtent, 0xffffffff, 'encoded extent');
  if (algorithm !== STORAGE_ALGORITHM_AES_256_GCM
      || !capacity || !canonicalExtent) {
    throw new RangeError('row algorithm or extent is invalid');
  }

  const output = new Uint8Array(ROW_AAD_DOMAIN.length + 107);
  output.set(ROW_AAD_DOMAIN);
  const at = ROW_AAD_DOMAIN.length;
  const view = new DataView(output.buffer);
  view.setUint32(at, STORAGE_PROTOCOL_VERSION, true);
  view.setUint32(at + 4, algorithm, true);
  output.set(objectSalt, at + 8);
  output.set(objectDigest, at + 40);
  view.setBigUint64(at + 72, generation, true);
  view.setUint32(at + 80, group, true);
  view.setUint16(at + 84, slot, true);
  view.setUint32(at + 86, rowClass, true);
  view.setUint32(at + 90, capacity, true);
  view.setUint32(at + 94, FRAME_VERSION, true);
  view.setUint8(at + 98, codec);
  view.setUint32(at + 99, canonicalExtent, true);
  view.setUint32(at + 103, encodedExtent, true);
  return output;
}

export async function opaqueRowLocator(
  locatorKey, volumeId, objectSalt, objectDigest, generation, group, slot,
) {
  volumeId = bytes(volumeId, 'volume identity');
  objectSalt = bytes(objectSalt, 'object salt');
  objectDigest = bytes(objectDigest, 'canonical object digest');
  if (volumeId.length !== 16 || objectSalt.length !== 32
      || objectDigest.length !== 32) {
    throw new RangeError('opaque locator identity is invalid');
  }
  generation = BigInt(generation);
  if (generation < 0n || generation > 0xffffffffffffffffn) {
    throw new RangeError('object generation is outside uint64');
  }
  group = integer(group, 0xffffffff, 'row group');
  slot = integer(slot, 0xffff, 'row slot');
  const input = new Uint8Array(
    ROW_LOCATOR_DOMAIN.length + volumeId.length + objectSalt.length
      + objectDigest.length + 14,
  );
  input.set(ROW_LOCATOR_DOMAIN);
  let at = ROW_LOCATOR_DOMAIN.length;
  input.set(volumeId, at); at += volumeId.length;
  input.set(objectSalt, at); at += objectSalt.length;
  input.set(objectDigest, at); at += objectDigest.length;
  const view = new DataView(input.buffer);
  view.setBigUint64(at, generation, true);
  view.setUint32(at + 8, group, true);
  view.setUint16(at + 12, slot, true);
  return new Uint8Array(await crypto.subtle.sign('HMAC', locatorKey, input));
}

async function sealCiphertextRow(key, group, slot, aad, paddedFrame) {
  aad = bytes(aad, 'row associated data');
  paddedFrame = bytes(paddedFrame, 'padded page frame');
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: dataRowNonce(group, slot),
    additionalData: aad, tagLength: 128,
  }, key, paddedFrame);
  return new Uint8Array(ciphertext);
}

export async function openCiphertextRow(key, group, slot, aad, ciphertext) {
  aad = bytes(aad, 'row associated data');
  ciphertext = bytes(ciphertext, 'ciphertext row');
  try {
    return new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: dataRowNonce(group, slot),
      additionalData: aad, tagLength: 128,
    }, key, ciphertext));
  } catch (_error) {
    throw new Error('ciphertext row authentication failed');
  }
}

export async function storedRowAuthenticator(key, locator, row) {
  locator = bytes(locator, 'opaque row locator');
  row = bytes(row, 'stored ciphertext row');
  if (locator.length !== 32) throw new RangeError('row locator must be 256 bits');
  const input = new Uint8Array(ROW_AUTH_DOMAIN.length + locator.length + row.length);
  input.set(ROW_AUTH_DOMAIN);
  input.set(locator, ROW_AUTH_DOMAIN.length);
  input.set(row, ROW_AUTH_DOMAIN.length + locator.length);
  const tag = new Uint8Array(await crypto.subtle.sign('HMAC', key, input));
  return tag.slice(0, 16);
}

export function encodeObjectMetadataAad({
  volumeId, objectSalt, objectDigest, generation,
  algorithm = STORAGE_ALGORITHM_AES_256_GCM,
}) {
  volumeId = bytes(volumeId, 'volume identity');
  objectSalt = bytes(objectSalt, 'object salt');
  objectDigest = bytes(objectDigest, 'canonical object digest');
  algorithm = integer(algorithm, 0xffffffff, 'storage algorithm');
  if (volumeId.length !== 16 || objectSalt.length !== 32
      || objectDigest.length !== 32
      || algorithm !== STORAGE_ALGORITHM_AES_256_GCM) {
    throw new RangeError('object metadata identity is invalid');
  }
  const output = new Uint8Array(METADATA_AAD_DOMAIN.length + 96);
  output.set(METADATA_AAD_DOMAIN);
  const at = METADATA_AAD_DOMAIN.length;
  const view = new DataView(output.buffer);
  view.setUint32(at, STORAGE_PROTOCOL_VERSION, true);
  view.setUint32(at + 4, algorithm, true);
  output.set(volumeId, at + 8);
  output.set(objectSalt, at + 24);
  output.set(objectDigest, at + 56);
  output.set(generationBytes(generation), at + 88);
  return output;
}

export function encodeVolumeRootAad({
  volumeId, volumeSalt, algorithm = STORAGE_ALGORITHM_AES_256_GCM,
}) {
  volumeId = bytes(volumeId, 'volume identity');
  volumeSalt = bytes(volumeSalt, 'volume salt');
  algorithm = integer(algorithm, 0xffffffff, 'storage algorithm');
  if (volumeId.length !== 16 || volumeSalt.length !== 32
      || algorithm !== STORAGE_ALGORITHM_AES_256_GCM) {
    throw new RangeError('volume root identity is invalid');
  }
  const output = new Uint8Array(ROOT_AAD_DOMAIN.length + 56);
  output.set(ROOT_AAD_DOMAIN);
  const at = ROOT_AAD_DOMAIN.length;
  const view = new DataView(output.buffer);
  view.setUint32(at, STORAGE_PROTOCOL_VERSION, true);
  view.setUint32(at + 4, algorithm, true);
  output.set(volumeId, at + 8);
  output.set(volumeSalt, at + 24);
  return output;
}

function copyStoredRow(value) {
  return {
    locator: value.locator.slice(),
    ciphertext: value.ciphertext.slice(),
    authenticator: value.authenticator.slice(),
  };
}

/**
 * One immutable encryption generation of a canonical object.
 *
 * A coordinate is claimed before WebCrypto starts. Concurrent calls and later
 * retries therefore cannot invoke AES-GCM twice with the same key and nonce;
 * retryRow returns a copy of the original ciphertext and authenticator.
 */
export class ImmutableObjectProjection {
  constructor({
    rowKey, authenticatorKey, locatorKey, volumeId, objectSalt, objectDigest,
    generation, algorithm = STORAGE_ALGORITHM_AES_256_GCM,
  }) {
    this.rowKey = rowKey;
    this.authenticatorKey = authenticatorKey;
    this.locatorKey = locatorKey;
    this.volumeId = bytes(volumeId, 'volume identity').slice();
    this.objectSalt = bytes(objectSalt, 'object salt').slice();
    this.objectDigest = bytes(objectDigest, 'canonical object digest').slice();
    this.generation = BigInt(generation);
    this.algorithm = integer(algorithm, 0xffffffff, 'storage algorithm');
    if (rowKey?.algorithm?.name !== 'AES-GCM'
        || rowKey.algorithm.length !== 256
        || authenticatorKey?.algorithm?.name !== 'HMAC'
        || locatorKey?.algorithm?.name !== 'HMAC'
        || this.volumeId.length !== 16 || this.objectSalt.length !== 32
        || this.objectDigest.length !== 32
        || this.generation < 0n || this.generation > 0xffffffffffffffffn
        || this.algorithm !== STORAGE_ALGORITHM_AES_256_GCM) {
      throw new RangeError('immutable object projection identity is invalid');
    }
    this.rows = new Map();
  }

  async sealRow({
    group, slot, rowClass, capacity, codec, canonicalExtent, encodedExtent,
    paddedFrame,
  }) {
    group = integer(group, 0xffffffff, 'row group');
    slot = integer(slot, 0xffff, 'row slot');
    const coordinate = (BigInt(group) << 16n) | BigInt(slot);
    if (this.rows.has(coordinate)) {
      throw new Error('row coordinate was already encrypted in this object generation');
    }
    const frame = bytes(paddedFrame, 'padded page frame').slice();
    const aad = encodeCiphertextRowAad({
      objectSalt: this.objectSalt, objectDigest: this.objectDigest,
      generation: this.generation, group, slot, rowClass, capacity, codec,
      canonicalExtent, encodedExtent, algorithm: this.algorithm,
    });
    const pending = (async () => {
      try {
        const locator = await opaqueRowLocator(
          this.locatorKey, this.volumeId, this.objectSalt, this.objectDigest,
          this.generation, group, slot,
        );
        const ciphertext = await sealCiphertextRow(
          this.rowKey, group, slot, aad, frame,
        );
        const authenticator = await storedRowAuthenticator(
          this.authenticatorKey, locator, ciphertext,
        );
        return { locator, ciphertext, authenticator };
      } finally {
        frame.fill(0);
      }
    })();
    this.rows.set(coordinate, pending);
    return copyStoredRow(await pending);
  }

  async retryRow(group, slot) {
    group = integer(group, 0xffffffff, 'row group');
    slot = integer(slot, 0xffff, 'row slot');
    const coordinate = (BigInt(group) << 16n) | BigInt(slot);
    const pending = this.rows.get(coordinate);
    if (!pending) throw new Error('row coordinate has not been encrypted');
    return copyStoredRow(await pending);
  }
}

export async function verifyStoredRow(key, locator, row, authenticator) {
  authenticator = bytes(authenticator, 'stored row authenticator');
  if (authenticator.length !== 16
      || !equalBytes(await storedRowAuthenticator(key, locator, row), authenticator)) {
    throw new Error('stored ciphertext row authentication failed');
  }
  return row;
}

export class MemoryCiphertextStore {
  // Every cache tier implements this byte-only shape. It has no key, codec,
  // page digest, VFS path, or ability to decide whether a row is valid.
  constructor() {
    this.rows = new Map();
  }

  async get(locator) {
    locator = bytes(locator, 'opaque row locator');
    const row = this.rows.get(hex(locator));
    return row == null ? null : {
      row: row.row.slice(), authenticator: row.authenticator.slice(),
    };
  }

  async put(locator, row, authenticator) {
    locator = bytes(locator, 'opaque row locator');
    row = bytes(row, 'ciphertext row');
    authenticator = bytes(authenticator, 'stored row authenticator');
    if (authenticator.length !== 16) {
      throw new RangeError('stored row authenticator must be 128 bits');
    }
    const coordinate = hex(locator);
    const current = this.rows.get(coordinate);
    if (current != null) {
      if (!equalBytes(current.row, row)
          || !equalBytes(current.authenticator, authenticator)) {
        throw new Error('immutable ciphertext locator was reused');
      }
      return;
    }
    this.rows.set(coordinate, {
      row: row.slice(), authenticator: authenticator.slice(),
    });
  }

  async promote(locator, row, authenticator) {
    // A disposable cache may replace a rejected local copy with the exact
    // authenticated ciphertext fetched from a lower tier. Publication never
    // calls this method; durable coordinates remain immutable through put().
    locator = bytes(locator, 'opaque row locator');
    row = bytes(row, 'ciphertext row');
    authenticator = bytes(authenticator, 'stored row authenticator');
    if (authenticator.length !== 16) {
      throw new RangeError('stored row authenticator must be 128 bits');
    }
    this.rows.set(hex(locator), {
      row: row.slice(), authenticator: authenticator.slice(),
    });
  }
}

export async function fetchAuthenticatedRow(tiers, key, locator) {
  if (!Array.isArray(tiers) || !tiers.length) {
    throw new TypeError('ciphertext lookup needs at least one storage tier');
  }
  locator = bytes(locator, 'opaque row locator');
  let rejected = 0;
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    if (!tier || typeof tier.get !== 'function') {
      throw new TypeError('ciphertext tier does not implement get');
    }
    const candidate = await tier.get(locator);
    if (candidate == null) continue;
    try {
      await verifyStoredRow(
        key, locator, candidate.row, candidate.authenticator,
      );
    } catch (_error) {
      rejected += 1;
      continue;
    }
    // Promotion retains the verified ciphertext representation. Plaintext is
    // admitted only into the separate resident page array after AEAD/open.
    await Promise.all(tiers.slice(0, index).map((cache) => (
      typeof cache.promote === 'function'
        ? cache.promote(locator, candidate.row, candidate.authenticator)
        : typeof cache.put === 'function'
          ? cache.put(locator, candidate.row, candidate.authenticator) : null
    )));
    return { ciphertext: candidate.row, rejected, tier: index };
  }
  throw new Error('no storage tier supplied a valid ciphertext row');
}

async function decodeCanonical(frame) {
  let raw;
  if (frame.codec === 0) {
    raw = frame.encoded;
  } else if (frame.codec === 1) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('this browser cannot decode deflate page frames');
    }
    const stream = new Blob([frame.encoded]).stream()
      .pipeThrough(new DecompressionStream('deflate'));
    raw = new Uint8Array(await new Response(stream).arrayBuffer());
  } else {
    throw new Error('ciphertext frame codec is unknown');
  }
  if (raw.length !== frame.canonicalExtent) {
    throw new Error('canonical page has the wrong extent');
  }
  if (!equalBytes(await sha256(raw), frame.digest)) {
    throw new Error('canonical page digest is invalid');
  }
  return raw;
}

export async function admitCiphertextRow({
  key, group, slot, aad, reconstructedCiphertext,
}) {
  // reconstructedCiphertext is deliberately named: erasure recovery belongs
  // before this call and no decompression or page materialization is legal on
  // unauthenticated bytes.
  const padded = await openCiphertextRow(
    key, group, slot, aad, reconstructedCiphertext,
  );
  let frame;
  try {
    frame = decodeCiphertextFrame(padded);
  } finally {
    // The authenticated padded frame is only a transient admission value. Its
    // decoded payload is a separate exact slice; erase this second plaintext
    // representation before decompression or resident publication continues.
    padded.fill(0);
  }
  return decodeCanonical(frame);
}

export class CiphertextPageFabric {
  constructor({ directory, key, authenticatorKey, tiers, recoverCiphertext = null }) {
    if (!directory || !Array.isArray(directory.rows)
        || !Array.isArray(directory.groups)
        || !(directory.ranks instanceof Uint32Array)) {
      throw new TypeError('ciphertext page fabric needs a direct directory');
    }
    directory.objectDigest = bytes(
      directory.objectDigest, 'canonical object digest',
    );
    directory.objectSalt = bytes(directory.objectSalt, 'object salt');
    directory.algorithm = integer(
      directory.algorithm, 0xffffffff, 'storage algorithm',
    );
    if (directory.objectDigest.length !== 32 || directory.objectSalt.length !== 32
        || directory.algorithm !== STORAGE_ALGORITHM_AES_256_GCM) {
      throw new RangeError('canonical object cryptographic identity is invalid');
    }
    directory.length = integer(
      directory.length, Number.MAX_SAFE_INTEGER, 'canonical object extent',
    );
    directory.pageBytes = integer(
      directory.pageBytes, 0xffffffff, 'canonical page extent',
    );
    let largestRank = 0;
    for (const rank of directory.ranks) largestRank = Math.max(largestRank, rank);
    if (!directory.pageBytes
        || directory.ranks.length !== Math.ceil(directory.length / directory.pageBytes)
        || directory.rows.length <= largestRank) {
      throw new RangeError('ciphertext page directory extent is invalid');
    }
    this.directory = directory;
    this.key = key;
    this.authenticatorKey = authenticatorKey;
    this.tiers = tiers;
    this.recoverCiphertext = recoverCiphertext;
    this.resident = new Array(directory.rows.length).fill(null);
    this.rejectedRows = 0;
    this.recoveredRows = 0;
  }

  get length() { return this.directory.length; }

  async physicalPage(rank) {
    rank = integer(rank, this.directory.rows.length - 1, 'canonical page rank');
    if (!rank) return null;
    if (this.resident[rank]) return this.resident[rank];
    const record = this.directory.rows[rank];
    if (!record) throw new Error(`canonical rank ${rank} has no ciphertext row`);
    const groupRecord = this.directory.groups[record.group];
    const storedRecord = groupRecord?.rows?.[record.slot];
    if (!groupRecord || !storedRecord) {
      throw new Error('canonical rank has no direct ciphertext coordinate');
    }
    let ciphertext;
    try {
      const fetched = await fetchAuthenticatedRow(
        this.tiers, this.authenticatorKey, storedRecord.locator,
      );
      this.rejectedRows += fetched.rejected;
      ciphertext = fetched.ciphertext;
    } catch (error) {
      if (typeof this.recoverCiphertext !== 'function') throw error;
      ciphertext = bytes(await this.recoverCiphertext({
        directory: this.directory,
        group: record.group,
        target: record.slot,
        fetch: async (candidate) => (await fetchAuthenticatedRow(
          this.tiers, this.authenticatorKey, candidate.locator,
        )).ciphertext,
      }), 'reconstructed ciphertext row');
      this.recoveredRows += 1;
    }
    if (ciphertext.length !== groupRecord.capacity + 16) {
      throw new Error('ciphertext row has the wrong group extent');
    }
    const aad = encodeCiphertextRowAad({
      objectSalt: this.directory.objectSalt,
      objectDigest: this.directory.objectDigest,
      generation: this.directory.generation,
      group: record.group,
      slot: record.slot,
      rowClass: groupRecord.rowClass,
      capacity: groupRecord.capacity,
      algorithm: this.directory.algorithm,
      codec: record.codec,
      canonicalExtent: this.directory.pageBytes,
      encodedExtent: record.encodedExtent,
    });
    const pending = admitCiphertextRow({
      key: this.key, group: record.group, slot: record.slot, aad,
      reconstructedCiphertext: ciphertext,
    });
    this.resident[rank] = pending;
    try {
      return await pending;
    } catch (error) {
      this.resident[rank] = null;
      throw error;
    }
  }

  async read(offset, length) {
    offset = integer(offset, Number.MAX_SAFE_INTEGER, 'read offset');
    length = integer(length, Number.MAX_SAFE_INTEGER, 'read extent');
    if (offset + length > this.length) {
      throw new RangeError('read is outside the canonical object');
    }
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const coordinate = offset + written;
      const page = Math.floor(coordinate / this.directory.pageBytes);
      const within = coordinate % this.directory.pageBytes;
      const count = Math.min(
        length - written, this.directory.pageBytes - within,
      );
      const raw = await this.physicalPage(this.directory.ranks[page]);
      if (raw) output.set(raw.subarray(within, within + count), written);
      written += count;
    }
    return output;
  }

  releaseResident() {
    const count = this.resident.reduce((total, page, rank) => (
      total + Number(rank > 0 && page != null)
    ), 0);
    this.resident.fill(null);
    return count;
  }
}

async function sealEnvelope(key, magic, plaintext, additionalData, label) {
  plaintext = bytes(plaintext, label);
  additionalData = bytes(additionalData, `${label} associated data`);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM', iv: nonce, additionalData, tagLength: 128,
  }, key, plaintext));
  const envelope = new Uint8Array(magic.length + nonce.length + sealed.length);
  envelope.set(magic);
  envelope.set(nonce, magic.length);
  envelope.set(sealed, magic.length + nonce.length);
  return envelope;
}

async function openEnvelope(key, magic, envelope, additionalData, label) {
  envelope = bytes(envelope, `${label} envelope`);
  additionalData = bytes(additionalData, `${label} associated data`);
  if (envelope.length < 32 || !equalBytes(envelope.subarray(0, 4), magic)) {
    throw new Error(`${label} envelope format is invalid`);
  }
  try {
    return new Uint8Array(await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: envelope.subarray(4, 16),
      additionalData, tagLength: 128,
    }, key, envelope.subarray(16)));
  } catch (_error) {
    throw new Error(`${label} envelope authentication failed`);
  }
}

export async function sealMetadataObject(key, metadata, additionalData) {
  return sealEnvelope(
    key, METADATA_MAGIC, metadata, additionalData, 'metadata',
  );
}

export async function openMetadataObject(key, envelope, additionalData) {
  return openEnvelope(
    key, METADATA_MAGIC, envelope, additionalData, 'metadata',
  );
}

export async function sealRootDescriptor(key, descriptor, additionalData) {
  return sealEnvelope(
    key, ROOT_MAGIC, descriptor, additionalData, 'root',
  );
}

export async function openRootDescriptor(key, envelope, additionalData) {
  return openEnvelope(
    key, ROOT_MAGIC, envelope, additionalData, 'root',
  );
}

export class RootConflict extends Error {
  constructor() {
    super('opaque filesystem root compare-and-swap failed');
    this.name = 'RootConflict';
  }
}

export class MemoryOpaqueRootRegister {
  // Reference implementation of the sole ordering primitive. IndexedDB or a
  // cloud service may replace this class only if its compareAndSwap operation
  // is linearizable over the exact opaque bytes.
  constructor(envelope = null) {
    this.head = envelope == null ? null : bytes(envelope, 'root envelope').slice();
  }

  async read() {
    return this.head == null ? null : this.head.slice();
  }

  async compareAndSwap(expected, replacement) {
    if (expected != null) expected = bytes(expected, 'expected root envelope');
    replacement = bytes(replacement, 'replacement root envelope');
    const matches = expected == null
      ? this.head == null
      : this.head != null && equalBytes(expected, this.head);
    if (!matches) return false;
    this.head = replacement.slice();
    return true;
  }
}

export async function prepareRootPublication({ key, descriptor, additionalData }) {
  // Preparation is intentionally separate from CAS. If the CAS response is
  // lost, the exact envelope is retried; the root is never encrypted again.
  return sealRootDescriptor(key, descriptor, additionalData);
}

export async function commitRootPublication({
  register, expectedEnvelope = null, envelope,
}) {
  if (!register || typeof register.read !== 'function'
      || typeof register.compareAndSwap !== 'function') {
    throw new TypeError('root publication needs a linearizable opaque register');
  }
  envelope = bytes(envelope, 'prepared root envelope');
  if (expectedEnvelope != null) {
    expectedEnvelope = bytes(expectedEnvelope, 'expected root envelope');
  }
  let current = await register.read();
  if (current != null && equalBytes(current, envelope)) return envelope.slice();
  if (await register.compareAndSwap(expectedEnvelope, envelope)) {
    return envelope.slice();
  }
  // Resolve a lost successful CAS response without creating another nonce.
  current = await register.read();
  if (current != null && equalBytes(current, envelope)) return envelope.slice();
  throw new RootConflict();
}
