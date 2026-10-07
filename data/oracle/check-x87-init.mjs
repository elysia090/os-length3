import {checkRegisterRecords} from './check-register-records.mjs';
const [providerFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('usage: check-x87-init.mjs VM.WASM COMPILER.WASM NATIVE-RECORDS');
const result=await checkRegisterRecords({providerFile,compilerFile,directory,prefix:'x87-init',forms:8,
  faultMasks:[4n,8n,12n].map(mask=>({offset:400,mask,vector:7})),
  refusedSources:[[0xf0,0xdb,0xe3],[0x9b,0xdb,0xe3],[0xd9,0x2f]]});
console.log(JSON.stringify({format:'c-wasm-x87-init-native-v1',...result,
  oracle:'actual x86 GPR/flags/x87/XMM/MXCSR; CR0.EM/TS faults are models; not physical hardware'},null,2));
