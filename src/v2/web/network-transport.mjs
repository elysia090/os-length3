// Ethernet carrier only; no IP, DNS, TCP, TLS, or guest socket implementation.
export class NetworkTransport {
  constructor({url,certificateHash}){this.url=url;this.certificateHash=certificateHash;this.frames=[];this.rows=new Map();this.highest=0n;this.sequence=0n;this.closed=false;}
  async open(generation){
    if(this.transport||typeof generation!=='bigint'||generation<1n||generation>0xffffffffffffffffn)throw new Error('fresh network generation');
    const url=new URL(this.url);if(url.protocol!=='https:')throw new Error('secure granted network endpoint required');
    const options=this.certificateHash?{serverCertificateHashes:[{algorithm:'sha-256',value:Uint8Array.from(atob(this.certificateHash),b=>b.charCodeAt(0))}]}:{};
    const wt=new WebTransport(url.href,options);this.transport=wt;this.generation=generation;await wt.ready;
    this.stride=Math.min(1068,wt.datagrams.maxDatagramSize-32);if(this.stride<32)throw new Error('network datagram budget');
    const control=await wt.createBidirectionalStream(),writer=control.writable.getWriter(),reader=control.readable.getReader();
    await writer.write(new TextEncoder().encode(JSON.stringify({version:1,generation:String(generation),stride:this.stride})+'\n'));await writer.close();
    let text='';const decoder=new TextDecoder();for(;;){const r=await reader.read();if(r.done)break;text+=decoder.decode(r.value,{stream:true});if(text.length>1024)throw new Error('network control extent');}
    reader.releaseLock();writer.releaseLock();const link=JSON.parse(text);if(link.generation!==String(generation)||link.stride!==this.stride)throw new Error('network binding disagreement');
    this.writer=wt.datagrams.writable.getWriter();this.reader=wt.datagrams.readable.getReader();
    this.reading=this.receive().catch(e=>{if(!this.closed)this.error=e;});wt.closed.catch(e=>{if(!this.closed)this.error=e;});
  }
  async send(frame){if(this.error)throw this.error;if(this.closed||!(frame instanceof Uint8Array)||frame.length<14||frame.length>2048||this.sequence===0xffffffffffffffffn)throw new Error('bounded Ethernet transfer');
    const rank=++this.sequence;for(let i=0;i<Math.ceil(frame.length/this.stride);++i){const part=frame.subarray(i*this.stride,(i+1)*this.stride),p=new Uint8Array(32+part.length),v=new DataView(p.buffer);
      v.setUint32(0,1,true);v.setUint32(4,frame.length,true);v.setBigUint64(8,this.generation,true);v.setBigUint64(16,rank,true);v.setUint32(24,i,true);v.setUint32(28,this.stride,true);p.set(part,32);await this.writer.write(p);}}
  async receive(){for(;;){const {value:p,done}=await this.reader.read();if(done){if(!this.closed)throw new Error('network carrier closed');return;}
      const now=performance.now();for(const row of this.rows.values())if(!row.done&&!row.poisoned&&now-row.at>2000){row.poisoned=true;row.bytes=null;}
      if(p.length<32)continue;const v=new DataView(p.buffer,p.byteOffset,p.byteLength),size=v.getUint32(4,true),generation=v.getBigUint64(8,true),rank=v.getBigUint64(16,true),part=v.getUint32(24,true),stride=v.getUint32(28,true);
      if(v.getUint32(0,true)!==1||generation!==this.generation||!rank||size<14||size>2048||stride!==this.stride||part>=Math.ceil(size/stride)||p.length!==32+Math.min(stride,size-part*stride))continue;
      if(rank>this.highest)this.highest=rank;for(const key of this.rows.keys())if(this.highest-BigInt(key)>=64n)this.rows.delete(key);
      if(this.highest-rank>=64n)continue;const key=String(rank);
      let row=this.rows.get(key);if(!row){if(this.rows.size>=64)this.rows.delete(this.rows.keys().next().value);row={at:now,size,bytes:new Uint8Array(size),mask:0n,done:false,poisoned:false};this.rows.set(key,row);}
      if(row.done||row.poisoned)continue;if(row.size!==size){row.poisoned=true;continue;}
      const bit=1n<<BigInt(part),at=part*stride;if(row.mask&bit){if(!p.subarray(32).every((b,i)=>row.bytes[at+i]===b))row.poisoned=true;continue;}
      row.bytes.set(p.subarray(32),at);row.mask|=bit;if(row.mask===(1n<<BigInt(Math.ceil(size/stride)))-1n){row.done=true;if(this.frames.length<64)this.frames.push(row.bytes);}
    }}
  take(){if(this.error)throw this.error;return this.frames.shift()??null;}
  replacement(){return new NetworkTransport({url:this.url,certificateHash:this.certificateHash});}
  requeue(frame){if(this.frames.length<64)this.frames.unshift(frame);}
  async close(){if(this.closed)return;this.closed=true;await this.reader?.cancel().catch(()=>{});this.transport?.close();await this.reading;this.frames.length=0;this.rows.clear();}
}
