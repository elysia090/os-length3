// Real C-Wasm physical image/page/MMU checks, not Linux boot or a JS VFS.
import assert from 'node:assert/strict';
import {open,readFile,stat} from 'node:fs/promises';

const [providerFile,kernelFile,initramfsFile,imageFile,...extra]=process.argv.slice(2);
if (!imageFile || extra.length) throw new Error('usage: check-boot-image.mjs VM.WASM SHIPPED-BZIMAGE SHIPPED-INITRAMFS IMMUTABLE-SYSTEM-IMAGE');
const imageBytes=(await stat(imageFile)).size;
assert(Number.isSafeInteger(imageBytes) && imageBytes>0 && imageBytes<=0x10000000);
const kernelBytes=(await stat(kernelFile)).size;
const initramfsBytes=(await stat(initramfsFile)).size;
assert(Number.isSafeInteger(initramfsBytes) && initramfsBytes>0);
const kernel=await open(kernelFile,'r'), image=await open(imageFile,'r');
const address=0x30000000n, ram=0x8000000n;
try {
  const header=new Uint8Array(4096);
  assert.equal((await kernel.read(header,0,header.length,0)).bytesRead,header.length);
  const command=new TextEncoder().encode(`console=ttyS0 nokaslr memmap=0x${imageBytes.toString(16)}$0x30000000 phram.phram=system,0x30000000,0x${imageBytes.toString(16)}`);
  const module=new WebAssembly.Module(await readFile(providerFile));
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
  const memory=new WebAssembly.Memory({initial:8,maximum:16});
  const vm=new WebAssembly.Instance(module,{machine:{memory}}).exports;
  assert.equal(typeof vm.vm_boot_image,'function','reserved immutable image missing from C loader');
  const input=vm.vm_arena_min(), source=input+8192, directory=input+12288, branches=directory+256;
  const base=input+16384, target=base+4096, port=base+2048, request=base+2112;
  const data=new Uint8Array(memory.buffer), view=new DataView(memory.buffer);
  data.set(header,input); data.set(command,input+4096);
  const prepare=()=>vm.vm_boot_prepare(input,4096,BigInt(kernelBytes),BigInt(initramfsBytes),ram,input+4096,command.length);
  assert.equal(prepare(),0);
  data.fill(0xa5,target,target+4096); data.fill(0x5a,source,source+16);
  assert.equal(vm.vm_boot_project(address,target,source),-1);
  assert(data.subarray(target,target+4096).every(byte=>byte===0xa5));
  assert(data.subarray(source,source+16).every(byte=>byte===0x5a));
  assert.equal(vm.vm_boot_image(address,BigInt(imageBytes)),0);
  const last=BigInt(imageBytes-1)&~4095n;
  let sourceBytes=0, projected=0;
  const offsets=[0n,last];
  for (let i=1;i<=64;++i) offsets.push(BigInt(Math.floor(Number(last)/4096*i/65))*4096n);
  for (const offset of offsets) {
    data.fill(0xa5,target,target+4096);
    assert.equal(vm.vm_boot_project(address+offset,target,source),5);
    assert.equal(view.getBigUint64(source,true),offset);
    const bytes=view.getUint32(source+8,true);
    assert.equal(bytes,Math.min(4096,imageBytes-Number(offset)));
    assert.equal(view.getUint32(source+12,true),5);
    assert(data.subarray(target,target+4096).every(byte=>byte===0xa5),'source projection must not materialize payload');
    const expected=new Uint8Array(bytes);
    assert.equal((await image.read(expected,0,bytes,Number(offset))).bytesRead,bytes);
    data.set(expected,target); data.fill(0,target+bytes,target+4096);
    sourceBytes+=bytes; ++projected;
  }
  assert.equal(vm.vm_boot_image(address,1n),-1,'projection seals image coordinates');
  assert.equal(vm.vm_boot_project(address-4096n,target,source),-1);
  assert.equal(vm.vm_boot_project(address+last+4096n,target,source),-1);
  assert.equal(vm.vm_boot_project(0x1000n,target,source),1);
  assert.equal(data[target+0x1e8],4);
  assert.equal(view.getBigUint64(target+0x30c,true),address);
  assert.equal(view.getBigUint64(target+0x314,true),(BigInt(imageBytes)+4095n)&~4095n);
  assert.equal(view.getUint32(target+0x31c,true),2);
  assert.equal(vm.vm_boot_project(0x2000n,target,source),1);
  assert.deepEqual(data.subarray(target,target+command.length),command);

  // Reopen revokes the plan. Invalid pre-projection replacement must not leave
  // a stale image reachable, including overflowing/unmapped coordinates.
  for (const [at,bytes] of [[address,0n],[address+1n,4096n],[ram-4096n,1n],
      [0xfffffffffffff000n,8192n],[0x3ffff000n,4097n],[address,0x10000001n]]) {
    assert.equal(prepare(),0); assert.equal(vm.vm_boot_image(address,BigInt(imageBytes)),0);
    assert.equal(vm.vm_boot_image(at,bytes),-1);
    assert.equal(vm.vm_boot_project(address,target,source),-1);
    assert.equal(vm.vm_boot_project(0x1000n,target,source),1); assert.equal(data[target+0x1e8],3);
  }
  assert.equal(prepare(),0); assert.equal(vm.vm_boot_image(address,BigInt(imageBytes)),0);
  for (let i=0;i<3;++i) {
    const physical=0x4000n+BigInt(i*4096), slot=base+(i+1)*4096, row=directory+i*32;
    assert.equal(vm.vm_boot_project(physical,slot,source),1);
    view.setBigUint64(row,physical,true); view.setUint32(row+8,slot-base,true);
    view.setUint32(row+12,3,true); view.setUint32(row+16,1,true); data.fill(0,row+20,row+32);
  }
  assert.equal(vm.vm_boot_initial_state(base),0);
  // The C-generated identity page tables reach the reserved image through the
  // real long-mode MMU. No host translation or fake pending record is supplied.
  view.setBigUint64(port,9n,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,3,8,branches,9n),0);
  assert.equal(vm.vm_bind_state(base),0);
  assert.equal(vm.vm_boot_image(address,1n),-1,'active memory cannot rebind its image');
  for (const offset of [0n,last]) {
    const cpu=data.slice(base,base+1256);
    assert.equal(vm.vm_access(port,address+offset,1,1,0n),2n);
    assert.equal(vm.vm_page_prepare(port,request),0);
    assert.equal(view.getBigUint64(request+16,true),offset);
    assert.equal(view.getUint32(request+32,true),5);
    const bytes=view.getUint32(request+28,true), slot=view.getUint32(request+24,true);
    const ticket=view.getBigUint64(request+40,true), saved=data.slice(request,request+48);
    assert.equal(vm.vm_page_prepare(port,request),0);
    assert.deepEqual(data.subarray(request,request+48),saved);
    assert.equal(vm.vm_page_commit(port,ticket+1n),-1);
    const expected=new Uint8Array(bytes);
    assert.equal((await image.read(expected,0,bytes,Number(offset))).bytesRead,bytes);
    data.set(expected,slot); data.fill(0,slot+bytes,slot+4096);
    assert.equal(vm.vm_page_commit(port,ticket),0);
    assert.equal(vm.vm_page_commit(port,ticket),-1);
    assert.equal(vm.vm_access(port,address+offset,1,1,0n),0n);
    assert.equal(view.getBigUint64(port+8,true),BigInt(expected[0]));
    assert.equal(vm.vm_access(port,address+offset,1,2,BigInt(expected[0]^255)),0n);
    assert.equal(data[slot],expected[0]^255,'phram writes change private resident RAM');
    assert.deepEqual(data.subarray(slot+1,slot+bytes),expected.subarray(1));
    const sourceByte=new Uint8Array(1);
    assert.equal((await image.read(sourceByte,0,1,Number(offset))).bytesRead,1);
    assert.equal(sourceByte[0],expected[0],'guest writes cannot modify immutable backing object');
    assert.equal(vm.vm_access(port,address+offset,1,1,0n),0n);
    assert.equal(view.getBigUint64(port+8,true),BigInt(expected[0]^255));
    assert.deepEqual(data.subarray(base,base+1256),cpu,'supply and MMU cannot mutate CPU');
    sourceBytes+=bytes;
  }
  assert.equal(vm.vm_page_count(),5);
  vm.vm_close(); assert.equal(vm.vm_boot_image(address,BigInt(imageBytes)),-1);
  console.log(JSON.stringify({format:'c-boot-image-probe-v1',status:'pass',linuxBoot:'not-tested',
    imageBytes,physicalAddress:`0x${address.toString(16)}`,projectedPages:projected,sourceBytes,
    residentImagePages:2,pageTablePages:3,memoryBytes:memory.buffer.byteLength,filesystemInterpreter:'guest Linux, not tested by this page probe'},null,2));
} finally { await kernel.close(); await image.close(); }
