// Standard Linux boot input / privileged C-loader gate, not syscall emulation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [file]=process.argv.slice(2);if(!file)throw new Error('VM.WASM');
const memory=new WebAssembly.Memory({initial:32});
const vm=(await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
const a=new Uint8Array(memory.buffer),v=new DataView(memory.buffer),h=vm.vm_arena_min(),command=h+4096,seed=h+8192,page=h+12288,row=h+16384;
const put=(p,x,n)=>{for(let i=0;i<n;++i)a[p+i]=Number(BigInt(x)>>BigInt(8*i)&255n);};
a[h+0x1f1]=31;a[h+0x200]=0xeb;a[h+0x201]=0x6a;a[h+0x211]=1;a[h+0x236]=1;
put(h+0x1fe,0xaa55,2);put(h+0x202,0x53726448,4);put(h+0x206,0x20f,2);put(h+0x1f4,0x2e640,4);
put(h+0x230,0x200000,4);put(h+0x258,0x1000000,8);put(h+0x260,0xe62000,4);put(h+0x22c,0x37ffffff,4);put(h+0x238,2047,4);
a[command]=0x61;for(let i=0;i<64;++i)a[seed+i]=(i*29+7)&255;
const prepare=()=>assert.equal(vm.vm_boot_prepare(h,4096,0x2ea400n,0x65432n,0x8000000n,command,1),0);
let refusals=0;prepare();
for(const length of [0,1,31,32,63,65,128,0xffffffff]){assert.equal(vm.vm_boot_entropy(seed,length),-1);++refusals;}
for(const offset of [0,h-64,a.length-63,0xfffffff8]){assert.equal(vm.vm_boot_entropy(offset,64),-1);++refusals;}
assert.equal(vm.vm_boot_entropy(seed,64),0);assert.equal(vm.vm_boot_entropy(seed,64),-1);++refusals;
assert.equal(vm.vm_boot_project(0x1000n,page,row),1);assert.equal(v.getBigUint64(page+0x250,true),0x7000n);
assert.equal(vm.vm_boot_entropy(seed,64),-1);++refusals;
assert.equal(vm.vm_boot_project(0x7000n,page,row),1);
assert.equal(v.getBigUint64(page,true),0n);assert.equal(v.getUint32(page+8,true),9);assert.equal(v.getUint32(page+12,true),64);
assert.deepEqual(a.slice(page+16,page+80),a.slice(seed,seed+64));assert(a.slice(page+80,page+4096).every(x=>x===0));
const before=Buffer.from(a);assert.equal(vm.vm_boot_project(0x7000n,page,row),-1);assert(Buffer.from(a).equals(before));++refusals;
vm.vm_close();prepare();assert.equal(vm.vm_boot_entropy(seed,64),0);
assert.equal(vm.vm_open(page,a.length-page,4096,h,0,1,0,9n),-1,'unprojected secret cannot be copied into a saved arena plan');++refusals;
assert.equal(vm.vm_boot_project(0x7000n,page,row),-1,'failed open revokes and erases the seed');++refusals;
prepare();assert.equal(vm.vm_boot_project(0x1000n,page,row),1);assert.equal(v.getBigUint64(page+0x250,true),0n);
assert.equal(vm.vm_boot_entropy(seed,64),-1);++refusals;vm.vm_close();
console.log(JSON.stringify({format:'linux-boot-entropy-loader-v1',status:'pass',refusals,bytes:64,protocol:'SETUP_RNG_SEED=9',scope:'C loader one-use/freeze/extent/close gates; deterministic test input, not entropy quality or Linux boot'},null,2));
