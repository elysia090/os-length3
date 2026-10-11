// Authenticated bzImage pages -> cold C compiler -> C MMU/table dispatcher.
// JavaScript transports bounded pages/metadata; it does not decode or execute
// guest instructions, resolve guest branches, or implement guest exceptions.
import {CompiledModules} from './compiled-modules.mjs';
import {PreparedCode} from './prepared-code.mjs';
import {CutTrace} from './machine-trace.mjs';
import {CompilerOutput} from './compiler-output.mjs';
import {equal} from './assertion.mjs';
import {CutProgress} from './cut-progress.mjs';
import {MachineYield} from './machine-yield.mjs';
import {memoryBudget,memoryGrowth} from './memory-budget.mjs';
import {isMachineBarrier} from './machine-barrier.mjs';
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
assert.equal = equal;
assert.deepEqual = (a,b) => assert(JSON.stringify(a) === JSON.stringify(b),'startup imports');

export async function runMachine(reader,providerBytes,compilerBytes,readExtent,
    {extended = false,onProgress = () => {},decompression,immutableImage,warmCuts=1,
      utcSeconds = BigInt(Math.floor(Date.now()/1000)),idleWait,onCompilerRefusal,readInput,keepAlive=false,bootEntropy,diagnostic=false,devices,onConsole=()=>{},shouldClose=()=>false,generation=9n} = {}) {
  const startedAt=performance.now();
  const taskOpportunity=new MachineYield();
  assert(Number.isInteger(warmCuts) && warmCuts>=1 && warmCuts<=64,'bounded warm cut quantum');
  assert(typeof keepAlive==='boolean','explicit interactive lifetime');
  const read = async name => new Bytes(await reader(name));
  const header = await read('boot.header');
  let command = await read('boot.command');
  if (immutableImage) {
    assert(Number.isSafeInteger(immutableImage.bytes) && immutableImage.bytes>0
      && immutableImage.bytes<=0x10000000 && immutableImage.address==='0x30000000','immutable physical image descriptor');
    const extent=`0x${immutableImage.bytes.toString(16)}`, address=immutableImage.address;
    command=new Bytes(new TextEncoder().encode(`${new TextDecoder().decode(command)} memmap=${extent}$${address} phram.phram=system,${address},${extent}`));
  }
  const kernel = diagnostic ? await read('boot.kernel-page') : null, last = diagnostic ? await read('boot.kernel-last-page') : null;
  const stateBytes = diagnostic ? await read('boot.state') : null, segmentBytes = diagnostic ? await read('boot.segments') : null;
  const meta = JSON.parse(new TextDecoder().decode(await read('boot.json')));
  const kernelBytes = header.readUInt32LE(0x1f4) * 16;
  const idtPage = diagnostic ? await read('call.extra-page') : null, cmdlinePage = diagnostic ? await read('cmdline.extra-page') : null;
  const optionPage = diagnostic ? await read('option.extra-page') : null;
  // A live machine may touch its declared RAM and immutable device pages.
  // Directory/branch/version words and private construction are NOT payload.
  // No payload population is allocated here: C supplies each demanded page.
  const {capacity,maximumPages:maximumMemoryPages}=memoryBudget(meta.ramBytes,immutableImage?.bytes??0,keepAlive,extended);
  // The compiler's supported private-static envelope extends through 2 MiB
  // plus its stack. This is link memory, not guest RAM or a CPU checkpoint.
  const memory = new WebAssembly.Memory({initial:64,maximum:maximumMemoryPages});
  const provider = await WebAssembly.compile(providerBytes);
  assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
  const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
  const sourceProfile = () => {
    if(typeof vm.vm_source_profile!=='function')return null;
    const names=['queries','coldReservations','quotaReplacements','sampledQueries',
      'sampledAbsentEntry','sampledRemappedOwner','sampledBudgetReject',
      'sampledReusable','sampledValidRowsSum','writeRevokedRows','pendingWriteCancellations',
      'walkProofHits','walkProofMisses'];
    return Object.fromEntries(names.map((name,i)=>[name,String(vm.vm_source_profile(i))]));
  };
  const compilerModule = await WebAssembly.compile(compilerBytes);
  assert.deepEqual(WebAssembly.Module.imports(compilerModule),[{module:'machine',name:'memory',kind:'memory'}]);
  let cc = (await WebAssembly.instantiate(compilerModule,{machine:{memory}})).exports;
  assert.equal(vm.vm_entry_abi(),4);assert.equal(cc.compiler_entry_abi(),4);
  const memoryFeatures=vm.vm_memory_features?.()??0;
  assert(((cc.compiler_memory_features?.()??0)&~memoryFeatures)===0,'compiler memory contract supported by C provider');
  for(const name of ['vm_source_demands','vm_source_admissions','vm_run_interrupted','vm_run_source'])
    assert.equal(typeof vm[name],'function','C warm admission observations required');
  assert(vm.vm_arena_min()<=cc.compiler_static_min(),'disjoint VM and cold static/stack reservations');
  const engineImports={machine:{memory,
    access:vm.vm_access,segment:vm.vm_segment,reserve:vm.vm_reserve,commit:vm.vm_commit,
    reserve_pair:vm.vm_reserve_pair,commit_pair:vm.vm_commit_pair,
    read_pair:vm.vm_read_pair,
    read_extent:vm.vm_read_extent,
    write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end,
    table:vm.vm_table,far_return:vm.vm_return,control:vm.vm_control,iret:vm.vm_iret,msr:vm.vm_msr,interrupt_flag:vm.vm_flag,
    software_interrupt:vm.vm_software_interrupt,system_transfer:vm.vm_system,floating_wait:vm.vm_floating_wait,checkpoint:vm.vm_checkpoint,descriptor:vm.vm_descriptor,far_transfer:vm.vm_transfer,
    io:vm.vm_io,time:vm.vm_time,debug:vm.vm_debug}};
  // Construction references can retain two MiB of exact topologies. Keep
  // their byte index in the same bounded lifetime, otherwise still-resident
  // bodies get compiled again merely because their index was evicted first.
  let engines = new CompiledModules(engineImports,{maximumEntries:8192,maximumBytes:4194304});
  let prepared=new PreparedCode({maximumEntries:16384,maximumBytes:4194304});
  let compilerOutput = cc.compiler_arena_min();
  let compilerReport = compilerOutput + 65536;
  // Compiler output/stack and VM metadata are outside all guest mappings.
  // Cold input borrows the exact C-MMU resident fragments, never a copy arena.
  // Construction capacity is a distinct private lifetime, never guest RAM.
  // Reserve bounded room for a replacement frontend without moving a running
  // machine, relaxing code admission or restoring an observed CPU checkpoint.
  const input = ((compilerReport + 80 + 4095) & ~4095)+524288;
  const rows = input + 8192;
  const versionOffset=input+24576,versionCount=capacity+32;
  const directoryOffset=(versionOffset+versionCount*4+4095)&~4095;
  const branches = directoryOffset + capacity * 32;
  const base = (branches + (capacity - 1) * 16 + 4095) & ~4095;
  const port = base + 2048, segments = base + 1408, codeView = base + 2112, pageRequest = base + 2176;
  const codeOffset = base + 32768, gdtOffset = base + 45056, stackOffset = base + 49152;
  const entropyPageOffset=base+36864;
  const idtCodeOffset = base + 53248, bssOffset = base + 57344;
  const cmdlineCodeOffset = base + 61440, optionOffset = base + 65536;
  const initialPages=Math.ceil((optionOffset+4096)/65536);
  assert(initialPages+Math.ceil(capacity*4096/65536)<=maximumMemoryPages,'private plus physical population fits its single reservation');
  const existingPages=memory.buffer.byteLength/65536;
  if (initialPages>existingPages) memory.grow(initialPages-existingPages);
  let data = new Bytes(memory.buffer), view = new DataView(memory.buffer);
  const relocated = 0x1000000n + BigInt(header.readUInt32LE(0x260)) - 0x320000n;
  const stack = relocated + 0x2ea400n, gdt = 0x12e6000n;
  if(diagnostic)assert.equal(stack,0x1e2c400n);
  data.set(header,input); data.set(command,input + 4096);
  assert.equal(vm.vm_boot_prepare(input,header.length,BigInt(meta.imageBytes),
    BigInt(meta.initramfsBytes),BigInt(meta.ramBytes),input + 4096,command.length),0);
  if(bootEntropy!==undefined){
    assert(bootEntropy instanceof Uint8Array&&bootEntropy.length===64&&typeof vm.vm_boot_entropy==='function','fresh64-byte boot entropy contract');
    const seedOffset=input-64;data.set(bootEntropy,seedOffset);
    assert.equal(vm.vm_boot_entropy(seedOffset,64),0);
    data.fill(0,seedOffset,input);bootEntropy.fill(0);
  }
  if (immutableImage)
    assert.equal(vm.vm_boot_image(BigInt(immutableImage.address),BigInt(immutableImage.bytes)),0);
  if(devices){assert.equal(vm.vm_boot_devices(BigInt(devices.address),devices.volume?8192:4096),0);
    if(devices.volume)assert.equal(vm.vm_boot_volume(BigInt(devices.volume.bytes)),0);}
  for (let i = 0; i < 6; ++i)
    assert.equal(vm.vm_boot_project(BigInt((i + 1) * 4096),base + (i + 2) * 4096,rows),1);
  // A one-use seed is committed as bootstrap RAM before execution, never
  // held across an asynchronous demand/reservation or regenerated from cache.
  if(bootEntropy!==undefined)assert.equal(vm.vm_boot_project(0x7000n,entropyPageOffset,rows),1);
  if(diagnostic){
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
  }
  assert.equal(vm.vm_boot_initial_state(base),0); assert.equal(vm.vm_boot_initial_segments(segments),0);
  const pages = Array.from({length:6},(_,i) => [BigInt((i + 1) * 4096),base + (i + 2) * 4096]);
  if(bootEntropy!==undefined)pages.push([0x7000n,entropyPageOffset]);
  if(diagnostic)pages.push([0x1000000n,codeOffset],[0x12e2000n,cmdlineCodeOffset],[0x12e3000n,idtCodeOffset],
    [0x12e4000n,optionOffset],[gdt,gdtOffset],[0x12ea000n,bssOffset],[stack & ~4095n,stackOffset]);
  for (const [i,[address,offset]] of pages.entries()) {
    const at = directoryOffset + i * 32;
    view.setBigUint64(at,address,true); view.setUint32(at + 8,offset - base,true);
    view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true);
    data.fill(0,at + 20,at + 32);
  }
  const machineGeneration=generation;
  assert(typeof machineGeneration==='bigint'&&machineGeneration>0n&&machineGeneration<=0xffffffffffffffffn,'non-reused machine generation');
  view.setBigUint64(port,machineGeneration,true);
  assert.equal(vm.vm_open(base,data.length - base,4096,directoryOffset,pages.length,capacity,branches,machineGeneration),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_source_versions_start(versionOffset,versionCount,machineGeneration),0);
  assert.equal(vm.vm_rtc_start(port,machineGeneration,utcSeconds),0);
  if(devices)await devices.attach({vm,memory,scratch:input+12288,generation:machineGeneration});
  // No A/D warmup, candidate RIP list or native prefix modules. C vm_code
  // projects the current translation. This single-owner Worker pins RAM,
  // directory and CPU context across async engine compilation/admission.
  const table = vm.__indirect_function_table, firstSlot = vm.vm_slot_min();
  const sourceCapacity = vm.vm_source_capacity(), installedSlots = new Map();
  const demandedAfterMiss=new Uint32Array(sourceCapacity);
  table.grow(Math.max(0,firstSlot + sourceCapacity - table.length));
  let admissions = 0, retired = 0, emittedBytes = 0, borrowedCodeBytes = 0;
  const exceptions = [];
  let sourceHits = 0, sourceMisses = 0, admissionMs = 0;
  let warmAdmissions=0,warmRuns=0,warmCompleted=0;
  const progress=new CutProgress(0); // One serialized lane, no per-cut allocation/history.
  let resourceGate;
  let engineMs = 0, coldMs = 0, executionMs = 0;
  let supplyMs = 0, pageSupplies = 0, sourceExtentBytes = 0, quantumYields = 0;
  let clockEvents = 0, boundaryClockEvents = 0, deferredClockPolls = 0, sampledClockMs = 0;
  let idleEvents=0,idleNanoseconds=0n;
  if(idleWait!==undefined)assert(typeof idleWait==='function' && typeof vm.vm_idle_clock==='function','C idle clock transport');
  const consoleOutput=new Uint8Array(16384);
  let consoleBytes=0,consoleHead=0,consoleAccepted=0n;
  function consoleText(){
    const decoder=new TextDecoder();
    if(!consoleHead)return decoder.decode(consoleOutput.subarray(0,consoleBytes));
    return decoder.decode(consoleOutput.subarray(consoleHead),{stream:true})
      +decoder.decode(consoleOutput.subarray(0,consoleHead));
  }
  function consoleObservation(){return {acceptedBytes:Number(consoleAccepted),retainedBytes:consoleBytes,
    evictedBytes:String(consoleAccepted-BigInt(consoleBytes)),text:consoleText()};}
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
  let cold = data, report = view;
  let compilerOutputWitness=new CompilerOutput(cold,compilerOutput,65536,compilerReport,memory);
  let compilerEpoch=1,inputSequence=0n;
  const compilerReplacements=[];
  const rip = () => view.getBigUint64(base + 384,true);
  function sourceIdentity(entry,limit,generation){
    const at=base+2304;
    if(vm.vm_source_stamp(port,generation,at))return null;
    return `${entry&4095n}:${limit}:${view.getBigUint64(at,true)}:${view.getBigUint64(at+8,true)}:${view.getUint32(at+16,true)}:${view.getUint32(at+20,true)}:${view.getUint32(at+24,true)}:${view.getUint32(at+28,true)}`;
  }
  async function replaceCompiler(refusal){
    if(typeof onCompilerRefusal!=='function')return false;
    const bytes=await onCompilerRefusal(refusal);if(!(bytes instanceof Uint8Array)||!bytes.length)throw new Error('replacement compiler bytes');
    const module=await WebAssembly.compile(bytes);assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
    // Probe this trusted compiler in a disposable private memory BEFORE its
    // data initialization is allowed to touch the live machine's memory.
    const probeMemory=new WebAssembly.Memory({initial:Math.ceil(input/65536)});
    const probe=(await WebAssembly.instantiate(module,{machine:{memory:probeMemory}})).exports;
    assert.equal(probe.compiler_entry_abi(),4);const output=probe.compiler_arena_min();
    assert(((probe.compiler_memory_features?.()??0)&~memoryFeatures)===0,'replacement memory contract supported by C provider');
    assert(probe.compiler_static_min()>=vm.vm_arena_min()&&output>=probe.compiler_static_min()&&output+65536+80<=input,
      'replacement remains inside private construction reservation');probe.compiler_close();
    const oldRip=rip(),oldRetired=view.getBigUint64(base+1128,true);
    cc.compiler_close();prepared.close();engines.close();
    for(const slot of installedSlots.keys())table.set(slot,null);installedSlots.clear();
    assert.equal(vm.vm_sources_reset(),0);
    const replacement=(await WebAssembly.instantiate(module,{machine:{memory}})).exports;
    assert.equal(replacement.compiler_entry_abi(),4);assert.equal(replacement.compiler_arena_min(),output);
    assert(output>=replacement.compiler_static_min()&&output+65536+80<=input,'replacement remains inside private construction reservation');
    cc=replacement;compilerOutput=output;compilerReport=output+65536;
    compilerOutputWitness=new CompilerOutput(cold,compilerOutput,65536,compilerReport,memory);
    engines=new CompiledModules(engineImports,{maximumEntries:8192,maximumBytes:4194304});prepared=new PreparedCode({maximumEntries:16384,maximumBytes:4194304});
    assert.equal(vm.vm_source_versions_start(versionOffset,versionCount,machineGeneration),0);
    assert.equal(rip(),oldRip);assert.equal(view.getBigUint64(base+1128,true),oldRetired);
    compilerReplacements.push({epoch:++compilerEpoch,entry:refusal.entry,bytes:bytes.length,retired});return true;
  }
  function receiveInput(){
    if(typeof readInput!=='function')return;
    for(let n=0;n<16;++n){const byte=readInput(false);if(byte===null||byte===undefined)return;
      const accepted=vm.vm_console_receive(port,machineGeneration,inputSequence+1n,byte);
      if(accepted===2)return;assert.equal(accepted,1);++inputSequence;readInput(true);}
  }
  let reportedRetired=0,reportedAdmissions=0;
  function systemProfile(){
    if(typeof vm.vm_system_profile!=='function')return null;
    const count=vm.vm_system_profile(0n,12),rows=[];
    for(let serial=count>128n?count-127n:1n;serial<=count;++serial){
      const row={serial:String(serial),words:Array.from({length:12},(_,word)=>`0x${BigInt.asUintN(64,vm.vm_system_profile(serial,word)).toString(16)}`)};
      rows.push(row);
    }
    const paths=[];
    if(typeof vm.vm_system_path_word==='function'){
      const total=vm.vm_system_profile_path(0n,64);
      for(let rank=0;rank<Math.min(128,Number(total));++rank){const serial=BigInt(rank+1),length=Number(vm.vm_system_profile_path(serial,64));
        const row={words:Array.from({length:13},(_,word)=>`0x${BigInt.asUintN(64,vm.vm_system_path_word(rank,word)).toString(16)}`)};
        row.path=length>0&&length<=64?new TextDecoder().decode(Uint8Array.from({length},(_,byte)=>Number(vm.vm_system_profile_path(serial,byte)))).replace(/\0.*$/s,''):length?'[not resident]':'[descriptor]';paths.push(row);
      }
    }
    return {count:String(count),columns:['operation','rip','cr3','retired','rax','rdi','rsi','rdx','r10','r8','r9','nextRip'],rows,paths};
  }
  function reportProgress() {
    reportedRetired=retired;reportedAdmissions=admissions;
    // Read-only diagnostics: neither a CPU snapshot nor a source retirement.
    // Admission/quantum progress also exposes work inside long instructions.
    onProgress({format:'browser-bzimage-startup-v1',status:'running',linuxBoot:'not-achieved',
      retired,admissions,nextRip:`0x${rip().toString(16)}`,quantumYields,taskYields:taskOpportunity.count,idleEvents,idleNanoseconds:String(idleNanoseconds),
      architecturalRCX:`0x${view.getBigUint64(base+8,true).toString(16)}`,
      residentPages:vm.vm_page_count(),memoryBytes:memory.buffer.byteLength,
      console:consoleObservation(),
      sourceReuse:{hits:sourceHits,misses:sourceMisses,warmAdmissions,warmRuns,warmCompleted,capacity:sourceCapacity},engineReuse:engines.stats(),
      preparedCode:prepared.stats(),
      compilerOutput:compilerOutputWitness.stats(),
      sourceProfile:sourceProfile(),
      systemProfile:systemProfile(),
      devices:typeof vm.vm_device_profile==='function'?Object.fromEntries(['network','block'].map((name,id)=>[name,Array.from({length:10},(_,word)=>String(vm.vm_device_profile(id,word)))])):null,
      timingMs:{cold:coldMs,engine:engineMs,execution:executionMs,supply:supplyMs,admission:admissionMs,
        elapsedCheck:performance.now()-startedAt}});
  }
  async function supplyPhysical() {
    let status = vm.vm_page_prepare(port,pageRequest);
    if (status === -3 && vm.vm_page_count() < capacity && memory.buffer.byteLength < maximumMemoryPages * 65536) {
      const currentPages=memory.buffer.byteLength/65536;
      const growth=memoryGrowth(currentPages,Math.min(currentPages+8,maximumMemoryPages),maximumMemoryPages);
      assert(growth>0,'remaining private/payload memory budget');
      memory.grow(growth); data = new Bytes(memory.buffer); view = new DataView(memory.buffer);
      cold=data; report=view; compilerOutputWitness.refresh();
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
    assert.equal(view.getBigUint64(pageRequest,true),machineGeneration);
    if(kind!==6)assert(offset >= base + 4096 && offset + 4096 <= data.length,'C-chosen virgin payload slot');
    if (kind === 2 || kind === 3 || kind === 5) {
      assert(typeof readExtent === 'function','authenticated bounded extent reader');
      const extent = await readExtent(kind,Number(view.getBigUint64(pageRequest + 16,true)),bytes);
      assert.equal(extent.length,bytes); assert(bytes > 0 && bytes <= 4096);
      data.set(extent,offset); data.fill(0,offset + bytes,offset + 4096); sourceExtentBytes += bytes;
    } else { assert(kind === 0 || kind === 1 || kind === 4 || kind === 6,'known initial page kind'); assert.equal(bytes,0); }
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
    if (deliveryResult !== 0n) {
      // Capture a bounded refusal diagnostic only at the terminal gate. This
      // is neither an event-time full CPU copy nor an alternate guest executor.
      const hex=at=>`0x${view.getBigUint64(at,true).toString(16)}`;
      const cache=rank=>({base:hex(segments+8+rank*16),limit:view.getUint32(segments+16+rank*16,true),
        attributes:view.getUint32(segments+20+rank*16,true)});
      event.state={rsp:hex(base+32),rflags:hex(base+392),cs:hex(base+488),ss:hex(base+496),tr:hex(base+536),
        gdtrBase:hex(base+448),gdtrLimit:hex(base+456),idtrBase:hex(base+464),idtrLimit:hex(base+472),
        csCache:cache(1),ssCache:cache(2),trCache:cache(7)};
    }
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
  function runSource(generation) {
    // Last C-admitted owner, not another page walk that could change the
    // precise fault/IRQ request. A miss/revocation/continuation is explicit.
    const bytes=vm.vm_run_source(port,generation,codeView);
    if(bytes<0)return {sourceUnavailable:'no current retained C run source'};
    assert(bytes>0 && bytes<=4096,'bounded C failed-source span');
    const entry=rip(),source=[];
    let left=Math.min(bytes,24);
    for(let page=0;left;++page){
      assert(page<2,'at most two physical source owners');
      const at=codeView+page*24,offset=view.getUint32(at+16,true),within=page?0:Number(entry&4095n);
      assert.equal(view.getBigUint64(at,true),(entry&~4095n)+BigInt(page*4096));
      assert.equal(view.getBigUint64(at+8,true),generation);assert.equal(view.getUint32(at+20,true),4096);
      assert(offset>=base+4096 && offset+4096<=data.length,'C-owned physical source fragment');
      const count=Math.min(left,4096-within);
      for(let byte=0;byte<count;++byte)source.push(data[offset+within+byte]);
      left-=count;
    }
    return {source,sourceBytes:bytes,sourceObservation:'last valid C-admitted physical owner; no faulting reread'};
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
    const nanoseconds=BigInt(Math.round(executionMs*1000000))+idleNanoseconds;
    assert(nanoseconds>=0n && nanoseconds<1n<<64n,'clock timestamp does not wrap');
    assert.equal(vm.vm_clock_commit(port,generation,view.getBigUint64(port+32,true),nanoseconds),0);
    sampledClockMs=executionMs; ++clockEvents;
  }
  async function idleBoundary(){
    if(!idleWait)return {awaiting:'accepted machine wake event; idle transport not selected'};
    if(!keepAlive&&idleEvents>=4096)return {awaiting:'idle event diagnostic bound',idleEvents};
    // Account for the retiring HLT's real execution before selecting its
    // next deadline. A hardware edge may already be due; never ask the host
    // to wait for a timestamp earlier than the current virtual observation.
    const sample=vm.vm_clock_poll(port,machineGeneration);assert.equal(sample,18n);
    acceptClock(machineGeneration);assert.equal(vm.vm_clock_poll(port,machineGeneration),0n);++boundaryClockEvents;
    const result=vm.vm_idle_clock(port,machineGeneration);
    if(result===1n)return null; // An already pending C event needs no host delay.
    if(result===4n){
      if(!keepAlive)return {awaiting:'external wake event; no currently eligible timer deadline'};
      // No eligible deadline is not the end of a terminal session. Wait for
      // input while reporting only the actually measured idle duration.
      const began=performance.now();await new Promise(resolve=>setTimeout(resolve,16));
      idleNanoseconds+=BigInt(Math.floor((performance.now()-began)*1000000));receiveInput();
      assert.equal(vm.vm_clock_poll(port,machineGeneration),18n);acceptClock(machineGeneration);
      assert.equal(vm.vm_clock_poll(port,machineGeneration),0n);++idleEvents;return null;
    }
    assert.equal(result,18n);
    const deadlineNanoseconds=view.getBigUint64(port+8,true);
    const virtualNanoseconds=BigInt(Math.round(executionMs*1000000))+idleNanoseconds;
    const observed=await idleWait({deadlineNanoseconds,virtualNanoseconds});
    assert(typeof observed?.elapsedNanoseconds==='bigint' && observed.elapsedNanoseconds>=0n,'measured idle duration');
    idleNanoseconds+=observed.elapsedNanoseconds;acceptClock(machineGeneration);
    assert.equal(vm.vm_idle_clock(port,machineGeneration),0n);++idleEvents;
    reportProgress();return null;
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
    if(devices)await devices.poll();
    const interrupted=rip();let boundary=vm.vm_boundary(port,machineGeneration);
    for(let waits=0;boundary===2n && waits<8192;++waits){
      const start=performance.now(),supplied=await supplyPhysical();supplyMs+=performance.now()-start;
      if(!supplied)return {...resourceGate,entry:`0x${interrupted.toString(16)}`};
      boundary=vm.vm_boundary(port,machineGeneration);
    }
    if(boundary===42n||boundary===50n){assert(devices,'explicit device transport');await devices.handle(boundary);return null;}
    if(boundary){
      assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
      assert.equal(view.getBigUint64(base+1128,true),BigInt(retired));
      if(boundary===1n){++externalInterrupts;return null;}
      if(boundary===4n){
        assert.equal(vm.vm_halted(),1);
        const idle=await idleBoundary();if(!idle)return null;
        return {kind:'halted',result:'4',entry:`0x${rip().toString(16)}`,completed:0,sourceRetired:0,
          ...idle};
      }
      const delivered=await deliverFault(boundary,interrupted);
      if(delivered)return delivered.deliveryResult==='0'?null:{kind:'interrupt-delivery',...delivered};
      return {kind:'interrupt-boundary',result:String(boundary),entry:`0x${interrupted.toString(16)}`};
    }
    const entry = rip();
    if (decompression && !decompressedOutput && entry === decompressionEntry) await observeDecompression(entry);
    if (diagnostic && entry === relocated + 0x2e2700n) {
      assert(!memsetInput,'no nested diagnostic memset');
      assert.equal(view.getBigUint64(base + 48,true),0n);
      memsetInput = {address:view.getBigUint64(base + 56,true),bytes:view.getBigUint64(base + 16,true)};
      assert(memsetInput.bytes === 16n || memsetInput.bytes === 131072n,'independent shipped memset sizes');
    }
    if (diagnostic && entry === 0x1000281n && !repeatInitialState) relocationInputs();
    if (diagnostic && entry === relocated + 0x2ded17n && !bssInitialState) {
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
      const identity=sourceIdentity(entry,limit,generation),cached=identity===null?null:prepared.get(identity);
      let instance,sourceBytes,instructions,binding;
      if(cached){({instance,sourceBytes,instructions,binding}=cached);}
      else{
      const construct = () => {
        const count = view.getUint32(codeView + 44,true) ? 2 : 1;
        for (let page = 0; page < count; ++page) {
          const at = codeView + page*24, physical = view.getUint32(at + 16,true);
          assert.equal(view.getBigUint64(at,true),address + BigInt(page*4096));
          assert.equal(view.getBigUint64(at + 8,true),generation);
          assert.equal(view.getUint32(at + 20,true),4096);
          assert(physical >= base + 4096 && physical + 4096 <= data.length,'C-verified source fragment');
          borrowedCodeBytes += 4096;
        }
        const started = performance.now();
        assert.equal(cc.compiler_open_fragments(view.getUint32(codeView+16,true),
          count===2 ? view.getUint32(codeView+40,true) : 0,count,address,generation),0);
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
        const refusal={kind:'compile',status,entry:`0x${entry.toString(16)}`,
          source:Array.from(data.subarray(offset + Number(entry & 4095n),offset + Number(entry & 4095n) + available)),
          sourceAvailable:available,
          cpu:{registers:Array.from({length:16},(_,i) => `0x${view.getBigUint64(base + i*8,true).toString(16)}`),
            flags:`0x${view.getBigUint64(base + 392,true).toString(16)}`,
            cr0:`0x${view.getBigUint64(base + 400,true).toString(16)}`,
            cr3:`0x${view.getBigUint64(base + 408,true).toString(16)}`,
            cr4:`0x${view.getBigUint64(base + 416,true).toString(16)}`,
            efer:`0x${view.getBigUint64(base + 424,true).toString(16)}`,
            mxcsr:`0x${view.getUint32(base + 612,true).toString(16)}`,
            xmm:Array.from({length:32},(_,i)=>`0x${view.getBigUint64(base + 128 + i*8,true).toString(16)}`)}};
        if(status===-102&&await replaceCompiler(refusal))return null;
        return refusal;
      }
      const length = Number(report.getBigUint64(compilerReport + 40,true));
      sourceBytes = Number(report.getBigUint64(compilerReport + 32,true));
      instructions = Number(report.getBigUint64(compilerReport + 24,true));
      binding=report.getUint32(compilerReport+76,true);
      assert(length > 0 && length <= 65536 && instructions > 0 && instructions <= limit);
      const beforeEngine = performance.now();
      // C owns each source coordinate and binding; the engine owner shares
      // only an exact newly emitted topology, not a per-coordinate instance.
      instance = await engines.get(cold.subarray(compilerOutput,compilerOutput + length));
      engineMs += performance.now() - beforeEngine; emittedBytes += length;
      const currentIdentity=sourceIdentity(entry,limit,generation);
      if(currentIdentity!==null)prepared.put(currentIdentity,{instance,sourceBytes,instructions,binding,bytes:length});
      }
      table.set(slot,instance.exports.cut); installedSlots.set(slot,instance);
      beforeAdmission = performance.now();
      assert.equal(vm.vm_source_publish(sourceBytes,instructions,binding,rows),0);
      admissionMs += performance.now() - beforeAdmission;
    } else {
      ++sourceHits; assert(installedSlots.has(slot),'C hit requires its installed engine handle');
      // Retained engine membership can change only at a cold admission. One
      // validated demand per slot afterwards keeps a hot cohort newer than
      // inactive bodies without host Map churn on every guest cut. Order
      // within that cohort is not an architectural fact or an exact LRU claim.
      const rank=slot-firstSlot;
      if(demandedAfterMiss[rank]!==sourceMisses) {
        engines.demand(installedSlots.get(slot)); demandedAfterMiss[rank]=sourceMisses;
      }
    }
    const sourceBytes = view.getUint32(rows + 8,true), instructions = view.getUint32(rows + 12,true);
    assert.equal(view.getBigUint64(rows,true),entry);
    assert(instructions > 0 && instructions <= limit);
    assert.equal(vm.vm_bind_execution(rows,1,generation),0); ++admissions;
    // Initial REP/BSS and all three scalar memset observations remain single-cut.
    // Afterwards the first ELF-header read is still a cold construction
    // boundary: its memory instruction cannot be inside a preceding pure
    // slice, and this on-demand owner has never published that entry. C yields
    // BEFORE that read, preserving the complete decompression comparison.
    // Linux's first entry is likewise unseen and yields before construction.
    // No CPU restore, injected output, guessed branch or observation opcode
    // is introduced. The strict regression keeps warmCuts=1 throughout.
    const initialProofReady=bssComparedBytes===0x18160&&memsetReturns===3&&memsetComparedBytes===131104&&!memsetInput;
    const cutBudget=!diagnostic||linuxEntry||initialProofReady ? warmCuts : 1;
    progress.reset(retired);
    let result;
    for (let resumes = 0; resumes < 8192; ++resumes) {
      const beforeExecution = performance.now();
      const remaining=progress.remaining(cutBudget);
      assert(remaining>0,'barrier needs an unretired cut');
      result = vm.vm_run(port,generation,remaining);
      executionMs += performance.now() - beforeExecution;
      progress.add(vm.vm_completed(),vm.vm_source_retired(),view.getBigUint64(base+1128,true),remaining);
      warmAdmissions+=vm.vm_source_admissions();
      if(cutBudget>1){++warmRuns;warmCompleted+=vm.vm_completed();}
      if(vm.vm_run_interrupted())++externalInterrupts;
      // The C mask is a validated demand hint, never execution authority.
      // One host refresh per distinct cohort rank avoids per-cut Map churn.
      if(cutBudget>1){
        const banked=typeof vm.vm_source_demand_banks==='function';
        const groupCount=typeof vm.vm_source_demand_groups==='function'?vm.vm_source_demand_groups():1;
        assert(Number.isInteger(groupCount)&&groupCount>0&&groupCount<=4,'bounded source demand groups');
        for(let cohort=0;cohort<groupCount;++cohort){
        let banks=groupCount>1?vm.vm_source_demand_group(cohort)>>>0:banked?vm.vm_source_demand_banks()>>>0:1;
        while(banks){const group=cohort*32+31-Math.clz32(banks&-banks);banks=(banks&(banks-1))>>>0;
          const mask=banked?vm.vm_source_demand_word(group):vm.vm_source_demands();
          for(let bank=0;bank<2;++bank){
          let bits=Number(bank ? mask>>32n : mask&0xffffffffn)>>>0;
          while(bits){
            const rank=group*64+bank*32+31-Math.clz32(bits&-bits);bits=(bits&(bits-1))>>>0;
            assert(rank<sourceCapacity && installedSlots.has(firstSlot+rank),'C demand needs its installed engine');
            if(demandedAfterMiss[rank]!==sourceMisses){
              engines.demand(installedSlots.get(firstSlot+rank));demandedAfterMiss[rank]=sourceMisses;
            }
          }
          }
        }
        }
      }
      if (!isMachineBarrier(result)) break;
      const waitingEntry=rip();
      assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired+progress.retired));
      if(cutBudget===1){
        if(!progress.completed)assert.equal(waitingEntry,entry);
        else{assert.equal(progress.completed,1);assert(progress.retired>0&&progress.retired<instructions
          &&waitingEntry>entry&&waitingEntry<entry+BigInt(sourceBytes),'exact nonempty prefix ends at its memory instruction');}
      }
      if (result === 10n) {
        ++quantumYields;
        if(extended && !(quantumYields&255))reportProgress();
        // A latched long instruction still has completed a bounded C quantum.
        // Host tasks may enqueue opaque input, but cannot enter guest state or
        // DMA here. The same continuation resumes through the C owner.
        if(keepAlive&&taskOpportunity.due())await taskOpportunity.yield();
        if(shouldClose())return {kind:'closed',entry:`0x${waitingEntry.toString(16)}`};
        continue;
      }
      if(result===42n||result===50n){
        retired+=progress.retired;trace.append(entry,progress.retired,rip(),result,view,base);
        assert(devices,'explicit device transport');await devices.handle(result);return null;
      }
      if(result===34n){
        // Internal C FERR/IRQ ownership, not a host floating-point exception
        // implementation or a physical-memory reply with a guessed address.
        retired+=progress.retired;trace.append(entry,progress.retired,rip(),result,view,base);
        let boundary=vm.vm_boundary(port,generation);
        for(let waits=0;boundary===2n&&waits<8192;++waits){
          const before=performance.now(),supplied=await supplyPhysical();supplyMs+=performance.now()-before;
          if(!supplied)return {...resourceGate,entry:`0x${rip().toString(16)}`};
          boundary=vm.vm_boundary(port,generation);
        }
        if(boundary===42n||boundary===50n){assert(devices,'explicit device transport');await devices.handle(boundary);return null;}
        if(boundary===1n){++externalInterrupts;return null;}
        if(!boundary)return {kind:'floating-wait',result:'34',entry:`0x${rip().toString(16)}`,
          awaiting:'guest interrupt enable/controller/handler; no fabricated #MF or retirement'};
        const delivered=await deliverFault(boundary,rip());
        return delivered??{kind:'floating-interrupt-boundary',result:String(boundary),entry:`0x${rip().toString(16)}`};
      }
      if(result===26n){
        assert.equal(view.getUint32(port+40,true),1);assert.equal(view.getUint32(port+44,true),0x200);
        const byte=Number(view.getBigUint64(port+8,true)),ticket=view.getBigUint64(port+32,true);
        assert(byte>=0 && byte<=255);
        // Reserve bounded observation capacity BEFORE transport acceptance.
        // This is a local byte sink, not a JS UART or Linux console model.
        if(consoleBytes===consoleOutput.length&&!keepAlive){
          retired+=progress.retired;
          return {kind:'console-capacity',result:'26',
            entry:`0x${waitingEntry.toString(16)}`,acceptedBytes:consoleBytes,capacity:consoleOutput.length,
            completed:progress.completed,sourceRetired:progress.retired};
        }
        assert(consoleAccepted<BigInt(Number.MAX_SAFE_INTEGER),'console observation counter exhausted');
        assert.equal(vm.vm_console_commit(port,generation,ticket,byte),1);
        onConsole(Uint8Array.of(byte));
        // A live terminal retains a fixed window, not an ever-growing log.
        // The bounded regression still stops BEFORE accepting an excess byte.
        consoleOutput[(consoleHead+consoleBytes)%consoleOutput.length]=byte;++consoleAccepted;
        if(consoleBytes===consoleOutput.length)consoleHead=(consoleHead+1)%consoleOutput.length;else++consoleBytes;
        assert.equal(vm.vm_console_commit(port,generation,ticket,byte),0);continue;
      }
      if (result === 18n) {
        acceptClock(generation); continue;
      }
      if (diagnostic && entry === 0x1000281n && !firstRepeatWait) {
        firstRepeatWait = {address:`0x${view.getBigUint64(port + 32,true).toString(16)}`,
          bytes:view.getUint32(port + 40,true),access:view.getUint32(port + 44,true)};
        assert.equal(firstRepeatWait.address,'0x1e283f8');
        assert.equal(firstRepeatWait.bytes,8); assert.equal(firstRepeatWait.access,18);
      }
      const start = performance.now(); const supplied = await supplyPhysical(); supplyMs += performance.now() - start;
      if (!supplied) {
        retired+=progress.retired;
        return {...resourceGate,entry:`0x${waitingEntry.toString(16)}`,completed:progress.completed,sourceRetired:progress.retired};
      }
      if(!progress.remaining(cutBudget)){
        // A final partial cut spent the cohort budget and committed its
        // pure prefix. The pending memory instruction is a FRESH C entry,
        // not a zero-budget resume or a replay of that prefix.
        retired+=progress.retired;trace.append(entry,progress.retired,rip(),result,view,base);return null;
      }
    }
    const done=progress.retired,completed=progress.completed;
    if(result===4n){
      assert.equal(vm.vm_halted(),1);assert(completed>0 && done>=completed);
      retired+=done;assert.equal(view.getBigUint64(base+1128,true),BigInt(retired));
      trace.append(entry,done,rip(),result,view,base);
      const idle=await idleBoundary();if(!idle)return null;
      return {kind:'halted',result:'4',entry:`0x${rip().toString(16)}`,admittedEntry:`0x${entry.toString(16)}`,
        completed,sourceRetired:done,flags:`0x${view.getBigUint64(base+392,true).toString(16)}`,
        ...idle};
    }
    const failedSource=result!==1n && result!==5n ? runSource(generation) : null;
    trace.append(entry,done,rip(),result,view,base);
    if (diagnostic && entry === 0x10002a1n) {
      assert.equal(rip(),relocated + 0x2ded00n,'independent shipped relocation trampoline destination');
      assert.equal(view.getBigUint64(base,true),rip());
    }
    if (relocationRegisterCheckpoint!==undefined && retired >= relocationRegisterCheckpoint+6 && relocationTrace.length < 16)
      relocationTrace.push({...trace.read(1)[0],source:Array.from(data.subarray(offset + Number(entry - address),
        offset + Number(entry - address) + Math.min(sourceBytes,24))),
        rax:`0x${view.getBigUint64(base,true).toString(16)}`,rsp:`0x${view.getBigUint64(base + 32,true).toString(16)}`});
    if (result !== 1n && result !== 5n) {
      // A later cut can fault after a committed prefix. The faulting RIP,
      // not the first admitted row, is the precise exception coordinate.
      retired+=done;
      const delivery = await deliverFault(result,rip());
      if (delivery) {
        assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired));
        return delivery.deliveryResult === '0' ? null : {kind:'exception-delivery',...delivery,
          admittedEntry:`0x${entry.toString(16)}`,completed,sourceRetired:done,...failedSource};
      }
    }
    if (result !== 1n && result !== 5n)
      return {kind:'execution',result:String(result),entry:`0x${rip().toString(16)}`,
        admittedEntry:`0x${entry.toString(16)}`,
        ...failedSource,
        completed,sourceRetired:done,
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
    if (!completed && !done) {
      // An IRQ or exact source cold miss yields to fresh C admission. Neither
      // is a retired instruction or permission to decode/execute in JS.
      assert.equal(result,1n);assert.equal(view.getBigUint64(base+1128,true),BigInt(retired));
      return null;
    }
    if(cutBudget===1){assert.equal(completed,1);assert(done>=1&&done<=instructions,'exact committed source prefix fits its attested row');}
    else assert(completed<=cutBudget && done>=completed,'bounded committed cohort');
    retired += done; assert.equal(view.getBigUint64(base + 1128,true),BigInt(retired));
    if (decompression && !linuxEntry && entry === linuxEntryAddress) {
      assert(decompressedOutput,'Linux entry must follow independently checked decompression');
      linuxEntry = {entry:`0x${entry.toString(16)}`,instructions:done,
        nextRip:`0x${rip().toString(16)}`,retired};
    }
    if (diagnostic && entry === 0x1000281n) relocationObservation();
    if (diagnostic && entry === relocated + 0x2ded17n) {
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
    if (diagnostic && entry === relocated + 0x2e2743n && memsetInput) {
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
    if(diagnostic){
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
    }
    let stopped;
    // Real scalar startup loops can retire far more than a tiny probe quota.
    // These are diagnostic limits, never synthetic execution completion.
    // A bounded regression ends at its quota. An explicitly interactive owner
    // must not destroy a running guest merely because that regression ended.
    // Per-call work, source, module, input and resident-memory bounds stay fixed;
    // closing the Worker/session still disposes every execution owner below.
    const maximumAdmissions = keepAlive ? Number.MAX_SAFE_INTEGER : extended ? 150000000 : 1000000;
    const maximumRetired = keepAlive ? Number.MAX_SAFE_INTEGER : extended ? 300000000 : 2000000;
    while (!shouldClose() && admissions < maximumAdmissions && retired < maximumRetired) {
      if(keepAlive&&taskOpportunity.due())await taskOpportunity.yield();
      if(shouldClose())break;
      receiveInput();
      // This independent diagnostic observes the complete decompressed image
      // BEFORE its first ELF-header read. Demand one-source frontiers until
      // that observation is complete; the compiler has no kernel/RIP rule.
      const observing=decompression&&!decompressedOutput;
      stopped = await step(view.getUint32(segments + 4,true)||observing ? 1 : 1024);
      if (stopped) break;
      if (extended && (retired-reportedRetired>=1000000 || admissions-reportedAdmissions>=1000000))reportProgress();
      // Let console/close messages enter even when every construction is hot.
      // Task opportunity is wall-budgeted above, not dependent on an exact
      // admission count that cannot bound long/coalesced C work or microtasks.
    }
    if (!stopped) stopped = {kind:'quota',entry:`0x${rip().toString(16)}`,admissions,retired,
      maximumAdmissions,maximumRetired,
      cpu:{registers:Array.from({length:16},(_,i) => `0x${view.getBigUint64(base + i*8,true).toString(16)}`),
        flags:`0x${view.getBigUint64(base + 392,true).toString(16)}`,
        cr3:`0x${view.getBigUint64(base + 408,true).toString(16)}`}};
    if(diagnostic)assert(retired >= 379,'REP really completed, not only accepted');
    if(diagnostic)assert.equal(repeatComparedBytes,kernelBytes);
    return {format:'browser-bzimage-startup-v1',status:extended?'stopped':'pass',probeStatus:'pass',linuxBoot:'not-achieved',
      decompressedOutput,linuxEntry,
      retired,modules:engines.stats().compilations,admissions,liveSlots:installedSlots.size,manualBranchEntries:0,
      independentStateCheckpoint:86,relocationRegisterCheckpoint,
      commandWitness:immutableImage?'fixed 86-instruction prefix; variable command parser count observed, not independently certified':'fixed 86/378-instruction witnesses',
      immutableImage,
      nextRip:`0x${rip().toString(16)}`,nextGate:stopped,exceptions,
      repeatAdmission:'completed through one pinned module; all copied bytes checked through C-MMU views',
      firstRepeatWait,pageSupplies,sourceExtentBytes,quantumYields,clockEvents,boundaryClockEvents,deferredClockPolls,externalInterrupts,
      idleEvents,idleNanoseconds:String(idleNanoseconds),
      postCode:vm.vm_post_read(machineGeneration),
      console:{...consoleObservation(),capacity:consoleOutput.length,
        ownership:'bounded local sink; C accepts generation/ticket/exact byte before UART commit/retirement; not a guest tty implementation'},
      rtcSeed:{utcSeconds:String(utcSeconds),source:'explicit supervisor UTC snapshot; not authenticated network time'},
      bootEntropy:{supplied:bootEntropy!==undefined,source:'supervisor64-byte input -> standard Linux SETUP_RNG_SEED; caller owns CSPRNG quality; never saved in artifacts'},
      clockContract:`active C execution nanoseconds${idleWait?' plus measured idle transport time':''}, guest clock requests plus safe cut-boundary poll each >=1 ms; virtual TSC 1 GHz, PIT 1193182 Hz, C RTC 32768 Hz; compilation/delivery paused`,
      repeatComparedBytes,bssComparedBytes,
      memsetComparedBytes,memsetReturns,
      residentPages:vm.vm_page_count(),descriptorCapacity:capacity,descriptorBytes:capacity * 32 + (capacity - 1) * 16,
      guestExecution:'C-Wasm table dispatcher/MMU',coldCompilation:'C-Wasm decoder/planner/emitter',
      guestMemoryCallback:'C-Wasm, not JavaScript',sourceProjection:'C-MMU borrowed page, no JS virtual-to-physical mapping',
      emittedBytes,copiedCodeBytes:0,borrowedCodeBytes,engineReuse:engines.stats(),compilerOutput:compilerOutputWitness.stats(),
      preparedCode:prepared.stats(),codeRevisionBytes:versionCount*4,
      compilerEpoch,compilerReplacements,inputBytes:String(inputSequence),
      sourceProfile:sourceProfile(),
      warmCuts,admissionUnit:'supervisor source query/bind; C warm admissions counted separately',
      systemProfile:systemProfile(),
      sourceReuse:{hits:sourceHits,misses:sourceMisses,warmAdmissions,warmRuns,warmCompleted,capacity:sourceCapacity,metadataBytes:vm.vm_source_metadata_bytes(),sourcePayloadBytes:0},
      timingMs:{cold:coldMs,engine:engineMs,execution:executionMs,supply:supplyMs,admission:admissionMs,
        elapsedCheck:performance.now()-startedAt},trace:trace.read(),relocationTrace,
      providerBytes:providerBytes.byteLength,compilerBytes:compilerBytes.byteLength,
      memoryBytes:memory.buffer.byteLength,coldMemoryBytes:0,
      compilerReservation:{staticBegin:cc.compiler_static_min(),arenaBegin:compilerOutput,
        outputBytes:65536,reportBytes:80,vmMetadataBegin:input,guestArenaBegin:base}};
  } catch (error) {
    // Preserve a bounded last state before disposal. An assertion failure is
    // not an unsupported opcode, quota stop, page fault or successful boot.
    error.diagnostic={retired,architecturalRetired:String(view.getBigUint64(base+1128,true)),
      cohort:{base:progress.base,completed:progress.completed,sourceRetired:progress.retired},
      admissions,entry:`0x${rip().toString(16)}`,
      cpu:{registers:Array.from({length:16},(_,i)=>`0x${view.getBigUint64(base+i*8,true).toString(16)}`),
        flags:`0x${view.getBigUint64(base+392,true).toString(16)}`,
        cr0:`0x${view.getBigUint64(base+400,true).toString(16)}`,
        cr3:`0x${view.getBigUint64(base+408,true).toString(16)}`,
        cr4:`0x${view.getBigUint64(base+416,true).toString(16)}`,
        efer:`0x${view.getBigUint64(base+424,true).toString(16)}`},
      request:{address:`0x${view.getBigUint64(port+32,true).toString(16)}`,
        bytes:view.getUint32(port+40,true),access:view.getUint32(port+44,true)},
      trace:trace.read(4),residentPages:vm.vm_page_count(),memoryBytes:memory.buffer.byteLength,
      console:consoleObservation(),
      sourceReuse:{hits:sourceHits,misses:sourceMisses},sourceProfile:sourceProfile(),systemProfile:systemProfile(),decompressedOutput,linuxEntry};
    throw error;
  } finally {
    taskOpportunity.close();
    try { if(devices)await devices.close(); }
    finally {
      for (const slot of installedSlots.keys()) table.set(slot,null);
      prepared.close();engines.close(); cc.compiler_close(); vm.vm_close();
    }
  }
}
