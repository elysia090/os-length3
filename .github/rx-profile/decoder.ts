import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const schema='rx-cxx-edge-capture-v1';
const hash=x=>createHash('sha256').update(x).digest('hex');
const FIRST=13, G_DEPTH=35, F_TRACE=5, F_DISPATCH=11;
const simd={"0":"V128_LOAD","11":"V128_STORE","17":"I32X4_SPLAT","18":"I64X2_SPLAT","22":"I8X16_EXTRACT_LANE_U","23":"I8X16_REPLACE_LANE","25":"I16X8_EXTRACT_LANE_U","26":"I16X8_REPLACE_LANE","27":"I32X4_EXTRACT_LANE","28":"I32X4_REPLACE_LANE","29":"I64X2_EXTRACT_LANE","30":"I64X2_REPLACE_LANE","31":"F32X4_EXTRACT_LANE","32":"F32X4_REPLACE_LANE","33":"F64X2_EXTRACT_LANE","34":"F64X2_REPLACE_LANE","35":"I8X16_EQ","39":"I8X16_GT_S","45":"I16X8_EQ","49":"I16X8_GT_S","55":"I32X4_EQ","59":"I32X4_GT_S","65":"F32X4_EQ","66":"F32X4_NE","67":"F32X4_LT","69":"F32X4_LE","70":"F32X4_GE","71":"F64X2_EQ","72":"F64X2_NE","73":"F64X2_LT","74":"F64X2_GT","75":"F64X2_LE","77":"V128_NOT","78":"V128_AND","79":"V128_AND_NOT","80":"V128_OR","81":"V128_XOR","82":"V128_BITSELECT","90":"V128_STORE32_LANE","91":"V128_STORE64_LANE","92":"V128_LOAD32_ZERO","93":"V128_LOAD64_ZERO","94":"F32X4_DEMOTE_F64X2_ZERO","95":"F64X2_PROMOTE_LOW_F32X4","100":"I8X16_BITMASK","101":"I8X16_NARROW_I16X8_S","102":"I8X16_NARROW_I16X8_U","106":"F32X4_NEAREST","108":"I8X16_SHR_S","110":"I8X16_ADD","111":"I8X16_ADD_SAT_S","112":"I8X16_ADD_SAT_U","113":"I8X16_SUB","114":"I8X16_SUB_SAT_S","115":"I8X16_SUB_SAT_U","119":"I8X16_MIN_U","121":"I8X16_MAX_U","123":"I8X16_AVGR_U","125":"I16X8_EXT_ADD_PAIRWISE_I8X16_U","127":"I32X4_EXT_ADD_PAIRWISE_I16X8_U","133":"I16X8_NARROW_I32X4_S","134":"I16X8_NARROW_I32X4_U","139":"I16X8_SHL","140":"I16X8_SHR_S","141":"I16X8_SHR_U","142":"I16X8_ADD","143":"I16X8_ADD_SAT_S","144":"I16X8_ADD_SAT_U","145":"I16X8_SUB","146":"I16X8_SUB_SAT_S","147":"I16X8_SUB_SAT_U","148":"F64X2_NEAREST","149":"I16X8_MUL","150":"I16X8_MIN_S","152":"I16X8_MAX_S","155":"I16X8_AVGR_U","164":"I32X4_BITMASK","171":"I32X4_SHL","172":"I32X4_SHR_S","173":"I32X4_SHR_U","174":"I32X4_ADD","177":"I32X4_SUB","181":"I32X4_MUL","182":"I32X4_MIN_S","183":"I32X4_MIN_U","184":"I32X4_MAX_S","185":"I32X4_MAX_U","186":"I32X4_DOT_I16X8_S","188":"I32X4_EXT_MUL_LOW_I16X8_S","189":"I32X4_EXT_MUL_HIGH_I16X8_S","190":"I32X4_EXT_MUL_LOW_I16X8_U","191":"I32X4_EXT_MUL_HIGH_I16X8_U","196":"I64X2_BITMASK","203":"I64X2_SHL","205":"I64X2_SHR_U","206":"I64X2_ADD","209":"I64X2_SUB","213":"I64X2_MUL","214":"I64X2_EQ","217":"I64X2_GT_S","227":"F32X4_SQRT","228":"F32X4_ADD","229":"F32X4_SUB","230":"F32X4_MUL","231":"F32X4_DIV","234":"F32X4_P_MIN","235":"F32X4_P_MAX","239":"F64X2_SQRT","240":"F64X2_ADD","241":"F64X2_SUB","242":"F64X2_MUL","243":"F64X2_DIV","246":"F64X2_P_MIN","247":"F64X2_P_MAX","248":"I32X4_TRUNC_SAT_F32X4_S","250":"F32X4_CONVERT_I32X4_S","252":"I32X4_TRUNC_SAT_F64X2_S_ZERO","254":"F64X2_CONVERT_LOW_I32X4_S"};
const U=n=>{assert.ok(Number.isInteger(n)&&n>=0&&n<=0xffffffff);const a=[];do{const k=n%128;n=Math.floor(n/128);a.push(k+(n?128:0));}while(n);return Buffer.from(a);};
const S=n=>{let v=BigInt(n),c;const a=[];do{c=Number(v&127n);v>>=7n;const done=(v===0n&&!(c&64))||(v===-1n&&(c&64));a.push(c+(done?0:128));if(done)break;}while(true);return Buffer.from(a);};
class Cursor {
 constructor(b,p=0,e=b.length){assert.ok(p>=0&&e>=p&&e<=b.length);this.b=b;this.p=p;this.e=e;}
 require(n){assert.ok(Number.isInteger(n)&&n>=0&&n<=this.e-this.p,'bounds '+this.p+' '+n+' '+this.e);}
 byte(){this.require(1);return this.b[this.p++];}
 skip(n){this.require(n);const p=this.p;this.p+=n;return p;}
 bytes(n){const p=this.skip(n);return this.b.subarray(p,p+n);}
 uv(bits=32){const max=Math.ceil(bits/7);let n=0n;for(let k=0;k<max;k++){let a=this.byte();n|=BigInt(a&127)<<(7n*BigInt(k));if(!(a&128)){assert.ok(n<(1n<<BigInt(bits)));return n;}}throw Error('overwide ULEB @'+this.p);}
 sv(bits){const max=Math.ceil(bits/7);let n=0n;for(let k=0;k<max;k++){let a=this.byte();n|=BigInt(a&127)<<(7n*BigInt(k));if(!(a&128)){if(a&64)n-=1n<<(7n*BigInt(k+1));assert.equal(n,BigInt.asIntN(bits,n));return n;}}throw Error('overwide SLEB @'+this.p);}
 u(){return Number(this.uv());}
 str(){const n=this.u();return this.bytes(n).toString('utf8');}
 count(){const n=this.u();assert.ok(n<=this.e-this.p,'vector cannot fit in section');return n;}
 end(){assert.equal(this.p,this.e,'unread bytes in vector/section');}
}
function limits(c){const flags=c.u();assert.ok((flags&~3)===0,'only pinned memory32/table limit forms supported');c.u();if(flags&1)c.u();}
function typed(c){const t=c.byte();assert.ok([0x7f,0x7e,0x7d,0x7c,0x7b,0x70,0x6f].includes(t),'known final module type only');return t;}
function vec(c,handle){const n=c.count(),a=[];for(let i=0;i<n;i++)a.push(handle(c,i));return a;}
function program(data,identity={}){
 const b=Buffer.from(data.buffer,data.byteOffset,data.byteLength);
 assert.ok(b.length>=8&&b.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])),'WebAssembly v1');
 assert.ok(WebAssembly.validate(b),'unauthentic or unsupported Wasm form');
 const top=new Cursor(b,8),sections=new Map,custom=new Map;
 while(top.p<top.e){
   const id=top.byte(),sizeAt=top.p,len=top.u(),start=top.skip(len),end=start+len;
   const row={id,sizeAt,start,end};
   if(id===0){const c=new Cursor(b,start,end),name=c.str();assert.ok(!custom.has(name),'duplicate custom section '+name);custom.set(name,{...row,start:c.p});}
   else {assert.ok(!sections.has(id),'duplicate core section');sections.set(id,row);}
 }
 const section=(n)=>{assert.ok(sections.has(n),'absent section '+n);const {start,end}=sections.get(n);return new Cursor(b,start,end);};
 const typ=section(1),types=vec(typ,c=>{assert.equal(c.byte(),0x60);return {args:vec(c,typed),ret:vec(c,typed)};});typ.end();
 const imports=section(2),importFunc=[];
 for(const row of vec(imports,c=>{
   const mod=c.str(),nm=c.str(),k=c.byte();let type=null;
   if(k===0)type=c.u();else if(k===1){typed(c);limits(c);}else if(k===2)limits(c);else if(k===3){typed(c);assert.ok(c.byte()<=1);}else throw Error('unrecognized import kind '+k);
   return {mod,nm,k,type};
 }))if(row.k===0)importFunc.push(row);
 imports.end();
 const [im,ty]=[importFunc[F_TRACE],types[importFunc[F_TRACE]?.type]];
 assert.deepEqual(im&&[im.mod,im.nm],[ 'env','trace' ],'proved pinned trace slot');
 assert.deepEqual(ty,{args:[0x7e],ret:[]},'proved stack-neutral trace type');
 assert.ok([8,13].includes(importFunc.length),'pinned main vs attached helper import count');
 const s3=section(3),decls=vec(s3,c=>c.u());s3.end();const code=section(10),codeSec=sections.get(10);const n=code.count();assert.equal(n,decls.length);
 const fixtures=new Map;
 for(let i=0;i<n;i++){
   const sizeAt=code.p,len=code.u(),start=code.skip(len);fixtures.set(i+importFunc.length,{idx:i+importFunc.length,type:decls[i],sizeAt,start,end:start+len,bodyBytes:len});
 }
 const startRow=custom.get('sods.starts');assert.ok(startRow&&(startRow.end-startRow.start)%8===0,'sods.starts required');
 const pc=[];
 for(let p=startRow.start;p<startRow.end;p+=8)pc.push(b.readBigUInt64LE(p));
 assert.ok(pc.length===fixtures.size-(FIRST-importFunc.length),'start/index witness');
 const entryRow=custom.get('sods.entries');const slots=new Map;
 if(entryRow){assert.ok((entryRow.end-entryRow.start)%16===0,'entries [%pc,%packed]');for(let p=entryRow.start;p<entryRow.end;p+=16){
  const a=b.readBigUInt64LE(p),v=b.readBigUInt64LE(p+8),key=v.toString();const prior=slots.get(key)??[];prior.push(a);slots.set(key,prior);
 }}
 const names=new Map;const nm=custom.get('name');
 if(nm){const z=new Cursor(b,nm.start,nm.end);while(z.p<z.e){const id=z.byte(),n=z.u(),s=z.skip(n);if(id===1){const k=new Cursor(b,s,s+n);for(const [idx,nm] of vec(k,c=>[c.u(),c.str()])){assert.ok(!names.has(idx));names.set(idx,nm);}k.end();}}}
 code.end();return {schema,b,sha:hash(b),identity,importFunc,types,decls,fixtures,pc,names,slots,codeSec};
}
const plain=new Set([0,1,5,11,15,26,27, ...Array.from({length:128},(_,i)=>i+0x45)]);
const idxOne=new Set([12,13,16,18,32,33,34,35,36,37,38,0xd2]);
function mem(c){const a=c.u();assert.ok(a<64,'pinned single-memory memarg only');return [a,c.uv(64).toString()];}
function decode(p,fn){
 const {b}=p;const c=new Cursor(b,fn.start,fn.end),ls=vec(c,z=>[z.u(),typed(z)]),ops=[];
 const opStart=c.p;
 while(c.p<c.e){
   const start=c.p;const o=c.byte();let a=[],kind=String(o);
   if(plain.has(o)){}
   else if([2,3,4].includes(o))a=[c.sv(33).toString()];
   else if(idxOne.has(o))a=[c.u()];
   else if(o===14){const n=c.u();assert.ok(n<c.e-c.p);for(let i=0;i<=n;i++)a.push(c.u());}
   else if(o===17||o===19)a=[c.u(),c.u()];
   else if(o>=0x28&&o<=0x3e)a=mem(c);
   else if(o===63||o===64){a=[c.u()];assert.equal(a[0],0);}
   else if(o===65||o===66)a=[c.sv(o===65?32:64).toString()];
   else if(o===67||o===68)a=[c.bytes(o===67?4:8).toString('hex')];
   else if(o===28)a=vec(c,typed);
   else if(o===0xd0)a=[c.sv(33).toString()];
   else if(o===0xd1){}
   else if(o===0xfc){
     const n=c.u();kind='fc.'+n;
     if(n<=7){}
     else if(n===10){a=[c.u(),c.u()];assert.deepEqual(a,[0,0]);}
     else if(n===11){a=[c.u()];assert.equal(a[0],0);}
     else throw Error('unclassified fc '+n+' @'+start+' in '+fn.idx);
   } else if(o===0xfd){
     const n=c.u();kind='fd.'+n;const k=simd[n];
     if(n===12||n===13)a=[c.bytes(16).toString('hex')];
     else if(!k)throw Error('unclassified fd '+n+' @'+start+' in '+fn.idx);
     else if(k.startsWith('V128_LOAD')||k.startsWith('V128_STORE')){a=mem(c);if(k.endsWith('_LANE'))a.push(c.byte());}
     else if(k.includes('_LANE'))a=[c.byte()];
   } else throw Error('unclassified opcode '+o+' @'+start+' in '+fn.idx);
   ops.push({start,end:c.p,o,kind,a});
 }
 assert.equal(ops.at(-1)?.o,0x0b);
 return {ops,ls,opStart};
}
const match=(r,p)=>r&&p.every((x,k)=>(k===0?r.o:r.a[k-1])===x);
function classify(p,fn,ops,i){
 const x=ops[i];if(fn.idx<FIRST||![16,17,18,19].includes(x.o))return null;
 const target=x.a[0],before=ops[i-1],after=ops[i+1];
 const kind=x.o===18?'return-call':x.o===19?'return-call-indirect':x.o===17?'call-indirect':target===F_DISPATCH?'dispatch-call':target>=FIRST?'unproved-direct':'other-helper';
 if(kind==='other-helper')return null;
 let relation=kind,known=false,continuation=null,local=null,block=null;
 if(x.o===16&&target>=FIRST){
  if(match(before,[65])&&match(after,[33])){
   block=Number(before.a[0]);local=after.a[0];
   const left=[[35,G_DEPTH],[65,'1'],[106],[36,G_DEPTH]];
   const right=[[35,G_DEPTH],[65,'1'],[107],[36,G_DEPTH]];
   const l=left.every((e,k)=>match(ops[i-5+k],e)),r=right.every((e,k)=>match(ops[i+2+k],e));
   const j=i+(l&&r?6:2);
   if((l===r)&&match(ops[j],[32,local])&&match(ops[j+1],[66])&&match(ops[j+2],[82])&&match(ops[j+3],[4])&&(l||block===0)){
      known=true;relation=l?'known-general-call':'known-quiet-call';continuation=ops[j+1].a[0];
   }
  }
 }
 const fld=target>=FIRST&&p.pc[target-FIRST]!==undefined?p.pc[target-FIRST]:null;
 return {schema,type:'site',hash:p.sha,fixtureOrImage:p.identity.id??null,elfSha:p.identity.elfSha??null, translatorSha:p.identity.translatorSha??null,
         sourceEpoch:p.identity.sourceEpoch??null,slotBase:p.identity.slotBase??null, moduleRole:p.importFunc.length===8?'main':'late',
         status:known?'stock-template-proved':'unknown-method-or-helper',sourceClass:relation,
         functionIdx:fn.idx,callerEntryPc:'0x'+p.pc[fn.idx-FIRST].toString(16),bodyStart:fn.start,bodyBytes:fn.bodyBytes,
         bodySha:hash(p.b.subarray(fn.start,fn.end)),absoluteOffset:x.start,relativeToBody:x.start-fn.start,
         bytes:p.b.subarray(x.start,x.end).toString('hex'),targetWasmFunc:x.o===16||x.o===18?target:null,
         targetFunctionStart:fld===null?null:'0x'+fld.toString(16),calleeEntryBlock:block,
         guestReturnPc:continuation===null?null:'0x'+BigInt(continuation).toString(16),guestCallPc:null};
}
function sitesOf(p, range=null){
 let sites=[],skips=[],decoded=0;
 for(const fn of p.fixtures.values()){
  if(fn.idx<FIRST||(range&&!range.has(fn.idx)))continue;
  let info;try{info=decode(p,fn);decoded++;}catch(e){skips.push({functionIdx:fn.idx,bodyStart:fn.start,bodyBytes:fn.bodyBytes,reason:String(e.message)});continue;}
  for(let i=0;i<info.ops.length;i++){const t=classify(p,fn,info.ops,i);if(t)sites.push(t);}
 }
 return {schema,decoded,skips,sites};
}
function activateNearRel32(p,site,elf,{bodyPc,fileOffset,expectedSite}){
 // Narrow independent toy witness only. For full ELF use a pinned real x86 decoder and source-block CFG.
 assert.equal(hash(elf),p.identity.elfSha);
 assert.equal(site.status,'stock-template-proved');assert.equal(site.calleeEntryBlock,0);
 assert.equal(BigInt(site.guestReturnPc),bodyPc+5n);
 assert.equal(site.callerEntryPc,'0x'+bodyPc.toString(16));
 assert.ok(fileOffset+5<=elf.length);assert.equal(elf[fileOffset],0xe8);
 assert.equal(BigInt(site.targetFunctionStart),bodyPc+5n+BigInt(elf.readInt32LE(fileOffset+1)));
 assert.equal(site.absoluteOffset,expectedSite);
 return {...site, guestCallPc:'0x'+bodyPc.toString(16), nativeWitness:{form:'caller_entry_rel32_5',vma:'0x'+bodyPc.toString(16),elfOffset:fileOffset,bytes:elf.subarray(fileOffset,fileOffset+5).toString('hex')}};
}
function counterProbe(p,selected){
 const k=0x200000000n, byF=new Map, tags=new Map;
 for(let j=0;j<selected.length;j++){
  const site=selected[j];assert.equal(site.hash,p.sha);assert.equal(site.status,'stock-template-proved');
  const fn=p.fixtures.get(site.functionIdx),{ops}=decode(p,fn);const i=ops.findIndex(x=>x.start===site.absoluteOffset);
  assert.ok(i>=0&&ops[i].o===16);const x=classify(p,fn,ops,i);
  assert.equal(x.sourceClass,site.sourceClass);assert.equal(x.bytes,site.bytes);
  const tag=k+BigInt(j);tags.set(tag,site);
  const part=Buffer.concat([Buffer.of(0x42),S(tag),Buffer.of(0x10,F_TRACE)]);
  const fnList=byF.get(fn.idx)??[];fnList.push({start:site.absoluteOffset,part,tag});byF.set(fn.idx,fnList);
 }
 // Safe choice for this counter form: original module must not be trace-instrumented.
 // Decode every body, including helpers, before granting the high-tag namespace.
 // A module skipped by the static census cannot be counter-instrumented until a trusted decoder closes coverage.
 for(const f of p.fixtures.values()){
   const {ops}=decode(p,f);
   assert.ok(!ops.some(o=>[0x10,0x12].includes(o.o)&&o.a[0]===F_TRACE),'stock already calls trace; cannot use this namespace safely');
 }
 let b=p.b,cc=p.codeSec;const bodyParts=[],branches=[];let cursor=cc.start;
 for(const [id,list] of [...byF].sort((a,b)=>a[0]-b[0])){
   const fn=p.fixtures.get(id),mark=list.sort((a,b)=>a.start-b.start);let v=fn.start;
   const groups=[], mask=[];let add=0;
   for(const t of mark){assert.ok(t.start>=v&&t.start<fn.end);if(t.start===v&&groups.length)throw Error('duplicate/overlap');groups.push(b.subarray(v,t.start),t.part);mask.push({p:t.start-fn.start+add,n:t.part.length,tag:t.tag.toString()});v=t.start;add+=t.part.length;}
   groups.push(b.subarray(v,fn.end));
   const sub=Buffer.concat(groups),bodyLen=U(sub.length);
   assert.equal(sub.length,fn.bodyBytes+add);
   bodyParts.push(b.subarray(cursor,fn.sizeAt),bodyLen,sub);branches.push({fn,delta:add,mask});cursor=fn.end;
 }
 bodyParts.push(b.subarray(cursor,cc.end));const code=Buffer.concat(bodyParts);
 const patched=Buffer.concat([b.subarray(0,cc.sizeAt),U(code.length),code,b.subarray(cc.end)]);
 const ran=program(patched,{...p.identity,kind:'diagnostic-counter'});
 // Recover actual patched spans, remove only tagged bytes, restore original prefixes, verify exact original bytes.
 const aa=[];let sp=ran.codeSec.start;
 for(const {fn,mask} of branches){
   const f=ran.fixtures.get(fn.idx);aa.push(patched.subarray(sp,f.sizeAt),b.subarray(fn.sizeAt,fn.start));
   let prev=0;for(const rm of mask){aa.push(patched.subarray(f.start+prev,f.start+rm.p));prev=rm.p+rm.n;}
   aa.push(patched.subarray(f.start+prev,f.end));sp=f.end;
 }
 aa.push(patched.subarray(sp,ran.codeSec.end));
 const reverse=Buffer.concat([patched.subarray(0,ran.codeSec.sizeAt),b.subarray(cc.sizeAt,cc.start),...aa,patched.subarray(ran.codeSec.end)]);
 assert.ok(reverse.equals(b),'entire original byte identity');
 return {patched,tags,verifyHash:hash(reverse),diagnosticHash:ran.sha,branches};
}


// Entry points only; the decoder body above is the exact archived capture unit.
export { program, sitesOf, decode, activateNearRel32, counterProbe, hash };
