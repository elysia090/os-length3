// Identity-addressed artifacts backed by replaceable physical-page delivery.

import { openPageBundle } from './page-fabric.js';

const DIGEST = /^[0-9a-f]{64}$/;

function hex(bytes) {
  return Array.from(
    bytes, (value) => value.toString(16).padStart(2, '0'),
  ).join('');
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the browser integer range`);
  }
  return number;
}

async function jsonAt(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`artifact index: HTTP ${response.status}`);
  return response.json();
}

async function fixedBytes(url, length, digest, label) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== length || hex(new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes),
  )) !== digest) {
    throw new Error(`${label} identity is invalid`);
  }
  return bytes;
}

export function artifactUrl(path = '', configured = null) {
  let root = configured || globalThis.QM_ARTIFACT_ROOT || null;
  if (root) return new URL(path, new URL(root, import.meta.url));
  root = new URL('../artifact/', import.meta.url);
  // The deployed trees are siblings. Source-level Node parity tests import
  // this file three directories below the repository artifact mount.
  if (root.protocol === 'file:') root = new URL('../../../artifact/', import.meta.url);
  return new URL(path, root);
}

async function resolveArtifact(name, root) {
  const normalized = String(name || '').toLowerCase();
  const catalog = await jsonAt(new URL('index.json', root));
  const artifacts = catalog?.schema === 1 ? catalog.artifacts : null;
  const selected = DIGEST.test(normalized)
    ? Object.values(artifacts || {}).find(
      (entry) => String(entry?.identity).toLowerCase() === normalized,
    )
    : artifacts?.[name];
  const identity = String(selected?.identity || '').toLowerCase();
  const path = String(selected?.path || '');
  if (!DIGEST.test(identity)
      || !/^(?:[a-z0-9][a-z0-9._-]*\/)+index\.json$/.test(path)) {
    throw new Error(`artifact ${name} is not in the catalog`);
  }
  return { identity, path, selected };
}

/**
 * Open the post-link compiler's direct executable projection.
 *
 * JavaScript authenticates only the two fixed roots named by the catalog.
 * vm.wasm walks the delivery directory and asks this source for opaque pack
 * ranges; no locator, executable row or x86 state is decoded on the host.
 */
export async function openDirectArtifact(name, options = {}) {
  const root = artifactUrl('', options.root || null);
  const resolved = await resolveArtifact(name, root);
  const indexUrl = new URL(resolved.path, root);
  const index = await jsonAt(indexUrl);
  const identity = index?.identity;
  const executable = index?.executable;
  const delivery = index?.delivery;
  const deliveryDigest = String(delivery?.root_sha256 || '').toLowerCase();
  const packBytes = safeInteger(delivery?.pack_bytes, 'delivery pack extent');
  const directoryBytes = safeInteger(
    delivery?.directory_bytes, 'delivery directory extent',
  );
  const declaredClosureBytes = safeInteger(
    delivery?.closure_bytes, 'delivery closure extent',
  );
  if (index?.schema !== 2
      || index?.format !== 'postlink-direct-executable-v1'
      || identity?.algorithm !== 'sha256'
      || String(identity?.digest).toLowerCase() !== resolved.identity
      || safeInteger(identity?.bytes, 'direct executable extent') !== 1696
      || executable?.file !== 'executable.root'
      || executable?.bytes !== identity.bytes
      || String(executable?.sha256).toLowerCase() !== resolved.identity
      || delivery?.format !== 'postlink-delivery-directory-v2'
      || delivery?.root_file !== 'delivery.root'
      || delivery?.root_bytes !== 192
      || !DIGEST.test(deliveryDigest)
      || delivery?.pack_file !== 'objects.pack'
      || !packBytes || !directoryBytes || directoryBytes > packBytes
      || declaredClosureBytes < packBytes + identity.bytes
                                     + delivery.root_bytes) {
    throw new Error('direct executable index is invalid');
  }

  const backingSpecs = [];
  const backingRanks = new Set();
  for (const raw of index.backings || []) {
    const sourceRank = safeInteger(raw?.source_rank, 'backing source rank');
    const physicalAddress = safeInteger(
      raw?.physical_address, 'backing physical address',
    );
    const canonicalBytes = safeInteger(
      raw?.canonical_bytes, 'backing canonical extent',
    );
    const mappedBytes = safeInteger(
      raw?.mapped_bytes, 'backing mapped extent',
    );
    const identity = String(raw?.identity || '').toLowerCase();
    const artifact = String(raw?.artifact || '');
    if (!sourceRank || backingRanks.has(sourceRank)
        || !DIGEST.test(identity) || !artifact
        || physicalAddress % 4096 || mappedBytes % 4096
        || !canonicalBytes || canonicalBytes > mappedBytes) {
      throw new Error('direct executable backing is invalid');
    }
    backingRanks.add(sourceRank);
    backingSpecs.push({
      artifact, canonicalBytes, identity, mappedBytes,
      physicalAddress, sourceRank,
    });
  }

  const [executableRoot, deliveryRoot] = await Promise.all([
    fixedBytes(
      new URL(executable.file, indexUrl), identity.bytes,
      resolved.identity, 'direct executable root',
    ),
    fixedBytes(
      new URL(delivery.root_file, indexUrl), delivery.root_bytes,
      deliveryDigest, 'direct delivery root',
    ),
  ]);
  const packUrl = new URL(delivery.pack_file, indexUrl);
  const backings = new Map();
  try {
    for (const spec of backingSpecs) {
      const opened = await openArtifact(spec.artifact, {
        root,
        wavePages: options.backingWavePages == null
          ? 2 : options.backingWavePages,
        cachePages: options.backingCachePages == null
          ? 16 : options.backingCachePages,
      });
      if (opened.identity !== spec.identity
          || opened.fabric.length !== spec.canonicalBytes) {
        opened.fabric.release();
        throw new Error(`backing ${spec.artifact} has the wrong identity`);
      }
      backings.set(spec.sourceRank, { ...spec, opened });
    }
  } catch (error) {
    for (const backing of backings.values()) backing.opened.fabric.release();
    throw error;
  }
  const backingDeliveryIdentities = new Set();
  let backingDeliveryBytes = 0;
  for (const backing of backings.values()) {
    const deliveryIdentity = String(backing.opened.index?.preferred || '')
      .toLowerCase();
    const deliveryBytes = safeInteger(
      backing.opened.delivery?.bytes, 'backing delivery extent',
    );
    if (!DIGEST.test(deliveryIdentity) || !deliveryBytes) {
      throw new Error('direct executable backing delivery is invalid');
    }
    if (!backingDeliveryIdentities.has(deliveryIdentity)) {
      backingDeliveryIdentities.add(deliveryIdentity);
      backingDeliveryBytes += deliveryBytes;
    }
  }
  const closureBytes = packBytes + executableRoot.length
    + deliveryRoot.length + backingDeliveryBytes;
  if (closureBytes !== declaredClosureBytes) {
    for (const backing of backings.values()) backing.opened.fabric.release();
    throw new Error(
      `direct delivery closure differs: ${closureBytes} != ${declaredClosureBytes}`,
    );
  }
  let released = false;
  let rangeRequests = 0;
  let logicalRangeRequests = 0;
  let rangeCacheHits = 0;
  let fetchedBytes = 0;
  const rangeCacheLimitBytes = 2 * 1024 * 1024;
  const rangeCache = new Map();
  let residentRangeBytes = 0;

  async function exactRange(offset, length) {
    const key = `${offset}:${length}`;
    if (rangeCache.has(key)) {
      const resident = rangeCache.get(key);
      rangeCache.delete(key);
      rangeCache.set(key, resident);
      rangeCacheHits += 1;
      return resident;
    }
    const final = offset + length - 1;
    const response = await fetch(packUrl, {
      headers: { Range: `bytes=${offset}-${final}` },
      cache: 'force-cache',
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expected = `bytes ${offset}-${final}/${packBytes}`;
    if (response.status !== 206
        || response.headers.get('Content-Range') !== expected
        || bytes.length !== length) {
      throw new Error(
        `direct delivery requires an exact HTTP Range response (${response.status})`,
      );
    }
    rangeRequests += 1;
    fetchedBytes += bytes.length;
    rangeCache.set(key, bytes);
    residentRangeBytes += bytes.length;
    while (residentRangeBytes > rangeCacheLimitBytes && rangeCache.size > 1) {
      const oldest = rangeCache.keys().next().value;
      residentRangeBytes -= rangeCache.get(oldest).length;
      rangeCache.delete(oldest);
    }
    return bytes;
  }

  const source = {
    async readRange(offset, length, total) {
      offset = safeInteger(offset, 'delivery pack offset');
      length = safeInteger(length, 'delivery pack range');
      total = safeInteger(total, 'delivery pack extent');
      if (released || !length || total !== packBytes
          || offset + length > packBytes) {
        throw new Error('direct delivery pack range is invalid');
      }
      logicalRangeRequests += 1;
      return (await exactRange(offset, length)).slice();
    },
    async readBackingRange(rank, address, offset, length, total) {
      rank = safeInteger(rank, 'backing source rank');
      address = safeInteger(address, 'backing physical address');
      offset = safeInteger(offset, 'backing object offset');
      length = safeInteger(length, 'backing object range');
      total = safeInteger(total, 'backing object extent');
      const backing = backings.get(rank);
      if (released || !backing || !length || offset + length > total
          || address < backing.physicalAddress
          || address + total > backing.physicalAddress + backing.mappedBytes) {
        throw new Error('direct executable backing range is invalid');
      }
      const coordinate = address - backing.physicalAddress + offset;
      if (coordinate + length > backing.canonicalBytes) {
        throw new Error('direct executable backing exceeds canonical bytes');
      }
      return backing.opened.fabric.read(coordinate, length);
    },
  };
  return {
    identity: resolved.identity,
    index,
    root: executableRoot,
    deliveryRoot,
    source,
    layout() {
      return {
        packBytes, directoryBytes, backingDeliveryBytes, closureBytes,
        logicalRangeRequests,
        rangeRequests, rangeCacheHits,
        fetchedBytes, residentRangeBytes,
        fixedRootBytes: executableRoot.length + deliveryRoot.length,
        backings: Array.from(backings.values(), backing => ({
          artifact: backing.artifact,
          canonicalBytes: backing.canonicalBytes,
          deliveryBytes: safeInteger(
            backing.opened.delivery.bytes, 'backing delivery extent',
          ),
          physicalAddress: backing.physicalAddress,
          sourceRank: backing.sourceRank,
          layout: backing.opened.fabric.layout(),
        })),
      };
    },
    release() {
      released = true;
      rangeCache.clear();
      residentRangeBytes = 0;
      for (const backing of backings.values()) backing.opened.fabric.release();
      backings.clear();
    },
  };
}

/** Open one physical projection without reconstructing the canonical object. */
export async function openArtifact(name, options = {}) {
  const root = artifactUrl('', options.root || null);
  const resolved = await resolveArtifact(name, root);
  const { identity } = resolved;
  const indexUrl = new URL(resolved.path, root);
  const index = await jsonAt(indexUrl);
  const canonical = index?.identity;
  if (index?.schema !== 1 || canonical?.algorithm !== 'sha256'
      || String(canonical.digest).toLowerCase() !== identity) {
    throw new Error('artifact identity index is invalid');
  }
  const bytes = safeInteger(canonical.bytes, 'artifact byte length');
  const deliveryDigest = String(index.preferred || '').toLowerCase();
  const delivery = index.deliveries?.[deliveryDigest];
  const expectedFile = `delivery/${deliveryDigest}.pages`;
  if (!DIGEST.test(deliveryDigest) || delivery?.format !== 'page-fabric-v1'
      || delivery.file !== expectedFile) {
    throw new Error('artifact delivery index is invalid');
  }
  const fabric = await openPageBundle({
    url: new URL(expectedFile, indexUrl).href,
    prefixBytes: safeInteger(delivery.prefix_bytes, 'artifact prefix size'),
    prefixSha256: delivery.prefix_sha256,
    objectSha256: identity,
    wavePages: options.wavePages == null ? 4 : options.wavePages,
    cachePages: options.cachePages == null ? 16 : options.cachePages,
  });
  if (fabric.length !== bytes) {
    fabric.release();
    throw new Error('artifact delivery has the wrong canonical extent');
  }
  return { identity, index, delivery, fabric };
}

/** Reconstruct and verify a consumer that still needs the complete bytes. */
export async function readArtifact(name, options = {}) {
  const opened = await openArtifact(name, options);
  const { fabric, identity } = opened;
  try {
    const output = await fabric.readAll(16, ({ decoded, total }) => {
      options.onProgress?.({
        loaded: total ? Math.round((fabric.length * decoded) / total) : 0,
        total: fabric.length,
        fetched: fabric.layout().fetchedBytes,
      });
    });
    const actual = hex(new Uint8Array(
      await crypto.subtle.digest('SHA-256', output),
    ));
    if (actual !== identity) {
      throw new Error('artifact canonical digest is invalid');
    }
    return { ...opened, bytes: output };
  } catch (error) {
    fabric.release();
    throw error;
  }
}
