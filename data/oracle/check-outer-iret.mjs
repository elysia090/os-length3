// Long-mode return models through the actual C VM. Independent native system
// observations are separate; this does not boot Linux or certify all IRET modes.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const arguments_=process.argv.slice(2),variant=arguments_.find(x=>x.startsWith('--return='));
if(variant&&!/^--return=(2|4|8),(0|1),(0|7)$/.test(variant))throw new Error('invalid return transaction');
const [operandBytes,far,discard]=variant?variant.slice(9).split(',').map(Number):[8,0,0];
const returnWord=(operandBytes===2?1:operandBytes===4?2:0)*65536+discard;
const [vmFile,compilerFile,hardwareFile,tcgFile,...extra]=arguments_.filter(x=>!x.startsWith('--return='));
if(!compilerFile||extra.length)throw new Error('usage: check-outer-iret.mjs VM.WASM COMPILER.WASM [HARDWARE-ROWS.log] [TCG-ROWS.log]');
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),directory=vm.vm_arena_min();
const base=directory+4096,segments=base+1408,port=base+2048;
const physical=[0x1000,0x2000,0x3000,0x4000,0x5000,0x6000,0x7000];
const payload=rank=>base+(rank+2)*4096;
const put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true);
const putSlot=(at,x,bytes)=>{for(let i=0;i<bytes;++i)data[at+i]=Number(BigInt.asUintN(64,BigInt(x))>>BigInt(i*8)&255n);};
const get=at=>v.getBigUint64(at,true);
let comparisons=0,faults=0,waits=0,refusals=0,compiled=0,native=0;
const compilerMemory=new WebAssembly.Memory({initial:16});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:compilerMemory}})).instance.exports;
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const source=new Uint8Array(compilerMemory.buffer),rv=new DataView(compilerMemory.buffer);
const spelling=Uint8Array.from([...(operandBytes===2?[0x66]:operandBytes===8?[0x48]:[]),far?(discard?0xca:0xcb):0xcf,...(far&&discard?[discard,0]:[])]);
source.fill(0x90,input,input+4096);source.set(spelling,input);
assert.equal(cc.compiler_open_pages(input,1,0x6000n,9n),0);
assert.equal(cc.compiler_emit(0x6000n,1,output,65536,report),0);
assert.equal(rv.getBigUint64(report+32,true),BigInt(spelling.length));
const cut=(await WebAssembly.instantiate(source.slice(output,output+Number(rv.getBigUint64(report+40,true))),
  {machine:{memory,iret:vm.vm_iret,far_return:vm.vm_return}})).instance.exports.cut;
