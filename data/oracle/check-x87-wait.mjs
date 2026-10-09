// Actual C compiler/MMU/table; model comparisons are not native observations.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,mode]=process.argv.slice(2),stack=mode==='--stack',exchange=mode==='--exchange',transfer=mode==='--transfer';
if(!compilerFile||(mode&&!stack&&!exchange&&!transfer))throw new Error('VM.WASM COMPILER.WASM [--stack|--exchange|--transfer]');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,
  cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),
  dir=vm.vm_arena_min(),cpu=dir+4096,segments=cpu+1408,port=cpu+2048,rows=dir+512,codeView=port+64,
  ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n,payload=i=>cpu+(i+2)*4096,
  put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
let comparisons=0,nm=0,mf=0,ferr=0,success=0;
for(let form=0;form<(transfer?73:exchange?24:stack?18:1);++form)for(const prefix of [[],[0x66],[0x67],[0x48],[0x64],[0x65],[0xf2],[0xf3]]){
  const source=Buffer.from([...prefix,...(transfer?[form<64?form<32?0xda:0xdb:0xd9,form<64?0xc0+((form>>3)&3)*8+(form&7):form<66?0xe0+(form-64):0xe8+(form-66)]:exchange?[form<8?0xd9:form<16?0xdd:0xdf,0xc8+(form&7)]:stack?[form<8?0xdd:form<16?0xdf:0xd9,form<16?0xc0+(form&7):form===16?0xf6:0xf7]:[0x9b])]);c.fill(0x90,ci,ci+4096);c.set(source,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,8,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),module=await WebAssembly.compile(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))));
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,floating_wait:vm.vm_floating_wait}})).exports.cut;
  for(const dispatch of [false,true])for(let mask=0;mask<8;++mask)for(const ne of [false,true])for(let pending=0;pending<3;++pending){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);
    });
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);a.set(source,payload(4));
    for(let reg=0;reg<16;++reg)put(cpu+reg*8,0xabcdef0123450000n+BigInt(reg));
    put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010011|(mask<<1)|(ne?32:0));
    put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);put(cpu+488,8);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    a.fill(0x5a,cpu+1152,cpu+1256);v.setUint16(cpu+1232,pending===1?0x37e:0x37f,true);v.setUint16(cpu+1234,pending?0x8081:0,true);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,5,5,dir+1024,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),expected=Buffer.from(before),fault=(stack||exchange||transfer?Boolean(mask&6):(mask&5)===5)?7:pending===1&&ne?16:0,
      waiting=!fault&&pending===1,result=dispatch?vm.vm_run(port,9n,1):cut(cpu,port,entry,binding);
    if(fault){assert.equal(result,BigInt(fault)*8n+3n);assert.equal(v.getUint32(port+24,true),fault);fault===7?++nm:++mf;}
    else if(waiting){assert.equal(result,34n);++ferr;}
    else {assert.equal(result,1n);expected.writeBigUInt64LE(entry+BigInt(source.length),384);
      expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(43n,1128);
      if(stack){const sw=before.readUInt16LE(1234),top=(sw>>>11)&7;let tag=before.readUInt16LE(1236);
        if(form<16)tag|=3<<(((top+(form&7))&7)*2);
        if(form>=8&&form<16)tag|=3<<(top*2);
        const next=form<8?top:(top+(form===16?7:1))&7;
        expected.writeUInt16LE((sw&0xc5ff)|(next<<11),1234);expected.writeUInt16LE(tag,1236);expected.writeBigUInt64LE(entry,1240);}
      if(exchange){const sw=before.readUInt16LE(1234),top=(sw>>>11)&7,other=(top+(form&7))&7,tag=before.readUInt16LE(1236),
        ta=(tag>>>(top*2))&3,tb=(tag>>>(other*2))&3;
        expected.writeUInt16LE((tag&~((3<<(top*2))|(3<<(other*2))))|(tb<<(top*2))|(ta<<(other*2)),1236);
        expected.writeUInt16LE(sw&~0x200,1234);expected.writeBigUInt64LE(entry,1240);}
      if(transfer){const sw=before.readUInt16LE(1234),top=(sw>>>11)&7,tag=before.readUInt16LE(1236);
        if(form<64){if(form>=32&&(form&7)){const other=(top+(form&7))&7,sourceTag=(tag>>>(other*2))&3;
            expected.writeUInt16LE((tag&~(3<<(top*2)))|(sourceTag<<(top*2)),1236);}}
        else if(form<66){expected.writeUInt16LE(sw&~0x200,1234);const se=before.readUInt16LE(1216+top*2);
          expected.writeUInt16LE(form===64?se^0x8000:se&0x7fff,1216+top*2);}
        else{const next=(top+7)&7;expected.writeUInt16LE((sw&~0x3a00)|(next<<11)|0x241,1234);
          expected.writeUInt16LE((tag&~(3<<(next*2)))|(2<<(next*2)),1236);
          expected.writeBigUInt64LE(0xc000000000000000n,1152+next*8);expected.writeUInt16LE(0xffff,1216+next*2);}
        expected.writeBigUInt64LE(entry,1240);}
      ++success;}
    assert(a.subarray(cpu,cpu+1256).equals(expected),`full state prefix=${prefix}, mask=${mask}, NE=${ne}, pending=${pending}, dispatch=${dispatch}`);
    if(dispatch)assert.equal(vm.vm_source_retired(),fault||waiting?0n:1n);
    ++comparisons;
  }
}
vm.vm_close();cc.compiler_close();console.log(JSON.stringify({status:'pass',comparisons,nm,mf,ferr,success,
  scope:transfer?'All FCMOV/sign/constant forms and prefixes, MP/TS/EM/NE, pending/masked, direct + C table':exchange?'All FXCH encodings/prefixes, MP/TS/EM/NE, pending/masked, direct + C table':stack?'All FFREE/FFREEP/TOP forms/prefixes, MP/TS/EM/NE, pending/masked, direct + C table':
    '8 prefix forms; MP/TS/EM/NE, masked/pending state, direct + C table; FWAIT preserves complete numeric state',linuxBoot:'not-tested'}));
