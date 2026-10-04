// Cache engine instances, not source instructions or guest-machine decisions.
// Every new body must first succeed in the C compiler. Exact emitted bytes are
// the reuse witness; source writes and changed compilation limits cannot reuse
// a different body under the same key. Imports belong to one Worker lifetime.
// The bounded owner is used in the execution Worker, not the UI thread.
export class CompiledModules {
  constructor(imports,{maximumEntries = 64,maximumBytes = 262144,maximumModuleBytes = 65536} = {}) {
    for (const value of [maximumEntries,maximumBytes,maximumModuleBytes])
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('positive bounded module quota');
    if (maximumModuleBytes > 65536) throw new RangeError('small emitted module quota');
    this.imports = Object.fromEntries(Object.entries(imports)
      .map(([module,values]) => [module,Object.freeze({...values})]));
    this.maximumEntries = maximumEntries;
    this.maximumBytes = maximumBytes;
    this.maximumModuleBytes = maximumModuleBytes;
    this.entries = new Map();
    this.bytes = 0; this.hits = 0; this.compilations = 0; this.closed = false;
    this.absentKeyCompilations = 0; this.changedBodyCompilations = 0; this.quotaEvictions = 0;
    this.validatedDemands = 0; this.newestInstance = null;
  }
  demand(key,instance) {
    if (this.closed) throw new Error('module owner closed');
    const entry=this.entries.get(key);
    if (!entry || entry.instance!==instance) return false;
    // The serialized caller has separately revalidated its installed C source
    // lease. This is only a lifetime hint for the SAME opaque instance, never
    // admission or a new-body equivalence witness. Missing/stale/other-owner
    // handles cannot resurrect a discarded byte witness or select guest code.
    if (this.newestInstance!==instance) {
      this.entries.delete(key); this.entries.set(key,entry); this.newestInstance=instance;
    }
    ++this.validatedDemands; return true;
  }
  async get(key,bytes) {
    if (this.closed) throw new Error('module owner closed');
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > this.maximumModuleBytes
        || bytes.length > this.maximumBytes) throw new RangeError('bounded emitted module');
    const previous = this.entries.get(key);
    if (previous && previous.bytes.length === bytes.length
        && previous.bytes.every((byte,rank) => byte === bytes[rank])) {
      // Only an exact C-emitted witness refreshes demand lifetime. Cold
      // construction may evict inactive entries, not a repeatedly used body.
      // Map insertion order gives bounded LRU without sorting or a new index.
      this.entries.delete(key); this.entries.set(key,previous);
      this.newestInstance=previous.instance;
      ++this.hits; return previous.instance;
    }
    // The caller's cold-emission arena is reused on the next request.
    const owned = Uint8Array.from(bytes);
    // Keep an explicit cancellation/publication boundary, but do not enqueue
    // engine jobs for a tiny body whose bytes are already resident and whose
    // sole caller must wait before executing it. Larger initial provider and
    // compiler modules use their separate asynchronous loaders.
    await Promise.resolve();
    if (this.closed) throw new Error('module owner closed during compilation');
    const module = new WebAssembly.Module(owned);
    const instance = new WebAssembly.Instance(module,this.imports);
    if (this.closed) throw new Error('module owner closed during compilation');
    ++this.compilations;
    // Request-time reason, counted only after successful construction. An
    // absent key may be new OR evicted: no unbounded history is retained.
    if (previous) ++this.changedBodyCompilations; else ++this.absentKeyCompilations;
    // Replace any entry installed while compilation was pending, not a stale
    // pre-await reference. This keeps accounting exact even for duplicate work.
    const current = this.entries.get(key);
    if (current) { this.bytes -= current.bytes.length; this.entries.delete(key); }
    while (this.entries.size >= this.maximumEntries || this.bytes + owned.length > this.maximumBytes) {
      const first = this.entries.keys().next().value, victim = this.entries.get(first);
      this.bytes -= victim.bytes.length; this.entries.delete(first);
      ++this.quotaEvictions;
    }
    this.entries.set(key,{bytes:owned,instance}); this.bytes += owned.length;
    this.newestInstance=instance;
    return instance;
  }
  stats() {
    return {compilations:this.compilations,hits:this.hits,entries:this.entries.size,
      absentKeyCompilations:this.absentKeyCompilations,changedBodyCompilations:this.changedBodyCompilations,
      quotaEvictions:this.quotaEvictions,validatedDemands:this.validatedDemands,
      retainedModuleBytes:this.bytes,maximumEntries:this.maximumEntries,maximumBytes:this.maximumBytes};
  }
  close() { this.closed = true; this.entries.clear(); this.bytes = 0; this.imports = null; this.newestInstance=null; }
}
