// Real authenticated bzImage bytes -> cold C compiler -> C MMU/dispatcher.
// Fixed independent startup observations, not a JavaScript guest interpreter.
// Fixture byte access only: no guest opcodes or execution are implemented here.
class Bytes extends Uint8Array {
  constructor(value,offset,length) {
    super(value,offset,length);
    this.view = new DataView(this.buffer,this.byteOffset,this.byteLength);
  }
  equals(other) { return this.length === other.length && this.every((byte,i) => byte === other[i]); }
  readUInt16LE(at) { return this.view.getUint16(at,true); }
  readUInt32LE(at) { return this.view.getUint32(at,true); }
  readInt32LE(at) { return this.view.getInt32(at,true); }
  readBigUInt64LE(at) { return this.view.getBigUint64(at,true); }
  writeBigUInt64LE(value,at) { this.view.setBigUint64(at,value,true); }
  writeUInt32LE(value,at) { this.view.setUint32(at,value,true); }
}
const assert = (value,message = 'startup assertion') => { if (!value) throw new Error(message); };
assert.equal = (a,b) => assert(a === b,`startup: ${String(a)} != ${String(b)}`);
assert.deepEqual = (a,b) => assert(JSON.stringify(a) === JSON.stringify(b),'startup imports');

export async function checkStartup(reader,providerBytes,compilerBytes) {
const read = async name => new Bytes(await reader(name));
const json = async name => JSON.parse(new TextDecoder().decode(await read(name)));
const header = await read('boot.header'), command = await read('boot.command');
const kernel = await read('boot.kernel-page'), last = await read('boot.kernel-last-page');
const stateBytes = await read('boot.state'), segmentBytes = await read('boot.segments');
const meta = await json('boot.json'), summary = await json('kernel.summary.json');
const afterReturn = await json('after-return.summary.json'), idt = await json('idt.summary.json');
const controlRead = await json('control-read.summary.json');
const idtPage = await read('call.extra-page');
assert.equal(summary.instructions,20); assert.equal(summary.modules,17);
assert.equal(BigInt(summary.stop.entry),0x1000243n);
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const provider = await WebAssembly.compile(providerBytes);
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const compilerMemory = new WebAssembly.Memory({initial:16,maximum:32});
const compilerModule = await WebAssembly.compile(compilerBytes);
assert.deepEqual(WebAssembly.Module.imports(compilerModule),[{module:'machine',name:'memory',kind:'memory'}]);
const cc = (await WebAssembly.instantiate(compilerModule,{machine:{memory:compilerMemory}})).exports;
const compilerInput = cc.compiler_arena_min(), compilerOutput = compilerInput + 8192;
const compilerReport = compilerOutput + 65536;
const data = new Bytes(memory.buffer), view = new DataView(memory.buffer);
const input = vm.vm_arena_min(), rows = input + 8192, directoryOffset = input + 12288;
const base = input + 16384, port = base + 2048, segments = base + 1408;
const codeOffset = base + 32768, gdtOffset = base + 45056, stackOffset = base + 49152;
const idtCodeOffset = base + 53248;
const relocated = 0x1000000n + BigInt(header.readUInt32LE(0x260)) - 0x320000n;
const stack = relocated + 0x2ea400n;
const gdt = 0x1000232n + BigInt(kernel.readInt32LE(0x22e));
assert.equal(gdt,0x12e6000n); assert.equal(stack,0x1e2c400n);
data.set(header,input); data.set(command,input + 4096);
assert.equal(vm.vm_boot_prepare(input,header.length,BigInt(meta.imageBytes),
  BigInt(meta.initramfsBytes),BigInt(meta.ramBytes),input + 4096,command.length),0);
for (let i = 0; i < 6; ++i)
  assert.equal(vm.vm_boot_project(BigInt((i + 1) * 4096),base + (i + 2) * 4096,rows),1);
assert.equal(vm.vm_boot_project(gdt,gdtOffset,rows),2);
assert.equal(view.getBigUint64(rows,true),BigInt(meta.kernelOffset) + gdt - BigInt(meta.kernelAddress));
assert.equal(view.getUint32(rows + 8,true),1024);
data.set(last,gdtOffset); data.set(kernel,codeOffset); data.set(idtPage,idtCodeOffset);
assert.equal(vm.vm_boot_project(stack & ~4095n,stackOffset,rows),0);
assert.equal(vm.vm_boot_initial_state(base),0); assert.equal(vm.vm_boot_initial_segments(segments),0);
for (let i = 0; i < 10; ++i) {
  const at = directoryOffset + i * 32;
  view.setBigUint64(at,i < 6 ? BigInt((i + 1) * 4096) : i === 6 ? 0x1000000n
    : i === 7 ? 0x12e3000n : i === 8 ? gdt : stack & ~4095n,true);
  view.setUint32(at + 8,i < 6 ? (i + 2) * 4096 : i === 6 ? codeOffset - base
    : i === 7 ? idtCodeOffset - base : i === 8 ? gdtOffset - base : stackOffset - base,true);
  view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true);
  data.fill(0,at + 20,at + 32);
}
view.setBigUint64(port,9n,true);
assert.equal(vm.vm_open(base,data.length - base,4096,directoryOffset,10,9n),0);
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
// Initial A/D walks occur before executable-generation admission.
for (const [address,bytes,access] of [[0x1000200n,1,9],[0x1260n,4,1],
  [gdt,8,2],[stack - 16n,8,2]])
  assert.equal(vm.vm_access(port,address,bytes,access,
    address === gdt ? last.readBigUInt64LE(0) : 0n),0n);
