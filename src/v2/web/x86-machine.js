// Physical delivery adapter for one build-time x86 -> QM machine artifact.
// CPU/MMU/control stay in vm.wasm; this module only resolves immutable block
// records and 4 KiB physical RAM pages, with dirty pages held as COW rows.

import { openPageBundle } from './page-fabric.js';

const MAGIC = new TextEncoder().encode('x86-native-machine-v1\n');
const HEX_WORD = /^[0-9a-f]{16}$/;
const BLOCK_MAGIC = [0x58, 0x38, 0x36, 0x42];
const PHYSICAL_PAGE_BYTES = 4096;

function equalPrefix(bytes, prefix) {
  return prefix.every((value, index) => bytes[index] === value);
}

function safeInteger(value, name) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${name} is outside the browser integer range`);
  }
  return result;
}

function word(value, name) {
  value = String(value || '').toLowerCase();
  if (!HEX_WORD.test(value)) throw new Error(`${name} is not one word`);
  return BigInt(`0x${value}`);
}

function decodeState(raw) {
  if (!raw || !Array.isArray(raw.registers) || raw.registers.length !== 16
      || !Array.isArray(raw.system) || raw.system.length !== 22
      || !Array.isArray(raw.msrs) || raw.msrs.length > 32) {
    throw new Error('native x86 state shape is invalid');
  }
  return {
    registers: raw.registers.map((value, index) => word(
      value, `register ${index}`,
    )),
    rip: word(raw.rip, 'rip'),
    rflags: word(raw.rflags, 'rflags'),
    cr0: word(raw.cr0, 'cr0'),
    cr3: word(raw.cr3, 'cr3'),
    cr4: word(raw.cr4, 'cr4'),
    efer: word(raw.efer, 'efer'),
    system: raw.system.map((value, index) => word(
      value, `system word ${index}`,
    )),
    msrs: raw.msrs.map((pair, index) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(`MSR ${index} shape is invalid`);
      }
      return [word(pair[0], `MSR ${index} key`),
        word(pair[1], `MSR ${index} value`)];
    }),
  };
}

export async function openNativeX86Artifact(bytes, options = {}) {
  if (!(bytes instanceof Uint8Array)
      || bytes.length < MAGIC.length + 4
      || !equalPrefix(bytes, MAGIC)) {
    throw new Error('native x86 machine header is invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerBytes = view.getUint32(MAGIC.length, true);
  const headerStart = MAGIC.length + 4;
  const headerEnd = headerStart + headerBytes;
  if (headerEnd > bytes.length) {
    throw new Error('native x86 machine metadata is truncated');
  }
  let header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(headerStart, headerEnd),
    ));
  } catch (error) {
    throw new Error(`native x86 machine metadata is invalid (${error.message})`);
  }
  if (header?.schema !== 1 || !header.memory || !Array.isArray(header.blocks)) {
    throw new Error('native x86 machine schema is unsupported');
  }
  const memoryBytes = safeInteger(header.memory.bytes, 'memory bundle bytes');
  const memoryLength = safeInteger(header.memory.length, 'physical RAM length');
  const blockBytes = safeInteger(header.block_bytes, 'block record bytes');
  const memoryEnd = headerEnd + memoryBytes;
  if (memoryEnd + blockBytes !== bytes.length) {
    throw new Error('native x86 machine extents are invalid');
  }
  const state = decodeState(header.state);
  const memoryFabric = await openPageBundle({
    blob: new Blob([bytes.subarray(headerEnd, memoryEnd)]),
    prefixBytes: safeInteger(
      header.memory.prefix_bytes, 'memory prefix bytes',
    ),
    prefixSha256: header.memory.prefix_sha256,
    wavePages: options.wavePages == null ? 2 : options.wavePages,
    cachePages: options.cachePages == null ? 16 : options.cachePages,
  });
  if (memoryFabric.length !== memoryLength) {
    memoryFabric.release();
    throw new Error('native x86 physical RAM extent is invalid');
  }

  const directory = new Map();
  let prior = -1n;
  for (const [rawRip, rawOffset, rawLength] of header.blocks) {
    const rip = word(rawRip, 'block RIP');
    const offset = safeInteger(rawOffset, 'block offset');
    const length = safeInteger(rawLength, 'block length');
    if (rip <= prior || length < 64 || offset + length > blockBytes) {
      memoryFabric.release();
      throw new Error('native x86 block directory is invalid');
    }
    const record = bytes.subarray(memoryEnd + offset, memoryEnd + offset + length);
    if (!BLOCK_MAGIC.every((value, index) => record[index] === value)
        || new DataView(record.buffer, record.byteOffset, record.byteLength)
          .getBigUint64(8, true) !== rip) {
      memoryFabric.release();
      throw new Error(`native x86 block 0x${rip.toString(16)} is invalid`);
    }
    directory.set(rip.toString(), record);
    prior = rip;
  }

  const dirty = new Map();
  const memory = {
    length: memoryLength,
    async read(offset, length) {
      if (offset % PHYSICAL_PAGE_BYTES || length !== PHYSICAL_PAGE_BYTES) {
        throw new Error('x86 RAM reads must be one aligned physical page');
      }
      const page = offset / PHYSICAL_PAGE_BYTES;
      const present = dirty.get(page);
      return present ? present.slice() : memoryFabric.read(offset, length);
    },
    async write(offset, payload) {
      if (offset % PHYSICAL_PAGE_BYTES
          || !(payload instanceof Uint8Array)
          || payload.length !== PHYSICAL_PAGE_BYTES) {
        throw new Error('x86 RAM writes must be one aligned physical page');
      }
      dirty.set(offset / PHYSICAL_PAGE_BYTES, payload.slice());
    },
  };
  const blocks = {
    length: blockBytes,
    async read(rip) {
      const record = directory.get(BigInt.asUintN(64, rip).toString());
      return record ? record.slice() : null;
    },
  };
  return {
    state,
    memory,
    blocks,
    snapshot() {
      return {
        dirtyPages: Array.from(dirty, ([page, payload]) => [
          page, payload.slice(),
        ]),
      };
    },
    release() {
      const resident = memoryFabric.release();
      dirty.clear();
      directory.clear();
      return resident;
    },
    layout() {
      return {
        blocks: directory.size,
        dirtyPages: dirty.size,
        memory: memoryFabric.layout(),
      };
    },
  };
}
