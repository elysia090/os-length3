// Node validation of the diagnostic fixture selector, not browser execution.
import assert from 'node:assert/strict';
const saved=Object.fromEntries(['self','fetch'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
let result,fetches=0,manifest;
try {
  globalThis.self={postMessage:value=>{result=value;}};
  globalThis.fetch=async url=>{
    ++fetches; assert.equal(url.pathname.endsWith('/manifest.json'),true);
    return {ok:true,json:async()=>manifest};
  };
  await import('../../src/v2/vm/check/browser/startup-worker.mjs');
  for (const fixture of ['../temp','https://example.invalid/root','generated-startup/../other','generated-startup-','x'.repeat(81),0]) {
    const before=fetches;
    await self.onmessage({data:{fixture}});
    assert.equal(result.status,'fail'); assert.match(result.error,/diagnostic fixture directory/);
    assert.equal(fetches,before,'invalid fixture must not perform a fetch');
  }
  manifest={format:'bzimage-startup-diagnostic-v1',immutableImage:{address:'0x30000000',bytes:4096},objects:{5:{bytes:8192}},files:{}};
  await self.onmessage({data:{fixture:'generated-startup-image-1004'}});
  assert.equal(result.status,'fail'); assert.match(result.error,/descriptor\/object mismatch/);
  assert.equal(fetches,1);
  manifest={format:'wrong-format'};
  await self.onmessage({data:{}}); assert.match(result.error,/manifest format/); assert.equal(fetches,2);
  manifest={format:'bzimage-startup-diagnostic-v1',files:{}};
  await self.onmessage({data:{fixture:'generated-startup-image-1004'}});
  assert.match(result.error,/undeclared diagnostic fixture/); assert.equal(fetches,3);
  console.log('Startup fixture selector: path escape, length/type, image binding and undeclared input refusals green; not browser boot');
} finally {
  for (const [key,descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor); else delete globalThis[key];
  }
}
