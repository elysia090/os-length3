// Generate bounded diagnostic fixtures; never publish these as a machine artifact.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: prepare-browser-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY');
const target = fileURLToPath(new URL('../../src/v2/vm/check/browser/generated-startup/',import.meta.url));
const files = ['boot.header','boot.command','boot.kernel-page','boot.kernel-last-page',
  'boot.state','boot.segments','boot.json','call.extra-page','source.sha256'];
for (const prefix of ['kernel','after-return','idt']) {
  const name = `${prefix}.summary.json`;
  const summary = JSON.parse(await readFile(path.join(directory,name)));
  files.push(name,...summary.cuts.map(cut => cut.rank ? `${prefix}.${cut.rank}.wasm` : `${prefix}.wasm`));
}
await mkdir(target,{recursive:true});
const manifest = {format:'bzimage-startup-diagnostic-v1',linuxBoot:'not-achieved',files:{}};
for (const name of ['vm.wasm','wasm-compiler.wasm',...files]) {
  const source = name === 'vm.wasm' ? providerFile : name === 'wasm-compiler.wasm' ? compilerFile
    : path.join(directory,name);
  const bytes = await readFile(source);
  manifest.files[name] = {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(path.join(target,name),bytes);
}
await writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2) + '\n');
console.log(`${files.length} bounded startup fixtures prepared; NOT Linux boot`);