const cuts = [ ...summary.cuts.map(cut => ({...cut,prefix:'kernel'})),
  ...afterReturn.cuts.map(cut => ({...cut,prefix:'after-return'})),
  ...idt.cuts.map(cut => ({...cut,prefix:'idt'})),
  ...controlRead.cuts.map(cut => ({...cut,prefix:'control-read'})) ].sort((a,b) => Number(BigInt(a.entry) - BigInt(b.entry)));
const table = vm.__indirect_function_table, firstSlot = table.grow(cuts.length);
assert(firstSlot >= vm.vm_slot_min());
let admissionCount = 0;
async function admit() {
  // Recompile from the actual resident code page after every RAM write.
  // No blind retry of stale rows or substitution of the original source.
  const code = data.subarray(codeOffset,codeOffset + 4096);
  assert(code.equals(kernel),'the fixed witness writes only disjoint GDT/stack pages');
  const bytes = new Bytes(compilerMemory.buffer), result = new DataView(compilerMemory.buffer);
  for (const [index,cut] of cuts.entries()) {
    const address = BigInt(cut.entry) & ~4095n;
    const sourceOffset = address === 0x1000000n ? codeOffset : idtCodeOffset;
    const source = data.subarray(sourceOffset,sourceOffset + 4096);
    assert(source.equals(address === 0x1000000n ? kernel : idtPage));
    bytes.set(source,compilerInput);
    assert.equal(cc.compiler_open_pages(compilerInput,1,address,9n),0);
    assert.equal(cc.compiler_emit(BigInt(cut.entry),1024,compilerOutput,65536,compilerReport),0);
    const length = Number(result.getBigUint64(compilerReport + 40,true));
    const emitted = bytes.subarray(compilerOutput,compilerOutput + length).slice();
    const expected = await read(cut.rank ? `${cut.prefix}.${cut.rank}.wasm` : `${cut.prefix}.wasm`);
    assert(emitted.equals(expected),'actual resident page/native-C emission equality');
    const module = await WebAssembly.compile(emitted);
    const instance = await WebAssembly.instantiate(module,{machine:{memory,
      access:vm.vm_access,segment:vm.vm_segment,reserve:vm.vm_reserve,commit:vm.vm_commit,
      table:vm.vm_table,far_return:vm.vm_return}});
    table.set(firstSlot + index,instance.exports.cut);
    const at = rows + index * 24;
    view.setBigUint64(at,BigInt(cut.entry),true); view.setUint32(at + 8,cut.sourceBytes,true);
    view.setUint32(at + 12,cut.instructions,true); view.setUint32(at + 16,firstSlot + index,true);
    view.setUint32(at + 20,0,true);
  }
  assert.equal(vm.vm_bind_execution(rows,cuts.length,9n),0);
  ++admissionCount;
}
await admit();
assert.equal(vm.vm_run(port,9n,32),5n); // RMW retires, its store revokes the next cut.
assert.equal(vm.vm_completed(),12); assert.equal(vm.vm_source_retired(),15n);
assert.equal(view.getBigUint64(base + 384,true),0x1000236n);
assert.equal(view.getBigUint64(gdtOffset + 2,true),last.readBigUInt64LE(2) + gdt);
assert.equal(vm.vm_run(port,9n,32),5n); assert.equal(vm.vm_source_retired(),0n);
await admit();
assert.equal(vm.vm_run(port,9n,32),5n); // LGDT then PUSH selector.
assert.equal(vm.vm_completed(),2); assert.equal(vm.vm_source_retired(),2n);
assert.equal(view.getBigUint64(base + 384,true),0x100023bn);
await admit();
assert.equal(vm.vm_run(port,9n,32),5n); // LEA then PUSH return RIP.
assert.equal(vm.vm_completed(),2); assert.equal(vm.vm_source_retired(),2n);
await admit();
assert.equal(vm.vm_run(port,9n,32),5n); // Descriptor Accessed mutation revokes the next entry.
assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
assert.equal(view.getBigUint64(base + 384,true),0x1000245n);
await admit();
assert.equal(vm.vm_run(port,9n,32),5n); // MOV then the real CALL into the supplied page.
assert.equal(vm.vm_completed(),2); assert.equal(vm.vm_source_retired(),2n);
assert.equal(view.getBigUint64(base + 384,true),0x12e3bb0n);
await admit();
assert.equal(vm.vm_run(port,9n,32),5n); // LEA then IDTR backing-record store.
assert.equal(vm.vm_completed(),2); assert.equal(vm.vm_source_retired(),2n);
await admit();
assert.equal(vm.vm_run(port,9n,32),6n); // LIDT/RET, CR4 read/AND; CR4 write is not yet compiled.
assert.equal(vm.vm_completed(),4); assert.equal(vm.vm_source_retired(),4n);
assert.equal(view.getBigUint64(base + 384,true),0x1000255n);
const expected = new Bytes(stateBytes), expectedSegments = new Bytes(segmentBytes);
expected.writeBigUInt64LE(stateBytes.readBigUInt64LE(416) & 0x1060n,0);
expected.writeBigUInt64LE(relocated,3 * 8);
expected.writeBigUInt64LE(0x1000n,15 * 8);
expected.writeBigUInt64LE(stack,4 * 8); expected.writeBigUInt64LE(0x1000000n,5 * 8);
// The ADD result's low byte is 0x08: odd parity, no carry/overflow/AF/SF/ZF.
expected.writeBigUInt64LE(0x1000255n,384); expected.writeBigUInt64LE(2n,392);
expected.writeBigUInt64LE(last.readBigUInt64LE(2) + gdt,432 + 2 * 8);
expected.writeBigUInt64LE(BigInt(last.readUInt16LE(0)),432 + 3 * 8);
expected.writeBigUInt64LE(0x12e6050n,432 + 4 * 8);
expected.writeBigUInt64LE(BigInt(last.readUInt16LE(0x40)),432 + 5 * 8);
for (const rank of [0,2,3,4,5]) {
  expected.writeBigUInt64LE(0n,432 + (6 + rank) * 8);
  expectedSegments.fill(0,8 + rank * 16,8 + (rank + 1) * 16);
  expectedSegments.writeUInt32LE(0x10000,8 + rank * 16 + 12);
}
const descriptor = view.getBigUint64(gdtOffset + Number(last.readBigUInt64LE(2)) + 16,true);
assert.equal(descriptor,0x00af9b000000ffffn);
expectedSegments.writeBigUInt64LE(0n,8 + 16);
expectedSegments.writeUInt32LE(0xffffffff,8 + 16 + 8);
expectedSegments.writeUInt32LE(0xa09b,8 + 16 + 12);
expected.writeBigUInt64LE(28n,1128);
assert(data.subarray(base,base + stateBytes.length).equals(expected),'complete architectural state after twenty-eight actual startup instructions');
assert(data.subarray(segments,segments + segmentBytes.length).equals(expectedSegments));
assert.equal(view.getBigUint64(stackOffset + Number((stack - 16n) & 4095n),true),0x1000245n);
assert.equal(view.getBigUint64(stackOffset + Number((stack - 8n) & 4095n),true),0x100024dn);
for (let i = 0; i < cuts.length; ++i) table.set(firstSlot + i,null);
cc.compiler_close(); vm.vm_close();
return {
  format:'browser-bzimage-startup-v1', status:'pass', linuxBoot:'not-achieved',
  retired:28, modules:cuts.length, admissions:admissionCount,
  nextRip:'0x1000255', nextGate:'MOV CR4,RAX (CR4 write)',
  guestExecution:'C-Wasm table dispatcher/MMU', coldCompilation:'C-Wasm decoder/planner/emitter',
  guestMemoryCallback:'C-Wasm, not JavaScript',
  providerBytes:providerBytes.byteLength, compilerBytes:compilerBytes.byteLength,
  memoryBytes:memory.buffer.byteLength, coldMemoryBytes:compilerMemory.buffer.byteLength
};
}
