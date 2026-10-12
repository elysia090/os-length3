// Encrypted physical blocks. Linux alone gives these bytes filesystem meaning.
// The small authenticated radix directory proves holes; a missing object is
// corruption, not a zero page. The caller retains the key and trusted head.
import {deriveVolumeStorageKeys,encodeVolumeRootAad,sealMetadataObject,
  openMetadataObject,prepareRootPublication,openRootDescriptor,commitRootPublication} from './ciphertext-storage.js';
const utf8=new TextEncoder(),zero=new Uint8Array(4096),maxPages=0x1000000;
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const hash=async b=>hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)));
const unhex=s=>Uint8Array.from(s.match(/../g),x=>parseInt(x,16));
const same=(a,b)=>a===null?b===null:b!==null&&a.length===b.length&&a.every((x,i)=>x===b[i]);
function extent(offset,bytes,total){if(!Number.isSafeInteger(offset)||!Number.isInteger(bytes)||offset<0||bytes<1||bytes>4096||offset>total-bytes)throw new RangeError('bounded physical block extent');}
export class IndexedBlockStore {
  static async open(name,{fence=null}={}){
    if(typeof name!=='string'||!/^[a-z0-9._-]{1,100}$/.test(name))throw new TypeError('opaque storage namespace');
    const db=await new Promise((resolve,reject)=>{let blocked=false;const r=indexedDB.open(`length3-block-${name}`,2);
      r.onupgradeneeded=()=>{if(blocked){r.transaction.abort();return;}for(const store of ['objects','head','authority'])
        if(!r.result.objectStoreNames.contains(store))r.result.createObjectStore(store);};
      r.onsuccess=()=>{if(blocked)r.result.close();else resolve(r.result);};r.onerror=()=>reject(r.error);
      r.onblocked=()=>{blocked=true;reject(new Error('storage upgrade blocked'));};});
    db.onversionchange=()=>db.close();return new IndexedBlockStore(db,fence);
  }
  constructor(db,fence=null){this.db=db;this.fence=fence;}
  transaction(store,write,body){return new Promise((resolve,reject)=>{
    const tx=this.db.transaction([store,'authority'],write?'readwrite':'readonly',write?{durability:'strict'}:undefined);
    let output,failure;tx.oncomplete=()=>resolve(output);tx.onabort=()=>reject(failure??tx.error??new Error('storage transaction aborted'));
    tx.onerror=()=>{};
    const r=tx.objectStore('authority').get(1);r.onsuccess=()=>{
      if((r.result??null)!==this.fence){failure=new Error('workspace supervisor fence lost');tx.abort();return;}
      try{body(tx.objectStore(store),v=>{output=v;});}
      catch(error){failure=error;tx.abort();}};
  });}
  async get(key){return this.transaction('objects',false,(s,done)=>{const r=s.get(key);r.onsuccess=()=>done(r.result?new Uint8Array(r.result):null);});}
  async put(key,bytes){return this.transaction('objects',true,(s,done)=>{const r=s.get(key);r.onsuccess=()=>{
    if(r.result&&!same(new Uint8Array(r.result),bytes)){txAbort(s);return;}
    if(!r.result)s.add(bytes.slice(),key);done(true);};});}
  async read(){return this.transaction('head',false,(s,done)=>{const r=s.get(0);r.onsuccess=()=>done(r.result?new Uint8Array(r.result):null);});}
  async compareAndSwap(expected,replacement){return this.transaction('head',true,(s,done)=>{const r=s.get(0);r.onsuccess=()=>{
    const current=r.result?new Uint8Array(r.result):null;if(!same(expected,current)){done(false);return;}
    const authority=s.transaction.objectStore('authority'),a=authority.get(0);a.onsuccess=()=>{
      if(a.result){if(!(a.result.expectedHead===null||a.result.expectedHead instanceof Uint8Array)
        ||!same(a.result.expectedHead,current)){txAbort(s);return;}
        authority.put({...a.result,expectedHead:replacement.slice()},0);}
      s.put(replacement.slice(),0);done(true);};};});}
  close(){this.db.close();}
}
function txAbort(store){store.transaction.abort();}
export class PersistentBlock {
  static async open({store,masterKey,volumeId,volumeSalt,bytes,create=false,expectedHead=null,onHead=()=>{}}){
    if(!store||!Number.isSafeInteger(bytes)||bytes<4096||bytes%4096||bytes/4096>maxPages)throw new TypeError('bounded persistent volume');
    const keys=await deriveVolumeStorageKeys(masterKey,volumeSalt,volumeId),aad=encodeVolumeRootAad({volumeId,volumeSalt});
    const v=new PersistentBlock();Object.assign(v,{store,keys,aad,bytes,onHead,cache:new Map(),dirty:new Map(),revision:0n,root:null,failed:false,closed:false});
    const head=await store.read();if(expectedHead!==null&&!same(head,expectedHead))throw new Error('persistent head rollback or replacement');
    if(head===null){if(!create)throw new Error('persistent volume missing; explicit creation required');v.head=null;await v.publish(null);v.fresh=true;}
    else{if(create)throw new Error('existing volume cannot be formatted as new');
      const raw=await openRootDescriptor(keys.rootKey,head,aad);if(raw.length!==52)throw new Error('volume root extent');
      const view=new DataView(raw.buffer,raw.byteOffset,raw.length);
      if(view.getUint32(0,true)!==1||view.getBigUint64(4,true)!==BigInt(bytes))throw new Error('volume root contract');
      v.revision=view.getBigUint64(12,true);v.root=raw.subarray(20).some(Boolean)?hex(raw.subarray(20)):null;v.head=head;
      // Creation publishes revision1 before Linux writes its first block.
      // Closing that untouched owner must not turn it into an existing
      // filesystem. A later empty root is NOT fresh: zeroing/wiping never
      // authorizes formatting. No host filesystem signature is inspected.
      v.fresh=v.revision===1n&&v.root===null;}
    return v;
  }
  context(role,coordinate){const suffix=utf8.encode(`physical-block-v1/${role}/${coordinate}`),out=new Uint8Array(this.aad.length+suffix.length);out.set(this.aad);out.set(suffix,this.aad.length);return out;}
  async object(key,role,coordinate){
    const encoded=await this.store.get(key);if(!encoded||await hash(encoded)!==key)throw new Error('missing/corrupt authenticated physical object');
    return openMetadataObject(this.keys.metadataKey,encoded,this.context(role,coordinate));
  }
  async save(raw,role,coordinate){const encoded=await sealMetadataObject(this.keys.metadataKey,raw,this.context(role,coordinate)),key=await hash(encoded);await this.store.put(key,encoded);return key;}
  async node(key,level){if(!key)return new Map();const raw=await this.object(key,'directory',level),view=new DataView(raw.buffer,raw.byteOffset,raw.length);
    if(raw.length<2||raw.length!==2+33*view.getUint16(0,true)||view.getUint16(0,true)>256)throw new Error('physical directory extent');
    const out=new Map();let last=-1;for(let at=2;at<raw.length;at+=33){const rank=raw[at];if(rank<=last)throw new Error('noncanonical physical directory');last=rank;out.set(rank,hex(raw.subarray(at+1,at+33)));}return out;}
  async saveNode(node,level){if(!node.size)return null;const raw=new Uint8Array(2+node.size*33);new DataView(raw.buffer).setUint16(0,node.size,true);let at=2;
    for(const [rank,key]of [...node].sort((a,b)=>a[0]-b[0])){raw[at]=rank;raw.set(unhex(key),at+1);at+=33;}return this.save(raw,'directory',level);}
  async leaf(page){let key=this.root;for(let level=2;level>=0;--level){const node=await this.node(key,level);key=node.get((page>>>(8*level))&255)??null;if(!key)return null;}return key;}
  active(){if(this.failed)throw new Error('persistent volume failed');if(this.closed)throw new Error('persistent volume closed');}
  async page(page){this.active();if(this.dirty.has(page))return this.dirty.get(page);
    if(this.cache.has(page)){const p=this.cache.get(page);this.cache.delete(page);this.cache.set(page,p);return p;}
    const key=await this.leaf(page),raw=key?await this.object(key,'page',page):zero.slice();if(raw.length!==4096)throw new Error('physical page extent');
    if(this.cache.size>=32){const rank=this.cache.keys().next().value;this.cache.get(rank).fill(0);this.cache.delete(rank);}this.cache.set(page,raw);return raw;}
  async read(offset,bytes){extent(offset,bytes,this.bytes);const out=new Uint8Array(bytes);for(let at=0;at<bytes;){const pos=offset+at,page=Math.floor(pos/4096),within=pos%4096,n=Math.min(bytes-at,4096-within);out.set((await this.page(page)).subarray(within,within+n),at);at+=n;}return out;}
  async write(offset,input){this.active();extent(offset,input?.length,this.bytes);if(!(input instanceof Uint8Array))throw new TypeError('physical block bytes');
    if(this.dirty.size>=256)await this.flush();for(let at=0;at<input.length;){const pos=offset+at,page=Math.floor(pos/4096),within=pos%4096,n=Math.min(input.length-at,4096-within);
      let raw=this.dirty.get(page);if(!raw){raw=(await this.page(page)).slice();this.dirty.set(page,raw);}raw.set(input.subarray(at,at+n),within);at+=n;}}
  async replaceMany(key,level,changes){const node=await this.node(key,level),groups=new Map();
    for(const [page,leaf]of changes){const rank=(page>>>(8*level))&255;if(!groups.has(rank))groups.set(rank,[]);groups.get(rank).push([page,leaf]);}
    for(const [rank,rows]of groups){const child=level?await this.replaceMany(node.get(rank)??null,level-1,rows):rows[0][1];
      if(child)node.set(rank,child);else node.delete(rank);}return this.saveNode(node,level);}
  async publish(root){if(this.revision===0xffffffffffffffffn)throw new Error('volume revision exhausted');const raw=new Uint8Array(52),view=new DataView(raw.buffer);
    view.setUint32(0,1,true);view.setBigUint64(4,BigInt(this.bytes),true);view.setBigUint64(12,this.revision+1n,true);if(root)raw.set(unhex(root),20);
    const envelope=await prepareRootPublication({key:this.keys.rootKey,descriptor:raw,additionalData:this.aad});
    await commitRootPublication({register:this.store,expectedEnvelope:this.head,envelope});this.head=envelope;this.root=root;++this.revision;await this.onHead(envelope.slice());}
  async flush(){this.active();if(!this.dirty.size)return;
    try{const changes=[];for(const [page,raw]of this.dirty)changes.push([page,raw.some(Boolean)?await this.save(raw,'page',page):null]);
      const root=await this.replaceMany(this.root,2,changes);
      await this.publish(root);for(const [page,raw]of this.dirty){this.cache.get(page)?.fill(0);this.cache.delete(page);raw.fill(0);}this.dirty.clear();
    }catch(e){this.failed=true;throw e;}}
  async close(){if(!this.closing)this.closing=(async()=>{
    try{await this.flush();}
    finally{this.closed=true;for(const raw of this.cache.values())raw.fill(0);this.cache.clear();
      for(const raw of this.dirty.values())raw.fill(0);this.dirty.clear();await this.store.close?.();}
  })();return this.closing;}
}
