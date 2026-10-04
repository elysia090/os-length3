import assert from 'node:assert/strict';
import {CutTrace} from '../../src/v2/vm/check/browser/cut-trace.mjs';
const data=new Uint8Array(4096),view=new DataView(data.buffer),state=2048;
const ring=new CutTrace(),reference=[];let comparisons=0;
assert.deepEqual(ring.read(),[]);assert.deepEqual(ring.read(0),[]);
const toString=BigInt.prototype.toString;
let hotFormatting=0;
for(let rank=0;rank<100000;++rank) {
  const entry=rank&1?0xffffffff81000000n+BigInt(rank):BigInt(rank),next=entry+8n,result=BigInt(rank%7);
  const instructions=rank%1025;
  for(const offset of [0,8,16,56,392])view.setBigUint64(state+offset,BigInt(rank)*(1n<<40n)+BigInt(offset),true);
  const expected={entry:`0x${entry.toString(16)}`,instructions,next:`0x${next.toString(16)}`,result:String(result),
    rax:`0x${view.getBigUint64(state,true).toString(16)}`,rcx:`0x${view.getBigUint64(state+8,true).toString(16)}`,
    rdx:`0x${view.getBigUint64(state+16,true).toString(16)}`,rdi:`0x${view.getBigUint64(state+56,true).toString(16)}`,
    flags:`0x${view.getBigUint64(state+392,true).toString(16)}`};
  const before=data.slice();
  BigInt.prototype.toString=function(...args){++hotFormatting;return toString.apply(this,args);};
  try {ring.append(entry,instructions,next,result,view,state);}finally{BigInt.prototype.toString=toString;}
  assert.deepEqual(data,before,'observer never writes guest bytes');
  reference.push(expected);if(reference.length>16)reference.shift();
  if(rank<32||!(rank%997)||rank===99999) {
    assert.deepEqual(ring.read(),reference);assert.deepEqual(ring.read(4),reference.slice(-4));
    assert.deepEqual(ring.read(1),reference.slice(-1));assert.deepEqual(ring.read(0),[]);++comparisons;
  }
}
assert.equal(hotFormatting,0,'no per-cut hex conversion');
assert.equal(ring.words.byteLength+ring.instructions.byteLength,1056,'fixed trace payload');
assert.throws(()=>ring.read(17),RangeError);assert.throws(()=>ring.read(-1),RangeError);
assert.throws(()=>ring.read(1.5),RangeError);
console.log(JSON.stringify({status:'pass',appends:100000,comparisons,hotHexConversions:hotFormatting,
  tracePayloadBytes:1056,guestMutation:false,linuxBoot:'not-tested'}));
