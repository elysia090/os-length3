// Producer-only ownership gate. Dummy roles never enter product artifact/.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const repo=fileURLToPath(new URL('../..',import.meta.url));
const work=await mkdtemp(path.join(repo,'temp','browser-owner-check-'));
const artifact=path.join(work,'artifact');await mkdir(artifact);
const payload=Buffer.alloc(196613);for(let n=0;n<payload.length;++n)payload[n]=(n*31+(n>>>8))&255;
const input=path.join(work,'input');await writeFile(input,payload,{flag:'wx'});
const digest=createHash('sha256').update(payload).digest('hex');
async function publish(name){let output='';
  const child=spawn(process.execPath,[path.join(repo,'data/distribution/package-browser.mjs'),input,input,input,input,input,path.join(artifact,name)],{windowsHide:true});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,output);return JSON.parse(output);
}
const first=await publish('one'),second=await publish('two');
assert.equal(first.sha256,second.sha256);
const owner=path.join(artifact,'objects',digest+'.object'),owned=await stat(owner);
assert.equal(owned.size,payload.length);assert.equal(owned.nlink,11);
assert.deepEqual(await readdir(path.dirname(owner)),[digest+'.object']);
for(const release of ['one','two'])for(const role of ['kernel','initramfs','system','vm','compiler']){
  const file=path.join(artifact,release,role+'.object');assert.deepEqual(await readFile(file),payload);
  const linked=await stat(file);assert.equal(linked.ino,owned.ino);assert.equal(linked.dev,owned.dev);
}
console.log('Browser packaging: one immutable streamed inode for ten role projections, exact digest/extent, no stale staging; dummy fixtures stay temp');
