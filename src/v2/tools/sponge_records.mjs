import { readFileSync } from 'node:fs';

const wasm = process.argv[2] || new URL('../web/vm.wasm', import.meta.url);
const request = JSON.parse(readFileSync(0, 'utf8'));
const decode = (value) => Uint8Array.from(Buffer.from(value, 'base64'));
const encode = (value) => Buffer.from(value).toString('base64');
const { instance } = await WebAssembly.instantiate(readFileSync(wasm), {});
const E = instance.exports;
const memory = new Uint8Array(E.memory.buffer);
const lanes = decode(request.lanes);
const tail = decode(request.tail);
const seed = decode(request.seed);
const records = decode(request.records);
if (lanes.length !== 200 || tail.length >= 136 || seed.length !== 32
    || records.length % 24) {
  throw new Error('invalid sponge residual input');
}
const lanesAt = E.vm_sponge_lanes();
const tailAt = E.vm_sponge_tail();
const inputAt = E.vm_buffer();
memory.set(lanes, lanesAt);
memory.set(tail, tailAt);
memory.set(seed, inputAt);
memory.set(records, inputAt + 32);
if (!E.vm_set_sponge_tail_size(tail.length)
    || !E.vm_sponge_records(records.length / 24, Number(request.rounds))) {
  throw new Error('vm.wasm rejected the sponge residual');
}
const tailSize = E.vm_sponge_tail_size();
process.stdout.write(JSON.stringify({
  lanes: encode(memory.slice(lanesAt, lanesAt + 200)),
  tail: encode(memory.slice(tailAt, tailAt + tailSize)),
}));
