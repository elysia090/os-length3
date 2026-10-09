import assert from 'node:assert/strict';
import {memoryBudget,memoryGrowth} from '../../src/v2/web/memory-budget.mjs';
assert.equal(memoryGrowth(32,33,512,512),1); // Old fixed16 subtraction grows17.
assert.equal(memoryGrowth(506,512,512),6); // Old unbounded batch grows8 and traps.
const memory=new WebAssembly.Memory({initial:506,maximum:512});memory.grow(memoryGrowth(506,512,512));
assert.equal(memory.buffer.byteLength,512*65536);
assert.equal(memoryGrowth(512,512,512),0);assert.throws(()=>memoryGrowth(512,513,512));
const live=memoryBudget(134217728,89874432,true,true);
assert.equal(live.capacity,54710);assert(live.maximumPages*65536>=live.capacity*(4096+52)+8*1024*1024);
assert.equal(memoryBudget(134217728,0,false,true).capacity,8192);
assert.equal(memoryBudget(134217728,0,false,false).capacity,4096);
assert.throws(()=>memoryBudget(0,0,true,true));assert.throws(()=>memoryBudget(2**53,0,true,true));
console.log(JSON.stringify({format:'physical-memory-reservation-v1',status:'pass',live,
 scope:'payload/descriptor/index/version/private bound; initial and final-batch growth; no eager payload allocation or Linux claim'},null,2));
