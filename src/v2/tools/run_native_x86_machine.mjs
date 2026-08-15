#!/usr/bin/env node
// Execute a build-time native x86 artifact through vm.wasm only.

import { readFileSync, writeFileSync } from 'node:fs';

const [artifactPath, wasmPath, rawBlocks = '1', snapshotPath, resumePath] =
  process.argv.slice(2);
if (!artifactPath || !wasmPath) {
  throw new Error('usage: run_native_x86_machine.mjs ARTIFACT VM_WASM [BLOCKS]');
}
const blocks = Number(rawBlocks);
if (!Number.isSafeInteger(blocks) || blocks <= 0) {
  throw new Error('BLOCKS must be a positive safe integer');
}
const root = new URL('../web/', import.meta.url);
const VM = await import(new URL('vm.js', root));
const X86 = await import(new URL('x86-machine.js', root));
const openStarted = performance.now();
const artifact = await X86.openNativeX86Artifact(
  new Uint8Array(readFileSync(artifactPath)),
);
const artifactOpened = performance.now();
let restoredState = artifact.state;
if (resumePath) {
  const restored = JSON.parse(readFileSync(resumePath, 'utf8'));
  if (![1, 2].includes(restored.schema)
      || !restored.state || !Array.isArray(restored.dirty_pages)) {
    throw new Error('native x86 resume snapshot is invalid');
  }
  const word = (value) => BigInt(`0x${value}`);
  const saved = restored.state;
  restoredState = {
    registers: saved.registers.map(word),
    xmm: (saved.xmm || Array(32).fill('0')).map(word),
    rip: word(saved.rip),
    rflags: word(saved.rflags),
    cr0: word(saved.cr0),
    cr3: word(saved.cr3),
    cr4: word(saved.cr4),
    efer: word(saved.efer),
    system: saved.system.map(word),
    msrs: saved.msrs.map(([key, value]) => [word(key), word(value)]),
    ioPorts: (saved.io_ports || []).map(
      ([coordinate, value]) => [coordinate, word(value)],
    ),
    consoleInput: Uint8Array.from(
      Buffer.from(saved.console_input || '', 'base64'),
    ),
    consoleOutput: Uint8Array.from(
      Buffer.from(saved.console_output || '', 'base64'),
    ),
  };
  for (const [page, encoded] of restored.dirty_pages) {
    const bytes = Uint8Array.from(Buffer.from(encoded, 'base64'));
    if (!Number.isSafeInteger(page) || page < 0 || bytes.length !== 4096) {
      throw new Error('native x86 resume page is invalid');
    }
    await artifact.memory.write(page * 4096, bytes);
  }
}
let traceCompleted = 0;
const traceFrom = Number(process.env.QM_X86_TRACE_FROM || 0);
const watchedRegister = process.env.QM_X86_WATCH_REGISTER == null
  ? null : Number(process.env.QM_X86_WATCH_REGISTER);
const watchUserOnly = Boolean(process.env.QM_X86_WATCH_USER_ONLY);
const traceUser = Boolean(process.env.QM_X86_TRACE_USER);
const sampleEvery = Number(process.env.QM_X86_SAMPLE_EVERY || 0);
const profileStateSteps = Boolean(process.env.QM_X86_PROFILE_STATE_STEPS);
const profileBlockMisses = Boolean(process.env.QM_X86_PROFILE_BLOCK_MISSES);
const stopConsole = process.env.QM_X86_STOP_CONSOLE || null;
const consoleQuantum = Number(process.env.QM_X86_CONSOLE_QUANTUM || 1024);
const stopRip = process.env.QM_X86_STOP_RIP == null
  ? null : BigInt(`0x${process.env.QM_X86_STOP_RIP.replace(/^0x/, '')}`);
const stopRipHit = Number(process.env.QM_X86_STOP_RIP_HIT || 1);
const collectStopRipSamples = Boolean(process.env.QM_X86_STOP_RIP_SAMPLES);
const stopZeroRegister = process.env.QM_X86_STOP_ZERO_REGISTER == null
  ? null : Number(process.env.QM_X86_STOP_ZERO_REGISTER);
