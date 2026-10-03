// Host engine reuse only. No instruction decoder or Linux boot claim.
import assert from 'node:assert/strict';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const emitted = value => Uint8Array.from([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,
  2,19,1,7,109,97,99,104,105,110,101,6,109,101,109,111,114,121,2,0,1,
  3,2,1,0,7,7,1,3,103,101,116,0,0,10,9,1,7,0,65,value,40,2,0,11
]);
const memory = new WebAssembly.Memory({initial:1,maximum:2});
new DataView(memory.buffer).setUint32(0,17,true);
new DataView(memory.buffer).setUint32(4,29,true);
const cache = new CompiledModules({machine:{memory}},{maximumEntries:2,maximumBytes:256});
const source = emitted(0), first = await cache.get(1n,source);
assert.equal(first.exports.get(),17);
assert.equal(await cache.get(1n,source),first);
source[source.length - 5] = 4;
const replacement = await cache.get(1n,source);
assert.notEqual(replacement,first); assert.equal(replacement.exports.get(),29);
source.fill(0); // Caller-arena reuse cannot poison the owned comparison witness.
assert.equal(await cache.get(1n,emitted(4)),replacement);
await cache.get(2n,emitted(0)); await cache.get(3n,emitted(4));
assert.equal(cache.stats().entries,2); assert(cache.stats().retainedModuleBytes <= 256);
assert.notEqual(await cache.get(1n,emitted(4)),replacement,'bounded FIFO eviction');
memory.grow(1);
new DataView(memory.buffer).setUint32(4,37,true);
assert.equal((await cache.get(1n,emitted(4))).exports.get(),37,'same memory object after grow');
const before = cache.stats();
await assert.rejects(cache.get(1n,new Uint8Array(1)),WebAssembly.CompileError);
assert.deepEqual(cache.stats(),before,'invalid emission cannot publish or remove a valid entry');
const tiny = new CompiledModules({machine:{memory}},{maximumEntries:8,maximumBytes:emitted(0).length});
await tiny.get(1,emitted(0)); await tiny.get(2,emitted(4));
assert.equal(tiny.stats().entries,1,'byte quota independent of entry quota');
await assert.rejects(tiny.get(3,new Uint8Array(65537)),RangeError);
const otherMemory = new WebAssembly.Memory({initial:1});
new DataView(otherMemory.buffer).setUint32(0,43,true);
const other = new CompiledModules({machine:{memory:otherMemory}});
assert.equal((await other.get(1n,emitted(0))).exports.get(),43,'Worker owners never share imported memories');
const mutableImports = {machine:{memory}}, pinned = new CompiledModules(mutableImports);
mutableImports.machine.memory = otherMemory;
assert.equal((await pinned.get(1n,emitted(0))).exports.get(),17,'imports are bound at owner construction');
const duplicate = new CompiledModules({machine:{memory}});
await Promise.all([duplicate.get(1n,emitted(0)),duplicate.get(1n,emitted(4))]);
assert.equal(duplicate.stats().entries,1); assert.equal(duplicate.stats().retainedModuleBytes,emitted(0).length);
assert.equal((await duplicate.get(1n,emitted(4))).exports.get(),37,'duplicate pending work keeps exact accounting/body');
const pending = other.get(2n,emitted(4)); other.close();
await assert.rejects(pending,/owner closed/); assert.equal(other.stats().entries,0);
cache.close(); tiny.close(); pinned.close(); duplicate.close();
await assert.rejects(cache.get(1n,emitted(0)),/owner closed/);
assert.equal(cache.stats().retainedModuleBytes,0);
console.log('Bounded emitted-Wasm engine reuse: green (exact body, changed body, arena reuse, FIFO/byte quotas, grow, invalid emission, independent owners, pending close; not Linux boot)');
