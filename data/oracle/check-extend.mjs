import {checkRegisterRecords} from './check-register-records.mjs';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-extend.mjs VM.WASM COMPILER.WASM EXTEND-FIXTURE-DIRECTORY');
const result=await checkRegisterRecords({providerFile,compilerFile,directory,prefix:'extend',forms:18});
console.log(JSON.stringify({format:'c-wasm-sign-extension-native-v1',...result},null,2));
