import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstatSync,readFileSync,writeFileSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const sha=b=>createHash('sha256').update(b).digest('hex');
const [source,archive,layers,officialWasm,pinsFile,...extra]=process.argv.slice(2);
assert(source&&archive&&layers&&officialWasm&&pinsFile&&!extra.length);
const pin={
  release:'ec84d6a4f34359f322726e323e294b03987a19b1aa544563c846ca1a83060ee3',
  busybox:'5b10f1705ad5250b74aa56548d72263db52c9737061db005c8186c8c295e4d63',
  inputWasm:'1422a0f7e11788880a4c13a78eba901e36813abb8243d5389ea24ac73a1c0614',
  muk:'0668fceb53911c4a9f89f013ce94c92eeac9df62754dfba4bc563fe7384c6348',
};
const file=(p)=>{assert(lstatSync(p).isFile());return readFileSync(p);};
const a=file(archive),raw=file(join(layers,'webroot.json')),wasm=file(officialWasm);
assert.equal(sha(wasm),pin.inputWasm);
const strip=(original)=>{
  const retained=[original.subarray(0,8)];
  assert(WebAssembly.validate(original));
  for(let offset=8;offset<original.length;){
    const from=offset,type=original[offset++];
    let n=0, shift=0, byte;
    do {
      assert(shift<=28 && offset<original.length);
      byte=original[offset++];n+=(byte&127)*2**shift;shift+=7;
    }while(byte&128);
    assert(offset+n<=original.length);
    offset+=n;
    if(type)retained.push(original.subarray(from,offset));
  }
  return Buffer.concat(retained);
};
const {openDistribution}=await import(pathToFileURL(resolve(source,'ricebox/distribution/deployment/local.ts')).href);
const w=openDistribution(layers);
try{
  assert.equal(w.about.root.profile,'published-busybox-current-config-v1');
  assert.equal(w.about.sha256,sha(a));assert.equal(w.about.bytes,a.length);assert.equal(w.about.file,basename(archive));
  w.checkAll();
  const bb=w.index.files.filter(f=>f.path==='/usr/bin/busybox');
  assert.equal(bb.length,1);assert.equal(bb[0].mode&0o777,0o755);
  const bv=execFileSync('tar',['--zstd','-xOf',archive,'root/usr/bin/busybox'],{maxBuffer:2<<20});
  assert.equal(sha(bv),pin.busybox);assert(bv.equals(w.read(bb[0])));
  const tr=w.blob(w.index.translator);
  assert(tr.equals(strip(wasm)) && WebAssembly.validate(tr));
  const mukInfo=JSON.parse(file(join(layers,'muk.json')));
  assert.match(mukInfo.path,/^blobs\/[a-f0-9]{64}\.bin$/);
  const muk=file(join(layers,mukInfo.path));
  assert.equal(mukInfo.size,muk.length);
  assert.equal(sha(muk),pin.muk);
  assert.equal(mukInfo.sha256,pin.muk);
  const hot=w.index.translations;
  assert.equal(hot.length,1);
  const t=hot[0];
  assert.equal(t.path,'/usr/bin/busybox');assert.equal(t.sha256,pin.busybox);
  assert.equal(t.association?.mode,'whole');assert.equal(t.association?.sourceSha256,pin.busybox);
  assert(w.blob(t.elf).equals(bv));
  const aot=w.blob(t.wasm);assert(WebAssembly.validate(aot));
  // Independently compare the artifact to live whole-translation by the pinned
  // CI runtime; no native Sods backend equality is implied.
  const {exports:e}=new WebAssembly.Instance(await WebAssembly.compile(wasm),{});
  const p=e.sods_alloc(bv.length);new Uint8Array(e.memory.buffer,p,bv.length).set(bv);
  assert.equal(e.sods_translate_whole(p,bv.length),0);
  assert(aot.equals(Buffer.from(e.memory.buffer,e.sods_output_ptr(),e.sods_output_len())));
  const packs=w.index.packs.map(p=>{
    assert.match(p.name,/^[a-f0-9]{64}\.pack$/);
    const b=file(join(layers,'packs',p.name));assert.equal(b.length,p.bytes);
    return {name:p.name,bytes:b.length,raw_sha256:sha(b)};
  });
  const sha256={archive:sha(a),webroot:sha(raw),translator:sha(tr),muk:sha(muk),busybox:sha(bv)};
  writeFileSync(pinsFile,JSON.stringify(sha256,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({scope:'private minimal official-carried BusyBox/current config, not fresh Alpine producer',
    archival_provenance:pin.release,operator_approved:false,sha256,
    index:{path:w.about.index.path,sha256:w.about.index.sha256,bytes:w.about.index.size},
    aot:{backend:'verified CI Wasm, not native compiler',sha256:sha(aot),bytes:aot.length,
      stored_sha256:t.wasm.sha256,association:t.association},
    translator_input_sha256:pin.inputWasm,muk_bytes:muk.length,
    files:w.index.files.length,dirs:w.index.dirs.length,links:w.index.links.length,packs},null,2));
}finally{w.close();}
