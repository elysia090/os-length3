// Read-only summary of independent Linux ptrace receipts, not an ELF mapper.
import {readFile} from 'node:fs/promises';
const [logPath,inputPath,outputPath]=process.argv.slice(2);
if(!outputPath)throw new Error('TRACE INPUT.elf OPTIMIZED.elf');
const log=await readFile(logPath,'utf8'),images=await Promise.all([inputPath,outputPath].map(p=>readFile(p)));
let generation=-1,base=0n,rows=[];const populations=[];
for(const line of log.split(/\r?\n/)){
  const m=/^oracle-trace (step|boundary) syscall=(-?\d+) rax=([a-f0-9]+) rip=([a-f0-9]+) rdi=([a-f0-9]+) rsi=([a-f0-9]+) rdx=([a-f0-9]+) flags=([a-f0-9]+) code=([a-f0-9]+)$/.exec(line);
  if(!m)continue;
  if(m[2]==='59'&&m[3]==='0'){if(generation>=0)populations.push(rows);++generation;if(generation>1)throw new Error('unexpected exec population');base=BigInt('0x'+m[4])-images[generation].readBigUInt64LE(24);rows=[];}
  if(generation<0)continue;
  const rip=BigInt('0x'+m[4])-base,code=BigInt('0x'+m[9]),byte=Number(code&255n);
  if(byte===0xe8||byte===0xc3||byte===0xff||(byte>=0x70&&byte<=0x7f)||byte===0x0f||byte===0x83)
    rows.push({rip:'0x'+rip.toString(16),code:code.toString(16).padStart(16,'0').match(/../g).reverse().join(''),rax:m[3],rdi:m[5],rsi:m[6],rdx:m[7],flags:m[8]});
}
if(generation>=0)populations.push(rows);
for(let n=0;n<populations.length;++n){console.log(n?'optimized':'original');
  for(const r of populations[n].filter(r=>/^(e8|c3|ff)/.test(r.code)).slice(0,110))console.log(`${r.rip} ${r.code} ax=${r.rax} di=${r.rdi} si=${r.rsi} dx=${r.rdx}`);
}
