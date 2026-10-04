// Reject ambiguous diagnostic flags before opening any executable/input file.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./check-wasm-startup.mjs',import.meta.url));
let refusals=0;
for (const flags of [['--unknown'],['--extended','--extended'],['--progress','--progress'],
    ['--segments=a','--segments=b'],['--image=a','--image=b'],['--segments='],['--image=']]) {
  const result=spawnSync(process.execPath,[script,'unused-vm','unused-compiler','unused-directory',...flags],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,1); assert.match(result.stderr,/usage:|empty independent fixture path/);
  assert.doesNotMatch(result.stderr,/ENOENT/); assert.equal(result.stdout,''); ++refusals;
}
console.log(`Startup diagnostic CLI: ${refusals} malformed/duplicate/empty-path refusals before I/O; not Linux boot`);
