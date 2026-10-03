// Actual native defined outputs; the product runtime is compiled SSA only.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-implicit-multiply.mjs VM.WASM COMPILER.WASM REGISTER-DIRECTORY');
const memory = new WebAssembly.Memory({initial:8});
const vm = (await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const coldMemory = new WebAssembly.Memory({initial:16});
const cc = (await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const cold = Buffer.from(coldMemory.buffer), cv = new DataView(coldMemory.buffer);
const input = cc.compiler_arena_min(), output = input+8192, report = output+65536;
const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const directoryAt = vm.vm_arena_min(), rows = directoryAt+512, base = directoryAt+4096;
const port = base+2048, segments = base+1408, code = base+24576, entry = 0x400000n, stride = 35*8;
const slot = vm.__indirect_function_table.grow(1);
const put = (at,value) => view.setBigUint64(at,BigInt(value),true);
const u64 = (record,rank) => record.readBigUInt64LE(rank*8);
const cpu = () => Buffer.from(data.subarray(base,base+1256));
let parity = 0, comparisons = 0, directComparisons = 0, rfComparisons = 0, refusals = 0, algebraComparisons = 0;
function reset(source,meta,record) {
  data.fill(0,base);
  for (const [first,end] of [[128,384],[432,488],[496,1128],[1136,1256]]) data.fill(0x5a,base+first,base+end);
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
  const forms=(await readdir(directory)).filter(name => /^product-\d+\.json$/.test(name))
    .map(name => Number(name.slice(8,-5))).sort((a,b)=>a-b);
  assert.deepEqual(forms,Array.from({length:38},(_,rank)=>rank));
  for (const form of forms) {
    const prefix = path.join(directory,`product-${form}`), source = await readFile(`${prefix}.source-page`);
    const meta = JSON.parse(await readFile(`${prefix}.json`)), emitted = await readFile(`${prefix}.wasm`);
    const native = await readFile(`${prefix}.cases`); assert.equal(native.length,512*stride);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,meta.instructions,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
    const module = await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
    const cut = (await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for (let row = 0; row < 512; ++row) {
      const record = native.subarray(row*stride,(row+1)*stride);
      reset(source,meta,record); const expected = cpu(), payload = Buffer.from(data.subarray(code,code+4096));
      for (let rank = 0; rank < 16; ++rank) expected.writeBigUInt64LE(u64(record,17+rank),rank*8);
      expected.writeBigUInt64LE(u64(record,33),392); expected.writeBigUInt64LE(u64(record,34),384);
      expected.writeBigUInt64LE(42n+BigInt(meta.instructions),1128);
      assert.equal(vm.vm_run(port,9n,1),1n,`${form}/${row}: C dispatch`);
      assert(data.subarray(base,base+1256).equals(expected),`${form}/${row}: complete CPU`);
      assert(data.subarray(code,code+4096).equals(payload));
      assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),BigInt(meta.instructions)); ++comparisons;
      reset(source,meta,record); assert.equal(cut(base,port),1n);
      assert(data.subarray(base,base+1256).equals(expected)); ++directComparisons;
      reset(source,meta,record); put(base+392,u64(record,16)|0x10000n);
      assert.equal(vm.vm_run(port,9n,1),1n); assert(data.subarray(base,base+1256).equals(expected)); ++rfComparisons;
    }
    const record = native.subarray(0,stride);
    for (const failure of ['TF','wrong-rip','unaligned','bounds','stale']) {
      reset(source,meta,record);
      if (failure === 'TF') put(base+392,u64(record,16)|256n);
      if (failure === 'wrong-rip') put(base+384,entry+1n);
      if (failure === 'stale') put(port,8);
      const before = Buffer.from(data);
      assert.equal(failure === 'stale' ? vm.vm_run(port,9n,1)
        : cut(failure === 'unaligned' ? base+1 : failure === 'bounds' ? data.length-8 : base,port),
        failure === 'stale' ? 5n : 6n);
      assert(data.subarray(base,base+1256).equals(before.subarray(base,base+1256))); ++refusals;
    }
    if (form<32 && (form%8 === 0 || form%8 === 4)) {
      // Independent test oracle only: exact mathematical 2w-bit product.
      const width = 8 << Math.floor(form/8), w = BigInt(width), mask = (1n<<w)-1n;
      const signed = form%8 === 4, sign = 1n<<(w-1n);
      const edges = [0n,1n,2n,sign-1n,sign,sign+1n,mask-1n,mask,15n,16n,127n,128n,0xffffffffn,0x100000000n];
      for (const a of edges) for (const b of edges) {
        const sample = Buffer.from(record), low = a&mask, right = b&mask;
        sample.writeBigUInt64LE((u64(sample,0)&~mask)|low,0);
        sample.writeBigUInt64LE((u64(sample,12)&~mask)|right,12*8);
        const product = (signed ? BigInt.asIntN(width,low) : low)*(signed ? BigInt.asIntN(width,right) : right);
        const lo = product&mask, hi = (product>>w)&mask;
        const overflow = signed ? product !== BigInt.asIntN(width,lo) : hi !== 0n;
        reset(source,meta,sample); const expected = cpu();
        if (width === 8) expected.writeBigUInt64LE((u64(sample,0)&~65535n)|(product&65535n),0);
        else {
          expected.writeBigUInt64LE(width === 16 ? (u64(sample,0)&~mask)|lo : lo,0);
          expected.writeBigUInt64LE(width === 16 ? (u64(sample,2)&~mask)|hi : hi,16);
        }
        expected.writeBigUInt64LE((u64(sample,16)&~0x801n)|(overflow ? 0x801n : 0n),392);
        expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384); expected.writeBigUInt64LE(43n,1128);
        assert.equal(vm.vm_run(port,9n,1),1n); assert(data.subarray(base,base+1256).equals(expected));
        ++algebraComparisons;
      }
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); cc.compiler_close(); }
console.log(JSON.stringify({format:'c-wasm-implicit-product-native-v1',status:'pass',parity,comparisons,directComparisons,rfComparisons,refusals,algebraComparisons,
  oracle:'actual x86 user-mode execution in reference build VM; not physical hardware',
  undefinedFlags:'incoming representative, not a hardware equality claim',linuxBoot:'not-tested'},null,2));
