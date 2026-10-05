// Independent per-bit SDM model, real CPL3 x86 receipts, and actual C-Wasm
// MMU/table execution. This does not implement a guest instruction callback.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-stack-flags.mjs VM.WASM FLAGS-FIXTURE-DIRECTORY');
const provider = await WebAssembly.compile(await readFile(providerFile));
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const directoryAt = vm.vm_arena_min(), rows = directoryAt + 512, base = directoryAt + 4096;
const port = base + 2048, slot = vm.__indirect_function_table.grow(1);
const entry = 0x400000n, stack = 0x500000n, pte = base + 20480 + 256 * 8;
const ram = base + 28672;
let randomState = 0xabcdef123456789n, comparisons = 0, hardware = 0, refusals = 0;
function random() {
  randomState = BigInt.asUintN(64,randomState ^ randomState << 13n);
  randomState ^= randomState >> 7n;
  randomState = BigInt.asUintN(64,randomState ^ randomState << 17n); return randomState;
}
function flagsAfter(before,value,width,cpl) {
  let result = before & ~0x10000n;
  const bits = [0,2,4,6,7,8,10,11,14];
  if (width === 64) bits.push(18,21);
  if (!cpl) bits.push(9,12,13);
  else if (BigInt(cpl) <= ((before >> 12n) & 3n)) bits.push(9);
  for (const bit of bits) {
    const mask = 1n << BigInt(bit); result = (result & ~mask) | (value & mask);
  }
  return result;
}
function reset(source,rsp,flags,cpl,value,width,push) {
  data.fill(0,base);
  for (let i = 0; i < 7; ++i) {
    const at = directoryAt + i * 32;
    view.setBigUint64(at,BigInt(i < 4 ? (i + 1) * 4096 : (i + 4) * 4096),true);
    view.setUint32(at + 8,(i + 2) * 4096,true);
    view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true);
    data.fill(0,at + 20,at + 32);
  }
  const shifts = [39n,30n,21n,12n];
  for (let i = 0; i < 4; ++i)
    view.setBigUint64(base + (i + 2) * 4096 + Number((entry >> shifts[i]) & 511n) * 8,
      BigInt(i === 3 ? 0x8000 : (i + 2) * 4096) | 103n,true);
  view.setBigUint64(pte,0x9067n,true); view.setBigUint64(pte + 8,0xa067n,true);
  data.set(source,base + 24576); data.fill(0x5a,ram,ram + 8192);
  const target = rsp - (push ? BigInt(width / 8) : 0n);
  if (!push && target >= stack && target + BigInt(width / 8) <= stack + 8192n)
    for (let i = 0; i < width / 8; ++i) data[ram + Number(target - stack) + i] = Number(value >> BigInt(8 * i) & 255n);
  for (let reg = 0; reg < 16; ++reg) view.setBigUint64(base + reg * 8,random(),true);
  view.setBigUint64(base + 32,rsp,true); view.setBigUint64(base + 384,entry,true);
  view.setBigUint64(base + 392,flags,true); view.setBigUint64(base + 400,0x80010011n,true);
  view.setBigUint64(base + 408,0x1000n,true); view.setBigUint64(base + 416,32n,true);
  view.setBigUint64(base + 424,0xd00n,true); view.setBigUint64(base + 488,16n | BigInt(cpl),true);
  view.setBigUint64(base + 1128,42n,true); view.setBigUint64(port,9n,true);
  assert.equal(vm.vm_open(base,data.length - base,4096,directoryAt,7,7,directoryAt + 1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);
}
try {
  for (const [name,width,push] of [['pushfq',64,true],['popfq',64,false],['pushf',16,true],['popf',16,false]]) {
    const module = await WebAssembly.compile(await readFile(path.join(directory,`${name}.wasm`)));
    assert.deepEqual(WebAssembly.Module.imports(module),[
      {module:'machine',name:'memory',kind:'memory'}, {module:'machine',name:'access',kind:'function'}]);
    const cut = (await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).exports.cut;
    const source = await readFile(path.join(directory,`${name}.source-page`)), sourceBytes = width === 16 ? 2 : 1;
    vm.__indirect_function_table.set(slot,cut);
    view.setBigUint64(rows,entry,true); view.setUint32(rows + 8,sourceBytes,true);
    view.setUint32(rows + 12,1,true); view.setUint32(rows + 16,slot,true); view.setUint32(rows + 20,0,true);
    function compare(rsp,flags,cpl,value) {
      reset(source,rsp,flags,cpl,value,width,push);
      const before = Buffer.from(data.subarray(base,base + 1256));
      const beforeRam = Buffer.from(data.subarray(ram,ram + 8192));
      const expected = Buffer.from(before), expectedRam = Buffer.from(beforeRam);
      const target = rsp - (push ? BigInt(width / 8) : 0n);
      if (push) {
        const pushed = flags & ~0x30000n;
        for (let i = 0; i < width / 8; ++i) expectedRam[Number(target - stack) + i] = Number(pushed >> BigInt(i * 8) & 255n);
      } else expected.writeBigUInt64LE(flagsAfter(flags,value,width,cpl),392);
      expected.writeBigUInt64LE(rsp + (push ? -1n : 1n) * BigInt(width / 8),32);
      expected.writeBigUInt64LE(entry + BigInt(sourceBytes),384); expected.writeBigUInt64LE(43n,1128);
      assert.equal(cut(base,port,entry),1n,name);
      assert(data.subarray(base,base + 1256).equals(expected),`${name}: complete direct CPU`);
      assert(data.subarray(ram,ram + 8192).equals(expectedRam),`${name}: direct RAM`);
      data.set(before,base); data.set(beforeRam,ram);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0);
      assert.equal(vm.vm_run(port,9n,1),push ? 5n : 1n);
      assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
      assert(data.subarray(base,base + 1256).equals(expected),`${name}: complete dispatched CPU`);
      assert(data.subarray(ram,ram + 8192).equals(expectedRam),`${name}: dispatched RAM`);
    }
    for (let cpl = 0; cpl < 4; ++cpl) for (let iopl = 0; iopl < 4; ++iopl)
    for (let sample = 0; sample < 128; ++sample) {
      const flags = 2n | (random() & 0x384ed5n) | BigInt(iopl) << 12n;
      const target = stack + (sample & 1 ? 4095n : 512n);
      compare(target + (push ? BigInt(width / 8) : 0n),flags,cpl,random()); ++comparisons;
    }
    const native = await readFile(path.join(directory,'native.bin'));
    assert.equal(native.length,2048 * 40);
    for (let at = 0; at < native.length; at += 40) {
      if (native.readBigUInt64LE(at) !== BigInt(width)) continue;
      const value = native.readBigUInt64LE(at + 8), before = native.readBigUInt64LE(at + 16);
      assert.equal(flagsAfter(before,value,width,3),native.readBigUInt64LE(at + 24));
      compare(stack + 1024n,push ? native.readBigUInt64LE(at + 24) : before,3,value); ++hardware;
    }
    // Stack faults and physical misses never partially store, advance RSP,
    // change flags or retire. Page-table A/D effects are a separate event.
    for (const failure of ['canonical','pte-absent','physical-miss','stale','TF','RF','AC','port-alias','port-wrap']) {
      const target = failure === 'canonical' ? 0x800000000000n : stack + 4095n;
      reset(source,target + (push ? BigInt(width / 8) : 0n),0x202n,3,~0n,width,push);
      let expected = 6n, argument = port;
      if (failure === 'canonical') expected = 99n;
      if (failure === 'pte-absent') { view.setBigUint64(pte + 8,0n,true); expected = 115n; }
      if (failure === 'physical-miss') { view.setBigUint64(pte + 8,0xb067n,true); expected = 2n; }
      if (failure === 'stale') { view.setBigUint64(port,8n,true); expected = 5n; }
      if (['TF','RF','AC'].includes(failure)) view.setBigUint64(base + 392,0x202n | ({TF:256n,RF:65536n,AC:262144n})[failure],true);
      if (failure === 'port-alias') argument = base;
      if (failure === 'port-wrap') argument = 0xfffffff8;
      const before = Buffer.from(data.subarray(base,base + 1256)), oldRam = Buffer.from(data.subarray(ram,ram + 8192));
      assert.equal(cut(base,argument,entry),expected,`${name}: ${failure}`);
      assert(data.subarray(base,base + 1256).equals(before)); assert(data.subarray(ram,ram + 8192).equals(oldRam));
      if (failure === 'canonical') { assert.equal(view.getUint32(port + 24,true),12); assert.equal(view.getUint32(port + 28,true),0); }
      if (failure === 'pte-absent') { assert.equal(view.getUint32(port + 24,true),14); assert.equal(view.getUint32(port + 28,true),push ? 6 : 4); }
      if (failure === 'physical-miss') { assert.equal(view.getBigUint64(port + 32,true),0xb000n); assert.equal(view.getUint32(port + 44,true),(push ? 2 : 1) | 16); }
      ++refusals;
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); }
console.log(`PUSHF/POPF: green (${comparisons} CPL/IOPL full-state cases direct+C dispatch, ${hardware} real CPL3 receipts, ${refusals} fault/refusal cases; NOT exception delivery/Linux boot)`);
