// Exact emitted body ownership and source-reference lifetime, not Linux boot.
import assert from 'node:assert/strict';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
import {PreparedCode} from '../../src/v2/web/prepared-code.mjs';
const bytes=(tag=0)=>Uint8Array.from([
  0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,
  7,7,1,3,99,117,116,0,0,10,6,1,4,0,65,7,11,
  0,3,1,120,tag,
]);
const metadata=(instance)=>({instance,bytes:bytes().length,sourceBytes:3,instructions:1,binding:0});
function owners(maximumEntries,maximumBytes=bytes().length*maximumEntries){
  let prepared;
  const compiled=new CompiledModules({}, {maximumEntries,maximumBytes,
    onEvict:instance=>prepared.discardInstance(instance)});
  prepared=new PreparedCode({maximumEntries:8,maximumBytes,
    retain:instance=>compiled.retain(instance),release:instance=>compiled.release(instance)});
  return {compiled,prepared,close(){prepared.close();compiled.close();}};
}
const pair=owners(3),kept=await pair.compiled.get(bytes());
pair.prepared.put('source/0',metadata(kept));
pair.prepared.put('source/1',metadata(kept));
for(let tag=1;tag<=64;++tag){
  await pair.compiled.get(bytes(tag));
  assert(pair.compiled.stats().entries<=3);
  assert(pair.compiled.stats().retainedModuleBytes<=bytes().length*3);
}
assert.equal(await pair.compiled.get(bytes()),kept,
  'a source-retained body must not lose its exact index to unrelated cold bodies');
assert.equal(pair.compiled.stats().compilations,65);
assert.equal(pair.prepared.get('source/0').instance,kept);
assert.equal(pair.prepared.stats().bodies,1);
pair.prepared.discard('source/0');
assert.equal(pair.compiled.stats().referencedEntries,1,'the second source still owns this body');
pair.prepared.discard('source/1');
assert.equal(pair.compiled.stats().referencedEntries,0);
for(let tag=65;tag<=68;++tag)await pair.compiled.get(bytes(tag));
assert.equal(pair.compiled.demand(kept),false,'released references cannot resurrect an evicted index');
pair.close();

// Source-key pressure can evict the last alias of the same incoming body.
// Its owner reference must be acquired again, exactly once, with no quota rise.
let narrow;
const narrowBodies=new CompiledModules({}, {maximumEntries:2,maximumBytes:bytes().length*2,
  onEvict:instance=>narrow.discardInstance(instance)});
narrow=new PreparedCode({maximumEntries:1,maximumBytes:bytes().length,
  retain:instance=>narrowBodies.retain(instance),release:instance=>narrowBodies.release(instance)});
const narrowInstance=await narrowBodies.get(bytes());
for(let key=0;key<32;++key)narrow.put(String(key),metadata(narrowInstance));
assert.equal(narrow.stats().entries,1);assert.equal(narrowBodies.stats().referencedEntries,1);
assert.equal(narrowBodies.entries.keys().next().value.references,1);
narrow.close();assert.equal(narrowBodies.stats().referencedEntries,0);narrowBodies.close();

// When all bodies are referenced, the same hard quota still wins. Eviction
// removes every dependent source reference, not only one coordinate alias.
for(const quota of [{entries:2,bytes:bytes().length*2},{entries:8,bytes:bytes().length*2}]){
  const p=owners(quota.entries,quota.bytes),a=await p.compiled.get(bytes(1));
  p.prepared.put('a/0',metadata(a));p.prepared.put('a/1',metadata(a));
  const b=await p.compiled.get(bytes(2));p.prepared.put('b',metadata(b));
  const c=await p.compiled.get(bytes(3));
  assert.equal(p.prepared.get('a/0'),null);assert.equal(p.prepared.get('a/1'),null);
  assert.equal(p.prepared.get('b').instance,b);assert.equal(p.compiled.demand(a),false);
  assert.equal(a.exports.cut(),7,'the independent admitted table handle is not mutated by index eviction');
  p.prepared.put('c',metadata(c));
  assert.equal(p.prepared.stats().bodies,2);assert.equal(p.compiled.stats().referencedEntries,2);
  assert.equal(p.compiled.stats().retainedModuleBytes,bytes().length*2);
  const foreign=new WebAssembly.Instance(new WebAssembly.Module(bytes(4))),before=p.prepared.stats();
  assert.throws(()=>p.prepared.put('foreign',metadata(foreign)),/body owner/);
  assert.deepEqual(p.prepared.stats(),before,'foreign handles cannot change coordinate ownership');
  p.close();assert.equal(p.compiled.stats().referencedEntries,0);assert.equal(p.prepared.stats().bodies,0);
}
console.log(JSON.stringify({status:'pass',coldBodies:64,retainedBodyCompilations:1,
  scope:'one exact bounded byte owner; coordinated source aliases, entry/byte quota pressure, foreign-handle refusal and release; no execution authority or browser-speed claim'}));
