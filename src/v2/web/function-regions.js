// Direct function-index lookup for a page-delivered WebAssembly module.

import { openPageBundle } from './page-fabric.js';

const HEADER_BYTES = 64;
const BODY_BYTES = 12;

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function safeBig(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the browser integer range`);
  }
  return number;
}

export async function openFunctionRegions(moduleEntry, manifestUrl) {
  const regions = moduleEntry?.regions;
  const delivery = regions?.delivery;
  if (!regions || !delivery) throw new Error('WebAssembly function regions are missing');
  const fabric = await openPageBundle({
    url: new URL(delivery.file, manifestUrl).href,
    prefixBytes: delivery.prefix_bytes,
    prefixSha256: delivery.prefix_sha256,
    objectSha256: regions.sha256,
    wavePages: 1,
    cachePages: 1,
  });
  if (fabric.length !== regions.bytes) {
    fabric.release();
    throw new Error('WebAssembly function regions have the wrong extent');
  }
  const header = await fabric.read(0, HEADER_BYTES);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (ascii(header, 0, 4) !== 'WREG'
      || view.getUint16(4, true) !== 1
      || view.getUint16(6, true) !== HEADER_BYTES
      || view.getUint32(24, true) !== BODY_BYTES
      || view.getUint32(28, true) !== 0
      || hex(header.subarray(32, 64)) !== String(moduleEntry.sha256).toLowerCase()) {
    fabric.release();
    throw new Error('WebAssembly function region header is invalid');
  }
  const moduleBytes = safeBig(view.getBigUint64(8, true), 'WebAssembly module length');
  const importedFunctions = view.getUint32(16, true);
  const bodyCount = view.getUint32(20, true);
  if (moduleBytes !== moduleEntry.bytes
      || fabric.length !== HEADER_BYTES + bodyCount * BODY_BYTES) {
    fabric.release();
    throw new Error('WebAssembly function region geometry is invalid');
  }

  return {
    moduleBytes,
    importedFunctions,
    bodyCount,
    async body(functionIndex) {
      functionIndex = Number(functionIndex);
      const ordinal = functionIndex - importedFunctions;
      if (!Number.isSafeInteger(functionIndex)
          || ordinal < 0 || ordinal >= bodyCount) return null;
      const bytes = await fabric.read(
        HEADER_BYTES + ordinal * BODY_BYTES, BODY_BYTES,
      );
      const row = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const start = row.getUint32(0, true);
      const end = row.getUint32(4, true);
      const typeIndex = row.getUint32(8, true);
      if (start >= end || end > moduleBytes) {
        throw new Error('WebAssembly function body region is invalid');
      }
      return { functionIndex, bodyOrdinal: ordinal, start, end, typeIndex };
    },
    layout() {
      return {
        moduleBytes, importedFunctions, bodyCount,
        recordBytes: BODY_BYTES,
        delivery: fabric.layout(),
      };
    },
    release() { fabric.release(); },
  };
}
