// Independent native counter-branch observations -> cold C -> actual C VM.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const dir=vm.vm_arena_min(),base=dir+4096,port=base+2048,segments=base+1408,rows=dir+512,codeView=port+64,code=base+24576;
const entry=0x400000n,table=vm.__indirect_function_table;
const first=vm.vm_slot_min();table.grow(Math.max(0,first+vm.vm_source_capacity()-table.length));
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),cpu=()=>Buffer.from(data.subarray(base,base+1256));
function state(before,address=entry){
  vm.vm_close();data.fill(0,dir);data.set(before,base);
  for(let i=0;i<5;++i){put(dir+i*32,i<4?(i+1)*4096:0x8000);v.setUint32(dir+i*32+8,(i+2)*4096,true);
    v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);put(base+20480,0x8067);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);put(base+488,8);put(base+384,address);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,5,5,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
function project(expected){
  expected.writeBigUInt64LE(0x80010011n,400);expected.writeBigUInt64LE(0x1000n,408);expected.writeBigUInt64LE(32n,416);
  expected.writeBigUInt64LE(0xd00n,424);expected.writeBigUInt64LE(8n,488);return expected;
}
async function compile(bytes,address=entry){
  cold.set(bytes,input);assert.equal(cc.compiler_open_pages(input,1,address&~4095n,9n),0);
  assert.equal(cc.compiler_emit(address,8,output,65536,report),0);
  const n=Number(cv.getBigUint64(report+40,true)),module=Buffer.from(cold.subarray(output,output+n));
  const cut=(await WebAssembly.instantiate(module,{machine:{memory}})).instance.exports.cut;
  return {cut,module,length:Number(cv.getBigUint64(report+32,true)),binding:cv.getUint32(report+76,true)};
}
let parity=0,direct=0,dispatch=0,rf=0,shadow=0,targetFaults=0,targetNotTaken=0;
for(let form=0;form<64;++form){
  const page=await readFile(path.join(directory,`count-${form}.source-page`));
  const records=await readFile(path.join(directory,`count-${form}.cases`));assert.equal(records.length,128*2512);
  const {cut,module,length,binding}=await compile(page);
  assert(module.equals(await readFile(path.join(directory,`count-${form}.wasm`))));++parity;
  for(let row=0;row<128;++row){
    const before=records.subarray(row*2512,row*2512+1256),expected=project(Buffer.from(records.subarray(row*2512+1256,(row+1)*2512)));
    state(before);assert.equal(cut(base,port,entry,binding),1n);assert(cpu().equals(expected));++direct;
    state(before);data.set(page,code);assert.equal(vm.vm_source_query(port,entry,8,codeView,rows),1n);
    table.set(v.getUint32(rows+16,true),cut);assert.equal(vm.vm_source_publish(length,1,binding,rows),0);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);assert.equal(vm.vm_run(port,9n,1),1n);
    assert.equal(vm.vm_source_retired(),1n);assert.equal(vm.vm_completed(),1);assert(cpu().equals(expected));++dispatch;
    state(before);put(base+392,v.getBigUint64(base+392,true)|0x10000n);
    assert.equal(cut(base,port,entry,binding),1n);assert(cpu().equals(expected));++rf;
    if(row===0){
      for(const kind of [1,2]){
        state(before);data.set(page,code);v.setUint32(segments+4,kind,true);
        assert.equal(vm.vm_source_query(port,entry,8,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);
        assert.equal(vm.vm_source_publish(length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
        assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(v.getUint32(segments+4,true),0);assert(cpu().equals(expected));++shadow;
      }
    }
  }
}
// Noncanonical taken target is a pending precise #GP, not a host/Wasm trap.
// This is an Intel model, not one of the native observations above.
const high=0x7fffffffffd0n;
for(const width32 of [false,true])for(let kind=0;kind<4;++kind)
for(const count of [0n,1n,2n,0x100000000n,0x100000001n])for(const zf of [0,1]){
  const page=Buffer.alloc(4096,0x90),bytes=[...(width32?[0x67]:[]),0xe0+kind,0x7f];page.set(bytes,Number(high&4095n));
  const {cut,binding}=await compile(page,high),before=Buffer.alloc(1256);before.writeBigUInt64LE(count,8);
  before.writeBigUInt64LE(BigInt(0x10203|(zf<<6)),392);before.writeBigUInt64LE(41n,1128);
  state(before,high);const expected=cpu();
  let next=kind<3?count-1n:count;if(width32)next=BigInt.asUintN(32,next);
  const taken=kind===3?next===0n:next!==0n&&(kind===2||(kind===1)===(zf===1));
  assert.equal(cut(base,port,high,binding),taken?107n:1n);
  if(taken){
    assert(cpu().equals(expected));assert.equal(v.getUint32(port+24,true),13);assert.equal(v.getUint32(port+28,true),0);
    assert.equal(v.getBigUint64(port+16,true),high+BigInt(bytes.length)+127n);++targetFaults;
  }else{
    if(kind<3)expected.writeBigUInt64LE(BigInt.asUintN(64,next),8);
    expected.writeBigUInt64LE(high+BigInt(bytes.length),384);expected.writeBigUInt64LE(BigInt(0x203|(zf<<6)),392);
    expected.writeBigUInt64LE(42n,1128);assert(cpu().equals(expected));++targetNotTaken;
  }
}
vm.vm_close();
console.log(JSON.stringify({format:'count-branch-native-c-wasm-v1',status:'pass',parity,direct,dispatch,rf,shadow,targetFaults,targetNotTaken,
  oracle:'native counter/width/ZF/target/GPR/flag records; RF/shadow/target #GP model scopes separate',linuxBoot:'not-tested'},null,2));
