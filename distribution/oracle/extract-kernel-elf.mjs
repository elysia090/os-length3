// Read-only diagnostic extraction. These bytes NEVER become guest RAM/state.
import {readFile,writeFile,realpath} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {shippedKernelElf} from './decompression-oracle.mjs';
const [input,identity,output]=process.argv.slice(2);if(!output)throw new Error('KERNEL TRUSTED-SHA256 NEW-TEMP-ELF');
const repo=await realpath(fileURLToPath(new URL('../..',import.meta.url))),target=path.resolve(output);
if(!target.startsWith(path.join(repo,'temp')+path.sep))throw new Error('diagnostic output below repository temp');
const elf=shippedKernelElf(await readFile(input),identity);await writeFile(target,elf,{flag:'wx'});
console.log(`${elf.length} verified diagnostic ELF bytes; no runtime injection`);
