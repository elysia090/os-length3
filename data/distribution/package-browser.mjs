// Projection packaging only. The native ELF/root population is not rebuilt,
// modified, decoded, or executed here. All five inputs are explicit products.
import {stat,open,mkdir,copyFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';import path from 'node:path';
const [kernel,initramfs,system,vm,compiler,out,...rest]=process.argv.slice(2);
if(!out||rest.length)throw new Error('KERNEL INITRAMFS SYSTEM VM COMPILER NEW-ARTIFACT-DIRECTORY');
const target=path.resolve(out);if(!target.includes(`${path.sep}artifact${path.sep}`))throw new Error('published projection below artifact/');
await mkdir(target);const manifest={format:'linux-release-v1',cpu:'x86-64-v2',ramBytes:536870912,
  command:'console=ttyS0,115200n8 earlyprintk=serial nokaslr rdinit=/init panic=-1',objects:{}};
for(const [name,input]of Object.entries({kernel,initramfs,system,vm,compiler})){
  const source=await realpath(input),bytes=(await stat(source)).size;if(bytes<1||bytes>268435456)throw new Error('bounded release input');
  const file=await open(source,'r'),hash=createHash('sha256'),row={file:`${name}.object`,bytes,chunkBytes:65536,chunks:[]};
  try{const buffer=Buffer.alloc(65536);for(let at=0;at<bytes;at+=65536){const n=Math.min(65536,bytes-at);if((await file.read(buffer,0,n,at)).bytesRead!==n)throw new Error('short release input');const chunk=buffer.subarray(0,n);hash.update(chunk);row.chunks.push(createHash('sha256').update(chunk).digest('hex'));}}
  finally{await file.close();}row.sha256=hash.digest('hex');manifest.objects[name]=row;await copyFile(source,path.join(target,row.file));
}
const raw=Buffer.from(JSON.stringify(manifest)+'\n'),identity=createHash('sha256').update(raw).digest('hex');
await writeFile(path.join(target,'release.json'),raw,{flag:'wx'});await writeFile(path.join(target,'SHA256SUMS'),`${identity}  release.json\n`,{flag:'wx'});
console.log(JSON.stringify({release:path.join(target,'release.json'),sha256:identity,bytes:Object.values(manifest.objects).reduce((n,r)=>n+r.bytes,raw.length),objects:Object.fromEntries(Object.entries(manifest.objects).map(([k,v])=>[k,{bytes:v.bytes,sha256:v.sha256}]))}));
