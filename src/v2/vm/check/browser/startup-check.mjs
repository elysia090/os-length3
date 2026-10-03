// Authenticated bzImage pages -> cold C compiler -> C MMU/table dispatcher.
// JavaScript transports bounded pages/metadata; it does not decode or execute
// guest instructions, resolve guest branches, or implement guest exceptions.
import {CompiledModules} from '../../../web/compiled-modules.mjs';
class Bytes extends Uint8Array {
  constructor(value,offset,length) {
    super(value,offset,length);
    this.view = new DataView(this.buffer,this.byteOffset,this.byteLength);
  }
  equals(other) { return this.length === other.length && this.every((byte,i) => byte === other[i]); }
  readUInt16LE(at) { return this.view.getUint16(at,true); }
  readUInt32LE(at) { return this.view.getUint32(at,true); }
  readBigUInt64LE(at) { return this.view.getBigUint64(at,true); }
  writeBigUInt64LE(value,at) { this.view.setBigUint64(at,value,true); }
  writeUInt32LE(value,at) { this.view.setUint32(at,value,true); }
}
const assert = (value,message = 'startup assertion') => { if (!value) throw new Error(message); };
assert.equal = (a,b) => assert(a === b,`startup: ${String(a)} != ${String(b)}`);
assert.deepEqual = (a,b) => assert(JSON.stringify(a) === JSON.stringify(b),'startup imports');

