// A bounded memo of complete, freshly supplied C source receipts.
// Neither this index nor a shared body authorizes source execution.
export function sourceStampHash(words){
  let hash=2166136261;
  for(let i=0;i<10;i++)hash=Math.imul(hash^words[i],16777619);
  hash=Math.imul(hash^(hash>>>16),0x85ebca6b);
  hash=Math.imul(hash^(hash>>>13),0xc2b2ae35);
  return(hash^(hash>>>16))>>>0;
}
export class StampedCode{
  constructor({maximumEntries=16384,maximumBytes=4194304,maximumAliases=64,maximumPages=262144,retain,release}={}){
    for(const n of [maximumEntries,maximumBytes,maximumAliases,maximumPages])if(!Number.isSafeInteger(n)||n<1)throw new RangeError('bounded source receipt quota');
    if(maximumEntries>16384||maximumPages>1048576||maximumAliases>maximumEntries)throw new RangeError('bounded source receipt extent');
    if((retain!==undefined||release!==undefined)&&(typeof retain!=='function'||typeof release!=='function'))throw new TypeError('paired body lifetime hooks');
    Object.assign(this,{maximumEntries,maximumBytes,maximumAliases,maximumPages,retain,release});
    let buckets=16;while(buckets<maximumEntries*2)buckets*=2;
    this.keys=new Uint32Array(maximumEntries*10);this.buckets=new Uint32Array(buckets);
    this.chains=new Uint32Array(maximumEntries+1);this.hashes=new Uint32Array(maximumEntries+1);
    this.prev=new Uint32Array(maximumEntries+1);this.next=new Uint32Array(maximumEntries+1);
    this.free=new Uint32Array(maximumEntries);for(let i=0;i<maximumEntries;i++)this.free[i]=maximumEntries-i;
    this.used=new Uint8Array(maximumEntries+1);this.latest=new Uint32Array(maximumPages);
    this.values=new Array(maximumEntries+1);this.watchers=new Map();this.bodies=new Map();
    this.metadataBytes=[this.keys,this.buckets,this.chains,this.hashes,this.prev,this.next,this.free,this.used,this.latest].reduce((n,a)=>n+a.byteLength,0);
    this.freeCount=maximumEntries;this.first=this.last=this.entries=this.bytes=this.watchLinks=0;
    this.hits=this.misses=this.evictions=this.aliasSkips=this.revisionDrops=this.scopeDrops=this.staleObservations=0;
    this.scope=null;this.closed=false;
  }
  active(){if(this.closed)throw new Error('source receipt owner closed');}
  validate(words){
    if(!(words instanceof Uint32Array)||words.length!==10||(typeof SharedArrayBuffer==='function'&&words.buffer instanceof SharedArrayBuffer)
      ||words[0]>=4096||words[1]<1||words[1]>1024||!(words[2]|words[3])||!(words[4]|words[5]))throw new RangeError('complete C source stamp');
    for(const at of [6,8]){const owner=words[at],revision=words[at+1];
      if(at===8&&!owner&&!revision)continue;
      if(owner<4096||(owner&4095)||(owner>>>12)>=this.maximumPages||!revision||revision===0xffffffff)throw new RangeError('bounded physical source revision');
    }
    if(words[6]===words[8]&&words[7]!==words[9])throw new RangeError('one physical page, one revision');
  }
  observe(words){
    const same=this.scope&&this.scope.every((n,i)=>n===words[i+2]);
    if(!same){while(this.first)this.remove(this.first,'scope');this.latest.fill(0);this.scope=words.slice(2,6);}
    for(const at of [6,8])if(words[at]&&words[at+1]<this.latest[words[at]>>>12]){this.staleObservations++;return false;}
    for(const at of [6,8])if(words[at]){const page=words[at]>>>12,revision=words[at+1];
      if(revision>this.latest[page]){this.latest[page]=revision;const rows=this.watchers.get(page);while(rows?.size)this.remove(rows.values().next().value,'revision');}}
    return true;
  }
  find(words,hash){
    for(let row=this.buckets[hash&(this.buckets.length-1)];row;row=this.chains[row]){
      if(this.hashes[row]!==hash)continue;let same=true;const at=(row-1)*10;
      for(let i=0;i<10;i++)if(this.keys[at+i]!==words[i]){same=false;break;}
      if(same)return row;
    }return 0;
  }
  touch(row){if(row===this.last)return;const before=this.prev[row],after=this.next[row];
    if(before)this.next[before]=after;else this.first=after;if(after)this.prev[after]=before;
    this.prev[row]=this.last;this.next[row]=0;if(this.last)this.next[this.last]=row;else this.first=row;this.last=row;
  }
  get(words){this.active();this.validate(words);if(!this.observe(words)){this.misses++;return null;}
    const row=this.find(words,sourceStampHash(words));if(!row){this.misses++;return null;}this.touch(row);this.hits++;return this.values[row];
  }
  remove(row,reason='quota'){
    if(!this.used[row])return;const value=this.values[row],body=this.bodies.get(value.instance),bucket=this.hashes[row]&(this.buckets.length-1);
    let previous=0,current=this.buckets[bucket];while(current!==row){previous=current;current=this.chains[current];if(!current)throw new Error('source receipt chain corrupt');}
    if(previous)this.chains[previous]=this.chains[row];else this.buckets[bucket]=this.chains[row];
    const before=this.prev[row],after=this.next[row];if(before)this.next[before]=after;else this.first=after;if(after)this.prev[after]=before;else this.last=before;
    const offset=(row-1)*10;
    for(const at of [6,8]){const owner=this.keys[offset+at];if(!owner||(at===8&&owner===this.keys[offset+6]))continue;
      const page=owner>>>12,rows=this.watchers.get(page);if(rows?.delete(row))this.watchLinks--;if(!rows?.size)this.watchers.delete(page);}
    body.rows.delete(row);if(!body.rows.size){this.bodies.delete(value.instance);this.bytes-=body.bytes;this.release?.(value.instance);}
    this.used[row]=0;this.values[row]=null;this.chains[row]=this.prev[row]=this.next[row]=0;this.free[this.freeCount++]=row;this.entries--;this.evictions++;
    if(reason==='revision')this.revisionDrops++;if(reason==='scope')this.scopeDrops++;
  }
  discardInstance(instance){this.active();const body=this.bodies.get(instance);if(!body)return 0;const count=body.rows.size;while(body.rows.size)this.remove(body.rows.values().next().value,'module');return count;}
  put(words,value){
    this.active();this.validate(words);
    if(!(value?.instance instanceof WebAssembly.Instance)||typeof value.instance.exports.cut!=='function'||!Number.isInteger(value.bytes)||value.bytes<1||value.bytes>65536||value.bytes>this.maximumBytes
      ||!Number.isInteger(value.sourceBytes)||value.sourceBytes<1||value.sourceBytes>4096||!Number.isInteger(value.instructions)||value.instructions<1||value.instructions>1024||value.instructions>value.sourceBytes||value.instructions>words[1]
      ||!Number.isInteger(value.binding)||value.binding<0||value.binding>0xffffffff)throw new RangeError('trusted emitted source receipt');
    let body=this.bodies.get(value.instance),acquired=false;
    if(body&&body.bytes!==value.bytes)throw new Error('same body with inconsistent extent');
    if(!body&&this.retain){if(!this.retain(value.instance))throw new Error('missing exact body owner');acquired=true;}
    if(!this.observe(words)){if(acquired)this.release?.(value.instance);return false;}
    const hash=sourceStampHash(words),existing=this.find(words,hash);
    if(existing){const old=this.values[existing];if(old.instance!==value.instance||old.bytes!==value.bytes||old.sourceBytes!==value.sourceBytes||old.instructions!==value.instructions||old.binding!==value.binding)throw new Error('immutable C source construction changed');return old;}
    body=this.bodies.get(value.instance);
    if(body&&body.rows.size>=this.maximumAliases){this.aliasSkips++;if(acquired)this.release?.(value.instance);return false;}
    while(this.entries>=this.maximumEntries||this.bytes+(this.bodies.has(value.instance)?0:value.bytes)>this.maximumBytes)this.remove(this.first);
    body=this.bodies.get(value.instance);
    if(!body){if(!acquired&&this.retain){if(!this.retain(value.instance))throw new Error('missing exact body owner');acquired=true;}body={bytes:value.bytes,rows:new Set()};this.bodies.set(value.instance,body);this.bytes+=value.bytes;}
    const row=this.free[--this.freeCount];this.keys.set(words,(row-1)*10);this.hashes[row]=hash;
    const bucket=hash&(this.buckets.length-1);this.chains[row]=this.buckets[bucket];this.buckets[bucket]=row;
    this.used[row]=1;this.values[row]=Object.freeze({...value});body.rows.add(row);this.entries++;
    this.prev[row]=this.last;this.next[row]=0;if(this.last)this.next[this.last]=row;else this.first=row;this.last=row;
    for(const at of [6,8]){const owner=words[at];if(!owner||(at===8&&owner===words[6]))continue;const page=owner>>>12;let rows=this.watchers.get(page);if(!rows){rows=new Set();this.watchers.set(page,rows);}rows.add(row);this.watchLinks++;}
    return this.values[row];
  }
  stats(){return{kind:'complete-numeric-C-stamp',hits:this.hits,misses:this.misses,entries:this.entries,bodies:this.bodies.size,evictions:this.evictions,uniqueEncodedBytes:this.bytes,maximumEntries:this.maximumEntries,maximumBytes:this.maximumBytes,maximumAliases:this.maximumAliases,aliasSkips:this.aliasSkips,revisionDrops:this.revisionDrops,scopeDrops:this.scopeDrops,staleObservations:this.staleObservations,metadataBytes:this.closed?0:this.metadataBytes,watchPages:this.watchers.size,watchLinks:this.watchLinks};}
  close(){if(this.closed)return;while(this.first)this.remove(this.first,'close');this.closed=true;this.scope=null;this.retain=this.release=null;
    this.keys=this.buckets=this.chains=this.hashes=this.prev=this.next=this.free=this.used=this.latest=this.values=null;}
}
