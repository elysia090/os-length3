import { readFileSync } from 'node:fs';

import {
  executeVirtualStateStepLoaded,
  load,
  release,
} from '../web/vm.js';

const [wasmPath, encodedPage] = process.argv.slice(2);
if (!wasmPath || !encodedPage) {
  throw new Error('usage: verify_x86_vm.mjs VM_WASM STEP_BASE64');
}

const decode = value => Uint8Array.from(Buffer.from(String(value), 'base64'));
const encode = value => Buffer.from(value).toString('base64');
const module = await WebAssembly.compile(readFileSync(wasmPath));
await load(module);

const page = decode(encodedPage);
const virtualPage = 0xffff800000000000n;
const bytes = new Uint8Array(4096);
new DataView(bytes.buffer).setBigUint64(0x400, 41n, true);
const reads = [];
const writes = [];
const result = executeVirtualStateStepLoaded(
  page,
  [0n, 0n, 0n, virtualPage + 0x400n,
    0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 2n],
  [],
  (address, width) => {
    reads.push([String(address), Number(width)]);
    if (BigInt(address) !== virtualPage || Number(width) !== bytes.length) {
      throw new Error('vm.wasm requested the wrong x86 virtual page');
    }
    return encode(bytes);
  },
  (address, encoded) => {
    writes.push(String(address));
    if (BigInt(address) !== virtualPage) {
      throw new Error(`vm.wasm dirtied the wrong x86 virtual page ${address}`);
    }
    bytes.set(decode(encoded));
  },
);

const view = new DataView(bytes.buffer);
if (result.locals[0] !== 42n || view.getBigUint64(0x408, true) !== 42n) {
  throw new Error('x86 virtual state page produced the wrong cut');
}
if (result.work !== 5 || result.span !== 3 || reads.length !== 1
    || writes.length !== 1) {
  throw new Error('x86 virtual state page escaped its canonical cost');
}
console.log(JSON.stringify({
  work: result.work,
  span: result.span,
  reads,
  writes,
}));
release();
