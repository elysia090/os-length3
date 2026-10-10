package main

// Transport-only witness. No shell, networking stack or filesystem imitation.
const probeHTML = `<!doctype html><meta charset="utf-8"><title>Packet gateway transport</title><h1>Packet gateway transport</h1><p>Opaque Ethernet/datagram probe. Not Linux boot or Internet connectivity.</p><button id="run">Verify transport</button><pre id="result">Not run</pre><script type="module" src="/probe.mjs"></script>`

const probeJS = `const result=document.getElementById('result');
document.getElementById('run').onclick=async()=>{
 let wt;
 try{
 const c=await(await fetch('/config')).json();
 wt=new WebTransport(c.url,{serverCertificateHashes:[{algorithm:'sha-256',value:Uint8Array.from(atob(c.certificateHash),b=>b.charCodeAt(0))}]});
 await wt.ready;
 if(wt.datagrams.maxDatagramSize<64)throw new Error('datagram budget');
 const stride=Math.min(1068,wt.datagrams.maxDatagramSize-32),generation=9n;
 const stream=await wt.createBidirectionalStream(),cw=stream.writable.getWriter(),cr=stream.readable.getReader();
 await cw.write(new TextEncoder().encode(JSON.stringify({version:1,generation:generation.toString(),stride})+'\n'));await cw.close();
 let control='';for(;;){const {value,done}=await cr.read();if(done)break;control+=new TextDecoder().decode(value);if(control.length>1024)throw new Error('control extent');}
 const link=JSON.parse(control);if(link.generation!==generation.toString()||link.stride!==stride)throw new Error('link binding');
 if(!c.diagnostic)throw new Error('probe requires explicit diagnostic echo backend');
 const writer=wt.datagrams.writable.getWriter(),reader=wt.datagrams.readable.getReader();
 const input=Uint8Array.from({length:1514},(_,i)=>(i*31+9)&255),parts=Math.ceil(input.length/stride),output=new Uint8Array(input.length);
 // Reverse order and duplicate fragments. Exactly one output frame is admitted.
 for(let i=parts-1;i>=0;i--){const at=i*stride,part=input.subarray(at,Math.min(input.length,at+stride)),p=new Uint8Array(32+part.length),v=new DataView(p.buffer);
 v.setUint32(0,1,true);v.setUint32(4,input.length,true);v.setBigUint64(8,generation,true);v.setBigUint64(16,1n,true);v.setUint32(24,i,true);v.setUint32(28,stride,true);p.set(part,32);
 await writer.write(p);if(i!==0)await writer.write(p);}
 let mask=0n;const deadline=setTimeout(()=>wt.close(),5000);
 try{while(mask!==(1n<<BigInt(parts))-1n){const {value:p,done}=await reader.read();if(done)throw new Error('incomplete frame');const v=new DataView(p.buffer,p.byteOffset,p.byteLength),i=v.getUint32(24,true);
 if(v.getUint32(0,true)!==1||v.getUint32(4,true)!==input.length||v.getBigUint64(8,true)!==generation||v.getBigUint64(16,true)!==1n||v.getUint32(28,true)!==stride||i>=parts||p.length!==32+Math.min(stride,input.length-i*stride))throw new Error('fragment binding');
 output.set(p.subarray(32),i*stride);mask|=1n<<BigInt(i);}}finally{clearTimeout(deadline);}
 if(!input.every((b,i)=>b===output[i]))throw new Error('payload changed');
 result.textContent=JSON.stringify({status:'pass',scope:'real browser WebTransport datagrams and pinned certificate',linuxBoot:'not-tested',internet:'not-tested',bytes:input.length,stride,fragments:parts,reverseOrder:true,duplicateFragment:true,generation:Number(generation)},null,2);
 }catch(e){result.textContent=JSON.stringify({status:'fail',error:e.message,name:e.name,source:e.source,streamErrorCode:e.streamErrorCode},null,2);}finally{wt?.close();}
};`
