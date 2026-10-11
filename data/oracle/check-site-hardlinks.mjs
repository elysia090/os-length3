import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,link,stat,access} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

const [make='make']=process.argv.slice(2),repo=fileURLToPath(new URL('../..',import.meta.url));
const scratch=await mkdtemp(join(repo,'temp/site-ownership-'));
const fixture=join(scratch,'artifact'),site=resolve(scratch,'site');
// The site recipe removes its target. Only a fresh, absent descendant of our
// newly created test directory can be supplied to that recipe.
assert(site.startsWith(resolve(scratch)+sep));
await assert.rejects(access(site),{code:'ENOENT'});
await mkdir(join(fixture,'objects'),{recursive:true});
const payload=Uint8Array.from({length:262144},(_,i)=>(i*31+7)&255);
const digest=createHash('sha256').update(payload).digest('hex');
const names=['objects/'+digest+'.object','release-a/vm.object','release-b/vm.object','release-b/compiler.object'];
const source=join(fixture,names[0]);await writeFile(source,payload);
for(const name of names.slice(1)){await mkdir(join(fixture,name,'..'),{recursive:true});await link(source,join(fixture,name));}
await writeFile(join(fixture,'index.json'),'{}\n');
await promisify(execFile)(make,['-C','src/v2','site',
  `SITE=${site.replaceAll('\\','/')}`,`ARTIFACT=${fixture.replaceAll('\\','/')}`],
  {cwd:repo,windowsHide:true,maxBuffer:1024*1024,timeout:60000});
const sourceInfo=await stat(source,{bigint:true}),owners=new Map();
for(const name of names){const file=join(site,'artifact',name),bytes=await readFile(file),info=await stat(file,{bigint:true});
  assert.equal(createHash('sha256').update(bytes).digest('hex'),digest,'exact release-role bytes');
  owners.set(`${info.dev}:${info.ino}`,Number(info.size));
  assert.notEqual(`${info.dev}:${info.ino}`,`${sourceInfo.dev}:${sourceInfo.ino}`,'site must own its copy independently');}
const uniqueBytes=[...owners.values()].reduce((a,b)=>a+b,0);
assert.equal(owners.size,1,'site assembly must preserve one payload owner across digest and release aliases');
assert.equal(uniqueBytes,payload.length);
assert.deepEqual(await readFile(join(site,'artifact/index.json')),Buffer.from('{}\n'));
assert.equal((await stat(source,{bigint:true})).nlink,sourceInfo.nlink,'source ownership stays unchanged');
console.log(JSON.stringify({format:'site-payload-ownership-v1',status:'pass',aliases:names.length,
  apparentPayloadBytes:names.length*payload.length,uniquePayloadBytes:uniqueBytes,
  independentCopy:true,byteDigest:digest,
  scope:'same fixture and site recipe; hardlink storage accounting, not compressed upload size or browser runtime speed'}));
