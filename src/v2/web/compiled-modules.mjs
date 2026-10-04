// Cache engine instances, not source instructions or guest-machine decisions.
// Every request must first succeed in the C compiler. Exact emitted bytes are
// the reuse witness; source writes and changed compilation limits cannot reuse
// a different body under the same key. Imports belong to one Worker lifetime.
export class CompiledModules {
  constructor(imports,{maximumEntries = 64,maximumBytes = 262144,maximumModuleBytes = 65536} = {}) {
    for (const value of [maximumEntries,maximumBytes,maximumModuleBytes])
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('positive bounded module quota');
    this.imports = Object.fromEntries(Object.entries(imports)
      .map(([module,values]) => [module,Object.freeze({...values})]));
    this.maximumEntries = maximumEntries;
    this.maximumBytes = maximumBytes;
    this.maximumModuleBytes = maximumModuleBytes;
    this.entries = new Map();
    this.bytes = 0; this.hits = 0; this.compilations = 0; this.closed = false;
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
      ++this.hits; return previous.instance;
    }
    // The caller's cold-emission arena is reused on the next request.
    const owned = Uint8Array.from(bytes);
    const module = await WebAssembly.compile(owned);
    if (this.closed) throw new Error('module owner closed during compilation');
    const instance = await WebAssembly.instantiate(module,this.imports);
    if (this.closed) throw new Error('module owner closed during compilation');
    ++this.compilations;
    // Replace any entry installed while compilation was pending, not a stale
    // pre-await reference. This keeps accounting exact even for duplicate work.
    const current = this.entries.get(key);
    if (current) { this.bytes -= current.bytes.length; this.entries.delete(key); }
    while (this.entries.size >= this.maximumEntries || this.bytes + owned.length > this.maximumBytes) {
      const first = this.entries.keys().next().value, victim = this.entries.get(first);
      this.bytes -= victim.bytes.length; this.entries.delete(first);
    }
    this.entries.set(key,{bytes:owned,instance}); this.bytes += owned.length;
    return instance;
  }
  stats() {
    return {compilations:this.compilations,hits:this.hits,entries:this.entries.size,
      retainedModuleBytes:this.bytes,maximumEntries:this.maximumEntries,maximumBytes:this.maximumBytes};
  }
  close() { this.closed = true; this.entries.clear(); this.bytes = 0; this.imports = null; }
}
