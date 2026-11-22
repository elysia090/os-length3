import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setImmediate} from 'node:timers/promises';
import {standIn} from '../../test/fixtures/distribution.ts';
import {readTarball} from '../../host/node/tar.ts';

test('explicit missing hot program fails the actual producer without publishing output',{timeout:35000},()=>{
  const work=mkdtempSync(join(tmpdir(),'ricebox-build-failure-'));
  try{
    const root=standIn(work,'9.9.9'),output=join(work,'output');
    // A bounded hang check, not a startup-time performance assertion.
    const r=spawnSync(process.execPath,[fileURLToPath(new URL('../distribution.ts',import.meta.url)),root,output,'--hot','/missing'],{encoding:'utf8',timeout:30000});
    assert.equal(r.error,undefined,r.stderr);
    assert.equal(r.status,1,r.stderr);
    assert.match(r.stderr,/\/missing is not a file of this root/);
    assert.equal(existsSync(output),false);
  }finally{rmSync(work,{recursive:true,force:true});}
});

test('archive reading stops at a pending visitor and preserves its rejection', {timeout: 10000}, async () => {
  const work = mkdtempSync(join(tmpdir(), 'ricebox-archive-visit-'));
  try {
    const archive = standIn(work, '9.9.9'), failed = new Error('visitor stopped');
    const reached = Promise.withResolvers<void>(), admission = Promise.withResolvers<void>();
    let visited = 0;
    const collected = readTarball(archive, () => {
      visited++;
      reached.resolve();
      return admission.promise;
    });
    const rejected = assert.rejects(collected, error => error === failed);
    try {
      await reached.promise;
      await setImmediate();
      assert.equal(visited, 1, 'no next body while the producer is backpressured');
    } finally { admission.reject(failed); await rejected; }
    assert.equal(visited, 1);
  } finally { rmSync(work, {recursive: true, force: true}); }
});
