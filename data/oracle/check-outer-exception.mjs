// Independent hardware-assisted user fetch faults through the actual C VM.
// No guest instruction interpretation, synthetic fault-success fallback or Linux boot claim.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,rowsFile,...extra]=process.argv.slice(2);
if(!rowsFile||extra.length)throw new Error('usage: check-outer-exception.mjs VM.WASM HARDWARE-USER-ROWS.log');
const rows=(await readFile(rowsFile,'utf8')).trim().split(/\r?\n/)
  .map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
assert.equal(rows.length,320);for(const [i,row]of rows.entries()){assert.equal(row.length,27);assert.equal(row[0],BigInt(i));}
const selected=rows.filter(row=>row[7]===14n);assert.equal(selected.length,208);
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),directory=vm.vm_arena_min();
const base=directory+4096,segments=base+1408,port=base+2048,codeView=base+2112;
const payload=rank=>base+(rank+2)*4096;
const put=(at,value)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(value)),true),get=at=>v.getBigUint64(at,true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256)),hidden=()=>Buffer.from(data.subarray(segments,segments+136));
let comparisons=0,waits=0;
function reset(row) {
  vm.vm_close();data.fill(0,base);put(port,9);
  const physical=[0x1000n,0x2000n,0x3000n,0x4000n,0x5000n,0x6000n,row[22]&~4095n];
  physical.forEach((p,rank)=>{const at=directory+rank*32;put(at,p);v.setUint32(at+8,(rank+2)*4096,true);
    v.setUint32(at+12,3,true);v.setUint32(at+16,1,true);data.fill(0,at+20,at+32);});
  put(payload(0),0x2027);put(payload(1),0x3027);put(payload(2),0xe7);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  put(payload(3)+24,0x00af00000000ffffn|row[20]<<40n);put(payload(3)+32,0x00cf00000000ffffn|row[21]<<40n);
  put(payload(3)+40,0x00008b0050000067n);
  put(payload(4)+4,row[22]+40n);
  put(payload(5)+14*16,(row[26]&65535n)|8n<<16n|0x8en<<40n|(row[26]>>16n&65535n)<<48n);
  put(payload(5)+14*16+8,row[26]>>32n);
  for(let rank=0;rank<16;++rank)put(base+rank*8,BigInt(rank+1)*0xabcdefff123n);
  put(base+32,row[12]);put(base+384,row[9]);put(base+392,row[11]&~0x10000n);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);
  put(base+448,0x4000);put(base+456,55);put(base+464,0x6000);put(base+472,4095);
  put(base+488,row[10]);put(base+496,row[13]);put(base+536,40);put(base+1128,123);
  v.setUint32(segments,2,true);
  for(const rank of [0,3,4,5])v.setUint32(segments+8+rank*16+12,0x1c013,true);
  put(segments+8+4*16,row[18]);put(segments+8+5*16,row[19]);
  v.setUint32(segments+32,0xffffffff,true);v.setUint32(segments+36,0xa000|Number(row[20]),true);
  v.setUint32(segments+48,0xffffffff,true);v.setUint32(segments+52,0xc000|Number(row[21]),true);
  put(segments+8+7*16,0x5000);v.setUint32(segments+8+7*16+8,103,true);v.setUint32(segments+8+7*16+12,0x8b,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,physical.length,physical.length,directory+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_code(port,row[9],codeView),115n,'C MMU owns the failed fetch, not a JS fault opcode');
  assert.equal(BigInt(v.getUint32(port+24,true)),row[7]);assert.equal(BigInt(v.getUint32(port+28,true)),row[8]);
  assert.equal(get(port+16),row[9]);
}
function expected(row) {
  const state=cpu(),cache=hidden();
  state.writeBigUInt64LE(row[26],384);state.writeBigUInt64LE(row[22]-8n,32);state.writeBigUInt64LE(row[25],392);
  state.writeBigUInt64LE(row[9],432);state.writeBigUInt64LE(row[24],488);state.writeBigUInt64LE(row[23],496);
  cache.writeBigUInt64LE(0n,24);cache.writeUInt32LE(0xffffffff,32);cache.writeUInt32LE(0xa09b,36);
  cache.fill(0,40,56);cache.writeUInt32LE(0x10000,52);cache.writeUInt32LE(0,4);
  return {state,cache};
}
function observe(row,want) {
  assert(cpu().equals(want.state),'whole CPU, original GPR/retirement and hardware entry state');
  assert(hidden().equals(want.cache),'whole cache with explicit ignored/null-SS representative');
  const stack=payload(6)+Number((row[22]-8n)&4095n);
  for(const [rank,field]of [8,9,10,11,12,13].entries())assert.equal(get(stack+rank*8),row[field],`hardware frame ${row[0]}:${field}`);
  assert.equal(get(segments+8+4*16),row[18]);assert.equal(get(segments+8+5*16),row[19]);
}
for(const row of selected) {
  reset(row);const want=expected(row);assert.equal(vm.vm_fault(port),0n,`CPL${row[1]} fetch #PF through TSS`);
  observe(row,want);++comparisons;
}
for(const rank of [4,6]) {
  const row=selected[2];reset(row);const want=expected(row),prior=cpu(),cache=hidden();
  v.setUint32(directory+rank*32+16,3,true);assert.equal(vm.vm_fault(port),2n);
  // CR2 publication belongs to fault entry, before a TSS/frame residency wait.
  prior.writeBigUInt64LE(row[9],432);assert(cpu().equals(prior));assert(hidden().equals(cache));
  v.setUint32(directory+rank*32+16,1,true);assert.equal(vm.vm_fault(port),0n);observe(row,want);++waits;
}
vm.vm_close();console.log(JSON.stringify({format:'c-outer-exception-v1',status:'pass',comparisons,waits,
  oracle:'independent hardware-assisted CPL1/2/3 fetch #PF frames plus whole C-state models; no bare-metal/cache-bit claim',linuxBoot:'not-tested'},null,2));
