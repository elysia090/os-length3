// Physical delivery adapter for one build-time x86 -> QM machine artifact.
// CPU/MMU/control stay in vm.wasm; this module only resolves immutable block
// records and 4 KiB physical RAM pages, with dirty pages held as COW rows.

import { openPageBundle } from './page-fabric.js';

const MAGIC_V1 = new TextEncoder().encode('x86-native-machine-v1\n');
const MAGIC_V2 = new TextEncoder().encode('x86-native-machine-v2\n');
const MAGIC_V3 = new TextEncoder().encode('x86-native-machine-v3\n');
const MAGIC_V4 = new TextEncoder().encode('x86-native-machine-v4\n');
const MAGIC = new TextEncoder().encode('x86-native-machine-v5\n');
const HEX_WORD = /^[0-9a-f]{16}$/;
const BLOCK_MAGIC = [0x58, 0x38, 0x36, 0x42];
const DESCRIPTOR_MAGIC = [0x58, 0x38, 0x36, 0x44];
const NATIVE_HEADER_BYTES = 64;
const NATIVE_REGION_BYTES = 65536;
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

function compactSignedWidth(value) {
  const signed = BigInt.asIntN(64, value);
  if (signed >= -128n && signed < 128n) return [3, 1];
  if (signed >= -32768n && signed < 32768n) return [4, 2];
  if (signed >= -2147483648n && signed < 2147483648n) return [5, 4];
  return [6, 8];
}

function readCompactContinuation(physical, rank) {
  const {
    view, continuationOffsetBase, continuationPayloadBase,
    continuationCount, continuationBytes,
  } = physical;
  if (!rank || rank > continuationCount) {
    throw new Error('native x86 continuation rank is invalid');
  }
  const start = view.getUint32(
    continuationOffsetBase + (rank - 1) * 4, true,
  );
  const end = view.getUint32(
    continuationOffsetBase + rank * 4, true,
  );
  if (start >= end || end > continuationBytes || end - start < 3) {
    throw new Error('native x86 continuation directory is invalid');
  }
  let cursor = continuationPayloadBase + start;
  const limit = continuationPayloadBase + end;
  const control = view.getUint8(cursor);
  const tags = view.getUint16(cursor + 1, true);
  cursor += 3;
  if (control > 42 || tags >>> 12) {
    throw new Error('native x86 continuation tag is invalid');
  }
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    const code = (tags >>> (index * 3)) & 7;
    let value;
    if (code === 0) {
      value = 0n;
    } else if (code === 1 && index > 0) {
      value = values[0];
    } else if (code === 2 && index > 1) {
      value = values[1];
    } else {
      const width = code === 3 ? 1 : code === 4 ? 2
        : code === 5 ? 4 : code === 6 ? 8 : 0;
      if (!width || cursor + width > limit) {
        throw new Error('native x86 continuation field is invalid');
      }
      const signed = width === 1 ? BigInt(view.getInt8(cursor))
        : width === 2 ? BigInt(view.getInt16(cursor, true))
          : width === 4 ? BigInt(view.getInt32(cursor, true))
            : view.getBigInt64(cursor, true);
      value = BigInt.asUintN(64, signed);
      cursor += width;
    }
    const [signedCode] = compactSignedWidth(value);
    const canonical = value === 0n ? 0
      : index > 0 && value === values[0] ? 1
        : index > 1 && value === values[1] ? 2 : signedCode;
    if (code !== canonical) {
      throw new Error('native x86 continuation is not canonical');
    }
    values.push(value);
  }
  if (cursor !== limit) {
    throw new Error('native x86 continuation extent is invalid');
  }
  return [control, ...values];
}

