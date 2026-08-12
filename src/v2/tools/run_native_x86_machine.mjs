#!/usr/bin/env node
// Execute a build-time native x86 artifact through vm.wasm only.

import { readFileSync, writeFileSync } from 'node:fs';

const [artifactPath, wasmPath, rawBlocks = '1', snapshotPath] =
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
const artifact = await X86.openNativeX86Artifact(
  new Uint8Array(readFileSync(artifactPath)),
);
let traceCompleted = 0;
const traceFrom = Number(process.env.QM_X86_TRACE_FROM || 0);
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
await VM.load(module);
const machine = await VM.openX86Machine(artifact);
const started = performance.now();
let state;
let completedBlocks = 0;
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
  for (let completed = 0; completed < blocks; completed += 1) {
    traceCompleted = completed;
    state = await machine.advance(1);
    if (state.missingBlock != null) break;
    completedBlocks = completed + 1;
    if (process.env.QM_X86_TRACE && completed >= traceFrom) process.stderr.write(
      `${completed + 1} ${state.rip.toString(16)} ${state.retired} ${state.status}\n`,
    );
    if (process.env.QM_X86_STATE_TRACE) process.stderr.write(
      `@state ${JSON.stringify({ block: completed + 1, ...snapshot() })}\n`,
    );
    if (state.halted) break;
  }
  const layout = artifact.layout();
  const observed = snapshot();
  if (snapshotPath) {
    const word = (value) => value.toString(16).padStart(16, '0');
    const machineState = machine.snapshot();
    const dirty = artifact.snapshot().dirtyPages.map(([page, bytes]) => [
      page, Buffer.from(bytes).toString('base64'),
    ]);
    writeFileSync(snapshotPath, `${JSON.stringify({
      schema: 1,
      state: {
        registers: machineState.registers.map(word),
        rip: word(machineState.rip),
        rflags: word(machineState.rflags),
        cr0: word(machineState.cr0),
        cr3: word(machineState.cr3),
        cr4: word(machineState.cr4),
        efer: word(machineState.efer),
        system: machineState.system.map(word),
        msrs: machineState.msrs.map(([key, value]) => [word(key), word(value)]),
      },
      dirty_pages: dirty,
    })}\n`);
  }
  process.stdout.write(`${JSON.stringify({
    requested_blocks: blocks,
    completed_blocks: completedBlocks,
    elapsed_ms: performance.now() - started,
    halted: state.halted,
    missing_block: state.missingBlock?.toString(16) || null,
    ...observed,
    layout,
  }, null, 2)}\n`);
} finally {
  machine.release();
  artifact.release();
  VM.release();
}
