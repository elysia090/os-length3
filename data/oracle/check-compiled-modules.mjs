// Exact bounded topology ownership only; no source admission or Linux boot.
import assert from 'node:assert/strict';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const emitted=(value,suffix=[])=>Uint8Array.from([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,
  2,19,1,7,109,97,99,104,105,110,101,6,109,101,109,111,114,121,2,0,1,
  3,2,1,0,7,7,1,3,103,101,116,0,0,10,9,1,7,0,65,value,40,2,0,11,
  ...(suffix.length?[0,suffix.length+2,1,120,...suffix]:[])
]);
const memory=new WebAssembly.Memory({initial:1,maximum:2});
let data=new DataView(memory.buffer);
data.setUint32(0,17,true);data.setUint32(4,29,true);data.setUint32(8,53,true);
const cache=new CompiledModules({machine:{memory}},{maximumEntries:2,maximumBytes:256});
const arena=emitted(0),first=await cache.get(arena);
assert.equal(first.exports.get(),17);assert.equal(await cache.get(arena),first);
arena[arena.length-5]=4;
const changed=await cache.get(arena);
assert.notEqual(changed,first);assert.equal(changed.exports.get(),29);
arena.fill(0);assert.equal(await cache.get(emitted(4)),changed,'caller reuse cannot corrupt witness');
await cache.get(emitted(8));assert.equal(cache.demand(first),false,'evicted witness cannot be resurrected');
assert.equal(await cache.get(emitted(4)),changed);
assert.notEqual(await cache.get(emitted(0)),first);
assert.equal(cache.stats().compilations,4);assert.equal(cache.stats().quotaEvictions,2);
memory.grow(1);data=new DataView(memory.buffer);data.setUint32(4,37,true);
assert.equal((await cache.get(emitted(4))).exports.get(),37,'same object/instance after grow');
const before=cache.stats();
await assert.rejects(cache.get(new Uint8Array(1)),WebAssembly.CompileError);
assert.deepEqual(cache.stats(),before,'invalid bytes cannot change a valid owner');
await assert.rejects(cache.get(1n,emitted(0)),RangeError,'obsolete coordinate-key API is not a fallback');
await assert.rejects(cache.get(new Uint8Array(new SharedArrayBuffer(16))),RangeError);
assert.deepEqual(cache.stats(),before,'shared source cannot race the immutable witness');

// Distinct table placements use the same opaque instance. C separately owns
// binding/admission; the host owner does not receive or invent a coordinate.
const placed=new CompiledModules({machine:{memory}});
const shared=await placed.get(emitted(0)),table=new WebAssembly.Table({element:'anyfunc',initial:3});
table.set(1,shared.exports.get);table.set(2,(await placed.get(emitted(0))).exports.get);
assert.equal(table.get(1),table.get(2));assert.equal(table.get(1)(),17);
assert.equal(placed.stats().compilations,1);
table.set(1,null);table.set(2,null);placed.close();

// A real 32-bit prefilter collision has different executable constants.
// The eight-byte custom payloads make both modules valid, with hash 867302654.
// Full witness equality, not this host index, must choose the instance.
const collisionA=emitted(0,[135,63,22,19,86,176,57,54]);
const collisionB=emitted(4,[145,52,254,190,160,57,13,29]);
const collision=new CompiledModules({machine:{memory}});
const ca=await collision.get(collisionA),cb=await collision.get(collisionB);
assert.equal(collision.buckets.get(867302654).size,2,'actual equal prefilter, distinct exact witnesses');
assert.notEqual(ca,cb);assert.equal(ca.exports.get(),17);assert.equal(cb.exports.get(),37);
assert.equal(await collision.get(collisionA),ca);assert.equal(await collision.get(collisionB),cb);
assert.equal(collision.stats().compilations,2);collision.close();

