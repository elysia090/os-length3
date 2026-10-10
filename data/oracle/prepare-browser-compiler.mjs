// Construction-only diagnostic replacement; never replace a live fixture.
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const [compilerFile,name]=process.argv.slice(2);
if(!compilerFile||!/^generated-startup-[a-z0-9-]+$/.test(name??'')||name.length>80)
  throw new Error('COMPILER.WASM NEW-GENERATED-STARTUP-NAME');
const bytes=await readFile(compilerFile);
if(bytes.length<8||bytes.length>4194304||!bytes.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])))
  throw new Error('bounded ordinary Wasm compiler');
const target=fileURLToPath(new URL(`../../src/v2/vm/check/browser/${name}/`,import.meta.url));
await mkdir(target); // Fresh owner only; do not overwrite retained inputs.
await copyFile(compilerFile,path.join(target,'wasm-compiler.wasm'));
const manifest={format:'bzimage-startup-diagnostic-v1',linuxBoot:'not-tested',files:{
  'wasm-compiler.wasm':{bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
}};
await writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({fixture:name,...manifest.files['wasm-compiler.wasm']}));
