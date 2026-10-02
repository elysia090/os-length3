// Test-only literal element semantics and real x86 receipts. Guest execution
// is the emitted Wasm loop through C MMU/access and C table continuation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-repeat.mjs VM.WASM REPEAT-FIXTURE-DIRECTORY');
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const vm = (await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const directoryAt = vm.vm_arena_min(), rows = directoryAt + 512, base = directoryAt + 4096;
const port = base + 2048, segments = base + 1408, code = base + 24576, ram = base + 28672;
const entry = 0x400000n, start = 0x500000n, pte = base + 20480 + 256 * 8;
const slot = vm.__indirect_function_table.grow(1);
const native = await readFile(path.join(directory,'native.bin')), recordBytes = 96 + 16384;
assert.equal(native.length,336 * recordBytes);
let seed = 0xabcdef123456789n, comparisons = 0, yields = 0, faults = 0, stale = 0, selfModification = 0;
function random() {
  seed = BigInt.asUintN(64,seed ^ seed << 13n); seed ^= seed >> 7n;
  seed = BigInt.asUintN(64,seed ^ seed << 17n); return seed;
}
function reset(source,sourceBytes,count,src,dst,df,sample,width) {
  data.fill(0,base);
  for (let rank = 0; rank < 9; ++rank) {
    const at = directoryAt + rank * 32;
    view.setBigUint64(at,BigInt(rank < 4 ? (rank + 1) * 4096 : (rank + 4) * 4096),true);
    view.setUint32(at + 8,(rank + 2) * 4096,true);
    view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true); data.fill(0,at + 20,at + 32);
  }
  const shifts = [39n,30n,21n,12n];
  for (let rank = 0; rank < 4; ++rank)
    view.setBigUint64(base + (rank + 2) * 4096 + Number(entry >> shifts[rank] & 511n) * 8,
      BigInt(rank === 3 ? 0x8000 : (rank + 2) * 4096) | 103n,true);
  for (let rank = 0; rank < 4; ++rank) view.setBigUint64(pte + rank * 8,BigInt((rank + 9) * 4096) | 103n,true);
  data.set(source,code);
  for (let i = 0; i < 16384; ++i) data[ram + i] = (i * 37 + sample * 17 + width) & 255;
  for (let reg = 0; reg < 16; ++reg) view.setBigUint64(base + reg * 8,random(),true);
  view.setBigUint64(base + 8,count,true); view.setBigUint64(base + 48,src,true); view.setBigUint64(base + 56,dst,true);
  view.setBigUint64(base + 384,entry,true); view.setBigUint64(base + 392,0x202n | (df ? 0x400n : 0n),true);
  view.setBigUint64(base + 400,0x80010011n,true); view.setBigUint64(base + 408,0x1000n,true);
  view.setBigUint64(base + 416,32n,true); view.setBigUint64(base + 424,0xd00n,true);
  view.setBigUint64(base + 488,19n,true); view.setBigUint64(base + 1128,42n,true);
  view.setBigUint64(port,9n,true); view.setUint32(segments,1,true); view.setUint32(segments + 4,1,true);
  assert.equal(vm.vm_open(base,data.length - base,4096,directoryAt,9,9,directoryAt + 1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  view.setBigUint64(rows,entry,true); view.setUint32(rows + 8,sourceBytes,true);
  view.setUint32(rows + 12,1,true); view.setUint32(rows + 16,slot,true); view.setUint32(rows + 20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function advance(cpu,payload,width,address,limit) {
  const mask = address === 32 ? 0xffffffffn : 0xffffffffffffffffn, size = width / 8;
  let count = cpu.readBigUInt64LE(8), src = cpu.readBigUInt64LE(48), dst = cpu.readBigUInt64LE(56);
  const stride = cpu.readBigUInt64LE(392) & 0x400n ? -BigInt(size) : BigInt(size);
  for (let n = 0; n < limit && (count & mask); ++n) {
    const from = Number((src & mask) - start), to = Number((dst & mask) - start);
    // One element loads before storing, including its own byte overlap.
    const value = Buffer.from(payload.subarray(from,from + size)); payload.set(value,to);
    count = (count - 1n) & mask; src = (src + stride) & mask; dst = (dst + stride) & mask;
  }
  if ((count & mask) === 0n) { count &= mask; src &= mask; dst &= mask; }
  cpu.writeBigUInt64LE(count,8); cpu.writeBigUInt64LE(src,48); cpu.writeBigUInt64LE(dst,56);
  return (count & mask) === 0n;
}
function narrow(cpu,address) {
  if (address === 32) for (const offset of [8,48,56]) cpu.writeBigUInt64LE(cpu.readBigUInt64LE(offset) & 0xffffffffn,offset);
}
try {
  for (const address of [32,64]) for (const width of [8,16,32,64]) {
    const prefix = path.join(directory,`repeat-${width}-${address}`);
    const module = await WebAssembly.compile(await readFile(`${prefix}.wasm`));
    assert.deepEqual(WebAssembly.Module.imports(module),[
      {module:'machine',name:'memory',kind:'memory'},{module:'machine',name:'access',kind:'function'}]);
    const cut = (await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    const source = await readFile(`${prefix}.source-page`), meta = JSON.parse(await readFile(`${prefix}.json`));
    for (let at = 0; at < native.length; at += recordBytes) {
      if (native.readBigUInt64LE(at) !== BigInt(width) || native.readBigUInt64LE(at + 8) !== BigInt(address)) continue;
      const df = Number(native.readBigUInt64LE(at + 24)), sample = Number(native.readBigUInt64LE(at + 40));
      reset(source,meta.sourceBytes,native.readBigUInt64LE(at + 48),native.readBigUInt64LE(at + 56),
        native.readBigUInt64LE(at + 64),df,sample,width);
      const expected = Buffer.from(data.subarray(base,base + 1256)), payload = Buffer.from(data.subarray(ram,ram + 16384));
      let complete = false;
      while (!complete) {
        narrow(expected,address); complete = advance(expected,payload,width,address,256);
        if (complete) { expected.writeBigUInt64LE(entry + BigInt(meta.sourceBytes),384); expected.writeBigUInt64LE(43n,1128); }
        const result = vm.vm_run(port,9n,1);
        assert.equal(result,complete ? (sample ? 5n : 1n) : 10n,`${width}/${address}: return`);
        assert.equal(vm.vm_completed(),complete ? 1 : 0); assert.equal(vm.vm_source_retired(),complete ? 1n : 0n);
        assert.equal(view.getUint32(segments + 4,true),complete ? 0 : 1);
        assert(data.subarray(base,base + 1256).equals(expected),`${width}/${address}: complete CPU at return`);
        assert(data.subarray(ram,ram + 16384).equals(payload),`${width}/${address}: RAM at return`);
        if (!complete) {
          ++yields;
          // Wrong port generation must not consume/cancel the valid latch.
          view.setBigUint64(port,8n,true); const saved = Buffer.from(data.subarray(base,base + 1256));
          assert.equal(vm.vm_run(port,9n,1),5n); assert(data.subarray(base,base + 1256).equals(saved)); ++stale;
          view.setBigUint64(port,9n,true);
          // Changing the caller's descriptor must not replace an in-flight instruction.
          view.setUint32(rows + 16,0,true);
        }
      }
      for (let rank = 0; rank < 3; ++rank)
        assert.equal(view.getBigUint64(base + [8,48,56][rank],true),native.readBigUInt64LE(at + 72 + rank * 8),
          `${width}/${address}: actual x86 parent register ${rank}`);
      assert(data.subarray(ram,ram + 16384).equals(native.subarray(at + 96,at + recordBytes)),`${width}/${address}: actual x86 RAM`);
      ++comparisons;
    }
    for (const operation of ['read','write']) for (const failure of ['pte','resident','cross-element']) {
      const size = width / 8, crossing = start + 4096n - BigInt(2 * size);
      const src = operation === 'read' ? crossing : start + 8192n;
      const dst = operation === 'write' ? crossing : start + 8192n;
      reset(source,meta.sourceBytes,4n,src,dst,0,0,width);
      const expected = Buffer.from(data.subarray(base,base + 1256)), payload = Buffer.from(data.subarray(ram,ram + 16384));
      if (failure === 'cross-element') {
        if (size === 1) continue;
        const crossingElement = start + 4096n - BigInt(size - 1);
        view.setBigUint64(base + (operation === 'read' ? 48 : 56),crossingElement,true);
        expected.writeBigUInt64LE(crossingElement,operation === 'read' ? 48 : 56);
      } else advance(expected,payload,width,address,2);
      view.setBigUint64(pte + 8,failure === 'resident' ? 0xd067n : 0n,true);
      const result = vm.vm_run(port,9n,1);
      assert.equal(result,failure === 'resident' ? 2n : 115n,`${operation}/${failure}`);
      assert.equal(vm.vm_completed(),0); assert.equal(vm.vm_source_retired(),0n);
      assert(data.subarray(base,base + 1256).equals(expected),'partial frontier, no faulting-element commit');
      assert(data.subarray(ram,ram + 16384).equals(payload),'no partial cross-page payload write');
      assert.equal(view.getUint32(segments + 4,true),1);
      if (failure === 'resident') {
        assert.equal(view.getBigUint64(port + 32,true),0xd000n);
        assert.equal(view.getUint32(port + 40,true),size);
        assert.equal(view.getUint32(port + 44,true),(operation === 'write' ? 2 : 1) | 16);
      } else {
        assert.equal(view.getUint32(port + 24,true),14); assert.equal(view.getUint32(port + 28,true),operation === 'write' ? 6 : 4);
      }
      ++faults;
    }
    const faultNative = await readFile(path.join(directory,'fault.bin')), faultRecordBytes = 112 + 16384;
    assert.equal(faultNative.length,44 * faultRecordBytes);
    for (let at = 0; at < faultNative.length; at += faultRecordBytes) {
      if (faultNative.readBigUInt64LE(at) !== BigInt(width) || faultNative.readBigUInt64LE(at + 8) !== BigInt(address)) continue;
      const operation = Number(faultNative.readBigUInt64LE(at + 16)), failure = Number(faultNative.readBigUInt64LE(at + 24));
      reset(source,meta.sourceBytes,faultNative.readBigUInt64LE(at + 32),faultNative.readBigUInt64LE(at + 40),
        faultNative.readBigUInt64LE(at + 48),0,0,width);
      const expected = Buffer.from(data.subarray(base,base + 1256)), payload = Buffer.from(data.subarray(ram,ram + 16384));
      narrow(expected,address); if (failure === 1) advance(expected,payload,width,address,2);
      view.setBigUint64(pte + 8,0n,true);
      assert.equal(vm.vm_run(port,9n,1),115n);
      assert(data.subarray(base,base + 1256).equals(expected),'hardware fault: complete pre-delivery CPU');
      assert(data.subarray(ram,ram + 16384).equals(faultNative.subarray(at + 112,at + faultRecordBytes)),'hardware fault RAM');
      for (let rank = 0; rank < 3; ++rank)
        assert.equal(view.getBigUint64(base + [8,48,56][rank],true),faultNative.readBigUInt64LE(at + 56 + rank * 8));
      // Hardware saved context adds RF during exception delivery, not MOVS.
      assert.equal(view.getBigUint64(base + 392,true),faultNative.readBigUInt64LE(at + 80) & ~65536n);
      assert.equal(view.getUint32(port + 24,true),Number(faultNative.readBigUInt64LE(at + 88)));
      assert.equal(view.getUint32(port + 28,true),Number(faultNative.readBigUInt64LE(at + 96)));
      assert.equal(view.getBigUint64(port + 16,true),faultNative.readBigUInt64LE(at + 104));
      assert.equal(vm.vm_source_retired(),0n); ++faults;
    }
    // Zero count suppresses even noncanonical addresses; no memory callback.
    reset(source,meta.sourceBytes,0n,0x800000000000n,~0n,0,0,width);
    const before = Buffer.from(data.subarray(base,base + 1256));
    narrow(before,address);
    before.writeBigUInt64LE(entry + BigInt(meta.sourceBytes),384); before.writeBigUInt64LE(43n,1128);
    assert.equal(vm.vm_run(port,9n,1),1n); assert(data.subarray(base,base + 1256).equals(before));
    for (const refusal of ['stale','TF','RF','AC','alias','wrap']) {
      reset(source,meta.sourceBytes,0x1234567800000004n,0x8765432100500200n,0xabcdef0100502000n,0,0,width);
      // Address-size-64 noncanonical pointers are not reached on entry refusal.
      if (['TF','RF','AC'].includes(refusal)) view.setBigUint64(base + 392,0x202n | ({TF:256n,RF:65536n,AC:262144n})[refusal],true);
      if (refusal === 'stale') view.setBigUint64(port,8n,true);
      const before = Buffer.from(data.subarray(base,base + 1256)), payload = Buffer.from(data.subarray(ram,ram + 16384));
      const argument = refusal === 'alias' ? base : refusal === 'wrap' ? 0xfffffff8 : port;
      assert.equal(cut(base,argument),refusal === 'stale' ? 5n : 6n,refusal);
      assert(data.subarray(base,base + 1256).equals(before)); assert(data.subarray(ram,ram + 16384).equals(payload)); ++stale;
    }
    if (width === 8) {
      reset(source,meta.sourceBytes,513n,start + 512n,entry,0,0,width);
      const expected = Buffer.from(data.subarray(base,base + 1256));
      const expectedCode = Buffer.from(data.subarray(code,code + 4096)), sourceRam = Buffer.from(data.subarray(ram,ram + 16384));
      for (let part = 0; part < 3; ++part) {
        const first = part * 256, end = Math.min(first + 256,513);
        expectedCode.set(sourceRam.subarray(512 + first,512 + end),first);
        expected.writeBigUInt64LE(BigInt(513 - end),8); expected.writeBigUInt64LE(start + BigInt(512 + end),48);
        expected.writeBigUInt64LE(entry + BigInt(end),56);
        if (end === 513) { expected.writeBigUInt64LE(entry + BigInt(meta.sourceBytes),384); expected.writeBigUInt64LE(43n,1128); }
        assert.equal(vm.vm_run(port,9n,1),end === 513 ? 5n : 10n);
        assert(data.subarray(base,base + 1256).equals(expected)); assert(data.subarray(code,code + 4096).equals(expectedCode));
      }
      const saved = Buffer.from(data.subarray(base,base + 1256));
      assert.equal(vm.vm_run(port,9n,1),5n); assert(data.subarray(base,base + 1256).equals(saved));
      ++selfModification;
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); }
console.log(`REP MOVS: green (${comparisons} native x86 CPU/RAM receipts, ${yields} bounded latch resumes, ${stale} entry/stale refusals, ${faults} partial/fault/miss cases, ${selfModification} source-code alias continuations; NOT exception delivery/Linux boot)`);
