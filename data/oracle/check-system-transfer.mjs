// Actual C boundary/cold compiler/table execution against independent system
// observations. This is neither a guest executor nor a Linux syscall adapter.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,hardwareFile,nativeDirectory,tcgFile,...extra]=process.argv.slice(2);
if(!hardwareFile||extra.length)throw new Error('usage: check-system-transfer.mjs VM.WASM COMPILER.WASM HARDWARE-ROWS.log [NATIVE-DIRECTORY] [TCG-ROWS.log]');
const memory=new WebAssembly.Memory({initial:8});
const provider=new WebAssembly.Module(await readFile(vmFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const vm=(await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),directory=vm.vm_arena_min();
const base=directory+4096,segments=base+1408,port=base+2048,rows=directory+512;
const put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true),get=at=>v.getBigUint64(at,true);
const payload=rank=>base+(rank+2)*4096;
const physical=[0x1000,0x2000,0x3000,0x100000];
const cpu=()=>Buffer.from(data.subarray(base,base+1256)),hidden=()=>Buffer.from(data.subarray(segments,segments+136));
const ram=()=>Buffer.from(data.subarray(payload(0),payload(3)+4096));
const ccMemory=new WebAssembly.Memory({initial:16});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:ccMemory}})).instance.exports;
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const source=new Uint8Array(ccMemory.buffer),rv=new DataView(ccMemory.buffer);
const forms=[[0x0f,0x05],[0x48,0x0f,0x07]],cuts=[],modules=[],bindings=[],slots=[];
for(const [op,bytes]of forms.entries()) {
  source.fill(0x90,input,input+4096);source.set(bytes,input);
  assert.equal(cc.compiler_open_pages(input,1,0x100000n,9n),0);
  assert.equal(cc.compiler_emit(0x100000n,8,output,65536,report),0);
  assert.equal(rv.getUint32(report+56,true),1);assert.equal(rv.getBigUint64(report+32,true),BigInt(bytes.length));
  const module=source.slice(output,output+Number(rv.getBigUint64(report+40,true)));
  const parsed=new WebAssembly.Module(module);
  assert.deepEqual(WebAssembly.Module.imports(parsed),[{module:'machine',name:'memory',kind:'memory'},
    {module:'machine',name:'system_transfer',kind:'function'}]);
  const cut=(await WebAssembly.instantiate(parsed,{machine:{memory,system_transfer:vm.vm_system}})).exports.cut;
  if(nativeDirectory)assert.deepEqual(Buffer.from(module),await readFile(`${nativeDirectory}/system-${op}.wasm`),'native C/cold C byte parity');
  cuts.push(cut);modules.push(module.length);bindings.push(rv.getUint32(report+76,true));
  const slot=vm.__indirect_function_table.grow(1);vm.__indirect_function_table.set(slot,cut);slots.push(slot);
}
function reset(op,cpl=op?0:3,entry=op?0x1002bbn:0x100230n) {
  vm.vm_close();data.fill(0,base);put(port,9);
  physical.forEach((address,rank)=>{const at=directory+rank*32;put(at,address);v.setUint32(at+8,(rank+2)*4096,true);
    v.setUint32(at+12,3,true);v.setUint32(at+16,1,true);data.fill(0,at+20,at+32);});
  put(payload(0),0x2027);put(payload(1),0x3027);put(payload(2),0xe7);
  data.set(forms[op],payload(3)+Number(entry&4095n));
  for(let rank=0;rank<16;++rank)put(base+rank*8,BigInt(rank+1)*0xabcdefff123n);
  put(base+32,0x800000000000n);put(base+384,entry);put(base+392,0x10647);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0x501);
  put(base+488,8|cpl);put(base+496,16|cpl);put(base+600,0x400);put(base+1128,123);
  v.setUint32(base+608,6,true);
  [0xc0000102,0x1a0,0xc0000081,0xc0000082,0xc0000083,0xc0000084].forEach((key,rank)=>put(base+616+rank*8,key));
  [0n,0x1801n,0x0018000800000000n,0x100240n,0n,0x600n].forEach((value,rank)=>put(base+872+rank*8,value));
  put(base+8,0x1002be);put(base+88,0x8000000000038647n);
  v.setUint32(segments,2,true);v.setUint32(segments+4,2,true);
  for(let rank=0;rank<8;++rank){put(segments+8+rank*16,BigInt(rank)*0x12345000n);
    v.setUint32(segments+16+rank*16,0xffffffff,true);v.setUint32(segments+20+rank*16,0xc093,true);}
  v.setUint32(segments+36,0xa09b|(cpl<<5),true);
  // Bind only borrowed CPU/cache records. No TSS/GDT/stack page exists.
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,4,4,directory+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
let models=0,faults=0,direct=0,dispatch=0,hardware=0,refusals=0;
function expected(op) {
  const state=cpu(),cache=hidden();let vector=0;
  if(!(get(base+424)&1n))vector=6;
  else if(op && ((get(base+488)&3n)||!canonical(get(base+8))))vector=13;
  if(!vector){
    const star=get(base+888),target=op?get(base+8):get(base+896);
    const flags=op?(get(base+88)&0x3c7fd7n)|2n:((get(base+392)&~0x10000n)&~get(base+912))|2n;
    state.writeBigUInt64LE(target,384);state.writeBigUInt64LE(flags,392);
    state.writeBigUInt64LE(op?(((star>>48n)+16n)&65535n)|3n:(star>>32n)&65532n,488);
    state.writeBigUInt64LE(op?(((star>>48n)+8n)&65535n)|3n:((star>>32n)+8n)&65535n,496);
    if(!op){state.writeBigUInt64LE(get(base+384)+2n,8);state.writeBigUInt64LE(get(base+392)&~0x10000n,88);}
    cache.writeUInt32LE(0,4);cache.writeBigUInt64LE(0n,24);cache.writeBigUInt64LE(0n,40);
    cache.writeUInt32LE(0xffffffff,32);cache.writeUInt32LE(0xffffffff,48);
    cache.writeUInt32LE(op?0xa0fb:0xa09b,36);cache.writeUInt32LE(op?0xc0f3:0xc093,52);
  }
  return {state,cache,vector};
}
const canonical=x=>x>>47n===0n||x>>47n===0x1ffffn;
function compare(op,wanted,mode) {
  const before=cpu(),cache=hidden(),memoryBefore=ram(),entry=get(base+384);
  let result;
  if(mode===0)result=vm.vm_system(port,op,op?0n:entry+2n);
  else if(mode===1){result=cuts[op](base,port,entry,bindings[op]);++direct;}
  else {
    put(rows,entry);v.setUint32(rows+8,forms[op].length,true);v.setUint32(rows+12,1,true);
    v.setUint32(rows+16,slots[op],true);v.setUint32(rows+20,bindings[op],true);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);result=vm.vm_run(port,9n,1);++dispatch;
  }
  const state=Buffer.from(wanted.state);
  if(!wanted.vector&&mode)state.writeBigUInt64LE(state.readBigUInt64LE(1128)+1n,1128);
  assert.equal(result,wanted.vector?BigInt(wanted.vector*8+3):mode===0?0n:mode===1?1n:5n);
  assert(cpu().equals(state),'whole CPU and exactly one successful compiled retirement');
  assert(hidden().equals(wanted.cache),'whole hidden cache: no data/FS/GS invalidation');
  assert(ram().equals(memoryBefore),'no TSS/GDT/stack/table payload access');
  if(wanted.vector){assert.equal(v.getUint32(port+24,true),wanted.vector);assert.equal(v.getUint32(port+28,true),0);
    assert.equal(get(port+16),entry);assert(cpu().equals(before)&&hidden().equals(cache));++faults;}
  if(mode===2){assert.equal(vm.vm_completed(),wanted.vector?0:1);assert.equal(vm.vm_source_retired(),wanted.vector?0n:1n);
    if(!wanted.vector){assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
      assert(cpu().equals(state)&&hidden().equals(wanted.cache));}}
}
for(const op of [0,1])for(const cpl of [0,1,2,3])for(const selector of [0n,8n,9n,64n,0xffffn])
for(const mask of [0n,2n,0x600n,0xffffffffn])for(const sce of [0,1])for(const bad of [false,true]) {
  let wanted;
  for(let mode=0;mode<3;++mode){reset(op,cpl);put(base+888,((0xffffn-selector)<<48n)|(selector<<32n));put(base+912,mask);
    put(base+424,sce?0x501:0x500);if(bad)put(base+8,0x800000000000n);
    wanted=expected(op);compare(op,wanted,mode);}
  ++models;
}
const observations=(await readFile(hardwareFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
assert.equal(observations.length,64);
for(const [index,row]of observations.entries()) {
  assert.equal(row.length,32);assert.equal(row[0],BigInt(index));
  for(const op of (index<48?[0,1]:[0])) {
    for(let mode=0;mode<3;++mode){
      reset(op,op?0:3,row[op?25:24]);put(base+888,row[3]);put(base+912,row[2]);put(base+424,row[26]);
      put(base+32,op?(index<32?row[4]:row[19]):row[4]);
      put(base+392,op?2n:(row[11]||row[1])|((row[1]&0x10000n)));
      put(segments+72,row[27]);put(segments+88,row[28]);
      if(op){put(base+8,row[12]);put(base+88,row[13]);put(base+488,row[6]);put(base+496,row[7]);}
      const wanted=expected(op);
      if(!op && index<48){
        assert.equal(wanted.state.readBigUInt64LE(488),row[6]);assert.equal(wanted.state.readBigUInt64LE(496),row[7]);
        assert.equal(wanted.state.readBigUInt64LE(392),row[8]);assert.equal(wanted.state.readBigUInt64LE(32),row[9]);
        assert.equal(wanted.state.readBigUInt64LE(8),row[10]);assert.equal(wanted.state.readBigUInt64LE(88),row[11]);
      }else if(op && index<32){
        assert.equal(wanted.state.readBigUInt64LE(384)+2n,row[16]);assert.equal(wanted.state.readBigUInt64LE(488),row[17]);
        assert.equal(wanted.state.readBigUInt64LE(392),row[18]);assert.equal(wanted.state.readBigUInt64LE(32),row[19]);
        assert.equal(wanted.state.readBigUInt64LE(496),row[20]);
      }else {assert.equal(BigInt(wanted.vector),row[14]);assert.equal(row[15],0n);
        assert.equal(get(base+384),row[16]);assert.equal(get(base+32),row[19]);}
      compare(op,wanted,mode);
    }
    ++hardware;
  }
}
for(const test of ['stale','unprivate','misaligned','generation','bad-op','next-zero','next-long','return-next','TF','CET','bank','mode','forged-CS','code-data']) {
  reset(0);let p=port,op=0,next=get(base+384)+2n;
  if(test==='stale')put(port,8);if(test==='unprivate')p=base;if(test==='misaligned')p=port+1;
  if(test==='generation')put(port,0);if(test==='bad-op')op=2;if(test==='next-zero')next=get(base+384);
  if(test==='next-long')next+=14n;if(test==='return-next')op=1;
  if(test==='TF')put(base+392,get(base+392)|0x100n);if(test==='CET')put(base+416,get(base+416)|(1n<<23n));
  if(test==='bank')put(base+640,0);if(test==='mode')put(base+424,0);
  if(test==='forged-CS')v.setUint32(segments+36,0xa09b,true);
  if(test==='code-data')v.setUint32(segments+36,0xa0f3,true);
  const state=cpu(),cache=hidden(),all=ram();const result=vm.vm_system(p,op,next);
  assert.equal(result,test==='stale'||test==='generation'?5n:6n,test);
  assert(cpu().equals(state)&&hidden().equals(cache)&&ram().equals(all));++refusals;
}
// Grammar rejection must preserve the entire caller-owned output/report.
for(const bytes of [[0x0f,0x07],[0x0f,0x34],[0x0f,0x35],[0xf0,0x0f,0x05],[0xf0,0x48,0x0f,0x07]]) {
  source.fill(0x90,input,input+4096);source.set(bytes,input);
  assert.equal(cc.compiler_open_pages(input,1,0x100000n,9n),0);source.fill(0xa5,output,report+cc.compiler_report_bytes());
  assert.equal(cc.compiler_emit(0x100000n,8,output,65536,report),-102);
  assert(source.subarray(output,report+cc.compiler_report_bytes()).every(x=>x===0xa5));
}
vm.vm_close();
let oracleDifferences={count:0,byField:{}};
if(tcgFile) {
  const reference=(await readFile(tcgFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
  assert.equal(reference.length,64);const differences=[];
  for(const [index,row]of reference.entries()) {
    assert.equal(row.length,32);assert.equal(row[0],BigInt(index));
    for(let field=1;field<32;++field)if(row[field]!==observations[index][field]) {
      assert(index<48 && ([7,8,23].includes(field) || (index<32 && [14,16,18].includes(field))
        || (index>=32 && [16,17,18,20,22].includes(field))),`unclassified TCG difference ${index}:${field}`);
      differences.push({index,field});
    }
  }
  oracleDifferences={count:differences.length,byField:Object.fromEntries([...new Set(differences.map(x=>x.field))]
    .sort((a,b)=>a-b).map(field=>[field,differences.filter(x=>x.field===field).length]))};
  assert.deepEqual(oracleDifferences,{count:232,byField:{7:36,8:12,14:32,16:48,17:16,18:48,20:16,22:16,23:8}});
}
console.log(JSON.stringify({format:'c-system-transfer-v1',status:'pass',models,faults,direct,dispatch,hardware,
  refusals,nativeCompilerParity:nativeDirectory?2:0,moduleBytes:modules,oracleDifferences,
  observed:'64 independent hardware-assisted rows; 48 calls, 32 returns, 16 return #GP, 16 call #UD',
  scope:'48-bit Intel long mode, SCE and forced CS/SS caches; no compat/CET/debug or SMP claim',linuxBoot:'not-tested'},null,2));
