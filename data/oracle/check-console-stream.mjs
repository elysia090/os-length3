import assert from 'node:assert/strict';
import {ConsoleStream} from '../../src/v2/web/console-stream.mjs';
let next=0;const tasks=new Map(),fragments=[];
const stream=new ConsoleStream(bytes=>fragments.push(Uint8Array.from(bytes)),{
  schedule:callback=>{tasks.set(++next,callback);return next;},
  cancel:id=>tasks.delete(id)
});
const encoder=new TextEncoder();
for(const byte of encoder.encode('\x1b[18t'))stream.write(Uint8Array.of(byte));
assert.equal(fragments.length,0);assert.equal(tasks.size,1);
for(const [id,callback] of tasks){tasks.delete(id);callback();}
assert.equal(new TextDecoder().decode(fragments[0]),'\x1b[18t');
assert.equal(tasks.size,0);
stream.write(encoder.encode('prompt'));assert.equal(tasks.size,1);
stream.write(Uint8Array.of(10));assert.equal(tasks.size,0);
assert.equal(new TextDecoder().decode(fragments[1]),'prompt\n');
const bytes=Uint8Array.from({length:5000},(_,i)=>128+i%128);
stream.write(bytes);stream.flush();assert.equal(tasks.size,0);
assert.deepEqual(Buffer.concat(fragments.slice(2).map(x=>Buffer.from(x))),Buffer.from(bytes));
assert(fragments.every(x=>x.length>0&&x.length<=2048));
const count=fragments.length;stream.flush();assert.equal(fragments.length,count);
// WebIDL Worker timers reject a ConsoleStream receiver. Node timers accept
// it, so model that browser-only contract before exercising default hooks.
const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
let scheduled,cancelled;
try{
  globalThis.setTimeout=function(callback){assert.equal(this,undefined);scheduled=callback;return 17;};
  globalThis.clearTimeout=function(timer){assert.equal(this,undefined);cancelled=timer;};
  const ordinary=new ConsoleStream(()=>{});
  ordinary.write(encoder.encode('prompt'));assert.equal(typeof scheduled,'function');
  ordinary.write(Uint8Array.of(10));assert.equal(cancelled,17);
}finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
console.log('console transport: bounded, exact, batched; non-LF query flushes at next host task; not guest tty evidence');
