// Actual C-Wasm lifecycle gate. No JavaScript instruction/MMU implementation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const file = process.argv[2];
if (!file) throw new Error('usage: check-page-supply.mjs VM.WASM');
const memory = new WebAssembly.Memory({initial:8,maximum:128});
const vm = (await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
for (const name of ['vm_page_prepare','vm_page_commit','vm_grow'])
  assert.equal(typeof vm[name],'function',`missing C page supply: ${name}`);
let data = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
const input = vm.vm_arena_min(), rows = input + 8192, branches = input + 12288;
const base = input + 16384, port = base + 2048, request = base + 2176;
const word = (at,value) => view.setBigUint64(at,BigInt(value),true);
const dword = (at,value) => view.setUint32(at,value,true);
// Exact Linux boot-protocol header shape, not an instruction implementation.
data[input + 0x1f1] = 31; data[input + 0x200] = 0xeb; data[input + 0x201] = 0x6a;
view.setUint16(input + 0x1fe,0xaa55,true); dword(input + 0x202,0x53726448);
view.setUint16(input + 0x206,0x20f,true); data[input + 0x211] = 1; data[input + 0x236] = 1;
dword(input + 0x1f4,0x2e640); dword(input + 0x230,0x200000); word(input + 0x258,0x1000000);
dword(input + 0x260,0xe62000); dword(input + 0x22c,0x37ffffff); dword(input + 0x238,2047);
assert.equal(vm.vm_boot_prepare(input,4096,0x2ea400n,0x65432n,0x8000000n,input + 4096,0),0);
assert.equal(vm.vm_boot_initial_state(base),0);
for (let rank = 0; rank < 3; ++rank) {
  const address = (rank + 4) * 4096, offset = (rank + 2) * 4096;
  assert.equal(vm.vm_boot_project(BigInt(address),base + offset,rows + 1024),1);
  word(rows + rank * 32,address); dword(rows + rank * 32 + 8,offset);
  dword(rows + rank * 32 + 12,3); dword(rows + rank * 32 + 16,1);
}
assert.equal(vm.vm_open(base,data.length - base,4096,rows,3,128,branches,9n),0);
assert.equal(vm.vm_bind_state(base),0); word(port,9);
function access(address,width = 8,rights = 1,value = 0n) {
  return vm.vm_access(port,BigInt(address),width,rights,value);
}
function prepare() {
  assert.equal(vm.vm_page_prepare(port,request),0);
  return {ticket:view.getBigUint64(request + 40,true),address:view.getBigUint64(request + 8,true),
    target:view.getUint32(request + 24,true),kind:view.getUint32(request + 32,true),
    source:view.getBigUint64(request + 16,true),bytes:view.getUint32(request + 28,true)};
}
assert.equal(vm.vm_page_prepare(port,request),-1); // Port metadata alone is not a C miss.
assert.equal(access(0x1200000),2n);
const first = prepare(); assert.equal(first.address,0x1200000n); assert.equal(first.kind,2);
assert.equal(first.source,0x204000n); assert.equal(first.bytes,4096);
data.fill(0x5a,first.target,first.target + 4096);
assert.deepEqual(prepare(),first); // Retry neither restages nor zeroes an immutable delivery.
assert.equal(data[first.target],0x5a);
assert.equal(vm.vm_page_commit(port,first.ticket + 1n),-1);
word(port,8); assert.equal(vm.vm_page_commit(port,first.ticket),-1); word(port,9);
word(base + 408,0x5000); assert.equal(vm.vm_page_commit(port,first.ticket),-1); word(base + 408,0x4000);
const cpu = data.slice(base,base + 1256);
memory.grow(1); data = new Uint8Array(memory.buffer); view = new DataView(memory.buffer);
assert.equal(vm.vm_grow(),0); assert.deepEqual(data.slice(base,base + 1256),cpu);
assert.equal(vm.vm_page_commit(port,first.ticket),0);
assert.equal(vm.vm_page_commit(port,first.ticket),-1); assert.equal(vm.vm_page_count(),4);
assert.equal(access(0x1200000),0n); assert.equal(view.getBigUint64(port + 8,true),0x5a5a5a5a5a5a5a5an);
assert.equal(access(0x1200000,8,2,0x1122334455667788n),0n);
assert.equal(vm.vm_page_prepare(port,request),-1); assert.equal(access(0x1200000),0n);
assert.equal(view.getBigUint64(port + 8,true),0x1122334455667788n);
// A resident permission miss is not permission to reload initial bytes.
dword(rows + 3 * 32 + 12,1);
assert.equal(access(0x1200000,8,2,0n),2n); assert.equal(vm.vm_page_prepare(port,request),-1);
dword(rows + 3 * 32 + 12,3);
assert.equal(access(0x1200000),0n); assert.equal(view.getBigUint64(port + 8,true),0x1122334455667788n);
assert.equal(access(0x1800000),2n); const zero = prepare();
assert.equal(zero.kind,0); assert(data.subarray(zero.target,zero.target + 4096).every(byte => byte === 0));
assert.equal(vm.vm_page_commit(port,first.ticket),-1); assert.equal(vm.vm_page_commit(port,zero.ticket),0);
// A failed cross-page store has no partial payload commit. Each subsequent
// C physical miss supplies only the actually missing fragment.
assert.equal(access(0x1800ffdn,8,2,0xffffffffffffffffn),2n);
assert(data.subarray(zero.target + 4093,zero.target + 4096).every(byte => byte === 0));
const second = prepare(); assert.equal(second.address,0x1801000n);
assert.equal(vm.vm_page_commit(port,second.ticket),0);
assert.equal(access(0x1800ffdn,8,2,0x8877665544332211n),0n);
assert.deepEqual(Array.from(data.subarray(zero.target + 4093,zero.target + 4096)),[0x11,0x22,0x33]);
assert.deepEqual(Array.from(data.subarray(second.target,second.target + 5)),[0x44,0x55,0x66,0x77,0x88]);
// Source and private-output aliasing cannot publish a page/request.
assert.equal(access(0x1900000),2n);
assert.equal(vm.vm_page_prepare(port,port),-1); assert.equal(vm.vm_page_prepare(port,base),-1);
const revoked = prepare(); assert.equal(access(0x1200000),0n);
assert.equal(vm.vm_page_commit(port,revoked.ticket),-1);
let growths = 0;
while (vm.vm_page_count() < 128) {
  assert.equal(access(0x2000000 + vm.vm_page_count() * 4096),2n);
  let status = vm.vm_page_prepare(port,request);
  if (status === -3) {
    ++growths; memory.grow(1); data = new Uint8Array(memory.buffer); view = new DataView(memory.buffer);
    assert.equal(vm.vm_grow(),0); status = vm.vm_page_prepare(port,request);
  }
  assert.equal(status,0); assert.equal(vm.vm_page_commit(port,view.getBigUint64(request + 40,true)),0);
}
assert(growths > 0); assert.equal(access(0x3000000),2n); data.fill(0xa5,request,request + 48);
assert.equal(vm.vm_page_prepare(port,request),-2); assert(data.subarray(request,request + 48).every(byte => byte === 0xa5));
assert.equal(access(0x1200000),0n); assert.equal(view.getBigUint64(port + 8,true),0x1122334455667788n);
const closing = first; vm.vm_close();
assert.equal(vm.vm_page_commit(port,closing.ticket),-1); assert.equal(vm.vm_grow(),-1);
console.log('C-Wasm page supply: green (128 pages; real payload growth/capacity gate; stale/context/replay/revocation; resident dirty protection; cross-page noncommit)');
