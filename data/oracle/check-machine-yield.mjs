import assert from 'node:assert/strict';
import {MachineYield} from '../../src/v2/web/machine-yield.mjs';
let now=0,pauses=0;
const scheduling=new MachineYield({now:()=>now,pause:async()=>{++pauses;now+=100;}});
for(let n=0;n<8;++n){now=n;assert.equal(scheduling.due(),false);}
now=8;assert.equal(scheduling.due(),true);await scheduling.yield();
assert.equal(pauses,1);assert.equal(scheduling.count,1);assert.equal(scheduling.due(),false);
now+=8;assert.equal(scheduling.due(),true);await scheduling.yield();assert.equal(pauses,2);
// A real task must run despite the caller's resolved-Promise chain.
let message=false;setTimeout(()=>{message=true;},0);
const live=new MachineYield({budgetMs:0.01});
for(let n=0;n<100000&&!message;++n){await Promise.resolve();if(live.due())await live.yield();}
assert(message);assert(live.count>0);
live.close();scheduling.close();
await assert.rejects(live.yield(),/live task owner/);
const pending=new MachineYield();const waiting=pending.yield();
await assert.rejects(pending.yield(),/serialized/);pending.close();await waiting;
console.log('Worker task scheduling: bounded safe-cut task opportunities; no guest state/clock/retirement mutation');
