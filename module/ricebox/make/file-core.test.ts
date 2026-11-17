import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {fileCoreOptions, validateFileCore, fileCoreDescriptor, FILE_CORE_LIMIT} from './file-core.ts';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
test('file core selection is explicit and preserves other builder arguments', () => {
  const legacy = ['root', 'out', '--translator', 'translator'];
  assert.equal(fileCoreOptions(legacy), null); assert.deepEqual(legacy, ['root', 'out', '--translator', 'translator']);
  const args = ['root', '--file-core', 'core.wasm', 'out', '--file-core-limit', '64'];
  assert.deepEqual(fileCoreOptions(args), {path:'core.wasm', maxFileBytes:64}); assert.deepEqual(args, ['root','out']);
  assert.deepEqual(fileCoreOptions(['--file-core','core.wasm']), {path:'core.wasm',maxFileBytes:FILE_CORE_LIMIT});
  assert.equal(fileCoreOptions(['--file-core','core.wasm','--file-core-limit','0'])!.maxFileBytes,0);
});
test('malformed explicit flags never silently omit the core', () => {
  for (const args of [['--file-core'], ['--file-core','--hot','/bin/sh'], ['--file-core-limit','5'],
    ['--file-core','a','--file-core','b'], ['--file-core','a','--file-core-limit','2','--file-core-limit','3'],
    ...['-1','2.5','2147483648','NaN','1e3',''].map(x=>['--file-core','a','--file-core-limit',x])]) {
    assert.throws(()=>fileCoreOptions(args));
  }
});
test('invalid modules and imported capabilities fail validation', async () => {
  await assert.rejects(validateFileCore(Uint8Array.of(1,2,3),8));
  await assert.rejects(validateFileCore(Uint8Array.of(0,97,115,109,1,0,0,0),8), /exports/);
  const imported = Uint8Array.of(0,97,115,109,1,0,0,0, 1,4,1,0x60,0,0, 2,7,1,1,101,1,102,0,0);
  await assert.rejects(validateFileCore(imported,8), /import/);
});
test('real core descriptor binds compressed and expanded bytes and selected limit', {skip:!process.env.SODS_CORE_WASM}, async () => {
  const input = readFileSync(process.env.SODS_CORE_WASM!);
  const core = await validateFileCore(input,64); let calls=0;
  const descriptor = fileCoreDescriptor(core,bytes=>{
    calls++; const gz=gzipSync(bytes,{level:9}), sha=hash(gz);
    assert.deepEqual(gunzipSync(gz),input);
    return {path:`blobs/${sha}.bin`,sha256:sha,size:gz.length,bytes:bytes.length};
  });
  assert.equal(calls,1);assert.equal(descriptor.abi,4);assert.equal(descriptor.maxFileBytes,64);
  assert.equal(descriptor.wasm,hash(input));assert.equal(descriptor.bytes,input.length);
  const index=JSON.stringify({fileCore:descriptor});
  assert.notEqual(hash(Buffer.from(index)),hash(Buffer.from(JSON.stringify({fileCore:{...descriptor,maxFileBytes:65}}))));
  await validateFileCore(input,0);
});
test('matching export names do not excuse an older ABI', {skip:!process.env.SODS_CORE_WASM}, async () => {
  const actual = new WebAssembly.Module(readFileSync(process.env.SODS_CORE_WASM!));
  const names = WebAssembly.Module.exports(actual).filter(x=>x.kind==='function').map(x=>x.name);
  const leb = (value:number):number[] => { const out:number[]=[]; do {const b=value&127;value>>>=7;out.push(b|(value?128:0));} while(value);return out; };
  const str = (value:string) => {const b=[...new TextEncoder().encode(value)];return [...leb(b.length),...b];};
  const section = (id:number,b:number[])=>[id,...leb(b.length),...b];
  const bytes = Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,0x7f]), ...section(3,[1,0]), ...section(5,[1,0,1]),
    ...section(7,[...leb(names.length+1),...str('memory'),2,0,...names.flatMap(n=>[...str(n),0,0])]),
    ...section(10,[1,4,0,0x41,3,0x0b]),
  ]);
  await assert.rejects(validateFileCore(bytes,8),/Unsupported core files ABI/);
});
