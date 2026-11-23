import test from 'node:test';
import assert from 'node:assert/strict';
import {verifySandbox} from './sandbox-same-process.mjs';
// In private scratch, use sealed capture.mjs and the verified exact source stock-chrome.ts.
const rows=p=>[
  ['Layer 1 Sandbox','Namespace'],['PID namespaces','Yes'],['Network namespaces','Yes'],
  ['Seccomp-BPF sandbox',p],
];
function simulated(data,product='Chrome/156.0.1.3') {
  const events=[];
  return {events,version:{product},subscribe(){return ()=>{};},async command(method,params,session){
    events.push({method,params,session});
    if(method==='Target.createTarget')return {targetId:'tab'};
    if(method==='Target.attachToTarget')return {sessionId:'tab-session'};
    if(method==='Runtime.evaluate')return {result:{value:data}};
    return {};
  }};
}
test('same-process sandbox gate uses existing exact source policy before origin navigation',async()=>{
  const okay=simulated(rows('Yes'));
  assert.equal((await verifySandbox(okay)).seccomp,'Yes');
  assert.deepEqual(okay.events.filter(x=>x.method==='Page.navigate').map(x=>x.params.url),['chrome://sandbox/']);
  assert.equal(okay.events.at(-1).method,'Target.closeTarget');
  const weak=simulated(rows('No'));
  await assert.rejects(verifySandbox(weak),/Stock Chrome sandbox is unavailable/);
  assert.equal(weak.events.at(-1).method,'Target.closeTarget');
  const substitute=simulated(rows('Yes'),'Chromium/156.0.1.3');
  await assert.rejects(verifySandbox(substitute),/Stock Chrome product did not identify itself/);
  assert.equal(substitute.events.length,0);
});
