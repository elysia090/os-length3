import assert from 'node:assert/strict';
import {test} from 'node:test';
import {outside, type Heard} from './outside.ts';
import {relay} from './relay.ts';

// Real host bridge, tiny routing-only Wasm fixture. This does not substitute for guest/relay E2E.
const vec = (v: number[]) => [v.length, ...v];
const name = (s: string) => vec([...new TextEncoder().encode(s)]);
const section = (id: number, v: number[]) => [id, ...vec(v)];
const route = new Uint8Array([0,97,115,109,1,0,0,0,
  ...section(1,[1,0x60,0,1,0x7f]), ...section(3,[3,0,0,0]), ...section(5,[1,0,1]),
  ...section(7,[4,...name('memory'),2,0,...name('cowboy_passed'),0,0,...name('cowboy_answer'),0,1,...name('cowboy_line'),0,2]),
  ...section(10,[3,...vec([0,0x41,0,0x0b]),...vec([0,0x41,0,0x0b]),...vec([0,0x41,2,0x0b])]),
  ...section(11,[1,0,0x41,0,0x0b,2,120,10])]);
function guest() {
  return {onwrote: null as (()=>void)|null, onroom: null as (()=>void)|null, closed:false, gone:false,
    openedCount:0, closedCount:0, ends:0, refusedCode:0, received:[] as number[], pending:[new Uint8Array([7])],
    opened(){this.openedCount++;}, refused(n:number){this.refusedCode=n;},
    give(b:Uint8Array){this.received.push(...b);return b.length;}, finish(){this.ends++;},close(){this.closedCount++;},
    take(){return this.pending.shift()??new Uint8Array(0);}};
}
test('synchronous open drains safely and half-close still permits final close', async()=>{
  const far=guest(); far.gone=true; let heard!:Heard; let closes=0, fins=0; const sent:number[]=[];
  const net=await outside(route,(_,h)=>{heard=h;h.opened();return {send(b){sent.push(...b);},finish(){fins++;},close(){closes++;}};},()=>{});
  net.connect(far,{ip:new Uint8Array([1,2,3,4]),port:80});
  assert.deepEqual(sent,[7]); assert.equal(fins,1);
  heard.bytes(new Uint8Array([8])); assert.deepEqual(far.received,[8]);
  far.closed=true; far.onwrote!(); far.onwrote!();
  assert.equal(closes,1); heard.bytes(new Uint8Array([9])); heard.ended();
  assert.deepEqual(far.received,[8]); assert.equal(far.ends,0);
});
test('synchronous failure releases the returned link and ignores late success',async()=>{
  const far=guest();let heard!:Heard;let closes=0;
  const net=await outside(route,(_,h)=>{heard=h;h.failed(111);return {send(){},finish(){},close(){closes++;}};},()=>{});
  net.connect(far,{ip:new Uint8Array([1,2,3,4]),port:80});heard.opened();
  assert.equal(far.refusedCode,111);assert.equal(closes,1);assert.equal(far.openedCount,0);
});
test('cancel before delayed open cannot revive the connection',async()=>{
  const far=guest();let heard!:Heard;let closes=0;
  const net=await outside(route,(_,h)=>{heard=h;return {send(){},finish(){},close(){closes++;}};},()=>{});
  net.connect(far,{ip:new Uint8Array([1,2,3,4]),port:80});far.closed=true;far.onwrote!();heard.opened();heard.bytes(new Uint8Array([9]));heard.ended();
  assert.equal(closes,1);assert.equal(far.openedCount,0);assert.deepEqual(far.received,[]);assert.equal(far.ends,0);
});
class Wire {
  static OPEN=1; static last:Wire; readyState=1; binaryType='';sent:unknown[]=[];closes=0;
  onopen:any;onmessage:any;onerror:any;onclose:any;
  constructor(_url:string){Wire.last=this;}
  send(b:unknown){this.sent.push(b);}close(){this.closes++;}
  message(b:number[]){this.onmessage({data:new Uint8Array(b).buffer});}
}
test('relay requires explicit FINs; transport loss is failure, not EOF',t=>{
  const original=globalThis.WebSocket; globalThis.WebSocket=Wire as any; t.after(()=>{globalThis.WebSocket=original;});
  for(const code of [1000,1006]){
    const events:string[]=[];relay('wss://test')('x:80',{opened(){},bytes(){},ended(){events.push('end');},failed(n){events.push(`fail:${n}`);}});
    const ws=Wire.last;ws.message([0]);ws.onclose({code});ws.message([]);
    assert.deepEqual(events,['fail:104']);
  }
  for (const code of [1000,1005,1006]) {
    const events:string[]=[];const link=relay('wss://test')('x:80',{opened(){},bytes(){},ended(){events.push('end');},failed(n){events.push(`fail:${n}`);}});
    const ws=Wire.last;ws.message([0]);ws.message([]);ws.message([]);link.finish();link.finish();ws.onclose({code,wasClean:code!==1006});
    assert.deepEqual(events,code===1006?['end','fail:104']:['end']);assert.equal(ws.sent.length,1);
  }
});

test('synchronous send failure stops draining the guest',async()=>{
  const far=guest();far.pending.push(new Uint8Array([9]));let closes=0;let sends=0;
  const net=await outside(route,(_,h)=>{h.opened();return {send(){sends++;h.failed(104);},finish(){},close(){closes++;}};},()=>{});
  net.connect(far,{ip:new Uint8Array([1,2,3,4]),port:80});
  assert.equal(sends,1);assert.equal(closes,1);assert.equal(far.pending.length,1);
});
test('relay rejects bytes after FIN and ignores callbacks after failure',t=>{
  const original=globalThis.WebSocket;globalThis.WebSocket=Wire as any;t.after(()=>{globalThis.WebSocket=original;});
  const events:string[]=[];relay('wss://test')('x:80',{opened(){},bytes(){events.push('bytes');},ended(){events.push('end');},failed(n){events.push(`fail:${n}`);}});
  const ws=Wire.last;ws.message([0]);ws.message([]);ws.message([9]);ws.message([8]);ws.onclose({code:1006});
  assert.deepEqual(events,['end','fail:71']);assert.equal(ws.closes,1);
});
