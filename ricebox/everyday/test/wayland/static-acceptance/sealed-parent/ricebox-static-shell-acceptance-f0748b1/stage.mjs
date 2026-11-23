// Copy this folder beside the offline installed npm package before running.
import {browserModules,distributionAssets} from 'ricebox/assets';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {gunzipSync,zstdDecompressSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const [prepared, trustedPins, newSite, ...extra]=process.argv.slice(2);
if (!prepared || !trustedPins || !newSite || extra.length) {
  throw Error('Usage: node stage.mjs PREPARED_ROOT TRUSTED_PINS.json NEW_SITE_DIRECTORY');
}
try {lstatSync(newSite); throw Error('Refusing to replace an existing site');}
catch(error) { if(error.code!=='ENOENT') throw error; }
const pins=JSON.parse(readFileSync(trustedPins,'utf8'));
for(const name of ['webroot','translator','muk','busybox']) {
  if(typeof pins?.[name]!=='string' || !/^[0-9a-f]{64}$/.test(pins[name])) {
    throw Error('Missing trusted SHA-256 pin: '+name);
  }
}
const assets=distributionAssets(prepared);
function get(name) {
  const bytes=assets.get('ricebox/'+name);
  if(!bytes) throw Error('Verified distribution is missing: '+name);
  return bytes;
}
function identity(name,bytes) {
  if(createHash('sha256').update(bytes).digest('hex')!==pins[name]) {
    throw Error(name+' does not match its independently trusted pin');
  }
}
function staticElf(name,bytes) {
  // Structural sanity only. The trusted hash, not an ELF magic byte, names
  // this particular executable. Never run the package's tools on the host.
  const elf=bytes.length>=64 && bytes.readUInt32BE(0)===0x7f454c46 &&
    bytes[4]===2 && bytes[5]===1 && [2,3].includes(bytes.readUInt16LE(16)) &&
    bytes.readUInt16LE(18)===62 && bytes.readBigUInt64LE(24)!==0n;
  if(!elf) throw Error(name+' must be a static x86-64 Linux ELF');
  const off=Number(bytes.readBigUInt64LE(32)), stride=bytes.readUInt16LE(54), count=bytes.readUInt16LE(56);
  if(!Number.isSafeInteger(off)||off<64||stride!==56||!count||off+stride*count>bytes.length) {
    throw Error(name+' has an invalid program-header table');
  }
  let code=false;
  for(let i=0;i<count;i++) {
    const at=off+i*stride, type=bytes.readUInt32LE(at);
    if(type===3) throw Error(name+' requires a dynamic interpreter');
    if(type===1 && (bytes.readUInt32LE(at+4)&1)) code=true;
    if(type===2) { // Static PIE may have PT_DYNAMIC, but cannot need a shared library.
      const start=bytes.readBigUInt64LE(at+8), length=bytes.readBigUInt64LE(at+32);
      if(length%16n || start+length>BigInt(bytes.length)) throw Error(name+' has an invalid dynamic table');
      for(let cursor=Number(start), end=Number(start+length); cursor<end; cursor+=16) {
        const tag=bytes.readBigUInt64LE(cursor);
        if(tag===0n) break;
        if(tag===1n) throw Error(name+' requires a shared library');
      }
    }
  }
  if(!code) throw Error(name+' lacks an executable load segment');
}
const rawAbout=get('webroot.json');
identity('webroot',rawAbout);
const about=JSON.parse(rawAbout), index=JSON.parse(get(about.index.path));
const translator=gunzipSync(get(index.translator.path));
identity('translator',translator);
if(!WebAssembly.validate(translator)) throw Error('Pinned translator is not a valid Wasm module');
const muk=get(JSON.parse(get('muk.json')).path);
identity('muk',muk);staticElf('Muk',muk);
const matches=index.files.filter(entry=>entry.path==='/usr/bin/busybox');
if (matches.length!==1 || !(matches[0].mode&0o111)) throw Error('Pinned root lacks one executable /usr/bin/busybox');
const entry=matches[0], pack=get('packs/'+index.packs[entry.pack].name);
const stored=pack.subarray(entry.at,entry.at+entry.len);
const busybox=entry.raw?stored:zstdDecompressSync(stored);
identity('busybox',busybox);staticElf('BusyBox',busybox);

const modules=browserModules();
const fixture=['index.html','demo.mjs','launch.mjs'].map(name=>[name,readFileSync(fileURLToPath(new URL('./'+name,import.meta.url)))]);
mkdirSync(newSite);
for(const [name,bytes] of [...assets,...modules,...fixture]) {
  const file=join(newSite,'demo',name);
  mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,bytes,{flag:'wx'});
}
console.log('Pinned shell-only fixtures staged at /demo/. No guest or browser has run.');
