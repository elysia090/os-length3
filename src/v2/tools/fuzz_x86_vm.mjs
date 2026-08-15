#!/usr/bin/env node
// Batch-check packed x86 state steps against their scalar reference states.

import { readFileSync } from 'node:fs';

const wasmPath = process.argv[2];
if (!wasmPath) throw new Error('usage: fuzz_x86_vm.mjs VM_WASM');
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!Number.isSafeInteger(input.memory_bytes) || input.memory_bytes <= 0
    || !Array.isArray(input.cases)) {
  throw new Error('x86 fuzz input is invalid');
}

const root = new URL('../web/', import.meta.url);
const VM = await import(new URL('vm.js', root));
await VM.load(await WebAssembly.compile(readFileSync(wasmPath)));
const bytes = (encoded) => Uint8Array.from(Buffer.from(encoded, 'base64'));
const word = (encoded) => BigInt(`0x${encoded}`);
const normalized = (state, memory, ranges) => ({
  registers: state.registers.map((value) =>
    BigInt.asUintN(64, value).toString(16).padStart(16, '0')),
  xmm: state.xmm.map((value) =>
    BigInt.asUintN(64, value).toString(16).padStart(16, '0')),
  rip: BigInt.asUintN(64, state.rip).toString(16).padStart(16, '0'),
  rflags: BigInt.asUintN(64, state.rflags).toString(16).padStart(16, '0'),
  halted: Boolean(state.halted),
  memory: ranges.map(([offset, encoded]) => [
    offset,
    Buffer.from(memory.subarray(offset, offset + bytes(encoded).length))
      .toString('base64'),
  ]),
});

let mismatch = null;
let completed = 0;
for (const fixture of input.cases) {
  const memoryBytes = new Uint8Array(input.memory_bytes);
  for (const [offset, encoded] of fixture.memory) {
    memoryBytes.set(bytes(encoded), offset);
  }
  const byRip = new Map(fixture.records.map(([rip, record]) => [
    word(rip).toString(), bytes(record),
  ]));
  const memory = {
    length: memoryBytes.length,
    async read(offset, length) {
      return memoryBytes.slice(offset, offset + length);
    },
    async write(offset, payload) {
      memoryBytes.set(payload, offset);
    },
  };
  const machine = await VM.openX86Machine({
    state: {
      registers: fixture.state.registers.map(word),
      xmm: fixture.state.xmm.map(word),
      rip: word(fixture.state.rip),
      rflags: word(fixture.state.rflags),
    },
    blocks: {
      async read(rip) { return byRip.get(rip.toString()) || null; },
    },
    memory,
  });
  try {
    const status = await machine.advance(1);
    await machine.flush();
    const snapshot = machine.snapshot();
    const actual = normalized({
      ...snapshot,
      halted: status.halted,
    }, memoryBytes, fixture.expected.memory);
    const expected = fixture.expected;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      mismatch = { case: fixture.case, actual, expected, status: {
        completed_blocks: status.completedBlocks,
        missing_block: status.missingBlock?.toString(16) || null,
      } };
      break;
    }
    completed += 1;
  } finally {
    machine.release();
  }
}
VM.release();
process.stdout.write(JSON.stringify({ cases: completed, mismatch }));
