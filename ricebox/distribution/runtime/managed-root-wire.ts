/** Metadata-only adapter to the managed root owner's neutral SODSROOT wire v1. */
import type {Index} from '../format/manifest.ts';
import {canonicalExecutableSource} from '../format/executable-source.ts';
import {canonicalHotSources} from './prepared-executable.ts';

const MAX_WIRE = 16 * 1024 * 1024, HEADER = 72, U32_MAX = 0xffffffff;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
function fail(why: string): never { throw new Error(`ricebox: invalid managed root wire: ${why}`); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function natural(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail(`${label} must be a safe unsigned integer <= ${max}`);
  return value;
}
function digest(value: unknown, label: string, pack = false): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length !== (pack ? 69 : 64) || !(pack ? /^[0-9a-f]{64}\.pack$/ : /^[0-9a-f]{64}$/).test(value)) fail(`${label} must contain a lowercase SHA-256 digest${pack ? ' and .pack suffix' : ''}`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * The caller authenticates the index JSON and supplies its digest as generation.
 * This encodes stored names, coordinates and producer source associations only:
 * Rust owns byte-path validation/resolution, inode/hardlink identity, source and
 * artifact IDs, and atomic namespace/catalog construction. No payload is read.
 *
 * AOT artifact and translator digests name their stored (possibly compressed)
 * blobs, not transformed WebAssembly.Modules. Association consistency is neither
 * source-byte verification nor proof of translator/compiler correctness.
 */
export function managedRootWire(index: Index, generation: string, shared = true): {
  wire: Uint8Array<ArrayBuffer>;
  limits: {inodes: number; entries: number; fileBytes: number};
} {
  const root = object(index, 'index'), generationBytes = digest(generation, 'generation');
  if (typeof shared !== 'boolean') fail('shared must be a boolean');
  let size = HEADER;
  function reserve(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_WIRE - size) fail('wire exceeds 16 MiB');
    size += bytes;
  }
  function inventory(key: string, fixed: number): unknown[] {
    const values = root[key];
    if (!Array.isArray(values)) fail(`${key} must be an array`);
    const count = natural(values.length, `${key} count`, U32_MAX);
    reserve(count * fixed);
    return values;
  }
  // Fixed-byte preflight rejects impossible counts before visiting any records.
  const packInput = inventory('packs', 40), dirInput = inventory('dirs', 8), linkInput = inventory('links', 8);
  const fileInput = inventory('files', 40), aotInput = inventory('translations', 104);
  function name(value: unknown, label: string): Uint8Array<ArrayBuffer> {
    if (typeof value !== 'string') fail(`${label} must be a string`);
    // Bound the encoded allocation first; do not silently replace lone surrogates.
    let length = 0;
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} cannot roundtrip through UTF-8`);
        length += 4;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail(`${label} cannot roundtrip through UTF-8`);
      } else {
        length += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
      }
      if (length > MAX_WIRE - size) fail('wire exceeds 16 MiB');
    }
    reserve(length);
    const bytes = encoder.encode(value);
    if (decoder.decode(bytes) !== value) fail(`${label} cannot roundtrip through UTF-8`);
    return bytes;
  }
  const packs = Array.from(packInput, (value, i) => {
    const pack = object(value, `packs[${i}]`);
    return {digest: digest(pack.name, `packs[${i}].name`, true), stored: natural(pack.bytes, `packs[${i}].bytes`)};
  });
  const dirs = Array.from(dirInput, (value, i) => {
    const dir = object(value, `dirs[${i}]`);
    return {path: name(dir.path, `dirs[${i}].path`), mode: natural(dir.mode, `dirs[${i}].mode`, 0o7777)};
  });
  const links = Array.from(linkInput, (value, i) => {
    const link = object(value, `links[${i}]`);
    return {path: name(link.path, `links[${i}].path`), target: name(link.target, `links[${i}].target`)};
  });
  let fileBytes = 0;
  const files = Array.from(fileInput, (value, i) => {
    const file = object(value, `files[${i}]`), bytes = natural(file.size, `files[${i}].size`);
    if (file.raw !== undefined && typeof file.raw !== 'boolean') fail(`files[${i}].raw must be a boolean when present`);
    fileBytes = Math.max(fileBytes, bytes);
    return {path: name(file.path, `files[${i}].path`), mode: natural(file.mode, `files[${i}].mode`, 0o7777), size: bytes,
      pack: natural(file.pack, `files[${i}].pack`, U32_MAX), raw: file.raw === true,
      at: natural(file.at, `files[${i}].at`), stored: natural(file.len, `files[${i}].len`)};
  });
  const translator = digest(object(root.translator, 'translator').sha256, 'translator.sha256');
  const aots = Array.from(aotInput, (value, i) => {
    const translation = object(value, `translations[${i}]`);
    return {path: name(translation.path, `translations[${i}].path`),
      artifact: digest(object(translation.wasm, `translations[${i}].wasm`).sha256, `translations[${i}].wasm.sha256`)};
  });
  // Preserve every wire occurrence. These helpers check producer associations,
  // not Linux path resolution or the root owner's identity/deduplication work.
  canonicalHotSources(index);
  const sources = index.translations.map(translation => digest(canonicalExecutableSource(index, translation).sha256, 'canonical source digest'));
  const wire = new Uint8Array(new ArrayBuffer(size)), view = new DataView(wire.buffer);
  let at = 0;
  function bytes(value: Uint8Array): void { wire.set(value, at); at += value.length; }
  function u32(value: number): void { view.setUint32(at, value, true); at += 4; }
  function u64(value: number): void { view.setBigUint64(at, BigInt(value), true); at += 8; }
  bytes(encoder.encode('SODSROOT')); u32(1); u32(0); bytes(generationBytes);
  u32(packs.length); u32(dirs.length); u32(links.length); u32(files.length); u32(aots.length); u32(0);
  for (const pack of packs) { bytes(pack.digest); u64(pack.stored); }
  for (const dir of dirs) { u32(dir.path.length); u32(dir.mode); bytes(dir.path); }
  for (const link of links) { u32(link.path.length); u32(link.target.length); bytes(link.path); bytes(link.target); }
  for (const file of files) {
    u32(file.path.length); u32(file.mode); u64(file.size); u32(file.pack); u32(Number(file.raw));
    u64(file.at); u64(file.stored); bytes(file.path);
  }
  for (let i = 0; i < aots.length; i++) {
    const aot = aots[i];
    u32(aot.path.length); u32(Number(shared)); bytes(sources[i]); bytes(aot.artifact); bytes(translator); bytes(aot.path);
  }
  const entries = dirs.length + links.length + files.length;
  // Safe logical upper counts, not a TS identity table or heap bound. Rust
  // computes the actual unique inode/source/artifact counts before publication.
  return {wire, limits: {inodes: 1 + entries, entries, fileBytes}};
}
