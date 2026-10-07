// One Node/browser diagnostic; C owns source selection and actual execution.
// Its standard ELF loading is fixture setup, never a product guest parser.
import {CompiledModules} from '../../../web/compiled-modules.mjs';
import {equal} from './assertion.mjs';
class Bytes extends Uint8Array {
  constructor(value,offset,length){super(value,offset,length);this.view=new DataView(this.buffer,this.byteOffset,this.byteLength);}
  static from(value){return new Bytes(value);}
  static alloc(length){return new Bytes(length);}
  readUInt16LE(at){return this.view.getUint16(at,true);}
  readUInt32LE(at){return this.view.getUint32(at,true);}
  readBigUInt64LE(at){return this.view.getBigUint64(at,true);}
  equals(other){return this.length===other.length && this.every((byte,i)=>byte===other[i]);}
  hex(){return Array.from(this,byte=>byte.toString(16).padStart(2,'0')).join('');}
}
const assert=(value,message='image admission assertion')=>{if(!value)throw new Error(message);};
assert.equal=equal;
assert.deepEqual=(actual,expected)=>{
  for(const key of Object.keys(actual)){
    if(actual[key] instanceof Uint8Array)assert(actual[key].equals(expected[key]),`state bytes: ${key}`);
    else equal(actual[key],expected[key]);
  }
};
export async function checkImageAdmission(vmBytes,compilerBytes,elfBytes,root,readObject){
const elf=Bytes.from(elfBytes),source=Bytes.alloc(8192),entries=[];
const ph=Number(elf.readBigUInt64LE(32)),size=elf.readUInt16LE(54),count=elf.readUInt16LE(56);let sourcePage,sourceEnd=0;
// Only test environment loading reads standard ELF. Product source selection is C.
for(let i=0;i<count;++i){const at=ph+i*size;if(elf.readUInt32LE(at)!==1 || !(elf.readUInt32LE(at+4)&1))continue;
  const address=elf.readBigUInt64LE(at+16),offset=Number(elf.readBigUInt64LE(at+8)),file=Number(elf.readBigUInt64LE(at+32)),memory=Number(elf.readBigUInt64LE(at+40));
  sourcePage??=address&~4095n;assert(address>=sourcePage);assert(Number(address-sourcePage)+memory<=source.length);
  sourceEnd=Math.max(sourceEnd,Number(address-sourcePage)+memory);
  source.set(elf.subarray(offset,offset+file),Number(address-sourcePage));for(let j=0;j<memory;++j)entries.push(address+BigInt(j));}
assert(entries.length);const sourcePages=Math.ceil(sourceEnd/4096),stackRank=4+sourcePages;
const cm=new WebAssembly.Memory({initial:16,maximum:32}),cc=(await WebAssembly.instantiate(compilerBytes,{machine:{memory:cm}})).instance.exports;
const ci=cc.compiler_arena_min(),co=ci+16384,cr=co+65536,c=Bytes.from(cm.buffer),cv=new DataView(cm.buffer);
c.set(elf,ci);assert.equal(cc.compiler_open_elf(ci,elf.length),0);
const baseline=[];for(const entry of entries){assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  baseline.push({code:new WebAssembly.Module(Bytes.from(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))))),
    span:cv.getUint32(cr+32,true),binding:cv.getUint32(cr+76,true)});}
