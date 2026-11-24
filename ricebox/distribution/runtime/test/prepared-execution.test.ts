import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {zstdCompressSync, zstdDecompressSync} from 'node:zlib';
import {Kernel, preparedLinux, RemoteKernel} from '../../../sods/runtime/linux.ts';
import {loadTranslator, prepare} from '../../../sods/runtime/translate.ts';
import {LINE, packOf} from '../../format/pack.ts';
import {canonicalExecutableSource, canonicalPackedFileSet} from '../../format/executable-source.ts';
import {prepareTree} from '../prepared-tree.ts';
import {executableKey} from '../prepared-executable.ts';
import type {Index, PreparedExecutable} from '../root-types.ts';
const digest = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM ?? process.env.SODS_TRANSLATOR_WASM;
function elf() {
  const bytes = new Uint8Array(4112), view = new DataView(bytes.buffer);
  bytes.set([127,69,76,70,2,1,1]); view.setUint16(16,2,true); view.setUint16(18,62,true); view.setUint32(20,1,true);
  view.setBigUint64(24,0x401000n,true); view.setBigUint64(32,64n,true); view.setUint16(52,64,true); view.setUint16(54,56,true); view.setUint16(56,1,true);
  view.setUint32(64,1,true); view.setUint32(68,5,true); view.setBigUint64(80,0x400000n,true);
  // Deliberately leave four canonical file bytes outside the loadable image.
  view.setBigUint64(96,4108n,true); view.setBigUint64(104,4108n,true); view.setBigUint64(112,4096n,true);
  bytes.set([0xb8,60,0,0,0,0xbf,7,0,0,0,0x0f,0x05],4096); bytes.set([17,33,55,77],4108); return bytes;
}
function root(bytes: Uint8Array, mode = 0o755) {
  const pack = packOf([bytes], digest); let reads = 0;
  const t = {path:'/usr/bin/program',sha256:hash(bytes),elf:{path:'blobs/source.bin',sha256:'a'.repeat(64),size:bytes.length,bytes:bytes.length},wasm:{path:'blobs/image.bin',sha256:'b'.repeat(64),size:8,bytes:8}};
  const index: Index = {name:'test',version:'1',sha256:'c'.repeat(64),codec:'zstd',packs:[{name:pack.name,owner:'test',bytes:pack.bytes.length}],dirs:[],links:[],
    files:['/usr/bin/program','/usr/bin/hard'].map(path=>({path,mode,size:bytes.length,pack:0,at:pack.at[0]!,len:bytes.length,raw:true})),translations:[t],
    translator:{name:'sods',version:'test',path:'blobs/translator.bin',sha256:'d'.repeat(64),size:8,bytes:8,wasm:'e'.repeat(64)}};
  return {index,t,source:canonicalExecutableSource(index,t),reads:()=>reads,reading:{sha256:digest,decode(){throw Error('raw');},range(_name:string,at:number,length:number){reads++;return pack.bytes.slice(at,at+length);}}};
}

