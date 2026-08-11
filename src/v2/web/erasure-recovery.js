// Erasure recovery for ciphertext rows. Matrix inverses are authenticated,
// encrypted directory data constructed before publication; page recovery only
// performs direct-coordinate loads and one VM vector combine per useful shard.

import { prepareByteCombiner } from './vm.js';

const clock = () => globalThis.performance?.now?.() ?? Date.now();

function directGeometry(value) {
  if (!value || !Number.isInteger(value.dataShards)
      || !Number.isInteger(value.parityShards)) {
    throw new TypeError('erasure recovery needs a direct geometry');
  }
  const data = value.dataShards;
  const total = data + value.parityShards;
  if (data <= 0 || value.parityShards <= 0 || total > 16
      || !(value.ordinalByMask instanceof Int16Array)
      || value.ordinalByMask.length !== 2 ** total
      || !(value.coefficients instanceof Uint8Array)) {
    throw new RangeError('erasure recovery geometry is not canonical');
  }
  let valid = 0;
  for (let mask = 0; mask < value.ordinalByMask.length; mask += 1) {
    let bits = mask;
    let count = 0;
    while (bits) { bits &= bits - 1; count += 1; }
    if (count === data) {
      if (value.ordinalByMask[mask] !== valid) {
        throw new RangeError('erasure mask ordinals are not canonical');
      }
      valid += 1;
    } else if (value.ordinalByMask[mask] !== -1) {
      throw new RangeError('invalid erasure mask has a coefficient row');
    }
  }
  if (value.coefficients.length !== valid * data * data) {
    throw new RangeError('erasure coefficient directory has the wrong extent');
  }
  return value;
}

/**
 * Return the recovery callback accepted by CiphertextPageFabric.
 *
 * `geometries` contains one direct table for every data-row count used by the
 * cold row grouping. The same minimized GF(2^8) artifact serves all groups.
 * A failed or unauthenticated candidate is simply absent from the availability
 * mask; no plaintext is produced until the caller subsequently opens AEAD.
 */
export async function createErasureRecovery({
  artifact, geometries, precompiled = null,
}) {
  if (!(artifact instanceof Uint8Array) || !Array.isArray(geometries)) {
    throw new TypeError('erasure recovery needs an artifact and geometries');
  }
  const byDataCount = new Map();
  for (const candidate of geometries) {
    const geometry = directGeometry(candidate);
    if (byDataCount.has(geometry.dataShards)) {
      throw new RangeError('erasure data-row count is duplicated');
    }
    byDataCount.set(geometry.dataShards, geometry);
  }
  const combiner = await prepareByteCombiner(artifact, precompiled);
  let lastProfile = null;

  const recover = async ({ directory, group, target, fetch }) => {
    const startedAt = clock();
    const record = directory?.groups?.[group];
    if (!record || !Array.isArray(record.rows)
        || !Number.isInteger(record.dataShards)
        || typeof fetch !== 'function') {
      throw new TypeError('ciphertext group has no direct recovery rows');
    }
    const geometry = byDataCount.get(record.dataShards);
    if (!geometry
        || record.rows.length !== geometry.dataShards + geometry.parityShards
        || !Number.isInteger(target) || target < 0
        || target >= geometry.dataShards) {
      throw new RangeError('ciphertext group recovery coordinate is invalid');
    }

    const sources = [];
    let mask = 0;
    for (let slot = 0; slot < record.rows.length; slot += 1) {
      if (slot === target || record.rows[slot] == null) continue;
      try {
        const row = await fetch(record.rows[slot]);
        if (!(row instanceof Uint8Array)) continue;
        if (sources.length && row.length !== sources[0].length) continue;
        sources.push(row);
        mask |= 1 << slot;
        if (sources.length === geometry.dataShards) break;
      } catch (_error) {
        // Authentication and availability failures both mean this slot cannot
        // participate. The next canonical slot is tried instead.
      }
    }
    if (sources.length !== geometry.dataShards) {
      throw new Error('not enough authenticated ciphertext rows to recover page');
    }
    const ordinal = geometry.ordinalByMask[mask];
    if (ordinal < 0) throw new Error('available ciphertext mask is not recoverable');
    const offset = (ordinal * geometry.dataShards + target)
      * geometry.dataShards;
    const selectedSources = [];
    const fixedBytes = [];
    for (let index = 0; index < geometry.dataShards; index += 1) {
      const coefficient = geometry.coefficients[offset + index];
      if (coefficient) {
        selectedSources.push(sources[index]);
        fixedBytes.push(coefficient);
      }
    }
    if (!selectedSources.length) {
      throw new Error('recovery coefficient row is empty');
    }
    const fetchedAt = clock();
    const result = combiner.combine(selectedSources, fixedBytes);
    const finishedAt = clock();
    lastProfile = {
      fetchMs: fetchedAt - startedAt,
      combineMs: finishedAt - fetchedAt,
      totalMs: finishedAt - startedAt,
      availableMask: mask,
      fetchedRows: sources.length,
      combinedRows: selectedSources.length,
      rowBytes: result.length,
    };
    globalThis.performance?.measure?.('qm:ciphertext-recover', {
      start: startedAt, end: finishedAt, detail: lastProfile,
    });
    return result;
  };
  recover.calls = combiner.calls;
  recover.misses = combiner.misses;
  recover.ok = combiner.ok;
  recover.capacity = combiner.capacity;
  recover.profile = () => (lastProfile == null ? null : { ...lastProfile });
  return recover;
}
