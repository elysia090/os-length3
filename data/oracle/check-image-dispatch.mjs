// Complete FINAL PF_X domain of the supplied bounded image, not Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {seedDisabledDebug} from './machine-observation.mjs';
const [vmFile,compilerFile,oldFile,elfFile,nativeModuleFile]=process.argv.slice(2);
if(!nativeModuleFile)throw new Error('VM.WASM COMPILER.WASM FROZEN-COMPILER.WASM VERIFIED-OPTIMIZED.elf NATIVE-MODULE.WASM');
const elf=await readFile(elfFile),memory=new WebAssembly.Memory({initial:16,maximum:32});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory}})).instance.exports;
const input=cc.compiler_arena_min(),bytes=new Uint8Array(memory.buffer);bytes.set(elf,input);
assert.equal(cc.compiler_open_elf(input,elf.length),0,'actual standard postlinked ELF must be accepted');
assert.equal(typeof cc.compiler_emit_image,'function',
  'cold C image generation must exist; selected cuts and proof counts are not the complete image dispatcher');
const output=input+16384,report=output+65536,v=new DataView(memory.buffer);
assert.equal(cc.compiler_image_report_bytes(),48);
assert.equal(cc.compiler_emit_image(256,65536,output,65536,report),0);
const emitted=Buffer.from(bytes.subarray(output,output+Number(v.getBigUint64(report+40,true))));
assert(emitted.equals(await readFile(nativeModuleFile)),'native / cold full-image bytes');
assert(WebAssembly.validate(emitted));
const module=new WebAssembly.Module(emitted);
assert(WebAssembly.Module.exports(module).some(x=>x.name==='entry' && x.kind==='function'));
assert(WebAssembly.Module.imports(module).some(x=>x.name==='image_bias' && x.kind==='global'));
const defined=Number(v.getBigUint64(report,true));
assert.equal(v.getBigUint64(report+8,true),1n);
// Test-only standard ELF reader. The product reader/planner remains C.
const entries=[],source=Buffer.alloc(4096);let sourcePage;
const ph=Number(elf.readBigUInt64LE(32)),phSize=elf.readUInt16LE(54),phCount=elf.readUInt16LE(56);
for(let i=0;i<phCount;++i){const at=ph+i*phSize;if(elf.readUInt32LE(at)!==1 || !(elf.readUInt32LE(at+4)&1))continue;
  const address=elf.readBigUInt64LE(at+16),file=Number(elf.readBigUInt64LE(at+8));
  const fileBytes=Number(elf.readBigUInt64LE(at+32)),extent=Number(elf.readBigUInt64LE(at+40));
  sourcePage??=address&~4095n;assert.equal(address&~4095n,sourcePage,'this oracle supports one source page, not an image-domain shortcut');
  assert(Number(address-sourcePage)+extent<=4096);source.set(elf.subarray(file,file+fileBytes),Number(address-sourcePage));
  for(let j=0;j<extent;++j)entries.push(address+BigInt(j));
}
assert(entries.length>1 && entries.length<=256);
assert.equal(v.getBigUint64(report+16,true),BigInt(entries.length),'every PF_X byte is a source coordinate');
const om=new WebAssembly.Memory({initial:16,maximum:32}),old=(await WebAssembly.instantiate(await readFile(oldFile),{machine:{memory:om}})).instance.exports;
const oi=old.compiler_arena_min(),oo=oi+16384,or=oo+65536,ob=Buffer.from(om.buffer),ov=new DataView(om.buffer);
ob.set(elf,oi);assert.equal(old.compiler_open_elf(oi,elf.length),0);
const cuts=[];
for(const entry of entries){assert.equal(old.compiler_emit(entry,1,oo,65536,or),0);
  cuts.push({module:new WebAssembly.Module(Buffer.from(ob.subarray(oo,oo+Number(ov.getBigUint64(or+40,true))))),
    span:ov.getUint32(or+32,true),binding:ov.getUint32(or+76,true)});}
