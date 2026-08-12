import { readFileSync } from 'node:fs';

import {
  executeVirtualStateStepLoaded,
  load,
  release,
} from '../web/vm.js';

const [wasmPath, encodedPage] = process.argv.slice(2);
if (!wasmPath || !encodedPage) {
  throw new Error('usage: verify_x86_repeat_vm.mjs VM_WASM STEP_BASE64');
}

const decode = value => Uint8Array.from(Buffer.from(String(value), 'base64'));
const encode = value => Buffer.from(value).toString('base64');
const module = await WebAssembly.compile(readFileSync(wasmPath));
await load(module);

const pageBytes = 4096;
const firstPage = 0xffff800000100000n;
const iterations = 1600n;
const iterationBytes = 16n;
const extent = iterations * iterationBytes;
const pattern = 0x0102030405060708n;
const pages = new Map();
const reads = [];
const writes = [];

const result = executeVirtualStateStepLoaded(
  decode(encodedPage),
  [pattern, iterations, 0n, 0n, 0n, 0n, 0n, firstPage,
    0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 2n],
  [],
  (address, width) => {
    const coordinate = BigInt(address);
    if (Number(width) !== pageBytes) {
      throw new Error('vm.wasm requested a noncanonical x86 page');
    }
    reads.push(coordinate);
    const page = pages.get(coordinate) ?? new Uint8Array(pageBytes);
    pages.set(coordinate, page);
    return encode(page);
  },
  (address, encoded) => {
    const coordinate = BigInt(address);
    writes.push(coordinate);
    pages.set(coordinate, decode(encoded));
  },
);

if (result.locals[1] !== 0n || result.locals[7] !== firstPage + extent) {
  throw new Error('counted recurrence published the wrong register state');
}
if ((result.locals[16] & 0x40n) === 0n) {
  throw new Error('counted recurrence did not publish its terminal flags');
}
for (let offset = 0n; offset < extent; offset += 1n) {
  const coordinate = firstPage + offset;
  const page = coordinate & ~0xfffn;
  const byte = pages.get(page)?.[Number(coordinate & 0xfffn)];
  const expected = Number((pattern >> ((offset & 7n) * 8n)) & 0xffn);
  if (byte !== expected) {
    throw new Error(`repeat mismatch at byte ${offset}`);
  }
}
const expectedPages = Number((extent + 4095n) >> 12n);
if (result.work !== 4 || result.span !== 2
    || new Set(reads).size !== expectedPages
    || new Set(writes).size !== expectedPages) {
  throw new Error('counted recurrence escaped its persistent physical cut');
}

console.log(JSON.stringify({
  work: result.work,
  span: result.span,
  extent: Number(extent),
  pages: expectedPages,
  reads: reads.length,
  writes: writes.length,
}));
release();
