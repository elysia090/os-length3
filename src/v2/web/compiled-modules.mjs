// Exact C-emitted topology witnesses belong to one bounded Worker owner.
// Source coordinates, generation and permission admission remain in C. An
// entry is passed by value at execution; it is not another instance identity.
// Byte quotas bound retained encoded witnesses, not the engine's native code,
// transient compilation allocations or renderer RSS. Eviction releases our
// references; it is not a synchronous native-code/OS-memory reclamation proof.
function fingerprint(bytes) {
  // A bounded host index only, never authentication or semantic equivalence.
  // Every candidate must still match the entire immutable byte witness.
  let value=2166136261;
  for(let i=0;i<bytes.length;++i)value=Math.imul(value^bytes[i],16777619);
  return value>>>0;
}
function equal(left,right) {
  if(left.length!==right.length)return false;
  for(let i=0;i<left.length;++i)if(left[i]!==right[i])return false;
  return true;
}
export class CompiledModules {
  constructor(imports,{maximumEntries=64,maximumBytes=262144,maximumModuleBytes=65536,onEvict}={}) {
    for(const value of [maximumEntries,maximumBytes,maximumModuleBytes])
      if(!Number.isSafeInteger(value)||value<=0)throw new RangeError('positive bounded module quota');
    if(maximumModuleBytes>65536)throw new RangeError('small emitted module quota');
    if(onEvict!==undefined&&typeof onEvict!=='function')throw new TypeError('synchronous body release');
    this.onEvict=onEvict;
    this.imports=Object.fromEntries(Object.entries(imports)
      .map(([module,values])=>[module,Object.freeze({...values})]));
    this.maximumEntries=maximumEntries;this.maximumBytes=maximumBytes;
    this.maximumModuleBytes=maximumModuleBytes;
    this.entries=new Map();this.unreferenced=new Map();this.buckets=new Map();this.instances=new WeakMap();
    this.referencedEntries=0;
    this.bytes=0;this.hits=0;this.compilations=0;this.quotaEvictions=0;
    this.validatedDemands=0;this.newestInstance=null;this.closed=false;
  }
  find(hash,bytes) {
    const bucket=this.buckets.get(hash);
    if(bucket)for(const entry of bucket)if(equal(entry.bytes,bytes))return entry;
    return null;
  }
  touch(entry) {
    if(this.newestInstance!==entry.instance) {
      this.entries.delete(entry);this.entries.set(entry,true);
      if(!entry.references){this.unreferenced.delete(entry);this.unreferenced.set(entry,true);}
      this.newestInstance=entry.instance;
    }
  }
  retain(instance) {
    if(this.closed)throw new Error('module owner closed');
    const entry=this.instances.get(instance);
    if(!entry||!this.entries.has(entry))return false;
    if(!entry.references++){this.unreferenced.delete(entry);++this.referencedEntries;}
    return true;
  }
  release(instance) {
    if(this.closed)throw new Error('module owner closed');
    const entry=this.instances.get(instance);
    if(!entry||!entry.references)return false;
    if(!--entry.references){this.unreferenced.set(entry,true);--this.referencedEntries;}
    return true;
  }
  demand(instance) {
    if(this.closed)throw new Error('module owner closed');
    const entry=this.instances.get(instance);
    // This is only a lifetime hint after the caller's C source-lease check.
    // Foreign or evicted handles cannot resurrect a byte witness or admit code.
    if(!entry||!this.entries.has(entry))return false;
    this.touch(entry);++this.validatedDemands;return true;
  }
  async get(bytes) {
    if(this.closed)throw new Error('module owner closed');
    if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>this.maximumModuleBytes
        ||bytes.length>this.maximumBytes
        ||(typeof SharedArrayBuffer==='function'&&bytes.buffer instanceof SharedArrayBuffer))
      throw new RangeError('bounded emitted module');
    const hash=fingerprint(bytes),previous=this.find(hash,bytes);
    if(previous){this.touch(previous);++this.hits;return previous.instance;}
    // The caller's emission arena may be reused before this continuation.
    const owned=Uint8Array.from(bytes);
    await Promise.resolve();
    if(this.closed)throw new Error('module owner closed during compilation');
    // Duplicate pending work shares only after another complete byte match.
    const published=this.find(hash,owned);
    if(published){this.touch(published);++this.hits;return published.instance;}
    const module=new WebAssembly.Module(owned),instance=new WebAssembly.Instance(module,this.imports);
    if(this.closed)throw new Error('module owner closed during compilation');
    while(this.entries.size>=this.maximumEntries||this.bytes+owned.length>this.maximumBytes) {
      // Keep the exact byte index while a source directory retains its body.
      // The hard quota still wins when every candidate is referenced; release
      // all dependent source keys rather than leave an unindexed live body.
      const victim=(this.unreferenced.size?this.unreferenced:this.entries).keys().next().value,bucket=this.buckets.get(victim.hash);
      this.entries.delete(victim);this.instances.delete(victim.instance);
      this.unreferenced.delete(victim);if(victim.references)--this.referencedEntries;
      bucket.delete(victim);if(!bucket.size)this.buckets.delete(victim.hash);
      this.bytes-=victim.bytes.length;++this.quotaEvictions;
      this.onEvict?.(victim.instance);
    }
    const entry={bytes:owned,instance,hash,references:0};
    let bucket=this.buckets.get(hash);
    if(!bucket){bucket=new Set();this.buckets.set(hash,bucket);}
    bucket.add(entry);this.entries.set(entry,true);this.unreferenced.set(entry,true);this.instances.set(instance,entry);
    this.bytes+=owned.length;++this.compilations;this.newestInstance=instance;
    return instance;
  }
  stats() {
    return {compilations:this.compilations,hits:this.hits,entries:this.entries.size,
      quotaEvictions:this.quotaEvictions,validatedDemands:this.validatedDemands,
      retainedModuleBytes:this.bytes,referencedEntries:this.referencedEntries,maximumEntries:this.maximumEntries,maximumBytes:this.maximumBytes};
  }
  close() {
    this.closed=true;this.entries.clear();this.unreferenced.clear();this.buckets.clear();this.instances=new WeakMap();
    this.bytes=0;this.referencedEntries=0;this.imports=null;this.newestInstance=null;this.onEvict=null;
  }
}
