import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {writeFramedAot} from '../../build/framed-aot.ts';
import {aotFraming} from '../../format/aot-frames.ts';
import {deployedCode} from '../deployed-code.ts';
import {createRoot} from '../root.ts';
import {validateExecutable} from '../prepared-executable.ts';
import {packOf} from '../../format/pack.ts';
import {canonicalPackedFileSet} from '../../format/executable-source.ts';
import type {Index} from '../../format/manifest.ts';
import {gzipSync} from 'node:zlib';
import {compileFramedAot} from '../framed-aot.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const u = (n: number) => {
  const b: number[] = [];
  for (; n > 127; n = Math.floor(n / 128)) b.push((n & 127) | 128);
  return [...b, n];
};
const text = (s: string) => {
  const b = new TextEncoder().encode(s);
  return [...u(b.length), ...b];
};
const section = (id: number, data: number[]) => [id, ...u(data.length), ...data];
const data = (address: number, bytes: number[]) => [0, 0x41, ...u(address), 0x0b, ...u(bytes.length), ...bytes];
/** Reads one initialized byte at 4097; the other write and BSS let tests
 * distinguish cold initialization from a later shared instantiation. */
const whole = (other = 4100) => Uint8Array.from([
  0,97,115,109,1,0,0,0,
  ...section(1,[1,0x60,0,1,0x7f]),
  ...section(2,[1,...text('env'),...text('memory'),2,1,1,2]),
  ...section(3,[1,0]),
  ...section(7,[1,...text('read'),0,0]),
  ...section(10,[1,8,0,0x41,...u(4097),0x2d,0,0,0x0b]),
  ...section(11,[2,...data(4096,[5,42,8]),...data(other,[100])]),
  ...section(0,[...text('sods.facts'),...new TextEncoder().encode('{"entry":4096,"imageStart":4096,"imageEnd":8192}')]),
]);
function fixture(t: TestContext, sharded = false) {
  const dir = mkdtempSync(join(tmpdir(),'ricebox-aot-frames-test-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const asset = writeFramedAot(dir, whole(), sharded), body = readFileSync(join(dir, asset.path));
  assert.equal(body.length, asset.size);
  assert.equal(sha(body), asset.sha256);
  return {asset, body, layout: asset.framing!};
}
function streamed(bytes: Uint8Array, width = 13): Response {
  let at = 0;
  return new Response(new ReadableStream({
    pull(c) {
      if (at === bytes.length) return c.close();
      const end = Math.min(bytes.length, at + width);
      c.enqueue(bytes.subarray(at, end)); at = end;
    },
  }));
}
const open = (body: Uint8Array) => async () => streamed(body);
const forever = () => new AbortController().signal;

test('checked frames stream code in both import modes and keep initial data private and ordered', async t => {
  const {asset, layout, body} = fixture(t);
  assert.ok(layout.sharedHead);
  assert.deepEqual(layout.data.map(p => p.address), [4096,4100]);
  const old = Response.prototype.arrayBuffer;
  Response.prototype.arrayBuffer = async () => { throw new Error('framed path must not buffer or join a Response'); };
  try {
    for (const shared of [false,true]) {
      const prog = await compileFramedAot(asset, shared, open(body), forever());
      const memory = new WebAssembly.Memory({initial:1, maximum:2, shared}), dest = new Uint8Array(memory.buffer);
      const fn = () => new WebAssembly.Instance(prog.module, {env:{memory}}).exports.read as () => number;
      assert.equal(fn()(), 0, 'the engine module no longer writes initial data on instantiation');
      const lay = (into: Uint8Array) => { for (const {offset, bytes} of prog.segments) into.set(bytes, offset); };
      lay(dest);
      assert.equal(fn()(),42);
      assert.equal(dest[4098],8);
      assert.equal(dest[4099],0);
      assert.equal(dest[4100],100);
      dest[4097] = 77;
      assert.equal(fn()(),77,'thread/instance reuse does not replay the initialized bytes');
      const next = new WebAssembly.Memory({initial:1,maximum:2,shared});
      lay(new Uint8Array(next.buffer));
      const again = new WebAssembly.Instance(prog.module,{env:{memory:next}}).exports.read as () => number;
      assert.equal(again(),42,'fresh guest memory still initializes');
    }
  } finally { Response.prototype.arrayBuffer = old; }
});

test('framing metadata is exact: fail before fetch for unknown version, gaps, duplication and bad bounds', async t => {
  const {asset} = fixture(t);
  assert.equal(aotFraming({size:1,bytes:1}),undefined,'old releases have no framing field');
  for (const bad of [
    (a: typeof asset) => { (a as {framing: unknown}).framing = null; },
    (a: typeof asset) => { (a.framing as {version: string}).version = 'future'; },
    (a: typeof asset) => { a.framing!.code[1]!.at += 1; },
    (a: typeof asset) => { a.framing!.code.splice(1,0,a.framing!.code[0]!); },
    (a: typeof asset) => { a.framing!.code[0]!.bytes = 2 ** 26; },
    (a: typeof asset) => { a.framing!.data[0]!.address = Number.MAX_SAFE_INTEGER; },
    (a: typeof asset) => { a.framing!.data[0]!.address = (2 ** 32) - 1; },
    (a: typeof asset) => { a.framing!.data[1]!.address = 4097; },
    (a: typeof asset) => { a.framing!.sharedHead!.bytes += 1; },
    (a: typeof asset) => { a.size += 1; },
    (a: typeof asset) => { a.bytes += 1; },
  ]) {
    const value = structuredClone(asset);
    bad(value);
    await assert.rejects(compileFramedAot(value, false, async () => {
      assert.fail('invalid layout must not fetch');
    }, forever()), /invalid framed AOT layout/);
  }
});

test('builder rejects overlapping valid Wasm initialization instead of changing reused guest bytes', t => {
  const dir = mkdtempSync(join(tmpdir(),'ricebox-overlap-aot-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const overlap = whole(4097);
  assert.equal(WebAssembly.validate(overlap),true);
  assert.throws(() => writeFramedAot(dir,overlap), /overlapping initial data/);
});

test('late corruption, truncation, trailing bytes, member reorder and decode overflow never return a module', async t => {
  const {asset, layout, body} = fixture(t);
  const damaged = Buffer.from(body);
  damaged[damaged.length-1] ^= 1;
  const swapped = Buffer.from(body);
  const head = layout.code[0]!, alt = layout.sharedHead!;
  const reordered = Buffer.concat([swapped.subarray(alt.at,alt.at+alt.size), swapped.subarray(0,head.size),
    swapped.subarray(alt.at + alt.size)]);
  const overflow = structuredClone(asset);
  overflow.framing!.data[0]!.bytes--;
  overflow.bytes--;
  const outside = structuredClone(asset);
  outside.framing!.data[0]!.address = 8300;

  for (const [what, stored, why] of [
    [asset, damaged, /member failed verification/],
    [asset, body.subarray(0,-1), /truncated/],
    [asset, Buffer.concat([body, Uint8Array.of(1)]), /exceeds its declared length/],
    [asset, reordered, /member failed verification/],
    [overflow, body, /exceeds its declared length/],
    [outside, body, /outside its image/],
  ] as const) {
    await assert.rejects(compileFramedAot(what, false, open(stored), forever()),why);
  }
});

test('no bytes from a wrong first frame reach the compiler', async t => {
  const {asset, body} = fixture(t);
  const corrupted = Buffer.from(body); corrupted[5] ^= 1;
  const real = WebAssembly.compileStreaming;
  let reaches = 0;
  WebAssembly.compileStreaming = async response => {
    const r = (await response).body!.getReader();
    try { if (!(await r.read()).done) reaches++; }
    finally { r.releaseLock(); }
    throw new Error('not an engine result');
  };
  try {
    await assert.rejects(compileFramedAot(asset,false,open(corrupted),forever()), /failed verification/);
    assert.equal(reaches,0);
  } finally { WebAssembly.compileStreaming = real; }
});

test('deployed reader coalesces and retirement drains an in-flight framed data read after compiling code', {timeout:5000}, async t => {
  const {asset, layout, body} = fixture(t);
  const real = globalThis.fetch, oldCompile = WebAssembly.compileStreaming;
  const compiled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let reads = 0, cancelled = 0, ready = 0, starts = 0;
  const dataStart = layout.data[0]!.at;
  globalThis.fetch = async () => {
    reads++;
    return new Response(new ReadableStream({
      start(c) { c.enqueue(body.subarray(0,dataStart)); },
      cancel() { cancelled++; },
    }));
  };
  WebAssembly.compileStreaming = async (...args) => {
    const module = await oldCompile(...args);
    compiled.resolve();
    return module;
  };
  const reader = deployedCode(new Map([['exact',{program:{path:'/bin/test',sha256:'a'.repeat(64),wasm:asset}}]]),
    'https://unused.test/', false, () => { ready++; }, () => { starts++; return {release:release.resolve}; });
  try {
    assert.equal(reader.take('exact'),undefined);
    assert.equal(reader.take('exact'),undefined);
    await compiled.promise;
    assert.equal(reader.reading(),1,'code alone must not publish an image');
    assert.equal(ready,0);
    reader.close();
    await release.promise;
    assert.equal(reader.take('exact'),null);
    assert.equal(reads,1);
    assert.equal(starts,1);
    assert.equal(cancelled,1);
    assert.equal(ready,0);
  } finally { reader.close(); globalThis.fetch = real; WebAssembly.compileStreaming = oldCompile; }
});

for (const sharded of [false,true]) test(`page startup and Worker admission bind a framed module to its image, sharded=${sharded}`, async t => {
  const {asset, body} = fixture(t, sharded);
  const empty = Uint8Array.of(0,97,115,109,1,0,0,0);
  const bytes = Uint8Array.of(127,69,76,70,1), path = '/usr/bin/program';
  const pack = packOf([bytes], b => createHash('sha256').update(b).digest());
  const blob = (b: Uint8Array) => ({size:b.length, sha256:sha(b), path:`blobs/${sha(b)}.bin`});
  const zipped = new Uint8Array(gzipSync(empty)), translator = {...blob(zipped), bytes:empty.length,
    name:'sods',version:'1',wasm:sha(empty)};
  const maker = blob(empty);
  const index: Index = {name:'fixture',version:'1',sha256:'a'.repeat(64),codec:'zstd',dirs:[],links:[],
    packs:[{name:pack.name,owner:'fixture',bytes:pack.bytes.length}],
    files:[{path,mode:0o755,size:bytes.length,pack:0,at:pack.at[0]!,len:bytes.length,raw:true}],
    translations:[],translator};
  const [source] = canonicalPackedFileSet(index,[path]);
  index.execution = {maker,programs:[{path,sha256:sha(bytes),wasm:asset,
    association:{version:1,mode:'whole',origin:source!.origin,sourceSha256:sha(bytes),sourceBytes:bytes.length}}]};
  const json = (v: unknown)=>new TextEncoder().encode(JSON.stringify(v));
  const indexBytes=json(index), hash=sha(indexBytes), descriptor={path:`index-${hash}.json`,sha256:hash,size:indexBytes.length};
  const assets = new Map<string,Uint8Array>([
    ['webroot.json',json({sha256:index.sha256,version:index.version,index:descriptor})],
    ['muk.json',json(maker)],[descriptor.path,indexBytes],
    [maker.path,empty],[translator.path,zipped],[asset.path,body],
  ]);
  const original = Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{value:new URL('https://unused.test/'),configurable:true});
  const requested:string[]=[];
  t.mock.method(globalThis,'fetch',async(url:string|URL|Request)=>{
    const name=new URL(String(url),'https://unused.test/').pathname.slice(1);
    requested.push(name);
    const b=assets.get(name);
    return b ? (name.endsWith('.json') ? new Response(Uint8Array.from(b),{headers:{'Content-Type':'application/json'}}) : streamed(b))
      : new Response(null,{status:404});
  });
  try {
    const root=createRoot({base:'/',first:[path],usedKey:'frame-test-used',planKey:'frame-test-plan',
      message:key=>key,missing:()=> 'missing',errorText:String});
    const prepared=await root.execution.load(), [exe]=prepared.executables;
    assert.ok(exe);
    assert.equal(validateExecutable(index,prepared.generation,exe).origin,source!.origin);
    assert.deepEqual(exe.segments!.map(p=>[p.offset,p.bytes.byteLength]),[[4096,3],[4100,1]]);
    assert.throws(()=>validateExecutable(index,prepared.generation,{...exe,segments:[...exe.segments!].reverse()}),/framed initial data/);
    assert.equal(requested.filter(n=>n===asset.path).length,1);
    assert.equal(requested.some(n=>n.startsWith('packs/')),false);
  } finally {
    if(original) Object.defineProperty(globalThis,'location',original);
    else Reflect.deleteProperty(globalThis,'location');
  }
});
