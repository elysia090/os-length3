// Deploy the authenticated Release ZIP, without rebuilding or mixing Linux roots.
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,copyFile,cp,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const pin='7ae8a85018b49656c8212e4984baf9500656ee3a2ef642a149752954924729f9';
const archiveHash='a2232ac08a952610783cf23daa44668a7a235520e1e772bea55146812447703b';
const manifestHash='8fb8f6fdd672817d30dd2f2136b6a666ecd610021f383a1ff4be9dbf8adcd0cc';
const sourceCommit='90ea11b242be33c9daf2a35808f5089fca0f9c08';
const archiveName=`os-length3-linux-0.1.0-web-${pin}.zip`;
const releaseUrl=`https://github.com/elysia090/libqm-prototype/releases/download/os-length3-linux-v0.1.0/${archiveName}`;
const work=path.join(repo,'temp','cloudflare-web',pin),source=path.join(work,'source');
const dist=path.join(repo,'dist'),hash=b=>createHash('sha256').update(b).digest('hex');
await mkdir(work,{recursive:true});await mkdir(source,{recursive:true});await mkdir(dist,{recursive:true});
let zip;
if(process.env.LENGTH3_WEB_ZIP)zip=await readFile(process.env.LENGTH3_WEB_ZIP);
else {
  try{zip=await readFile(path.join(work,archiveName));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!zip){const response=await fetch(releaseUrl);if(!response.ok)throw new Error(`Release download HTTP ${response.status}`);
    zip=Buffer.from(await response.arrayBuffer());}
}
if(zip.length!==94990744||hash(zip)!==archiveHash)throw new Error('Release Web ZIP identity differs');
const archive=path.join(work,archiveName);await writeFile(archive,zip);
execFileSync(process.platform==='win32'?'tar.exe':'unzip',process.platform==='win32'
  ?['-xf',archive,'-C',source]:['-q','-o',archive,'-d',source],{stdio:'inherit'});
const raw=await readFile(path.join(source,'web-bundle.json'));
if(hash(raw)!==manifestHash)throw new Error('Web bundle manifest identity differs');
const manifest=JSON.parse(raw);
if(manifest.releaseSha256!==pin||manifest.webSourceCommit!==sourceCommit)throw new Error('Release/Web source pairing differs');
const roles=JSON.parse(await readFile(path.join(source,'artifact','release','release.json'))).objects;
const splitBytes=16*1048576,objects={};
async function writeChanged(file,bytes){try{const old=await readFile(file);if(old.equals(Buffer.from(bytes)))return;}catch(e){if(e.code!=='ENOENT')throw e;}await writeFile(file,bytes);}
for(const [name,row] of Object.entries(manifest.files)){
  if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'))throw new Error('invalid packaged path');
  const file=path.join(source,name),bytes=await readFile(file);
  if(bytes.length!==row.bytes||hash(bytes)!==row.sha256)throw new Error(`packaged bytes differ: ${name}`);
  if(name==='serve.mjs'||name==='web/_headers')continue;
  if(bytes.length>25*1048576){
    const parts=[];
    for(let at=0;at<bytes.length;at+=splitBytes){const part=`release-parts/${row.sha256}/${String(parts.length).padStart(3,'0')}.object`;
      await mkdir(path.dirname(path.join(dist,part)),{recursive:true});await writeChanged(path.join(dist,part),bytes.subarray(at,at+splitBytes));parts.push('/'+part);}
    objects['/'+name]={...row,partBytes:splitBytes,parts};
  }else {await mkdir(path.dirname(path.join(dist,name)),{recursive:true});await copyFile(file,path.join(dist,name));
    if(name.startsWith('artifact/release/')&&name.endsWith('.object'))objects['/'+name]={...row,parts:['/'+name],partBytes:splitBytes};}
  if(objects['/'+name]){
    const role=roles[path.basename(name,'.object')],rangeChunks=[];
    for(let at=0;at<bytes.length;at+=65536){const chunk=bytes.subarray(at,at+65536),identity=hash(chunk);
      if(identity!==role.chunks[at/65536])throw new Error('Release chunk identity differs');
      const chunkName=`release-chunks/${identity}.object`;await mkdir(path.dirname(path.join(dist,chunkName)),{recursive:true});
      await writeChanged(path.join(dist,chunkName),chunk);rangeChunks.push('/'+chunkName);}
    objects['/'+name].rangeChunks=rangeChunks;
  }
}
// Separate hosted shell; the accepted Release's Web/runtime bytes stay intact.
await cp(path.join(repo,'src','v2','hosted'),path.join(dist,'os'),{recursive:true});
await cp(path.join(repo,'src','v2','web'),path.join(dist,'legacy-ui'),{recursive:true});
for(const name of ['compiler','vm','postlink-compiler'])await cp(path.join(repo,'artifact',name),path.join(dist,'legacy-ui','artifact',name),{recursive:true});
await copyFile(path.join(repo,'artifact','index.json'),path.join(dist,'legacy-ui','artifact','index.json'));
const legacyIndex=await readFile(path.join(dist,'legacy-ui','index.html'),'utf8');
await writeChanged(path.join(dist,'legacy-ui','index.html'),legacyIndex.replace('</body>','<script type="module" src="/os/legacy-migration.mjs"></script></body>'));
async function listFiles(root,prefix=''){const out=[];for(const dirent of await readdir(root,{withFileTypes:true})){
  const name=prefix+dirent.name;if(dirent.isDirectory())out.push(...await listFiles(path.join(root,dirent.name),name+'/'));else if(dirent.isFile())out.push(name);}return out;}
const hostedFiles=await listFiles(path.join(dist,'os')),legacyFiles=await listFiles(path.join(dist,'legacy-ui'));
const routing=JSON.parse(await readFile(path.join(repo,'data','distribution','hosted-routing.json'),'utf8'));
// Only this independently approved bundle's public files are addressable.
await writeFile(path.join(dist,'web-bundle.json'),raw);
const config={releaseSha256:pin,webSourceCommit:sourceCommit,archiveSha256:archiveHash,redirectQm:routing.redirectQm,
  versionPrefix:`/releases/${pin}`,files:['/web-bundle.json',...hostedFiles.map(n=>'/os/'+n),...Object.keys(manifest.files).filter(n=>n!=='serve.mjs'&&n!=='web/_headers').map(n=>'/'+n)],legacyFiles,objects};
await writeChanged(path.join(repo,'data','distribution','cloudflare-release.generated.json'),JSON.stringify(config));
const deploymentCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const hostedFileIdentities={};for(const name of hostedFiles){const bytes=await readFile(path.join(dist,'os',name));hostedFileIdentities[name]={bytes:bytes.length,sha256:hash(bytes)};}
await writeFile(path.join(dist,'deployment.json'),JSON.stringify({format:'length3-hosted-web-v1',deploymentCommit,
  hostedShellCommit:deploymentCommit,hostedFiles:hostedFileIdentities,webSourceCommit:sourceCommit,releaseSha256:pin,archiveSha256:archiveHash,roles,
  persistence:'browser-origin IndexedBlockStore',cloudSynchronization:false,source:releaseUrl},null,2)+'\n');
console.log(JSON.stringify({status:'prepared',deploymentCommit,releaseSha256:pin,webSourceCommit:sourceCommit,
  checkedFiles:Object.keys(manifest.files).length,systemParts:objects['/artifact/release/system.object'].parts.length}));