const slot=vm.__indirect_function_table.grow(1),rows=directory+512;
vm.__indirect_function_table.set(slot,cut);
const binding=rv.getUint32(report+76,true);
function runCompiled() {
  put(base+384,0x6000);data.set(spelling,payload(5));
  put(rows,0x6000);v.setUint32(rows+8,spelling.length,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,binding,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);++compiled;
  return vm.vm_run(port,9n,1);
}
function reset(cpl,conforming=false,accessed=true) {
  vm.vm_close();data.fill(0,base);put(port,9);
  physical.forEach((p,rank)=>{const at=directory+rank*32;put(at,p);v.setUint32(at+8,(rank+2)*4096,true);
    v.setUint32(at+12,3,true);v.setUint32(at+16,1,true);data.fill(0,at+20,at+32);});
  put(payload(0),0x2027);put(payload(1),0x3027);put(payload(2),0xe7);
  const codeAccess=0x9a|(cpl<<5)|(conforming?4:0)|(accessed?1:0);
  const stackAccess=0x92|(cpl<<5)|(accessed?1:0);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  put(payload(3)+24,0x00af00000000ffffn|BigInt(codeAccess)<<40n);
  put(payload(3)+32,0x00cf00000000ffffn|BigInt(stackAccess)<<40n);
  for(let rank=0;rank<16;++rank)put(base+rank*8,BigInt(rank+1)*0xabcdefff123n);
  put(base+32,0x5e00);put(base+384,0xffffffff81000b7en);put(base+392,0x246);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0x500);
  put(base+448,0x4000);put(base+456,39);put(base+488,8);put(base+496,16);
  put(base+600,0x400);put(base+1128,123);
  v.setUint32(segments,2,true);v.setUint32(segments+4,2,true);
  for(const rank of [0,2,3,4,5]){
    put(base+480+rank*8,16);put(segments+8+rank*16,0x1000n+BigInt(rank)*0x1000n);
    v.setUint32(segments+8+rank*16+8,0xffffffff,true);v.setUint32(segments+8+rank*16+12,0xc093,true);
  }
  v.setUint32(segments+36,0xa09b,true);v.setUint32(segments+52,0xc093,true);
  const frame=payload(4)+0xe00;
  for(const [rank,x] of [0x600100,24|cpl,0x202,0x7e00,32|cpl].entries())put(frame+rank*8,x);
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,physical.length,physical.length,directory+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  return {frame,codeAccess,stackAccess};
}
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
const hidden=()=>Buffer.from(data.subarray(segments,segments+136));
if(!variant){
for(const cpl of [1,2,3])for(const conforming of [false,true])for(const accessed of [false,true])
for(const flags of [2n,0x202n,0x10647n,0x3d7fd5n,~0n])for(const rsp of [0x7e00n,0x800000000000n]) {
  const {frame,codeAccess,stackAccess}=reset(cpl,conforming,accessed);put(frame+16,flags);put(frame+24,rsp);
  const expected=cpu(),h=hidden();
  expected.writeBigUInt64LE(0x600100n,384);expected.writeBigUInt64LE(rsp,32);
  expected.writeBigUInt64LE(BigInt(24|cpl),488);expected.writeBigUInt64LE(BigInt(32|cpl),496);
  expected.writeBigUInt64LE((flags&0x3d7fd5n)|2n,392);h.writeUInt32LE(0,4);
  h.writeBigUInt64LE(0n,24);h.writeUInt32LE(0xffffffff,32);h.writeUInt32LE(0xa000|codeAccess|1,36);
  h.writeBigUInt64LE(0n,40);h.writeUInt32LE(0xffffffff,48);h.writeUInt32LE(0xc000|stackAccess|1,52);
  for(const rank of [0,3,4,5]) {
    expected.writeBigUInt64LE(0n,480+rank*8);
    h.writeUInt32LE(0x10000|(h.readUInt32LE(8+rank*16+12)&~128),8+rank*16+12);
  }
  assert.equal(vm.vm_iret(port),0n,`CPL0 -> CPL${cpl} long-mode return`);
  assert(cpu().equals(expected),'whole CPU, including no retirement at provider boundary');
  assert(hidden().equals(h),'whole hidden cache and obsolete lower-privilege selectors');
  assert.equal(data[payload(3)+29],codeAccess|1);assert.equal(data[payload(3)+37],stackAccess|1);++comparisons;
  const fresh=reset(cpl,conforming,accessed);put(fresh.frame+16,flags);put(fresh.frame+24,rsp);
  const retired=expected.readBigUInt64LE(1128);expected.writeBigUInt64LE(retired+1n,1128);
  assert.equal(runCompiled(),5n,'successful privilege/context return revokes the old execution admission');
  assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);
  assert(cpu().equals(expected),'compiled whole CPU, including one retirement and restored RF');
  assert(hidden().equals(h));
  assert.equal(vm.vm_run(port,9n,1),5n);assert(cpu().equals(expected));assert(hidden().equals(h));
  assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
}
for(const test of [
  {name:'null-cs',word:1,value:3,vector:13,error:0},
  {name:'code-dpl',descriptor:24,value:0x00afbb000000ffffn,vector:13,error:24},
  {name:'code-not-present',descriptor:24,value:0x00af7b000000ffffn,vector:11,error:24},
  {name:'code-data',descriptor:24,value:0x00cff3000000ffffn,vector:13,error:24},
  {name:'code-L-and-D',descriptor:24,value:0x00effb000000ffffn,vector:13,error:24},
  {name:'bad-rip',word:0,value:0x800000000000n,vector:13,error:0},
  {name:'null-user-ss',word:4,value:3,vector:13,error:0},
  {name:'stack-rpl',word:4,value:32,vector:13,error:32},
  {name:'stack-dpl',descriptor:32,value:0x00cfd3000000ffffn,vector:13,error:32},
  {name:'stack-code',descriptor:32,value:0x00affb000000ffffn,vector:13,error:32},
  {name:'stack-readonly',descriptor:32,value:0x00cff1000000ffffn,vector:13,error:32},
  {name:'stack-not-present',descriptor:32,value:0x00cf73000000ffffn,vector:12,error:32},
]) {
  const {frame}=reset(3);
  if(test.word!==undefined)put(frame+test.word*8,test.value);else put(payload(3)+test.descriptor,test.value);
  const before=cpu(),h=hidden();assert.equal(vm.vm_iret(port),BigInt(test.vector*8+3),test.name);
  assert.equal(v.getUint32(port+24,true),test.vector);assert.equal(v.getUint32(port+28,true),test.error);
  assert(cpu().equals(before));assert(hidden().equals(h));++faults;
  const fresh=reset(3);
  if(test.word!==undefined)put(fresh.frame+test.word*8,test.value);else put(payload(3)+test.descriptor,test.value);
  put(base+384,0x6000);const unchanged=cpu(),cache=hidden();
  assert.equal(runCompiled(),BigInt(test.vector*8+3),`compiled ${test.name}`);
  assert(cpu().equals(unchanged));assert(hidden().equals(cache));
  assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
}
for(const rank of [3,4]) {
  reset(3);v.setUint32(directory+rank*32+16,3,true);
  const before=cpu(),h=hidden();assert.equal(vm.vm_iret(port),2n);assert(cpu().equals(before));assert(hidden().equals(h));
  v.setUint32(directory+rank*32+16,1,true);assert.equal(vm.vm_iret(port),0n);++waits;
}
reset(3);put(port,8);const before=cpu(),h=hidden();assert.equal(vm.vm_iret(port),5n);
assert(cpu().equals(before));assert(hidden().equals(h));++refusals;
}
let oracleDifferences=[];
if(hardwareFile) {
  const parse=async file=>(await readFile(file,'utf8')).trim().split(/\r?\n/)
    .map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
  const observations=await parse(hardwareFile);
  assert([320,352].includes(observations.length),'complete independent system fixture');
  for(const [index,row] of observations.entries()) {
    assert.equal(row.length,observations.length===352?23:22);assert.equal(row[0],BigInt(index));
    const cpl=Number(row[1]),start=reset(cpl);
    let frame=start.frame;
    if(index>=320) {
      const rsp=row[6]-40n;put(base+32,rsp);frame=payload(4)+Number(rsp&4095n);
      put(payload(2),0x7027);put(payload(2)+8,0);data.fill(0,payload(6),payload(6)+4096);
      put(payload(6)+4*8,0x4027);put(payload(6)+6*8,0x6027);put(payload(6)+511*8,0x5027);
    }
    put(payload(3)+24,0x00af00000000ffffn|row[2]<<40n);
    put(payload(3)+32,0x00cf00000000ffffn|row[3]<<40n);
    const frameBytes=far?4*operandBytes+discard:5*operandBytes;
    const slotAt=rank=>frame+(far&&rank>=3?(rank-1)*operandBytes+discard:rank*operandBytes);
    putSlot(frame,row[7]===128n?row[9]-2n:variant?0x7000n:0x100260n,operandBytes);
    if(!far)putSlot(slotAt(2),row[4],operandBytes);
    putSlot(slotAt(3),row[5],operandBytes);putSlot(slotAt(1),24|cpl,operandBytes);putSlot(slotAt(4),32|cpl,operandBytes);
    if(index>>4===18&&operandBytes===8)putSlot(frame,0x800000000000n,operandBytes);
    if(index>>4===14)putSlot(slotAt(4),3,operandBytes);
    if(index>>4===20)putSlot(slotAt(1),3,operandBytes);
    put(base+384,row[7]===128n?row[9]-4n:row[9]);
    put(base+392,2);put(segments+8+4*16,row[18]);put(segments+8+5*16,row[19]);
    const prior=cpu(),cache=hidden(),result=far?vm.vm_return(port,returnWord):vm.vm_iret(port,returnWord);
    if(row[7]===128n) {
      assert.equal(result,0n,`hardware return ${index}`);
      assert.equal(get(base+384)+2n,row[9]);assert.equal(get(base+32),row[12]);
      assert.equal(get(base+488),row[10]);assert.equal(get(base+496),row[13]);assert.equal(get(base+392),row[11]);
    } else {
      assert.equal(result,row[7]*8n+3n,`hardware exception ${index}`);
      assert.equal(BigInt(v.getUint32(port+28,true)),row[8]);
      assert.equal(get(port+16),row[7]===14n?row[22]:row[9]);
      assert(cpu().equals(prior));assert(hidden().equals(cache));
      assert.equal(row[10],8n);assert.equal(row[13],16n);assert.equal(row[12],row[6]-BigInt(frameBytes));
      assert.equal(row[11],0x10002n,'native fault frame adds RF without retiring IRET');
    }
    for(const [rank,field] of [[3,14],[0,15],[4,16],[5,17]])assert.equal(get(base+480+rank*8),row[field]);
    assert.equal(get(segments+8+4*16),row[18]);assert.equal(get(segments+8+5*16),row[19]);
    assert.equal(BigInt(data[payload(3)+29]),row[20],`CS Accessed side effect ${index}`);
    assert.equal(BigInt(data[payload(3)+37]),row[21],`SS Accessed side effect ${index}`);++native;
    const expected=cpu(),hiddenResult=hidden();data.set(prior,base);data.set(cache,segments);
    data[payload(3)+29]=Number(row[2]);data[payload(3)+37]=Number(row[3]);
    if(row[7]===128n){expected.writeBigUInt64LE(expected.readBigUInt64LE(1128)+1n,1128);
      if(far)hiddenResult.writeUInt32LE(0,4);}
    else expected.writeBigUInt64LE(0x6000n,384);
    assert.equal(runCompiled(),row[7]===128n?5n:row[7]*8n+3n,`compiled hardware case ${index}`);
    assert(cpu().equals(expected),`compiled whole CPU ${index}`);assert(hidden().equals(hiddenResult),`compiled hidden cache ${index}`);
    assert.equal(vm.vm_completed(),row[7]===128n?1:0);
    assert.equal(vm.vm_source_retired(),row[7]===128n?1n:0n);
    if(row[7]===14n)assert.equal(get(port+16),row[22]);
    assert.equal(BigInt(data[payload(3)+29]),row[20]);assert.equal(BigInt(data[payload(3)+37]),row[21]);
  }
  if(tcgFile) {
    const reference=await parse(tcgFile);assert.equal(reference.length,observations.length);
    for(const [index,row] of reference.entries()) {
      assert.equal(row.length,observations[index].length);assert.equal(row[0],BigInt(index));
      for(let field=1;field<row.length;++field)if(row[field]!==observations[index][field]) {
        assert(field===20||field===21||(index>>4===12&&field===7)
          ||(index>>4===18&&field>=9&&field<=17)
          ||(index>>4===21&&(field===7||field===22||(field>=9&&field<=17))),
          `unclassified oracle disagreement ${index}:${field}`);
        oracleDifferences.push({case:index,field,hardware:`0x${observations[index][field].toString(16)}`,tcg:`0x${row[field].toString(16)}`});
      }
    }
  }
}
vm.vm_close();
console.log(JSON.stringify({format:'c-outer-iret-model-v1',status:'pass',comparisons,faults,waits,refusals,
  compiled,native,returnVariant:variant??'default IRETQ',oracleDifferences:{count:oracleDifferences.length,
    byField:Object.fromEntries([...new Set(oracleDifferences.map(x=>x.field))].map(field=>[field,oracleDifferences.filter(x=>x.field===field).length])),
    examples:oracleDifferences.slice(0,4)},
  oracle:hardwareFile?'whole C-state models, cold compiled/C table dispatch and independent hardware-assisted system observations'
    :'whole C-state models and cold compiled/C table dispatch; hardware observation not supplied',linuxBoot:'not-tested'},null,2));
