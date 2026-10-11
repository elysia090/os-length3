// Binary NUL-delimited inventory avoids PowerShell CRLF filenames. An archive
// failure is fatal before the source digest can be consumed by an oracle.
import {spawnSync} from 'node:child_process';
import {existsSync,lstatSync,openSync,closeSync,realpathSync,createReadStream,readFileSync} from 'node:fs';
import {resolve,dirname,sep} from 'node:path';
import {createHash} from 'node:crypto';
const [tar,out,...rest]=process.argv.slice(2);
if(!out||rest.some(x=>!/^--upstream=[A-Z_]+$/.test(x)))throw new Error('usage: node pack-source.mjs GNU-TAR NEW-OUTPUT [--upstream=ROLE ...]');
const repo=realpathSync('.'),target=resolve(out),parent=realpathSync(dirname(target));
if(!parent.startsWith(repo+sep+'temp'+sep)||existsSync(target))throw new Error('new source archive below repository temp');
const inventory=spawnSync('git',['ls-files','--cached','--others','--exclude-standard','-z','corpus','src/v2','data'],{encoding:'buffer',windowsHide:true});
if(inventory.status!==0)throw new Error('git inventory failed');
const files=inventory.stdout.toString('utf8').split('\0').filter(name=>name&&existsSync(name));
const lock=readFileSync('data/sources.env','utf8');
for(const option of rest){
  const role=option.slice(11),url=new RegExp(`^${role}_URL=(https://[^\\r\\n]+)$`,'m').exec(lock)?.[1];
  const pin=new RegExp(`^${role}_SHA256=([a-f0-9]{64})$`,'m').exec(lock)?.[1];
  if(!url||!pin)throw new Error('locked SHA-256 upstream role required');
  const name=new URL(url).pathname.split('/').at(-1),file='data/upstream/'+name;
  if(!/^[A-Za-z0-9_.+-]+$/.test(name))throw new Error('upstream basename');
  const digest=createHash('sha256');for await(const bytes of createReadStream(file))digest.update(bytes);
  if(digest.digest('hex')!==pin)throw new Error('upstream identity mismatch');
  if(!files.includes(file))files.push(file);
}
// Missing tracked deletions are deliberately excluded; initialized submodule
// directories remain inputs so their required third-party sources are included.
const input=Buffer.from(files.join('\0')+'\0');
closeSync(openSync(target,'wx'));
const run=spawnSync(realpathSync(tar),['--force-local','--format=ustar','--null','--verbatim-files-from','--exclude=.git','-cf',target,'-T','-'],{input,encoding:'buffer',windowsHide:true,maxBuffer:1024*1024});
if(run.status!==0)throw new Error('source archive failed: '+run.stderr.toString('utf8'));
const hash=createHash('sha256');for await(const bytes of createReadStream(target))hash.update(bytes);
console.log(JSON.stringify({format:'oracle-source-archive-v1',file:target,inventoryEntries:files.length,bytes:lstatSync(target).size,sha256:hash.digest('hex')}));