cc.compiler_close(); // No compilation may occur in the execution sequence.
let nodeReads=0,objectReads=0,comparisons=0,refusals=0,constructions=0,tailAdmissions=0,engineLookups=0;
async function context(){
  const memory=new WebAssembly.Memory({initial:16,maximum:32}),vm=(await WebAssembly.instantiate(vmBytes,{machine:{memory}})).instance.exports;
  for(const name of ['vm_directory_image_source_bind','vm_directory_image_plan','vm_directory_image_publish','vm_directory_image_select'])assert.equal(typeof vm[name],'function',name);
  const a=Bytes.from(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,
    branches=dir+2048,segments=cpu+1408,port=cpu+2048,codeView=port+64,rootAt=cpu+2560,request=cpu+2688,plan=cpu+2816,blob=cpu+4096,reserved=131072;
  const put=(at,n)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(n)),true),payload=i=>cpu+reserved+i*4096;
  const table=vm.__indirect_function_table,first=vm.vm_slot_min();table.grow(Math.max(0,first+vm.vm_source_capacity()-table.length));
  const imports={memory,access:vm.vm_access,reserve:vm.vm_reserve,commit:vm.vm_commit,
    write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end,
    segment:vm.vm_segment,reserve_pair:vm.vm_reserve_pair,commit_pair:vm.vm_commit_pair,table:vm.vm_table,
    read_pair:vm.vm_read_pair,read_extent:vm.vm_read_extent,far_return:vm.vm_return,control:vm.vm_control,
    iret:vm.vm_iret,msr:vm.vm_msr,debug:vm.vm_debug,io:vm.vm_io,time:vm.vm_time,interrupt_flag:vm.vm_flag,
    software_interrupt:vm.vm_software_interrupt,system_transfer:vm.vm_system,floating_wait:vm.vm_floating_wait};
  function seed(entry,bias){
    const stack=BigInt.asUintN(64,sourcePage+bias)+BigInt(sourcePages*4096);
    a.fill(0,cpu,cpu+1256);a.fill(0,segments,segments+136);a.fill(0,port,port+48);
    a.fill(0,payload(stackRank),payload(stackRank+1)+4096);
    for(let r=0;r<16;++r)put(cpu+r*8,0x123456789abcdefn+BigInt(r));
    put(cpu,stack);put(cpu+32,stack);put(cpu+56,stack);put(cpu+384,entry);put(cpu+392,0x10203);put(cpu+400,0x80010011);
    put(cpu+408,0x1000);put(cpu+416,0x6b0);put(cpu+424,0xd01);put(cpu+488,8);put(cpu+528,0xface);put(cpu+536,0xbeef);put(cpu+1128,41);put(port,1);
    v.setBigUint64(cpu+600,0x400n,true); // Fixed disabled-debug profile, not a guest operation.
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);put(payload(stackRank),0x1234);
  }
  function reset(entry,bias){
    vm.vm_close();a.fill(0,dir);const page=BigInt.asUintN(64,sourcePage+bias);
    const addresses=[0x1000,0x2000,0x3000,0x4000,...Array.from({length:sourcePages+2},(_,i)=>0x8000+i*4096)];
    addresses.forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,reserved+i*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0)+Number((page>>39n)&511n)*8,0x2067);put(payload(1)+Number((page>>30n)&511n)*8,0x3067);
    put(payload(2)+Number((page>>21n)&511n)*8,0x4067);
    for(let i=0;i<sourcePages+2;++i){const address=page+BigInt(i*4096);assert.equal(address>>21n,page>>21n);
      put(payload(3)+Number((address>>12n)&511n)*8,0x8067+i*4096);}
    seed(entry,bias);
    a.set(source.subarray(0,sourcePages*4096),payload(4));put(payload(stackRank),0x1234);
    assert.equal(vm.vm_open(cpu,a.length-cpu,reserved,dir,addresses.length,addresses.length,branches,1n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    a.set(root,rootAt);assert.equal(vm.vm_directory_bind(rootAt,1n,65536),0);
  }
  async function query(major,key,kind,identity=false){
    assert.equal(vm.vm_directory_query(1n,major,key,kind),0);
    while(vm.vm_directory_status()===2){assert.equal(vm.vm_directory_request(request,1n),2);
      const token=v.getBigUint64(request+8,true),n=v.getUint32(request+48,true),opaque=a.subarray(request+16,request+48).hex();
      const bytes=await readObject(opaque);assert.equal(bytes.length,n);a.set(bytes,blob);
      assert(vm.vm_directory_node_commit(blob,n,1n,token)>=0);++nodeReads;}
    assert.equal(vm.vm_directory_request(request,1n),3);const token=v.getBigUint64(request+8,true);
    if(identity){assert.equal(vm.vm_directory_image_source_bind(1n,token),0);vm.vm_directory_cancel_request();return token;}
    const n=v.getUint32(request+48,true),opaque=a.subarray(request+16,request+48).hex(),bytes=await readObject(opaque);
    assert.equal(bytes.length,n);a.set(bytes,blob);assert.equal(vm.vm_directory_object_commit(blob,n,1n,token),0);++objectReads;return token;
  }
  function pending(entry,limit=1){assert.equal(vm.vm_source_query(port,entry,limit,codeView,rows),1n);}
  function extend(){assert.equal(vm.vm_source_extend(port,codeView,rows),1n);}
  function install(fn,span,binding){table.set(v.getUint32(rows+16,true),fn);assert.equal(vm.vm_source_publish(span,1,binding,rows),0);}
  function run(){assert.equal(vm.vm_bind_execution(rows,1,1n),0);const result=vm.vm_run(port,1n,1);
    return {result,state:Bytes.from(a.subarray(cpu,cpu+1256)),segments:Bytes.from(a.subarray(segments,segments+136)),
      port:Bytes.from(a.subarray(port,port+48)),ram:Bytes.from(a.subarray(payload(stackRank),payload(stackRank+1)+4096)),retired:vm.vm_source_retired()};}
  return {vm,a,v,dir,cpu,rows,port,plan,blob,payload,imports,reset,seed,query,pending,extend,install,run};
}
const actual=await context(),reference=await context();
for(const bias of [0n,0x70000000n,0xffff800000000000n]){
  const engines=new CompiledModules({machine:{...actual.imports,image_bias:new WebAssembly.Global({value:'i64',mutable:false},bias)}},
    {maximumEntries:2,maximumBytes:65536});
  actual.reset(BigInt.asUintN(64,entries[0]+bias),bias);await actual.query(0n,0n,6,true);let token=0n,instanceTicket=0n,instance;
  try{for(let i=0;i<entries.length;++i){const entry=BigInt.asUintN(64,entries[i]+bias);
    actual.seed(entry,bias);actual.pending(entry);
    const select=token?actual.vm.vm_directory_image_select(1n,entries[i]):-153;
    if(select===-154){actual.extend();++tailAdmissions;assert.equal(actual.vm.vm_directory_image_select(1n,entries[i]),0);}
    if(select && select!==-154){assert.equal(select,-153);token=await actual.query(1n,entries[i],5);}
    let planned=actual.vm.vm_directory_image_plan(1n,token,actual.plan);
    if(planned===-154){actual.extend();++tailAdmissions;planned=actual.vm.vm_directory_image_plan(1n,token,actual.plan);}
    assert.equal(planned,0,`coordinate ${entries[i].toString(16)}, bias ${bias.toString(16)}`);
    const at=actual.v.getUint32(actual.plan,true),n=actual.v.getUint32(actual.plan+4,true);
    assert.equal(actual.v.getBigUint64(actual.plan+8,true),BigInt.asUintN(64,bias));assert.equal(actual.v.getUint32(actual.plan+20,true),0);
    // A successful C plan preserves the pinned object's ticket. Do not hash
    // and compare the complete code witness again for each source coordinate.
    if(instanceTicket!==token){instance=await engines.get(actual.a.subarray(at,at+n));instanceTicket=token;++engineLookups;}
    else assert(engines.demand(instance));
    actual.vm.__indirect_function_table.set(actual.v.getUint32(actual.rows+16,true),instance.exports.entry);
    assert.equal(actual.vm.vm_directory_image_publish(1n,token,actual.rows),0);const observed=actual.run();
    reference.reset(entry,bias);const fn=new WebAssembly.Instance(baseline[i].code,{machine:reference.imports}).exports.cut;
    reference.pending(entry);if(Number(entry&4095n)+baseline[i].span>4096)reference.extend();
    reference.install(fn,baseline[i].span,baseline[i].binding);assert.deepEqual(observed,reference.run());++comparisons;
  }}finally{constructions+=engines.stats().compilations;engines.close();}
}
// Refusals preserve the caller's DTO/row; they are not synthetic guest faults.
const entry=entries[0];actual.reset(entry,0n);let token=await actual.query(1n,entry,5);actual.pending(entry);
actual.a.fill(0xa5,actual.plan,actual.plan+24);const unchanged=Bytes.from(actual.a.subarray(actual.plan,actual.plan+24));
assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.plan),-150);assert(actual.a.subarray(actual.plan,actual.plan+24).equals(unchanged));++refusals;
actual.reset(entry,0n);await actual.query(0n,0n,6,true);token=await actual.query(1n,entry,5);actual.pending(entry);
for(const [generation,ticket] of [[2n,token],[1n,token+1n]]){actual.a.fill(0xa5,actual.plan,actual.plan+24);
  assert.equal(actual.vm.vm_directory_image_plan(generation,ticket,actual.plan),-141);assert(actual.a.subarray(actual.plan,actual.plan+24).equals(unchanged));++refusals;}