const stagedRoot = process.env.SODS_TEST_DYNAMIC_ROOT, mukFile = process.env.RICEBOX_MUK_FILE;
test('the pinned fixture file set captures lazily from one checked root without reading or rehashing warm members', {
  skip: !stagedRoot || !mukFile ? 'requires the matched dynamic fixture and existing Muk artifact; no guest is run' : false,
}, () => {
  const lib = '/usr/lib/x86_64-linux-gnu/', paths = ['/usr/bin/ricebox-pie-fixture', `${lib}ld-linux-x86-64.so.2`,
    `${lib}libc.so.6`, `${lib}libricebox-pie-fixture.so.1`];
  // These are actual staged bytes. The app and its DSO are local fixture
  // builds; the interpreter and libc are from the pinned Debian archive.
  const payloads = paths.map(path => {
    const where = join(stagedRoot!, path);
    assert.ok(lstatSync(where).isFile());
    return new Uint8Array(readFileSync(where));
  });
  assert.equal(hash(payloads[1]), '8642358c60bdf4579911381070c69cc7b1a447809b73d483ce799c4421609d21');
  assert.equal(hash(payloads[2]), 'cc7377e8816cefadbb4ee083f5387f67a4a883d90bc273160842a6ac075af662');
  const stored = payloads.map(bytes => zstdCompressSync(bytes)), pack = packOf(stored, digest);
  const index = {codec: 'zstd', packs: [{name: pack.name, owner: 'fixture', bytes: pack.bytes.length}], dirs: [], links: [],
    files: paths.map((path, i) => ({path, mode: i < 2 ? 0o755 : 0o644, size: payloads[i].length, pack: 0, at: pack.at[i], len: stored[i].length}))};
  const reads: [number, number][] = [], hashes: number[] = [], decoded: number[] = [];
  const tree = prepareTree({muk: readFileSync(mukFile!), captureSources: canonicalPackedFileSet(index, paths), root: {index, reading: {
    range(name, at, length) {
      assert.equal(name, pack.name); reads.push([at, length]); return pack.bytes.slice(at, at + length);
    },
    sha256(bytes) { hashes.push(bytes.length); return digest(bytes); },
    decode(bytes, size) {
      decoded.push(bytes.length);
      const out = zstdDecompressSync(bytes); assert.equal(out.length, size);
      return new Uint8Array(out);
    },
  }}});
  assert.equal(tree.sources.size, paths.length);
  assert.deepEqual([reads, hashes, decoded], [[], [], []], 'select and capture are metadata only');
  for (const i of [0, 1]) assert.deepEqual(tree.vfs.readFile(paths[i]), payloads[i]);
  assert.deepEqual(reads, [[pack.at[0], stored[0].length], [0, paths.length * LINE], [pack.at[1], stored[1].length]]);
  assert.deepEqual(hashes, [paths.length * LINE, stored[0].length, stored[1].length]);
  assert.deepEqual(decoded, [stored[0].length, stored[1].length], 'dependencies were not fetched');
  for (const i of [0, 1, 0, 1]) assert.deepEqual(tree.vfs.readFile(paths[i]), payloads[i]);
  assert.deepEqual([reads.length, hashes.length, decoded.length], [3, 3, 2], 'resident members keep their existing verification');
});

test('actual prepared tree captures before overlays and whole AOT preserves lazy complete ELF', {skip:!translatorPath}, async()=>{
  const bytes=elf(),r=root(bytes),translator=await loadTranslator(readFileSync(translatorPath!)),p=prepare(translator.whole(bytes));
  const replacement=bytes.slice();replacement[4108]=99;
  const tree=prepareTree({muk:Uint8Array.of(1),root:{index:r.index,reading:r.reading},
    captureSources:[r.source],files:[{path:r.t.path,bytes:replacement,mode:0o755}]});
  const {kernel,attached}=preparedLinux({vfs:tree.vfs,inline:true,translate:translator,console:{write(){},read:()=>new Uint8Array(0)},
    executables:[{key:'program',source:tree.sources.get(r.source.origin)!,module:new WebAssembly.Module(p.wasm),segments:p.segments,shared:false}]});
  try {
    assert.equal(r.reads(),0);assert.equal(attached.size,1);assert.equal(kernel.translated(tree.vfs.file(r.t.path)),false);
    assert.equal(await kernel.spawn('/usr/bin/hard',['/usr/bin/hard'],[],'/'),7<<8);assert.equal(r.reads(),0,'AOT execution must not demand source');
    assert.deepEqual(tree.vfs.readFile('/usr/bin/hard'),bytes);assert.equal(r.reads(),2,'one table and one authenticated raw payload');
    assert.deepEqual(tree.vfs.readFile(r.t.path),replacement);assert.equal(r.reads(),2,'overlay is never replaced by hot arrival');
    assert.ok(kernel.prebuiltSource(tree.sources.get(r.source.origin)!,new WebAssembly.Module(p.wasm),p.segments));
    assert.equal(kernel.translated(tree.vfs.file(r.t.path)),false,'late hot remains on original hardlinked source');
  } finally {kernel.halt();if(kernel instanceof RemoteKernel){kernel.close();await kernel.snapshotWorkerStops();}}
});

test('actual prepared-tree capture keeps mode denial authoritative without reading canonical payload', {skip:!translatorPath}, async()=>{
  const bytes=elf(),r=root(bytes,0o644),translator=await loadTranslator(readFileSync(translatorPath!)),p=prepare(translator.whole(bytes));
  const tree=prepareTree({muk:Uint8Array.of(1),root:{index:r.index,reading:r.reading},captureSources:[r.source]});
  const {kernel}=preparedLinux({vfs:tree.vfs,inline:true,console:{write(){},read:()=>new Uint8Array(0)},executables:[{key:'p',source:tree.sources.get(r.source.origin)!,module:new WebAssembly.Module(p.wasm),segments:p.segments}]});
  try{assert.throws(()=>kernel.start(r.t.path,[r.t.path],[],'/'));assert.equal(r.reads(),0);}finally{kernel.halt();}
});

