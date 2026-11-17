import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';

test('actual Worker start handler reports explicit core mismatch before creating a kernel',{skip:!process.env.SODS_TRANSLATOR_WASM},async()=>{
  const messages: {type:string;message?:string}[]=[];
  const host={postMessage(message:{type:string;message?:string}){messages.push(message);},onmessage:null as null|((event:{data:unknown})=>Promise<void>)};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'self');
  Object.defineProperty(globalThis,'self',{value:host,configurable:true});
  try {
    await import('../worker.ts');
    await host.onmessage!({data:{type:'start',translator:readFileSync(process.env.SODS_TRANSLATOR_WASM!),fileCore:{module:new Uint8Array([0,97,115,109,1,0,0,0]),maxFileBytes:32},muk:new Uint8Array([1]),box:{config:'{}',words:[]},cwd:'/'}});
    assert.equal(messages.length,1);assert.equal(messages[0].type,'error');assert.match(messages[0].message!,/Unsupported core files ABI/);
  } finally {
    if(previous)Object.defineProperty(globalThis,'self',previous);else Reflect.deleteProperty(globalThis,'self');
  }
});
test('prepared legacy Worker rejects a later explicit core selection instead of ignoring it',{skip:!process.env.SODS_TRANSLATOR_WASM},async()=>{
  const messages:{type:string;message?:string}[]=[];
  const host={postMessage(message:{type:string;message?:string}){messages.push(message);},onmessage:null as null|((event:{data:unknown})=>Promise<void>)};
  const previous=Object.getOwnPropertyDescriptor(globalThis,'self');Object.defineProperty(globalThis,'self',{value:host,configurable:true});
  try {
    await import(new URL('../worker.ts?selection',import.meta.url).href);
    await host.onmessage!({data:{type:'ready',translator:readFileSync(process.env.SODS_TRANSLATOR_WASM!),muk:new Uint8Array([1])}});
    await host.onmessage!({data:{type:'start',fileCore:{module:new Uint8Array([0,97,115,109,1,0,0,0]),maxFileBytes:32},box:{config:'{}',words:[]},cwd:'/'}});
    assert.equal(messages.length,1);assert.equal(messages[0].type,'error');assert.match(messages[0].message!,/selected by the first preparation/);
  } finally {if(previous)Object.defineProperty(globalThis,'self',previous);else Reflect.deleteProperty(globalThis,'self');}
});
