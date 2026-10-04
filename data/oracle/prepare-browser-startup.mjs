// Generate bounded diagnostic fixtures; never publish these as a machine artifact.
import {readFile,writeFile,mkdir,open,copyFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {decompressionOracle} from './decompression-oracle.mjs';

const [providerFile,compilerFile,directory,segmentFile,imageFile,targetDirectory,...extra] = process.argv.slice(2);
if (!directory || extra.length) throw new Error('usage: prepare-browser-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY [NATIVE-SEGMENTS [IMMUTABLE-SYSTEM-IMAGE [NEW-OUTPUT-DIRECTORY]]]');
if (imageFile && !targetDirectory) throw new Error('image attachment requires a fresh explicit output; do not replace a retained Worker fixture');
const target = targetDirectory ? path.resolve(targetDirectory)
  : fileURLToPath(new URL('../../src/v2/vm/check/browser/generated-startup/',import.meta.url));
const files = ['boot.header','boot.command','boot.kernel-page','boot.kernel-last-page',
  'boot.state','boot.segments','boot.json','call.extra-page','cmdline.extra-page','option.extra-page','source.sha256'];
// An explicit new output is isolated from any retained Worker's fixture owner.
// Refuse existing output instead of silently replacing an active diagnostic.
await mkdir(target,{recursive:!targetDirectory});
const manifest = {format:'bzimage-startup-diagnostic-v1',linuxBoot:'not-achieved',files:{}};
manifest.objects = {};
const objects=[[2,'boot.kernel-object',path.join(directory,'boot.kernel-object')],
  [3,'boot.initramfs-object',path.join(directory,'boot.initramfs-object')]];
if (imageFile) objects.push([5,'boot.system-object',imageFile]);
for (const [kind,name,source] of objects) {
  const sourceSize=(await stat(source)).size;
  if (!Number.isSafeInteger(sourceSize) || sourceSize<1 || (kind===5 && sourceSize>0x10000000))
    throw new Error('diagnostic object extent before copy');
  await copyFile(source,path.join(target,name));
  const file=await open(path.join(target,name),'r'), chunkBytes=65536;
  try {
    const size=(await file.stat()).size, buffer=Buffer.alloc(chunkBytes), hash=createHash('sha256');
    if (!Number.isSafeInteger(size) || size<1 || (kind===5 && size>0x10000000)) throw new Error('diagnostic object extent');
    const row={name,bytes:size,chunkBytes,chunks:[]};
    for (let at=0;at<size;at+=chunkBytes) {
      const length=Math.min(chunkBytes,size-at);
      if ((await file.read(buffer,0,length,at)).bytesRead!==length) throw new Error('short immutable object');
      const bytes=buffer.subarray(0,length); hash.update(bytes);
      row.chunks.push(createHash('sha256').update(bytes).digest('hex'));
    }
    row.sha256=hash.digest('hex'); manifest.objects[kind]=row;
    if (kind===5) manifest.immutableImage={address:'0x30000000',bytes:size};
  } finally { await file.close(); }
}
for (const name of ['vm.wasm','wasm-compiler.wasm',...files]) {
  const source = name === 'vm.wasm' ? providerFile : name === 'wasm-compiler.wasm' ? compilerFile
    : name === 'boot.segments' && segmentFile ? segmentFile
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
