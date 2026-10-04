import {readFile} from 'node:fs/promises';
import {checkEngineConstruction} from '../../src/v2/vm/check/browser/engine-construction-check.mjs';
const [compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-engine-construction.mjs COMPILER.wasm');
console.log(JSON.stringify(await checkEngineConstruction(await readFile(compilerFile)),null,2));