old.compiler_close();cc.compiler_close();
const ram=new WebAssembly.Memory({initial:16,maximum:32}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory:ram}})).instance.exports;
const a=Buffer.from(ram.buffer),dv=new DataView(ram.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,
  rows=dir+512,branches=dir+2048,port=cpu+2048,segments=cpu+1408,codeView=port+64,code=cpu+24576,payload=cpu+28672;
const table=vm.__indirect_function_table,first=vm.vm_slot_min();table.grow(Math.max(0,first+vm.vm_source_capacity()-table.length));
const put=(at,value)=>dv.setBigUint64(at,BigInt.asUintN(64,BigInt(value)),true);
const realImports={memory:ram,access:vm.vm_access,reserve:vm.vm_reserve,commit:vm.vm_commit,
  write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end,
  segment:vm.vm_segment,reserve_pair:vm.vm_reserve_pair,commit_pair:vm.vm_commit_pair,table:vm.vm_table,
  read_pair:vm.vm_read_pair,read_extent:vm.vm_read_extent,far_return:vm.vm_return,control:vm.vm_control,
  iret:vm.vm_iret,msr:vm.vm_msr,debug:vm.vm_debug,io:vm.vm_io,time:vm.vm_time,interrupt_flag:vm.vm_flag,
  software_interrupt:vm.vm_software_interrupt,system_transfer:vm.vm_system,descriptor:vm.vm_descriptor,checkpoint:vm.vm_checkpoint,far_transfer:vm.vm_transfer};
assert.throws(()=>new WebAssembly.Instance(module,{machine:{...realImports,
  image_bias:new WebAssembly.Global({value:'i64',mutable:true},0n)}}),WebAssembly.LinkError,
  'image bias must be immutable throughout this instance lifetime');
function reset(entry,bias,cpl,permission){
  vm.vm_close();a.fill(0,dir);
  [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{
    put(dir+i*32,address);dv.setUint32(dir+i*32+8,(i+2)*4096,true);dv.setUint32(dir+i*32+12,3,true);dv.setUint32(dir+i*32+16,1,true);});
  const page=BigInt.asUintN(64,sourcePage+bias),stack=page+4096n;
  put(cpu+8192+Number((page>>39n)&511n)*8,0x2067);put(cpu+12288+Number((page>>30n)&511n)*8,0x3067);
  put(cpu+16384+Number((page>>21n)&511n)*8,0x4067);
  put(cpu+20480+Number((page>>12n)&511n)*8,0x8067);
  put(cpu+20480+Number((stack>>12n)&511n)*8,permission==='absent'?0n:permission==='readonly'?0x9065n:0x9067n);
  for(let r=0;r<16;++r)put(cpu+r*8,BigInt(r+1)*0x123456789abn);
  put(cpu,stack);put(cpu+32,stack);put(cpu+384,entry);put(cpu+392,0x10203);put(cpu+400,0x80010011);
  put(cpu+408,0x1000);put(cpu+416,0x6b0);put(cpu+424,0xd01);put(cpu+488,8|cpl);put(cpu+1128,41);put(port,9);
  seedDisabledDebug(dv,cpu);dv.setUint32(segments,2,true);dv.setUint32(segments+36,0xa09b,true);
  a.set(source,code);put(payload,0x1234);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,6,6,branches,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
}
let comparisons=0,refusals=0;
for(const bias of [0n,0x70000000n,0xffff800000000000n]){
  const image=new WebAssembly.Instance(module,{machine:{...realImports,image_bias:new WebAssembly.Global({value:'i64',mutable:false},bias)}}).exports;
  for(let i=0;i<entries.length;++i)for(const cpl of [0,3])for(const permission of ['readwrite','readonly','absent']){
    const entry=BigInt.asUintN(64,entries[i]+bias),baseline=new WebAssembly.Instance(cuts[i].module,{machine:realImports}).exports.cut;
    const run=fn=>{reset(entry,bias,cpl,permission);assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);
      table.set(dv.getUint32(rows+16,true),fn);assert.equal(vm.vm_source_publish(cuts[i].span,1,cuts[i].binding,rows),0);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0);const result=vm.vm_run(port,9n,1);
      return {result,retired:vm.vm_source_retired(),completed:vm.vm_completed(),
        state:Buffer.from(a.subarray(cpu,cpu+1256)),segments:Buffer.from(a.subarray(segments,segments+136)),
        port:Buffer.from(a.subarray(port,port+64)),ram:Buffer.from(a.subarray(payload,payload+4096))};};
    assert.deepEqual(run(image.entry),run(baseline));++comparisons;
  }
  for(const offset of [-1n,BigInt(entries.length),0x100000000n]){
    const entry=BigInt.asUintN(64,sourcePage+bias+offset);reset(entry,bias,0,'readwrite');
    const before=Buffer.from(a.subarray(cpu,cpu+1256));
    assert.equal(image.entry(cpu,port,entry,0),6n);assert(a.subarray(cpu,cpu+1256).equals(before));++refusals;
  }
}
vm.vm_close();console.log(JSON.stringify({format:'bounded-complete-elf-dispatch-v1',status:'pass',
  sourceCoordinates:entries.length,definedBodies:defined,dispatchers:1,comparisons,refusals,biases:3,
  oracle:'native/cold bytes; every final PF_X coordinate against frozen C compiler through actual C MMU/table, CPL/permissions/faults',
  linuxBoot:'not-tested',largeImageDirectory:'not-tested-by-this-oracle',productionRoot:'not-published'},null,2));
