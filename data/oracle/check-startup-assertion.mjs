// Diagnostic utility checks, not guest ISA or Linux boot evidence.
import assert from 'node:assert/strict';
import {equal} from '../../src/v2/vm/check/browser/assertion.mjs';
for(const value of [0,-0,1,1n,2n**64n-1n,'boot',true,false,null,undefined,Symbol('same')])
  assert.equal(equal(value,value),undefined);
equal(0,-0);
let conversions=0;
const identity={toString(){++conversions;return 'identity';}};
for(let i=0;i<100000;++i)equal(identity,identity);
assert.equal(conversions,0,'a passing comparison must not observe or materialize a string');
const primitive={ [Symbol.toPrimitive](){++conversions;return 'primitive';} };
equal(primitive,primitive);assert.equal(conversions,0);
assert.throws(()=>equal(identity,primitive),{name:'Error',message:'startup: identity != primitive'});
assert.equal(conversions,2,'a failure retains its exact diagnostic conversions');
for(const [actual,expected] of [[1,1n],[NaN,NaN],[false,0],[undefined,null],['a','b']])
  assert.throws(()=>equal(actual,expected),{name:'Error',message:`startup: ${String(actual)} != ${String(expected)}`});
const marker=new Error('conversion fails'),poison={toString(){throw marker;}};
equal(poison,poison);assert.throws(()=>equal(poison,identity),error=>error===marker);
console.log('Startup comparison diagnostics: green (identity/primitive/NaN/type distinctions, no success conversions, exact failure messages and conversion errors; not Linux boot)');
