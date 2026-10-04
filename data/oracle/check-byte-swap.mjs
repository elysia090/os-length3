import {checkRegisterRecords} from './check-register-records.mjs';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-byte-swap.mjs VM.WASM COMPILER.WASM BSWAP-FIXTURE-DIRECTORY');
const result=await checkRegisterRecords({providerFile,compilerFile,directory,prefix:'byte-swap',forms:96,
  refusedSources:[[0xf0,0x0f,0xcf],[0x66,0x0f,0xcf],[0xf0,0x48,0x0f,0xcf]]});
console.log(JSON.stringify({format:'c-wasm-byte-swap-native-v1',...result},null,2));
