// Independent before/after byte equality and cold compiler cost only.
// No guest instruction execution, checkpoint restore or Linux boot claim.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [beforeFile,afterFile,...extra]=process.argv.slice(2);
if(!afterFile||extra.length)throw new Error('usage: check-flag-frontier.mjs BEFORE.wasm AFTER.wasm');
async function compiler(file) {
  const bytes=await readFile(file),memory=new WebAssembly.Memory({initial:16});
  const exports=(await WebAssembly.instantiate(bytes,{machine:{memory}})).instance.exports;
  const arena=exports.compiler_arena_min(),output=arena+8192,report=output+65536;
  const data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
  return {bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),data,view,arena,output,report,exports};
}
const before=await compiler(beforeFile),after=await compiler(afterFile),entry=0x400000n;
const operations=[
  [0x90],[0x31,0xc0],[0x11,0xd8],[0x19,0xc1],[0xd3,0xe0],
  [0xc1,0xe0,0],[0xc1,0xe0,1],[0xf8],[0xf9],[0xfc],[0xfd],
  [0x0f,0x94,0xc0],[0x0f,0x4c,0xc1],[0x0f,0xbc,0xc1],[0x0f,0xaf,0xc1],
  [0x0f,0x90,0xc0],[0x0f,0x92,0xc0],[0x0f,0x96,0xc0],
  [0x0f,0x98,0xc0],[0x0f,0x9a,0xc0],[0x0f,0x9e,0xc0],
];
function code(length,rotation) {
  const page=Buffer.alloc(4096,0xcc);let at=0;
  for(let rank=0;rank<length;++rank){const instruction=operations[(rank+rotation)%operations.length];page.set(instruction,at);at+=instruction.length;}
  return page;
}
function open(owner,page) {
  owner.data.set(page,owner.arena);
  assert.equal(owner.exports.compiler_open_pages(owner.arena,1,entry,9n),0);
}
function emit(owner,length) {
  return owner.exports.compiler_emit(entry,length,owner.output,65536,owner.report);
}
let comparisons=0,sourceInstructions=0;
for(let length=1;length<=1024;length*=2)for(let rotation=0;rotation<operations.length;++rotation) {
  const page=code(length,rotation);
  for(const owner of [before,after]){open(owner,page);assert.equal(emit(owner,length),0);}
  assert(before.data.subarray(before.report,before.report+80).equals(after.data.subarray(after.report,after.report+80)),`complete report ${length}/${rotation}`);
  const bytes=Number(before.view.getBigUint64(before.report+40,true));
  assert(before.data.subarray(before.output,before.output+bytes).equals(after.data.subarray(after.output,after.output+bytes)),`whole module ${length}/${rotation}`);
  ++comparisons;sourceInstructions+=length;
}
const timing=[];
for(const length of [1,8,64]) {
  const page=code(length,2);
  for(const owner of [before,after]){open(owner,page);for(let warm=0;warm<256;++warm)assert.equal(emit(owner,length),0);}
  for(let trial=0;trial<8;++trial) {
    const row={length,trial,iterations:1000};
    for(const [name,owner]of trial%2?[['after',after],['before',before]]:[['before',before],['after',after]]) {
      const start=performance.now();
      for(let repeat=0;repeat<row.iterations;++repeat)assert.equal(emit(owner,length),0);
      row[name+'Ms']=performance.now()-start;
    }
    timing.push(row);
  }
}
for(const owner of [before,after])owner.exports.compiler_close();
console.log(JSON.stringify({format:'cold-flag-frontier-v1',status:'pass',linuxBoot:'not-tested',
  before:{bytes:before.bytes,sha256:before.sha256},after:{bytes:after.bytes,sha256:after.sha256},
  exactModuleAndReportComparisons:comparisons,comparedSourceInstructions:sourceInstructions,
  timing,scope:'alternating concurrent Node compiler micro measurements, not guest execution or isolated browser/Linux speedup'},null,2));
