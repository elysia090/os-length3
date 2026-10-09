// Bounded construction reuse. Keys come only from a fresh C-MMU source pin
// and C physical revisions; this directory never resolves or executes RIPs.
// Values are ordinary compiler-emitted Wasm instances plus exact publication
// metadata, not a second executable format, source copy or interpreter.
export class PreparedCode {
  constructor({maximumEntries=8192,maximumBytes=2097152}={}){
    for(const n of [maximumEntries,maximumBytes])if(!Number.isSafeInteger(n)||n<1)throw new RangeError('bounded prepared code');
    this.maximumEntries=maximumEntries;this.maximumBytes=maximumBytes;this.entries=new Map();this.bodies=new Map();
    this.bytes=0;this.hits=0;this.misses=0;this.evictions=0;this.closed=false;
  }
  get(key){if(this.closed)throw new Error('prepared owner closed');if(typeof key!=='string')throw new TypeError('C source identity');
    const entry=this.entries.get(key);if(!entry){++this.misses;return null;}
    this.entries.delete(key);this.entries.set(key,entry);++this.hits;return entry;
  }
  discard(key){const entry=this.entries.get(key);if(!entry)return;this.entries.delete(key);
    const body=this.bodies.get(entry.instance);if(--body.references===0){this.bytes-=body.bytes;this.bodies.delete(entry.instance);}++this.evictions;
  }
  put(key,value){if(this.closed)throw new Error('prepared owner closed');
    if(typeof key!=='string'||!(value.instance instanceof WebAssembly.Instance)||typeof value.instance.exports.cut!=='function'
      ||!Number.isInteger(value.bytes)||value.bytes<1||value.bytes>65536||value.bytes>this.maximumBytes
      ||!Number.isInteger(value.sourceBytes)||value.sourceBytes<1||value.sourceBytes>4096
      ||!Number.isInteger(value.instructions)||value.instructions<1||value.instructions>1024||value.instructions>value.sourceBytes
      ||!Number.isInteger(value.binding)||value.binding<0||value.binding>0xffffffff)throw new RangeError('trusted emitted code metadata');
    const previous=this.entries.get(key);if(previous){
      if(previous.sourceBytes!==value.sourceBytes||previous.instructions!==value.instructions||previous.binding!==value.binding||previous.bytes!==value.bytes)
        throw new Error('immutable C source construction changed');
      return previous;
    }
    let body=this.bodies.get(value.instance);
    if(body&&body.bytes!==value.bytes)throw new Error('same body with inconsistent extent');
    // Evicting the last reference can turn a shared body into a new body.
    // Recompute its charge after each removal, not once before the loop.
    while(this.entries.size>=this.maximumEntries
      ||this.bytes+(this.bodies.has(value.instance)?0:value.bytes)>this.maximumBytes)
      this.discard(this.entries.keys().next().value);
    body=this.bodies.get(value.instance);
    if(!body){body={bytes:value.bytes,references:0};this.bodies.set(value.instance,body);this.bytes+=value.bytes;}
    if(body.bytes!==value.bytes)throw new Error('same body with inconsistent extent');
    ++body.references;const entry=Object.freeze({...value});this.entries.set(key,entry);return entry;
  }
  stats(){return {hits:this.hits,misses:this.misses,entries:this.entries.size,bodies:this.bodies.size,evictions:this.evictions,
    uniqueEncodedBytes:this.bytes,maximumEntries:this.maximumEntries,maximumBytes:this.maximumBytes};}
  close(){this.closed=true;this.entries.clear();this.bodies.clear();this.bytes=0;}
}
