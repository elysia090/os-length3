// Publish only local diagnostic fixtures, not a Linux/signed delivery root.
import {readFile,readdir,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkImageAdmission} from '../../src/v2/vm/check/browser/image-admission-check.mjs';
const [vm,compiler,multiElf,multiDirectory,crossElf,crossDirectory,fpuElf,fpuDirectory]=process.argv.slice(2);
if(!crossDirectory)throw new Error('VM.WASM COLD.WASM MULTI.elf DIRECTORY CROSS.elf CROSS-DIRECTORY');
const output=resolve(dirname(fileURLToPath(import.meta.url)),'../../src/v2/vm/check/browser/generated/image-admission');
if(Boolean(fpuElf)!==Boolean(fpuDirectory))throw new Error('both FPU diagnostic ELF/directory required');
const cases=[['multi',multiElf,multiDirectory],['cross',crossElf,crossDirectory],...(fpuElf?[['fpu',fpuElf,fpuDirectory]]:[])];
// Before any staged file is changed, require the SAME C source/module
// admission/execution gate. An older authenticated directory can still lack
// the execution admission witness; hashes alone cannot make it usable.
const [vmBytes,compilerBytes]=await Promise.all([vm,compiler].map(file=>readFile(file)));
for(const [name,elf,directory] of cases){
  const [elfBytes,root]=await Promise.all([elf,resolve(directory,'root-ref')].map(file=>readFile(file)));
  const result=await checkImageAdmission(vmBytes,compilerBytes,elfBytes,root,key=>{
    if(!/^[0-9a-f]{64}$/.test(key))throw new Error('C object identity');
    return readFile(resolve(directory,key));
  });
  if(result.status!=='pass'||result.executionCompilerCalls!==0)throw new Error(`${name}: candidate admission refused`);
}
const files={};
async function copy(name,input){
  const bytes=await readFile(input);
  files[name]={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const target=resolve(output,name);await mkdir(dirname(target),{recursive:true});await copyFile(input,target);
}
await copy('vm.wasm',vm);await copy('compiler.wasm',compiler);
for(const [name,elf,directory] of cases){
  await copy(`${name}.elf`,elf);
  for(const file of await readdir(directory)){
    if(file!=='root-ref' && !/^[0-9a-f]{64}$/.test(file))throw new Error('unexpected diagnostic directory file');
    await copy(`${name}/${file}`,resolve(directory,file));
  }
}
await writeFile(resolve(output,'manifest.json'),JSON.stringify({format:'c-image-admission-diagnostic-v1',linuxBoot:'not-tested',cases:cases.map(([name])=>name),files})+'\n');
console.log(`Prepared local C image admission diagnostic: ${output}`);
