// Privileged specification matrix, not a native CPL0/hardware fault oracle.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-control-read.mjs CONTROL-FIXTURE-DIRECTORY');
const offsets = {0:400,2:432,3:408,4:416,8:440};
const names = (await readdir(directory)).filter(name => /^control-\d+-\d+\.json$/.test(name));
assert.equal(names.length,80);
let cases = 0;
for (const name of names) {
  const prefix = path.join(directory,name.slice(0,-5)), meta = JSON.parse(await readFile(`${prefix}.json`));
  const module = await WebAssembly.compile(await readFile(`${prefix}.wasm`));
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
  const memory = new WebAssembly.Memory({initial:2});
  const cut = (await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
  const bytes = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
  const state = 4096, port = 8192;
  for (let cpl = 0; cpl < 4; ++cpl) for (let sample = 0; sample < 16; ++sample) {
    bytes.fill(0,state,state + 1256); bytes.fill(0,port,port + 48);
    for (let reg = 0; reg < 16; ++reg) view.setBigUint64(state + reg * 8,0x12340000n + BigInt(reg),true);
    const value = meta.control === 8 ? BigInt(sample)
      : BigInt.asUintN(64,0x80000000000000ffn * BigInt(sample));
    const flags = 2n | BigInt(sample & 7) | (sample & 8 ? 0x200n : 0n);
    view.setBigUint64(state + offsets[meta.control],value,true);
    view.setBigUint64(state + 384,BigInt(meta.entry),true); view.setBigUint64(state + 392,flags,true);
    view.setBigUint64(state + 488,16n | BigInt(cpl),true); view.setBigUint64(state + 1128,42n,true);
    const expected = Buffer.from(bytes.subarray(state,state + 1256));
    if (cpl) {
      assert.equal(cut(state,port),107n);
      assert.equal(view.getBigUint64(port + 16,true),BigInt(meta.entry));
      assert.equal(view.getUint32(port + 24,true),13); assert.equal(view.getUint32(port + 28,true),0);
    } else {
      assert.equal(cut(state,port),1n);
      expected.writeBigUInt64LE(value,meta.reg * 8);
      expected.writeBigUInt64LE(BigInt(meta.entry) + BigInt(meta.sourceBytes),384);
      expected.writeBigUInt64LE(43n,1128);
    }
    assert(bytes.subarray(state,state + 1256).equals(expected)); ++cases;
  }
  for (const flag of [0x100n,0x10000n,0x20000n]) {
    view.setBigUint64(state + 384,BigInt(meta.entry),true);
    view.setBigUint64(state + 392,2n | flag,true);
    view.setBigUint64(state + 488,16n,true);
    const before = Buffer.from(bytes.subarray(state,state + 1256));
    assert.equal(cut(state,port),6n);
    assert(bytes.subarray(state,state + 1256).equals(before)); ++cases;
  }
}
console.log(`Compiled control reads: ${names.length} modules / ${cases} privilege/value model cases green; NOT hardware exception entry or Linux boot`);