export async function checkStartup(reader,providerBytes,compilerBytes,readExtent) {
  const read = async name => new Bytes(await reader(name));
  const header = await read('boot.header'), command = await read('boot.command');
  const kernel = await read('boot.kernel-page'), last = await read('boot.kernel-last-page');
  const stateBytes = await read('boot.state'), segmentBytes = await read('boot.segments');
  const meta = JSON.parse(new TextDecoder().decode(await read('boot.json')));
  const kernelBytes = header.readUInt32LE(0x1f4) * 16;
  const idtPage = await read('call.extra-page'), cmdlinePage = await read('cmdline.extra-page');
  const optionPage = await read('option.extra-page');
  const memory = new WebAssembly.Memory({initial:8,maximum:128});
  const provider = await WebAssembly.compile(providerBytes);
  assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
  const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
  const compilerMemory = new WebAssembly.Memory({initial:16,maximum:32});
  const compilerModule = await WebAssembly.compile(compilerBytes);
  assert.deepEqual(WebAssembly.Module.imports(compilerModule),[{module:'machine',name:'memory',kind:'memory'}]);
  const cc = (await WebAssembly.instantiate(compilerModule,{machine:{memory:compilerMemory}})).exports;
  const engines = new CompiledModules({machine:{memory,
    access:vm.vm_access,segment:vm.vm_segment,reserve:vm.vm_reserve,commit:vm.vm_commit,
    table:vm.vm_table,far_return:vm.vm_return,control:vm.vm_control}});
  const compilerInput = cc.compiler_arena_min(), compilerOutput = compilerInput + 8192;
  const compilerReport = compilerOutput + 65536;
  let data = new Bytes(memory.buffer), view = new DataView(memory.buffer);
  const input = vm.vm_arena_min(), rows = input + 8192, directoryOffset = input + 12288;
  const capacity = 4096, branches = directoryOffset + capacity * 32;
  const base = (branches + (capacity - 1) * 16 + 4095) & ~4095;
  const port = base + 2048, segments = base + 1408, codeView = base + 2112, pageRequest = base + 2176;
  const codeOffset = base + 32768, gdtOffset = base + 45056, stackOffset = base + 49152;
  const idtCodeOffset = base + 53248, bssOffset = base + 57344;
  const cmdlineCodeOffset = base + 61440, optionOffset = base + 65536;
  const relocated = 0x1000000n + BigInt(header.readUInt32LE(0x260)) - 0x320000n;
  const stack = relocated + 0x2ea400n, gdt = 0x12e6000n;
  assert.equal(stack,0x1e2c400n);
  data.set(header,input); data.set(command,input + 4096);
  assert.equal(vm.vm_boot_prepare(input,header.length,BigInt(meta.imageBytes),
    BigInt(meta.initramfsBytes),BigInt(meta.ramBytes),input + 4096,command.length),0);
  for (let i = 0; i < 6; ++i)
    assert.equal(vm.vm_boot_project(BigInt((i + 1) * 4096),base + (i + 2) * 4096,rows),1);
  assert.equal(vm.vm_boot_project(gdt,gdtOffset,rows),2);
  assert.equal(view.getBigUint64(rows,true),BigInt(meta.kernelOffset) + gdt - BigInt(meta.kernelAddress));
  assert.equal(view.getUint32(rows + 8,true),1024);
  data.set(last,gdtOffset); data.set(kernel,codeOffset); data.set(idtPage,idtCodeOffset);
  data.set(cmdlinePage,cmdlineCodeOffset);
  assert.equal(vm.vm_boot_project(0x12e4000n,optionOffset,rows),2);
  assert.equal(view.getBigUint64(rows,true),BigInt(meta.kernelOffset) + 0x2e4000n);
  data.set(optionPage,optionOffset);
  assert.equal(vm.vm_boot_project(stack & ~4095n,stackOffset,rows),0);
  assert.equal(vm.vm_boot_project(0x12ea000n,bssOffset,rows),0);
  assert.equal(vm.vm_boot_initial_state(base),0); assert.equal(vm.vm_boot_initial_segments(segments),0);
  const pages = Array.from({length:6},(_,i) => [BigInt((i + 1) * 4096),base + (i + 2) * 4096]);
  pages.push([0x1000000n,codeOffset],[0x12e2000n,cmdlineCodeOffset],[0x12e3000n,idtCodeOffset],
    [0x12e4000n,optionOffset],[gdt,gdtOffset],[0x12ea000n,bssOffset],[stack & ~4095n,stackOffset]);
  for (const [i,[address,offset]] of pages.entries()) {
    const at = directoryOffset + i * 32;
    view.setBigUint64(at,address,true); view.setUint32(at + 8,offset - base,true);
    view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true);
    data.fill(0,at + 20,at + 32);
  }
  view.setBigUint64(port,9n,true);
  assert.equal(vm.vm_open(base,data.length - base,4096,directoryOffset,pages.length,capacity,branches,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  // No A/D warmup, candidate RIP list or native prefix modules. C vm_code
  // projects the current translation. This single-owner Worker pins RAM,
  // directory and CPU context across async engine compilation/admission.
  const table = vm.__indirect_function_table, slot = table.grow(1);
  assert(slot >= vm.vm_slot_min());
  let admissions = 0, retired = 0, emittedBytes = 0, copiedCodeBytes = 0;
  let engineMs = 0, coldMs = 0, executionMs = 0;
  let supplyMs = 0, pageSupplies = 0, sourceExtentBytes = 0, quantumYields = 0;
  let repeatInitialState, repeatInitialSegments, repeatComparedBytes = 0;
  let firstRepeatWait;
  let bssInitialState, bssInitialSegments, bssComparedBytes = 0;
  let memsetInput, memsetComparedBytes = 0, memsetReturns = 0;
  const trace = [];
  const relocationTrace = [];
  const cold = new Bytes(compilerMemory.buffer), report = new DataView(compilerMemory.buffer);
  const rip = () => view.getBigUint64(base + 384,true);
  async function supplyPhysical() {
    let status = vm.vm_page_prepare(port,pageRequest);
    if (status === -3 && memory.buffer.byteLength < 128 * 65536) {
      memory.grow(8); data = new Bytes(memory.buffer); view = new DataView(memory.buffer);
      assert.equal(vm.vm_grow(),0); status = vm.vm_page_prepare(port,pageRequest);
    }
    assert.equal(status,0);
    const ticket = view.getBigUint64(pageRequest + 40,true);
    const offset = view.getUint32(pageRequest + 24,true);
    const kind = view.getUint32(pageRequest + 32,true), bytes = view.getUint32(pageRequest + 28,true);
    assert.equal(view.getBigUint64(pageRequest,true),9n);
    assert(offset >= base + 4096 && offset + 4096 <= data.length,'C-chosen virgin payload slot');
    if (kind === 2 || kind === 3) {
      assert(typeof readExtent === 'function','authenticated bounded extent reader');
      const extent = await readExtent(kind,Number(view.getBigUint64(pageRequest + 16,true)),bytes);
      assert.equal(extent.length,bytes); assert(bytes > 0 && bytes <= 4096);
      data.set(extent,offset); data.fill(0,offset + bytes,offset + 4096); sourceExtentBytes += bytes;
    } else { assert(kind === 0 || kind === 1,'known initial page kind'); assert.equal(bytes,0); }
    assert.equal(vm.vm_page_commit(port,ticket),0); ++pageSupplies;
  }
  function relocationInputs() {
    assert.equal(retired,378); assert.equal(rip(),0x1000281n);
    assert.equal(view.getBigUint64(base + 416,true),32n);
    assert.equal(view.getBigUint64(base + 32,true),stack);
    assert.equal(view.getBigUint64(base + 392,true),0x402n);
    assert.equal(view.getBigUint64(base + 48,true),0x12e63f8n);
    assert.equal(view.getBigUint64(base + 56,true),relocated + 0x2e63f8n);
    assert.equal(view.getBigUint64(base + 8,true),0x5cc80n);
    repeatInitialState = data.slice(base,base + stateBytes.length);
    repeatInitialSegments = data.slice(segments,segments + segmentBytes.length);
  }
  function relocationObservation() {
    const expected = new Bytes(repeatInitialState);
    expected.writeBigUInt64LE(0n,8); expected.writeBigUInt64LE(0xfffff8n,48);
    expected.writeBigUInt64LE(relocated - 8n,56); expected.writeBigUInt64LE(0x1000284n,384);
    expected.writeBigUInt64LE(379n,1128);
    assert(data.subarray(base,base + expected.length).equals(expected),'complete REP CPU observation');
    assert(data.subarray(segments,segments + segmentBytes.length).equals(repeatInitialSegments),'REP hidden-cache observation');
    // Independent diagnostic observation, not guest execution or a JS MMU.
    // Both source/destination offsets are borrowed from the C-MMU provider.
    const length = kernelBytes;
    for (let at = 0; at < length; at += 4096) {
      assert.equal(vm.vm_code(port,0x1000000n + BigInt(at),codeView),0n);
      const source = view.getUint32(codeView + 16,true);
      assert.equal(vm.vm_code(port,relocated + BigInt(at),codeView),0n);
      const destination = view.getUint32(codeView + 16,true);
      const bytes = Math.min(4096,length - at);
      assert(data.subarray(source,source + bytes).equals(data.subarray(destination,destination + bytes)),
        `C-borrowed relocation memory observation at ${at}`);
      repeatComparedBytes += bytes;
    }
  }
  async function step(limit) {
    const entry = rip();
    if (entry === relocated + 0x2e2700n) {
      assert(!memsetInput,'no nested diagnostic memset');
      assert.equal(view.getBigUint64(base + 48,true),0n);
      memsetInput = {address:view.getBigUint64(base + 56,true),bytes:view.getBigUint64(base + 16,true)};
      assert(memsetInput.bytes === 16n || memsetInput.bytes === 131072n,'independent shipped memset sizes');
    }
    if (entry === 0x1000281n && !repeatInitialState) relocationInputs();
    if (entry === relocated + 0x2ded17n && !bssInitialState) {
      assert.equal(retired,391);
      assert.equal(view.getBigUint64(base,true),0n);
      assert.equal(view.getBigUint64(base + 56,true),relocated + 0x2e6400n);
      assert.equal(view.getBigUint64(base + 8,true),(0x2fe560n - 0x2e6400n) / 8n);
      bssInitialState = data.slice(base,base + stateBytes.length);
      bssInitialSegments = data.slice(segments,segments + segmentBytes.length);
    }
    data.fill(0xa5,codeView,codeView + 24);
    let projection = vm.vm_code(port,entry,codeView);
    for (let waits = 0; projection === 2n && waits < 4; ++waits) {
      const start = performance.now(); await supplyPhysical(); supplyMs += performance.now() - start;
      projection = vm.vm_code(port,entry,codeView);
    }
    if (projection) {
      assert(data.subarray(codeView,codeView + 24).every(byte => byte === 0xa5),'rejected view publication');
      return {kind:'fetch',result:String(projection),entry:`0x${entry.toString(16)}`,
        requestAddress:`0x${view.getBigUint64(port + 32,true).toString(16)}`,
        requestBytes:view.getUint32(port + 40,true),requestAccess:view.getUint32(port + 44,true)};
    }
    const address = view.getBigUint64(codeView,true), generation = view.getBigUint64(codeView + 8,true);
    const offset = view.getUint32(codeView + 16,true), bytes = view.getUint32(codeView + 20,true);
    assert.equal(address,entry & ~4095n); assert.equal(generation,9n); assert.equal(bytes,4096);
    assert(offset >= base + 4096 && offset + bytes <= data.length,'C-verified resident view');
    cold.set(data.subarray(offset,offset + bytes),compilerInput); copiedCodeBytes += bytes;
    const started = performance.now();
    assert.equal(cc.compiler_open_pages(compilerInput,1,address,generation),0);
    cold.fill(0xa5,compilerOutput,compilerReport + 80);
    const status = cc.compiler_emit(entry,limit,compilerOutput,65536,compilerReport);
    coldMs += performance.now() - started;
    if (status) {
      assert(cold.subarray(compilerOutput,compilerReport + 80).every(byte => byte === 0xa5),'refusal cannot publish');
      return {kind:'compile',status,entry:`0x${entry.toString(16)}`};
    }
    const length = Number(report.getBigUint64(compilerReport + 40,true));
    const sourceBytes = Number(report.getBigUint64(compilerReport + 32,true));
    const instructions = Number(report.getBigUint64(compilerReport + 24,true));
    assert(length > 0 && length <= 65536 && instructions > 0 && instructions <= limit);
    const beforeEngine = performance.now();
    const instance = await engines.get(entry,cold.subarray(compilerOutput,compilerOutput + length));
    engineMs += performance.now() - beforeEngine; emittedBytes += length;
    table.set(slot,instance.exports.cut);
    view.setBigUint64(rows,entry,true); view.setUint32(rows + 8,sourceBytes,true);
    view.setUint32(rows + 12,instructions,true); view.setUint32(rows + 16,slot,true);
    view.setUint32(rows + 20,0,true);
    assert.equal(vm.vm_bind_execution(rows,1,generation),0); ++admissions;
    let result;
    for (let resumes = 0; resumes < 8192; ++resumes) {
      const beforeExecution = performance.now();
      result = vm.vm_run(port,generation,1);
      executionMs += performance.now() - beforeExecution;
      if (result !== 2n && result !== 10n) break;
      assert.equal(vm.vm_completed(),0); assert.equal(vm.vm_source_retired(),0n);
      assert.equal(rip(),entry); assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired));
      if (result === 10n) { ++quantumYields; continue; }
      if (entry === 0x1000281n && !firstRepeatWait) {
        firstRepeatWait = {address:`0x${view.getBigUint64(port + 32,true).toString(16)}`,
          bytes:view.getUint32(port + 40,true),access:view.getUint32(port + 44,true)};
        assert.equal(firstRepeatWait.address,'0x1e283f8');
        assert.equal(firstRepeatWait.bytes,8); assert.equal(firstRepeatWait.access,18);
      }
      const start = performance.now(); await supplyPhysical(); supplyMs += performance.now() - start;
    }
    const done = Number(vm.vm_source_retired());
    trace.push({entry:`0x${entry.toString(16)}`,instructions:done,next:`0x${rip().toString(16)}`,result:String(result),
      rax:`0x${view.getBigUint64(base,true).toString(16)}`,
      rcx:`0x${view.getBigUint64(base + 8,true).toString(16)}`,
      rdx:`0x${view.getBigUint64(base + 16,true).toString(16)}`,
      rdi:`0x${view.getBigUint64(base + 56,true).toString(16)}`,
      flags:`0x${view.getBigUint64(base + 392,true).toString(16)}`});
    if (entry === 0x10002a1n) {
      assert.equal(rip(),relocated + 0x2ded00n,'independent shipped relocation trampoline destination');
      assert.equal(view.getBigUint64(base,true),rip());
    }
    if (retired >= 384 && relocationTrace.length < 16)
      relocationTrace.push({...trace.at(-1),source:Array.from(cold.subarray(compilerInput + Number(entry - address),
        compilerInput + Number(entry - address) + Math.min(sourceBytes,24))),
        rax:`0x${view.getBigUint64(base,true).toString(16)}`,rsp:`0x${view.getBigUint64(base + 32,true).toString(16)}`});
    if (trace.length > 16) trace.shift();
    if (result !== 1n && result !== 5n)
      return {kind:'execution',result:String(result),entry:`0x${entry.toString(16)}`,
        completed:vm.vm_completed(),sourceRetired:done,
        faultAddress:`0x${view.getBigUint64(port + 16,true).toString(16)}`,
        faultVector:view.getUint32(port + 24,true),faultError:view.getUint32(port + 28,true),
        cpu:{registers:Array.from({length:16},(_,i) => `0x${view.getBigUint64(base + i * 8,true).toString(16)}`),
          cr0:`0x${view.getBigUint64(base + 400,true).toString(16)}`,
          cr3:`0x${view.getBigUint64(base + 408,true).toString(16)}`,
          cr4:`0x${view.getBigUint64(base + 416,true).toString(16)}`,
          efer:`0x${view.getBigUint64(base + 424,true).toString(16)}`},
        // Request fields can be from an older wait; fault fields above are
        // authoritative only for a pending architectural fault result.
        requestAddress:`0x${view.getBigUint64(port + 32,true).toString(16)}`,
        requestBytes:view.getUint32(port + 40,true),requestAccess:view.getUint32(port + 44,true)};
    assert.equal(vm.vm_completed(),1); assert.equal(done,instructions);
    retired += done; assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired));
    if (entry === 0x1000281n) relocationObservation();
    if (entry === relocated + 0x2ded17n) {
      const expected = new Bytes(bssInitialState);
      expected.writeBigUInt64LE(0n,8); expected.writeBigUInt64LE(relocated + 0x2fe560n,56);
      expected.writeBigUInt64LE(entry + 3n,384); expected.writeBigUInt64LE(392n,1128);
      assert(data.subarray(base,base + expected.length).equals(expected),'complete BSS REP CPU observation');
      assert(data.subarray(segments,segments + segmentBytes.length).equals(bssInitialSegments),'BSS REP cache observation');
      const end = relocated + 0x2fe560n;
      for (let address = relocated + 0x2e6400n; address < end; ) {
        assert.equal(vm.vm_code(port,address,codeView),0n);
        const offset = view.getUint32(codeView + 16,true) + Number(address & 4095n);
        const length = Math.min(4096 - Number(address & 4095n),Number(end - address));
        assert(data.subarray(offset,offset + length).every(byte => byte === 0),'C-borrowed BSS zero observation');
        bssComparedBytes += length; address += BigInt(length);
      }
    }
    if (entry === relocated + 0x2e2743n && memsetInput) {
      assert.equal(view.getBigUint64(base,true),memsetInput.address,'memset returns its original destination');
      const end = memsetInput.address + memsetInput.bytes;
      for (let address = memsetInput.address; address < end; ) {
        assert.equal(vm.vm_code(port,address,codeView),0n);
        const offset = view.getUint32(codeView + 16,true) + Number(address & 4095n);
        const length = Math.min(4096 - Number(address & 4095n),Number(end - address));
        assert(data.subarray(offset,offset + length).every(byte => byte === 0),'C-borrowed scalar memset observation');
        memsetComparedBytes += length; address += BigInt(length);
      }
      ++memsetReturns; memsetInput = null;
    }
    return null;
  }
  try {
    // Bound the quota to the existing independent 86-instruction observation,
    // not a JavaScript-decoded instruction or branch boundary.
    while (retired < 86) {
      const limit = view.getUint32(segments + 4,true) ? 1 : 86 - retired;
      const stopped = await step(limit);
      assert(!stopped,`before independent witness: ${JSON.stringify(stopped)}`);
    }
    assert.equal(rip(),0x12e299en);
    const expected = new Bytes(stateBytes), expectedSegments = new Bytes(segmentBytes);
    expected.writeBigUInt64LE(0x6fn,0); expected.writeBigUInt64LE(0x12000n,8);
    expected.writeBigUInt64LE(0x6en,16); expected.writeBigUInt64LE(relocated,24);
    expected.writeBigUInt64LE(0x1000n,15 * 8);
    expected.writeBigUInt64LE(stack - 216n,32); expected.writeBigUInt64LE(relocated + 0x31f000n,40);
    expected.writeBigUInt64LE(0x12e4fa6n,48); expected.writeBigUInt64LE(0x2002n,56);
    expected.writeBigUInt64LE(0xffffe001n,64); expected.writeBigUInt64LE(3n,72);
    expected.writeBigUInt64LE(0x12e4fa6n,88); expected.writeBigUInt64LE(0x1000n,96);
    expected.writeBigUInt64LE(0x12e299en,384); expected.writeBigUInt64LE(2n,392);
    expected.writeBigUInt64LE(last.readBigUInt64LE(2) + gdt,448);
    expected.writeBigUInt64LE(BigInt(last.readUInt16LE(0)),456);
    expected.writeBigUInt64LE(0x12e6050n,464); expected.writeBigUInt64LE(BigInt(last.readUInt16LE(0x40)),472);
    for (const rank of [0,2,3,4,5]) {
      expected.writeBigUInt64LE(0n,432 + (6 + rank) * 8);
      expectedSegments.fill(0,8 + rank * 16,8 + (rank + 1) * 16);
      expectedSegments.writeUInt32LE(0x10000,8 + rank * 16 + 12);
    }
    assert.equal(view.getBigUint64(gdtOffset + Number(last.readBigUInt64LE(2)) + 16,true),0x00af9b000000ffffn);
    expectedSegments.writeBigUInt64LE(0n,24); expectedSegments.writeUInt32LE(0xffffffff,32);
    expectedSegments.writeUInt32LE(0xa09b,36); expected.writeBigUInt64LE(86n,1128);
    assert(data.subarray(base,base + stateBytes.length).equals(expected),'complete 86-instruction CPU observation');
    assert(data.subarray(segments,segments + segmentBytes.length).equals(expectedSegments),'hidden-cache observation');
    assert.equal(view.getBigUint64(bssOffset + 0x438,true),0x1000n);
    for (const [distance,value] of [[8n,0x1000267n],[16n,0n],[24n,0n],
        [32n,0x1000000n],[40n,relocated],[216n,0x12e3d93n]])
      assert.equal(view.getBigUint64(stackOffset + Number((stack - distance) & 4095n),true),value);
    let stopped;
    // Real scalar startup loops can retire far more than a tiny probe quota.
    // These are diagnostic limits, never synthetic execution completion.
    const maximumAdmissions = 300000, maximumRetired = 500000;
    while (admissions < maximumAdmissions && retired < maximumRetired) {
      stopped = await step(view.getUint32(segments + 4,true) ? 1 : 1024);
      if (stopped) break;
    }
    if (!stopped) stopped = {kind:'quota',entry:`0x${rip().toString(16)}`,admissions,retired,
      maximumAdmissions,maximumRetired};
    assert(retired >= 379,'REP really completed, not only accepted');
    assert.equal(repeatComparedBytes,kernelBytes);
    return {format:'browser-bzimage-startup-v1',status:'pass',linuxBoot:'not-achieved',
      retired,modules:engines.stats().compilations,admissions,liveSlots:1,manualBranchEntries:0,
      independentStateCheckpoint:86,relocationRegisterCheckpoint:378,
      nextRip:`0x${rip().toString(16)}`,nextGate:stopped,
      repeatAdmission:'completed through one pinned module; all copied bytes checked through C-MMU views',
      firstRepeatWait,pageSupplies,sourceExtentBytes,quantumYields,repeatComparedBytes,bssComparedBytes,
      memsetComparedBytes,memsetReturns,
      residentPages:vm.vm_page_count(),descriptorCapacity:capacity,descriptorBytes:capacity * 32 + (capacity - 1) * 16,
      guestExecution:'C-Wasm table dispatcher/MMU',coldCompilation:'C-Wasm decoder/planner/emitter',
      guestMemoryCallback:'C-Wasm, not JavaScript',sourceProjection:'C-MMU borrowed page, no JS virtual-to-physical mapping',
      emittedBytes,copiedCodeBytes,engineReuse:engines.stats(),
      timingMs:{cold:coldMs,engine:engineMs,execution:executionMs,supply:supplyMs},trace,relocationTrace,
      providerBytes:providerBytes.byteLength,compilerBytes:compilerBytes.byteLength,
      memoryBytes:memory.buffer.byteLength,coldMemoryBytes:compilerMemory.buffer.byteLength};
  } finally {
    table.set(slot,null); engines.close(); cc.compiler_close(); vm.vm_close();
  }
}
