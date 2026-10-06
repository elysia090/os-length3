// Real x86 REP observations versus bounded generated loops in the C VM owner.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const dir=vm.vm_arena_min(),base=dir+4096,port=base+2048,segments=base+1408,rows=dir+512;
const code=base+24576,ram=base+28672,pte=base+20480+256*8;
const entry=0x400000n,start=0x500000n,slot=vm.__indirect_function_table.grow(1);
const put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true),cpu=()=>Buffer.from(data.subarray(base,base+1256));
const u64=x=>BigInt.asUintN(64,x),mask=bits=>(1n<<BigInt(bits))-1n;
function reset(page,meta,word,form){
  vm.vm_close();data.fill(0,dir);
  for(let i=0;i<9;++i){put(dir+i*32,i<4?(i+1)*4096:(i+4)*4096);
    v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);put(base+20480,0x8067);
  for(let i=0;i<4;++i)put(pte+i*8,BigInt((i+9)*4096)|0x67n);
  for(let r=0;r<16;++r)put(base+r*8,word(r));
  put(base+384,entry);put(base+392,word(16));put(base+400,0x80010011);put(base+408,0x1000);
  put(base+416,32);put(base+424,0xd00);put(base+488,19);put(base+496,27);put(base+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);v.setUint32(segments+52,0xc0f3,true);
  data.set(page,code);
  const scenario=Number(word(37)>>16n),direction=Number(word(37)>>8n&255n),sample=Number(word(37)&255n),size=meta.width/8;
  for(let i=0;i<16384;++i)data[ram+i]=(i*37+form*11+sample)&255;
  if(meta.kind>=3){
    const addressMask=mask(meta.address),src=word(6)&addressMask,dst=word(7)&addressMask;
    for(let element=0;element<513;++element){
      const delta=BigInt(element*size),from=direction?src-delta:src+delta,to=direction?dst-delta:dst+delta;
      if(to<start||to+BigInt(size)>start+16384n)continue;
      const value=meta.kind===4?Buffer.from(data.subarray(base,base+size))
        :Buffer.from(data.subarray(ram+Number(from-start),ram+Number(from-start)+size));
      let unequal=meta.ne;if((scenario===1&&element===0)||(scenario===2&&element===256))unequal=!unequal;
      if(unequal)value[0]^=1;data.set(value,ram+Number(to-start));
    }
  }
  if(scenario>=3)put(pte+8,0);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,9,9,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);v.setUint32(rows+8,meta.sourceBytes,true);v.setUint32(rows+12,1,true);v.setUint32(rows+16,slot,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function compareFlags(flags,a,b,bits){
  const m=mask(bits),sign=1n<<BigInt(bits-1),r=(a-b)&m;let parity=0;
  for(let bit=0;bit<8;++bit)parity^=Number(r>>BigInt(bit)&1n);
  const f=(a<b?1:0)|(!parity?4:0)|(((a^b^r)&16n)?16:0)|(!r?64:0)|((r&sign)?128:0)
    |(((a^b)&(a^r)&sign)?2048:0);
  return (flags&~0x8d5n)|BigInt(f);
}
function advance(expected,payload,meta,scenario,originalFlags){
  const m=mask(meta.address),size=meta.width/8,bits=mask(meta.width),step=expected.readBigUInt64LE(392)&0x400n?-BigInt(size):BigInt(size);
  if(meta.address===32){
    expected.writeBigUInt64LE(expected.readBigUInt64LE(8)&m,8);
  }
  const load=address=>{
    const at=Number(address-start);
    if(at<0 || at+size>16384 || (scenario>=3 && at<8192 && at+size>4096))return null;
    let value=0n;for(let byte=0;byte<size;++byte)value|=BigInt(payload[at+byte])<<BigInt(byte*8);return value;
  };
  for(let element=0;element<256;++element){
    let count=expected.readBigUInt64LE(8)&m;if(!count)return 'complete';
    const src=expected.readBigUInt64LE(48)&m,dst=expected.readBigUInt64LE(56)&m;
    const a=meta.kind===4?expected.readBigUInt64LE(0)&bits:load(src);
    const b=meta.kind===2?0n:load(dst);
    if(a===null||b===null){expected.writeBigUInt64LE((expected.readBigUInt64LE(392)&~0x8d5n)|(originalFlags&0x8d5n),392);return 'fault';}
    if(meta.kind===2){const kept=meta.width<32?expected.readBigUInt64LE(0)&~bits:0n;expected.writeBigUInt64LE(kept|a,0);}
    else expected.writeBigUInt64LE(compareFlags(expected.readBigUInt64LE(392),a,b,meta.width),392);
    expected.writeBigUInt64LE((count-1n)&m,8);
    if(meta.kind!==4)expected.writeBigUInt64LE((src+step)&m,48);
    if(meta.kind!==2)expected.writeBigUInt64LE((dst+step)&m,56);
    if(meta.kind>=3 && Boolean(expected.readBigUInt64LE(392)&64n)===Boolean(meta.ne))return 'complete';
  }
  return (expected.readBigUInt64LE(8)&m)?'quantum':'complete';
}
let parity=0,success=0,faults=0,quantum=0,dispatch=0,models=0,stale=0,rollbacks=0;
for(let form=0;form<48;++form){
  const prefix=path.join(directory,`repeat-${form}`),meta=JSON.parse(await readFile(`${prefix}.json`,'utf8'));
  const page=await readFile(`${prefix}.source-page`),records=await readFile(`${prefix}.cases`),stride=38*8+16384;
  assert.equal(records.length,meta.rows*stride);cold.set(page,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,8,output,65536,report),0);
  const module=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  assert(module.equals(await readFile(`${prefix}.wasm`)));++parity;
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  for(let row=0;row<meta.rows;++row){
    const word=index=>records.readBigUInt64LE(row*stride+index*8),scenario=Number(word(37)>>16n);
    reset(page,meta,word,form);const expected=cpu(),payload=Buffer.from(data.subarray(ram,ram+16384)),original=word(16);
    let outcome;
    do{
      outcome=advance(expected,payload,meta,scenario,original);
      if(outcome==='complete'){expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);expected.writeBigUInt64LE(43n,1128);
        expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392);}
      const result=vm.vm_run(port,9n,1);assert.equal(result,outcome==='complete'?1n:outcome==='quantum'?10n:115n,`form ${form} row ${row}`);
      assert(cpu().equals(expected),`full CPU form=${form} row=${row} outcome=${outcome}`);
      assert(data.subarray(ram,ram+16384).equals(payload));assert.equal(vm.vm_source_retired(),outcome==='complete'?1n:0n);++dispatch;++models;
      if(outcome==='quantum'){
        ++quantum;put(port,8);const before=cpu();assert.equal(vm.vm_run(port,9n,1),5n);assert(cpu().equals(before));put(port,9);++stale;
      }
    }while(outcome==='quantum');
    for(let r=0;r<16;++r)assert.equal(v.getBigUint64(base+r*8,true),word(17+r),`native GPR r${r} form=${form} row=${row}`);
    assert.equal(v.getBigUint64(base+392,true),word(33)&~0x10000n,'native full flags; hardware RF delivery excluded');
    assert(data.subarray(ram,ram+16384).equals(records.subarray(row*stride+38*8,(row+1)*stride)));
    if(outcome==='fault'){
      assert.equal(word(34),14n);assert.equal(v.getUint32(port+24,true),14);assert.equal(v.getUint32(port+28,true),Number(word(35)));
      assert.equal(v.getBigUint64(port+16,true),word(36));++faults;
      if(scenario===5&&meta.kind>=3)++rollbacks;
    }else{assert.equal(word(34),0n);++success;}
  }
}
vm.__indirect_function_table.set(slot,null);vm.vm_close();
console.log(JSON.stringify({format:'native-string-repeat-v1',status:'pass',parity,success,faults,quantum,dispatch,models,stale,rollbacks,
  scope:'48 LODS/CMPS/SCAS REP/REPE/REPNE forms, native GPR/flags/RAM/fault observations; bounded quantum frontiers are separate models',linuxBoot:'not-tested'},null,2));
