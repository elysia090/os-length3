// Coalesce host lifetime hints within one unchanged C source publication epoch.
// C still owns and validates every executed source lease. This stores no body,
// CPU state or execution authority; it only avoids rescanning observed ranks.
export class SourceDemands {
  constructor(capacity) {
    if(!Number.isSafeInteger(capacity)||capacity<1||capacity>8192)
      throw new RangeError('bounded C source demand capacity');
    this.capacity=capacity;
    this.words=new BigUint64Array(Math.ceil(capacity/64));
    this.epochs=new Float64Array(this.words.length);this.epochs.fill(-1);
    this.observations=0;this.reusedWords=0;
  }
  fresh(group,mask,epoch) {
    if(!Number.isInteger(group)||group<0||group>=this.words.length||typeof mask!=='bigint'
      ||!Number.isSafeInteger(epoch)||epoch<0)throw new RangeError('C source demand word');
    const bits=BigInt.asUintN(64,mask);++this.observations;
    let fresh=bits;
    if(this.epochs[group]===epoch)fresh&=~this.words[group];
    else {this.words[group]=0n;this.epochs[group]=epoch;}
    this.words[group]|=bits;
    if(bits&&!fresh)++this.reusedWords;
    return fresh;
  }
  reset(){this.words.fill(0n);this.epochs.fill(-1);}
  stats(){return {observations:this.observations,reusedWords:this.reusedWords,
    words:this.words.length,metadataBytes:this.words.byteLength+this.epochs.byteLength};}
}

// One batch crosses the JS/Wasm boundary; VM getters stay native Wasm calls.
// This helper owns a fixed 64 KiB memory and imports only readonly source hints.
export async function openBatchedSourceDemands(vm,capacity,providedBytes) {
  if(!Number.isInteger(capacity)||capacity<1||capacity>8192)throw new RangeError('bounded source hints');
  for(const name of ['vm_source_demand_groups','vm_source_demand_group','vm_source_demand_word'])
    if(typeof vm[name]!=='function')throw new Error('selected provider lacks batched source observation');
  let bytes=providedBytes;
  const location=new URL('./source-demands.wasm',import.meta.url);
  if(bytes===undefined&&location.protocol==='file:')bytes=new Uint8Array(await (await import('node:fs/promises')).readFile(location));
  if(bytes===undefined){const response=await fetch(location,{cache:'no-cache'});
    if(!response.ok)throw new Error('source observation delivery failed');
    bytes=new Uint8Array(1306);let at=0;const reader=response.body.getReader();
    try{for(;;){const part=await reader.read();if(part.done)break;if(part.value.length>bytes.length-at)throw new Error('oversized source observer');bytes.set(part.value,at);at+=part.value.length;}
      if(at!==bytes.length)throw new Error('short source observer');
    }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}}
  if(!(bytes instanceof Uint8Array)||bytes.length!==1306)throw new Error('source observer extent');
  bytes=Uint8Array.from(bytes);
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!=='40431723079c448cddddfd19d26b067e01bb8c6d41a2afe9419a5c7db00672e9')throw new Error('source observer identity differs');
  const module=await WebAssembly.compile(bytes),imports=WebAssembly.Module.imports(module);
  if(imports.length!==3||imports.some(x=>x.module!=='source'||x.kind!=='function'||!['groups','group','word'].includes(x.name)))throw new Error('readonly observer imports');
  const e=(await WebAssembly.instantiate(module,{source:{groups:vm.vm_source_demand_groups,group:vm.vm_source_demand_group,word:vm.vm_source_demand_word}})).exports;
  if(e.source_demands_abi()!==1||e.memory.buffer.byteLength!==65536)throw new Error('private source observer ABI');
  const at=e.source_demands_data();if(at%4||at<0||at+capacity*4>e.memory.buffer.byteLength)throw new Error('source observer private extent');
  const ranks=new Uint32Array(e.memory.buffer,at,capacity);
  return {ranks,read(epoch){if(!Number.isSafeInteger(epoch)||epoch<0)throw new RangeError('source publication epoch');
    const count=e.source_demands_read(epoch>>>0,Math.floor(epoch/4294967296),capacity);
    if(count<0||count>capacity)throw new Error('C source observation failed');return count;},
    reset(){e.source_demands_reset();},stats(){return {mode:'wasm-batch',observations:Number(e.source_demands_observations()),reusedWords:Number(e.source_demands_reused()),
      metadataBytes:e.memory.buffer.byteLength,helperBytes:1306,helperSha256:'40431723079c448cddddfd19d26b067e01bb8c6d41a2afe9419a5c7db00672e9'};}};
}
