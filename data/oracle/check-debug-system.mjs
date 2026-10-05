// Privileged x86 observations versus generated MOV DR and the C owner.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,directory,traceFile]=process.argv.slice(2);
if (!traceFile) throw new Error('usage: check-debug-system.mjs VM.WASM CUT-DIRECTORY TRACE');
const rows=(await readFile(traceFile,'utf8')).trim().split(/\r?\n/)
  .map(line=>line.trim().split(/\s+/).map(word=>BigInt(`0x${word}`)));
assert.equal(rows.length,592);
const boundaries=[0n,1n,0xffffffffffffffffn,0x400n,0xffff0ff0n,
  0x800000000000n,0xffff800000000000n,0x123456789abcdef0n];
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cuts=await Promise.all([0,1].map(write=>Promise.all(Array.from({length:8},async(_,rank)=>
  (await WebAssembly.instantiate(await readFile(path.join(directory,`debug-${write}-${rank}-0-0.wasm`)),
    {machine:{memory,debug:vm.vm_debug}})).instance.exports.cut))));
const bytes=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const dir=vm.vm_arena_min(),state=dir+4096,segments=state+1408,port=state+2048;
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
put(dir,0x1000);view.setUint32(dir+8,4096,true);view.setUint32(dir+12,3,true);view.setUint32(dir+16,1,true);
let comparisons=0,faultMatches=0,representativeDifferences=0;
for (let index=0;index<rows.length;++index) {
  const row=rows[index];assert.equal(row.length,13);assert.equal(row[0],BigInt(index));
  const gd=index>=576,rank=gd ? (index-576)&7 : Math.floor(index/72);
  const write=!gd || index>=584 ? 1 : 0;
  const target=rank===4 || rank===5 ? rank+2 : rank;
  const n=index%72;
  let value=gd ? 0x12345678n : n<64 ? 1n<<BigInt(n) : boundaries[n-64];
  if (!gd && target===7) value&=~0x20ffn;
  assert.equal(row[1],BigInt(write));assert.equal(row[2],BigInt(rank));assert.equal(row[3],value);
  const vector=gd ? 1 : target>=6 && value>>32n ? 13 : 0;
  assert.equal(row[11],BigInt(vector),`native fault ${index}`);assert.equal(row[4],value);
  if (vector) ++faultMatches;
  const expectedDebug=[0n,0n,0n,0n,0xffff0ff0n,gd ? 0x2400n : 0x400n];
  if (gd) expectedDebug[4]|=0x2000n;
  else if (!vector) expectedDebug[target<4 ? target : target-2]=target<4 ? value
    : target===6 ? (value&0xe00fn)|0xffff0ff0n : (value&0xffff23ffn)|0x400n;
  for (let k=0;k<6;++k) {
    const expected=gd && k===5 ? expectedDebug[k]&~0x2000n : expectedDebug[k];
    const mask=k===4 ? 0xe00fn : k===5 ? 0xffff23ffn : 0xffffffffffffffffn;
    assert.equal(row[5+k]&mask,expected&mask,`native field ${index}/${k}`);
    if (row[5+k]!==expected) ++representativeDifferences;
  }
  bytes.fill(0,state,state+4096);put(port,9);put(state,value);put(state+384,0x400000);
  put(state+392,row[12]);put(state+400,0x80010011);put(state+408,0x1000);
  put(state+416,32);put(state+424,0x500);put(state+488,8);
  put(state+592,0xffff0ff0);put(state+600,gd ? 0x2400 : 0x400);
  // Alias words deliberately differ; the canonical DR6/DR7 owner wins.
  put(state+576,0xa5a5a5a5a5a5a5a5n);put(state+584,0xa5a5a5a5a5a5a5a5n);
  view.setUint32(segments,2,true);view.setUint32(segments+36,0xa09b,true);
  assert.equal(vm.vm_open(state,bytes.length-state,4096,dir,1,1,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(state),0);assert.equal(vm.vm_bind_segments(segments),0);
  const expected=Buffer.from(bytes.subarray(state,state+1256));
  for (let k=0;k<6;++k) expected.writeBigUInt64LE(expectedDebug[k],544+(k<4 ? k : k+2)*8);
  if (!vector) {expected.writeBigUInt64LE(0x400003n,384);expected.writeBigUInt64LE(1n,1128);}
  assert.equal(cuts[write][rank](state,port,0x400000n),vector ? BigInt(vector*8+3) : 1n);
  assert.deepEqual(bytes.subarray(state,state+1256),expected);
  if (vector) assert.equal(view.getUint32(port+24,true),vector);
  ++comparisons;
}
console.log(JSON.stringify({format:'c-wasm-debug-register-system-v1',status:'pass',rows:rows.length,
  comparisons,faultMatches,representativeDifferences,oracle:'QEMU TCG CPL0, not physical hardware',
  debugException:'oracle observes entered #DB; C owner reports pending #DB and keeps GD until entry',
  linuxBoot:'not-tested'},null,2));
