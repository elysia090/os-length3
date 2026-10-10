// Replace the authoritative init script in a bounded uncompressed newc boot
// archive. This is an offline build adapter, never a guest filesystem reader.
import {readFile,writeFile} from 'node:fs/promises';
const [source,script,target,...extra]=process.argv.slice(2);
if(!target||extra.length)throw new Error('SOURCE-NEWC INIT-SCRIPT NEW-OUTPUT');
const input=await readFile(source),init=await readFile(script);if(input.length>4194304||init.length>65536)throw new Error('bounded initramfs input');
const chunks=[];let at=0,replaced=0,trailer=false;
const align=n=>(n+3)&~3;
while(at<input.length){if(input.subarray(at).every(b=>b===0))break;
  const start=at,header=Buffer.from(input.subarray(at,at+110));if(header.length!==110||header.subarray(0,6).toString()!=='070701')throw new Error('canonical newc header');
  const field=n=>{const s=header.subarray(6+n*8,14+n*8).toString();if(!/^[a-fA-F0-9]{8}$/.test(s))throw new Error('newc integer');return parseInt(s,16);};
  const bytes=field(6),namesize=field(11);if(!namesize||namesize>4096||at+110+namesize>input.length)throw new Error('bounded newc name');
  const name=input.subarray(at+110,at+110+namesize);if(name[name.length-1]!==0)throw new Error('newc name termination');
  const text=name.subarray(0,-1).toString(),dataAt=align(at+110+namesize),end=align(dataAt+bytes);if(end>input.length)throw new Error('truncated newc entry');
  if(text==='TRAILER!!!'){if(bytes)throw new Error('newc trailer extent');trailer=true;chunks.push(input.subarray(start,end));at=end;break;}
  if(text==='init'||text==='./init'){
    if((field(1)&0xf000)!==0x8000||!(field(1)&0x49)||replaced++)throw new Error('unique executable init');
    header.write(init.length.toString(16).padStart(8,'0'),54,'ascii');const prefix=Buffer.alloc(align(110+namesize));header.copy(prefix);name.copy(prefix,110);
    chunks.push(prefix,init,Buffer.alloc(align(init.length)-init.length));
  }else chunks.push(input.subarray(start,end));at=end;
}
if(!trailer||replaced!==1||input.subarray(at).some(Boolean))throw new Error('complete single-init boot archive');
const bytes=Buffer.concat(chunks),output=Buffer.alloc(Math.ceil(bytes.length/512)*512);bytes.copy(output);
await writeFile(target,output,{flag:'wx'});console.log(JSON.stringify({bytes:output.length,initBytes:init.length,entriesPreserved:true}));
