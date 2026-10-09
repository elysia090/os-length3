// C compiler/MMU/table checks: these are models, not hardware fault receipts.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16}),
  vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,
  cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports,
  a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),
  dir=vm.vm_arena_min(),cpu=dir+4096,segments=cpu+1408,port=cpu+2048,rows=dir+512,codeView=port+64,
  ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n,payload=i=>cpu+(i+2)*4096,
  put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let faults=0,suppressed=0;
const masks=[0n,4n,8n,12n],formats=[[0xd9,2,4],[0xd9,3,4],[0xdd,2,8],[0xdd,3,8],[0xdb,7,10]];
for(const prefix of [[],[0x66],[0x67],[0x48],[0x64],[0x65],[0xf2],[0xf3]])for(const [opcode,group,width]of formats){
  const source=Buffer.from([...prefix,opcode,(group<<3)|7]),fop=((opcode&7)<<8)|(group<<3)|7;
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);const binding=cv.getUint32(cr+76,true),
    cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
      {machine:{memory,floating_wait:vm.vm_floating_wait,write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end}})).instance.exports.cut;
  for(const dispatch of [false,true])for(const mask of masks)for(const pending of [false,true])for(let numeric=0;numeric<5;++numeric)
  for(const addressMode of [0,1,2]){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);
    put(payload(3)+8,0x9065);put(payload(3)+16,0xa065);a.set(source,payload(4));a.fill(0x5a,payload(5),payload(6)+4096);
    const address=addressMode===0?0x401010n:addressMode===1?0x401fffn:0x800000000000n;
    for(let reg=0;reg<16;++reg)put(cpu+reg*8,0xabcdef0123450000n+BigInt(reg));
    put(cpu+56,address);put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010031n|mask);
    put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);put(cpu+488,8);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    const bias=width===4?127:1023,cw=pending?0x37e:numeric===1||numeric===4?0x37e:numeric===2?0x377:numeric===3?0x36f:0x37f,
      sig=numeric===1?0x8000000000000001n:0x8000000000000000n,se=numeric===1?0x7fff:numeric===2?16384+bias:numeric===3?16383-bias:0x3fff,
      raised=numeric===1&&width!==10||numeric===4?1:numeric===2&&width!==10?8:numeric===3&&width!==10?16:0;
    v.setUint16(cpu+1232,cw,true);v.setUint16(cpu+1234,pending?0x8081:0,true);v.setUint16(cpu+1236,numeric===4?0xffff:0xfffc,true);
    put(cpu+1152,sig);v.setUint16(cpu+1216,se,true);put(cpu+1240,0x12340000);put(cpu+1248,0x56780000);v.setUint16(cpu+1238,0x123,true);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+1024,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),image=Buffer.from(a.subarray(payload(5),payload(6)+4096)),
      expected=Buffer.from(before),fault=mask?7:pending?16:raised?0:addressMode===2&&!prefix.includes(0x67)?13:14,
      result=dispatch?vm.vm_run(port,9n,1):cut(cpu,port,entry,binding);
    if(fault){assert.equal(result,BigInt(fault)*8n+3n);assert.equal(v.getUint32(port+24,true),fault);++faults;}
    else{assert.equal(result,1n);expected.writeBigUInt64LE(entry+BigInt(source.length),384);expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(43n,1128);
      expected.writeUInt16LE(0x8080|raised|(numeric===4?64:0),1234);expected.writeUInt16LE(fop,1238);expected.writeBigUInt64LE(entry,1240);
      expected.writeBigUInt64LE(prefix.includes(0x67)?address&0xffffffffn:address,1248);++suppressed;}
    assert(a.subarray(cpu,cpu+1256).equals(expected),`state width=${width} mask=${mask} pending=${pending} numeric=${numeric} address=${addressMode} prefix=${prefix}`);
    assert(a.subarray(payload(5),payload(6)+4096).equals(image),'no destination load/write/pop on a suppressed or faulting store');
    if(dispatch)assert.equal(vm.vm_source_retired(),fault?0n:1n);
  }
}
vm.vm_close();console.log(JSON.stringify({status:'pass',faults,suppressed,
  scope:'5 formats/8 prefixes; direct + C table, #NM/#MF priority, protected/split/noncanonical destination; invalid/overflow/underflow suppress memory/pop',linuxBoot:'not-tested'}));
