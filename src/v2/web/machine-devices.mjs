// Privileged opaque IO broker. All device/ring/DMA and guest semantics are C.
// Transport promises never retain borrowed guest memory or mutate CPU state.
function ok(value,label){if(value!==0&&value!==1)throw new Error(`${label}: ${value}`);}
export class MachineDevices {
  constructor({volume,network=null,address='0x38000000',binding}){
    this.volume=volume;this.network=network;this.address=address;this.binding=binding;
    this.rx=null;this.rxSequence=0n;this.closed=false;
  }
  async attach({vm,memory,scratch,generation}){
    Object.assign(this,{vm,memory,scratch,generation});
    const view=new DataView(memory.buffer),grant=scratch,ticket=scratch+128,reply=scratch+4096;
    this.ticket=ticket;this.reply=reply;
    if(!Array.isArray(this.binding)||this.binding.length!==4||!this.binding.every(x=>typeof x==='bigint')||!this.binding.slice(0,2).some(Boolean)||!this.binding.slice(2).some(Boolean))throw new Error('authority/workspace identity required');
    for(let i=0;i<4;++i)view.setBigUint64(grant+i*8,this.binding[i],true);
    view.setBigUint64(grant+32,1n,true);view.setBigUint64(grant+40,generation,true);view.setBigUint64(grant+48,1n,true);
    view.setUint32(grant+56,0,true);view.setUint32(grant+60,0,true);view.setBigUint64(grant+64,0n,true);
    view.setBigUint64(grant+72,BigInt(this.volume.bytes),true);view.setUint32(grant+80,4096,true);view.setUint32(grant+84,3,true);view.setUint32(grant+88,1,true);view.setUint32(grant+92,0,true);
    ok(vm.vm_block_grant(grant),'block grant');
    if(this.network){
      view.setBigUint64(grant+32,2n,true);view.setBigUint64(grant+72,2048n,true);view.setUint32(grant+80,2048,true);view.setUint32(grant+88,2,true);
      this.networkGrant=new Uint8Array(memory.buffer,grant,96).slice();this.rx=this.networkGrant.slice(0,64);
      // A granted but unreachable network must not postpone offline boot.
      // Transport setup has no C access. Admit link-up later at a safe poll.
      this.connecting=this.network.open(generation).then(()=>{this.linkReady=true;},e=>{this.networkError=e;});
    }
  }
  async poll(){if(this.closed||!this.network||this.networkError)return;
    if(this.network.error){this.networkError=this.network.error;
      if(this.linkBound)ok(this.vm.vm_network_revoke_grant(this.generation),'network revocation');this.linkBound=false;return;}
    if(this.linkReady&&!this.linkBound){new Uint8Array(this.memory.buffer).set(this.networkGrant,this.scratch);
      const status=this.vm.vm_network_grant(this.scratch);if(status===-1)return;ok(status,'network grant');this.linkBound=true;}
    if(!this.linkBound)return;const frame=this.network.take();if(!frame)return;
    const bytes=new Uint8Array(this.memory.buffer);bytes.set(this.rx,this.scratch);bytes.set(frame,this.reply);
    const status=this.vm.vm_network_receive_frame(this.scratch,this.rxSequence+1n,this.reply,frame.length);
    if(status===-123){this.network.requeue(frame);return;}ok(status,'network RX');++this.rxSequence;
  }
  async handle(result){
    if(this.closed)throw new Error('device owner closed');const vm=this.vm,bytes=new Uint8Array(this.memory.buffer);
    if(result===42n){if(!this.network)throw new Error('network transfer without grant');
      const count=vm.vm_network_transmit(this.ticket),at=vm.vm_network_transmit_address();if(count<14||count>2048||!at)throw new Error('bounded C network request');
      const ticket=bytes.slice(this.ticket,this.ticket+72),frame=bytes.slice(at,at+count);
      try{await this.network.send(frame);}catch(error){this.networkError=error;ok(vm.vm_network_revoke_grant(this.generation),'failed network revocation');this.linkBound=false;return;}
      new Uint8Array(this.memory.buffer).set(ticket,this.ticket);ok(vm.vm_network_transmit_commit(this.ticket),'network TX commit');return;}
    if(result!==50n)throw new Error(`unhandled device barrier ${result}`);
    const encoded=vm.vm_block_request(this.ticket);if(!encoded)throw new Error('C block request absent');
    const op=encoded-1,offset=Number(vm.vm_block_offset()),count=vm.vm_block_extent(),ticket=bytes.slice(this.ticket,this.ticket+72);
    let reply=null;if(op===0)reply=await this.volume.read(offset,count);
    else if(op===1)await this.volume.write(offset,bytes.slice(vm.vm_block_payload(),vm.vm_block_payload()+count));
    else if(op===4)await this.volume.flush();else throw new Error('unsupported C block request');
    const current=new Uint8Array(this.memory.buffer);current.set(ticket,this.ticket);if(reply)current.set(reply,this.reply);
    ok(vm.vm_block_reply(this.ticket,this.reply,reply?.length??0,0),'block completion');
  }
  status(){return {networkRequested:!!this.network,networkConnected:!!this.linkReady,
    networkBound:!!this.linkBound,networkFailure:this.networkError?.name??null,
    receivedFrames:String(this.rxSequence),closed:this.closed};}
  async close(){if(this.closed)return;this.closed=true;await this.network?.close();await this.volume.close();}
}