// A real engine module sufficient for preparation-only loadTranslator transport.
// No fake Linux syscall or filesystem implementation is used here.
const memoryModule=Uint8Array.of(0,97,115,109,1,0,0,0,5,3,1,0,1,7,10,1,6,109,101,109,111,114,121,2,0);
test('actual Worker rejects profile/generation/legacy-hot mismatches with visible diagnostics before execution',async()=>{
  const r=root(elf()),generation='f'.repeat(64),messages:{type:string;message?:string;owners?:Record<string,number>}[]=[];
  const host={onmessage:null as null|((event:{data:unknown})=>Promise<void>),postMessage(message:typeof messages[number]){messages.push(message);}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'self');Object.defineProperty(globalThis,'self',{value:host,configurable:true});
  try{
    await import(new URL('../worker.ts?prepared-selection',import.meta.url).href);
    await host.onmessage!({data:{type:'ready',profile:'canonical-aot-v1',generation,translator:memoryModule,muk:Uint8Array.of(1),root:{index:r.index,url:'https://unused.test/'},executables:[]}});
    await host.onmessage!({data:{type:'executables',generation:'e'.repeat(64),executables:[]}});
    await host.onmessage!({data:{type:'hot',files:[]}});
    await host.onmessage!({data:{type:'start',box:{config:'{}',words:[]},cwd:'/'}});
    assert.equal(messages.filter(m=>m.type==='error').length,3);assert.ok(messages.every(m=>m.type!=='threads'));
    assert.match(messages[0]!.message!,/generation/);assert.match(messages[1]!.message!,/executable-only/);assert.match(messages[2]!.message!,/profile|generation/);
    // Ready does not acknowledge preparation. This valid, empty admission
    // awaits the real Readied owner before we retire and restore global self.
    // Cancellation while preparation is pending is tested separately below.
    await host.onmessage!({data:{type:'executables',generation,executables:[]}});
    assert.equal(messages.length,3);
    await host.onmessage!({data:{type:'retire'}});
    await host.onmessage!({data:{type:'executables',generation,executables:[]}});assert.match(messages.at(-1)!.message!,/retiring/);
  }finally{if(previous)Object.defineProperty(globalThis,'self',previous);else Reflect.deleteProperty(globalThis,'self');}
});

test('actual Worker captures original source before an ordinary overlay and validates late executable identities',async()=>{
  const r=root(elf()),generation='f'.repeat(64),source=r.source;
  const facts=new TextEncoder().encode('sods.facts'),body=new TextEncoder().encode('{}');
  const module=new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0,0,1+facts.length+body.length,facts.length,...facts,...body));
  const executable:PreparedExecutable={generation,key:executableKey(generation,source,r.t,r.index.translator.sha256,false),path:source.path,source,
    artifact:{sha256:r.t.wasm.sha256,translator:r.index.translator.sha256,mode:'whole'},module,segments:null,shared:false};
  const messages:{type:string;message?:string}[]=[],host={onmessage:null as null|((event:{data:unknown})=>Promise<void>),postMessage(message:typeof messages[number]){messages.push(message);}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'self');Object.defineProperty(globalThis,'self',{value:host,configurable:true});
  try{
    await import(new URL('../worker.ts?prepared-hot-source',import.meta.url).href);
    await host.onmessage!({data:{type:'ready',profile:'canonical-aot-v1',generation,translator:memoryModule,muk:Uint8Array.of(1),root:{index:r.index,url:'https://unused.test/'},files:[{path:r.t.path,bytes:elf(),mode:0o755}],executables:[]}});
    await host.onmessage!({data:{type:'executables',generation,executables:[executable]}});assert.deepEqual([...messages],[]);
    await host.onmessage!({data:{type:'executables',generation,executables:[{...executable,key:'wrong'}]}});assert.match(messages.at(-1)!.message!,/match/);
    await host.onmessage!({data:{type:'executables',generation,executables:[executable]}});assert.match(messages.at(-1)!.message!,/Duplicate/);
    await host.onmessage!({data:{type:'retire'}});
  }finally{if(previous)Object.defineProperty(globalThis,'self',previous);else Reflect.deleteProperty(globalThis,'self');}
});

