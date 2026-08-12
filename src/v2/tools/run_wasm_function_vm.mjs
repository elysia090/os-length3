#!/usr/bin/env node
// Run one exported, straight-line integer function through vm.wasm only.

import { readFileSync } from 'node:fs';

const [modulePath, vmPath, exportName, rawRows = '[]'] = process.argv.slice(2);
if (!modulePath || !vmPath || !exportName) {
  throw new Error(
    'usage: run_wasm_function_vm.mjs MODULE VM_WASM EXPORT JSON_ARGUMENT_ROWS',
  );
}
const rows = JSON.parse(rawRows);
if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) {
  throw new TypeError('JSON_ARGUMENT_ROWS must be an array of arrays');
}
const word = (value) => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError('wide integer arguments must be JSON strings');
  }
  return BigInt(value);
};
const unsigned = (value) => BigInt.asUintN(64, value).toString();

const root = new URL('../web/', import.meta.url);
const VM = await import(new URL('vm.js', root));
const Wasm = await import(new URL('wasm-function.js', root));
const runtime = await VM.load(await WebAssembly.compile(readFileSync(vmPath)));
try {
  const opened = Wasm.openWasmFunction(
    new Uint8Array(readFileSync(modulePath)), exportName,
  );
  const results = await VM.executeGuestFunctionBatch(
    opened.source, opened.start, opened.end,
    rows.map((row) => row.map(word)),
  );
  process.stdout.write(`${JSON.stringify({
    engine: 'vm.wasm',
    function_index: opened.functionIndex,
    body: [opened.start, opened.end],
    results: results.map(unsigned),
    locals: Array.from(
      { length: Number(runtime.exports.vm_guest_local_count()) },
      (_unused, index) => unsigned(runtime.exports.vm_guest_local(index)),
    ),
  })}\n`);
} finally {
  VM.release();
}
