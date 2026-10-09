// Unit-check the diagnostic Worker lifetime, not a real browser boot.
import assert from 'node:assert/strict';
const result = {textContent:''};
const saved = Object.fromEntries(['document','location','Worker'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
let worker, expectedMessage={extended:true}, creations=0;
try {
  globalThis.document = {getElementById:name => name==='result'?result:null};
  globalThis.location = {href:'http://localhost/startup.html?budget=extended'};
  globalThis.Worker = class {
    constructor(url,options) { assert.equal(url,'./startup-worker.mjs'); assert.equal(options.type,'module'); this.stops = 0; worker = this; ++creations; }
    terminate() { ++this.stops; }
    postMessage(message) { assert.deepEqual(message,expectedMessage); }
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
  globalThis.location={href:'http://localhost/startup.html?budget=extended&fixture=generated-startup-image-1004'};
  expectedMessage={extended:true,fixture:'generated-startup-image-1004'};
  await import('../../src/v2/vm/check/browser/startup.mjs?independent-fixture-test');
  assert.equal(worker.stops,0,'fresh explicitly selected fixture does not reuse/stop a prior Worker');
  globalThis.location={href:'http://localhost/startup.html?budget=extended&warm-cuts=64&idle=1'};
  expectedMessage={extended:true,warmCuts:64,idle:true};
  await import('../../src/v2/vm/check/browser/startup.mjs?explicit-warm-idle');
  assert.equal(worker.stops,0);
  globalThis.location={href:'http://localhost/startup.html?warm-cuts=1&idle=0'};
  expectedMessage={extended:false,warmCuts:1,idle:false};
  await import('../../src/v2/vm/check/browser/startup.mjs?explicit-cold-no-idle');
  assert.equal(worker.stops,0);
  for(const query of ['warm-cuts=0','warm-cuts=65','warm-cuts=01','warm-cuts=1.5','idle=unexpected']){
    globalThis.location={href:`http://localhost/startup.html?${query}`};
    const before=creations;
    await import(`../../src/v2/vm/check/browser/startup.mjs?reject-${query}`);
    assert.equal(creations,before,'invalid selection cannot start/leak a Worker');
    assert.deepEqual(JSON.parse(result.textContent),
      {status:'fail',linuxBoot:'not-achieved',error:'diagnostic warm/idle selection'});
    assert.equal(document.title,'bzImage startup: fail');
  }
} finally {
  for (const [key,descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }
}
const workerGlobals=Object.fromEntries(['self','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
const replies=[];
let fetches=0;
try {
  globalThis.self={postMessage:message=>replies.push(message)};
  globalThis.fetch=async()=>{++fetches;throw new Error('test manifest fetch boundary');};
  await import('../../src/v2/vm/check/browser/startup-worker.mjs?selection-check');
  for(const data of [{warmCuts:0},{warmCuts:65},{warmCuts:1.5},{warmCuts:'64'},
      {warmCuts:null},{warmCuts:NaN},{idle:1},{idle:'true'},{idle:null}]){
    const before=fetches;
    await self.onmessage({data});
    assert.equal(fetches,before,'Worker refuses invalid selection before any fetch');
    assert.equal(replies.at(-1).status,'fail');
    assert.equal(replies.at(-1).linuxBoot,'not-achieved');
    assert.equal(replies.at(-1).error,'diagnostic warm/idle selection');
  }
  for(const data of [{},{warmCuts:1,idle:false},{warmCuts:64,idle:true}]){
    const before=fetches;
    await self.onmessage({data});
    assert.equal(fetches,before+1,'valid selection reaches only the stub manifest boundary');
    assert.equal(replies.at(-1).error,'test manifest fetch boundary');
  }
} finally {
  for(const [key,descriptor] of Object.entries(workerGlobals)) {
    if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];
  }
}
console.log('Diagnostic progress/explicit warm-idle selection and Worker lifetime: green (not browser boot)');