for (const prepared of [false, true]) test(`ready overlays belong to the VFS at foreground start, prepared=${prepared}`, async () => {
  const r = root(elf()), generation = 'f'.repeat(64), source = r.source;
  const facts = new TextEncoder().encode('sods.facts'), body = new TextEncoder().encode('{}');
  const module = new WebAssembly.Module(Uint8Array.of(0,97,115,109,1,0,0,0,0,1+facts.length+body.length,facts.length,...facts,...body));
  const aot: PreparedExecutable = {generation, key: executableKey(generation, source, r.t, r.index.translator.sha256, false),
    path: source.path, source, artifact: {sha256: r.t.wasm.sha256, translator: r.index.translator.sha256, mode: 'whole'},
    module, segments: null, shared: false};
  const files = [{path: '/replaced', bytes: Uint8Array.of(2)}, {path: '/retained', bytes: Uint8Array.of(3)},
    ...(!prepared ? [{path: '/legacy-hot', bytes: Uint8Array.of(4), module, shared: false}] : [])];
  const iterator = files[Symbol.iterator].bind(files);
  let visits = 0;
  files[Symbol.iterator] = () => { visits++; return iterator(); };
  const messages: {type: string; message?: string}[] = [];
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>),
    postMessage(message: typeof messages[number]) { messages.push(message); }};
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'self'), start = Kernel.prototype.start;
  let reached = 0;
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  Kernel.prototype.start = function () {
    assert.deepEqual(this.vfs.readFile('/replaced'), Uint8Array.of(9));
    assert.deepEqual(this.vfs.readFile('/retained'), Uint8Array.of(3));
    if (prepared) {
      assert.equal(this.translated(this.vfs.file('/usr/bin/hard')), true);
      assert.equal(this.translated(this.vfs.file(r.t.path)), false, 'late ordinary overlay does not inherit AOT');
    } else assert.equal(this.translated(this.vfs.file('/legacy-hot')), true, 'legacy still attaches its ready image');
    reached++;
    throw new Error('Guest entry withheld by test');
  };
  try {
    await import(new URL(`../worker.ts?ready-overlays-${prepared}`, import.meta.url).href);
    const profile = prepared ? {profile: 'canonical-aot-v1', generation} : {};
    await host.onmessage!({data: {type: 'ready', ...profile, translator: memoryModule, muk: Uint8Array.of(1), files,
      ...(prepared && {root: {index: r.index, url: 'https://must-not-read-source.test/'}, executables: [aot]})}});
    // Await preparation without starting a guest.
    if (prepared) await host.onmessage!({data: {type: 'executables', generation, executables: []}});
    assert.equal(messages.length, 0);
    await host.onmessage!({data: {type: 'start', ...profile, box: {config: '{}', words: []}, cwd: '/',
      files: [{path: '/replaced', bytes: Uint8Array.of(9)}, ...(prepared ? [{path: r.t.path, bytes: Uint8Array.of(5)}] : [])]}});
    assert.equal(reached, 1);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message ?? '', /^Error: Guest entry withheld by test/);
    assert.equal(visits, 2, prepared ? 'validate and install only; foreground must not revisit the ready wire list' :
      'legacy installs first, then reads its saved list to bind translations');
  } finally {
    try { await host.onmessage?.({data: {type: 'retire'}}); }
    finally { Kernel.prototype.start = start; if (prior) Object.defineProperty(globalThis, 'self', prior); else Reflect.deleteProperty(globalThis, 'self'); }
  }
});

