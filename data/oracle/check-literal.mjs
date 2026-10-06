// Native observations -> actual cold C -> direct and C-MMU/table dispatch.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory,mode]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
if(mode!==undefined && mode!=='--binding-only')throw new Error('unknown literal check mode');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const dir=vm.vm_arena_min(),base=dir+4096,port=base+2048,segments=base+1408,rows=dir+512;
const code=base+24576,entry=0x400000n,slot=vm.__indirect_function_table.grow(1);
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
let parity=0,direct=0,dispatch=0,rebound=0;
function reset(page,before,meta){
  vm.vm_close();data.fill(0,dir);
  for(let i=0;i<5;++i){put(dir+i*32,i<4?(i+1)*4096:0x8000);v.setUint32(dir+i*32+8,i<4?(i+2)*4096:24576,true);
    v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);put(base+20480,0x8067);
  data.set(before,base);data.set(page,code);
  put(base+384,entry);put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);
  put(base+488,19);put(base+496,27);put(base+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);v.setUint32(segments+52,0xc0f3,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,5,5,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,meta.binding,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
for(let id=0;id<1024;++id){
  const prefix=path.join(directory,`literal-${id}`),meta=JSON.parse(await readFile(`${prefix}.json`,'utf8'));
  const page=await readFile(`${prefix}.source-page`),records=await readFile(`${prefix}.cases`);
  assert.equal(records.length,2512);cold.set(page,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  assert.equal(cv.getUint32(report+76,true),meta.binding);
  if(mode==='--binding-only')continue;
  const bytes=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  assert(bytes.equals(await readFile(`${prefix}.wasm`)));++parity;
  const cut=(await WebAssembly.instantiate(bytes,{machine:{memory}})).instance.exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  for(const table of [false,true]){
    reset(page,records.subarray(0,1256),meta);const expected=Buffer.from(data.subarray(base,base+1256));
    records.copy(expected,0,1256,1256+128);expected.writeBigUInt64LE(records.readBigUInt64LE(1256+392)&~0x10000n,392);
    expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);expected.writeBigUInt64LE(43n,1128);
    assert.equal(table?vm.vm_run(port,9n,1):cut(base,port,entry,meta.binding),1n);
    assert(data.subarray(base,base+1256).equals(expected),`native full CPU id=${id} table=${table}`);
    if(table){assert.equal(vm.vm_source_retired(),1n);++dispatch;}else ++direct;
  }
  if(meta.kind<2){
    reset(page,records.subarray(0,1256),meta);
    const binding=(meta.binding^0x1234abcd)>>>0,bits=BigInt(meta.bits),shift=meta.legacy?8n:0n,mask=(1n<<bits)-1n;
    const value=meta.kind===1?BigInt.asUintN(64,BigInt(binding|0)):BigInt(binding);
    const expected=Buffer.from(data.subarray(base,base+1256)),at=meta.reg*8;
    expected.writeBigUInt64LE((meta.bits>=32?0n:expected.readBigUInt64LE(at)&~(mask<<shift))|((value&mask)<<shift),at);
    expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);expected.writeBigUInt64LE(43n,1128);
    assert.equal(cut(base,port,entry,binding),1n);assert(data.subarray(base,base+1256).equals(expected));++rebound;
  }
}
vm.__indirect_function_table.set(slot,null);vm.vm_close();
console.log(JSON.stringify({format:'literal-binding-native-c-wasm-v1',status:'pass',mode:mode??'full-native',parity,direct,dispatch,rebound,
  oracle:'actual native GPR/full-flags; rebound parameter family is a separate integer model; RSP writes excluded',linuxBoot:'not-tested'},null,2));
