import {checkEngineConstruction} from './engine-construction-check.mjs';
self.onmessage=async()=>{
  try {
    const manifest=await(await fetch('./generated-startup/manifest.json')).json();
    if(manifest.format!=='bzimage-startup-diagnostic-v1')throw new Error('diagnostic manifest');
    const row=manifest.files['wasm-compiler.wasm'];
    if(!row)throw new Error('declared cold compiler');
    const response=await fetch('./generated-startup/wasm-compiler.wasm');
    if(!response.ok)throw new Error(`cold compiler HTTP ${response.status}`);
    const bytes=new Uint8Array(await response.arrayBuffer());
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    const hex=Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
    if(bytes.length!==row.bytes||hex!==row.sha256)throw new Error('cold compiler integrity');
    self.postMessage({...await checkEngineConstruction(bytes),secureContext:self.isSecureContext,
      isolated:self.crossOriginIsolated,compilerSha256:hex,
      fixtureIntegrity:'local diagnostic SHA-256, not signed release admission'});
  } catch(error) {self.postMessage({status:'fail',linuxBoot:'not-tested',error:error.message,stack:error.stack});}
};