for(const rehearsed of [false,true])test(`actual prepared Worker runs the real muk and AOT guest without any pack source demand, rehearsed=${rehearsed}`,{skip:!translatorPath||!process.env.RICEBOX_MUK_FILE,timeout:20_000},async()=>{
  const bytes=elf(),r=root(bytes),translator=await loadTranslator(readFileSync(translatorPath!)),p=prepare(translator.whole(bytes)),generation='f'.repeat(64),source=r.source;
  const executable:PreparedExecutable={generation,key:executableKey(generation,source,r.t,r.index.translator.sha256,false),path:source.path,source,
    artifact:{sha256:r.t.wasm.sha256,translator:r.index.translator.sha256,mode:'whole'},module:new WebAssembly.Module(p.wasm),segments:p.segments,shared:false};
  const box={config:JSON.stringify({ociVersion:'1.0.2',process:{args:[r.t.path],env:[],cwd:'/',noNewPrivileges:true},root:{path:'/',readonly:false},
    linux:{namespaces:['pid','network','ipc','uts','mount','user'].map(type=>({type})),uidMappings:[{containerID:0,hostID:0,size:1}],gidMappings:[{containerID:0,hostID:0,size:1}]}}),
    words:['run','--lend','/','--ids','0-0','-b','/run/box','box']};
  const messages:{type:string;status?:number;message?:string}[]=[],host={onmessage:null as null|((event:{data:unknown})=>Promise<void>),postMessage(message:typeof messages[number]){messages.push(message);}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'self'), previousXHR=Object.getOwnPropertyDescriptor(globalThis,'XMLHttpRequest');
  let sourceRequests=0;
  Object.defineProperty(globalThis,'self',{value:host,configurable:true});
  Object.defineProperty(globalThis,'XMLHttpRequest',{value:class {constructor(){sourceRequests++;throw new Error('unexpected canonical source demand');}},configurable:true});
  try{
    await import(new URL(`../worker.ts?prepared-real-muk-${rehearsed}`,import.meta.url).href);
    const preparation={profile:'canonical-aot-v1',generation,translator:readFileSync(translatorPath!),muk:readFileSync(process.env.RICEBOX_MUK_FILE!),root:{index:r.index,url:'https://must-not-read-source.test/'},executables:[executable]};
    if(rehearsed)await host.onmessage!({data:{type:'ready',...preparation,rehearse:box}});
    await host.onmessage!({data:{type:'start',...(rehearsed?{profile:preparation.profile,generation,executables:[]}:preparation),box,cwd:'/'}});
    for(let i=0;i<100&&!messages.some(m=>m.type==='exit'||m.type==='error');i++)await new Promise(resolve=>setTimeout(resolve,5));
    assert.deepEqual(messages.filter(m=>m.type==='error'),[]);assert.equal(messages.find(m=>m.type==='exit')?.status,7<<8,JSON.stringify(messages));
    // Count the real host range boundary; no canonical payload was demanded.
    // This is a Node adapter test, not a browser network trace.
    assert.equal(sourceRequests,0);
  }finally{await host.onmessage?.({data:{type:'retire'}});if(previous)Object.defineProperty(globalThis,'self',previous);else Reflect.deleteProperty(globalThis,'self');if(previousXHR)Object.defineProperty(globalThis,'XMLHttpRequest',previousXHR);else Reflect.deleteProperty(globalThis,'XMLHttpRequest');}
});

test('actual prepared Worker cannot reuse a tree after a fatal rehearsal exec', {skip: !translatorPath, timeout: 15_000}, async () => {
  const r = root(elf()), generation = 'f'.repeat(64), box = {config: '{}', words: []};
  const messages: {type: string; message?: string; failures?: string[]}[] = [];
  const host = {onmessage: null as null | ((event: {data: unknown}) => Promise<void>),
    postMessage(message: typeof messages[number]) { messages.push(message); }};
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', {value: host, configurable: true});
  const takeMemory = Kernel.prototype.takeMemory;
  let attempts = 0;
  Kernel.prototype.takeMemory = function () {
    // Real Sods preparation has accepted the run. Fail at old-image
    // replacement, after admission, rather than fabricating a Worker receipt.
    attempts++;
    throw new Error('injected irreversible exec allocation failure');
  };
  try {
    await import(new URL('../worker.ts?prepared-fatal-rehearsal', import.meta.url).href);
    const data = {type: 'start', profile: 'canonical-aot-v1', generation, translator: readFileSync(translatorPath!),
      muk: elf(), root: {index: r.index, url: 'https://must-not-read-source.test/'}, executables: [], rehearse: box, box, cwd: '/'};
    await host.onmessage!({data});
    assert.equal(attempts, 1, 'no foreground allocation or new ownership follows the failed rehearsal');
    const outcome = messages.find(m => m.type === 'error');
    assert.match(outcome?.message ?? '', /^ExecCommitError: Exec transaction could not complete \(address-space\)/);
    assert.ok(messages.every(m => m.type !== 'threads' && m.type !== 'exit'));
    await host.onmessage!({data: {type: 'retire'}});
    const retirement = messages.find(m => m.type === 'retiring');
    assert.deepEqual(retirement?.failures, ['ExecCommitError: Exec transaction could not complete (address-space)']);
  } finally {
    if (!messages.some(m => m.type === 'retiring')) await host.onmessage?.({data: {type: 'retire'}});
    Kernel.prototype.takeMemory = takeMemory;
    if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self');
  }
});

