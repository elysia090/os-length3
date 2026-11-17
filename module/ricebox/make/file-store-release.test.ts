import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {zstdCompressSync} from 'node:zlib';
import {openWeb} from './tree.ts';
import {releaseFileStore} from '../runtime/file-store.ts';
import {prepareTree} from '../runtime/prepared-tree.ts';
const core=process.env.SODS_FILE_STORE_WASM,translator=process.env.SODS_TRANSLATOR_WASM;
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function tarFile(name:string,text:string){
  const bytes=Buffer.from(text),header=Buffer.alloc(512);header.write(name);
  header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
  header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);
  header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);
  const sum=header.reduce((n,b)=>n+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  return Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512)]);
}
test('layers CLI builds a coherent core release that selects Rust without caller override',{skip:!core||!translator},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ricebox-core-release-'));
  try{
    const tar=Buffer.concat([tarFile('root/etc/os-release','NAME=fixture\nVERSION_ID=0.0.1\n'),tarFile('root/hello','hello\n'),Buffer.alloc(1024)]);
    const archive=zstdCompressSync(tar),path=join(dir,`fixture-0.0.1-x86_64-${hash(archive)}.tar.zst`),out=join(dir,'web');writeFileSync(path,archive);
    execFileSync(process.execPath,[fileURLToPath(new URL('layers.ts',import.meta.url)),path,out,'--translator',translator!,'--hot',',','--file-store',core!,'--file-store-limit','8192'],{stdio:'pipe'});
    const web=openWeb(out);
    try{
      assert.equal(web.index.fileStore?.abi,4);assert.equal(web.index.fileStore?.maxFileBytes,8192);
      assert.equal(hash(readFileSync(join(out,web.about.index.path))),web.about.index.sha256);
      const selected=await releaseFileStore(web.index.fileStore,async(d)=>new Uint8Array(web.blob(d)));
      const tree=await prepareTree({fileStore:selected,muk:new Uint8Array([1]),root:{index:web.index,reading:{range:(name,at,len)=>web.readRange(name,at,len,new Uint8Array(len)),decode:(b)=>new Uint8Array(web.unzstd(b)),sha256:(b)=>new Uint8Array(createHash('sha256').update(b).digest())}}});
      assert.equal(new TextDecoder().decode(tree.vfs.readFile('/hello')),'hello\n');
      assert.throws(()=>tree.vfs.file('/hello').data); // no TS mutable canonical alias
      tree.dispose();
      const descriptor=web.index.fileStore!;rmSync(join(out,descriptor.path));
      await assert.rejects(releaseFileStore(descriptor,async(d)=>new Uint8Array(web.blob(d))),/ENOENT/);
    }finally{web.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
