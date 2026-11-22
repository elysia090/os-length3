import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import {createRoot} from '../root.ts';
import {packOf} from '../../format/pack.ts';
import {canonicalExecutableSource} from '../../format/executable-source.ts';
import {canonicalHotSources, executableKey, validateExecutable} from '../prepared-executable.ts';
import {createExecutionProfile} from '../execution-profile.ts';
import type {About, Blob, Index, PreparedExecutable, PreparedRoot, Translation} from '../root-types.ts';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const digest = (bytes: Uint8Array) => new Uint8Array(createHash('sha256').update(bytes).digest());
const encode = (text: string) => new TextEncoder().encode(text);
const empty = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
function fixture(image = empty) {
  const assets = new Map<string, Uint8Array>();
  const blob = (bytes: Uint8Array): Blob => { const stored = new Uint8Array(gzipSync(bytes)); const sha256 = hash(stored), path = `blobs/${sha256}.bin`; assets.set(path, stored); return {path, sha256, size: stored.length, bytes: bytes.length}; };
  const source = Uint8Array.of(127,69,76,70,7), pack = packOf([source], digest);
  assets.set('packs/' + pack.name, pack.bytes);
  const translation: Translation = {path: '/usr/bin/program', sha256: hash(source), elf: blob(source), wasm: blob(image)};
  const index: Index = {name: 'fixture', version: '1', sha256: 'a'.repeat(64), codec: 'zstd',
    packs: [{name: pack.name, owner: 'fixture', bytes: pack.bytes.length}], dirs: [], links: [],
    files: [{path: translation.path, mode: 0o755, size: source.length, pack: 0, at: pack.at[0]!, len: source.length, raw: true}],
    translations: [translation], translator: {...blob(empty), name: 'sods', version: 'fixture', wasm: hash(empty)}};
  function publish() {
    const bytes = encode(JSON.stringify(index)), sha256 = hash(bytes), path = `index-${sha256}.json`;
    assets.set(path, bytes);
    const about: About = {name: 'fixture', version: '1', sha256: index.sha256, bytes: 0, file: 'root.tar.zst',
      root: {name: 'fixture', profile: 'fixture'}, index: {path, sha256, size: bytes.length}, translator: {name: 'sods', version: 'fixture'}};
    assets.set('webroot.json', encode(JSON.stringify(about)));
    return about;
  }
  return {assets, source, translation, index, publish};
}
function context(f: ReturnType<typeof fixture>) {
  const about = f.publish(), source = canonicalExecutableSource(f.index, f.translation), shared = false;
  const value: PreparedExecutable = {generation: about.index.sha256, key: executableKey(about.index.sha256, source, f.translation, f.index.translator.sha256, shared),
    path: source.path, source, artifact: {sha256: f.translation.wasm.sha256, translator: f.index.translator.sha256, mode: 'whole'}, module: new WebAssembly.Module(empty), segments: [], shared};
  const base: Omit<PreparedRoot, 'executables'> = {profile: 'canonical-aot-v1', generation: about.index.sha256, about, index: f.index, translator: new WebAssembly.Module(empty), url: 'https://fixture.test/', muk: null};
  return {base, value};
}

test('prepared loader defers ELF independently of legacy files; verified compile failure alone falls back', async t => {
  for (const image of [empty, Uint8Array.of(1,2,3)]) await t.test(image === empty ? 'compiled' : 'compile fallback', async () => {
    const f = fixture(image); f.publish(); const asked: string[] = [];
    const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', {value: new URL('https://fixture.test/'), configurable: true});
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const path = new URL(String(input), 'https://fixture.test/').pathname.slice(1); asked.push(path);
      const bytes = f.assets.get(path); return new Response(bytes ? new Uint8Array(bytes) : undefined, {status: bytes ? 200 : 404});
    });
    try {
      const root = createRoot({base: '/', first: [f.translation.path], usedKey: 'test-used', planKey: 'test-plan', message: key => key, missing: () => 'missing', errorText: String});
      const stages: string[] = [], unwatch = root.watchLoad(stage => stages.push(stage.at));
      const first = root.execution.load();
      assert.equal(root.execution.load(), first);
      const prepared = await first;
      unwatch();
      assert.equal(stages.at(-1), 'ready');
      assert.equal(stages.filter(stage => stage === 'ready').length, 1);
      assert.equal('files' in prepared, false); assert.equal(prepared.executables.length, image === empty ? 1 : 0);
      assert.equal(asked.includes(f.translation.elf.path), false); assert.equal(asked.some(path => path.startsWith('packs/')), false);
      assert.deepEqual(root.execution.executablesNow(prepared), prepared.executables.map(value => ({...value, more: []})));
      const legacy = await root.loadWebroot();
      assert.deepEqual(legacy.files[0]!.bytes, f.source); assert.equal(asked.includes(f.translation.elf.path), true);
      assert.deepEqual(root.filesNow(legacy)[0]!.bytes, f.source);
    } finally { if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else Reflect.deleteProperty(globalThis, 'location'); t.mock.restoreAll(); }
  });
});

