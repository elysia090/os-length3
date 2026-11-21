import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {standIn} from '../../test/fixtures/distribution.ts';

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
