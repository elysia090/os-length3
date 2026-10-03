// Native fault frames and complete CPU/RAM receipts -> cold C -> actual C-MMU.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-pop-memory.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
const memory = new WebAssembly.Memory({initial:8});
const vm = (await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cm = new WebAssembly.Memory({initial:16});
const cc = (await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const cold = Buffer.from(cm.buffer), cv = new DataView(cm.buffer), input = cc.compiler_arena_min();
const output = input+8192, report = output+65536;
const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const directoryAt = vm.vm_arena_min(), rows = directoryAt+512, base = directoryAt+4096;
const port = base+2048, segments = base+1408, entry = 0x400000n, stride = 40*8;
const addresses = [0x12340000n,0x23450000n,0x200012340000n];
const payloads = [10,12,14].map(rank => base+(rank+1)*4096), code = base+40960;
const at = physical => base+(Number(physical/4096n)+1)*4096;
const put = (where,value) => view.setBigUint64(where,BigInt(value),true);
const u64 = (record,rank) => record.readBigUInt64LE(rank*8);
const slot = vm.__indirect_function_table.grow(1);
let comparisons = 0, directComparisons = 0, faults = 0, parity = 0, refusals = 0, waits = 0, retries = 0, rf = 0;
const cpu = () => Buffer.from(data.subarray(base,base+1256));
const payload = () => Buffer.from(data.subarray(code,base+65536));
function reset(source,meta,record,row) {
  data.fill(0,base);
  for (const [first,end] of [[128,384],[432,488],[496,1128],[1136,1256]]) data.fill(0x5a,base+first,base+end);
  seedDisabledDebug(view, base);
  for (let i = 0; i < 16; ++i) {
    const where = directoryAt+i*32; put(where,(i+1)*4096); view.setUint32(where+8,(i+2)*4096,true);
    view.setUint32(where+12,3,true); view.setUint32(where+16,1,true); data.fill(0,where+20,where+32);
  }
  put(at(0x1000n),0x2067); put(at(0x2000n),0x3067);
  put(at(0x1000n)+Number(addresses[2]>>39n&511n)*8,0x10067); put(at(0x10000n),0x7067);
  put(at(0x3000n)+2*8,0x4067); put(at(0x3000n)+145*8,0x5067);
  put(at(0x3000n)+282*8,0x6067); put(at(0x7000n)+145*8,0x8067);
  put(at(0x4000n),0x9067);
  for (let owner = 0; owner < 3; ++owner) {
    const table = [0x5000n,0x6000n,0x8000n][owner];
    for (let page = 0; page < 2; ++page) {
      let rights = 103n;
      if (owner === 0 && row%16 === 3 && page === 1) rights = 0n;
      if (owner === 0 && row%16 === 8) rights = 101n;
      if (owner === 1 && row%16 === 4 && page === 1) rights = 101n;
      if (owner === 1 && row%16 === 9 && page === 1) rights = 0n;
      put(at(table)+(Number(addresses[owner]>>12n&511n)+page)*8,
        rights ? BigInt((10+owner*2+page)*4096)|rights : 0n);
    }
    for (let byte = 0; byte < 8192; ++byte) data[payloads[owner]+byte] = (byte*37+row+owner*91)&255;
  }
  data.set(source,code);
  for (let reg = 0; reg < 17; ++reg) put(base+(reg === 16 ? 392 : reg*8),u64(record,reg));
  put(base+384,entry); put(base+1128,42); put(base+400,0x80010011); put(base+408,0x1000);
  put(base+416,32); put(base+424,0xd00); put(base+488,19); put(port,9);
  view.setUint32(segments,1,true); view.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directoryAt,16,16,directoryAt+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry); view.setUint32(rows+8,meta.sourceBytes,true); view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
try {
  for (let form = 0; form < 24; ++form) {
    const prefix = path.join(directory,`pop-memory-${form}`), source = await readFile(`${prefix}.source-page`);
    const meta = JSON.parse(await readFile(`${prefix}.json`)), emitted = await readFile(`${prefix}.wasm`);
    const native = await readFile(`${prefix}.cases`); assert.equal(native.length,256*stride);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
    const module = await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[
      {module:'machine',name:'memory',kind:'memory'},{module:'machine',name:'access',kind:'function'}]);
    const cut = (await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for (let row = 0; row < 256; ++row) {
      const record = native.subarray(row*stride,(row+1)*stride), vector = u64(record,35);
      reset(source,meta,record,row); const expected = cpu(), bytes = payload();
      for (let reg = 0; reg < 16; ++reg) expected.writeBigUInt64LE(u64(record,17+reg),reg*8);
      expected.writeBigUInt64LE(u64(record,33),392); expected.writeBigUInt64LE(u64(record,34),384);
      if (!vector) {
        expected.writeBigUInt64LE(43n,1128);
        const destination = u64(record,38), value = u64(record,39);
        const owner = addresses.findIndex(address => destination >= address && destination+BigInt(meta.bytes) <= address+8192n);
        const where = owner < 0 ? code+2048 : payloads[owner]+Number(destination-addresses[owner]);
        for (let byte = 0; byte < meta.bytes; ++byte) bytes[where-code+byte] = Number(value >> BigInt(byte*8)&255n);
      }
      const result = vector ? vector<<3n|3n : 1n;
      // A successful payload write retires once, then revokes the bound row
      // before any next dispatch. Direct invocation has no dispatcher token.
      assert.equal(vm.vm_run(port,9n,1),vector ? result : 5n,`${form}/${row}: result`);
      assert(data.subarray(base,base+1256).equals(expected),`${form}/${row}: complete CPU`);
      assert(data.subarray(code,base+65536).equals(bytes),`${form}/${row}: complete payload`);
      assert.equal(vm.vm_completed(),vector ? 0 : 1); assert.equal(vm.vm_source_retired(),vector ? 0n : 1n);
      if (vector) {
        assert.equal(view.getUint32(port+24,true),Number(vector));
        assert.equal(view.getUint32(port+28,true),Number(u64(record,36)));
        assert.equal(view.getBigUint64(port+16,true),u64(record,37)); ++faults;
      }
      ++comparisons;
      reset(source,meta,record,row); const hidden = Buffer.from(data.subarray(segments,segments+136));
      assert.equal(cut(base,port),result,`${form}/${row}: direct result`);
      assert(data.subarray(base,base+1256).equals(expected)); assert(data.subarray(code,base+65536).equals(bytes));
      assert(data.subarray(segments,segments+136).equals(hidden)); ++directComparisons;
      reset(source,meta,record,row); put(base+392,u64(record,16)|0x10000n);
      const rfExpected = Buffer.from(expected);
      if (vector) rfExpected.writeBigUInt64LE(u64(record,16)|0x10000n,392);
      assert.equal(cut(base,port),result);
      assert(data.subarray(base,base+1256).equals(rfExpected)); assert(data.subarray(code,base+65536).equals(bytes)); ++rf;
    }
    const record = native.subarray(0,stride);
    for (const failure of ['TF','AC','alias','wrap','stale']) {
      reset(source,meta,record,0);
      if (failure === 'TF' || failure === 'AC') put(base+392,0x202n|(failure === 'TF' ? 256n : 262144n));
      if (failure === 'stale') put(port,8);
      const before = cpu(), bytes = payload();
      assert.equal(cut(base,failure === 'alias' ? base : failure === 'wrap' ? 0xfffffff8 : port),failure === 'stale' ? 5n : 6n);
      assert(data.subarray(base,base+1256).equals(before)); assert(data.subarray(code,base+65536).equals(bytes)); ++refusals;
    }
    for (const missing of ['stack','destination']) {
      if (missing === 'destination' && form >= 22) continue; // Same physical read/write owner.
      reset(source,meta,record,0);
      const table = missing === 'stack' ? 0x5000n : meta.kind === 4 ? 0x4000n : meta.kind === 0 ? 0x5000n : 0x6000n;
      const owner = table === 0x4000n ? entry : table === 0x6000n ? addresses[1] : addresses[0];
      let leaf = Number(owner>>12n&511n);
      if (missing === 'destination' && meta.kind === 0) {
        put(base+32,addresses[0]+4096n-BigInt(meta.bytes)); ++leaf;
      }
      const original = view.getBigUint64(at(table)+leaf*8,true);
      put(at(table)+leaf*8,0x11067); const before = cpu(), bytes = payload();
      assert.equal(cut(base,port),2n,`${form}: physical ${missing} wait`);
      assert(data.subarray(base,base+1256).equals(before)); assert(data.subarray(code,base+65536).equals(bytes));
      assert.equal(view.getBigUint64(port+32,true)&~4095n,0x11000n);
      assert.equal(view.getUint32(port+44,true)&3,missing === 'stack' ? 1 : 2);
      ++waits;
      put(at(table)+leaf*8,original);
      const rsp = view.getBigUint64(base+32,true);
      const destination = missing === 'destination' && meta.kind === 0 ? rsp+BigInt(meta.bytes) : u64(record,38);
      const value = view.getBigUint64(payloads[0]+Number(rsp-addresses[0]),true);
      const ownerAt = addresses.findIndex(address => destination >= address && destination+BigInt(meta.bytes) <= address+8192n);
      const target = ownerAt < 0 ? code+2048 : payloads[ownerAt]+Number(destination-addresses[ownerAt]);
      for (let byte = 0; byte < meta.bytes; ++byte) bytes[target-code+byte] = Number(value>>BigInt(byte*8)&255n);
      before.writeBigUInt64LE(rsp+BigInt(meta.bytes),32); before.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);
      before.writeBigUInt64LE(43n,1128);
      assert.equal(cut(base,port),1n); assert(data.subarray(base,base+1256).equals(before));
      assert(data.subarray(code,base+65536).equals(bytes)); ++retries;
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); cc.compiler_close(); }
console.log(JSON.stringify({format:'c-wasm-pop-memory-native-v1',status:'pass',parity,comparisons,directComparisons,faults,refusals,waits,retries,rf,
  oracle:'actual x86 user-mode execution in reference build VM; not physical hardware',
  linuxBoot:'not-tested',exceptionDelivery:'not-tested'},null,2));