test('prepared Worker cancellation during asynchronous preparation publishes no kernel or late source association',async()=>{
  const r=root(elf()),generation='f'.repeat(64),messages:{type:string;message?:string;owners?:Record<string,number>}[]=[],host={onmessage:null as null|((event:{data:unknown})=>Promise<void>),postMessage(message:typeof messages[number]){messages.push(message);}};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'self');Object.defineProperty(globalThis,'self',{value:host,configurable:true});
  try{
    await import(new URL('../worker.ts?prepared-cancel-pending',import.meta.url).href);
    const start=host.onmessage!({data:{type:'start',profile:'canonical-aot-v1',generation,translator:memoryModule,muk:Uint8Array.of(1),root:{index:r.index,url:'https://unused.test/'},executables:[],box:{config:'{}',words:[]},cwd:'/'}});
    await host.onmessage!({data:{type:'start',profile:'canonical-aot-v1',generation,box:{config:'{}',words:[]},cwd:'/'}});
    assert.match(messages.at(-1)!.message!,/one foreground start/);
    await host.onmessage!({data:{type:'retire'}});assert.equal(messages.find(m=>m.type==='retiring')!.owners?.preparation,1);
    await start;assert.ok(messages.every(m=>m.type!=='threads'));assert.ok(messages.some(m=>m.type==='error'&&/retiring/.test(m.message??'')));
    await host.onmessage!({data:{type:'retire'}});assert.deepEqual(messages.at(-1)!.owners,{});
    await host.onmessage!({data:{type:'executables',generation,executables:[]}});assert.match(messages.at(-1)!.message!,/retiring/);
  }finally{if(previous)Object.defineProperty(globalThis,'self',previous);else Reflect.deleteProperty(globalThis,'self');}
});

test('partial canonical publication failure cannot revive prepared AOT or keeper after mapping abandonment', {skip:!translatorPath}, async()=>{
  const bytes=elf(),r=root(bytes),translator=await loadTranslator(readFileSync(translatorPath!)),p=prepare(translator.whole(bytes));
  const tree=prepareTree({muk:Uint8Array.of(1),root:{index:r.index,reading:r.reading},captureSources:[r.source]});
  let keeperCalls=0;
  const source=tree.sources.get(r.source.origin)!,module=new WebAssembly.Module(p.wasm);
  const {kernel,attached}=preparedLinux({vfs:tree.vfs,inline:true,translate:translator,keeper:{has(){keeperCalls++;return true;},take(){throw new Error('stale keeper must not be asked');}},
    console:{write(){},read:()=>new Uint8Array(0)},executables:[{key:'program',source,module,segments:p.segments}]});
  const original=tree.vfs.file(r.t.path),mapping={proc:{bytes:bytes.slice()},start:0,length:bytes.length,off:0};
  try{
    original.materialize();original.map(mapping);mapping.proc.bytes[4108]^=1;
    const previous=original.version,failure=new Error('publication after canonical update failed');
    Object.defineProperty(original,'show',{value(){throw failure;},configurable:true});
    try{assert.throws(()=>original.settle(),error=>error===failure);}finally{Reflect.deleteProperty(original,'show');original.abandon(mapping);}
    assert.ok(original.version>previous,'an accepted or uncertain canonical publication invalidates old executable revision');
    assert.equal(kernel.prebuiltSource(source,module,p.segments),null,'late hot cannot attach the old source token');
    assert.equal(kernel.translated(original),false);assert.equal(kernel.keptFor(original),false);assert.equal(keeperCalls,0);
    const fresh=kernel.image(original,true);assert.notEqual(fresh,attached.get('program'));assert.equal(keeperCalls,0);
    assert.equal(fresh.source!()[4108],bytes[4108]!^1);
  }finally{original.abandon(mapping);kernel.halt();}
});
