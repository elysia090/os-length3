import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Description, FdTable, Pipe} from '../../runtime/linux/fd.ts';
import {loadFileScope} from '../../runtime/linux/file-scope.ts';
import '../../runtime/linux.ts';

test('terminal Description release is reentry-safe and continues independent cleanup', () => {
  const pipe=new Pipe(), d=new Description('pipe-rw',{pipe}).retain(), failure=Error('gone'); let calls=0;
  d.gone=()=>{calls++;d.release();throw failure;};
  assert.throws(()=>d.release(),e=>e===failure);
  assert.equal(d.closed,true);assert.equal(d.refs,0);assert.equal(calls,1);
  assert.equal(pipe.readers,0);assert.equal(pipe.writers,0);assert.equal(pipe.changes,2);
  d.release();assert.equal(d.refs,0);assert.equal(calls,1);
});

test('all captured descriptor slots are attempted despite several finalizer failures', () => {
  const table=new FdTable(), failures=[Error('a'),Error('b')], closed:number[]=[];
  for(let i=0;i<3;i++){const d=new Description('file');d.gone=()=>{closed.push(i);if(i<2)throw failures[i];};table.install(d);}
  assert.throws(()=>table.closeAll(),e=>e instanceof AggregateError && e.errors[0]===failures[0] && e.errors[1]===failures[1]);
  assert.deepEqual(closed,[0,1,2]);assert.equal(table.slots.size,0);
  table.closeAll();assert.deepEqual(closed,[0,1,2]);
});

for(const operation of ['closeAll','exec'] as const)test(`${operation} does not retire a replacement installed by an earlier finalizer`,()=>{
  const table=new FdTable(), first=new Description('file'), old=new Description('file'), replacement=new Description('file');
  table.install(first,{fd:3,cloexec:true});table.install(old,{fd:4,cloexec:true});
  first.gone=()=>{table.close(4);table.install(replacement,{fd:4,cloexec:true});};
  table[operation]();assert.equal(old.closed,true);assert.equal(replacement.closed,false);assert.equal(table.get(4),replacement);
  table.closeAll();assert.equal(replacement.closed,true);
});

test('shared table and dup retain Rust inode access until the actual fd owners leave', {skip:!process.env.SODS_FILE_STORE_WASM},async()=>{
  const scope=await loadFileScope(readFileSync(process.env.SODS_FILE_STORE_WASM!),8),vfs=scope.createVfs(),file=vfs.writeFile('/a','payload');
  try{
    const table=new FdTable(), d=new Description('file',{node:file});let calls=0;
    d.gone=()=>{calls++;throw Error('last owner');};
    table.install(d,{fd:3});table.install(d,{fd:4});table.share();
    table.letGo();assert.equal(d.refs,2);assert.equal(d.closed,false);
    table.close(3);assert.equal(d.refs,1);assert.equal(calls,0);
    assert.throws(()=>table.letGo(),/last owner/);assert.equal(d.closed,true);assert.equal(calls,1);assert.equal(table.slots.size,0);
    assert.equal(new TextDecoder().decode(file.bytes()),'payload'); // Namespace/raw owner, not fd-owned destruction.
  }finally{scope.dispose();}
});

test('multiple independent cleanup failures remain visible without suppressing later cleanup',()=>{
  const d=new Description('socket').retain(), gone=Error('gone'), socket=Error('socket');let closed=0;
  d.gone=()=>{throw gone;};
  Object.defineProperty(d,'sock',{value:{close(){closed++;throw socket;}}});
  assert.throws(()=>d.release(),e=>e instanceof AggregateError && e.errors[0]===gone && e.errors[1]===socket);
  assert.equal(closed,1);d.release();assert.equal(closed,1);
});
