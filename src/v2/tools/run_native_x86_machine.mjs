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
const stopRip = process.env.QM_X86_STOP_RIP == null
  ? null : BigInt(`0x${process.env.QM_X86_STOP_RIP.replace(/^0x/, '')}`);
if (watchedRegister != null
    && (!Number.isInteger(watchedRegister)
        || watchedRegister < 0 || watchedRegister >= 16)) {
  throw new Error('QM_X86_WATCH_REGISTER must be a GPR index from 0 to 15');
}
if (!Number.isSafeInteger(sampleEvery) || sampleEvery < 0) {
  throw new Error('QM_X86_SAMPLE_EVERY must be a non-negative integer');
}
const trace = (message) => {
  if (traceCompleted >= traceFrom) process.stderr.write(message);
};
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
const machine = await VM.openX86Machine({
  ...artifact,
  state: restoredState,
  devices: {
    consoleWrite(bytes) {
      if (consoleBytes.length < (1 << 20)) consoleBytes.push(...bytes);
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
const sampledRips = new Map();
const sampleTail = [];
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
  };
}
try {
  if (!process.env.QM_X86_TRACE && !process.env.QM_X86_STATE_TRACE
      && watchedRegister == null && !traceUser && stopRip == null
      && sampleEvery === 0) {
    state = await machine.advance(blocks);
    completedBlocks = state.completedBlocks;
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
      if (stopRip != null) {
        const before = machine.status();
        if (before.rip === stopRip) {
          state = before;
          break;
        }
      }
      state = await machine.advance(1);
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
      if (stopRip != null && state.rip === stopRip) break;
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
    resumed: Boolean(resumePath),
    layout,
  }, null, 2)}\n`);
} finally {
  machine.release();
  artifact.release();
  VM.release();
}