const changed=actual.payload(4)+Number(entry-sourcePage);
actual.a[changed]^=1;assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.plan),-152);++refusals;actual.a[changed]^=1;
assert.equal(actual.vm.vm_directory_image_source_bind(1n,token),-150);++refusals;
// Failed pinned reselection must restore the previous coordinate/ticket. In
// particular a matching byte elsewhere must not silently select a new bias.
for(const [generation,coordinate,error] of [[2n,entry,-141],[1n,entry-1n,-153],[1n,entries.at(-1)+1n,-153]]){
  assert.equal(actual.vm.vm_directory_image_select(generation,coordinate),error);++refusals;}
if(Number(entry&4095n)+baseline[0].span>4096){
  actual.a.fill(0xa5,actual.plan,actual.plan+24);
  assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.plan),-154);
  assert(actual.a.subarray(actual.plan,actual.plan+24).equals(unchanged));++refusals;actual.extend();
  actual.a[actual.payload(5)]^=1;assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.plan),-152);++refusals;
  actual.a[actual.payload(5)]^=1;
}
assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.plan),0);
const validPlan=Bytes.from(actual.a.subarray(actual.plan,actual.plan+24));
actual.a[changed]^=1;
assert.equal(actual.vm.vm_directory_image_select(1n,entry+1n),-152);++refusals;actual.a[changed]^=1;
assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.plan),0);
assert(actual.a.subarray(actual.plan,actual.plan+24).equals(validPlan));
assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.blob),-150);++refusals;
const rowBefore=Bytes.from(actual.a.subarray(actual.rows,actual.rows+24));
assert.equal(actual.vm.vm_directory_image_publish(2n,token,actual.rows),-141);
assert(actual.a.subarray(actual.rows,actual.rows+24).equals(rowBefore));++refusals;
actual.vm.vm_directory_cancel_request();assert.equal(actual.vm.vm_directory_image_plan(1n,token,actual.plan),-150);++refusals;
assert.equal(actual.vm.vm_directory_image_select(1n,entry),-150);++refusals;
actual.vm.vm_close();reference.vm.vm_close();
return {format:'c-image-source-admission-v1',status:'pass',coordinates:entries.length,comparisons,refusals,
  engineConstructions:constructions,engineLookups,biases:3,nodeReads,objectReads,tailAdmissions,executionCompilerCalls:0,
  sourceIdentity:'authenticated C source-row digest; source ELF not readAll in VM',
  oracle:'actual C MMU/source/table execution against current standalone compiler; not independent native ISA proof',
  linuxBoot:'not-tested',productionRoot:'local trusted fixture, not signed release'};
}
