import {readFile,open} from 'node:fs/promises';
import path from 'node:path';
import {checkStartup} from '../../src/v2/vm/check/browser/startup-check.mjs';

const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-wasm-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY');
async function extent(kind,offset,bytes) {
  const name = kind === 2 ? 'boot.kernel-object' : kind === 3 ? 'boot.initramfs-object' : null;
  if (!name || offset < 0 || bytes < 1 || bytes > 4096) throw new Error('C extent shape');
  const file = await open(path.join(directory,name),'r');
  try {
    const result = Buffer.alloc(bytes);
    const {bytesRead} = await file.read(result,0,bytes,offset);
    if (bytesRead !== bytes) throw new Error('short C extent');
    return result;
  } finally { await file.close(); }
}
console.log(JSON.stringify(await checkStartup(name => readFile(path.join(directory,name)),
  await readFile(providerFile),await readFile(compilerFile),extent),null,2));
