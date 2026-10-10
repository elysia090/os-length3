// Independent C compiler/VM address gate; no JavaScript guest executor.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [vmFile,compilerFile,directory,...extra]=process.argv.slice(2);
if(!compilerFile||extra.length)throw new Error('usage: check-segment-memory.mjs VM.WASM COMPILER.WASM [NATIVE-DIRECTORY]');
const memory=new WebAssembly.Memory({initial:16}),coldMemory=new WebAssembly.Memory({initial:32});
const vmBytes=await readFile(vmFile),compilerBytes=await readFile(compilerFile);
const vm=(await WebAssembly.instantiate(vmBytes,{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(compilerBytes,{machine:{memory:coldMemory}})).instance.exports;
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer),input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),header=vm.vm_arena_min(),directoryAt=header+8192;
const base=header+16384,segments=base+1408,port=base+2048,request=base+2112,rows=directoryAt+512;
const physical=[0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000];
const pageAt=pa=>base+pa+4096,ramAt=pageAt(0x9000),pte=pageAt(0x4000)+256*8,entry=0x400000n;
const slot=vm.__indirect_function_table.grow(1),put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256)),cache=()=>Buffer.from(data.subarray(segments,segments+136));
const ram=()=>Buffer.from(data.subarray(ramAt,ramAt+8192));
function reset(source,meta,word=index=>index===16?0x202n:0n,row=0,missing=false){
  vm.vm_close();data.fill(0,header);
  data[header+0x1f1]=31;data[header+0x200]=0xeb;data[header+0x201]=0x6a;
  v.setUint16(header+0x1fe,0xaa55,true);v.setUint32(header+0x202,0x53726448,true);v.setUint16(header+0x206,0x20f,true);
  data[header+0x211]=1;data[header+0x236]=1;v.setUint32(header+0x1f4,0x2e640,true);
  v.setUint32(header+0x230,0x200000,true);put(header+0x258,0x1000000);
  v.setUint32(header+0x260,0xe62000,true);v.setUint32(header+0x22c,0x37ffffff,true);v.setUint32(header+0x238,2047,true);
  assert.equal(vm.vm_boot_prepare(header,4096,0x2ea400n,0x65432n,0x8000000n,header+4096,0),0);
  for(let rank=0;rank<physical.length;++rank){const at=directoryAt+rank*32;
    put(at,physical[rank]);v.setUint32(at+8,physical[rank]+4096,true);v.setUint32(at+12,3,true);
    v.setUint32(at+16,1,true);data.fill(0,at+20,at+32);}
  for(let rank=0;rank<3;++rank)put(pageAt(physical[rank]),BigInt(physical[rank+1])|0x67n);
  put(pageAt(0x2000)+4*8,0x3067n); // High (>4 GiB) linear alias, not a base narrowed to i32.
  put(pageAt(0x3000)+2*8,0x4067n);put(pageAt(0x4000),0x8067n);
  put(pte,0x9067n);put(pte+8,BigInt(missing?0xd000:0xa000)|0x67n);
  data.set(source,pageAt(0x8000));
  for(let index=0;index<8192;++index)data[ramAt+index]=(index*37+row*19+(meta.form||0))&255;
  for(let reg=0;reg<16;++reg)put(base+reg*8,word(reg));
  put(base+384,entry);put(base+392,word(16));put(base+400,0x80010011n);put(base+408,0x1000n);
  put(base+416,0x620n);put(base+424,0xd00n);put(base+488,19n);put(base+496,27n);
  put(base+600,0x400n);v.setUint32(base+612,0x1f80,true);put(base+1128,42n);put(port,9n);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);v.setUint32(segments+52,0xc0f3,true);
  // Null selectors remain zero, but the MSR-written hidden bases are live.
  for(const rank of [4,5])v.setUint32(segments+8+rank*16+12,0x10000,true);
  if(meta.segment!==undefined)put(segments+8+(4+meta.segment)*16,word(38));
  assert.equal(vm.vm_open(base,data.length-base,4096,directoryAt,7,8,header+12288,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,meta.operandBinding||0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function emit(source){
  cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  const status=cc.compiler_emit(entry,1,output,65536,report);
  assert.equal(status,0,'FS/GS operands must enter the common compiled boundary');
  return {body:Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true)))),
    sourceBytes:Number(cv.getBigUint64(report+32,true)),operandBinding:cv.getUint32(report+76,true)};
}
async function load(body){
  const imports={memory,access:vm.vm_access,reserve:vm.vm_reserve,commit:vm.vm_commit,
    read_pair:vm.vm_read_pair,read_extent:vm.vm_read_extent,reserve_pair:vm.vm_reserve_pair,commit_pair:vm.vm_commit_pair,
    write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end,table:vm.vm_table};
  const cut=(await WebAssembly.instantiate(body,{machine:imports})).instance.exports.cut;
  vm.__indirect_function_table.set(slot,cut);return cut;
}
const page=Buffer.alloc(4096,0xcc);page.set([0x64,0x48,0x8b,0x04,0x25,0,0,0,0]);
let parity=0,direct=0,dispatch=0,nativeSuccess=0,nativeFault=0,models=0,waits=0,retries=0,refusals=0,differentials=0,msrFences=0,msrFresh=0;
let familyCount=0;
const moduleBytes=[];
try{
const exact=emit(page);assert.equal(exact.sourceBytes,9);const exactCut=await load(exact.body);
reset(page,{...exact,segment:0},index=>index===16?0x202n:index===38?0x500200n:0n);
const value=v.getBigUint64(ramAt+512,true);
assert.equal(vm.vm_access(port,entry,1,9,0n),0n,'ordinary executable fetch');
assert.equal(vm.vm_access(port,0n,8,65,0n),0n,'C-owned FS normalization');
assert.equal(v.getBigUint64(port+8,true),value);
assert.equal(exactCut(base,port,entry,0),1n,'exact FS direct entry');
put(base+384,entry);put(base+1128,42n);
assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(v.getBigUint64(base,true),value);++models;
if(directory)for(let form=0;form<24;++form){
  const prefix=`${directory}/segment-${form}`,meta=JSON.parse(await readFile(`${prefix}.json`));meta.form=form;
  const source=await readFile(`${prefix}.source-page`),records=await readFile(`${prefix}.cases`);
  const stride=41*8+8192;assert.equal(meta.words,41);assert.equal(records.length,meta.rows*stride);
  const result=emit(source);assert.equal(result.sourceBytes,meta.sourceBytes);assert.equal(result.operandBinding,meta.operandBinding);
  assert.deepEqual(result.body,await readFile(`${prefix}.wasm`),'fresh native-C/cold-C byte parity');++parity;moduleBytes.push(result.body.length);
  const cut=await load(result.body);
  for(let record=0;record<meta.rows;++record){
    const word=index=>records.readBigUInt64LE(record*stride+index*8),mode=Number(word(37)),trapped=!!word(40),row=record%8;
    const payload=records.subarray(record*stride+41*8,(record+1)*stride);
    trapped?++nativeFault:++nativeSuccess;
    for(const table of [false,true]){
      reset(source,meta,word,row);
      if((mode===3||mode===4)&&meta.kind!==3)put(pte+8,0n);
      const expected=cpu(),hidden=cache();
      for(let reg=0;reg<16;++reg)expected.writeBigUInt64LE(word(17+reg),reg*8);
      expected.writeBigUInt64LE(word(33)&~0x10000n,392);
      if(!trapped){expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);expected.writeBigUInt64LE(43n,1128);}
      const writes=[1,2,4].includes(meta.kind);
      const wanted=trapped?word(34)*8n+3n:table&&writes?5n:1n;
      assert.equal(table?vm.vm_run(port,9n,1):cut(base,port,entry,meta.operandBinding),wanted,`form ${form}, row ${record}, table ${table}`);
      assert(cpu().equals(expected),`all CPU bytes against native GPR/flag observation: form ${form}, row ${record}`);
      assert(cache().equals(hidden),'hidden cache unchanged model, not a hardware observation');
      assert(ram().equals(payload),`complete native payload: form ${form}, row ${record}`);
      if(trapped){assert.equal(v.getUint32(port+24,true),Number(word(34)));assert.equal(v.getUint32(port+28,true),Number(word(35)));
        if(word(34)===14n)assert.equal(v.getBigUint64(port+16,true),word(36));}
      if(table){assert.equal(vm.vm_source_retired(),trapped?0n:1n);++dispatch;}else ++direct;
    }
  }
}
// Metamorphic address-boundary isolation, not a second semantics oracle:
// compare the existing unprefixed C cut with a segmented cut at the same
// linear coordinate. Native instruction semantics are checked separately.
const families=[
  ...[0,4,15,16,17,32,255].map(count=>({name:`PALIGNR ${count}`,code:[0x66,0x0f,0x3a,0x0f,0x06,count],size:16,aligned:true})),
  {name:'MOVDQU load',code:[0xf3,0x0f,0x6f,0x06],size:16},
  {name:'MOVDQU store',code:[0xf3,0x0f,0x7f,0x06],size:16},
  {name:'MOVQ scalar',code:[0xf3,0x0f,0x7e,0x06],size:8},
  ...[0x12,0x13,0x16,0x17].map(opcode=>
    ({name:`selected half ${opcode}`,code:[0x66,0x0f,opcode,0x06],size:8})),
  {name:'FXRSTOR',code:[0x48,0x0f,0xae,0x0e],size:512,aligned:true},
  {name:'FXSAVE',code:[0x48,0x0f,0xae,0x06],size:512,aligned:true},
  {name:'LDMXCSR',code:[0x0f,0xae,0x16],size:4},
  {name:'STMXCSR',code:[0x0f,0xae,0x1e],size:4},
  {name:'CMPXCHG16B',code:[0x48,0x0f,0xc7,0x0e],size:16,aligned:true},
  {name:'PUSH memory',code:[0xff,0x36],size:8,callStack:true},
  {name:'POP memory',code:[0x8f,0x06],size:8},
  {name:'indirect CALL',code:[0xff,0x16],size:8,callStack:true,branch:true},
  {name:'indirect JMP',code:[0xff,0x26],size:8,branch:true},
  {name:'selector store',code:[0x8c,0x16],size:2},
  {name:'SGDT',code:[0x0f,0x01,0x06],size:10},
  {name:'LGDT',code:[0x0f,0x01,0x16],size:10,privileged:true},
  {name:'REP MOVSB',code:[0xf3,0xa4],size:1,string:true},
  {name:'CMOV',code:[0x48,0x0f,0x44,0x06],size:8},
  {name:'BTS',code:[0x48,0x0f,0xab,0x0e],size:8},
  {name:'SHRD',code:[0x48,0x0f,0xad,0x06],size:8},
  {name:'IDIV',code:[0x48,0xf7,0x3e],size:8},
  // Serialized LOCK uses the same complete-fragment C reservation. These
  // are address/latch models; independent native LOCK rows live separately.
  ...[0x01,0x09,0x11,0x19,0x21,0x29,0x31].map((opcode,index)=>
    ({name:`LOCK ALU ${index}`,code:[0xf0,0x48,opcode,0x0e],size:8})),
  ...[0x06,0x0e,0x1e,0x16].map((modrm,index)=>
    ({name:`LOCK unary ${index}`,code:[0xf0,0x48,index<2?0xff:0xf7,modrm],size:8})),
  ...[0xab,0xb3,0xbb].map((opcode,index)=>
    ({name:`LOCK bit ${index}`,code:[0xf0,0x48,0x0f,opcode,0x0e],size:8})),
  ...[0x2e,0x36,0x3e].map((modrm,index)=>
    ({name:`LOCK immediate bit ${index}`,code:[0xf0,0x48,0x0f,0xba,modrm,0xff],size:8})),
];
familyCount=families.length;
for(const segment of [0,1])for(const address of [32,64])for(const family of families)
for(const mode of ['normal','fault','wait']){
  const linear=mode==='normal'?0x500200n:0x500000n+BigInt(4096-(family.aligned&&family.size>16?16:family.aligned||family.size===1?0:1));
  const hiddenBase=mode==='normal'?0x100500000n:0x500000n;
  const target=mode==='normal'?linear+0x100000000n:linear;
  const offset=target-hiddenBase;
  const refPage=Buffer.alloc(4096,0xcc),segPage=Buffer.alloc(4096,0xcc);
  refPage.set([...(address===32?[0x67]:[]),...family.code]);
  segPage.set([0x64+segment,...(address===32?[0x67]:[]),...family.code]);
  // A high-base segmented 32-bit offset has a 64-bit linear result. Its flat
  // comparison uses a 64-bit address, rather than narrowing that result.
  if(address===32&&mode==='normal')refPage.set([...family.code,0xcc]);
  const ref=emit(refPage),seg=emit(segPage),refCut=await load(ref.body);
  const word=index=>index===16?0x10202n:index===6?target:index===4?0x500780n:
    index===7?0x500700n:index===1?(family.string?3n:1n):index===38?hiddenBase:0n;
  function seed(source,meta,segmented){
    reset(source,{...meta,segment},word,0,mode==='wait');
    if(segmented)put(base+48,offset|(address===32?0x7654321000000000n:0n));
    if(family.privileged){put(base+488,16n);put(base+496,24n);v.setUint32(segments+36,0xa09b,true);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0,'admit the kernel CS context before execution');}
    for(let rank=0;rank<32;++rank)put(base+128+rank*8,BigInt(rank+1)*0x1011121314151617n);
    if(mode==='fault')put(pte+8,0n);
    const at=ramAt+Number(linear-0x500000n);
    if(family.name==='FXRSTOR'){data.fill(0,at,at+512);v.setUint32(at+24,0x1f80,true);}
    if(family.name==='LDMXCSR')v.setUint32(at,0x1f80,true);
    if(family.name==='IDIV')put(at,3n);
    if(family.branch)put(at,entry+128n);
    // SGDT/LGDT use genuine C system words, not a host pathname/syscall.
    if(family.name==='SGDT'){put(base+448,0x12345678n);put(base+456,0x77n);}
  }
  function execute(){
    const result=vm.vm_run(port,9n,1);
    if(result!==2n||mode!=='wait')return result;
    ++waits;assert.equal(vm.vm_source_retired(),0n);
    assert.equal(vm.vm_page_prepare(port,request),0);
    const ticket=v.getBigUint64(request+40,true),destination=v.getUint32(request+24,true);
    assert.equal(v.getBigUint64(request+8,true),0xd000n);
    data.set(data.subarray(ramAt+4096,ramAt+8192),destination);
    // Caller row edits confer no authority over the C-owned continuation.
    put(rows,entry+4096n);v.setUint32(rows+16,0,true);v.setUint32(rows+20,0xdeadbeef,true);
    assert.equal(vm.vm_page_commit(port,ticket),0);assert.equal(vm.vm_page_commit(port,ticket),-1);
    const resumed=vm.vm_run(port,9n,1);++retries;
    data.set(data.subarray(destination,destination+4096),ramAt+4096);
    return resumed;
  }
  seed(refPage,ref,false);vm.__indirect_function_table.set(slot,refCut);
  const expectedResult=execute(),expectedCPU=cpu(),expectedRAM=ram();
  const faultFields=Buffer.from(data.subarray(port+16,port+32));
  const segmentCut=await load(seg.body);seed(segPage,seg,true);
  const hidden=cache(),initialRSI=v.getBigUint64(base+48,true);
  const result=execute();
  assert.equal(result,expectedResult,`${family.name}, ${segment}, ${address}, ${mode}`);
  if(expectedCPU.readBigUInt64LE(384)===entry+BigInt(ref.sourceBytes))expectedCPU.writeBigUInt64LE(entry+BigInt(seg.sourceBytes),384);
  const delta=family.string?expectedCPU.readBigUInt64LE(48)-target:0n;
  expectedCPU.writeBigUInt64LE(BigInt.asUintN(address,initialRSI+delta) | (family.string?0n:initialRSI&~((1n<<BigInt(address))-1n)),48);
  if(family.name==='indirect CALL'&&(result===1n||result===5n))expectedRAM.writeBigUInt64LE(entry+BigInt(seg.sourceBytes),0x778);
  const actualCPU=cpu();
  if(!actualCPU.equals(expectedCPU)){
    const fields=[];
    for(let offset=0;offset+8<=expectedCPU.length;offset+=8)
      if(actualCPU.readBigUInt64LE(offset)!==expectedCPU.readBigUInt64LE(offset))
        fields.push(`${offset}: ${actualCPU.readBigUInt64LE(offset).toString(16)} != ${expectedCPU.readBigUInt64LE(offset).toString(16)}`);
    assert.fail(`complete normalized CPU: ${family.name}, ${segment}, ${address}, ${mode}: ${fields.join(', ')}`);
  }
  assert(ram().equals(expectedRAM),`complete normalized RAM: ${family.name}, ${segment}, ${address}, ${mode}`);
  assert(cache().equals(hidden),'no hidden-base publication by a payload access');
  if((result&7n)===3n)assert(data.subarray(port+16,port+32).equals(faultFields));
  ++differentials;
}
// Base writes use the existing typed MSR boundary, not a host-side TLS map.
// A latched page wait owns the old context and ticket until it completes.
for(const segment of [0,1]){
  const source=Buffer.from(page);source[0]=0x64+segment;
  const meta=emit(source);await load(meta.body);
  const key=0xc0000100+segment;
  const kernel=()=>{put(base+488,16n);put(base+496,24n);v.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);};
  reset(source,{...meta,segment},index=>index===16?0x202n:index===38?0x500fffn:0n,0,true);kernel();
  const expected=Buffer.concat([data.subarray(ramAt+4095,ramAt+4096),data.subarray(ramAt+4096,ramAt+4103)]).readBigUInt64LE();
  assert.equal(vm.vm_run(port,9n,1),2n);assert.equal(vm.vm_page_prepare(port,request),0);
  const ticket=v.getBigUint64(request+40,true),destination=v.getUint32(request+24,true);
  const state=cpu(),hidden=cache(),payload=ram(),boundary=Buffer.from(data.subarray(port,request+48));
  assert.equal(vm.vm_msr(port,1,key,0x500200n),6n,'latched entry refuses an interposed base write');
  assert(cpu().equals(state)&&cache().equals(hidden)&&ram().equals(payload));
  assert(data.subarray(port,request+48).equals(boundary),'refusal preserves the prepared supply ticket');
  data.set(data.subarray(ramAt+4096,ramAt+8192),destination);
  assert.equal(vm.vm_page_commit(port,ticket),0);assert.equal(vm.vm_page_commit(port,ticket),-1);
  assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(v.getBigUint64(base,true),expected);++msrFences;
  reset(source,{...meta,segment},index=>index===16?0x202n:0n);kernel();
  assert.equal(vm.vm_msr(port,1,key,0x500200n),0n,'a fresh entry observes the newly published base');
  assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(v.getBigUint64(base,true),v.getBigUint64(ramAt+512,true));++msrFresh;
}
// Invalid source roles/profile never become a different architectural segment.
// Ignoring a value is not permission to erase the operand's precise fault.
// Counts16/32/255 need no source payload in the result, but m128 still faults.
for(const count of [0,4,16,32,255]){
  const source=Buffer.alloc(4096,0xcc);source.set([0x66,0x0f,0x3a,0x0f,0x06,count]);
  const made=emit(source),cut=await load(made.body);
  reset(source,made,index=>index===16?0x202n:index===6?0x500001n:0n);
  const before=cpu(),hidden=cache(),payload=ram();
  assert.equal(cut(base,port,entry,made.operandBinding),107n,'unaligned PALIGNR source raises #GP');
  assert.equal(v.getUint32(port+24,true),13);assert.equal(v.getUint32(port+28,true),0);
  assert(cpu().equals(before)&&cache().equals(hidden)&&ram().equals(payload));++models;
}
for(const role of [64,128])for(const invalid of ['two-roles','stack','fetch','base','version','compatibility']){
  reset(page,{...exact,segment:role===64?0:1},index=>index===16?0x202n:index===38?0x500200n:0n);
  let access=role|1;
  if(invalid==='two-roles')access|=192;if(invalid==='stack')access|=4;if(invalid==='fetch')access|=8;
  if(invalid==='base')put(segments+8+(role===64?4:5)*16,0x800000000000n);
  if(invalid==='version')v.setUint32(segments,0,true);
  if(invalid==='compatibility')v.setUint32(segments+36,0xc0fb,true);
  const state=cpu(),hidden=cache(),payload=ram();
  assert.equal(vm.vm_access(port,0n,8,access,0n),6n);
  assert(cpu().equals(state)&&cache().equals(hidden)&&ram().equals(payload));++refusals;
}
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();}
console.log(JSON.stringify({format:'native-segment-memory-v1',status:'pass',linuxBoot:'not-tested',
  vmBytes:vmBytes.length,vmSha256:createHash('sha256').update(vmBytes).digest('hex'),
  compilerBytes:compilerBytes.length,compilerSha256:createHash('sha256').update(compilerBytes).digest('hex'),
  parity,direct,dispatch,nativeSuccess,nativeFault,models,differentials,waits,retries,refusals,msrFences,msrFresh,moduleBytes,
  familyCount,
  scope:`actual native FS/GS load/store/RMW/LEA/MOVSB/TLS, 32/64-bit offsets, high/zero bases, wrap, #PF/#GP; ${familyCount}-family metamorphic address checks and C page-wait/MSR fences are models, not independent ISA observations or browser boot`},null,2));
