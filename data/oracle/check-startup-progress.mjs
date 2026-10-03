// Unit-check the diagnostic Worker lifetime, not a real browser boot.
import assert from 'node:assert/strict';
const result = {textContent:''};
const saved = Object.fromEntries(['document','location','Worker'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
let worker;
try {
  globalThis.document = {getElementById:name => {assert.equal(name,'result'); return result;}};
  globalThis.location = {href:'http://localhost/startup.html?budget=extended'};
  globalThis.Worker = class {
    constructor(url,options) { assert.equal(url,'./startup-worker.mjs'); assert.equal(options.type,'module'); this.stops = 0; worker = this; }
    terminate() { ++this.stops; }
    postMessage(message) { assert.deepEqual(message,{extended:true}); }
  };
  await import('../../src/v2/vm/check/browser/startup.mjs');
  for (const retired of [10000000,20000000]) {
    worker.onmessage({data:{status:'running',linuxBoot:'not-achieved',retired}});
    assert.equal(worker.stops,0); assert.equal(JSON.parse(result.textContent).retired,retired);
    assert.equal(document.title,'bzImage startup: running');
  }
  worker.onmessage({data:{status:'pass',linuxBoot:'not-achieved',nextGate:{kind:'compile',status:-102}}});
  assert.equal(worker.stops,1); assert.equal(document.title,'bzImage startup: pass');
  assert.equal(JSON.parse(result.textContent).linuxBoot,'not-achieved');
} finally {
  for (const [key,descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }
}
console.log('Diagnostic progress retains one Worker until a final result: green (not browser boot)');
