import assert from 'node:assert/strict';
import {checkParallelReceipt} from './check-browser-parallel-receipt.mjs';
const good=['start one 11','start two 12','start three 13','start four 14',
  'compile one 0','compile three 0','end three 0','compile two 0','end one 0',
  'end two 0','compile four 0','end four 0','browser-four-compilers:pass',
  'browser-multisource-link:pass','browser-parallel-products:/workspace/parallel-build.ABC123',
  'expanded-build-final-exit:0',''].join('\n');
assert.equal(checkParallelReceipt(good).maximumLive,4);
assert.equal(checkParallelReceipt(good.replaceAll('\n','\r\n')).targets,4);
for(const [from,to] of [['start two 12','start two 11'],['compile one 0','compile one 1'],
  ['end four 0','end four 7'],['start four 14','compile four 0'],
  ['compile two 0','compile one 0'],['end two 0','end one 0'],
  ['browser-multisource-link:pass','browser-multisource-link:fail'],
  ['expanded-build-final-exit:0','expanded-build-final-exit:148'],
  ['browser-parallel-products:/workspace/parallel-build.ABC123','browser-parallel-products:/tmp/build']])
  assert.throws(()=>checkParallelReceipt(good.replace(from,to)),from);
console.log('parallel receipt checker: two positive and nine negative witnesses; not Linux execution');
