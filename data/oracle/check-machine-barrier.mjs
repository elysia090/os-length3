import assert from 'node:assert/strict';
import {isMachineBarrier} from '../../src/v2/web/machine-barrier.mjs';
for(let reason=0n;reason<=4n;++reason)assert(isMachineBarrier((reason<<3n)|2n));
for(let result=-128n;result<=255n;++result)
  assert.equal(isMachineBarrier(result),[2n,10n,18n,26n,34n].includes(result));
for(const result of [undefined,null,2,'2',{},1n<<63n,(1n<<64n)+34n])assert.equal(isMachineBarrier(result),false);
console.log('ABI4 barrier classification: 396 checks; FERR token34 remains inside the owner loop');
