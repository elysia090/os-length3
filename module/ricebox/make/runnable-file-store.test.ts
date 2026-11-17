/** Opt-in local release test. Historical fixtures are not rebuilt or published. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,readdirSync,symlinkSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {openDistribution} from '../deployment/local.ts';
import {validateFileStore,fileStoreDescriptor} from './file-store.ts';
const source=process.env.RICEBOX_RELEASE_DIR,muk=process.env.RICEBOX_MUK_FILE,mukHash=process.env.RICEBOX_MUK_SHA256,core=process.env.SODS_FILE_STORE_WASM;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
test('historical full release runs muk and shell with a release-selected Rust file owner',{skip:!source||!muk||!mukHash||!core},async()=>{
  assert.equal(hash(readFileSync(muk!)),mukHash);
  const sourceRoot=resolve(source!);
  const original=openDistribution(sourceRoot),out=mkdtempSync(join(tmpdir(),'ricebox-runnable-core-'));
  try{
    assert.equal(original.index.fileStore,undefined,'baseline fixture must be a legacy release');
    original.checkAll(); // All pack tables and stored files, not just paths used by this program.
    mkdirSync(join(out,'blobs'));symlinkSync(join(sourceRoot,'packs'),join(out,'packs'),'dir');
    const existingBlobs=new Set(readdirSync(join(sourceRoot,'blobs')));
    for(const name of existingBlobs)symlinkSync(join(sourceRoot,'blobs',name),join(out,'blobs',name));
    const selected=await validateFileStore(readFileSync(core!),0x7fffffff);
    const descriptor=fileStoreDescriptor(selected,bytes=>{const gz=gzipSync(bytes),sha256=hash(gz),path=`blobs/${sha256}.bin`;if(existingBlobs.has(path.slice(6)))assert.deepEqual(readFileSync(join(out,path)),gz);else writeFileSync(join(out,path),gz);return {path,sha256,size:gz.length,bytes:bytes.length};});
    const index={...original.index,fileStore:descriptor},bytes=Buffer.from(JSON.stringify(index)),sha256=hash(bytes),path=`index-${sha256}.json`;
    writeFileSync(join(out,path),bytes);writeFileSync(join(out,'webroot.json'),JSON.stringify({...original.about,index:{path,sha256,size:bytes.length}}));
    const run=(web:string,program:string,args:string[])=>JSON.parse(execFileSync(process.execPath,[fileURLToPath(new URL('runnable.ts',import.meta.url)),'--child',JSON.stringify({web,path:program,args,translator:'',fresh:false,kept:null,muk})],{env:{...process.env,SODS_INLINE:'1'},encoding:'utf8',timeout:60_000,maxBuffer:1<<20}));
    const baseline=run(sourceRoot,'/usr/bin/true',[]);assert.equal(baseline.status,0);assert.equal(baseline.error,null);
    const rust=run(out,'/usr/bin/sh',['-c','printf core-ok']);assert.equal(rust.status,0);assert.equal(rust.stdout,'core-ok');assert.equal(rust.stderr,'');assert.equal(rust.error,null);
    // An obsolete selected index must fail, not run the same root with TS storage.
    const obsolete={...original.index,fileCore:descriptor},oldBytes=Buffer.from(JSON.stringify(obsolete));
    const oldHash=hash(oldBytes),oldPath=`index-${oldHash}.json`;
    writeFileSync(join(out,oldPath),oldBytes);
    writeFileSync(join(out,'webroot.json'),JSON.stringify({...original.about,index:{path:oldPath,sha256:oldHash,size:oldBytes.length}}));
    assert.throws(()=>run(out,'/usr/bin/true',[]),/fileCore is an obsolete selection/);
    // Different commands are functional checks, not a paired performance benchmark.
  }finally{original.close();rmSync(out,{recursive:true,force:true});}
});
