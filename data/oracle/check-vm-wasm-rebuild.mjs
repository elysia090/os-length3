// Same output path, real compiler, exact exports and unchanged-command reuse.
// This verifies build identity, not Linux execution or a performance claim.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const [make,clang]=process.argv.slice(2);
if(!clang)throw new Error('usage: check-vm-wasm-rebuild.mjs MAKE_EXECUTABLE WASM_CLANG');
const root=fileURLToPath(new URL('../../',import.meta.url));
const scratch=await mkdtemp(join(root,'temp/vm-wasm-flags-'));
const output=join(scratch,'vm.wasm').replaceAll('\\','/');
const command=promisify(execFile),profileExports=[
  'vm_source_profile','vm_system_profile','vm_system_profile_path','vm_system_path_word',
];
async function build(profile){
  const result=await command(resolve(make),['-C','src/v2/vm','wasm',
    `WASM_OUTPUT=${output}`,`WASM_CC=${resolve(clang).replaceAll('\\','/')}`,
    `WASM_PROFILE=${profile}`],{cwd:root,maxBuffer:2**20,timeout:60000});
  assert.equal(result.stderr,'','successful build must not hide a failed stamp comparison');
  const bytes=await readFile(output),module=new WebAssembly.Module(bytes);
  const names=new Set(WebAssembly.Module.exports(module).map(row=>row.name));
  for(const name of profileExports)assert.equal(names.has(name),!!profile,`${name}: profile ${profile}`);
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
  return {bytes,mtime:(await stat(output,{bigint:true})).mtimeNs};
}
const production=await build(0),profile=await build(1);
assert.notDeepEqual(profile.bytes,production.bytes,'profile switch must rebuild the same output path');
const repeated=await build(1);
assert.deepEqual(repeated.bytes,profile.bytes);
assert.equal(repeated.mtime,profile.mtime,'unchanged command must retain the existing output');
const restored=await build(0);
assert.deepEqual(restored.bytes,production.bytes,'return to production must remove all diagnostic exports');
const final=await build(0);
assert.equal(final.mtime,restored.mtime);
console.log(JSON.stringify({status:'pass',productionBytes:production.bytes.length,
  profileBytes:profile.bytes.length,output,switches:2,unchangedBuilds:2,
  scope:'real 0/1/0 profile builds at one path, exact imports/exports, deterministic bytes and no unnecessary unchanged-command compilation'}));
