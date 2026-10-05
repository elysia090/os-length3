// Native x86 observations versus cold C emission and actual C MMU/table calls.
// JS constructs oracle inputs/observations only; it is not a guest executor.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [vmFile,compilerFile,directory,...extra]=process.argv.slice(2);
if(!directory||extra.length)throw new Error('usage: check-string-element.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:16}),coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const compiler=await readFile(compilerFile);
const cc=(await WebAssembly.instantiate(compiler,{machine:{memory:coldMemory}})).instance.exports;
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),header=vm.vm_arena_min(),directoryAt=header+8192;
const base=header+16384,segments=base+1408,port=base+2048,request=base+2112,rows=directoryAt+512;
const physical=[0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000,0xb000,0xc000];
const pageAt=pa=>base+pa+4096,ramAt=pageAt(0x9000),pte=pageAt(0x4000)+256*8,entry=0x400000n;
const slot=vm.__indirect_function_table.grow(1),put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256)),cache=()=>Buffer.from(data.subarray(segments,segments+136));
function reset(source,meta,word,row,missing=false){
  vm.vm_close();data.fill(0,header);
  // Test boot-source plan admits a virgin RAM page for the supply oracle.
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
  put(pageAt(0x3000)+2*8,0x4067n);put(pageAt(0x4000),0x8067n);
  for(let rank=0;rank<4;++rank)put(pte+rank*8,BigInt(missing&&rank===1?0xd000:0x9000+rank*4096)|0x67n);
  data.set(source,pageAt(0x8000));
  for(let index=0;index<16384;++index)data[ramAt+index]=(index*37+row*19+meta.form)&255;
  for(let reg=0;reg<16;++reg)put(base+reg*8,word(reg));
  put(base+384,entry);put(base+392,word(16));put(base+400,0x80010011n);put(base+408,0x1000n);
  put(base+416,32n);put(base+424,0xd00n);put(base+488,19n);put(base+496,27n);
  put(base+600,0x400n);put(base+1128,42n);put(port,9n);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);v.setUint32(segments+52,0xc0f3,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directoryAt,9,10,header+12288,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,meta.operandBinding,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
let parity=0,direct=0,dispatch=0,nativeSuccess=0,nativeFault=0,waits=0,retries=0,refusals=0,rfModels=0;
let prefixNativeFaults=0,baseSegmentRefusals=0;
const moduleBytes=[];
try{
for(let form=0;form<16;++form){
  const prefix=`${directory}/string-${form}`,meta=JSON.parse(await readFile(`${prefix}.json`));meta.form=form;
  const source=await readFile(`${prefix}.source-page`),records=await readFile(`${prefix}.cases`);
  const stride=38*8+16384;assert.equal(meta.words,38);assert.equal(records.length,meta.rows*stride);
  cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,8,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+32,true),BigInt(meta.sourceBytes));assert.equal(cv.getBigUint64(report+24,true),1n);
  assert.equal(cv.getUint32(report+76,true),meta.operandBinding);
  const body=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  assert.deepEqual(body,await readFile(`${prefix}.wasm`),'fresh native-C/cold-C byte parity');++parity;moduleBytes.push(body.length);
  const cut=(await WebAssembly.instantiate(body,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  for(let record=0;record<meta.rows;++record){
    const word=index=>records.readBigUInt64LE(record*stride+index*8),mode=Number(word(37)),row=record%16;
    const payload=records.subarray(record*stride+38*8,(record+1)*stride);
    mode?++nativeFault:++nativeSuccess;
    for(const table of [false,true]){
      reset(source,meta,word,row);
      if(mode>0&&mode<6)put(pte+8,0n);
      const expected=cpu(),hidden=cache();
      for(let reg=0;reg<16;++reg)expected.writeBigUInt64LE(word(17+reg),reg*8);
      expected.writeBigUInt64LE(word(33)&~0x10000n,392); // Hardware delivery alone adds RF.
      if(!mode){expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);expected.writeBigUInt64LE(43n,1128);}
      const wanted=mode?(word(34)*8n+3n):table?5n:1n;
      assert.equal(table?vm.vm_run(port,9n,1):cut(base,port,entry,meta.operandBinding),wanted,`form ${form}, record ${record}, table ${table}`);
      assert(cpu().equals(expected),'all 1256 CPU bytes against independent GPR/flag observations');
      assert(cache().equals(hidden),'hidden cache is an unchanged model, not a hardware observation');
      assert(data.subarray(ramAt,ramAt+16384).equals(payload),'entire native payload, no partial string element');
      if(mode){assert.equal(v.getUint32(port+24,true),Number(word(34)));assert.equal(v.getUint32(port+28,true),Number(word(35)));
        if(word(34)===14n)assert.equal(v.getBigUint64(port+16,true),word(36));}
      if(table){assert.equal(vm.vm_source_retired(),mode?0n:1n);assert.equal(vm.vm_completed(),mode?0:1);++dispatch;}else ++direct;
    }
  }
  const first=index=>records.readBigUInt64LE(index*8);
  for(const refusal of ['entry','generation','TF','AC','port-alias']){
    reset(source,meta,first,0);if(refusal==='generation')put(port,8n);
    if(refusal==='TF'||refusal==='AC')put(base+392,first(16)|(refusal==='TF'?256n:262144n));
    const expected=cpu(),hidden=cache(),payload=Buffer.from(data.subarray(ramAt,ramAt+16384));
    assert.equal(cut(base,refusal==='port-alias'?base:port,refusal==='entry'?entry+1n:entry,0),refusal==='generation'?5n:6n);
    assert(cpu().equals(expected)&&cache().equals(hidden)&&data.subarray(ramAt,ramAt+16384).equals(payload));++refusals;
  }
  reset(source,meta,first,0);put(base+392,first(16)|65536n);
  assert.equal(cut(base,port,entry,0),1n);assert.equal(v.getBigUint64(base+392,true),first(16));++rfModels;
  // C-authenticated residency supply, same pending row even if caller edits it.
  for(const read of meta.store?[false]:[true,false]){
    reset(source,meta,first,0,true);const size=meta.width/8;
    const pointer=0x501000n-BigInt(size>1?size-1:0);
    const src=read?pointer:0x502200n,dst=read?0x502200n:pointer;
    put(base+48,meta.store?first(6):src|(meta.address===32?0x7654321000000000n:0n));
    put(base+56,dst|(meta.address===32?0xabcdef0100000000n:0n));put(base+392,0x10202n);
    const expected=cpu(),hidden=cache(),originalPayload=Buffer.from(data.subarray(ramAt,ramAt+16384));
    const payload=Buffer.from(originalPayload),at=Number(dst-0x500000n);
    const value=meta.store?Buffer.from(data.subarray(base,base+size)):Buffer.from(payload.subarray(Number(src-0x500000n),Number(src-0x500000n)+size));
    payload.set(value,at);
    assert.equal(vm.vm_run(port,9n,1),2n);assert(cpu().equals(expected)&&cache().equals(hidden));
    assert(data.subarray(ramAt,ramAt+16384).equals(originalPayload),'wait publishes no payload fragment');
    assert.equal(vm.vm_source_retired(),0n);++waits;
    assert.equal(vm.vm_page_prepare(port,request),0);
    assert.equal(v.getBigUint64(request+8,true),0xd000n);
    const target=v.getUint32(request+24,true),ticket=v.getBigUint64(request+40,true);
    data.set(data.subarray(ramAt+4096,ramAt+8192),target);
    put(rows,entry+4096n);v.setUint32(rows+16,0,true);v.setUint32(rows+20,0xdeadbeef,true);
    assert.equal(vm.vm_page_commit(port,ticket),0);assert.equal(vm.vm_page_commit(port,ticket),-1);
    assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_source_retired(),1n);++retries;
    const mask=meta.address===32?0xffffffffn:0xffffffffffffffffn;
    if(!meta.store)expected.writeBigUInt64LE((src+BigInt(size))&mask,48);
    expected.writeBigUInt64LE((dst+BigInt(size))&mask,56);expected.writeBigUInt64LE(0x202n,392);
    expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);expected.writeBigUInt64LE(43n,1128);
    assert(cpu().equals(expected)&&cache().equals(hidden));
    const logical=Buffer.concat([data.subarray(ramAt,ramAt+4096),data.subarray(target,target+4096),data.subarray(ramAt+8192,ramAt+16384)]);
    assert(logical.equals(payload));
  }
}
const meta={form:0,sourceBytes:0,operandBinding:0};
const prefixRecords=await readFile(`${directory}/string-16.cases`);assert.equal(prefixRecords.length,4*38*8);
for(const repeated of [false,true])for(const segment of [0x36,0x3e,0x64,0x65]){
  const source=Buffer.alloc(4096,0x90),bytes=[segment,...(repeated?[0xf3]:[]),0xa4];source.set(bytes);
  cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  const status=cc.compiler_emit(entry,8,output,65536,report);
  if(segment===0x64||segment===0x65){assert.equal(status,-102,'FS/GS base cannot become flat DS');++baseSegmentRefusals;continue;}
  assert.equal(status,0);meta.sourceBytes=bytes.length;
  const body=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  const cut=(await WebAssembly.instantiate(body,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
  const form=(repeated?2:0)+(segment===0x3e?1:0),word=index=>prefixRecords.readBigUInt64LE((form*38+index)*8);
  vm.__indirect_function_table.set(slot,cut);reset(source,meta,word,0);
  const expected=cpu(),hidden=cache(),payload=Buffer.from(data.subarray(ramAt,ramAt+16384));
  for(let reg=0;reg<16;++reg)expected.writeBigUInt64LE(word(17+reg),reg*8);
  expected.writeBigUInt64LE(word(33)&~0x10000n,392);
  assert.equal(word(34),13n,'native observation, not a guessed SS-prefix vector');
  assert.equal(vm.vm_run(port,9n,1),word(34)*8n+3n);assert.equal(v.getUint32(port+24,true),Number(word(34)));
  assert.equal(v.getUint32(port+28,true),Number(word(35)));assert(cpu().equals(expected)&&cache().equals(hidden));
  assert(data.subarray(ramAt,ramAt+16384).equals(payload));++prefixNativeFaults;
}
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();}
console.log(JSON.stringify({format:'native-string-element-v1',status:'pass',compilerBytes:compiler.length,
  compilerSha256:createHash('sha256').update(compiler).digest('hex'),parity,direct,dispatch,nativeSuccess,nativeFault,
  waits,retries,refusals,rfModels,prefixNativeFaults,baseSegmentRefusals,moduleBytes,
  scope:'single MOVS/STOS, flat long-mode source, 32/64 address size; four native ignored SS/DS-prefix faults; hidden cache unchanged models; no FS/GS-base or debug/AC equivalence claim',linuxBoot:'not-tested'},null,2));
