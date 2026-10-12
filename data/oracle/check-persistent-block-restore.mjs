import assert from 'node:assert/strict';
import {importStorageMasterKey} from '../../src/v2/web/ciphertext-storage.js';
import {PersistentBlock} from '../../src/v2/web/persistent-block.mjs';
class Store {
  objects=new Map();head=null;abort=false;
  async get(key){return this.objects.get(key)?.slice()??null;}
  async put(key,bytes){if(this.objects.has(key))assert.deepEqual(bytes,this.objects.get(key));else this.objects.set(key,bytes.slice());}
  async read(){return this.head?.slice()??null;}
  async compareAndSwap(expected,next){if(this.abort)throw new Error('restore publication aborted');
    if(expected===null?this.head!==null:!this.head||expected.length!==this.head.length||!expected.every((b,i)=>b===this.head[i]))return false;
    this.head=next.slice();return true;}
}
const masterKey=await importStorageMasterKey(new Uint8Array(32).fill(43)),store=new Store();
const config={store,masterKey,volumeId:new Uint8Array(16).fill(19),volumeSalt:new Uint8Array(32).fill(29),bytes:64*1048576};
const a=new Uint8Array(4096).fill(17),b=new Uint8Array(4096).fill(31);
let volume=await PersistentBlock.open({...config,create:true});
const initial=await volume.checkpoint();
await volume.write(4000,a);await volume.write(32*1048576,a);const before=await volume.checkpoint();
const oldLeaf=await volume.leaf(0),oldObject=store.objects.get(oldLeaf).slice();
await volume.write(4000,b);await volume.write(32*1048576,b);const current=await volume.checkpoint(),revision=volume.revision;

// A retained checkpoint with missing or modified bodies is refused before CAS.
store.objects.delete(oldLeaf);
await assert.rejects(volume.restore(before),/missing/);assert.deepEqual(await store.read(),current);
assert.deepEqual(await volume.read(4000,4096),b);
store.objects.set(oldLeaf,oldObject.slice());store.objects.get(oldLeaf)[40]^=1;
await assert.rejects(volume.restore(before),/corrupt/);assert.deepEqual(await store.read(),current);
store.objects.set(oldLeaf,oldObject);
const altered=before.slice();altered[altered.length-1]^=1;
await assert.rejects(volume.restore(altered));assert.deepEqual(await store.read(),current);
await volume.write(8192,b);await assert.rejects(volume.restore(before),/dirty/);
assert.deepEqual(await store.read(),current);await volume.flush();

// Rollback restores all old pages in a NEW head, invalidating cached new bytes.
const oldRevision=volume.revision;await volume.restore(before);
assert.equal(volume.revision,oldRevision+1n);assert(volume.revision>revision);
assert.notDeepEqual(await store.read(),before);assert(!volume.fresh);
assert.deepEqual(await volume.read(4000,4096),a);assert.deepEqual(await volume.read(32*1048576,4096),a);
assert.deepEqual(await volume.read(8192,4096),new Uint8Array(4096));
const restored=await volume.checkpoint();await volume.close();
volume=await PersistentBlock.open({...config,expectedHead:restored});
assert.deepEqual(await volume.read(4000,4096),a);

// Restoring the initially empty snapshot never reauthorizes Linux formatting.
const sequence=volume.revision;await volume.restore(initial);
assert.equal(volume.revision,sequence+1n);assert(!volume.fresh);
await volume.close();volume=await PersistentBlock.open({...config,expectedHead:await store.read()});
assert(!volume.fresh);assert.deepEqual(await volume.read(4000,4096),new Uint8Array(4096));

// A failed publication retains the current durable envelope exactly.
const retained=await volume.checkpoint();store.abort=true;
await assert.rejects(volume.restore(before),/publication aborted/);assert.deepEqual(await store.read(),retained);
await assert.rejects(volume.close(),/failed/);store.abort=false;
volume=await PersistentBlock.open({...config,expectedHead:retained});
assert.deepEqual(await volume.read(4000,4096),new Uint8Array(4096));
const futureStore=new Store();futureStore.head=retained.slice();
for(const [key,bytes]of store.objects)futureStore.objects.set(key,bytes.slice());
const future=await PersistentBlock.open({...config,store:futureStore,expectedHead:retained});
await future.write(4000,b);const futureHead=await future.checkpoint();await future.close();
await assert.rejects(volume.restore(futureHead),/ahead/);assert.deepEqual(await store.read(),retained);
const competitor=await PersistentBlock.open({...config,expectedHead:retained});
await competitor.write(4000,b);const competingHead=await competitor.checkpoint();
await assert.rejects(volume.restore(before),/compare-and-swap/);assert.deepEqual(await store.read(),competingHead);
await assert.rejects(volume.close(),/failed/);await competitor.close();
console.log(JSON.stringify({status:'pass',scope:'physical checkpoint restore; software selection and data compatibility not certified',
  missingObjects:'retained-current-head',corruptObjects:'retained-current-head',tamperedEnvelope:'rejected',
  dirtyWrites:'refused',restore:'old-bytes-in-new-sequence',cache:'invalidated',emptyRestore:'no-reformat',
  abortedPublication:'retained-current-head',futureCheckpoint:'rejected',competingWriter:'retained-competing-head',reopen:'exact-restored-bytes'}));
