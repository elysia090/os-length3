import {checkImageAdmission} from './image-admission-check.mjs';
self.onmessage=async({data})=>{
  try{
    if(data?.generation!==1)throw new Error('diagnostic Worker generation');
    const root=new URL('./generated/image-admission/',import.meta.url);
    const response=await fetch(new URL('manifest.json',root));
    if(!response.ok)throw new Error('prepare-browser-image-admission.mjs must run first');
    const manifest=await response.json();
    if(manifest.format!=='c-image-admission-diagnostic-v1' || manifest.linuxBoot!=='not-tested')throw new Error('local diagnostic format');
    async function read(name){
      const record=manifest.files[name];if(!record)throw new Error('undeclared diagnostic file');
      const reply=await fetch(new URL(name,root));if(!reply.ok)throw new Error(`HTTP ${reply.status}: ${name}`);
      const bytes=new Uint8Array(await reply.arrayBuffer());
      const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
      const hex=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
      if(bytes.length!==record.bytes || hex!==record.sha256)throw new Error(`stale/corrupt fixture: ${name}`);
      return bytes;
    }
    const [vm,compiler]=await Promise.all(['vm.wasm','compiler.wasm'].map(read)),cases=[];
    const names=manifest.cases??['multi','cross'];
    if(!Array.isArray(names)||!names.length||names.length>3||new Set(names).size!==names.length
        ||names.some(name=>!['multi','cross','fpu'].includes(name)))throw new Error('diagnostic case list');
    for(const name of names){
      const [elf,index]=await Promise.all([read(`${name}.elf`),read(`${name}/root-ref`)]);
      const result=await checkImageAdmission(vm,compiler,elf,index,opaque=>{
        if(!/^[0-9a-f]{64}$/.test(opaque))throw new Error('C object identity');
        return read(`${name}/${opaque}`);
      });
      cases.push({name,...result});
    }
    self.postMessage({format:'browser-c-image-admission-v1',status:'pass',linuxBoot:'not-tested',
      secureContext:self.isSecureContext,isolated:self.crossOriginIsolated,cases,
      fixtureIntegrity:'local diagnostic SHA-256; not signed release authorization'});
  }catch(error){self.postMessage({format:'browser-c-image-admission-v1',status:'fail',linuxBoot:'not-tested',error:error.message,stack:error.stack});}
};
