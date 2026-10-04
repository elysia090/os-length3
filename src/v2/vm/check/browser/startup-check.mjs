// Authenticated bzImage pages -> cold C compiler -> C MMU/table dispatcher.
// JavaScript transports bounded pages/metadata; it does not decode or execute
// guest instructions, resolve guest branches, or implement guest exceptions.
import {CompiledModules} from '../../../web/compiled-modules.mjs';
import {CutTrace} from './cut-trace.mjs';
import {CompilerOutput} from './compiler-output.mjs';
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

export async function checkStartup(reader,providerBytes,compilerBytes,readExtent,
    {extended = false,onProgress = () => {},decompression,immutableImage,
      utcSeconds = BigInt(Math.floor(Date.now()/1000))} = {}) {
  const startedAt=performance.now();
  const read = async name => new Bytes(await reader(name));
  const header = await read('boot.header');
  let command = await read('boot.command');
  if (immutableImage) {
    assert(Number.isSafeInteger(immutableImage.bytes) && immutableImage.bytes>0
      && immutableImage.bytes<=0x10000000 && immutableImage.address==='0x30000000','immutable physical image descriptor');
    const extent=`0x${immutableImage.bytes.toString(16)}`, address=immutableImage.address;
    command=new Bytes(new TextEncoder().encode(`${new TextDecoder().decode(command)} memmap=${extent}$${address} phram.phram=system,${address},${extent}`));
  }
  const kernel = await read('boot.kernel-page'), last = await read('boot.kernel-last-page');
  const stateBytes = await read('boot.state'), segmentBytes = await read('boot.segments');
  const meta = JSON.parse(new TextDecoder().decode(await read('boot.json')));
  const kernelBytes = header.readUInt32LE(0x1f4) * 16;
  const idtPage = await read('call.extra-page'), cmdlinePage = await read('cmdline.extra-page');
  const optionPage = await read('option.extra-page');
  const maximumMemoryPages = extended ? 512 : 128;
  const memory = new WebAssembly.Memory({initial:extended ? 16 : 8,maximum:maximumMemoryPages});
  const provider = await WebAssembly.compile(providerBytes);
  assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
  const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
  const compilerMemory = new WebAssembly.Memory({initial:16,maximum:32});
  const compilerModule = await WebAssembly.compile(compilerBytes);
  assert.deepEqual(WebAssembly.Module.imports(compilerModule),[{module:'machine',name:'memory',kind:'memory'}]);
  const cc = (await WebAssembly.instantiate(compilerModule,{machine:{memory:compilerMemory}})).exports;
  const engines = new CompiledModules({machine:{memory,
    access:vm.vm_access,segment:vm.vm_segment,reserve:vm.vm_reserve,commit:vm.vm_commit,
    reserve_pair:vm.vm_reserve_pair,commit_pair:vm.vm_commit_pair,
    write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end,
    table:vm.vm_table,far_return:vm.vm_return,control:vm.vm_control,iret:vm.vm_iret,msr:vm.vm_msr,interrupt_flag:vm.vm_flag,
    software_interrupt:vm.vm_software_interrupt,
    io:vm.vm_io,time:vm.vm_time,debug:vm.vm_debug}},
    {maximumEntries:1024,maximumBytes:262144});
  const compilerInput = cc.compiler_arena_min(), compilerOutput = compilerInput + 8192;
  const compilerReport = compilerOutput + 65536;
  let data = new Bytes(memory.buffer), view = new DataView(memory.buffer);
  const input = vm.vm_arena_min(), rows = input + 8192, directoryOffset = input + 12288;
  const capacity = extended ? 8192 : 4096, branches = directoryOffset + capacity * 32;
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
  if (immutableImage)
    assert.equal(vm.vm_boot_image(BigInt(immutableImage.address),BigInt(immutableImage.bytes)),0);
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
  const machineGeneration=9n;
  view.setBigUint64(port,machineGeneration,true);
  assert.equal(vm.vm_open(base,data.length - base,4096,directoryOffset,pages.length,capacity,branches,machineGeneration),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_rtc_start(port,machineGeneration,utcSeconds),0);
  // No A/D warmup, candidate RIP list or native prefix modules. C vm_code
  // projects the current translation. This single-owner Worker pins RAM,
  // directory and CPU context across async engine compilation/admission.
  const table = vm.__indirect_function_table, firstSlot = vm.vm_slot_min();
  const sourceCapacity = vm.vm_source_capacity(), installedSlots = new Set();
  table.grow(Math.max(0,firstSlot + sourceCapacity - table.length));
  let admissions = 0, retired = 0, emittedBytes = 0, copiedCodeBytes = 0;
  const exceptions = [];
  let sourceHits = 0, sourceMisses = 0, admissionMs = 0;
  let resourceGate;
  let engineMs = 0, coldMs = 0, executionMs = 0;
  let supplyMs = 0, pageSupplies = 0, sourceExtentBytes = 0, quantumYields = 0;
  let clockEvents = 0, boundaryClockEvents = 0, deferredClockPolls = 0, sampledClockMs = 0;
  const consoleOutput=new Uint8Array(16384);
  let consoleBytes=0;
  let repeatInitialState, repeatInitialSegments, repeatComparedBytes = 0;
  let relocationRegisterCheckpoint;
  let firstRepeatWait;
  let bssInitialState, bssInitialSegments, bssComparedBytes = 0;
  let memsetInput, memsetComparedBytes = 0, memsetReturns = 0;
  let decompressedOutput, linuxEntry;
  const decompressionEntry = decompression ? BigInt(decompression.observationRip) : 0n;
  const linuxEntryAddress = decompression ? BigInt(decompression.elfEntry) : 0n;
  const trace = new CutTrace();
  const relocationTrace = [];
  const cold = new Bytes(compilerMemory.buffer), report = new DataView(compilerMemory.buffer);
  const compilerOutputWitness=new CompilerOutput(cold,compilerOutput,65536,compilerReport);
  const rip = () => view.getBigUint64(base + 384,true);
  let reportedRetired=0,reportedAdmissions=0;
  function reportProgress() {
    reportedRetired=retired;reportedAdmissions=admissions;
    // Read-only diagnostics: neither a CPU snapshot nor a source retirement.
    // Admission/quantum progress also exposes work inside long instructions.
    onProgress({format:'browser-bzimage-startup-v1',status:'running',linuxBoot:'not-achieved',
      retired,admissions,nextRip:`0x${rip().toString(16)}`,quantumYields,
      architecturalRCX:`0x${view.getBigUint64(base+8,true).toString(16)}`,
      residentPages:vm.vm_page_count(),memoryBytes:memory.buffer.byteLength,
      console:{acceptedBytes:consoleBytes,text:new TextDecoder().decode(consoleOutput.subarray(0,consoleBytes))},
      sourceReuse:{hits:sourceHits,misses:sourceMisses,capacity:sourceCapacity},engineReuse:engines.stats(),
      compilerOutput:compilerOutputWitness.stats(),
      timingMs:{cold:coldMs,engine:engineMs,execution:executionMs,supply:supplyMs,admission:admissionMs,
        elapsedCheck:performance.now()-startedAt}});
  }
  async function supplyPhysical() {
    let status = vm.vm_page_prepare(port,pageRequest);
    if (status === -3 && vm.vm_page_count() < capacity && memory.buffer.byteLength < maximumMemoryPages * 65536) {
      memory.grow(8); data = new Bytes(memory.buffer); view = new DataView(memory.buffer);
      assert.equal(vm.vm_grow(),0); status = vm.vm_page_prepare(port,pageRequest);
    }
    if (status === -3) {
      resourceGate = {kind:'resident-quota',residentPages:vm.vm_page_count(),capacity,
        memoryBytes:memory.buffer.byteLength,maximumMemoryBytes:maximumMemoryPages * 65536};
      return false;
    }
    if (status === -4) {
      resourceGate={kind:'physical-source',status,
        requestAddress:`0x${view.getBigUint64(port+32,true).toString(16)}`,
        requestBytes:view.getUint32(port+40,true),requestAccess:view.getUint32(port+44,true),
        contract:'outside initial boot source map; firmware/device contract required, not zero RAM'};
      return false;
    }
    assert.equal(status,0);
    const ticket = view.getBigUint64(pageRequest + 40,true);
    const offset = view.getUint32(pageRequest + 24,true);
    const kind = view.getUint32(pageRequest + 32,true), bytes = view.getUint32(pageRequest + 28,true);
    assert.equal(view.getBigUint64(pageRequest,true),9n);
    assert(offset >= base + 4096 && offset + 4096 <= data.length,'C-chosen virgin payload slot');
    if (kind === 2 || kind === 3 || kind === 5) {
      assert(typeof readExtent === 'function','authenticated bounded extent reader');
      const extent = await readExtent(kind,Number(view.getBigUint64(pageRequest + 16,true)),bytes);
      assert.equal(extent.length,bytes); assert(bytes > 0 && bytes <= 4096);
      data.set(extent,offset); data.fill(0,offset + bytes,offset + 4096); sourceExtentBytes += bytes;
    } else { assert(kind === 0 || kind === 1 || kind === 4,'known initial page kind'); assert.equal(bytes,0); }
    assert.equal(vm.vm_page_commit(port,ticket),0); ++pageSupplies;
    return true;
  }
  async function deliverFault(result,entry) {
    if ((result & 7n) !== 3n) return null;
    const event = {entry:`0x${entry.toString(16)}`,vector:view.getUint32(port + 24,true),
      error:view.getUint32(port + 28,true),address:`0x${view.getBigUint64(port + 16,true).toString(16)}`};
    let deliveryResult;
    for (let waits = 0; waits < 16; ++waits) {
      const start = performance.now(); deliveryResult = vm.vm_fault(port);
      executionMs += performance.now() - start;
      if (deliveryResult !== 2n) break;
      const beforeSupply = performance.now(); const supplied = await supplyPhysical();
      supplyMs += performance.now() - beforeSupply;
      if (!supplied) return {entry:`0x${entry.toString(16)}`,deliveryResult:String(deliveryResult),...resourceGate};
    }
    event.deliveryResult = String(deliveryResult); event.nextRip = `0x${rip().toString(16)}`;
    event.cr2 = `0x${view.getBigUint64(base + 432,true).toString(16)}`;
    exceptions.push(event);
    if (exceptions.length > 16) exceptions.shift();
    // C owns the IDT, frame, handler target and page-wait continuation.
    // A secondary fault/unsupported delivery stops this probe explicitly;
    // it is not reclassified as successful boot or recursively skipped.
    if ((deliveryResult & 7n) === 3n) event.secondary = {
      vector:view.getUint32(port + 24,true),error:view.getUint32(port + 28,true),
      address:`0x${view.getBigUint64(port + 16,true).toString(16)}`};
    return event;
  }
  function relocationInputs() {
    // The unchanged command retains its independent fixed 378-instruction
    // witness. Image attachment extends the actual command: its parser work
    // is not certified by that old count. The REP/BSS checks below instead
    // preserve the observed incoming count and assert their exact +1/+13
    // transitions, complete CPU/cache state and every transferred byte.
    if (!immutableImage) assert.equal(retired,378);
    relocationRegisterCheckpoint=retired; assert.equal(rip(),0x1000281n);
    assert.equal(view.getBigUint64(base + 416,true),32n);
    assert.equal(view.getBigUint64(base + 32,true),stack);
    assert.equal(view.getBigUint64(base + 392,true),0x402n);
    assert.equal(view.getBigUint64(base + 48,true),0x12e63f8n);
    assert.equal(view.getBigUint64(base + 56,true),relocated + 0x2e63f8n);
    assert.equal(view.getBigUint64(base + 8,true),0x5cc80n);
    repeatInitialState = data.slice(base,base + stateBytes.length);
    repeatInitialSegments = data.slice(segments,segments + segmentBytes.length);
  }
  async function observeDecompression(entry) {
    assert.equal(decompression.format,'shipped-kernel-decompression-observation-v1');
    assert.equal(decompression.pageBytes,4096);
    assert.equal(decompression.outputBytes,14622864);
    assert.equal(decompression.pages.length,Math.ceil(decompression.outputBytes / 4096));
    assert.equal(vm.vm_code(port,entry,codeView),0n);
    const instruction = view.getUint32(codeView + 16,true) + Number(entry & 4095n);
    assert(data.subarray(instruction,instruction + decompression.observationSource.length)
      .equals(decompression.observationSource),'exact native ELF-header-read witness');
    const savedState = data.slice(base,base + stateBytes.length);
    const savedSegments = data.slice(segments,segments + segmentBytes.length);
    let comparedBytes = 0;
    for (let rank = 0; rank < decompression.pages.length; ++rank) {
      const address = BigInt(decompression.outputAddress) + BigInt(rank * 4096);
      assert.equal(vm.vm_code(port,address,codeView),0n);
      const offset = view.getUint32(codeView + 16,true);
      const bytes = Math.min(4096,decompression.outputBytes - rank * 4096);
      // A bounded independent observation: no whole output reconstruction,
      // host decompressor, address translation or replacement guest bytes.
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',data.subarray(offset,offset + bytes)));
      const hex = Array.from(digest,byte => byte.toString(16).padStart(2,'0')).join('');
      assert.equal(hex,decompression.pages[rank]); comparedBytes += bytes;
    }
    assert(data.subarray(base,base + stateBytes.length).equals(savedState),'decompression observation preserves CPU');
    assert(data.subarray(segments,segments + segmentBytes.length).equals(savedSegments),'decompression observation preserves caches');
    decompressedOutput = {entry:`0x${entry.toString(16)}`,comparedBytes,pages:decompression.pages.length,
      sha256:decompression.outputSha256,gzipCrc32:decompression.gzipCrc32,
      oracle:'independent gzip CRC/ISIZE verified; exact per-page SHA-256 comparison before ELF PT_LOAD moves',
      guestCrc:'PREBOOT uses raw inflate; this is independent output validation, not a guest CRC check'};
    onProgress({format:'browser-bzimage-startup-v1',status:'running',linuxBoot:'not-achieved',retired,admissions,
      nextRip:`0x${entry.toString(16)}`,decompressedOutput});
  }
  function relocationObservation() {
    const expected = new Bytes(repeatInitialState);
    expected.writeBigUInt64LE(0n,8); expected.writeBigUInt64LE(0xfffff8n,48);
    expected.writeBigUInt64LE(relocated - 8n,56); expected.writeBigUInt64LE(0x1000284n,384);
    expected.writeBigUInt64LE(repeatInitialState.readBigUInt64LE(1128)+1n,1128);
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
  let externalInterrupts=0;
  function acceptClock(generation) {
    assert.equal(view.getUint32(port+40,true),0);
    assert.equal(view.getUint32(port+44,true),0x100);
    // Only measured C execution advances this diagnostic clock. Compilation,
    // delivery and UI stalls are paused; no guest counter is synthesized.
    assert.equal(vm.vm_clock_commit(port,generation,view.getBigUint64(port+32,true),
      BigInt(Math.round(executionMs*1000000))),0);
    sampledClockMs=executionMs; ++clockEvents;
  }
  async function step(limit) {
    // A supervisor clock event is not a guest time instruction. C permits it
    // only between completed cuts, outside pinned fault/page/IO frontiers.
    if(executionMs-sampledClockMs>=1){
      const before=rip(), beforeRetired=view.getBigUint64(base+1128,true);
      const sample=vm.vm_clock_poll(port,machineGeneration);
      if(sample===18n){
        acceptClock(machineGeneration);
        assert.equal(vm.vm_clock_poll(port,machineGeneration),0n); ++boundaryClockEvents;
      }else{ assert.equal(sample,6n); ++deferredClockPolls; }
      assert.equal(rip(),before); assert.equal(view.getBigUint64(base+1128,true),beforeRetired);
    }
    // C drains asynchronous architectural events before source projection;
    // a pending IRQ has priority over a fault while fetching the next opcode.
    const interrupted=rip();let boundary=vm.vm_boundary(port,9n);
    for(let waits=0;boundary===2n && waits<8192;++waits){
      const start=performance.now(),supplied=await supplyPhysical();supplyMs+=performance.now()-start;
      if(!supplied)return {...resourceGate,entry:`0x${interrupted.toString(16)}`};
      boundary=vm.vm_boundary(port,9n);
    }
    if(boundary){
      assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
      assert.equal(view.getBigUint64(base+1128,true),BigInt(retired));
      if(boundary===1n){++externalInterrupts;return null;}
      const delivered=await deliverFault(boundary,interrupted);
      if(delivered)return delivered.deliveryResult==='0'?null:{kind:'interrupt-delivery',...delivered};
      return {kind:'interrupt-boundary',result:String(boundary),entry:`0x${interrupted.toString(16)}`};
    }
    const entry = rip();
    if (decompression && !decompressedOutput && entry === decompressionEntry) await observeDecompression(entry);
    if (entry === relocated + 0x2e2700n) {
      assert(!memsetInput,'no nested diagnostic memset');
      assert.equal(view.getBigUint64(base + 48,true),0n);
      memsetInput = {address:view.getBigUint64(base + 56,true),bytes:view.getBigUint64(base + 16,true)};
      assert(memsetInput.bytes === 16n || memsetInput.bytes === 131072n,'independent shipped memset sizes');
    }
    if (entry === 0x1000281n && !repeatInitialState) relocationInputs();
    if (entry === relocated + 0x2ded17n && !bssInitialState) {
      assert.equal(retired,relocationRegisterCheckpoint+13);
      assert.equal(view.getBigUint64(base,true),0n);
      assert.equal(view.getBigUint64(base + 56,true),relocated + 0x2e6400n);
      assert.equal(view.getBigUint64(base + 8,true),(0x2fe560n - 0x2e6400n) / 8n);
      bssInitialState = data.slice(base,base + stateBytes.length);
      bssInitialSegments = data.slice(segments,segments + segmentBytes.length);
    }
    data.fill(0xa5,codeView,codeView + 48);
    let beforeAdmission = performance.now();
    let projection = vm.vm_source_query(port,entry,limit,codeView,rows);
    admissionMs += performance.now() - beforeAdmission;
    for (let waits = 0; (projection === 2n || projection === 5n) && waits < 4; ++waits) {
      if (projection === 2n) {
        const start = performance.now(); const supplied = await supplyPhysical(); supplyMs += performance.now() - start;
        if (!supplied) return {...resourceGate,entry:`0x${entry.toString(16)}`};
      }
      beforeAdmission = performance.now();
      projection = vm.vm_source_query(port,entry,limit,codeView,rows);
      admissionMs += performance.now() - beforeAdmission;
    }
    if (projection !== 0n && projection !== 1n) {
      assert(data.subarray(codeView,codeView + 48).every(byte => byte === 0xa5),'rejected view publication');
      const delivery = await deliverFault(projection,entry);
      if (delivery) return delivery.deliveryResult === '0' ? null : {kind:'exception-delivery',...delivery};
      return {kind:'fetch',result:String(projection),entry:`0x${entry.toString(16)}`,
        requestAddress:`0x${view.getBigUint64(port + 32,true).toString(16)}`,
        requestBytes:view.getUint32(port + 40,true),requestAccess:view.getUint32(port + 44,true)};
    }
    const address = view.getBigUint64(codeView,true), generation = view.getBigUint64(codeView + 8,true);
    const offset = view.getUint32(codeView + 16,true), bytes = view.getUint32(codeView + 20,true);
    assert.equal(address,entry & ~4095n); assert.equal(generation,machineGeneration); assert.equal(bytes,4096);
    assert(offset >= base + 4096 && offset + bytes <= data.length,'C-verified resident view');
    const slot = view.getUint32(rows + 16,true);
    assert(slot >= firstSlot && slot < firstSlot + sourceCapacity,'C-chosen bounded engine slot');
    if (projection === 1n) {
      ++sourceMisses;
      const construct = () => {
        const count = view.getUint32(codeView + 44,true) ? 2 : 1;
        for (let page = 0; page < count; ++page) {
          const at = codeView + page*24, physical = view.getUint32(at + 16,true);
          assert.equal(view.getBigUint64(at,true),address + BigInt(page*4096));
          assert.equal(view.getBigUint64(at + 8,true),generation);
          assert.equal(view.getUint32(at + 20,true),4096);
          assert(physical >= base + 4096 && physical + 4096 <= data.length,'C-verified source fragment');
          cold.set(data.subarray(physical,physical + 4096),compilerInput + page*4096);
          copiedCodeBytes += 4096;
        }
        const started = performance.now();
        assert.equal(cc.compiler_open_pages(compilerInput,count,address,generation),0);
        const status = compilerOutputWitness.emit(()=>cc.compiler_emit(entry,limit,compilerOutput,65536,compilerReport));
        coldMs += performance.now() - started; return status;
      };
      let status = construct();
      if (status === -105) {
        assert.equal(view.getUint32(codeView + 44,true),0,'only the first truncated instruction requests a tail');
        let following = vm.vm_source_extend(port,codeView,rows);
        for (let waits=0;following === 2n && waits<4;++waits) {
          const start=performance.now(), supplied=await supplyPhysical(); supplyMs += performance.now()-start;
          if (!supplied) return {...resourceGate,entry:`0x${entry.toString(16)}`};
          following=vm.vm_source_extend(port,codeView,rows);
        }
        if (following === 5n) return null; // Source pin changed: re-admit the same unretired RIP.
        if (following !== 1n) {
          const delivery=await deliverFault(following,entry);
          if (delivery) return delivery.deliveryResult === '0' ? null : {kind:'exception-delivery',...delivery};
          return {kind:'source-tail',result:String(following),entry:`0x${entry.toString(16)}`};
        }
        status = construct();
      }
      if (status) {
        const available = Math.min(15,4096 - Number(entry & 4095n));
        return {kind:'compile',status,entry:`0x${entry.toString(16)}`,
          source:Array.from(data.subarray(offset + Number(entry & 4095n),offset + Number(entry & 4095n) + available)),
          sourceAvailable:available,
          cpu:{registers:Array.from({length:16},(_,i) => `0x${view.getBigUint64(base + i*8,true).toString(16)}`),
            flags:`0x${view.getBigUint64(base + 392,true).toString(16)}`,
            cr3:`0x${view.getBigUint64(base + 408,true).toString(16)}`}};
      }
      const length = Number(report.getBigUint64(compilerReport + 40,true));
      const sourceBytes = Number(report.getBigUint64(compilerReport + 32,true));
      const instructions = Number(report.getBigUint64(compilerReport + 24,true));
      assert(length > 0 && length <= 65536 && instructions > 0 && instructions <= limit);
      const beforeEngine = performance.now();
      // The source owner's rotating slot is placement, not executable
      // identity. Keep a bounded engine candidate per C-selected coordinate;
      // CompiledModules still requires exact newly emitted bytes to reuse it.
      const instance = await engines.get(entry,cold.subarray(compilerOutput,compilerOutput + length));
      engineMs += performance.now() - beforeEngine; emittedBytes += length;
      table.set(slot,instance.exports.cut); installedSlots.add(slot);
      beforeAdmission = performance.now();
      assert.equal(vm.vm_source_publish(sourceBytes,instructions,rows),0);
      admissionMs += performance.now() - beforeAdmission;
    } else { ++sourceHits; assert(installedSlots.has(slot),'C hit requires its installed engine handle'); }
    const sourceBytes = view.getUint32(rows + 8,true), instructions = view.getUint32(rows + 12,true);
    assert.equal(view.getBigUint64(rows,true),entry);
    assert(instructions > 0 && instructions <= limit);
    assert.equal(vm.vm_bind_execution(rows,1,generation),0); ++admissions;
    let result;
    for (let resumes = 0; resumes < 8192; ++resumes) {
      const beforeExecution = performance.now();
      result = vm.vm_run(port,generation,1);
      executionMs += performance.now() - beforeExecution;
      if (result !== 2n && result !== 10n && result !== 18n && result !== 26n) break;
      assert.equal(vm.vm_completed(),0); assert.equal(vm.vm_source_retired(),0n);
      assert.equal(rip(),entry); assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired));
      if (result === 10n) {
        ++quantumYields;
        if(extended && !(quantumYields&255))reportProgress();
        continue;
      }
      if(result===26n){
        assert.equal(view.getUint32(port+40,true),1);assert.equal(view.getUint32(port+44,true),0x200);
        const byte=Number(view.getBigUint64(port+8,true)),ticket=view.getBigUint64(port+32,true);
        assert(byte>=0 && byte<=255);
        // Reserve bounded observation capacity BEFORE transport acceptance.
        // This is a local byte sink, not a JS UART or Linux console model.
        if(consoleBytes===consoleOutput.length)return {kind:'console-capacity',result:'26',
          entry:`0x${entry.toString(16)}`,acceptedBytes:consoleBytes,capacity:consoleOutput.length};
        assert.equal(vm.vm_console_commit(port,generation,ticket,byte),1);
        consoleOutput[consoleBytes++]=byte;
        assert.equal(vm.vm_console_commit(port,generation,ticket,byte),0);continue;
      }
      if (result === 18n) {
        acceptClock(generation); continue;
      }
      if (entry === 0x1000281n && !firstRepeatWait) {
        firstRepeatWait = {address:`0x${view.getBigUint64(port + 32,true).toString(16)}`,
          bytes:view.getUint32(port + 40,true),access:view.getUint32(port + 44,true)};
        assert.equal(firstRepeatWait.address,'0x1e283f8');
        assert.equal(firstRepeatWait.bytes,8); assert.equal(firstRepeatWait.access,18);
      }
      const start = performance.now(); const supplied = await supplyPhysical(); supplyMs += performance.now() - start;
      if (!supplied) return {...resourceGate,entry:`0x${entry.toString(16)}`};
    }
    const done = Number(vm.vm_source_retired());
    trace.append(entry,done,rip(),result,view,base);
    if (entry === 0x10002a1n) {
      assert.equal(rip(),relocated + 0x2ded00n,'independent shipped relocation trampoline destination');
      assert.equal(view.getBigUint64(base,true),rip());
    }
    if (relocationRegisterCheckpoint!==undefined && retired >= relocationRegisterCheckpoint+6 && relocationTrace.length < 16)
      relocationTrace.push({...trace.read(1)[0],source:Array.from(data.subarray(offset + Number(entry - address),
        offset + Number(entry - address) + Math.min(sourceBytes,24))),
        rax:`0x${view.getBigUint64(base,true).toString(16)}`,rsp:`0x${view.getBigUint64(base + 32,true).toString(16)}`});
    if (result !== 1n && result !== 5n) {
      const delivery = await deliverFault(result,entry);
      if (delivery) {
        assert.equal(done,0); assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired));
        return delivery.deliveryResult === '0' ? null : {kind:'exception-delivery',...delivery};
      }
    }
    if (result !== 1n && result !== 5n)
      return {kind:'execution',result:String(result),entry:`0x${entry.toString(16)}`,
        source:Array.from(data.subarray(offset+Number(entry-address),
          offset+Number(entry-address)+Math.min(sourceBytes,24))),sourceBytes,
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
    if (!vm.vm_completed() && !done) {
      // The C boundary delivered an external interrupt, not a source cut.
      // The handler's RIP must be admitted normally on the next iteration.
      assert.equal(result,1n);assert.equal(view.getBigUint64(base+1128,true),BigInt(retired));
      return null;
    }
    assert.equal(vm.vm_completed(),1); assert.equal(done,instructions);
    retired += done; assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired));
    if (decompression && !linuxEntry && entry === linuxEntryAddress) {
      assert(decompressedOutput,'Linux entry must follow independently checked decompression');
      linuxEntry = {entry:`0x${entry.toString(16)}`,instructions:done,
        nextRip:`0x${rip().toString(16)}`,retired};
    }
    if (entry === 0x1000281n) relocationObservation();
    if (entry === relocated + 0x2ded17n) {
      const expected = new Bytes(bssInitialState);
      expected.writeBigUInt64LE(0n,8); expected.writeBigUInt64LE(relocated + 0x2fe560n,56);
      expected.writeBigUInt64LE(entry + 3n,384);
      expected.writeBigUInt64LE(bssInitialState.readBigUInt64LE(1128)+1n,1128);
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
    const maximumAdmissions = extended ? 150000000 : 1000000;
    const maximumRetired = extended ? 300000000 : 2000000;
    while (admissions < maximumAdmissions && retired < maximumRetired) {
      stopped = await step(view.getUint32(segments + 4,true) ? 1 : 1024);
      if (stopped) break;
      if (extended && (retired-reportedRetired>=1000000 || admissions-reportedAdmissions>=1000000))reportProgress();
    }
    if (!stopped) stopped = {kind:'quota',entry:`0x${rip().toString(16)}`,admissions,retired,
      maximumAdmissions,maximumRetired,
      cpu:{registers:Array.from({length:16},(_,i) => `0x${view.getBigUint64(base + i*8,true).toString(16)}`),
        flags:`0x${view.getBigUint64(base + 392,true).toString(16)}`,
        cr3:`0x${view.getBigUint64(base + 408,true).toString(16)}`}};
    assert(retired >= 379,'REP really completed, not only accepted');
    assert.equal(repeatComparedBytes,kernelBytes);
    return {format:'browser-bzimage-startup-v1',status:'pass',linuxBoot:'not-achieved',
      decompressedOutput,linuxEntry,
      retired,modules:engines.stats().compilations,admissions,liveSlots:installedSlots.size,manualBranchEntries:0,
      independentStateCheckpoint:86,relocationRegisterCheckpoint,
      commandWitness:immutableImage?'fixed 86-instruction prefix; variable command parser count observed, not independently certified':'fixed 86/378-instruction witnesses',
      immutableImage,
      nextRip:`0x${rip().toString(16)}`,nextGate:stopped,exceptions,
      repeatAdmission:'completed through one pinned module; all copied bytes checked through C-MMU views',
      firstRepeatWait,pageSupplies,sourceExtentBytes,quantumYields,clockEvents,boundaryClockEvents,deferredClockPolls,externalInterrupts,
      postCode:vm.vm_post_read(machineGeneration),
      console:{acceptedBytes:consoleBytes,capacity:consoleOutput.length,
        text:new TextDecoder().decode(consoleOutput.subarray(0,consoleBytes)),
        ownership:'bounded local sink; C accepts generation/ticket/exact byte before UART commit/retirement; not a guest tty implementation'},
      rtcSeed:{utcSeconds:String(utcSeconds),source:'explicit supervisor UTC snapshot; not authenticated network time'},
      clockContract:'active C execution nanoseconds, guest clock requests plus safe cut-boundary poll each >=1 ms; virtual TSC 1 GHz, PIT 1193182 Hz, C RTC 32768 Hz; compilation/delivery paused',
      repeatComparedBytes,bssComparedBytes,
      memsetComparedBytes,memsetReturns,
      residentPages:vm.vm_page_count(),descriptorCapacity:capacity,descriptorBytes:capacity * 32 + (capacity - 1) * 16,
      guestExecution:'C-Wasm table dispatcher/MMU',coldCompilation:'C-Wasm decoder/planner/emitter',
      guestMemoryCallback:'C-Wasm, not JavaScript',sourceProjection:'C-MMU borrowed page, no JS virtual-to-physical mapping',
      emittedBytes,copiedCodeBytes,engineReuse:engines.stats(),compilerOutput:compilerOutputWitness.stats(),
      sourceReuse:{hits:sourceHits,misses:sourceMisses,capacity:sourceCapacity,metadataBytes:vm.vm_source_metadata_bytes(),sourcePayloadBytes:0},
      timingMs:{cold:coldMs,engine:engineMs,execution:executionMs,supply:supplyMs,admission:admissionMs,
        elapsedCheck:performance.now()-startedAt},trace:trace.read(),relocationTrace,
      providerBytes:providerBytes.byteLength,compilerBytes:compilerBytes.byteLength,
      memoryBytes:memory.buffer.byteLength,coldMemoryBytes:compilerMemory.buffer.byteLength};
  } catch (error) {
    // Preserve a bounded last state before disposal. An assertion failure is
    // not an unsupported opcode, quota stop, page fault or successful boot.
    error.diagnostic={retired,admissions,entry:`0x${rip().toString(16)}`,
      cpu:{registers:Array.from({length:16},(_,i)=>`0x${view.getBigUint64(base+i*8,true).toString(16)}`),
        flags:`0x${view.getBigUint64(base+392,true).toString(16)}`,
        cr0:`0x${view.getBigUint64(base+400,true).toString(16)}`,
        cr3:`0x${view.getBigUint64(base+408,true).toString(16)}`,
        cr4:`0x${view.getBigUint64(base+416,true).toString(16)}`,
        efer:`0x${view.getBigUint64(base+424,true).toString(16)}`},
      request:{address:`0x${view.getBigUint64(port+32,true).toString(16)}`,
        bytes:view.getUint32(port+40,true),access:view.getUint32(port+44,true)},
      trace:trace.read(4),residentPages:vm.vm_page_count(),memoryBytes:memory.buffer.byteLength,
      console:{acceptedBytes:consoleBytes,text:new TextDecoder().decode(consoleOutput.subarray(0,consoleBytes))},
      sourceReuse:{hits:sourceHits,misses:sourceMisses},decompressedOutput,linuxEntry};
    throw error;
  } finally {
    for (const slot of installedSlots) table.set(slot,null);
    engines.close(); cc.compiler_close(); vm.vm_close();
  }
}
