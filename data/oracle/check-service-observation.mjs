import assert from 'node:assert/strict';
import {ServiceObservation} from '../../src/v2/web/service-observation.mjs';
function fixture(){const events=[];let timer,cancelled=0;
  const observer=new ServiceObservation({notify:e=>events.push(e),deadlineMs:1000,
    schedule:f=>(timer=f,7),cancel:id=>{assert.equal(id,7);++cancelled;}});
  return {observer,events,expire:()=>timer(),cancelled:()=>cancelled};}
{
  const f=fixture();f.observer.feed('service console-ready\n');assert.equal(f.events.length,0);
  f.observer.feed('console-');assert.equal(f.events.length,0);
  f.observer.feed('ready\r\n');assert.equal(f.events.length,1);
  f.observer.feed('\nconsole-ready\n');assert.equal(f.events[0].state,'pending');
  f.expire();assert.equal(f.events[1].reason,'readiness-deadline');
  f.observer.feed('service boot-offline-complete\n');assert.equal(f.events.length,2);
  f.observer.feed('boot-offline-complete\r\n');assert.equal(f.events[2].state,'ready');
  f.observer.feed('boot-offline-complete\n');assert.equal(f.events.length,3);
}
{
  const f=fixture();f.observer.feed('console-ready\nService initialization failed; inspect its live state from the console.\n');
  assert.equal(f.events.at(-1).reason,'bootstrap-exit');assert.equal(f.cancelled(),1);
}
{
  const f=fixture();f.observer.feed('console-ready\n');f.observer.close();f.expire();assert.equal(f.events.length,1);
}
{
  const f=fixture();f.observer.fault();assert.equal(f.events[0].reason,'machine-fault');
}
for(const deadlineMs of [0,999,900001,NaN])assert.throws(()=>new ServiceObservation({notify:()=>{},deadlineMs}),TypeError);
console.log('service observation: pass (deadline, exact complete/failure lines, late readiness, fault, close)');
