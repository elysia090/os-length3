import assert from 'node:assert/strict';
import {importStorageMasterKey} from '../../src/v2/web/ciphertext-storage.js';
import {PersistentBlock} from '../../src/v2/web/persistent-block.mjs';

// Isolated durable-store model: only compareAndSwap publishes a new head.
// Faults leave already written ciphertext objects in place, like a lost Worker.
class Store {
  objects=new Map();head=null;puts=0;closed=0;failPut=0;failHead=false;
  constructor(source){if(source){this.head=source.head.slice();for(const [k,b]of source.objects)this.objects.set(k,b.slice());}}
  async get(k){return this.objects.get(k)?.slice()??null;}
  async put(k,b){if(++this.puts===this.failPut)throw new DOMException('isolated store quota','QuotaExceededError');
    if(this.objects.has(k))assert.deepEqual(b,this.objects.get(k));else this.objects.set(k,b.slice());}
  async read(){return this.head?.slice()??null;}
  async compareAndSwap(expected,replacement){if(this.failHead)throw new Error('interrupted before head commit');
    if(expected===null?this.head!==null:!this.head||expected.length!==this.head.length||!expected.every((b,i)=>b===this.head[i]))return false;
    this.head=replacement.slice();return true;}
  close(){++this.closed;}
}
const masterKey=await importStorageMasterKey(new Uint8Array(32).fill(31));
const identity={masterKey,volumeId:new Uint8Array(16).fill(17),volumeSalt:new Uint8Array(32).fill(23),bytes:64*1024*1024};
const payload=seed=>Uint8Array.from({length:4096},(_,i)=>(i*37+seed)&255);
const oldA=payload(5),oldB=payload(7),newA=payload(19),newB=payload(29);
const baseline=new Store();let volume=await PersistentBlock.open({...identity,store:baseline,create:true});
await volume.write(4000,oldA);await volume.write(16*1024*1024,oldB);await volume.close();
const trusted=baseline.head.slice();
async function stage(v){await v.write(4000,newA);await v.write(16*1024*1024,newB);}
async function oldRoot(store){const recovered=await PersistentBlock.open({...identity,store,expectedHead:trusted});
  assert.deepEqual(await recovered.read(4000,4096),oldA);assert.deepEqual(await recovered.read(16*1024*1024,4096),oldB);
  assert.deepEqual(await recovered.read(32*1024*1024,4096),new Uint8Array(4096));await recovered.close();}
const successful=new Store(baseline);volume=await PersistentBlock.open({...identity,store:successful,expectedHead:trusted});
await stage(volume);await volume.flush();const publicationPuts=successful.puts;assert(publicationPuts>=6);await volume.close();

// Quota failure at every object write, including partial directory publication.
for(let at=1;at<=publicationPuts;++at){const store=new Store(baseline);store.failPut=at;
  const v=await PersistentBlock.open({...identity,store,expectedHead:trusted});await stage(v);
  const plaintext=[...v.cache.values(),...v.dirty.values()];assert(plaintext.some(b=>b.some(Boolean)));
  await assert.rejects(v.flush(),{name:'QuotaExceededError'});assert.deepEqual(store.head,trusted);
  await assert.rejects(v.read(4000,16),/failed/);await assert.rejects(v.write(4000,newA),/failed/);
  await assert.rejects(v.close(),/failed/);assert.equal(store.closed,1);
  assert.equal(v.cache.size,0);assert.equal(v.dirty.size,0);assert(plaintext.every(b=>b.every(x=>x===0)));
  await oldRoot(store);
}
// Losing a Worker before flush publishes no dirty bytes at all.
const abandonedStore=new Store(baseline),abandoned=await PersistentBlock.open({...identity,store:abandonedStore,expectedHead:trusted});
await stage(abandoned);assert.deepEqual(abandonedStore.head,trusted);await oldRoot(abandonedStore);
// All objects can be written and the head transaction can still abort.
const abortStore=new Store(baseline);abortStore.failHead=true;
const abort=await PersistentBlock.open({...identity,store:abortStore,expectedHead:trusted});await stage(abort);
await assert.rejects(abort.flush(),/before head commit/);assert.deepEqual(abortStore.head,trusted);
await assert.rejects(abort.close(),/failed/);assert.equal(abortStore.closed,1);await oldRoot(abortStore);
// A quota error first encountered by close retains its original failure for
// concurrent/repeated release callers while disposing plaintext only once.
const closeStore=new Store(baseline);closeStore.failPut=2;
const closeVolume=await PersistentBlock.open({...identity,store:closeStore,expectedHead:trusted});await stage(closeVolume);
const closePlaintext=[...closeVolume.cache.values(),...closeVolume.dirty.values()];
const closes=await Promise.allSettled([closeVolume.close(),closeVolume.close()]);
assert(closes.every(r=>r.status==='rejected'&&r.reason.name==='QuotaExceededError'));
assert.equal(closes[0].reason,closes[1].reason);await assert.rejects(closeVolume.close(),e=>e===closes[0].reason);
assert.equal(closeStore.closed,1);assert.equal(closeVolume.dirty.size,0);assert.equal(closeVolume.cache.size,0);
assert(closePlaintext.every(b=>b.every(x=>x===0)));assert.deepEqual(closeStore.head,trusted);await oldRoot(closeStore);
// A committed head followed by a failed trusted-head notification must not
// silently roll back or claim a successful flush. The old pin rejects reopening.
const notifyStore=new Store(baseline);
const notify=await PersistentBlock.open({...identity,store:notifyStore,expectedHead:trusted,onHead:()=>{throw new Error('trusted head notification failed');}});
await stage(notify);await assert.rejects(notify.flush(),/notification failed/);assert.notDeepEqual(notifyStore.head,trusted);
await assert.rejects(()=>PersistentBlock.open({...identity,store:notifyStore,expectedHead:trusted}),/rollback or replacement/);
await assert.rejects(notify.close(),/failed/);assert.equal(notifyStore.closed,1);
// Corruption never becomes sparse zero-fill. Restoring the exact independently
// retained ciphertext repairs this object; there is no automatic recovery claim.
const damagedStore=new Store(baseline),damaged=await PersistentBlock.open({...identity,store:damagedStore,expectedHead:trusted});
const key=await damaged.leaf(0),retained=baseline.objects.get(key).slice();damagedStore.objects.get(key)[40]^=1;
await assert.rejects(damaged.read(4000,16),/corrupt/);damagedStore.objects.set(key,retained.slice());
assert.deepEqual(await damaged.read(4000,4096),oldA);await damaged.close();await oldRoot(damagedStore);
// A successful close is terminal and repeated cleanup does not close twice.
await volume.close();assert.equal(successful.closed,1);await assert.rejects(volume.read(4000,16),/closed/);
await assert.rejects(volume.write(4000,newA),/closed/);await assert.rejects(volume.flush(),/closed/);
console.log(JSON.stringify({format:'persistent-block-failure-v1',status:'pass',publicationPuts,
  cases:{quotaAtEveryObject:publicationPuts,discardedDirtyOwner:1,headAbort:1,quotaDuringClose:1,notificationFailure:1,corruptObjectWithRetainedCopy:1,terminalClose:1},
  scope:'isolated store faults, exact old-root bytes and plaintext cleanup; not browser quota, ext4 crash recovery or automatic repair'},null,2));
