import assert from 'node:assert/strict';
import {StampedCode,sourceStampHash} from '../../src/v2/web/stamped-code.mjs';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const wasm=tag=>Uint8Array.from([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,99,117,116,0,0,10,6,1,4,0,65,7,11,0,3,1,120,tag]);
const key=(entry=0,owner=4096,revision=1)=>Uint32Array.of(entry,1024,9,0,1,0,owner,revision,0,0);
const value=instance=>({instance,bytes:wasm(0).length,sourceBytes:3,instructions:1,binding:0});
let memo;const compiled=new CompiledModules({}, {maximumEntries:8,maximumBytes:1024,onEvict:i=>memo.discardInstance(i)});
memo=new StampedCode({maximumEntries:4,maximumBytes:256,maximumAliases:2,maximumPages:16,retain:i=>compiled.retain(i),release:i=>compiled.release(i)});
const a=await compiled.get(wasm(0)),b=await compiled.get(wasm(1));
const first=key();memo.put(first,value(a));first[0]=9;assert.equal(memo.get(key()).instance,a,'key snapshot is owned');assert.equal(memo.get(key(9)),null);
memo.put(key(1),value(a));assert.equal(memo.put(key(2),value(a)),false,'alias cap skips without phantom retain');assert.equal(compiled.stats().referencedEntries,1);assert.equal(memo.stats().entries,2);
memo.put(key(3,8192),value(b));assert.equal(memo.get(key(3,8192)).instance.exports.cut(),7);
assert.equal(memo.get(key(0,4096,2)),null);assert.equal(memo.stats().revisionDrops,2);assert.equal(memo.stats().entries,1);assert.equal(compiled.stats().referencedEntries,1);
assert.equal(memo.get(key(0,4096,1)),null,'old revision does not become current again');assert.equal(memo.put(key(0,4096,1),value(a)),false);assert.equal(compiled.stats().referencedEntries,1,'stale put rolls acquired body back');
memo.put(key(0,4096,2),value(a));const old=value(a);assert.throws(()=>memo.put(key(0,4096,2),{...old,binding:1}),/immutable/);
const changedBudget=key(0,4096,2);changedBudget[1]=1;assert.equal(memo.get(changedBudget),null,'budget is part of receipt');memo.put(changedBudget,value(a));
const scope=key(4,12288);scope[4]=2;memo.put(scope,value(b));assert.equal(memo.stats().entries,1);assert(memo.stats().scopeDrops>=2);assert.equal(compiled.stats().referencedEntries,1);
const bad=key(0,12288);bad[6]=4097;const before=memo.stats();assert.throws(()=>memo.put(bad,value(a)),RangeError);assert.deepEqual(memo.stats(),before);
const foreign=new WebAssembly.Instance(new WebAssembly.Module(wasm(2))),foreignKey=scope.slice();foreignKey[7]=2;assert.throws(()=>memo.put(foreignKey,value(foreign)),/body owner/);assert.deepEqual(memo.stats(),before,'foreign handle cannot prune or evict');
const shared=new Uint32Array(new SharedArrayBuffer(40));shared.set(scope);assert.throws(()=>memo.get(shared),RangeError);
// An actual hash collision: invert the odd FNV multiplier before avalanche.
const rawHash=words=>{let h=2166136261;for(const w of words)h=Math.imul(h^w,16777619);return h>>>0;};
const ca=Uint32Array.of(1,1024,9,0,3,0,4096,1,8192,1),cb=ca.slice();cb[0]=2;
let prefix=2166136261;for(let i=0;i<9;i++)prefix=Math.imul(prefix^cb[i],16777619);
cb[9]=(prefix^Math.imul(rawHash(ca),899433627))>>>0;assert(cb[9]&&cb[9]!==0xffffffff);assert.equal(sourceStampHash(ca),sourceStampHash(cb));
// Different second-page owners avoid treating the deliberately colliding
// revisions as the same currently-written physical page.
const collision=new StampedCode({maximumEntries:4,maximumBytes:256,maximumAliases:4,maximumPages:16});
collision.put(ca,value(a));cb[8]=12288;prefix=2166136261;for(let i=0;i<9;i++)prefix=Math.imul(prefix^cb[i],16777619);cb[9]=(prefix^Math.imul(rawHash(ca),899433627))>>>0;
assert.equal(sourceStampHash(ca),sourceStampHash(cb));collision.put(cb,value(b));assert.equal(collision.get(ca).instance,a);assert.equal(collision.get(cb).instance,b);
assert.equal(collision.stats().entries,2,'hash is only a prefilter');collision.close();
// A self-evicted incoming alias reacquires exactly one body reference.
let narrow;const bodies=new CompiledModules({}, {maximumEntries:2,maximumBytes:256,onEvict:i=>narrow.discardInstance(i)});
narrow=new StampedCode({maximumEntries:1,maximumBytes:256,maximumAliases:1,maximumPages:16,retain:i=>bodies.retain(i),release:i=>bodies.release(i)});
const single=await bodies.get(wasm(0));for(let i=0;i<200;i++){const k=key(i%4096);k[4]=i+1;narrow.put(k,value(single));assert.equal(narrow.stats().entries,1);assert.equal(bodies.stats().referencedEntries,1);}
narrow.close();assert.equal(bodies.stats().referencedEntries,0);bodies.close();memo.close();assert.equal(memo.stats().metadataBytes,0);assert.equal(memo.stats().watchLinks,0);assert.equal(compiled.stats().referencedEntries,0);compiled.close();
assert.throws(()=>memo.get(key()),/closed/);
console.log(JSON.stringify({status:'pass',scope:'full source stamp, real prefilter collision, alias cap, revision/scope/budget separation, foreign/shared refusals, exact paired release, metadata close; no guest execution claim'}));
