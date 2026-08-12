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
  return { identity, path };
}

/** Open one physical projection without reconstructing the canonical object. */
export async function openArtifact(name, options = {}) {
  const root = new URL(options.root || '../artifact/', import.meta.url);
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
  const output = new Uint8Array(fabric.length);
  const waveBytes = fabric.pageBytes * fabric.wavePages;
  try {
    for (let offset = 0; offset < output.length; offset += waveBytes) {
      const count = Math.min(waveBytes, output.length - offset);
      output.set(await fabric.read(offset, count), offset);
      options.onProgress?.({
        loaded: offset + count,
        total: output.length,
        fetched: fabric.layout().fetchedBytes,
      });
    }
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
