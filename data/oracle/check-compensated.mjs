// Exact integer rational oracle for the emitted pure numeric SSA. Not Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [directory]=process.argv.slice(2);if(!directory)throw new Error('EMITTED-MODULE-DIRECTORY');
const unit=1150n,mask=(1n<<64n)-1n;let seed=0x7363616c65645f64n,comparisons=0;
function random(){seed^=seed<<13n;seed&=mask;seed^=seed>>7n;seed^=seed<<17n;seed&=mask;return seed|(1n<<63n);}
function scaled(word){const magnitude=word&((1n<<63n)-1n),exponent=(magnitude>>52n)&2047n;
  assert.notEqual(exponent,2047n,'no nonfinite output on normalized finite inputs');
  const fraction=magnitude&((1n<<52n)-1n),sig=exponent?fraction|(1n<<52n):fraction;
  const shift=(exponent?exponent-1023n:-1022n)-52n+unit;
  const value=sig<<shift;return word>>63n?-value:value;}
for(let operation=0;operation<3;++operation){const bytes=await readFile(path.join(directory,`compensated-${operation}.wasm`));
  assert(WebAssembly.validate(bytes));const {instance}=await WebAssembly.instantiate(bytes);assert.equal(instance.exports.compute.length,2);
  for(let row=0;row<16384;++row){let a=random(),b=random();if(row<4){a=row&1?mask:1n<<63n;b=row&2?mask:1n<<63n;}
    const [high,low]=instance.exports.compute(a,b),actual=scaled(BigInt.asUintN(64,high))+scaled(BigInt.asUintN(64,low));
    const numerator=operation===0?a+b:operation===1?a*b:a,denominator=operation===0?1n<<63n:operation===1?1n<<126n:b;
    let error=actual*denominator-(numerator<<unit);if(error<0)error=-error;
    assert(error<=(1n<<(unit-99n))*denominator,`compensated ${operation}/${row} exact dyadic error`);++comparisons;
  }
}
console.log(JSON.stringify({format:'compensated-ssa-rational-v1',status:'pass',comparisons,
  absoluteErrorBound:'2^-99',scope:'normalized finite significand add/multiply/divide; direct emitted Wasm, exact BigInt dyadic oracle',linuxBoot:'not-tested'},null,2));
