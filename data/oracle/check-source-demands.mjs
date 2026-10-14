import assert from 'node:assert/strict';
import {SourceDemands} from '../../src/v2/web/source-demands.mjs';
const demands=new SourceDemands(8192),oldMarks=new Float64Array(8192),newMarks=new Float64Array(8192);oldMarks.fill(-1);newMarks.fill(-1);
let seed=7;const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
function walk(group,mask,epoch,marks){const result=[];for(let part=0;part<2;part++){let bits=Number(part?mask>>32n:mask&0xffffffffn)>>>0;while(bits){const rank=group*64+part*32+31-Math.clz32(bits&-bits);bits=(bits&(bits-1))>>>0;if(marks[rank]!==epoch){marks[rank]=epoch;result.push(rank);}}}return result;}
let rows=0;for(let epoch=1;epoch<=300;epoch++)for(let repeat=0;repeat<80;repeat++){
 const group=random()%128,mask=BigInt.asIntN(64,(BigInt(random())<<32n)|BigInt(random()));
 if(!(repeat%5)){const rank=group*64+random()%64;oldMarks[rank]=newMarks[rank]=epoch;}
 const previous=walk(group,mask,epoch,oldMarks),current=walk(group,demands.fresh(group,mask,epoch),epoch,newMarks);assert.deepEqual(current,previous);rows+=previous.length;
}
const f=new SourceDemands(64);assert.equal(f.fresh(0,-1n,1),0xffffffffffffffffn);assert.equal(f.fresh(0,-1n,1),0n);assert.equal(f.fresh(0,1n,2),1n);f.reset();assert.equal(f.fresh(0,1n,2),1n);
for(const args of [[-1,0n,0],[1,0n,0],[0,0,0],[0,0n,-1],[0,0n,1.5]])assert.throws(()=>f.fresh(...args),RangeError);
assert.throws(()=>new SourceDemands(0),RangeError);assert.throws(()=>new SourceDemands(8193),RangeError);
console.log(JSON.stringify({status:'pass',observations:24000,identicalDemandRanks:rows,cases:['signed high bit','all 128 banks','direct C hit already marked','publication epoch changes','owner reset','invalid metadata refusal'],scope:'host lifetime hints; C source execution and permissions unchanged'}));
