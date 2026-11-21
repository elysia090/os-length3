#!/usr/bin/env node
// CI Wasm backend adapter for the exact stock producer's --whole contract.
// This is intentionally not the native Sods executable or native AOT evidence.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const [flag,elfPath,out,...extra]=process.argv.slice(2);
assert(flag==='--whole' && elfPath && out && !extra.length);
const translator=readFileSync(process.env.RX_ATTESTED_WASM);
const elf=readFileSync(elfPath);
assert.equal(sha(translator),'1422a0f7e11788880a4c13a78eba901e36813abb8243d5389ea24ac73a1c0614');
assert.equal(sha(elf),'5b10f1705ad5250b74aa56548d72263db52c9737061db005c8186c8c295e4d63');
const {exports:e}=new WebAssembly.Instance(await WebAssembly.compile(translator),{});
const at=e.sods_alloc(elf.length);
new Uint8Array(e.memory.buffer,at,elf.length).set(elf);
const st=e.sods_translate_whole(at,elf.length);
const payload=new Uint8Array(e.memory.buffer,e.sods_output_ptr(),e.sods_output_len());
assert.equal(st,0,st?new TextDecoder().decode(payload):'');
assert(WebAssembly.validate(payload));
writeFileSync(out,payload,{flag:'wx'});
