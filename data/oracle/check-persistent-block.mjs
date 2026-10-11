import assert from 'node:assert/strict';
import {importStorageMasterKey} from '../../src/v2/web/ciphertext-storage.js';
import {PersistentBlock} from '../../src/v2/web/persistent-block.mjs';
class Store {
  objects=new Map();head=null;
  async get(k){return this.objects.get(k)?.slice()??null;}
  async put(k,b){if(this.objects.has(k))assert.deepEqual(b,this.objects.get(k));else this.objects.set(k,b.slice());}
  async read(){return this.head?.slice()??null;}
  async compareAndSwap(a,b){if(a===null?this.head!==null:!a.every((v,i)=>this.head?.[i]===v))return false;this.head=b.slice();return true;}
}
const masterKey=await importStorageMasterKey(crypto.getRandomValues(new Uint8Array(32))),volumeId=new Uint8Array(16).fill(1),volumeSalt=new Uint8Array(32).fill(2),store=new Store();
const config={store,masterKey,volumeId,volumeSalt,bytes:1073741824};
// An interrupted boot before the first guest write retains initial creation
// authority; a committed all-zero write must never regain it.
const untouched=new Store(),emptyConfig={...config,store:untouched};
let empty=await PersistentBlock.open({...emptyConfig,create:true});
const emptyHead=await untouched.read();await empty.close();
empty=await PersistentBlock.open({...emptyConfig,expectedHead:emptyHead});
assert(empty.fresh);assert.equal(empty.revision,1n);assert.equal(empty.root,null);
await empty.write(0,new Uint8Array(4096));await empty.close();
empty=await PersistentBlock.open({...emptyConfig,expectedHead:await untouched.read()});
assert(!empty.fresh);assert.equal(empty.revision,2n);assert.equal(empty.root,null);await empty.close();
let v=await PersistentBlock.open({...config,create:true});assert(v.fresh);assert.deepEqual(await v.read(8000,32),new Uint8Array(32));
const payload=Uint8Array.from({length:4096},(_,i)=>i*31&255);await v.write(4000,payload);await v.flush();const pinned=await store.read();await v.close();
v=await PersistentBlock.open({...config,expectedHead:pinned});assert(!v.fresh);assert.deepEqual(await v.read(4000,4096),payload);
const competitor=await PersistentBlock.open({...config,expectedHead:pinned});await v.write(70000000,payload);await v.flush();
await competitor.write(80000000,payload);await assert.rejects(()=>competitor.flush(),/compare-and-swap/);
await assert.rejects(()=>PersistentBlock.open({...config,expectedHead:pinned}),/rollback/);
await assert.rejects(()=>PersistentBlock.open({...config,create:true}),/formatted/);
await v.close();v=await PersistentBlock.open(config);assert.deepEqual(await v.read(70000000,4096),payload);
const pageKey=await v.leaf(0);store.objects.get(pageKey)[40]^=1;v.cache.clear();await assert.rejects(()=>v.read(4000,32),/corrupt/);
store.objects.delete(pageKey);await assert.rejects(()=>v.read(4000,32),/missing/);
console.log('Persistent block: untouched creation resume, no reformat after zero-write commit, cross-page write/flush/close/reopen, authenticated sparse holes, corruption/missing rejection, pinned rollback and competing-root CAS fences');
