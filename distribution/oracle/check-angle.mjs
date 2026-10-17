// Exact integer/dyadic reference for emitted SSA, not guest execution.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [directory]=process.argv.slice(2);if(!directory)throw new Error('EMITTED-MODULE-DIRECTORY');
const bytes=await readFile(path.join(directory,'angle.wasm'));assert(WebAssembly.validate(bytes));
const {instance}=await WebAssembly.instantiate(bytes),unit=1150n,mask=(1n<<64n)-1n,P=0x3243f6a8885a308d3n;
let seed=0x5150495f72616e6bn,comparisons=0;
function random(){seed^=seed<<13n;seed&=mask;seed^=seed>>7n;seed^=seed<<17n;seed&=mask;return seed|(1n<<63n);}
function scaled(word){word=BigInt.asUintN(64,word);const exponent=(word>>52n)&2047n;
  assert.notEqual(exponent,2047n);const sig=(word&((1n<<52n)-1n))|(exponent?1n<<52n:0n);
  const value=sig<<((exponent?exponent-1023n:-1022n)-52n+unit);return word>>63n?-value:value;}
for(let exponent=-1;exponent<63;++exponent)for(let row=0;row<4096;++row){let sig=random();
  if(row<4)sig=row&1?mask:1n<<63n;
  const N=sig<<BigInt(exponent+2);let q=N/P,r=N%P;const reverse=r>P/2n;if(reverse){++q;r=P-r;}
  const [quadrant,high,low,negative,a,b]=instance.exports.compute(sig,BigInt(exponent)).map(x=>BigInt.asUintN(64,x));
  assert.equal(quadrant,q&3n);assert.equal(high,r>>64n);assert.equal(low,r&mask);assert.equal(negative,reverse?1n:0n);
  assert.equal(scaled(a)+scaled(b),(reverse?-r:r)<<(unit-65n));++comparisons;
}
console.log(JSON.stringify({format:'angle-ssa-rational-v1',status:'pass',comparisons,
  exponentRange:[-1,62],residual:'exact nearest Pi/2 dyadic, architectural 66-bit Pi',
  scope:'normalized significands; integer quadrant/residual and both binary64 lanes checked exactly; emitted Wasm',linuxBoot:'not-tested'},null,2));
