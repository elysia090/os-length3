// Real host scheduling/cancellation observations, not a Linux boot oracle.
import assert from 'node:assert/strict';
import {waitForClock} from '../../src/v2/web/idle-clock.mjs';
let waits=0,refusals=0,cancellations=0;
for(const delta of [1n,1000000n,2000000n]){
  const result=await waitForClock({deadlineNanoseconds:123n+delta,virtualNanoseconds:123n});
  assert(result.elapsedNanoseconds>=delta);++waits;
}
for(const [deadlineNanoseconds,virtualNanoseconds]of [[0n,0n],[1n,1n],[-1n,0n],[1n,-1n],[(1n<<64n),0n],[1,0n]]){
  await assert.rejects(waitForClock({deadlineNanoseconds,virtualNanoseconds}),RangeError);++refusals;
}
const pre=new AbortController();pre.abort(new Error('cancel-before-wait'));
await assert.rejects(waitForClock({deadlineNanoseconds:10n,virtualNanoseconds:0n,signal:pre.signal}),/cancel-before-wait/);++cancellations;
const active=new AbortController();
const pending=waitForClock({deadlineNanoseconds:(1n<<64n)-1n,virtualNanoseconds:0n,signal:active.signal});
active.abort(new Error('cancel-pending-wait'));await assert.rejects(pending,/cancel-pending-wait/);++cancellations;
const zero=new AbortController(),falsy=waitForClock({deadlineNanoseconds:1000000000n,virtualNanoseconds:0n,signal:zero.signal});
zero.abort(0);let rejected=false;
try{await falsy;}catch(reason){assert.equal(reason,0);rejected=true;}assert(rejected);++cancellations;
await assert.rejects(waitForClock({deadlineNanoseconds:1n,virtualNanoseconds:0n,signal:{aborted:false}}),TypeError);++refusals;
console.log(JSON.stringify({format:'idle-clock-host-transport-v1',status:'pass',waits,refusals,cancellations,
  clock:'measured performance.now duration; no synthesized timestamp or guest timer interpretation',linuxBoot:'not-tested'},null,2));
