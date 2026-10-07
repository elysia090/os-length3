// The same bounded diagnostic runs unchanged in Node and a browser Worker.
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {checkImageAdmission} from '../../src/v2/vm/check/browser/image-admission-check.mjs';
const [vm,compiler,elf,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COLD.WASM VERIFIED.elf NATIVE-DIRECTORY');
const [vmBytes,compilerBytes,elfBytes,root]=await Promise.all([vm,compiler,elf,path.join(directory,'root-ref')].map(file=>readFile(file)));
const result=await checkImageAdmission(vmBytes,compilerBytes,elfBytes,root,name=>{
  if(!/^[0-9a-f]{64}$/.test(name))throw new Error('C object identity');
  return readFile(path.join(directory,name));
});
console.log(JSON.stringify(result,null,2));
