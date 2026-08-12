import { readFileSync } from 'node:fs';

import {
  executeVirtualStateStepLoaded,
  load,
  release,
} from '../web/vm.js';

const [wasmPath, encodedArgument] = process.argv.slice(2);
if (!wasmPath || !encodedArgument) {
  throw new Error('usage: verify_x86_copy_vm.mjs VM_WASM STEP_BASE64|-');
}
const encodedPage = encodedArgument === '-'
  ? readFileSync(0, 'utf8').trim()
  : encodedArgument;

const decode = value => Uint8Array.from(Buffer.from(String(value), 'base64'));
const encode = value => Buffer.from(value).toString('base64');
const module = await WebAssembly.compile(readFileSync(wasmPath));
await load(module);

const pageBytes = 4096;
const source = 0xffff800000300000n;
// Eight pages preserves the direct-cache slot while keeping the extents
// disjoint. This exercises eviction without changing copy semantics.
const target = source + 8n * BigInt(pageBytes);
const sentinel = 5 * pageBytes + 123;
const targetBytes = 3 * pageBytes + 10;
const pages = new Map();
const reads = [];
const writes = [];

for (let index = 0; index <= Math.floor(sentinel / pageBytes); index += 1) {
  const coordinate = source + BigInt(index * pageBytes);
  const page = new Uint8Array(pageBytes).fill('a'.charCodeAt(0));
  if (index === Math.floor(sentinel / pageBytes)) {
    page[sentinel % pageBytes] = 0;
  }
  pages.set(coordinate, page);
}
for (let index = 0; index <= Math.floor(targetBytes / pageBytes); index += 1) {
  pages.set(target + BigInt(index * pageBytes), new Uint8Array(pageBytes));
}

const result = executeVirtualStateStepLoaded(
  decode(encodedPage),
  [source, 0n, target + BigInt(targetBytes), 0n, 0n, 0n,
    0xffffffffn, target, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 2n],
  [],
  (address, width) => {
    const coordinate = BigInt(address);
    if (Number(width) !== pageBytes || !pages.has(coordinate)) {
      throw new Error(`vm.wasm requested an unknown copy page ${address}`);
    }
    reads.push(coordinate);
    return encode(pages.get(coordinate));
  },
  (address, encoded) => {
    const coordinate = BigInt(address);
    writes.push(coordinate);
    pages.set(coordinate, decode(encoded));
  },
);

if (result.locals[6] !== BigInt(sentinel)
    || result.locals[7] !== target + BigInt(sentinel)
    || result.locals[8] !== target + BigInt(sentinel)
    || result.locals[9] !== BigInt(sentinel)
    || result.locals[10] !== 0n
    || (result.locals[16] & 0x40n) === 0n) {
  throw new Error('bounded copy published the wrong terminal state');
}
for (let offset = 0; offset < targetBytes; offset += 1) {
  const coordinate = target + BigInt(offset);
  const page = coordinate & ~0xfffn;
  if (pages.get(page)?.[Number(coordinate & 0xfffn)] !== 'a'.charCodeAt(0)) {
    throw new Error(`bounded copy mismatch at byte ${offset}`);
  }
}
const firstUnwritten = target + BigInt(targetBytes);
if (pages.get(firstUnwritten & ~0xfffn)[Number(firstUnwritten & 0xfffn)] !== 0) {
  throw new Error('bounded copy wrote beyond its destination extent');
}
if (result.work !== 5 || result.span !== 4
    || new Set(reads).size !== 10 || new Set(writes).size !== 4) {
  throw new Error('bounded copy escaped its persistent physical cut');
}

console.log(JSON.stringify({
  work: result.work,
  span: result.span,
  scannedBytes: sentinel + 1,
  copiedBytes: targetBytes,
  readPages: new Set(reads).size,
  dirtyPages: new Set(writes).size,
}));
release();
