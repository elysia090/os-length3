import {checkStartup} from './startup-check.mjs';
import {diagnosticExtents} from './extent-reader.mjs';
import {waitForClock} from '../../../web/idle-clock.mjs';

let active=false,compilerReply,input=new Uint8Array(8192),inputHead=0,inputCount=0;
self.onmessage = async ({data}) => {
  if(data?.type==='input'){
    if(!active||typeof data.text!=='string'||data.text.length>4096){self.postMessage({status:'input-refused'});return;}
    const bytes=new TextEncoder().encode(data.text);if(inputCount+bytes.length>input.length){self.postMessage({status:'input-backpressure'});return;}
    for(const byte of bytes){input[(inputHead+inputCount)&8191]=byte;++inputCount;}return;
  }
  if(data?.type==='compiler'){
    if(!compilerReply||typeof data.fixture!=='string'||!/^generated-startup-[a-z0-9-]+$/.test(data.fixture)||data.fixture.length>80)return;
    try{
      const root=new URL(`./${data.fixture}/`,import.meta.url),reply=await fetch(new URL('manifest.json',root));
      if(!reply.ok)throw new Error(`compiler manifest HTTP ${reply.status}`);
      const manifest=await reply.json(),row=manifest.files?.['wasm-compiler.wasm'];
      if(manifest.format!=='bzimage-startup-diagnostic-v1'||!row||!Number.isInteger(row.bytes)||row.bytes<1||row.bytes>4194304)throw new Error('compiler manifest extent');
      const source=await fetch(new URL('wasm-compiler.wasm',root));if(!source.ok)throw new Error(`compiler HTTP ${source.status}`);
      const bytes=new Uint8Array(await source.arrayBuffer()),hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if(bytes.length!==row.bytes||hash!==row.sha256)throw new Error('compiler integrity');
      const resolve=compilerReply;compilerReply=null;resolve(bytes);
    }catch(error){self.postMessage({status:'running',awaiting:'compiler-update',error:error.message});}
    return;
  }
  if(active)return;
  try {
    if ((data?.warmCuts !== undefined && (!Number.isInteger(data.warmCuts) || data.warmCuts < 1 || data.warmCuts > 64))
        || (data?.idle !== undefined && typeof data.idle !== 'boolean'))
      throw new Error('diagnostic warm/idle selection');
    const fixture=data?.fixture ?? 'generated-startup';
    if (typeof fixture!=='string' || fixture.length>80 || !/^generated-startup(?:-[a-z0-9-]+)?$/.test(fixture))
      throw new Error('diagnostic fixture directory');
    const root=new URL(`./${fixture}/`,import.meta.url);
    const response=await fetch(new URL('manifest.json',root));
    if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
    const manifest = await response.json();
    if (manifest.format !== 'bzimage-startup-diagnostic-v1') throw new Error('diagnostic manifest format');
    if (manifest.immutableImage && manifest.objects?.[5]?.bytes!==manifest.immutableImage.bytes)
      throw new Error('immutable image descriptor/object mismatch');
    const cache = new Map();
    const read = async name => {
      const row = manifest.files[name];
      if (!row || !/^[a-z0-9.-]+$/.test(name)) throw new Error('undeclared diagnostic fixture');
      if (!cache.has(name)) cache.set(name,(async () => {
        const response = await fetch(new URL(name,root));
        if (!response.ok) throw new Error(`fixture HTTP ${response.status}: ${name}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
        const hex = Array.from(digest,byte => byte.toString(16).padStart(2,'0')).join('');
        if (bytes.length !== row.bytes || hex !== row.sha256) throw new Error(`fixture integrity: ${name}`);
        return bytes;
      })());
      return cache.get(name);
    };
    const transport = diagnosticExtents(manifest.objects,root);
    active=true;
    const result = await checkStartup(read,await read('vm.wasm'),await read('wasm-compiler.wasm'),transport.read,
      {extended:data?.extended === true,onProgress:progress => self.postMessage(progress),
        keepAlive:data?.interactive===true,
        warmCuts:data?.warmCuts??1,idleWait:data?.idle===true?waitForClock:undefined,
        onCompilerRefusal:data?.interactive===true?refusal=>new Promise(resolve=>{compilerReply=resolve;self.postMessage({status:'running',awaiting:'compiler-update',refusal});}):undefined,
        readInput:data?.interactive===true?consume=>{if(!inputCount)return null;const byte=input[inputHead];
          if(consume){inputHead=(inputHead+1)&8191;--inputCount;}return byte;}:undefined,
        immutableImage:manifest.immutableImage,
        decompression:JSON.parse(new TextDecoder().decode(await read('boot.decompression.json')))});
    self.postMessage({...result,secureContext:self.isSecureContext,isolated:self.crossOriginIsolated,
      fixtureIntegrity:'local diagnostic SHA-256; not signed production admission',
      objectTransport:transport.stats,
      sourceReceipt:new TextDecoder().decode(await read('source.sha256')).trim().split('\n')});
    active=false;
  } catch (error) {
    active=false;compilerReply=null;
    self.postMessage({format:'browser-bzimage-startup-v1',status:'fail',linuxBoot:'not-achieved',
      error:error.message,stack:error.stack,diagnostic:error.diagnostic});
  }
};
