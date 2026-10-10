import assert from 'node:assert/strict';
import {CutProgress} from '../../src/v2/vm/check/browser/cut-progress.mjs';
let cases=0;
for(const base of [0,41,214024756])for(const prefix of [0,1,7,64])for(const remainder of [0,1,3]){
  const progress=new CutProgress(base);
  progress.add(prefix,BigInt(prefix*3),BigInt(base+prefix*3),64);
  progress.add(remainder,BigInt(remainder),BigInt(base+prefix*3+remainder),64);
  assert.equal(progress.completed,prefix+remainder);assert.equal(progress.retired,prefix*3+remainder);
  progress.reset(base);assert.equal(progress.completed,0);assert.equal(progress.retired,0);++cases;
}
const invalid=[[-1,0n,0n,1],[2,2n,2n,1],[1,0n,0n,1],[0,1n,1n,1],
  [1,1025n,1025n,1],[1,1n,2n,1],[1,1,1n,1],[0,0n,0n,0]];
for(const args of invalid){
  const progress=new CutProgress(0);assert.throws(()=>progress.add(...args));
  assert.equal(progress.completed,0);assert.equal(progress.retired,0);++cases;
}
const progress=new CutProgress(Number.MAX_SAFE_INTEGER);
assert.throws(()=>progress.add(1,1n,BigInt(Number.MAX_SAFE_INTEGER)+1n,1));
assert.throws(()=>new CutProgress(-1));assert.throws(()=>progress.reset(1.5));
const finalPrefix=new CutProgress(135104112);
finalPrefix.add(63,105n,135104217n,64);
assert.equal(finalPrefix.remaining(64),1);
finalPrefix.add(1,2n,135104219n,1);
assert.equal(finalPrefix.remaining(64),0);assert.equal(finalPrefix.retired,107);
assert.throws(()=>finalPrefix.remaining(63));assert.throws(()=>finalPrefix.remaining(0));
finalPrefix.reset(135104219);assert.equal(finalPrefix.remaining(64),64);
console.log(`Cut prefix accounting: ${cases} bounded prefix/reset/refusal cases plus overflow; not Linux boot`);
