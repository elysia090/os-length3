import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {bundle} from '../programs.ts';
import {table} from '../commands.ts';

test('comparison helpers import without launching a CLI and preserve OCI bundle inputs',()=>{
  const config=JSON.parse(bundle('/fixture/root',['/usr/bin/sh','-c','printf ok'],['LANG=C'],123,456));
  assert.deepEqual(config.process.args,['/usr/bin/sh','-c','printf ok']);
  assert.deepEqual(config.root,{path:'/fixture/root',readonly:true});
  assert.deepEqual(config.linux.uidMappings,[{containerID:0,hostID:123,size:1}]);
  assert.deepEqual(config.linux.gidMappings,[{containerID:0,hostID:456,size:1}]);
});

test('the recorded command table names its current verifier without regenerating evidence',()=>{
  const recorded=readFileSync(new URL('../../etc/length3/commands',import.meta.url),'utf8');
  const generated=table(new Map(),[]);
  assert.equal(generated.split('\n')[0],recorded.split('\n')[0]);
  assert.match(generated,/ricebox\/distribution\/verification\/commands\.ts/);
});