test('prepared integrity/decode failure rejects instead of turning into source fallback', async t => {
  const f = fixture();
  // Authenticate a non-gzip body successfully: the subsequent verified decode
  // failure must propagate, not take the compile-only fallback route.
  const stored = Uint8Array.of(1,2,3,4); f.translation.wasm = {path: `blobs/${hash(stored)}.bin`, sha256: hash(stored), size: stored.length, bytes: empty.length};
  f.assets.set(f.translation.wasm.path, stored); f.publish(); const asked: string[] = [];
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {value: new URL('https://fixture.test/'), configurable: true});
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => { const path = new URL(String(input), 'https://fixture.test/').pathname.slice(1); asked.push(path); const bytes = f.assets.get(path); return new Response(bytes ? new Uint8Array(bytes) : undefined, {status: bytes ? 200 : 404}); });
  try {
    const root = createRoot({base: '/', first: [f.translation.path], usedKey: 'test-used', planKey: 'test-plan', message: key => key, missing: () => 'missing', errorText: String});
    await assert.rejects(root.execution.load()); assert.equal(asked.includes(f.translation.elf.path), false);
  } finally { if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation); else Reflect.deleteProperty(globalThis, 'location'); }
});

test('same inode hardlink hot records deduplicate; conflicting source/artifact records fail before association', async () => {
  const f = fixture(), alias = '/usr/bin/alias';
  f.index.files.push({...f.index.files[0]!, path: alias});
  f.index.translations.push({...f.translation, path: alias});
  assert.equal(canonicalHotSources(f.index).length, 1);
  const {base, value} = context(f);
  const result = {value, moreURL: '/more', reached: []};
  const profile = createExecutionProfile({first: [f.translation.path, alias], load: async () => ({base, initial: [result, result]}),
    async executable() { throw new Error('initial artifacts are already prepared'); }, worker() { throw new Error('unused'); }, save() {}});
  const root = await profile.load(); assert.equal(root.executables.length, 1); assert.equal(profile.executablesNow(root).length, 1);
  f.index.translations[1] = {...f.index.translations[1]!, wasm: {...f.translation.wasm, sha256: 'b'.repeat(64)}};
  assert.throws(() => canonicalHotSources(f.index), /Conflicting/);
});

test('wire validation refuses same-size wrong source, foreign generation and changed artifact identity', () => {
  const f = fixture(), {base, value} = context(f);
  assert.equal(validateExecutable(f.index, base.generation, value).origin, value.source.origin);
  for (const wrong of [{...value, generation: 'b'.repeat(64)}, {...value, source: {...value.source, origin: 'wrong'}},
    {...value, source: {...value.source, sha256: 'b'.repeat(64)}}, {...value, artifact: {...value.artifact, sha256: 'b'.repeat(64)}}])
    assert.throws(() => validateExecutable(f.index, base.generation, wrong), /match/);
});

test('profile does not publish failed warming and keeps extras/spares generation scoped', async () => {
  const f = fixture(), {base, value} = context(f), sent: unknown[] = [], saves: unknown[] = [], calls: string[] = [];
  f.index.translations.push({...f.translation, path: '/later'});
  let fail = true;
  const worker = {postMessage(message: unknown) { sent.push(message); }, addEventListener() {}, removeEventListener() {}, terminate() {}} as unknown as Worker;
  const profile = createExecutionProfile({first: [f.translation.path], load: async () => ({base, initial: [{value, moreURL: '/more', reached: []}]}),
    worker: () => worker, save: entry => saves.push(entry),
    executable: async (_root, translation) => { calls.push(translation.path); if (fail) throw new Error('integrity failure'); return null; }});
  const root = await profile.load(), heard: PreparedExecutable[] = []; profile.hearLater(value => heard.push(value));
  assert.deepEqual(calls, []);
  const warming = profile.warm(root);
  assert.equal(profile.warm(root), warming);
  await assert.rejects(warming, /integrity/); assert.equal(profile.failures.length, 1); assert.deepEqual(heard, []);
  assert.deepEqual(calls, ['/later']);
  profile.keepMore(root, value.path, 0, [{module: value.module, bytes: empty, base: 0}]); assert.equal(saves.length, 1);
  assert.equal(profile.executablesNow(root)[0]!.more!.length, 1);
  profile.readyWorker(root, {config: '{}', words: []});
  const ready = profile.takeReady()!; assert.equal(ready.generation, root.generation); assert.deepEqual([...ready.givenExecutables], [value.key]);
  assert.equal(profile.takeReady(), null); assert.equal((sent[1] as {profile: string}).profile, 'canonical-aot-v1');
  assert.throws(() => profile.executablesNow({...root}), /another execution profile/); fail = false;
});

test('authenticated download checksum mismatch never becomes compile fallback or an ELF request', {timeout:30_000}, async t => {
  const f=fixture(),stored=f.assets.get(f.translation.wasm.path)!.slice();stored[stored.length-1]^=1;
  f.assets.set(f.translation.wasm.path,stored);f.publish();const asked:string[]=[];
  const previousLocation=Object.getOwnPropertyDescriptor(globalThis,'location');Object.defineProperty(globalThis,'location',{value:new URL('https://checksum.test/'),configurable:true});
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request)=>{const path=new URL(String(input),'https://checksum.test/').pathname.slice(1);asked.push(path);const bytes=f.assets.get(path);return new Response(bytes?new Uint8Array(bytes):undefined,{status:bytes?200:404});});
  try{
    const root=createRoot({base:'/',first:[f.translation.path],usedKey:'checksum-used',planKey:'checksum-plan',message:key=>key,missing:()=> 'missing',errorText:String});
    await assert.rejects(root.execution.load(),/Content mismatch/);assert.equal(asked.includes(f.translation.elf.path),false);
  }finally{if(previousLocation)Object.defineProperty(globalThis,'location',previousLocation);else Reflect.deleteProperty(globalThis,'location');}
});
