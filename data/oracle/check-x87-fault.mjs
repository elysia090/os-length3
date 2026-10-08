// C/MMU fault priority and atomic operand loads. No guest ISA
// or exception interpreter is implemented by this model supervisor.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,mode]=process.argv.slice(2),memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
if(mode&&!['--arithmetic','--status','--register','--load','--store','--mmx'].includes(mode))throw new Error('VM.WASM COMPILER.WASM [--arithmetic|--status|--register|--load|--store|--mmx]');
const mmx=mode==='--mmx',load=mode==='--load',store=mode==='--store',arithmetic=mode==='--arithmetic',status=mode==='--status',register=mmx||mode==='--register';
const cases=mmx?[{width:0,pop:false,opcode:0x0f,second:0xef,modrm:0xc0}]:store?[[0xdf,2,2],[0xdb,2,4],[0xdf,3,2],[0xdb,3,4],[0xdf,7,8],[0xdf,1,2],[0xdb,1,4],[0xdd,1,8]]
  .map(([opcode,group,width])=>({opcode,width,modrm:(group<<3)|7})):
  load?[4,8].map(width=>({width,opcode:width===4?0xd9:0xdd,modrm:7})):
  register?Array.from({length:72},(_,family)=>{const index=family&7,encoding=Math.floor(family/24),operation=Math.floor(family/8)%3;
  return {width:0,pop:encoding===2,opcode:encoding===0?0xd8:encoding===1?0xdc:0xde,
    modrm:(operation===0?0xc0:operation===1?(encoding?0xe8:0xe0):(encoding?0xe0:0xe8))|index};}):
  status?Array.from({length:8},(_,family)=>{const integer=family>=4,pop=!(family&1),width=integer?(family<6?2:4):(family<2?4:8);
  return {width,pop,integer,opcode:integer?(width===2?0xde:0xda):(width===4?0xd8:0xdc),modrm:((pop?3:2)<<3)|7};}):
  arithmetic?[2,4].flatMap(width=>[0,4,5].map(group=>({width,group,opcode:width===4?0xda:0xde,modrm:(group<<3)|7}))):
  [2,4,8].map(width=>({width,opcode:width===4?0xdb:0xdf,modrm:width===8?0x2f:7}));
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,port=cpu+2048,segments=cpu+1408,codeView=port+64,
  ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,payload=i=>cpu+(i+2)*4096,entry=0x400000n;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let faults=0,success=0;
for(const prefix of [[],[0x66],[0x67],[0x48],[0x64],[0x65]])for(const item of cases){const {width,group}=item;
  const source=Buffer.from([...prefix.filter(x=>!mmx||x!==0x66),item.opcode,...(item.second?[item.second]:[]),item.modrm]);c.fill(0x90,ci,ci+4096);c.set(source,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),instance=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,access:vm.vm_access,floating_wait:vm.vm_floating_wait,write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end}})).instance;
  for(const mask of [0n,4n,8n,12n])for(const pending of [false,true])for(const resident of [false,true])for(const crossing of [false,true]){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);
    put(payload(3)+8,crossing?0x9067:resident?0x9065:0);put(payload(3)+16,resident?0xa065:0);
    const address=crossing?0x401fffn:0x401010n;put(cpu+56,address);put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010031n|mask);
    put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+488,8);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    v.setUint16(cpu+1232,pending?0x37e:0x37f,true);v.setUint16(cpu+1234,pending?0x8081:0,true);v.setUint16(cpu+1236,register?0x5555:arithmetic||status||store?0xfffd:0xffff,true);
    a.set(source,payload(4));a.fill(0,payload(5),payload(6)+4096);a[payload(5)+(crossing?4095:16)]=1;
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),instance.exports.cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),data=Buffer.from(a.subarray(payload(5),payload(6)+4096));
    const expected=mmx&&(mask&4n)?6:mask?7:pending?16:store||!register&&!resident?14:0,result=vm.vm_run(port,9n,1);
    if(expected){assert.equal(result,BigInt(expected)*8n+3n);assert.equal(v.getUint32(port+24,true),expected);assert(a.subarray(cpu,cpu+1256).equals(before));++faults;}
    else{assert.equal(result,1n);
      if(register){const after=Buffer.from(before);after.writeBigUInt64LE(entry+BigInt(source.length),384);after.writeBigUInt64LE(0x202n,392);
        after.writeBigUInt64LE(43n,1128);after.writeUInt16LE(item.pop?0x800:0,1234);after.writeUInt16LE(mmx?0x5556:item.pop?0x5557:0x5555,1236);
        if(mmx)after.writeUInt16LE(0xffff,1216);else after.writeBigUInt64LE(entry,1240);
        assert(a.subarray(cpu,cpu+1256).equals(after),'complete register arithmetic zero-state model');
      }else if(status){const after=Buffer.from(before);after.writeBigUInt64LE(entry+BigInt(source.length),384);after.writeBigUInt64LE(0x202n,392);
        after.writeBigUInt64LE(43n,1128);after.writeUInt16LE(0x100|(item.pop?0x800:0)|(item.integer?0:2),1234);
        after.writeUInt16LE(item.pop?0xffff:0xfffd,1236);after.writeBigUInt64LE(entry,1240);
        assert(a.subarray(cpu,cpu+1256).equals(after),'complete status compare model');
      }else{const top=arithmetic?0:7;assert.equal(v.getBigUint64(cpu+1152+top*8,true),0x8000000000000000n);
        assert.equal(v.getUint16(cpu+1216+top*2,true),load?(width===4?0x3f6a:0x3bcd):arithmetic&&group===4?0xbfff:0x3fff);}
      ++success;}
    assert(a.subarray(payload(5),payload(6)+4096).equals(data));
  }
}
vm.vm_close();cc.compiler_close();console.log(JSON.stringify({status:'pass',family:mmx?'MMX':store?'integer-store':load?'IEEE-load':register?'register-arithmetic':status?'status-comparison':arithmetic?'integer-arithmetic':'FILD',faults,success,
  oracle:register?'C #NM/#MF and complete zero/pop models; register operations do not access absent operand pages':
    'C #NM/#MF-before-access and readonly/cross-page/absent operand models',linuxBoot:'not-tested'}));
