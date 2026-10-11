// Projection packaging only. The native ELF/root population is not rebuilt,
// modified, decoded, or executed here. All five inputs are explicit products.
import {stat,open,mkdir,writeFile,realpath,link,unlink} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';import path from 'node:path';
const [kernel,initramfs,system,vm,compiler,out,...rest]=process.argv.slice(2);
if(!out||rest.length)throw new Error('KERNEL INITRAMFS SYSTEM VM COMPILER NEW-ARTIFACT-DIRECTORY');
const target=path.resolve(out);if(!target.includes(`${path.sep}artifact${path.sep}`))throw new Error('published projection below artifact/');
await mkdir(target);const pool=path.join(path.dirname(target),'objects');await mkdir(pool,{recursive:true});
const manifest={format:'linux-release-v1',cpu:'x86-64-v2',ramBytes:536870912,
  command:'console=ttyS0,115200n8 earlyprintk=serial nokaslr rdinit=/init panic=-1',objects:{}};
for(const [name,input]of Object.entries({kernel,initramfs,system,vm,compiler})){
  const source=await realpath(input),before=await stat(source),bytes=before.size;if(bytes<1||bytes>268435456)throw new Error('bounded release input');
  const staging=path.join(pool,`.partial-${randomUUID()}`),owned=await open(staging,'wx');
  let file;
  const hash=createHash('sha256'),row={file:`${name}.object`,bytes,chunkBytes:65536,chunks:[]};
  try{
  file=await open(source,'r');
  try{const buffer=Buffer.alloc(65536);for(let at=0;at<bytes;at+=65536){const n=Math.min(65536,bytes-at);if((await file.read(buffer,0,n,at)).bytesRead!==n)throw new Error('short release input');const chunk=buffer.subarray(0,n);hash.update(chunk);row.chunks.push(createHash('sha256').update(chunk).digest('hex'));
      for(let written=0;written<n;){const out=await owned.write(chunk,written,n-written,at+written);if(!out.bytesWritten)throw new Error('short owner write');written+=out.bytesWritten;}}
    const after=await file.stat();if(after.size!==bytes||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('producer changed during publication');
    await owned.sync();
  }finally{await Promise.all([file.close(),owned.close()]);}
  row.sha256=hash.digest('hex');manifest.objects[name]=row;
  const owner=path.join(pool,row.sha256+'.object');
  // Link the already hashed, flushed inode, not another read of a producer
  // path that may still be growing. Collision never overwrites an owner.
  try{await link(staging,owner);}catch(e){if(e.code!=='EEXIST')throw e;}
  await unlink(staging);
  const witness=createHash('sha256');for await(const bytes of createReadStream(owner))witness.update(bytes);
  if((await stat(owner)).size!==row.bytes||witness.digest('hex')!==row.sha256)throw new Error('immutable payload owner identity');
  // Release roles are projections of one owned inode. New releases cannot
  // duplicate a kernel/root/module payload or mutate a construction input.
  await link(owner,path.join(target,row.file));
  }finally{
    await Promise.all([file?.close().catch(()=>{}),owned.close().catch(()=>{})]);
    await unlink(staging).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
}
const raw=Buffer.from(JSON.stringify(manifest)+'\n'),identity=createHash('sha256').update(raw).digest('hex');
await writeFile(path.join(target,'release.json'),raw,{flag:'wx'});await writeFile(path.join(target,'SHA256SUMS'),`${identity}  release.json\n`,{flag:'wx'});
console.log(JSON.stringify({release:path.join(target,'release.json'),sha256:identity,bytes:Object.values(manifest.objects).reduce((n,r)=>n+r.bytes,raw.length),objects:Object.fromEntries(Object.entries(manifest.objects).map(([k,v])=>[k,{bytes:v.bytes,sha256:v.sha256}]))}));
