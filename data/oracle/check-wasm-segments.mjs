// Generated MOV-to-segment cuts through the actual C-Wasm descriptor boundary.
// Independent descriptor/privilege expectations, not a hardware fault oracle.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [providerFile, prefix] = process.argv.slice(2);
if (!providerFile || !prefix) throw new Error('usage: check-wasm-segments.mjs VM.WASM SHIPPED-CODE-PREFIX');
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const vm = (await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const directory = vm.vm_arena_min(), base = directory + 4096;
const segments = base + 1408, port = base + 2048;
const bytes = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const cuts = new Map();
for (const [rank, index] of [[0,4],[2,5],[3,3],[4,6],[5,7]]) {
  const meta = JSON.parse(await readFile(`${prefix}.${index}.json`,'utf8'));
  const module = await WebAssembly.compile(await readFile(`${prefix}.${index}.wasm`));
  assert.deepEqual(WebAssembly.Module.imports(module),[
    {module:'machine',name:'memory',kind:'memory'},
    {module:'machine',name:'segment',kind:'function'},
  ]);
  const fn = (await WebAssembly.instantiate(module,{machine:{memory,segment:vm.vm_segment}})).exports.cut;
  cuts.set(rank,{fn,entry:BigInt(meta.entry),next:BigInt(meta.continuation)});
}
for (let i = 0; i < 4; ++i) {
  const at = directory + i * 32;
  view.setBigUint64(at,BigInt((i + 1) * 4096),true);
  view.setUint32(at + 8,(i + 2) * 4096,true);
  view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true);
}
assert.equal(vm.vm_open(base,bytes.length - base,4096,directory,4,4,directory + 1024,9n),0);
function reset(cpl,rank,selector) {
  bytes.fill(0,base,base + 1256); bytes.fill(0,segments,segments + 136); bytes.fill(0,port,port + 48);
  // The caller's source register must survive even when its upper bits are not
  // part of the selector; flags and every unrelated register stay unchanged.
  view.setBigUint64(base,0xabcdeffedcba0000n | BigInt(selector),true);
  view.setBigUint64(base + 384,cuts.get(rank).entry,true);
  view.setBigUint64(base + 392,0x8d7n,true);
  view.setBigUint64(base + 400,0x80010001n,true);
  view.setBigUint64(base + 408,0x1000n,true);
  view.setBigUint64(base + 416,32n,true); view.setBigUint64(base + 424,0x500n,true);
  view.setBigUint64(base + 448,0x4000n,true); view.setBigUint64(base + 456,31n,true);
  view.setBigUint64(base + 488,BigInt(16 | cpl),true);
  view.setUint32(segments,1,true);
  view.setUint32(segments + 8 + 16 + 12,0xa09b | (cpl << 5),true);
  for (const segment of [0,2,3,4,5,6,7]) {
    view.setBigUint64(segments + 8 + segment * 16,0xabcdefn,true);
    view.setUint32(segments + 8 + segment * 16 + 8,123,true);
    view.setUint32(segments + 8 + segment * 16 + 12,0x10000,true);
  }
  view.setBigUint64(port,9n,true);
  view.setBigUint64(base + 8192,0x2027n,true);
  view.setBigUint64(base + 12288,0x3027n,true);
  view.setBigUint64(base + 16384,0xe7n,true);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
}
let comparisons = 0;
function check(rank,selector,vector,baseAddress,limit,attributes) {
  const savedState = bytes.subarray(base,base + 1256).slice();
  const savedSegments = bytes.subarray(segments,segments + 136).slice();
  const {fn,next} = cuts.get(rank);
  assert.equal(fn(base,port),vector ? BigInt(vector * 8 + 3) : 1n);
  if (vector) {
    assert.deepEqual(bytes.subarray(base,base + 1256),savedState);
    assert.deepEqual(bytes.subarray(segments,segments + 136),savedSegments);
    assert.equal(view.getUint32(port + 24,true),vector);
    assert.equal(view.getUint32(port + 28,true),selector < 4 ? 0 : selector & 0xfffc);
  } else {
    savedState.writeBigUInt64LE(BigInt(selector),432 + (6 + rank) * 8);
    savedState.writeBigUInt64LE(next,384); savedState.writeBigUInt64LE(1n,1128);
    savedSegments.writeBigUInt64LE(baseAddress,8 + rank * 16);
    savedSegments.writeUInt32LE(limit,8 + rank * 16 + 8);
    savedSegments.writeUInt32LE(attributes,8 + rank * 16 + 12);
    if (rank === 2) savedSegments.writeUInt32LE(1,4);
    assert.deepEqual(bytes.subarray(base,base + 1256),savedState);
    assert.deepEqual(bytes.subarray(segments,segments + 136),savedSegments);
  }
  ++comparisons;
}
for (let cpl = 0; cpl < 4; ++cpl)
for (let selector = 0; selector < 4; ++selector)
for (const rank of [0,2,3,4,5]) {
  reset(cpl,rank,selector);
  const vector = rank === 2 && (cpl === 3 || selector !== cpl) ? 13 : 0;
  check(rank,selector,vector,0n,0,0x10000 | (rank === 2 ? cpl << 5 : 0));
}
for (let cpl = 0; cpl < 4; ++cpl)
for (let rpl = 0; rpl < 4; ++rpl)
for (let dpl = 0; dpl < 4; ++dpl)
for (let type = 0; type < 32; ++type)
for (let present = 0; present < 2; ++present)
for (const rank of [2,3]) {
  const selector = 24 | rpl, access = type | dpl * 32 | present * 128;
  reset(cpl,rank,selector);
  const descriptor = 0x12ca00345678bcddn | BigInt(access) << 40n;
  view.setBigUint64(base + 20480 + 24,descriptor,true);
  const code = Boolean(type & 8), conforming = code && Boolean(type & 4);
  const invalid = !(type & 16) || (rank === 2
    ? code || !(type & 2) || rpl !== cpl || dpl !== cpl
    : code && !(type & 2) || !conforming && (cpl > dpl || rpl > dpl));
  const vector = invalid ? 13 : !present ? rank === 2 ? 12 : 11 : 0;
  check(rank,selector,vector,0x12345678n,0xabcddfff,0xc000 | access | 1);
  assert.equal(view.getBigUint64(base + 20480 + 24,true),vector ? descriptor : descriptor | 1n << 40n);
}
assert.equal(comparisons,8272);
console.log(`Generated segment cuts / actual C-Wasm: green (${comparisons} independent model cases; not hardware exception entry or Linux boot)`);
