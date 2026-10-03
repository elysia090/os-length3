// Actual x86 observations -> native/cold C byte parity -> direct and C-dispatched Wasm.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-extend.mjs VM.WASM COMPILER.WASM EXTEND-FIXTURE-DIRECTORY');
const memory = new WebAssembly.Memory({initial:8});
const vm = (await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const coldMemory = new WebAssembly.Memory({initial:16});
const cc = (await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const cold = Buffer.from(coldMemory.buffer), cv = new DataView(coldMemory.buffer);
const input = cc.compiler_arena_min(), output = input+8192, report = output+65536;
const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const directoryAt = vm.vm_arena_min(), rows = directoryAt+512, base = directoryAt+4096;
const port = base+2048, segments = base+1408, code = base+24576, entry = 0x400000n, stride = 34*8;
const slot = vm.__indirect_function_table.grow(1);
const put = (at,value) => view.setBigUint64(at,BigInt(value),true);
const u64 = (record,rank) => record.readBigUInt64LE(rank*8);
const cpu = () => Buffer.from(data.subarray(base,base+1256));
let parity = 0, comparisons = 0, directComparisons = 0, refusals = 0;
function reset(source,meta,record) {
  data.fill(0,base);
  for (const [first,end] of [[128,384],[432,488],[496,1128],[1136,1256]]) data.fill(0x5a,base+first,base+end);
  seedDisabledDebug(view, base);
  for (const [rank,address] of [0x1000,0x2000,0x3000,0x4000,0x8000].entries()) {
    const at = directoryAt+rank*32; put(at,address); view.setUint32(at+8,(rank+2)*4096,true);
    view.setUint32(at+12,3,true); view.setUint32(at+16,1,true); data.fill(0,at+20,at+32);
  }
  put(base+8192,0x2067); put(base+12288,0x3067); put(base+16384+2*8,0x4067); put(base+20480,0x8067);
  data.set(source,code);
  for (let rank = 0; rank < 17; ++rank) put(base+(rank === 16 ? 392 : rank*8),u64(record,rank));
  put(base+384,entry); put(base+1128,42); put(base+400,0x80010011); put(base+408,0x1000);
  put(base+416,32); put(base+424,0xd00); put(base+488,19); put(port,9);
  view.setUint32(segments,1,true); view.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directoryAt,5,5,directoryAt+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry); view.setUint32(rows+8,meta.sourceBytes,true); view.setUint32(rows+12,meta.instructions,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
try {
  for (let form = 0; form < 18; ++form) {
    const prefix = path.join(directory,`extend-${form}`), source = await readFile(`${prefix}.source-page`);
    const meta = JSON.parse(await readFile(`${prefix}.json`)), emitted = await readFile(`${prefix}.wasm`);
    const native = await readFile(`${prefix}.cases`); assert.equal(native.length,256*stride);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,meta.instructions,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
    const module = await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
    const cut = (await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for (let row = 0; row < 256; ++row) {
      const record = native.subarray(row*stride,(row+1)*stride);
      reset(source,meta,record); const expected = cpu(), payload = Buffer.from(data.subarray(code,code+4096));
      for (let rank = 0; rank < 16; ++rank) expected.writeBigUInt64LE(u64(record,17+rank),rank*8);
      expected.writeBigUInt64LE(u64(record,33),392); expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);
      expected.writeBigUInt64LE(42n+BigInt(meta.instructions),1128);
      assert.equal(vm.vm_run(port,9n,1),1n,`${form}/${row}: C dispatch`);
      assert(data.subarray(base,base+1256).equals(expected),`${form}/${row}: complete CPU`);
      assert(data.subarray(code,code+4096).equals(payload));
      assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),BigInt(meta.instructions)); ++comparisons;
      reset(source,meta,record);
      assert.equal(cut(base,port),1n,`${form}/${row}: direct`);
      assert(data.subarray(base,base+1256).equals(expected),`${form}/${row}: direct complete CPU`);
      assert(data.subarray(code,code+4096).equals(payload)); ++directComparisons;
    }
    const record = native.subarray(0,stride);
    for (const failure of ['TF','unaligned','wrap','stale']) {
      reset(source,meta,record);
      if (failure === 'TF') put(base+392,u64(record,16)|256n);
      if (failure === 'stale') put(port,8);
      const before = cpu();
      assert.equal(failure === 'stale' ? vm.vm_run(port,9n,1)
        : cut(failure === 'unaligned' ? base+1 : failure === 'wrap' ? 0xfffffff8 : base,port),failure === 'stale' ? 5n : 6n);
      assert(data.subarray(base,base+1256).equals(before)); ++refusals;
    }
    reset(source,meta,record); put(base+392,u64(record,16)|0x10000n);
    assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(view.getBigUint64(base+392,true),u64(record,16));
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); cc.compiler_close(); }
console.log(JSON.stringify({format:'c-wasm-sign-extension-native-v1',status:'pass',parity,comparisons,directComparisons,refusals,
  oracle:'actual x86 user-mode execution in reference build VM; not physical hardware',linuxBoot:'not-tested'},null,2));
