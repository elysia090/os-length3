// Hardware-visible quotient/remainder and #DE; undefined flags use a declared representative.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-divide.mjs VM.WASM COMPILER.WASM DIVIDE-FIXTURE-DIRECTORY');
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
let parity = 0, comparisons = 0, directComparisons = 0, faults = 0, refusals = 0;
let wideAlgebraComparisons = 0;
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
  put(port+16,1234); view.setUint32(port+24,13,true); view.setUint32(port+28,99,true);
  view.setUint32(segments,1,true); view.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directoryAt,5,5,directoryAt+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry); view.setUint32(rows+8,meta.sourceBytes,true); view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
try {
  const forms=(await readdir(directory)).filter(name => /^divide-\d+\.json$/.test(name))
    .map(name => Number(name.slice(7,-5))).sort((a,b)=>a-b);
  assert(forms.length === 24 || forms.length === 32,'complete declared width matrix is required');
  assert.deepEqual(forms,Array.from({length:forms.length},(_,rank)=>rank));
  for (const form of forms) {
    const prefix = path.join(directory,`divide-${form}`), source = await readFile(`${prefix}.source-page`);
    const meta = JSON.parse(await readFile(`${prefix}.json`)), emitted = await readFile(`${prefix}.wasm`);
    const native = await readFile(`${prefix}.cases`); assert.equal(native.length,512*stride);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
    const module = await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
    const cut = (await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for (let row = 0; row < 512; ++row) {
      const record = native.subarray(row*stride,(row+1)*stride), fault = !!u64(record,34);
      reset(source,meta,record); const expected = cpu(), payload = Buffer.from(data.subarray(code,code+4096));
      for (let rank = 0; rank < 16; ++rank) expected.writeBigUInt64LE(u64(record,17+rank),rank*8);
      // Only defined native flags are an oracle; the selected undefined bits preserve incoming values.
      assert.equal((u64(record,33)^u64(record,16)) & (fault ? ~0n : ~0x8d5n),0n);
      expected.writeBigUInt64LE(fault ? entry : entry+BigInt(meta.sourceBytes),384);
      if (!fault) expected.writeBigUInt64LE(43n,1128);
      assert.equal(vm.vm_run(port,9n,1),fault ? 3n : 1n,`${form}/${row}: C dispatch`);
      assert(data.subarray(base,base+1256).equals(expected),`${form}/${row}: complete CPU / declared undefined flags`);
      assert(data.subarray(code,code+4096).equals(payload));
      assert.equal(vm.vm_completed(),fault ? 0 : 1); assert.equal(vm.vm_source_retired(),fault ? 0n : 1n);
      if (fault) {
        assert.equal(view.getBigUint64(port+16,true),entry);
        assert.equal(view.getUint32(port+24,true),0); assert.equal(view.getUint32(port+28,true),0); ++faults;
      }
      ++comparisons; reset(source,meta,record);
      assert.equal(cut(base,port),fault ? 3n : 1n,`${form}/${row}: direct`);
      assert(data.subarray(base,base+1256).equals(expected));
      assert(data.subarray(code,code+4096).equals(payload)); ++directComparisons;
      reset(source,meta,record); put(base+392,u64(record,16)|0x10000n);
      assert.equal(vm.vm_run(port,9n,1),fault ? 3n : 1n);
      assert.equal(view.getBigUint64(base+392,true),u64(record,16)|(fault ? 0x10000n : 0n));
    }
    const record = native.subarray(0,stride);
    for (const failure of ['TF','alias','unaligned','wrap','stale']) {
      reset(source,meta,record);
      if (failure === 'TF') put(base+392,u64(record,16)|256n);
      if (failure === 'stale') put(port,8);
      const before = cpu(), frontier = Buffer.from(data.subarray(port,port+72));
      assert.equal(failure === 'stale' ? vm.vm_run(port,9n,1)
        : cut(base,failure === 'alias' ? base : failure === 'unaligned' ? port+1 : failure === 'wrap' ? 0xfffffff8 : port),
        failure === 'stale' ? 5n : 6n);
      assert(data.subarray(base,base+1256).equals(before));
      if (failure !== 'stale') assert(data.subarray(port,port+72).equals(frontier)); ++refusals;
    }
    if (form === 24 || form === 28) {
      // Independent unbounded-integer test oracle, never a product runtime.
      // Stress the restoring step's 65th-bit carry and exact signed limits,
      // in addition to the actual x86 observations above.
      const signed = form === 28, mask = (1n<<64n)-1n, sign = 1n<<63n;
      const divisors = [0n,1n,2n,127n,128n,32767n,sign-1n,sign,mask-1n,mask];
      function algebra(numerator,rawDivisor) {
        const n = signed ? BigInt.asIntN(128,numerator) : BigInt.asUintN(128,numerator);
        const d = signed ? BigInt.asIntN(64,rawDivisor) : BigInt.asUintN(64,rawDivisor);
        const quotient = d ? n/d : 0n, remainder = d ? n%d : 0n;
        const fault = !d || quotient < (signed ? -sign : 0n) || quotient > (signed ? sign-1n : mask);
        const sample = Buffer.from(record);
        sample.writeBigUInt64LE(BigInt.asUintN(64,n),0);
        sample.writeBigUInt64LE(BigInt.asUintN(64,n>>64n),2*8);
        sample.writeBigUInt64LE(BigInt.asUintN(64,d),12*8);
        sample.writeBigUInt64LE(0x10202n,16*8); // Incoming RF survives #DE only.
        reset(source,meta,sample); const expected = cpu();
        if (!fault) {
          expected.writeBigUInt64LE(BigInt.asUintN(64,quotient),0);
          expected.writeBigUInt64LE(BigInt.asUintN(64,remainder),16);
          expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);
          expected.writeBigUInt64LE(0x202n,392); expected.writeBigUInt64LE(43n,1128);
        }
        assert.equal(vm.vm_run(port,9n,1),fault ? 3n : 1n,`wide algebra: ${n}/${d}`);
        assert(data.subarray(base,base+1256).equals(expected));
        assert.equal(vm.vm_completed(),fault ? 0 : 1); assert.equal(vm.vm_source_retired(),fault ? 0n : 1n);
        if (fault) {
          assert.equal(view.getBigUint64(port+16,true),entry);
          assert.equal(view.getUint32(port+24,true),0); assert.equal(view.getUint32(port+28,true),0);
        }
        reset(source,meta,sample); assert.equal(cut(base,port),fault ? 3n : 1n);
        assert(data.subarray(base,base+1256).equals(expected)); ++wideAlgebraComparisons;
      }
      for (const d of divisors) {
        for (const h of [0n,1n,BigInt.asUintN(64,d-1n),d,sign,mask])
          for (const l of [0n,1n,2n,sign-1n,sign,mask]) algebra((h<<64n)|l,d);
        const divisor = signed ? BigInt.asIntN(64,d) : d;
        const magnitude = divisor < 0n ? -divisor : divisor;
        for (const q of (signed ? [-sign-1n,-sign,-sign+1n,-1n,0n,1n,sign-1n,sign,sign+1n]
          : [0n,1n,mask-1n,mask,mask+1n]))
          for (const r of [0n,magnitude ? magnitude-1n : 0n,1n-magnitude])
            algebra(divisor*q+r,d);
      }
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); cc.compiler_close(); }
console.log(JSON.stringify({format:'c-wasm-register-division-native-v1',status:'pass',parity,comparisons,directComparisons,faults,refusals,wideAlgebraComparisons,
  oracle:'actual x86 user-mode execution in reference build VM; not physical hardware',
  undefinedFlags:'incoming representative, not a hardware equality claim',linuxBoot:'not-tested',exceptionDelivery:'not-tested'},null,2));
