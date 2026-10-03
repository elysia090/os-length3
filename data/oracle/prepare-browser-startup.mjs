// Generate bounded diagnostic fixtures; never publish these as a machine artifact.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decompressionOracle} from './decompression-oracle.mjs';

const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: prepare-browser-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY');
const target = fileURLToPath(new URL('../../src/v2/vm/check/browser/generated-startup/',import.meta.url));
const files = ['boot.header','boot.command','boot.kernel-page','boot.kernel-last-page',
  'boot.state','boot.segments','boot.json','call.extra-page','cmdline.extra-page','option.extra-page','source.sha256'];
await mkdir(target,{recursive:true});
const manifest = {format:'bzimage-startup-diagnostic-v1',linuxBoot:'not-achieved',files:{}};
manifest.objects = {};
for (const [kind,name] of [[2,'boot.kernel-object'],[3,'boot.initramfs-object']]) {
  const bytes = await readFile(path.join(directory,name)), chunkBytes = 65536;
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  manifest.objects[kind] = {name,bytes:bytes.length,sha256:sha256(bytes),chunkBytes,chunks:[]};
  for (let at = 0; at < bytes.length; at += chunkBytes)
    manifest.objects[kind].chunks.push(sha256(bytes.subarray(at,at + chunkBytes)));
  await writeFile(path.join(target,name),bytes);
}
for (const name of ['vm.wasm','wasm-compiler.wasm',...files]) {
  const source = name === 'vm.wasm' ? providerFile : name === 'wasm-compiler.wasm' ? compilerFile
    : path.join(directory,name);
  const bytes = await readFile(source);
  manifest.files[name] = {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  await writeFile(path.join(target,name),bytes);
}
const observation = Buffer.from(JSON.stringify(decompressionOracle(
  await readFile(path.join(directory,'boot.kernel-object')))) + '\n');
manifest.files['boot.decompression.json'] = {bytes:observation.length,
  sha256:createHash('sha256').update(observation).digest('hex')};
await writeFile(path.join(target,'boot.decompression.json'),observation);
await writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2) + '\n');
console.log(`${files.length + 1} bounded startup fixtures prepared; NOT Linux boot`);
