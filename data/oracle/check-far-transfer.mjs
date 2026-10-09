// Independent native processor frames/RAM -> actual C compiler/MMU/event/table.
// Recovery INT/IST belongs only to the native observation harness.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,nativeFile]=process.argv.slice(2);if(!nativeFile)throw new Error('VM.WASM COMPILER.WASM NATIVE-FAR.LOG');
const native=(await readFile(nativeFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
assert.equal(native.length,384);
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,view=port+80;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x7000n,put=(at,x)=>v.setBigUint64(at,BigInt(x),true),payload=i=>cpu+(i+2)*4096,table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let comparisons=0,faults=0,success=0;
const cached=new Map();
for(const r of native){assert.equal(r.length,34);const [rank,width,call,gate,cpl,mode]=r.map(Number);
  let source=Buffer.from([...(width===2?[0x66]:width===8?[0x48]:[]),0xff,call?0x1d:0x2d,0,0,0,0]);
  const operand=mode===6?0x300000n:0x7200n;source.writeInt32LE(Number(operand-entry-BigInt(source.length)),source.length-4);
  assert.equal(r[8],entry+BigInt(source.length));const key=source.toString('hex');let made=cached.get(key);
  if(!made){c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
    const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
      {machine:{memory,read_pair:vm.vm_read_pair,far_transfer:vm.vm_transfer,checkpoint:vm.vm_checkpoint}})).instance.exports.cut;
    made={cut,binding};cached.set(key,made);cc.compiler_close();}
  vm.vm_close();a.fill(0,dir);
  // Native low identity map is mirrored with declared private transport. GDT/
  // TSS/cache addresses are not claimed to be native register measurements.
  for(let page=1;page<=11;++page){put(dir+(page-1)*32,page===11?0x200000:page*4096);v.setUint32(dir+(page-1)*32+8,(page+1)*4096,true);v.setUint32(dir+(page-1)*32+12,3,true);v.setUint32(dir+(page-1)*32+16,1,true);}
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2),0xe7);put(payload(2)+16,0x2000e7);put(payload(10),0xa5a5a5a5a5a5a5a5n);
  a.set(source,payload(6));a.set(Buffer.alloc(256,0x90),payload(6)+0x100);put(payload(6)+0x200,r[6]);v.setUint16(payload(6)+0x200+width,Number(r[7]),true);
  put(payload(3)+56,r[13]);put(payload(3)+64,r[14]);put(payload(3)+72,r[15]);put(payload(5)+4,r[16]);
  a.fill(0xa5,payload(8)+0xce8,payload(8)+0xd08);a.fill(0xa5,payload(8)+0xee8,payload(8)+0xf08);
  put(cpu+384,entry);put(cpu+392,r[12]);put(cpu+400,0x80010011);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);
  put(cpu+32,r[9]);put(cpu+488,r[10]);put(cpu+496,r[11]);put(cpu+448,0x4000);put(cpu+456,79);put(cpu+536,40);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b|(cpl<<5),true);v.setUint32(segments+52,0xc093|(cpl<<5),true);
  put(segments+8+7*16,0x6000);v.setUint32(segments+8+7*16+8,103,true);v.setUint32(segments+8+7*16+12,0x8b,true);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,11,11,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_source_query(port,entry,1,view,rows),1n);table.set(v.getUint32(rows+16,true),made.cut);assert.equal(vm.vm_source_publish(source.length,1,made.binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const result=vm.vm_run(port,9n,1),fault=Number(r[17]);
  assert.equal(result,fault?BigInt(fault)*8n+3n:5n,`result native row${rank}/${width}/${call}/${gate}/${cpl}/${mode}`);
  if(fault){assert.equal(v.getUint32(port+24,true),fault);assert.equal(v.getUint32(port+28,true),Number(r[18]),`fault error row${rank}`);++faults;}else ++success;
  assert.equal(v.getBigUint64(cpu+384,true),r[19],`RIP row${rank}`);assert.equal(v.getBigUint64(cpu+32,true),r[20],`RSP row${rank}`);
  assert.equal(v.getBigUint64(cpu+488,true),r[21],`CS row${rank}`);assert.equal(v.getBigUint64(cpu+496,true),r[22],`SS row${rank}`);
  assert.equal(v.getBigUint64(cpu+392,true),r[23]&~(fault?0x10000n:0n),`flags row${rank}`);assert.equal(vm.vm_source_retired(),fault?0n:1n);
  assert.equal(v.getBigUint64(payload(3)+56,true),r[24],`descriptor Accessed row${rank}`);
  assert.equal(v.getBigUint64(payload(10),true),r[33],`partial frame row${rank}`);
  for(let word=0;word<4;++word){assert.equal(v.getBigUint64(payload(8)+0xce8+word*8,true),r[25+word],`origin RAM row${rank}/${word}`);
    assert.equal(v.getBigUint64(payload(8)+0xee8+word*8,true),r[29+word],`inner RAM row${rank}/${word}`);}
  ++comparisons;
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,modules:cached.size,faults,success,scope:'independent WHPX target/control/flags/descriptor/frame-RAM comparisons; declared cache/transport mirror; C compiler/MMU/table',linuxBoot:'not-tested'}));
