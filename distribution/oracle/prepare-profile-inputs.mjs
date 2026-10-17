// Produce fresh independent GNU-assembler inputs; never overwrite a receipt.
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {inputs,catalog} from './x86-profile-inputs.mjs';
const [asArg,objcopyArg,nmArg,workArg,...extra]=process.argv.slice(2);
if(!workArg || extra.some(x=>x!=='--boundary') || extra.length>1)
  throw new Error('AS OBJCOPY NM NEW-TEMP-DIRECTORY [--boundary]');
const repo=await realpath(new URL('../..',import.meta.url)),work=path.resolve(workArg);
if(!work.startsWith(path.join(repo,'temp')+path.sep))throw new Error('fresh directory below repository temp required');
await mkdir(work);
const run=(program,args)=>{const r=spawnSync(program,args,{windowsHide:true,encoding:'utf8',maxBuffer:64*1024*1024});
  if(r.error||r.status!==0)throw new Error(`${program}: ${r.error?.message??r.stderr}`);return r.stdout;};
const records=Array.from(inputs({full:!extra.length}));
const source=['.intel_syntax noprefix','.text',...records.flatMap((r,i)=>[`input_${i}:`,r.assembly]),'input_end:',''].join('\n');
const asm=path.join(work,'inputs.S'),object=path.join(work,'inputs.o'),binary=path.join(work,'inputs.bin');
await writeFile(asm,source,{flag:'wx'});run(asArg,['--64','-o',object,asm]);
run(objcopyArg,['-O','binary','--only-section=.text',object,binary]);
const symbols=run(nmArg,['-n',object]),offsets=new Map();
for(const line of symbols.split(/\r?\n/)){const m=/^([a-fA-F0-9]+)\s+[a-zA-Z]\s+input_(\d+|end)$/.exec(line);if(m)offsets.set(m[2],parseInt(m[1],16));}
const bytes=await readFile(binary);if(offsets.size!==records.length+1||offsets.get('end')>bytes.length)throw new Error('complete assembler boundaries');
for(let i=0;i<records.length;++i){const start=offsets.get(String(i)),end=offsets.get(i+1===records.length?'end':String(i+1));
  if(start===undefined||end===undefined||end<=start||end-start>15)throw new Error(`one architectural instruction per record ${i}`);
  records[i].bytes=bytes.subarray(start,end).toString('hex');}
const sha=buffer=>createHash('sha256').update(buffer).digest('hex');
const receipt={format:'x86-profile-inputs-v1',profile:'development-standard-v2',
  oracle:'GNU as encoding, not independent execution semantics',assembler:run(asArg,['--version']).split(/\r?\n/)[0],
  sourceSha256:sha(Buffer.from(source)),binarySha256:sha(bytes),
  instructionSha256:sha(bytes.subarray(0,offsets.get('end'))),catalogRows:catalog.length,
  registerPairs:extra.length?'boundary':'all 16 x 16 where legal',
  domain:'declared instruction families and explicit operand dimensions; NOT all x86 encodings/states/programs',records};
await writeFile(path.join(work,'inputs.json'),JSON.stringify(receipt),{flag:'wx'});
console.log(JSON.stringify({format:receipt.format,status:'prepared',records:records.length,catalogRows:catalog.length,
  assembler:receipt.assembler,sourceSha256:receipt.sourceSha256,binarySha256:receipt.binarySha256,
  instructionSha256:receipt.instructionSha256,linuxBoot:'not-tested'}));
