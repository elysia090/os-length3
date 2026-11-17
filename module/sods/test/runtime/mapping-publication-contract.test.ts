// Counterexamples an optimization must preserve or explicitly exclude. These
// exercise the public File/Mapping embedding contract, not native Linux validity.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, FsError, E, type Mapping} from '../../runtime/linux/fs.ts';

test('run publication can change a later observation in the same backing',()=>{
  const file=new File(new Uint8Array(8)),memory=new Uint8Array(9);
  const first:Mapping={proc:{bytes:memory},start:0,length:8,off:0};
  const shifted:Mapping={proc:{bytes:memory},start:1,length:8,off:0};
  file.map(first);file.map(shifted);memory[0]=1;memory[2]=2;
  // A speculative gather made before publication would capture only offsets 0
  // and 2. Existing per-run show also changes later bytes of first's source.
  const upfront=memory.slice(0,8);
  file.settle(0,8,first);
  assert.deepEqual([...upfront],[1,0,2,0,0,0,0,0]);
  assert.deepEqual([...file.data],[1,1,2,2,2,2,2,2]);
  file.abandon(first);file.abandon(shifted);
});

test('second-run failure leaves first canonical write and its publication visible',()=>{
  class Failing extends File {
    writes=0;
    protected override replaceRange(at:number,bytes:Uint8Array):void {
      if(++this.writes===2)throw new FsError(E.IO);
      super.replaceRange(at,bytes);
    }
  }
  const file=new Failing(new Uint8Array(8));
  const maps:Mapping[]=[0,1].map(()=>({proc:{bytes:new Uint8Array(8)},start:0,length:8,off:0}));
  for(const m of maps)file.map(m);
  maps[0].proc.bytes[0]=1;maps[0].proc.bytes[2]=2;
  const version=file.version;
  assert.throws(()=>file.settle(0,8,maps[0]),(e:unknown)=>e instanceof FsError&&e.errno===E.IO);
  assert.deepEqual([...file.data],[1,0,0,0,0,0,0,0]);
  assert.deepEqual([...maps[1].proc.bytes],[1,0,0,0,0,0,0,0]);
  assert.equal(maps[0].seen![0],1);assert.equal(maps[0].seen![2],0);
  assert.equal(file.version,version+1); // Dirty-page admission invalidates before a publication can partially fail.
  file.settle(0,8,maps[0]);
  assert.equal(file.version,version+2); // Retrying remaining dirt is another invalidating observation, not rollback.
  assert.equal(file.data[2],2);assert.equal(maps[1].proc.bytes[2],2);
  for(const m of maps)file.unmap(m);
});

test('publication callback failure preserves the canonical prefix and invalidates before the callback',()=>{
  const file=new File(new Uint8Array(8)),memory=new Uint8Array(8),failure=new Error('mapping publication failed');
  let reads=0,seenVersion=-1;
  const mapping:Mapping={proc:{get bytes(){
    if(++reads===3){seenVersion=file.version;throw failure;}
    return memory;
  }},start:0,length:8,off:0};
  file.map(mapping);memory[0]=1;memory[2]=2;
  assert.throws(()=>file.settle(),(error:unknown)=>error===failure);
  assert.deepEqual([...file.data],[1,0,0,0,0,0,0,0]);
  assert.deepEqual([...mapping.seen!],[0,0,0,0,0,0,0,0]);
  assert.equal(seenVersion,1);assert.equal(file.version,1);
  file.abandon(mapping);
});

test('nonoverlapping changes from another mapping survive sparse publication',()=>{
  const file=new File(new Uint8Array(8));
  const maps:Mapping[]=[0,1].map(()=>({proc:{bytes:new Uint8Array(8)},start:0,length:8,off:0}));
  for(const m of maps)file.map(m);
  maps[0].proc.bytes[0]=1;maps[1].proc.bytes[2]=2;
  file.settle(0,8,maps[0]); // A whole-page write/show here would erase the second writer.
  assert.equal(maps[1].proc.bytes[2],2);
  file.settle(0,8,maps[1]);
  assert.deepEqual([...file.data],[1,0,2,0,0,0,0,0]);
  for(const m of maps)file.unmap(m);
});
