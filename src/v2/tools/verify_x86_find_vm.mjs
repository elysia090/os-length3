import { readFileSync } from 'node:fs';

import {
  executeVirtualStateStepLoaded,
  load,
  release,
} from '../web/vm.js';

const [wasmPath, encodedPage] = process.argv.slice(2);
if (!wasmPath || !encodedPage) {
  throw new Error('usage: verify_x86_find_vm.mjs VM_WASM STEP_BASE64');
}

const decode = value => Uint8Array.from(Buffer.from(String(value), 'base64'));
const encode = value => Buffer.from(value).toString('base64');
const module = await WebAssembly.compile(readFileSync(wasmPath));
await load(module);

const pageBytes = 4096;
const firstPage = 0xffff800000200000n;
const sentinelOffset = 5 * pageBytes + 123;
const sentinelPage = Math.floor(sentinelOffset / pageBytes);
const pages = new Map();
const reads = [];
const writes = [];

for (let index = 0; index <= sentinelPage; index += 1) {
  const coordinate = firstPage + BigInt(index * pageBytes);
  const page = new Uint8Array(pageBytes).fill('a'.charCodeAt(0));
  if (index === sentinelPage) {
    page[sentinelOffset % pageBytes] = '%'.charCodeAt(0);
  }
  pages.set(coordinate, page);
}

const result = executeVirtualStateStepLoaded(
  decode(encodedPage),
  [0n, 0n, 0n, 0n, 0n, 0n, 0n, firstPage,
    0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 2n],
  [],
  (address, width) => {
    const coordinate = BigInt(address);
    if (Number(width) !== pageBytes || !pages.has(coordinate)) {
      throw new Error('vm.wasm requested a noncanonical find page');
    }
    reads.push(coordinate);
    return encode(pages.get(coordinate));
  },
  (address) => {
    writes.push(BigInt(address));
  },
);

if (result.locals[1] !== BigInt(sentinelOffset)
    || result.locals[6] !== BigInt('%'.charCodeAt(0))
    || (result.locals[16] & 0x40n) === 0n) {
  throw new Error('byte find published the wrong terminal state');
}
if (result.work !== 6 || result.span !== 4
    || reads.length !== sentinelPage + 1 || writes.length !== 0) {
  throw new Error('byte find escaped its persistent physical cut');
}

console.log(JSON.stringify({
  work: result.work,
  span: result.span,
  bytes: sentinelOffset + 1,
  pages: reads.length,
  writes: writes.length,
}));
release();
