// Demand-mapped directory for QM physical execution pages.

import { openPageBundle } from './page-fabric.js';

const HEADER_BYTES = 24;
const ENTRY_BYTES = 40;
const STATE_STEP = 2;

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function safeBig(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} is outside the browser integer range`);
  }
  return number;
}

function compare(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export async function openPhysicalPages(moduleEntry, manifestUrl) {
  const steps = moduleEntry?.steps;
  const delivery = steps?.delivery;
  if (!steps || !delivery) return null;
  const fabric = await openPageBundle({
    url: new URL(delivery.file, manifestUrl).href,
    prefixBytes: delivery.prefix_bytes,
    prefixSha256: delivery.prefix_sha256,
    objectSha256: steps.sha256,
    wavePages: 1,
    cachePages: 4,
  });
  if (fabric.length !== steps.bytes) {
    fabric.release();
    throw new Error('physical-page archive has the wrong extent');
  }
  const header = await fabric.read(0, HEADER_BYTES);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const fixedHeader = view.getUint16(6, true);
  const headerBytes = safeBig(view.getBigUint64(8, true),
                              'physical-page directory extent');
  const count = view.getUint32(16, true);
  const entryBytes = view.getUint32(20, true);
  const expectedHeader = (HEADER_BYTES + count * ENTRY_BYTES + 7) & ~7;
  if (ascii(header, 0, 4) !== 'PAGE'
      || view.getUint16(4, true) !== 2
      || fixedHeader !== HEADER_BYTES
      || entryBytes !== ENTRY_BYTES
      || headerBytes !== expectedHeader
      || headerBytes > fabric.length
      || count !== steps.pages) {
    fabric.release();
    throw new Error('physical-page archive header is invalid');
  }

  async function row(index) {
    const bytes = await fabric.read(HEADER_BYTES + index * ENTRY_BYTES,
                                    ENTRY_BYTES);
    const entry = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const result = {
      kind: entry.getUint32(0, true),
      functionIndex: entry.getUint32(4, true),
      startPc: entry.getUint32(8, true),
      stackInputs: entry.getUint32(12, true),
      offset: safeBig(entry.getBigUint64(16, true), 'physical-page offset'),
      length: entry.getUint32(24, true),
      span: entry.getUint32(28, true),
      work: entry.getUint32(32, true),
      requiredFeatures: entry.getUint32(36, true),
    };
    result.key = [result.kind, result.functionIndex,
      result.startPc, result.stackInputs];
    if (result.offset < headerBytes
        || result.offset + result.length > fabric.length) {
      throw new Error('physical-page payload is outside its archive');
    }
    return result;
  }

  return {
    async stateStep(functionIndex, startPc = 0, stackInputs = 0) {
      const key = [STATE_STEP, Number(functionIndex),
        Number(startPc), Number(stackInputs)];
      let low = 0;
      let high = count;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const entry = await row(middle);
        if (compare(entry.key, key) < 0) low = middle + 1;
        else high = middle;
      }
      if (low >= count) return null;
      const entry = await row(low);
      return compare(entry.key, key) === 0
        ? { ...entry, source: fabric }
        : null;
    },
    layout() {
      return {
        pages: count,
        directoryBytes: headerBytes,
        delivery: fabric.layout(),
      };
    },
    release() { fabric.release(); },
  };
}