if (watchedRegister != null
    && (!Number.isInteger(watchedRegister)
        || watchedRegister < 0 || watchedRegister >= 16)) {
  throw new Error('QM_X86_WATCH_REGISTER must be a GPR index from 0 to 15');
}
if (!Number.isSafeInteger(sampleEvery) || sampleEvery < 0) {
  throw new Error('QM_X86_SAMPLE_EVERY must be a non-negative integer');
}
if (!Number.isSafeInteger(consoleQuantum) || consoleQuantum <= 0) {
  throw new Error('QM_X86_CONSOLE_QUANTUM must be a positive integer');
}
if (stopZeroRegister != null
    && (!Number.isInteger(stopZeroRegister)
        || stopZeroRegister < 0 || stopZeroRegister >= 16)) {
  throw new Error('QM_X86_STOP_ZERO_REGISTER must be a GPR index from 0 to 15');
}
if (stopZeroRegister != null && stopRip == null) {
  throw new Error('QM_X86_STOP_ZERO_REGISTER requires QM_X86_STOP_RIP');
}
if (!Number.isSafeInteger(stopRipHit) || stopRipHit < 1) {
  throw new Error('QM_X86_STOP_RIP_HIT must be a positive safe integer');
}
const trace = (message) => {
  if (traceCompleted >= traceFrom) process.stderr.write(message);
};
if (profileBlockMisses) {
  const readBlock = artifact.blocks.read.bind(artifact.blocks);
  artifact.blocks.read = async (rip, candidate = 0) => {
    const record = await readBlock(rip, candidate);
    const key = BigInt.asUintN(64, rip).toString(16).padStart(16, '0');
    const row = blockMissRips.get(key) || {
      count: 0,
      bytes: 0,
      max_bytes: 0,
      oversize: 0,
      nulls: 0,
      max_candidate: 0,
    };
    row.count += 1;
    row.max_candidate = Math.max(row.max_candidate, candidate);
    if (record == null) {
      row.nulls += 1;
    } else {
      row.bytes += record.length;
      row.max_bytes = Math.max(row.max_bytes, record.length);
      if (record.length > 1024) row.oversize += 1;
    }
    blockMissRips.set(key, row);
    return record;
  };
}
if (process.env.QM_X86_TRACE) {
  const readBlock = artifact.blocks.read.bind(artifact.blocks);
  artifact.blocks.read = async (rip) => {
    trace(`block ${rip.toString(16)}\n`);
    return readBlock(rip);
  };
  const readPage = artifact.memory.read.bind(artifact.memory);
  artifact.memory.read = async (offset, length) => {
    trace(`read ${offset.toString(16)} ${length}\n`);
    return readPage(offset, length);
  };
  const writePage = artifact.memory.write.bind(artifact.memory);
  artifact.memory.write = async (offset, bytes) => {
    trace(`write ${offset.toString(16)} ${bytes.length}\n`);
    return writePage(offset, bytes);
  };
}
const module = await WebAssembly.compile(readFileSync(wasmPath));
const moduleCompiled = performance.now();
await VM.load(module);
const consoleBytes = [];
let consoleTail = '';
const consoleDecoder = new TextDecoder('utf-8', { fatal: false });
const machine = await VM.openX86Machine({
  ...artifact,
  state: restoredState,
  devices: {
    consoleWrite(bytes) {
      if (consoleBytes.length < (1 << 20)) consoleBytes.push(...bytes);
      consoleTail = (consoleTail
        + consoleDecoder.decode(bytes, { stream: true })).slice(-4096);
      if (process.env.QM_X86_TRACE) {
        trace(`@console ${traceCompleted} ${Buffer.from(bytes).toString('base64')}\n`);
      }
    },
    entropy({ rip }) {
      return BigInt.asUintN(
        64,
        rip * 0x9e3779b97f4a7c15n + 0xd1b54a32d192ed03n,
      );
    },
  },
});
if (process.env.QM_X86_CONSOLE_INPUT_BASE64 != null) {
  machine.feedConsole(Uint8Array.from(Buffer.from(
    process.env.QM_X86_CONSOLE_INPUT_BASE64, 'base64',
  )));
} else if (process.env.QM_X86_CONSOLE_INPUT != null) {
  machine.feedConsole(process.env.QM_X86_CONSOLE_INPUT);
}
const machineOpened = performance.now();
const started = performance.now();
let state;
let completedBlocks = 0;
let stopPredecessor = null;
let priorRip = null;
let stopRipSeen = 0;
const stopRipSamples = [];
const sampledRips = new Map();
const sampleTail = [];
const stateStepRips = new Map();
const stateStepEdges = new Map();
const blockMissRips = new Map();
let profiledStateSteps = 0;
function addStateStep(map, key, retired, work, span) {
  const row = map.get(key) || { count: 0, retired: 0n, work: 0n, span: 0n };
  row.count += 1;
  row.retired += retired;
  row.work += work;
  row.span += span;
  map.set(key, row);
}
function rankedStateSteps(map, limit = 32) {
  return Array.from(map, ([key, row]) => ({
    key,
    count: row.count,
    retired: row.retired.toString(),
    work: row.work.toString(),
    span: row.span.toString(),
  })).sort((left, right) => right.count - left.count
      || (BigInt(right.work) > BigInt(left.work) ? 1
        : BigInt(right.work) < BigInt(left.work) ? -1 : 0)
      || left.key.localeCompare(right.key)).slice(0, limit);
}
function rankedBlockMisses(map, limit = 32) {
  return Array.from(map, ([key, row]) => ({ key, ...row }))
    .sort((left, right) => right.count - left.count
      || right.bytes - left.bytes
      || left.key.localeCompare(right.key))
    .slice(0, limit);
}
function summarizeBlockMisses(map) {
  const limits = [256, 512, 768, 1024, 1536, 2048, 4096];
  const summary = {
    reads: 0,
    bytes: 0,
    oversize: 0,
    nulls: 0,
    unique_rips: map.size,
  };
  const size_classes = limits.map((limit) => ({
    limit,
    reads: 0,
    unique_rips: 0,
  }));
  for (const row of map.values()) {
    summary.reads += row.count;
    summary.bytes += row.bytes;
    summary.oversize += row.oversize;
    summary.nulls += row.nulls;
    const sizeClass = size_classes.find((entry) => row.max_bytes <= entry.limit);
    if (sizeClass) {
      sizeClass.reads += row.count - row.nulls;
      sizeClass.unique_rips += 1;
    }
  }
  return { ...summary, size_classes, top_rips: rankedBlockMisses(map) };
}
function snapshot() {
  const registersAt = machine.exports.vm_x86_registers(machine.session);
  const view = new DataView(machine.exports.memory.buffer);
  return {
    rip: state.rip.toString(16).padStart(16, '0'),
    rflags: machine.exports.vm_x86_rflags(machine.session)
      .toString(16).padStart(16, '0'),
    registers: Array.from({ length: 16 }, (_unused, index) =>
      view.getBigUint64(registersAt + index * 8, true)
        .toString(16).padStart(16, '0')),
    retired: state.retired.toString(),
    work: state.work.toString(),
    span: state.span.toString(),
    host_barriers: state.hostBarriers,
    timer_source: Number(machine.exports.vm_x86_io_value(
      machine.session, 0x10046,
    )),
  };
}
try {
  if (!process.env.QM_X86_TRACE && !process.env.QM_X86_STATE_TRACE
      && watchedRegister == null && !traceUser && stopRip == null
      && sampleEvery === 0 && !profileStateSteps && stopConsole == null) {
    state = await machine.advance(blocks);
    completedBlocks = state.completedBlocks;
  } else if (stopConsole != null && !process.env.QM_X86_TRACE
      && !process.env.QM_X86_STATE_TRACE && watchedRegister == null
      && !traceUser && stopRip == null && !profileStateSteps) {
    while (completedBlocks < blocks) {
      const quantum = Math.min(consoleQuantum, blocks - completedBlocks);
      state = await machine.advance(quantum);
      completedBlocks += state.completedBlocks;
      if (state.missingBlock != null || state.halted
          || state.completedBlocks < quantum
          || consoleTail.includes(stopConsole)) break;
    }
  } else if (sampleEvery > 0 && !process.env.QM_X86_TRACE
      && !process.env.QM_X86_STATE_TRACE && watchedRegister == null
      && !traceUser && stopRip == null) {
    while (completedBlocks < blocks) {
      const quantum = Math.min(sampleEvery, blocks - completedBlocks);
      state = await machine.advance(quantum);
      completedBlocks += state.completedBlocks;
      const rip = state.rip.toString(16).padStart(16, '0');
      sampledRips.set(rip, (sampledRips.get(rip) || 0) + 1);
      sampleTail.push({
        block: completedBlocks,
        rip,
        retired: state.retired.toString(),
        work: state.work.toString(),
        span: state.span.toString(),
        hostBarriers: state.hostBarriers,
      });
      if (sampleTail.length > 16) sampleTail.shift();
      if (state.missingBlock != null || state.halted
          || state.completedBlocks < quantum) break;
    }
  } else {
    let watchedValue = watchedRegister == null
      ? null : restoredState.registers[watchedRegister];
    for (let completed = 0; completed < blocks; completed += 1) {
      traceCompleted = completed;
      const before = profileStateSteps ? machine.status() : null;
      if (stopRip != null) {
        const before = machine.status();
        const machineState = (stopZeroRegister != null
                              || collectStopRipSamples)
          ? machine.snapshot() : null;
        const registers = machineState?.registers || null;
        if (before.rip === stopRip
            && (stopZeroRegister == null
                || registers[stopZeroRegister] === 0n)) {
          stopRipSeen += 1;
          if (collectStopRipSamples && stopRipSamples.length < 256) {
            stopRipSamples.push({
              hit: stopRipSeen,
              block: completed,
              predecessor: priorRip?.toString(16) || null,
              registers: registers.map((value) => value.toString(16)),
            });
          }
          if (stopRipSeen >= stopRipHit) {
            state = before;
            stopPredecessor = priorRip;
            break;
          }
        }
        priorRip = before.rip;
      }
      state = await machine.advance(1);
      if (profileStateSteps && state.completedBlocks) {
        const beforeRip = before.rip.toString(16).padStart(16, '0');
        const afterRip = state.rip.toString(16).padStart(16, '0');
        const retired = state.retired - before.retired;
        const work = state.work - before.work;
        const span = state.span - before.span;
        addStateStep(stateStepRips, beforeRip, retired, work, span);
        addStateStep(
          stateStepEdges, `${beforeRip}->${afterRip}`, retired, work, span,
        );
        profiledStateSteps += 1;
      }
      if (state.missingBlock != null) break;
      completedBlocks = completed + 1;
      if (process.env.QM_X86_TRACE && completed >= traceFrom) process.stderr.write(
        `${completed + 1} ${state.rip.toString(16)} ${state.retired} ${state.status}\n`,
      );
      if (process.env.QM_X86_STATE_TRACE && completed >= traceFrom) process.stderr.write(
        `@state ${JSON.stringify({ block: completed + 1, ...snapshot() })}\n`,
      );
      if (traceUser && completed >= traceFrom
          && state.rip < 0x0000800000000000n) {
        process.stderr.write(
          `@user ${JSON.stringify({ block: completed + 1, ...snapshot() })}\n`,
        );
      }
      if (watchedRegister != null) {
        const current = machine.snapshot().registers[watchedRegister];
        const watchScope = !watchUserOnly || state.rip < 0x0000800000000000n;
        if (current !== watchedValue && watchScope) {
          if (completed >= traceFrom) {
            process.stderr.write(
            `@register ${JSON.stringify({
              block: completed + 1,
              register: watchedRegister,
              before: watchedValue.toString(16),
              after: current.toString(16),
              rip: state.rip.toString(16),
              retired: state.retired.toString(),
            })}\n`,
            );
          }
          watchedValue = current;
        }
      }
      if (state.halted) break;
    }
  }
  const layout = artifact.layout();
  const observed = snapshot();
  if (snapshotPath && snapshotPath !== '-') {
    await machine.flush();
    const word = (value) => value.toString(16).padStart(16, '0');
    const machineState = machine.snapshot();
    const dirty = artifact.snapshot().dirtyPages.map(([page, bytes]) => [
      page, Buffer.from(bytes).toString('base64'),
    ]);
    writeFileSync(snapshotPath, `${JSON.stringify({
      schema: 2,
      state: {
        registers: machineState.registers.map(word),
        xmm: machineState.xmm.map(word),
        rip: word(machineState.rip),
        rflags: word(machineState.rflags),
        cr0: word(machineState.cr0),
        cr3: word(machineState.cr3),
        cr4: word(machineState.cr4),
        efer: word(machineState.efer),
        system: machineState.system.map(word),
        msrs: machineState.msrs.map(([key, value]) => [word(key), word(value)]),
        io_ports: machineState.ioPorts.map(
          ([coordinate, value]) => [coordinate, word(value)],
        ),
        console_input: Buffer.from(machineState.consoleInput).toString('base64'),
        console_output: Buffer.from(machineState.consoleOutput).toString('base64'),
      },
      dirty_pages: dirty,
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    requested_blocks: blocks,
    completed_blocks: completedBlocks,
    artifact_open_ms: artifactOpened - openStarted,
    module_compile_ms: moduleCompiled - artifactOpened,
    machine_open_ms: machineOpened - moduleCompiled,
    elapsed_ms: performance.now() - started,
    halted: state.halted,
    missing_block: state.missingBlock?.toString(16) || null,
    ...observed,
    console_bytes: consoleBytes.length,
    console: new TextDecoder('utf-8', { fatal: false }).decode(
      Uint8Array.from(consoleBytes),
    ),
    sample_every: sampleEvery,
    sampled_rips: Array.from(sampledRips, ([rip, count]) => ({ rip, count }))
      .sort((left, right) => right.count - left.count || left.rip.localeCompare(right.rip))
      .slice(0, 32),
    sample_tail: sampleTail,
    stop_predecessor: stopPredecessor?.toString(16) || null,
    stop_rip_hits: stopRipSeen,
    stop_rip_samples: stopRipSamples,
    state_step_profile: profileStateSteps ? {
      steps: profiledStateSteps,
      unique_rips: stateStepRips.size,
      unique_edges: stateStepEdges.size,
      top_rips: rankedStateSteps(stateStepRips),
      top_edges: rankedStateSteps(stateStepEdges),
    } : null,
    block_miss_profile: profileBlockMisses
      ? summarizeBlockMisses(blockMissRips) : null,
    resumed: Boolean(resumePath),
    layout,
  }, null, 2)}\n`);
} finally {
  machine.release();
  artifact.release();
  VM.release();
}
