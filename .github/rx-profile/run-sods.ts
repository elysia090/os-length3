import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {makeObserver} from './cc-observer.ts';
const [cmd, src, layers, root, inputs, ccPath, out] = process.argv.slice(2);
const source = (p: string) => import(path.join(src, p));
const digest = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(digest(b)).toString('hex');
const {openDistribution} = await source('ricebox/distribution/deployment/local.ts');
const {mountPack} = await source('ricebox/distribution/format/mount.ts');
const {Vfs, mountTarget} = await source('ricebox/sods/runtime/linux/fs.ts');
const {Kernel,Task,Process} = await source('ricebox/sods/runtime/linux/process.ts');
const {loadTranslator} = await source('ricebox/sods/runtime/translation/translator.ts');
const w = openDistribution(layers);
assert.equal(w.index.translations.length, 0, 'engine/mode admission is not stock if AOT found');
const receipts = {root: w.about.sha256, index: w.about.index.sha256, translator: w.index.translator.wasm};
if (cmd === 'verify') {
  w.checkAll();
  const members = new Set<string>(); const seen = new Set<string>();
  const nativeToPack=new Map<string,string>(),packToNative=new Map<string,string>();
  const safe = (at: string) => {
    assert(at.startsWith('/') && !at.split('/').slice(1).some(x => x === '..'||x === '.'));
    assert(!members.has(at)); members.add(at);
    const p = path.join(root, at); const st = fs.lstatSync(p, {bigint:true});
    if(!st.isSymbolicLink()) assert.equal(st.uid+st.gid,0n);
    return {p,st};
  };
  for (const f of w.index.files) {
    const {p,st} = safe(f.path);
    assert(st.isFile());
    assert.equal(st.mode & 0o7777n, BigInt(f.mode & 0o7777));
    assert.equal(st.size,BigInt(f.size));
    assert(fs.readFileSync(p).equals(w.read(f)), 'native/packed file bytes differ');
    if(f.len){
      const image=f.pack+':'+f.at+':'+f.len, inode=String(st.dev)+':'+String(st.ino);
      assert(!nativeToPack.has(inode)||nativeToPack.get(inode)===image,'native nonempty hardlink not preserved');
      assert(!packToNative.has(image)||packToNative.get(image)===inode,'index invents nonempty hardlink');
      nativeToPack.set(inode,image);packToNative.set(image,inode);
    } else assert(st.nlink===1n,'empty hardlink group needs a separate identity receipt');
  }
  for (const d of w.index.dirs) {
    const {st} = safe(d.path);
    assert(st.isDirectory());
    assert.equal(st.mode & 0o7777n, BigInt(d.mode & 0o7777));
  }
  for (const l of w.index.links) {
    const {p,st} = safe(l.path);
    assert(st.isSymbolicLink()); assert.equal(fs.readlinkSync(p),l.target);
  }
  function walk(at: string) {
    for (const e of fs.readdirSync(path.join(root,at),{withFileTypes:true})) {
      const p = path.posix.join(at,e.name);
      seen.add(p); if(e.isDirectory())walk(p);
    }
  }
  walk('/');
  // Canonical tar's root container directory may have no separate index row.
  members.delete('/');
  assert(seen.size===members.size && [...seen].every(at=>members.has(at)),'projection inventory differs');
  w.close();
  // stdout is a private, runner-owned receipt file opened before sudo.
  await new Promise<void>((done,reject)=>process.stdout.write(JSON.stringify({...receipts,files:w.index.files.length})+'\n',error=>error?reject(error):done()));
  process.exit(0);
}
assert(cmd==='stock'||cmd==='profile');
const translator = w.blob(w.index.translator);
assert.equal(hex(translator),receipts.translator);
const tr = await loadTranslator(translator);
const vfs = new Vfs();
mountPack(mountTarget(vfs),w.index,{range:(pack: string, at: number, len: number)=>new Uint8Array(w.readRange(pack,at,len,Buffer.alloc(len))),decode:(b: Uint8Array)=>new Uint8Array(w.unzstd(b)),sha256:digest});
const modes: Record<string,number> = {'fixture.sh':0o755,'ninja':0o755,'rx-time':0o755,'rx-time.c':0o644,'build.ninja':0o644,'driver.cc':0o644,'edit_distance-A.cc':0o644,'edit_distance-B.cc':0o644,'edit_distance.h':0o644,'string_piece.h':0o644};
for (const [name,mode] of Object.entries(modes)) vfs.writeFile('/tmp/rx-in/'+name,new Uint8Array(fs.readFileSync(path.join(inputs,name))),mode);
vfs.mkdirp('/tmp/rx-out');
let phase = false, stdout = '', stderr = '', pending = '';
const node = vfs.file(ccPath), compilerBytes = fs.readFileSync(path.join(root,ccPath));
assert(Buffer.from(node.read(0,node.size)).equals(compilerBytes));
const compilerSha=hex(compilerBytes), modules: {wasm:string,bytes:Uint8Array,entry:number}[]=[];
const obs = cmd === 'profile' ? makeObserver(Task,{Process,selected:()=>phase,phaseOf:()=> 'changed-source-template-TU'}) : undefined;
if(obs) {
  globalThis.__riceboxTrace = Object.assign(obs,{observe(file: any, revision: number, image: any, bytes: Uint8Array) {
    if (file!==node) return;
    const wasm = hex(bytes); const epoch = 'cc1plus-'+(modules.length+1);
    modules.push({wasm,bytes,entry:image.facts.entry});
    obs.bind(image.module,{elf:compilerSha,wasm,role:'cc1plus',epoch,node,revision});
  }});
}
const kernel = new Kernel({vfs,translate:tr,console:{read:()=>new Uint8Array(),write(fd: number,b: Uint8Array){
  const x = Buffer.from(b).toString('latin1'); if(fd===2){stderr+=x;return} stdout+=x; pending+=x;
  for(let i=pending.indexOf('\n');i>=0;i=pending.indexOf('\n')){
    const line=pending.slice(0,i);pending=pending.slice(i+1);
    if(line==='RX_B_START'){assert(!phase);phase=true;}
    if(line==='RX_B_END'){assert(phase);phase=false;}
  }
  if(stdout.length+stderr.length>4*1024*1024)throw Error('fixture output too large');
}}});
if(obs)await obs.start();
const status = await kernel.spawn('/bin/sh',['/bin/sh','/tmp/rx-in/fixture.sh'],['HOME=/root','PATH=/bin:/usr/bin','LANG=C','LC_ALL=C','TZ=UTC','TERM=dumb','TMPDIR=/tmp','SOURCE_DATE_EPOCH=0'],'/tmp/rx-out');
assert.equal(status,0,'real fixture, build, proof or negative-control failure');
assert(!phase);
w.close();
fs.writeFileSync(path.join(out,'stdout'),stdout,'latin1');
fs.writeFileSync(path.join(out,'stderr'),stderr,'latin1');
const artifacts = Object.fromEntries(['edit_distance.o','driver.o','proof'].map(name=>{
  const f=vfs.file('/tmp/rx-out/'+name);
  if(name==='proof')fs.writeFileSync(path.join(out,'proof.bin'),f.read(0,f.size));
  return [name,{mode:f.mode & 0o7777,uid:f.uid,gid:f.gid,size:f.size}];
}));
fs.writeFileSync(path.join(out,'artifacts.json'),JSON.stringify(artifacts));
if(obs) {
  assert(modules.length>0 && modules.length<=8);
  const written=new Set<string>();
  const maps=modules.flatMap(m=>{
    if(written.has(m.wasm))return [];
    written.add(m.wasm);
    const file=path.join(out,'module-'+m.wasm+'.wasm');
    const elfEntry=compilerBytes.readBigUInt64LE(24), bias=BigInt(m.entry)-elfEntry;
    assert.equal(bias,compilerBytes.readUInt16LE(16)===3 ? 0x400000n:0n);
    fs.writeFileSync(file,m.bytes);
    return [{wasm:m.wasm,elf:compilerSha,bias:'0x'+bias.toString(16)}];
  });
  await obs.finish(path.join(out,'holder.json'),{...receipts,compilerSha,maps});
}
