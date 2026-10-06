// The completed row must be visible before process EOF, without overwrite.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {progressLog} from './progress-log.mjs';
const temporaryRoot=path.resolve(tmpdir());
const directory=await mkdtemp(path.join(temporaryRoot,'length3-progress-')),file=path.join(directory,'rows.jsonl');
assert.equal(path.dirname(path.resolve(directory)),temporaryRoot);
assert(path.basename(directory).startsWith('length3-progress-'),'exact fresh temporary cleanup scope');
let log;
try{
  log=progressLog(file);const row={status:'running',retired:123,text:'λ / 日本語'};
  log.write(row);assert.deepEqual(JSON.parse((await readFile(file,'utf8')).trim()),row);
  assert.throws(()=>progressLog(file),{code:'EEXIST'});
  log.write({status:'pass'});
  const rows=(await readFile(file,'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows,[row,{status:'pass'}]);
  log.close();log.close();assert.throws(()=>log.write(row),/closed progress log/);
}finally{log?.close();await rm(directory,{recursive:true,force:true});}
console.log('Progress log: live complete UTF-8 rows, append, no-clobber, close/refusal checks green; no guest execution');
