// Real x86 receipts, cold C compiler byte parity, and generated Wasm through
// the C VM/MMU. Host code constructs fixtures; it never executes guest opcodes.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-branch.mjs VM.WASM COMPILER.WASM BRANCH-FIXTURE-DIRECTORY');
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const vm = (await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const coldMemory = new WebAssembly.Memory({initial:16,maximum:32});
const compilerModule = await WebAssembly.compile(await readFile(compilerFile));
assert.deepEqual(WebAssembly.Module.imports(compilerModule),[{module:'machine',name:'memory',kind:'memory'}]);
const cc = (await WebAssembly.instantiate(compilerModule,{machine:{memory:coldMemory}})).exports;
const cold = Buffer.from(coldMemory.buffer), cv = new DataView(coldMemory.buffer);
const input = cc.compiler_arena_min(), output = input + 8192, report = output + 65536;
const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const directoryAt = vm.vm_arena_min(), rows = directoryAt + 512, base = directoryAt + 4096;
const port = base + 2048, segments = base + 1408, codeView = base + 2112;
const code = base + 28672, ram = base + 32768;
const entry = 0x400000n, start = 0x12340000n;
const ramPte = base + 24576 + 320 * 8;
const slot = vm.__indirect_function_table.grow(1);
let comparisons = 0, generalProtection = 0, faultOrdering = 0, refusals = 0, parity = 0, prefixes = 0, resumeFlags = 0;
function reset(source,sourceBytes,record,target) {
  data.fill(0,base);
  // Poison unrelated architectural storage: accidental zero publication must
  // not look like preservation merely because the fixture started at zero.
  for (const [first,end] of [[128,384],[432,488],[496,1128],[1136,1256]])
    data.fill(0x5a,base + first,base + end);
  seedDisabledDebug(view, base);
  const physical = [0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x9000,0xa000];
  for (const [rank,address] of physical.entries()) {
    const at = directoryAt + rank * 32;
    view.setBigUint64(at,BigInt(address),true); view.setUint32(at + 8,(rank + 2) * 4096,true);
    view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true); data.fill(0,at + 20,at + 32);
  }
  view.setBigUint64(base + 8192,0x2067n,true);
  view.setBigUint64(base + 12288,0x3067n,true);
  view.setBigUint64(base + 16384 + 2 * 8,0x4067n,true);
  view.setBigUint64(base + 16384 + 145 * 8,0x5067n,true);
  view.setBigUint64(base + 20480,0x8067n,true);
  view.setBigUint64(ramPte,0x9067n,true); view.setBigUint64(ramPte + 8,0xa067n,true);
  data.set(source,code); data.fill(0x5a,ram,ram + 8192);
  for (let rank = 0; rank < 17; ++rank)
    view.setBigUint64(base + (rank === 16 ? 392 : rank * 8),record.readBigUInt64LE(rank * 8),true);
  const operand = record.readBigUInt64LE(37 * 8);
  if (operand) view.setBigUint64(operand === entry + 0x800n ? code + 0x800 : ram + Number(operand - start),target,true);
  view.setBigUint64(base + 384,entry,true); view.setBigUint64(base + 1128,42n,true);
  view.setBigUint64(base + 400,0x80010011n,true); view.setBigUint64(base + 408,0x1000n,true);
  view.setBigUint64(base + 416,32n,true); view.setBigUint64(base + 424,0xd00n,true);
  view.setBigUint64(base + 488,19n,true); view.setBigUint64(port,9n,true);
  view.setUint32(segments,2,true); view.setUint32(segments + 36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length - base,4096,directoryAt,8,8,directoryAt + 1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  view.setBigUint64(rows,entry,true); view.setUint32(rows + 8,sourceBytes,true);
  view.setUint32(rows + 12,1,true); view.setUint32(rows + 16,slot,true); view.setUint32(rows + 20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function cpu() { return Buffer.from(data.subarray(base,base + 1256)); }
function payload() { return Buffer.from(data.subarray(code,ram + 8192)); }
function unchanged(before,bytes,message) {
  assert(data.subarray(base,base + 1256).equals(before),`${message}: complete CPU`);
  assert(data.subarray(code,ram + 8192).equals(bytes),`${message}: source/operand RAM`);
  assert.equal(vm.vm_source_retired(),0n); assert.equal(vm.vm_completed(),0);
}
try {
  for (let form = 0; form < 24; ++form) {
    const prefix = path.join(directory,`branch-${form}`);
    const source = await readFile(`${prefix}.source-page`), meta = JSON.parse(await readFile(`${prefix}.json`));
    const emitted = await readFile(`${prefix}.wasm`), native = await readFile(`${prefix}.cases`);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    assert.equal(cv.getBigUint64(report + 40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output + emitted.length).equals(emitted),'native / cold C byte-identical emission'); ++parity;
    const module = await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),meta.memory ? [
      {module:'machine',name:'memory',kind:'memory'},{module:'machine',name:'access',kind:'function'}]
      : [{module:'machine',name:'memory',kind:'memory'}]);
    const cut = (await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    assert.equal(native.length,256 * 38 * 8);
    for (let row = 0; row < 256; ++row) {
      const record = native.subarray(row * 304,(row + 1) * 304);
      const fault = record.readBigUInt64LE(35 * 8) !== 0n;
      const target = fault ? 0x8000000000000000n : record.readBigUInt64LE(34 * 8);
      reset(source,meta.sourceBytes,record,target);
      const expected = cpu(), bytes = payload();
      for (let rank = 0; rank < 16; ++rank) expected.writeBigUInt64LE(record.readBigUInt64LE((17 + rank) * 8),rank * 8);
      expected.writeBigUInt64LE(record.readBigUInt64LE(33 * 8),392);
      expected.writeBigUInt64LE(record.readBigUInt64LE(34 * 8),384);
      if (!fault) expected.writeBigUInt64LE(43n,1128);
      assert.equal(vm.vm_run(port,9n,1),fault ? 107n : 1n,`form ${form}/row ${row}`);
      assert(data.subarray(base,base + 1256).equals(expected),`form ${form}/row ${row}: real x86 CPU`);
      assert(data.subarray(code,ram + 8192).equals(bytes),'JMP has no source/operand store');
      assert.equal(vm.vm_completed(),fault ? 0 : 1); assert.equal(vm.vm_source_retired(),fault ? 0n : 1n);
      if (fault) {
        assert.equal(view.getUint32(port + 24,true),13); assert.equal(view.getUint32(port + 28,true),0);
        assert.equal(view.getBigUint64(port + 16,true),target); ++generalProtection;
      }
      ++comparisons;
      // RF restored by exception return is accepted, unlike TF. Success
      // clears it; a pending target fault preserves it without retirement.
      reset(source,meta.sourceBytes,record,target);
      view.setBigUint64(base+392,record.readBigUInt64LE(16*8)|0x10000n,true);
      const rfExpected=Buffer.from(expected);
      if (fault) rfExpected.writeBigUInt64LE(record.readBigUInt64LE(33*8)|0x10000n,392);
      assert.equal(vm.vm_run(port,9n,1),fault ? 107n : 1n,`form ${form}/RF row ${row}`);
      assert(data.subarray(base,base+1256).equals(rfExpected),`form ${form}/RF complete CPU ${row}`);
      assert(data.subarray(code,ram+8192).equals(bytes),'RF changes no JMP payload');
      assert.equal(vm.vm_source_retired(),fault ? 0n : 1n); ++resumeFlags;
    }
    const record = native.subarray(0,304);
    for (const failure of ['TF','alias','wrap','stale']) {
      reset(source,meta.sourceBytes,record,record.readBigUInt64LE(34 * 8));
      if (failure === 'TF') view.setBigUint64(base + 392,0x302n,true);
      if (failure === 'stale') view.setBigUint64(port,8n,true);
      const before = cpu(), bytes = payload();
      assert.equal(failure === 'stale' ? vm.vm_run(port,9n,1)
        : cut(base,failure === 'alias' ? base : failure === 'wrap' ? 0xfffffff8 : port),failure === 'stale' ? 5n : 6n);
      unchanged(before,bytes,failure); ++refusals;
    }
    if (meta.memory && form !== 22) {
      // A cross-page operand must fault before inspecting a noncanonical
      // loaded target. This is a C-MMU contract test, not a hardware receipt.
      for (const failure of ['absent','supervisor','resource']) {
        reset(source,meta.sourceBytes,record,0x8000000000000000n);
        view.setBigUint64(ramPte + 8,failure === 'absent' ? 0n : failure === 'supervisor' ? 0xa063n : 0xb067n,true);
        const before = cpu(), bytes = payload();
        assert.equal(vm.vm_run(port,9n,1),failure === 'resource' ? 2n : 115n,`${form}/${failure}`);
        unchanged(before,bytes,failure);
        if (failure !== 'resource') {
          assert.equal(view.getUint32(port + 24,true),14);
          assert.equal(view.getUint32(port + 28,true),failure === 'supervisor' ? 5 : 4);
          assert.equal(view.getBigUint64(port + 16,true),start + 4096n);
        } else assert.equal(view.getBigUint64(port + 32,true),0xb000n);
        ++faultOrdering;
      }
    }
    if (form === 18) {
      reset(source,meta.sourceBytes,record,0x8000000000000000n);
      view.setBigUint64(base + 32,0x8000000000000000n - 127n,true);
      const before = cpu(), bytes = payload(); assert.equal(vm.vm_run(port,9n,1),99n);
      unchanged(before,bytes,'SS address precedes target'); assert.equal(view.getUint32(port + 24,true),12); ++faultOrdering;
    }
    if (form === 0) {
      // A canonical but unmapped destination belongs to the following fetch,
      // not the near JMP. No destination validation can unretire the JMP.
      reset(source,meta.sourceBytes,record,record.readBigUInt64LE(34 * 8));
      view.setBigUint64(base,0x600000n,true);
      assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_source_retired(),1n);
      const before = cpu(); assert.equal(before.readBigUInt64LE(384),0x600000n);
      assert.equal(vm.vm_code(port,0x600000n,codeView),115n);
      assert(data.subarray(base,base + 1256).equals(before)); assert.equal(view.getUint32(port + 24,true),14);
      assert.equal(view.getUint32(port + 28,true),20); ++faultOrdering;
    }
  }
  const prefix = path.join(directory,'branch-24');
  const source = await readFile(`${prefix}.source-page`), emitted = await readFile(`${prefix}.wasm`);
  cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1024,output,65536,report),0);
  assert.equal(cv.getBigUint64(report + 40,true),BigInt(emitted.length));
  assert(cold.subarray(output,output + emitted.length).equals(emitted)); ++parity;
  const leading = (await WebAssembly.instantiate(emitted,{machine:{memory}})).instance.exports.cut;
  assert.equal(cc.compiler_emit(entry + 7n,1024,output,65536,report),0);
  const following = (await WebAssembly.instantiate(cold.subarray(output,output + Number(cv.getBigUint64(report + 40,true))),
    {machine:{memory}})).instance.exports.cut;
  const record = Buffer.alloc(304); record.writeBigUInt64LE(0x202n,128);
  for (const target of [0x500031n,0x8000000000000000n]) {
    reset(source,7,record,0n); view.setBigUint64(base,target - 49n,true);
    const expected = cpu(), bytes = payload();
    vm.__indirect_function_table.set(slot,leading);
    assert.equal(vm.vm_run(port,9n,1),1n);
    expected.writeBigUInt64LE(target,0); expected.writeBigUInt64LE(entry + 7n,384); expected.writeBigUInt64LE(43n,1128);
    assert(data.subarray(base,base + 1256).equals(expected),'pure prefix commits exact fallthrough, not successor branch');
    view.setBigUint64(rows,entry + 7n,true); view.setUint32(rows + 8,2,true);
    vm.__indirect_function_table.set(slot,following); assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const fault = target === 0x8000000000000000n;
    assert.equal(vm.vm_run(port,9n,1),fault ? 107n : 1n);
    if (!fault) { expected.writeBigUInt64LE(target,384); expected.writeBigUInt64LE(44n,1128); }
    assert(data.subarray(base,base + 1256).equals(expected),'later target fault cannot roll back retired prefix');
    assert(data.subarray(code,ram + 8192).equals(bytes)); ++prefixes;
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); cc.compiler_close(); }
console.log(`Indirect JMP: green (${parity} native/cold byte-identical modules; ${comparisons} actual x86 CPU comparisons, ${generalProtection} #GP receipts, ${faultOrdering} C-MMU fault-ordering cases, ${refusals} refusals, ${resumeFlags} RF checks, ${prefixes} prefix/fault compositions; NOT exception delivery/Linux boot)`);
