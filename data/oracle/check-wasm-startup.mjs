import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {checkStartup} from '../../src/v2/vm/check/browser/startup-check.mjs';

const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-wasm-startup.mjs VM.WASM COMPILER.WASM BUNDLE-PREFIX-DIRECTORY');
console.log(JSON.stringify(await checkStartup(name => readFile(path.join(directory,name)),
  await readFile(providerFile),await readFile(compilerFile)),null,2));
