import {checkRegisterRecords} from './check-register-records.mjs';
const [providerFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
console.log(JSON.stringify({format:'native-flags-low-c-v1',...await checkRegisterRecords({providerFile,compilerFile,directory,prefix:'flags-low',forms:168})},null,2));
