import assert from 'node:assert/strict';
import {importStorageMasterKey} from '../../src/v2/web/ciphertext-storage.js';
import {PersistentBlock} from '../../src/v2/web/persistent-block.mjs';
class Store {
  objects=new Map();head=null;abort=false;
  async get(key){return this.objects.get(key)?.slice()??null;}
  async put(key,bytes){if(this.objects.has(key))assert.deepEqual(bytes,this.objects.get(key));else this.objects.set(key,bytes.slice());}
  async read(){return this.head?.slice()??null;}
  async compareAndSwap(expected,next){if(this.abort)throw new Error('system selection aborted');
    if(expected===null?this.head!==null:!this.head||expected.length!==this.head.length||!expected.every((v,i)=>v===this.head[i]))return false;
    this.head=next.slice();return true;}
}
const store=new Store(),systemA='a1'.repeat(32),systemB='b2'.repeat(32);
const config={store,masterKey:await importStorageMasterKey(new Uint8Array(32).fill(71)),
  volumeId:new Uint8Array(16).fill(23),volumeSalt:new Uint8Array(32).fill(37),bytes:32*1048576};
const dataA=new Uint8Array(4096).fill(41),dataB=new Uint8Array(4096).fill(59);
let volume=await PersistentBlock.open({...config,systemRoot:systemA,create:true});
await volume.write(4000,dataA);const stateA=await volume.checkpoint(),revisionA=volume.revision;
assert.deepEqual(await volume.inspectCheckpoint(stateA),{revision:revisionA,systemRoot:systemA});
await volume.selectSystemRoot(systemB);assert.equal(volume.revision,revisionA+1n);
assert.deepEqual(await volume.read(4000,4096),dataA);
await volume.write(4000,dataB);const stateB=await volume.checkpoint();await volume.close();
await assert.rejects(PersistentBlock.open({...config,systemRoot:systemA,expectedHead:stateB}),/system root differs/);
volume=await PersistentBlock.open({...config,systemRoot:systemB,expectedHead:stateB});
assert.deepEqual(await volume.read(4000,4096),dataB);
const before=volume.revision;await volume.restore(stateA);
assert.equal(volume.revision,before+1n);assert.equal(volume.systemRoot,systemA);
assert.deepEqual(await volume.read(4000,4096),dataA);
const restored=await volume.checkpoint();await volume.close();
await assert.rejects(PersistentBlock.open({...config,systemRoot:systemB,expectedHead:restored}),/system root differs/);
volume=await PersistentBlock.open({...config,systemRoot:systemA,expectedHead:restored});
assert.deepEqual(await volume.read(4000,4096),dataA);
await assert.rejects(volume.selectSystemRoot('unqualified-or-invalid-id'),/opaque system/);
assert.deepEqual(await store.read(),restored);
store.abort=true;await assert.rejects(volume.selectSystemRoot(systemB),/selection aborted/);
assert.deepEqual(await store.read(),restored);assert.equal(volume.systemRoot,systemA);
await assert.rejects(volume.close(),/failed/);store.abort=false;
volume=await PersistentBlock.open({...config,systemRoot:systemA,expectedHead:restored});
assert.deepEqual(await volume.read(4000,4096),dataA);await volume.close();
const emptyStore=new Store(),emptyConfig={...config,store:emptyStore,systemRoot:systemA};
volume=await PersistentBlock.open({...emptyConfig,create:true});const emptyHead=await volume.checkpoint();await volume.close();
volume=await PersistentBlock.open({...emptyConfig,expectedHead:emptyHead});assert.equal(volume.fresh,true);await volume.close();
await assert.rejects(PersistentBlock.open({...emptyConfig,systemRoot:systemB,expectedHead:emptyHead}),/system root differs/);
console.log(JSON.stringify({status:'pass',scope:'opaque system identity and data in one authenticated head; publisher approval and Linux compatibility remain Supervisor responsibilities',
  selection:'preserves-committed-data-in-new-sequence',mismatchedBoot:'rejected',rollback:'system-A-and-data-A-in-new-sequence',
  abortedSelection:'retains-current-head-and-system',reopen:'restored-system-and-data'}));
