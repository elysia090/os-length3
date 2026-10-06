// Independent x86 observations -> shared cold C -> direct and C-VM execution.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory,beforeDirectory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM NATIVE-DIRECTORY [PRE-LOWERING-DIRECTORY]');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const dir=vm.vm_arena_min(),base=dir+4096,port=base+2048,segments=base+1408,rows=dir+512,codeView=port+64,code=base+24576;
const entry=0x400000n,table=vm.__indirect_function_table,first=vm.vm_slot_min();
table.grow(Math.max(0,first+vm.vm_source_capacity()-table.length));
const put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true),cpu=()=>Buffer.from(data.subarray(base,base+1256));
function reset(before){
  vm.vm_close();data.fill(0,dir);data.set(before,base);
  for(let i=0;i<5;++i){put(dir+i*32,i<4?(i+1)*4096:0x8000);v.setUint32(dir+i*32+8,(i+2)*4096,true);
    v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);put(base+20480,0x8067);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);put(base+488,8);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,5,5,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
function projected(record){
  const result=Buffer.from(record);result.writeBigUInt64LE(0x80010011n,400);result.writeBigUInt64LE(0x1000n,408);
  result.writeBigUInt64LE(32n,416);result.writeBigUInt64LE(0xd00n,424);result.writeBigUInt64LE(8n,488);return result;
}
async function compile(page,instructions=1){
  cold.set(page,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,instructions,output,65536,report),0);
  const n=Number(cv.getBigUint64(report+40,true)),module=Buffer.from(cold.subarray(output,output+n));
  assert.deepEqual(WebAssembly.Module.imports(await WebAssembly.compile(module)),[{module:'machine',name:'memory',kind:'memory'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory}})).instance.exports.cut;
  return {cut,module,length:Number(cv.getBigUint64(report+32,true)),instructions:Number(cv.getBigUint64(report+24,true))};
}
const laneMask=bits=>(1n<<BigInt(bits))-1n;
function model(before,compare,bits,dst,src,legacy=false){
  const result=Buffer.from(before),mask=laneMask(bits),sign=1n<<BigInt(bits-1);
  const index=reg=>legacy&&reg>=4?reg-4:reg,shift=reg=>legacy&&reg>=4?8n:0n;
  const read=reg=>(result.readBigUInt64LE(index(reg)*8)>>shift(reg))&mask;
  const write=(reg,value)=>{
    const at=index(reg)*8,s=shift(reg),kept=bits>=32?0n:result.readBigUInt64LE(at)&~(mask<<s);
    result.writeBigUInt64LE(kept|((value&mask)<<s),at);
  };
  const d=read(dst),s=read(src),a=result.readBigUInt64LE(0)&mask,left=compare?a:d,right=compare?d:s;
  const value=(compare?left-right:left+right)&mask;
  let parity=0;for(let i=0;i<8;++i)parity^=Number((value>>BigInt(i))&1n);
  const carry=compare?left<right:left+right>mask;
  const overflow=!!((compare?(left^right)&(left^value):~(left^right)&(left^value))&sign);
  const flags=(carry?1:0)|(!parity?4:0)|(((left^right^value)&16n)?16:0)
    |(!value?64:0)|((value&sign)?128:0)|(overflow?2048:0);
  result.writeBigUInt64LE((result.readBigUInt64LE(392)&~0x8d5n)|BigInt(flags),392);
  if(compare){if(a===d)write(dst,s);else write(0,d);}
  else {write(src,d);write(dst,value);}
  return result;
}
const pairs=[[0,3],[1,2],[6,7],[8,15],[9,10],[11,12],[13,14],[0,0],[8,8],[5,2],[3,0],[0,1],[2,0],[2,2],[1,1]];
const high=[[0,4],[4,0],[4,4],[4,7],[5,2],[6,3],[3,7]];
let form=0,stable=0,parity=0,direct=0,dispatch=0,rf=0,models=0,allRegisters=0,refusals=0;
for(let compare=0;compare<2;++compare)for(let family=0;family<2;++family)
for(let width=0;width<(family?1:4);++width)for(let pair=0;pair<(family?7:15);++pair)
for(let variant=0;variant<3;++variant,++form){
  const bits=8<<width,[dst,src]=(family?high:pairs)[pair],instructions=variant===1?3:variant===2?2:1;
  const page=await readFile(path.join(directory,`update-${form}.source-page`));
  const records=await readFile(path.join(directory,`update-${form}.cases`));assert.equal(records.length,64*2512);
  if(beforeDirectory){
    assert(page.equals(await readFile(path.join(beforeDirectory,`update-${form}.source-page`))));
    const old=await readFile(path.join(beforeDirectory,`update-${form}.cases`)),normalized=Buffer.from(records);
    for(let row=0;row<128;++row){old.writeBigUInt64LE(0n,row*1256+32);normalized.writeBigUInt64LE(0n,row*1256+32);}
    assert(old.equals(normalized));stable+=64;
  }
  const emitted=await compile(page,instructions);assert(emitted.module.equals(await readFile(path.join(directory,`update-${form}.wasm`))));++parity;
  for(let row=0;row<64;++row){
    const before=records.subarray(row*2512,row*2512+1256),native=records.subarray(row*2512+1256,(row+1)*2512);
    let expected=Buffer.from(before);
    if(variant===1)expected.writeBigUInt64LE(expected.readBigUInt64LE(8),80);
    expected=model(expected,compare,bits,dst,src,!!family);
    if(variant===2)expected=model(expected,compare,bits,dst,src,!!family);
    if(variant===1)expected.writeBigUInt64LE(expected.readBigUInt64LE(80),88);
    expected.writeBigUInt64LE(entry+BigInt(emitted.length),384);expected.writeBigUInt64LE(41n+BigInt(instructions),1128);
    assert(expected.equals(native),`independent algebra/native form=${form} row=${row}`);++models;
    expected=projected(native);reset(before);assert.equal(emitted.cut(base,port,entry,0),1n);assert(cpu().equals(expected));++direct;
    reset(before);data.set(page,code);assert.equal(vm.vm_source_query(port,entry,instructions,codeView,rows),1n);
    table.set(v.getUint32(rows+16,true),emitted.cut);assert.equal(vm.vm_source_publish(emitted.length,instructions,0,rows),0);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);assert.equal(vm.vm_run(port,9n,1),1n);
    assert.equal(vm.vm_source_retired(),BigInt(instructions));assert.equal(vm.vm_completed(),1);assert(cpu().equals(expected));++dispatch;
    reset(before);put(base+392,v.getBigUint64(base+392,true)|0x10000n);
    assert.equal(emitted.cut(base,port,entry,0),1n);assert(cpu().equals(expected));++rf;
  }
}
assert.equal(form,402);
// Including RSP/SPL: these cannot safely run in the native return harness.
for(let compare=0;compare<2;++compare)for(const bits of [8,16,32,64])
for(let dst=0;dst<16;++dst)for(let src=0;src<16;++src){
  const page=Buffer.alloc(4096,0x90),bytes=[];
  if(bits===16)bytes.push(0x66);
  const rex=(bits===64?8:0)|(dst>=8?1:0)|(src>=8?4:0);if(rex||bits===8)bytes.push(0x40|rex);
  bytes.push(0x0f,(compare?0xb0:0xc0)+(bits!==8?1:0),0xc0|((src&7)<<3)|(dst&7));page.set(bytes);
  const emitted=await compile(page);
  for(let arm=0;arm<2;++arm){
    const before=Buffer.alloc(1256);for(let reg=0;reg<16;++reg)before.writeBigUInt64LE(BigInt(reg+1)*0x123456789abcdefn,reg*8);
    const mask=laneMask(bits),d=before.readBigUInt64LE(dst*8)&mask;
    before.writeBigUInt64LE((before.readBigUInt64LE(0)&~mask)|((d+BigInt(arm))&mask),0);
    before.writeBigUInt64LE(entry,384);before.writeBigUInt64LE(0x203n,392);before.writeBigUInt64LE(41n,1128);
    const expected=model(before,compare,bits,dst,src);expected.writeBigUInt64LE(entry+BigInt(bytes.length),384);expected.writeBigUInt64LE(42n,1128);
    reset(before);assert.equal(emitted.cut(base,port,entry,0),1n);assert(cpu().equals(projected(expected)));++allRegisters;
  }
}
// Malformed descriptors/source are not an opcode fallback; invalid LOCK is a
// positively admitted #UD rather than executing a register transaction.
const locked=Buffer.alloc(4096,0x90);locked.set([0xf0,0x0f,0xc1,0xc3]);
const fault=await compile(locked);reset(Buffer.alloc(1256));put(base+384,entry);put(base+392,2);
const unchanged=cpu();assert.equal(fault.cut(base,port,entry,0),51n);assert(cpu().equals(unchanged));++refusals;
vm.vm_close();
console.log(JSON.stringify({format:'register-update-native-c-wasm-v1',status:'pass',forms:form,stable,parity,direct,dispatch,rf,models,allRegisters,refusals,
  oracle:'native GPR/all-defined-flags observations; RSP/RF/LOCK scopes separate explicit models',linuxBoot:'not-tested'},null,2));
