import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {Vfs,FsError,E,type Mapping} from '../../runtime/linux/fs.ts';
import {loadFileScope} from '../../runtime/linux/file-scope.ts';
const wasm=process.env.SODS_FILE_STORE_WASM;

test('Rust resident publication preserves alias observation order',{skip:!wasm},async()=>{
  const scope=await loadFileScope(readFileSync(wasm!),8),vfs=new Vfs(),file=scope.writeFile(vfs,'/a',new Uint8Array(8));
  const memory=new Uint8Array(9),a:Mapping={proc:{bytes:memory},start:0,length:8,off:0},b:Mapping={proc:{bytes:memory},start:1,length:8,off:0};
  try {
    file.map(a);file.map(b);memory[0]=1;memory[2]=2;file.settle(0,8,a);
    file.abandon(a);file.abandon(b);
    assert.deepEqual([...file.bytes()],[1,1,2,2,2,2,2,2]);
  } finally {file.abandon(a);file.abandon(b);scope.dispose();}
});
test('injected second core write failure preserves first publication and source retirement',{skip:!wasm},async()=>{
  // A boundary failure injection, not an induced allocator OOM. No other
  // scenario may compile a scope concurrently while Instance is replaced.
  const Original=WebAssembly.Instance;let writes=0;
  class Failing extends Original {
    private wrapped?:WebAssembly.Exports;
    override get exports():WebAssembly.Exports {
      const raw=super.exports;
      return this.wrapped??= {...raw,files_write:(...args:number[])=>++writes===2?-3:(raw.files_write as (...a:number[])=>number)(...args)};
    }
  }
  let scope:Awaited<ReturnType<typeof loadFileScope>>;
  try {WebAssembly.Instance=Failing;scope=await loadFileScope(readFileSync(wasm!),8);}
  finally {WebAssembly.Instance=Original;}
  const vfs=new Vfs(),file=scope.lazyFile(vfs,'/a',()=>new Uint8Array(8));file.materialize();
  const maps:Mapping[]=[0,1].map(()=>({proc:{bytes:new Uint8Array(8)},start:0,length:8,off:0}));
  try {
    for(const m of maps)file.map(m);maps[0].proc.bytes[0]=1;maps[0].proc.bytes[2]=2;
    const version=file.version;
    assert.throws(()=>file.settle(0,8,maps[0]),(e:unknown)=>e instanceof FsError&&e.errno===E.NOSPC);
    assert.deepEqual([...maps[1].proc.bytes],[1,0,0,0,0,0,0,0]);
    assert.equal(maps[0].seen![0],1);assert.equal(maps[0].seen![2],0);
    assert.equal(file.version,version+1);assert.equal(vfs.loaded.files.size,0);
    // Abandon before inspecting canonical bytes so inspection does not retry
    // publication and conceal the retained failure prefix.
    for(const m of maps)file.abandon(m);
    assert.deepEqual([...file.bytes()],[1,0,0,0,0,0,0,0]);assert.equal(file.release(),0);
  } finally {for(const m of maps)file.abandon(m);scope.dispose();}
});

test('Rust publication failure does not start the following run',{skip:!wasm},async()=>{
  const scope=await loadFileScope(readFileSync(wasm!),8),vfs=new Vfs(),file=scope.writeFile(vfs,'/a',new Uint8Array(8));
  let refuse=false;const backing=new Uint8Array(8),proc={get bytes(){if(refuse)throw Error('publication refused');return backing;}};
  const first:Mapping={proc:{bytes:new Uint8Array(8)},start:0,length:8,off:0},second:Mapping={proc,start:0,length:8,off:0};
  try {
    file.map(first);file.map(second);first.proc.bytes[0]=1;first.proc.bytes[2]=2;refuse=true;
    const version=file.version;
    assert.throws(()=>file.settle(0,8,first),/publication refused/);
    assert.equal(file.version,version+1); // Failure cannot retain the old executable source identity.
    file.abandon(first);file.abandon(second);
    assert.deepEqual([...file.bytes()],[1,0,0,0,0,0,0,0]);
    assert.equal(backing[0],0);assert.equal(first.seen![0],1);
  } finally {file.abandon(first);file.abandon(second);scope.dispose();}
});
