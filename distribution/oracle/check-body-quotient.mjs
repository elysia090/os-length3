// Ordinary Wasm structure oracle only; not a product guest/metadata reader.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [file,expected='1']=process.argv.slice(2);if(!file)throw new Error('MODULE.wasm [EXPECTED-BODIES]');
const bytes=await readFile(file);let at=8,functions,codeBodies,exports;
function uleb(){let value=0,shift=0,byte;do{assert(at<bytes.length && shift<=28);byte=bytes[at++];value+=(byte&127)*2**shift;shift+=7;}while(byte&128);return value;}
while(at<bytes.length){const id=bytes[at++],length=uleb(),end=at+length;assert(end<=bytes.length);
  if(id===3)functions=uleb();if(id===10)codeBodies=uleb();if(id===7)exports=uleb();at=end;}
assert.equal(exports,130,'all source exports survive');assert.equal(functions,Number(expected),'exact body quotient, not source export population');
assert.equal(codeBodies,Number(expected));assert(WebAssembly.validate(bytes));
console.log(JSON.stringify({status:'pass',functions,codeBodies,exports,bytes:bytes.length,linuxBoot:'not-tested'}));