const tiny=new CompiledModules({machine:{memory}},{maximumEntries:8,maximumBytes:emitted(0).length});
const discarded=await tiny.get(emitted(0));await tiny.get(emitted(4));
assert.equal(tiny.stats().entries,1);assert.equal(tiny.stats().quotaEvictions,1);
assert.equal(tiny.demand(discarded),false);await assert.rejects(tiny.get(new Uint8Array(65537)),RangeError);
for(const quota of [{maximumEntries:2,maximumBytes:256},
                   {maximumEntries:8,maximumBytes:emitted(0).length+emitted(4,[1]).length}]) {
  for(const byDemand of [false,true]) {
    const owner=new CompiledModules({machine:{memory}},quota),hot=await owner.get(emitted(0));
    for(let cold=1;cold<=32;++cold) {
      await owner.get(emitted(4,[cold]));
      if(byDemand)assert.equal(owner.demand(hot),true);
      else assert.equal(await owner.get(emitted(0)),hot);
      assert(owner.stats().entries<=quota.maximumEntries);
      assert(owner.stats().retainedModuleBytes<=quota.maximumBytes);
    }
    assert.equal(owner.stats().compilations,33);assert.equal(owner.stats().quotaEvictions,31);
    assert.equal(owner.stats().hits,byDemand?0:32);
    assert.equal(owner.stats().validatedDemands,byDemand?32:0);
    const unchanged=owner.stats();
    assert.equal(owner.demand(first),false,'foreign owner is not a lifetime witness');
    assert.deepEqual(owner.stats(),unchanged);
    owner.close();assert.throws(()=>owner.demand(hot),/owner closed/);
    assert.equal(owner.stats().retainedModuleBytes,0);
  }
}

const otherMemory=new WebAssembly.Memory({initial:1});
new DataView(otherMemory.buffer).setUint32(0,43,true);
const other=new CompiledModules({machine:{memory:otherMemory}});
assert.equal((await other.get(emitted(0))).exports.get(),43,'imports never cross Worker owners');
const mutable={machine:{memory}},pinned=new CompiledModules(mutable);
mutable.machine.memory=otherMemory;
assert.equal((await pinned.get(emitted(0))).exports.get(),17,'imports pinned at construction');
const scheduledCompile=WebAssembly.compile;
let scheduled=0;
WebAssembly.compile=async()=>{++scheduled;throw new Error('unexpected asynchronous tiny construction');};
try {
  const inline=new CompiledModules({machine:{memory}});
  assert.equal((await inline.get(emitted(0))).exports.get(),17);
  assert.equal(scheduled,0);inline.close();
} finally {WebAssembly.compile=scheduledCompile;}
const duplicate=new CompiledModules({machine:{memory}});
const twins=await Promise.all([duplicate.get(emitted(0)),duplicate.get(emitted(0))]);
assert.equal(twins[0],twins[1]);assert.equal(duplicate.stats().compilations,1);
assert.equal(duplicate.stats().hits,1);assert.equal(duplicate.stats().retainedModuleBytes,emitted(0).length);
await Promise.all([duplicate.get(emitted(4)),duplicate.get(emitted(8))]);
assert.equal(duplicate.stats().entries,3);assert.equal(duplicate.stats().compilations,3);
const pending=other.get(emitted(4));other.close();
await assert.rejects(pending,/owner closed/);assert.equal(other.stats().entries,0);
const originalModule=WebAssembly.Module,cancelledOwner=new CompiledModules({machine:{memory}});
let constructions=0;
WebAssembly.Module=function(bytes){++constructions;return new originalModule(bytes);};
try {
  const cancelled=cancelledOwner.get(emitted(0));cancelledOwner.close();
  await assert.rejects(cancelled,/owner closed/);assert.equal(constructions,0);
} finally {WebAssembly.Module=originalModule;}
const arenaOwner=new CompiledModules({machine:{memory}}),borrowed=emitted(0);
const snapshot=arenaOwner.get(borrowed);borrowed.fill(0);
assert.equal((await snapshot).exports.get(),17,'snapshot before cancellation yield');
const badLink=new CompiledModules({machine:{}}),linkBefore=badLink.stats();
await assert.rejects(badLink.get(emitted(0)),WebAssembly.LinkError);
assert.deepEqual(badLink.stats(),linkBefore);
assert.throws(()=>new CompiledModules({}, {maximumModuleBytes:65537}),RangeError);
for(const owner of [cache,tiny,pinned,duplicate,arenaOwner,badLink])owner.close();
await assert.rejects(cache.get(emitted(0)),/owner closed/);
console.log('Exact bounded topology owner: green (shared instances/placements, real hash collision with distinct results, changed bytes, immutable arena/grow, LRU/byte quotas, demand/eviction, independent imports, duplicate pending work, cancellation/refusals; no coordinate-key or guest fallback, not Linux boot)');