function decodeState(raw) {
  if (!raw || !Array.isArray(raw.registers) || raw.registers.length !== 16
      || !Array.isArray(raw.system) || raw.system.length !== 22
      || (raw.xmm !== undefined
          && (!Array.isArray(raw.xmm) || raw.xmm.length !== 32))
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
    xmm: (raw.xmm || Array(32).fill('0000000000000000')).map(
      (value, index) => word(value, `vector word ${index}`),
    ),
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
  const openStarted = performance.now();
  let direct = bytes instanceof Uint8Array;
  let backing = direct ? null : bytes;
  if (!direct && (!backing || typeof backing.read !== 'function')) {
    throw new Error('native x86 machine header is invalid');
  }
  // Boot admits tens of thousands of blocks, and each one names three
  // extents -- proof, parameter row, template.  Resolving those through the
  // page fabric is one read per extent, so a boot pays ~3 reads per block
  // while ending up with essentially the whole object resident anyway: the
  // measured fetch is 33.5 MB of a 32.8 MB artifact.  Demand paging buys
  // nothing here and costs a read per extent, so take the object in one
  // fetch and let every range resolve as a subarray.
  if (!direct && options.bulk !== false) {
    const whole = await backing.read(0, backing.length);
    if (whole instanceof Uint8Array && whole.length === backing.length) {
      bytes = whole;
      direct = true;
      backing = null;
    }
  }
  const artifactLength = safeInteger(
    direct ? bytes.length : backing.length, 'native x86 artifact bytes',
  );
  const range = async (offset, length) => {
    if (offset < 0 || length < 0 || offset + length > artifactLength) {
      throw new Error('native x86 artifact range is invalid');
    }
    return direct ? bytes.subarray(offset, offset + length)
      : backing.read(offset, length);
  };
  const prefix = await range(0, Math.min(
    artifactLength, Math.max(MAGIC.length, MAGIC_V1.length) + 4,
  ));
  const v5 = artifactLength >= MAGIC.length + 4 && equalPrefix(prefix, MAGIC);
  const v4 = !v5 && artifactLength >= MAGIC_V4.length + 4
    && equalPrefix(prefix, MAGIC_V4);
  const v3 = !v5 && !v4 && artifactLength >= MAGIC_V3.length + 4
    && equalPrefix(prefix, MAGIC_V3);
  const v2 = !v5 && !v4 && !v3 && artifactLength >= MAGIC_V2.length + 4
    && equalPrefix(prefix, MAGIC_V2);
  const magic = v5 ? MAGIC : v4 ? MAGIC_V4
    : v3 ? MAGIC_V3 : v2 ? MAGIC_V2 : MAGIC_V1;
  if (artifactLength < magic.length + 4 || !equalPrefix(prefix, magic)) {
    throw new Error('native x86 machine header is invalid');
  }
  const prefixView = new DataView(
    prefix.buffer, prefix.byteOffset, prefix.byteLength,
  );
  const headerBytes = prefixView.getUint32(magic.length, true);
  const headerStart = magic.length + 4;
  const headerEnd = headerStart + headerBytes;
  if (headerEnd > artifactLength) {
    throw new Error('native x86 machine metadata is truncated');
  }
  const rawHeader = await range(headerStart, headerBytes);
  let header;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      rawHeader,
    ));
  } catch (error) {
    throw new Error(`native x86 machine metadata is invalid (${error.message})`);
  }
  if (header?.schema !== (v5 ? 5 : v4 ? 4 : v3 ? 3 : v2 ? 2 : 1)
      || !header.memory
      || (!v5 && !v4 && !v3 && !v2 && !Array.isArray(header.blocks))) {
    throw new Error('native x86 machine schema is unsupported');
  }
  // A v1 projection has interleaved records and cannot offer page-granular
  // STEP admission. Keep it readable during migration by materializing once.
  if (!v5 && !v4 && !v3 && !v2 && !direct) {
    return openNativeX86Artifact(await range(0, artifactLength), options);
  }
  const memoryBytes = safeInteger(header.memory.bytes, 'memory bundle bytes');
  const memoryLength = safeInteger(header.memory.length, 'physical RAM length');
  let memoryStart = headerEnd;
  let memoryEnd;
  let blockBytes;
  let descriptorStart;
  let descriptorBytes;
  let executionStart;
  let executionBytes;
  if (v5 || v4 || v3 || v2) {
    const regions = header.regions;
    if (!regions || safeInteger(regions.page_bytes, 'region page bytes')
        !== NATIVE_REGION_BYTES
        || !Array.isArray(regions.memory)
        || !Array.isArray(regions.descriptors)
        || !Array.isArray(regions.execution)) {
      throw new Error('native x86 region geometry is invalid');
    }
    [memoryStart, memoryEnd] = regions.memory.map(
      (value) => safeInteger(value, 'memory region coordinate'),
    );
    const memoryExtent = memoryEnd;
    memoryEnd = memoryStart + memoryExtent;
    [descriptorStart, descriptorBytes] = regions.descriptors.map(
      (value) => safeInteger(value, 'descriptor region coordinate'),
    );
    [executionStart, executionBytes] = regions.execution.map(
      (value) => safeInteger(value, 'execution region coordinate'),
    );
    blockBytes = descriptorBytes + executionBytes;
    if (memoryExtent !== memoryBytes
        || descriptorBytes !== safeInteger(
          header.descriptor_bytes, 'descriptor bytes',
        )
        || executionBytes !== safeInteger(
          header.execution_bytes, 'execution bytes',
        )
        || memoryStart % NATIVE_REGION_BYTES
        || descriptorStart % NATIVE_REGION_BYTES
        || executionStart % NATIVE_REGION_BYTES
        || headerEnd > memoryStart || memoryEnd > descriptorStart
        || descriptorStart + descriptorBytes > executionStart
        || executionStart + executionBytes !== artifactLength) {
      throw new Error('native x86 machine extents are invalid');
    }
  } else {
    blockBytes = safeInteger(header.block_bytes, 'block record bytes');
    memoryEnd = headerEnd + memoryBytes;
    descriptorStart = memoryEnd;
    descriptorBytes = blockBytes;
    if (memoryEnd + blockBytes !== artifactLength) {
      throw new Error('native x86 machine extents are invalid');
    }
  }
  const state = decodeState(header.state);
  const memoryFabric = await openPageBundle({
    ...(direct ? {
      blob: new Blob([bytes.subarray(memoryStart, memoryEnd)]),
    } : {
      reader(offset, length) {
        return range(memoryStart + offset, length);
      },
    }),
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
  const memoryOpened = performance.now();

  const directory = new Map();
  let prior = -1n;
  let priorGuard = null;
  let uniqueSteps = 0;
  let uniqueStepTemplates = 0;
  let blockCount = 0;
  let uniqueGuards = 0;
  let uniqueContinuations = 0;
  let physicalBlocks = null;
  let coordinateCount = 0;
  let descriptorFetched = memoryOpened;
  let blockRowsStarted = memoryOpened;
  let blockRowsValidated = memoryOpened;
  let blockIndexBuilt = memoryOpened;
  if (v5 || v4 || v3) {
    blockCount = safeInteger(header.block_count, 'block count');
    const stepCount = safeInteger(header.step_count, 'STEP instance count');
    const templateCount = safeInteger(
      header.template_count, 'STEP template count',
    );
    const guardCount = safeInteger(header.guard_count, 'code proof count');
    const continuationCount = v5 || v4 ? safeInteger(
      header.continuation_count, 'continuation count',
    ) : 0;
    const continuationBytes = v5 ? safeInteger(
      header.continuation_bytes, 'continuation bytes',
    ) : 0;
    const templateExecutionBytes = safeInteger(
      header.template_execution_bytes, 'STEP template bytes',
    );
    const parameterExecutionBytes = safeInteger(
      header.parameter_execution_bytes, 'STEP parameter bytes',
    );
    const stepInstanceBytes = 16;
    const extentBytes = 8;
    const blockInstanceBytes = v5 || v4 ? 20 : NATIVE_HEADER_BYTES;
    const controlTemplateBytes = 40;
    if (descriptorBytes !== blockCount * blockInstanceBytes
        + stepCount * stepInstanceBytes
        + (templateCount + guardCount) * extentBytes
        + (v5 ? (continuationCount + 1) * 4 + continuationBytes
          : continuationCount * controlTemplateBytes)
        || ((v5 || v4) && blockCount && !continuationCount)
        || templateExecutionBytes + parameterExecutionBytes > executionBytes) {
      memoryFabric.release();
      throw new Error('native x86 quotient descriptor extent is invalid');
    }
    const descriptorRegion = await range(descriptorStart, descriptorBytes);
    descriptorFetched = performance.now();
    const instanceBase = blockCount * blockInstanceBytes;
    const templateBase = instanceBase + stepCount * stepInstanceBytes;
    const guardBase = templateBase + templateCount * extentBytes;
    const continuationBase = guardBase + guardCount * extentBytes;
    if (v5 || v4) {
      const view = new DataView(
        descriptorRegion.buffer,
        descriptorRegion.byteOffset,
        descriptorRegion.byteLength,
      );
      let expectedOffset = 0;
      for (let index = 0; index < templateCount; index += 1) {
        const at = templateBase + index * extentBytes;
        const offset = view.getUint32(at, true);
        const length = view.getUint32(at + 4, true);
        if (offset !== expectedOffset || !length
            || offset + length > templateExecutionBytes) {
          memoryFabric.release();
          throw new Error('native STEP template directory is invalid');
        }
        expectedOffset += length;
      }
      if (expectedOffset !== templateExecutionBytes) {
        memoryFabric.release();
        throw new Error('native STEP template extent is invalid');
      }
      expectedOffset = templateExecutionBytes;
      for (let index = 0; index < stepCount; index += 1) {
        const at = instanceBase + index * stepInstanceBytes;
        const templateRank = view.getUint32(at, true);
        const offset = view.getUint32(at + 4, true);
        const length = view.getUint32(at + 8, true);
        const stepLength = view.getUint32(at + 12, true);
        if (!templateRank || templateRank > templateCount
            || offset !== expectedOffset
            || offset + length
              > templateExecutionBytes + parameterExecutionBytes
            || !stepLength) {
          memoryFabric.release();
          throw new Error('native STEP instance directory is invalid');
        }
        expectedOffset += length;
      }
      if (expectedOffset !== templateExecutionBytes + parameterExecutionBytes) {
        memoryFabric.release();
        throw new Error('native STEP parameter extent is invalid');
      }
      expectedOffset = templateExecutionBytes + parameterExecutionBytes;
      for (let index = 0; index < guardCount; index += 1) {
        const at = guardBase + index * extentBytes;
        const offset = view.getUint32(at, true);
        const length = view.getUint32(at + 4, true);
        if (offset !== expectedOffset || !length
            || offset + length > executionBytes) {
          memoryFabric.release();
          throw new Error('native code proof directory is invalid');
        }
        expectedOffset += length;
      }
      if (expectedOffset !== executionBytes) {
        memoryFabric.release();
        throw new Error('native code proof extent is invalid');
      }
      let continuationOffsetBase = 0;
      let continuationPayloadBase = 0;
      if (v5) {
        continuationOffsetBase = continuationBase;
        continuationPayloadBase = continuationBase
          + (continuationCount + 1) * 4;
        if (view.getUint32(continuationOffsetBase, true) !== 0
            || view.getUint32(
              continuationOffsetBase + continuationCount * 4, true,
            ) !== continuationBytes) {
          memoryFabric.release();
          throw new Error('native x86 continuation directory is invalid');
        }
        // Integrity is already proved by the enclosing artifact. Validate a
        // row only when its block is admitted; cold continuation payloads are
        // intentionally never decoded or materialized during open.
      } else {
        for (let index = 0; index < continuationCount; index += 1) {
          const at = continuationBase + index * controlTemplateBytes;
          if (view.getUint32(at + 4, true)
              || view.getUint32(at, true) > 42) {
            memoryFabric.release();
            throw new Error('native x86 continuation is invalid');
          }
        }
      }

      blockRowsStarted = performance.now();
      let priorRip = -1n;
      let priorProofOffset = -1;
      const tailCounts = new Uint32Array(256);
      for (let index = 0; index < blockCount; index += 1) {
        const at = index * blockInstanceBytes;
        const rip = view.getBigUint64(at, true);
        const stepRank = view.getUint32(at + 8, true);
        const continuationRank = view.getUint32(at + 12, true);
        const guardRank = view.getUint32(at + 16, true);
        const proofOffset = guardRank && guardRank <= guardCount
          ? view.getUint32(guardBase + (guardRank - 1) * extentBytes, true)
          : 0;
        if (rip < priorRip || !stepRank || stepRank > stepCount
            || !continuationRank || continuationRank > continuationCount
            || guardRank > guardCount
            || (rip === priorRip && proofOffset <= priorProofOffset)) {
          memoryFabric.release();
          throw new Error(
            `native x86 block instance 0x${rip.toString(16)} is invalid`,
          );
        }
        if (rip !== priorRip) coordinateCount += 1;
        tailCounts[Number(rip & 255n)] += 1;
        priorRip = rip;
        priorProofOffset = proofOffset;
      }
      blockRowsValidated = performance.now();
      const tailOffsets = new Uint32Array(257);
      for (let tail = 0; tail < 256; tail += 1) {
        tailOffsets[tail + 1] = tailOffsets[tail] + tailCounts[tail];
      }
      const tailRanks = new Uint32Array(blockCount);
      const tailCursor = tailOffsets.slice(0, 256);
      for (let index = 0; index < blockCount; index += 1) {
        const rip = view.getBigUint64(index * blockInstanceBytes, true);
        const tail = Number(rip & 255n);
        tailRanks[tailCursor[tail]] = index;
        tailCursor[tail] += 1;
      }
      blockIndexBuilt = performance.now();
      uniqueSteps = stepCount;
      uniqueStepTemplates = templateCount;
      uniqueGuards = guardCount;
      uniqueContinuations = continuationCount;
      // Keep the quotient as mapped rows. The only resident lookup state is
      // two typed CSR arrays; no block, STEP, proof or continuation objects
      // survive artifact admission.
      physicalBlocks = {
        view,
        blockInstanceBytes,
        instanceBase,
        templateBase,
        guardBase,
        continuationBase,
        continuationOffsetBase,
        continuationPayloadBase,
        continuationCount,
        continuationBytes,
        compactContinuations: v5,
        tailOffsets,
        tailRanks,
      };
    } else {
    const templates = [];
    let expectedOffset = 0;
    for (let index = 0; index < templateCount; index += 1) {
      const start = templateBase + index * extentBytes;
      const view = new DataView(
        descriptorRegion.buffer, descriptorRegion.byteOffset + start,
        extentBytes,
      );
      const offset = view.getUint32(0, true);
      const length = view.getUint32(4, true);
      if (offset !== expectedOffset || !length
          || offset + length > templateExecutionBytes) {
        memoryFabric.release();
        throw new Error('native STEP template directory is invalid');
      }
      templates.push({ offset, length });
      expectedOffset += length;
    }
    if (expectedOffset !== templateExecutionBytes) {
      memoryFabric.release();
      throw new Error('native STEP template extent is invalid');
    }
    const steps = [];
    expectedOffset = templateExecutionBytes;
    for (let index = 0; index < stepCount; index += 1) {
      const start = instanceBase + index * stepInstanceBytes;
      const view = new DataView(
        descriptorRegion.buffer, descriptorRegion.byteOffset + start,
        stepInstanceBytes,
      );
      const templateRank = view.getUint32(0, true);
      const parameterOffset = view.getUint32(4, true);
      const parameterLength = view.getUint32(8, true);
      const length = view.getUint32(12, true);
      const template = templates[templateRank - 1];
      if (!template || parameterOffset !== expectedOffset
          || parameterOffset + parameterLength
            > templateExecutionBytes + parameterExecutionBytes
          || !length) {
        memoryFabric.release();
        throw new Error('native STEP instance directory is invalid');
      }
      steps.push({
        template,
        parameters: { offset: parameterOffset, length: parameterLength },
        length,
      });
      expectedOffset += parameterLength;
    }
    if (expectedOffset !== templateExecutionBytes + parameterExecutionBytes) {
      memoryFabric.release();
      throw new Error('native STEP parameter extent is invalid');
    }
    const guards = [];
    expectedOffset = templateExecutionBytes + parameterExecutionBytes;
    for (let index = 0; index < guardCount; index += 1) {
      const start = guardBase + index * extentBytes;
      const view = new DataView(
        descriptorRegion.buffer, descriptorRegion.byteOffset + start,
        extentBytes,
      );
      const offset = view.getUint32(0, true);
      const length = view.getUint32(4, true);
      if (offset !== expectedOffset || !length
          || offset + length > executionBytes) {
        memoryFabric.release();
        throw new Error('native code proof directory is invalid');
      }
      guards.push({ offset, length });
      expectedOffset += length;
    }
    if (expectedOffset !== executionBytes) {
      memoryFabric.release();
      throw new Error('native code proof extent is invalid');
    }
    uniqueSteps = steps.length;
    uniqueStepTemplates = templates.length;
    uniqueGuards = guards.length;
    for (let index = 0; index < blockCount; index += 1) {
      const start = index * NATIVE_HEADER_BYTES;
      const descriptor = descriptorRegion.subarray(
        start, start + NATIVE_HEADER_BYTES,
      );
      const descriptorView = new DataView(
        descriptor.buffer, descriptor.byteOffset, descriptor.byteLength,
      );
      const rip = descriptorView.getBigUint64(8, true);
      const rank = descriptorView.getUint32(56, true);
      const guardRank = descriptorView.getUint32(60, true);
      const step = steps[rank - 1];
      const guard = guardRank ? guards[guardRank - 1]
        : { offset: 0, length: 0 };
      if (rip < prior || !step || !guard
          || !DESCRIPTOR_MAGIC.every(
            (value, position) => descriptor[position] === value,
          )
          || descriptorView.getUint16(4, true) !== 3
          || descriptorView.getUint16(6, true) !== NATIVE_HEADER_BYTES
          || descriptorView.getUint32(24, true) !== step.length
          || (rip === prior && guard.offset <= priorGuard)) {
        throw new Error(
          `native x86 descriptor 0x${rip.toString(16)} is invalid`,
        );
      }
      const key = rip.toString();
      const variants = directory.get(key) || [];
      variants.push({
        descriptor,
        template: step.template,
        parameters: step.parameters,
        guard,
      });
      directory.set(key, variants);
      prior = rip;
      priorGuard = guard.offset;
    }
    }
  } else if (v2) {
    blockCount = safeInteger(header.block_count, 'block count');
    const stepCount = safeInteger(header.step_count, 'STEP count');
    const guardCount = safeInteger(header.guard_count ?? 0, 'code proof count');
    const stepExecutionBytes = safeInteger(
      header.step_execution_bytes ?? executionBytes, 'STEP execution bytes',
    );
    const stepIdentityBytes = 8;
    if (descriptorBytes !== blockCount * NATIVE_HEADER_BYTES
        + (stepCount + guardCount) * stepIdentityBytes
        || stepExecutionBytes > executionBytes) {
      memoryFabric.release();
      throw new Error('native x86 descriptor extent is invalid');
    }
    const steps = [];
    let expectedOffset = 0;
    const descriptorRegion = await range(descriptorStart, descriptorBytes);
    const identityBase = blockCount * NATIVE_HEADER_BYTES;
    for (let index = 0; index < stepCount; index += 1) {
      const start = identityBase + index * stepIdentityBytes;
      const identityView = new DataView(
        descriptorRegion.buffer,
        descriptorRegion.byteOffset + start,
        stepIdentityBytes,
      );
      const offset = identityView.getUint32(0, true);
      const length = identityView.getUint32(4, true);
      if (offset !== expectedOffset || offset + length > stepExecutionBytes) {
        memoryFabric.release();
        throw new Error('native STEP directory is invalid');
      }
      steps.push({ offset, length });
      expectedOffset += length;
    }
    if (expectedOffset !== stepExecutionBytes) {
      memoryFabric.release();
      throw new Error('native STEP extent is invalid');
    }
    uniqueSteps = steps.length;
    uniqueStepTemplates = steps.length;
    const guards = [];
    const guardBase = identityBase + stepCount * stepIdentityBytes;
    expectedOffset = stepExecutionBytes;
    for (let index = 0; index < guardCount; index += 1) {
      const start = guardBase + index * stepIdentityBytes;
      const identityView = new DataView(
        descriptorRegion.buffer,
        descriptorRegion.byteOffset + start,
        stepIdentityBytes,
      );
      const offset = identityView.getUint32(0, true);
      const length = identityView.getUint32(4, true);
      if (offset !== expectedOffset || !length
          || offset + length > executionBytes) {
        memoryFabric.release();
        throw new Error('native code proof directory is invalid');
      }
      guards.push({ offset, length });
      expectedOffset += length;
    }
    if (expectedOffset !== executionBytes) {
      memoryFabric.release();
      throw new Error('native code proof extent is invalid');
    }
    uniqueGuards = guards.length;
    for (let index = 0; index < blockCount; index += 1) {
      const start = index * NATIVE_HEADER_BYTES;
      const descriptor = descriptorRegion.subarray(
        start, start + NATIVE_HEADER_BYTES,
      );
      const descriptorView = new DataView(
        descriptor.buffer, descriptor.byteOffset, descriptor.byteLength,
      );
      const rip = descriptorView.getBigUint64(8, true);
      const rank = descriptorView.getUint32(56, true);
      const guardRank = descriptorView.getUint32(60, true);
      const step = steps[rank - 1];
      const guard = guardRank ? guards[guardRank - 1] : { offset: 0, length: 0 };
      const version = descriptorView.getUint16(4, true);
      if (rip < prior || !step || !guard
          || !DESCRIPTOR_MAGIC.every(
            (value, position) => descriptor[position] === value,
          )
          || ![1, 2].includes(version)
          || descriptorView.getUint16(6, true) !== NATIVE_HEADER_BYTES
          || descriptorView.getBigUint64(8, true) !== rip
          || descriptorView.getUint32(24, true) !== step.length
          || (version === 1 && guard.length)
          || (version === 2 && !guard.length)
          || (rip === prior && guard.offset <= priorGuard)) {
        throw new Error(`native x86 descriptor 0x${rip.toString(16)} is invalid`);
      }
      const key = rip.toString();
      const variants = directory.get(key) || [];
      variants.push({ descriptor, step, guard });
      directory.set(key, variants);
      prior = rip;
      priorGuard = guard.offset;
    }
  } else {
    for (const [rawRip, rawOffset, rawLength] of header.blocks) {
      const rip = word(rawRip, 'block RIP');
      const offset = safeInteger(rawOffset, 'block offset');
      const length = safeInteger(rawLength, 'block length');
      if (rip <= prior || length < NATIVE_HEADER_BYTES
          || offset + length > blockBytes) {
        memoryFabric.release();
        throw new Error('native x86 block directory is invalid');
      }
      const record = bytes.subarray(
        descriptorStart + offset, descriptorStart + offset + length,
      );
      if (!BLOCK_MAGIC.every((value, index) => record[index] === value)
          || new DataView(record.buffer, record.byteOffset, record.byteLength)
            .getBigUint64(8, true) !== rip) {
        memoryFabric.release();
        throw new Error(`native x86 block 0x${rip.toString(16)} is invalid`);
      }
      directory.set(rip.toString(), [record]);
      prior = rip;
    }
    blockCount = directory.size;
    uniqueSteps = directory.size;
    uniqueStepTemplates = directory.size;
  }

  const dirty = new Map();
  const descriptorsOpened = performance.now();
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
  // Admission keeps the quotient: a shared SSA template is retained once, by
  // rank, however many blocks project through it.  Caching the assembled X86B
  // record instead would hold one copy of the template per block and undo the
  // collapse -- measured at 4.30x on a boot's admitted working set.
  //
  // The consumer copies the returned bytes straight into vm_step_buffer and
  // does not retain them, so the assembly buffer is reused rather than kept.
  const blockPartsCache = new Map();
  const templateCache = new Map();
  const guardCache = new Map();
  const parameterCache = new Map();
  let blockRecordCacheHits = 0;
  let retainedBytes = 0;
  let assemblyBuffer = new Uint8Array(0);
  const retain = (cache, key, bytes) => {
    const held = cache.get(key);
    if (held) return held;
    cache.set(key, bytes);
    retainedBytes += bytes.length;
    return bytes;
  };
  // Transient: the caller copies these bytes into vm_step_buffer and drops
  // them, so one buffer serves every admission.  Nothing per-block is kept.
  const assemble = (parts) => {
    const { guard, parameters, template, rip } = parts;
    const length = NATIVE_HEADER_BYTES
      + guard.length + parameters.length + template.length;
    if (assemblyBuffer.length < length) {
      assemblyBuffer = new Uint8Array(length);
    }
    const record = assemblyBuffer.subarray(0, length);
    record.fill(0, 0, NATIVE_HEADER_BYTES);
    record.set(BLOCK_MAGIC);
    const view = new DataView(
      record.buffer, record.byteOffset, record.byteLength,
    );
    view.setUint16(4, 3, true);
    view.setUint16(6, NATIVE_HEADER_BYTES, true);
    view.setBigUint64(8, rip, true);
    const addRip = (value) => BigInt.asUintN(64, rip + value);
    view.setBigUint64(16, addRip(parts.boundary), true);
    view.setUint32(24, parts.stepLength, true);
    view.setUint32(28, parts.control, true);
    const relativeFirst = parts.control === 2
      || ![0, 3, 4, 5, 12, 14, 22].includes(parts.control);
    view.setBigUint64(
      32, relativeFirst ? addRip(parts.first) : parts.first, true,
    );
    view.setBigUint64(
      40, parts.control === 2 ? addRip(parts.second) : parts.second, true,
    );
    view.setBigUint64(48, parts.third, true);
    view.setUint32(56, parameters.length, true);
    view.setUint32(60, template.length, true);
    let cursor = NATIVE_HEADER_BYTES;
    record.set(guard, cursor);
    cursor += guard.length;
    record.set(parameters, cursor);
    cursor += parameters.length;
    record.set(template, cursor);
    return record;
  };
  const blocks = {
    length: blockBytes,
    async read(rip, candidate = 0) {
      if (physicalBlocks) {
        if (!Number.isSafeInteger(candidate) || candidate < 0) return null;
        rip = BigInt.asUintN(64, rip);
        const cacheKey = `${rip.toString()}:${candidate}`;
        const cachedParts = blockPartsCache.get(cacheKey);
        if (cachedParts) {
          blockRecordCacheHits += 1;
          return assemble(cachedParts);
        }
        const physical = physicalBlocks;
        const rowRip = (index) => physical.view.getBigUint64(
          index * physical.blockInstanceBytes, true,
        );
        const tail = Number(rip & 255n);
        let low = physical.tailOffsets[tail];
        let high = physical.tailOffsets[tail + 1];
        while (low < high) {
          const middle = low + ((high - low) >> 1);
          if (rowRip(physical.tailRanks[middle]) < rip) low = middle + 1;
          else high = middle;
        }
        const selected = low + candidate;
        if (selected >= physical.tailOffsets[tail + 1]) return null;
        const index = physical.tailRanks[selected];
        if (rowRip(index) !== rip) return null;
        const rowAt = index * physical.blockInstanceBytes;
        const stepRank = physical.view.getUint32(rowAt + 8, true);
        const continuationRank = physical.view.getUint32(rowAt + 12, true);
        const guardRank = physical.view.getUint32(rowAt + 16, true);
        const stepAt = physical.instanceBase + (stepRank - 1) * 16;
        const templateRank = physical.view.getUint32(stepAt, true);
        const parameterOffset = physical.view.getUint32(stepAt + 4, true);
        const parameterLength = physical.view.getUint32(stepAt + 8, true);
        const stepLength = physical.view.getUint32(stepAt + 12, true);
        const templateAt = physical.templateBase + (templateRank - 1) * 8;
        const templateOffset = physical.view.getUint32(templateAt, true);
        const templateLength = physical.view.getUint32(templateAt + 4, true);
        let guardOffset = 0;
        let guardLength = 0;
        if (guardRank) {
          const guardAt = physical.guardBase + (guardRank - 1) * 8;
          guardOffset = physical.view.getUint32(guardAt, true);
          guardLength = physical.view.getUint32(guardAt + 4, true);
        }
        let control;
        let boundary;
        let first;
        let second;
        let third;
        if (physical.compactContinuations) {
          [control, boundary, first, second, third] =
            readCompactContinuation(physical, continuationRank);
        } else {
          const continuationAt = physical.continuationBase
            + (continuationRank - 1) * 40;
          control = physical.view.getUint32(continuationAt, true);
          boundary = physical.view.getBigUint64(
            continuationAt + 8, true,
          );
          first = physical.view.getBigUint64(continuationAt + 16, true);
          second = physical.view.getBigUint64(continuationAt + 24, true);
          third = physical.view.getBigUint64(continuationAt + 32, true);
        }
        const [guard, parameters, template] = await Promise.all([
          range(executionStart + guardOffset, guardLength),
          range(executionStart + parameterOffset, parameterLength),
          range(executionStart + templateOffset, templateLength),
        ]);
        const parts = {
          rip,
          guard: retain(guardCache, guardRank, guard),
          parameters: retain(parameterCache, stepRank, parameters),
          template: retain(templateCache, templateRank, template),
          stepLength,
          control,
          boundary,
          first,
          second,
          third,
        };
        blockPartsCache.set(cacheKey, parts);
        return assemble(parts);
      }
      const variants = directory.get(BigInt.asUintN(64, rip).toString());
      const resident = variants?.[candidate];
      if (!resident) return null;
      if (resident instanceof Uint8Array) return resident.slice();
      if (resident.template) {
        // Admission keeps the quotient physical: the browser concatenates
        // mapped extents, while vm.wasm applies the typed projection before
        // validating the ordinary STEP page. No JS operand graph exists.
        const [guard, parameters, template] = await Promise.all([
          range(
            executionStart + resident.guard.offset, resident.guard.length,
          ),
          range(
            executionStart + resident.parameters.offset,
            resident.parameters.length,
          ),
          range(
            executionStart + resident.template.offset,
            resident.template.length,
          ),
        ]);
        const record = new Uint8Array(
          NATIVE_HEADER_BYTES + guard.length
            + parameters.length + template.length,
        );
        record.set(resident.descriptor.subarray(0, 56));
        record[3] = BLOCK_MAGIC[3];
        record.fill(0, 56, NATIVE_HEADER_BYTES);
        const recordView = new DataView(record.buffer);
        recordView.setUint32(56, parameters.length, true);
        recordView.setUint32(60, template.length, true);
        let cursor = NATIVE_HEADER_BYTES;
        record.set(guard, cursor);
        cursor += guard.length;
        record.set(parameters, cursor);
        cursor += parameters.length;
        record.set(template, cursor);
        return record;
      }
      // A v2 artifact shares only exact STEP pages. Keep it readable while
      // v3 and later artifacts project literals and frame coordinates.
      const [guard, step] = await Promise.all([
        range(
          executionStart + resident.guard.offset, resident.guard.length,
        ),
        range(executionStart + resident.step.offset, resident.step.length),
      ]);
      const record = new Uint8Array(
        NATIVE_HEADER_BYTES + guard.length + step.length,
      );
      record.set(resident.descriptor.subarray(0, 56));
      record[3] = BLOCK_MAGIC[3];
      record.fill(0, 56, NATIVE_HEADER_BYTES);
      record.set(guard, NATIVE_HEADER_BYTES);
      record.set(step, NATIVE_HEADER_BYTES + guard.length);
      return record;
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
      blockPartsCache.clear();
      templateCache.clear();
      guardCache.clear();
      parameterCache.clear();
      blockRecordCacheHits = 0;
      retainedBytes = 0;
      assemblyBuffer = new Uint8Array(0);
      physicalBlocks = null;
      return resident;
    },
    layout() {
      return {
        blocks: blockCount,
        coordinates: v5 || v4 ? coordinateCount : directory.size,
        uniqueSteps,
        sharedSteps: blockCount - uniqueSteps,
        uniqueStepTemplates,
        sharedStepTemplates: uniqueSteps - uniqueStepTemplates,
        uniqueCodeProofs: uniqueGuards,
        uniqueContinuations,
        sharedContinuations: v5 || v4
          ? blockCount - uniqueContinuations : 0,
        blockIndex: v5 || v4 ? {
          kind: 'tail-byte-csr',
          buckets: 256,
          bytes: 4 * (257 + blockCount),
        } : null,
        recordCache: {
          records: blockPartsCache.size,
          bytes: retainedBytes,
          hits: blockRecordCacheHits,
          admittedTemplates: templateCache.size,
          admittedTemplateBytes: [...templateCache.values()].reduce(
            (total, bytes) => total + bytes.length, 0,
          ),
        },
        descriptorBytes,
        executionBytes: v5 || v4 || v3 || v2 ? executionBytes : blockBytes
          - directory.size * NATIVE_HEADER_BYTES,
        openMilliseconds: {
          memory: memoryOpened - openStarted,
          descriptorFetch: descriptorFetched - memoryOpened,
          descriptorDirectories: blockRowsStarted - descriptorFetched,
          blockValidation: blockRowsValidated - blockRowsStarted,
          blockIndex: blockIndexBuilt - blockRowsValidated,
          descriptors: descriptorsOpened - memoryOpened,
        },
        dirtyPages: dirty.size,
        memory: memoryFabric.layout(),
        delivery: direct || typeof backing.layout !== 'function'
          ? null : backing.layout(),
      };
    },
  };
}
