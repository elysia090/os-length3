// C-produced module -> existing authenticated C index -> C VM source/run.
// Fixture scope only: this does not authenticate the Linux release or close ELF.
import assert from 'node:assert/strict';
import {readFile,open} from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2);
const program=[0x48,0xc7,0xc0,7,0,0,0,0x48,0xc7,0xc3,3,0,0,0,0xf8];
if(args[0]==='--emit'){
  if(args.length!==3)throw new Error('--emit COMPILER.WASM OUTPUT.WASM');
  const memory=new WebAssembly.Memory({initial:16});
  const cc=(await WebAssembly.instantiate(await readFile(args[1]),{machine:{memory}})).instance.exports;
  const bytes=new Uint8Array(memory.buffer),view=new DataView(memory.buffer);
  const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
  bytes.fill(0x90,input,input+4096);bytes.set(program,input);
  assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
  assert.equal(cc.compiler_emit(0x400000n,3,output,65536,report),0);
  assert.equal(view.getBigUint64(report+32,true),15n);assert.equal(view.getBigUint64(report+24,true),3n);
  const file=await open(args[2],'wx');
  try{await file.writeFile(bytes.subarray(output,output+Number(view.getBigUint64(report+40,true))));}
  finally{await file.close();}
  console.log('fixture C module emitted; not a whole-ELF publication');
}else{
  if(args.length!==2)throw new Error('VM.WASM FIXTURE-DIRECTORY');
  const [vmFile,fixture]=args,memory=new WebAssembly.Memory({initial:16});
  const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
  for(const name of ['vm_directory_bind','vm_directory_query','vm_directory_request','vm_directory_node_commit',
    'vm_directory_object_commit','vm_directory_cancel_request','vm_directory_status'])
    assert.equal(typeof vm[name],'function',`C Artifact path must own ${name}`);
  const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),base=dir+4096;
  const state=base,segments=base+1408,port=base+2048,rootAt=base+3072,requestAt=base+3200;
  const codeView=base+3264,nodeAt=base+4096,objectAt=base+8192,rows=dir+512,reserved=16384;
  const payload=i=>base+reserved+i*4096,put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
  const get=at=>v.getBigUint64(at,true),cpu=()=>Buffer.from(data.subarray(state,state+1256));
  const root=await readFile(path.join(fixture,'root-ref'));assert.equal(root.length,88);
  let nodeReads=0,objectReads=0,bytesRead=0,checks=0,objects=0;
  function reset(){
    vm.vm_close();data.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,reserved+i*4096,true);
      v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);
    });
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);
    for(let r=0;r<16;++r)put(state+r*8,BigInt(r+1)*0x123456789abn);
    put(state+384,0x400000);put(state+392,0x10203);put(state+400,0x80010011);
    put(state+408,0x1000);put(state+416,32);put(state+424,0xd00);put(state+488,8);put(state+1128,41);put(port,9);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    data.fill(0x90,payload(4),payload(4)+4096);data.set(program,payload(4));
    assert.equal(vm.vm_open(base,data.length-base,reserved,dir,6,6,dir+1024,9n),0);
    assert.equal(vm.vm_bind_state(state),0);assert.equal(vm.vm_bind_segments(segments),0);
    data.set(root,rootAt);assert.equal(vm.vm_directory_bind(rootAt,9n,4096),0);
  }
  async function lookup(rank,{controls=false}={}){
    const expected=cpu();assert.equal(vm.vm_directory_query(9n,1n,BigInt(rank),1),0);
    assert.equal(vm.vm_directory_query(8n,1n,BigInt(rank),1),-141);
    let pathNodes=0,lastNodeTicket;
    while(vm.vm_directory_status()===2){
      assert.equal(vm.vm_directory_request(requestAt,9n),2);assert.equal(get(requestAt),9n);
      const ticket=get(requestAt+8),count=v.getUint32(requestAt+48,true);
      const opaque=data.subarray(requestAt+16,requestAt+48).toString('hex');
      const bytes=await readFile(path.join(fixture,opaque));assert.equal(bytes.length,count);assert(count<=4096);
      assert.equal(v.getUint32(requestAt+52,true),3);data.set(bytes,nodeAt);
      if(controls){
        assert.equal(vm.vm_directory_node_commit(nodeAt,count,8n,ticket),-141);
        assert.equal(vm.vm_directory_node_commit(nodeAt,count,9n,ticket+1n),-141);
        assert(vm.vm_directory_node_commit(nodeAt,count-1,9n,ticket)<0);
        data[nodeAt+count-1]^=1;assert.equal(vm.vm_directory_node_commit(nodeAt,count,9n,ticket),-35);
        data[nodeAt+count-1]^=1;assert(cpu().equals(expected));checks+=4;
      }
      const result=vm.vm_directory_node_commit(nodeAt,count,9n,ticket);assert(result===0||result===1);
      lastNodeTicket=ticket;++pathNodes;++nodeReads;bytesRead+=count;
    }
    assert.equal(pathNodes,3);assert.equal(vm.vm_directory_request(requestAt,9n),3);
    const ticket=get(requestAt+8),count=v.getUint32(requestAt+48,true);
    const opaque=data.subarray(requestAt+16,requestAt+48).toString('hex');
    assert.equal(v.getUint32(requestAt+52,true),1);assert(count<=4096);
    const bytes=await readFile(path.join(fixture,opaque));assert.equal(bytes.length,count);data.set(bytes,objectAt);
    if(controls){
      assert.equal(vm.vm_directory_object_commit(objectAt,count,9n,lastNodeTicket),-141);
      data[objectAt]^=1;assert.equal(vm.vm_directory_object_commit(objectAt,count,9n,ticket),-35);
      data[objectAt]^=1;assert(cpu().equals(expected));checks+=2;
    }
    assert.equal(vm.vm_directory_object_commit(objectAt,count,9n,ticket),0);
    assert.equal(vm.vm_directory_object_commit(objectAt,count,9n,ticket),-141);
    assert.equal(vm.vm_directory_status(),4);assert(cpu().equals(expected));++objectReads;bytesRead+=count;++objects;
    return {bytes:data.subarray(objectAt,objectAt+count),ticket};
  }
  reset();
  for(const rank of [0,49,50,2249,2999])await lookup(rank,{controls:true});
  const verified=await lookup(7);
  // The C-verified buffer stays pinned, and these exact bytes are passed to
  // the engine once. No refetch/hash substitute or host canonical row parser.
  const module=new WebAssembly.Module(verified.bytes),instance=new WebAssembly.Instance(module,{machine:{memory}});
  const table=vm.__indirect_function_table,first=vm.vm_slot_min();
  table.grow(Math.max(0,first+vm.vm_source_capacity()-table.length));
  assert.equal(vm.vm_source_query(port,0x400000n,3,codeView,rows),1n);
  const slot=v.getUint32(rows+16,true);table.set(slot,instance.exports.cut);
  // This fixture's source/span proof came from --emit's actual C report.
  // Artifact identity alone is never substituted for this compiler obligation.
  assert.equal(vm.vm_source_publish(15,3,0,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const expected=cpu();expected.writeBigUInt64LE(7n,0);expected.writeBigUInt64LE(3n,24);
  expected.writeBigUInt64LE(0x40000fn,384);expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(44n,1128);
  assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),3n);
  assert(cpu().equals(expected));
  vm.vm_directory_cancel_request();assert.equal(vm.vm_directory_query(9n,1n,8n,1),0);
  assert.equal(vm.vm_directory_request(requestAt,9n),2);const cancelled=get(requestAt+8);
  vm.vm_directory_cancel_request();assert.equal(vm.vm_directory_query(9n,1n,8n,1),0);
  assert.equal(vm.vm_directory_request(requestAt,9n),2);assert(get(requestAt+8)>cancelled);
  assert.equal(vm.vm_directory_node_commit(nodeAt,v.getUint32(requestAt+48,true),9n,cancelled),-141);
  const beforeClose=get(requestAt+8);reset();assert.equal(vm.vm_directory_query(9n,1n,8n,1),0);
  assert.equal(vm.vm_directory_request(requestAt,9n),2);assert(get(requestAt+8)>beforeClose);
  assert.equal(vm.vm_directory_node_commit(nodeAt,v.getUint32(requestAt+48,true),9n,beforeClose),-141);checks+=2;
  assert.equal(vm.vm_directory_bind(state,9n,4096),-140);
  data[rootAt+52]=1;assert.equal(vm.vm_directory_bind(rootAt,9n,4096),-140);assert.equal(vm.vm_directory_status(),0);++checks;
  vm.vm_close();
  console.log(JSON.stringify({format:'c-artifact-directory-provider-v1',status:'pass',objects,nodeReads,objectReads,bytesRead,
    fixtureRows:3000,queriedRows:objects,maximumPathNodes:3,checks,compiledRetired:3,
    authority:'fixture root selected by the test; release-root authentication and full ELF closure not established',
    guestExecution:'exact verified C-emitted Wasm via C source/MMU/table dispatcher',linuxBoot:'not-tested'},null,2));
}
