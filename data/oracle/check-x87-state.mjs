// Actual native FPU observations -> cold C compiler -> C MMU/table.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory,rawInputMode,diagnosticMode]=process.argv.slice(2);
const underflow=rawInputMode?.endsWith('-underflow'),inputMode=underflow?rawInputMode.slice(0,-10):rawInputMode;
assert(!diagnosticMode||['--diagnostic','--trig-contract','--log-contract','--angle-contract'].includes(diagnosticMode));
const mismatches=[],structuralMismatches=[],differentOffsets=new Map();let mismatchCount=0;
const requestedMode=['--arctangent','--logarithm-one','--logarithm','--exponential','--sin','--cos','--sincos','--tan','--scale','--remainder','--nearest-remainder','--extract','--root'].includes(inputMode)?'--register':inputMode==='--examine'?'--stack':inputMode==='--packed-integer-float'?'--integer-float':inputMode==='--rounded-float-integer'||inputMode==='--quad-float-integer'?'--float-integer-complete':['--integral-round','--pairwise','--dot','--square-root','--approximate','--format-change'].includes(inputMode)?'--float-arithmetic':inputMode;
const standard=requestedMode==='--packed-standard';
const absolute=requestedMode==='--mmx-absolute';
const widen=requestedMode==='--widen';
const integralRound=inputMode==='--integral-round';
const pairwise=inputMode==='--pairwise';
const dot=inputMode==='--dot';
const squareRoot=inputMode==='--square-root';
const approximate=inputMode==='--approximate';
const formatChange=inputMode==='--format-change';
const packedIntegerFloat=inputMode==='--packed-integer-float';
const quadFloatInteger=inputMode==='--quad-float-integer';
const examine=inputMode==='--examine';
const root=inputMode==='--root';
const extract=inputMode==='--extract';
const trig=['--sin','--cos','--sincos','--tan'].includes(inputMode);
const exponential=inputMode==='--exponential';
assert(!underflow||trig||exponential);
const trigContract=diagnosticMode==='--trig-contract';assert(!trigContract||trig);
let trigWords=0,maximumProductUlps=0,maximumPhysicalUlps=0,independentC1=0;
const binarySpecial=['--arctangent','--logarithm-one','--logarithm','--scale','--remainder','--nearest-remainder'].includes(inputMode);
const logarithmOne=inputMode==='--logarithm-one',logarithm=logarithmOne||inputMode==='--logarithm';
const angleContract=diagnosticMode==='--angle-contract',logContract=diagnosticMode==='--log-contract'||angleContract;assert(!logContract||logarithm||inputMode==='--arctangent');
let logarithmWords=0,logarithmC1=0,logarithmExactBoundaries=0,undefinedRepresentatives=0,analyticAngleRounding=0,maximumLogProductUlps=0,maximumLogPhysicalUlps=0;
const packedFloat=({'--packed-minmax':'--minmax','--packed-predicate':'--predicate'})[requestedMode];
const packedVariant=({'--horizontal':{mode:'--packed-extended',prefix:'packed-horizontal',forms:450},
  '--reduction':{mode:'--packed-extended',prefix:'vector-reduction',forms:225},
  '--string-compare':{mode:'--packed-extended',prefix:'vector-string',forms:6144},
  '--distance':{mode:'--packed-extended',prefix:'vector-distance',forms:360},
  '--projection':{mode:'--packed-extended',prefix:'vector-projection',forms:60},
  '--select':{mode:'--packed-extended',prefix:'vector-select',forms:12288},
  '--mmx-horizontal':{mode:'--mmx-extended',prefix:'mmx-horizontal',forms:270},
  '--swizzle':{mode:'--packed-extended',prefix:'vector-swizzle',forms:45},
  '--mmx-swizzle':{mode:'--mmx-extended',prefix:'mmx-swizzle',forms:27}})[requestedMode];
const align=requestedMode==='--align',signmask=requestedMode==='--mask',doubleShuffle=requestedMode==='--shuffle-double',half=requestedMode==='--half',predicate=requestedMode==='--predicate'||packedFloat==='--predicate',minmax=requestedMode==='--minmax'||packedFloat==='--minmax',rounding=requestedMode==='--round',extraction=signmask||requestedMode==='--extract',floatArithmetic=predicate||minmax||requestedMode==='--float-arithmetic',decimalStore=requestedMode==='--bcd-store',decimal=requestedMode==='--bcd-load',shuffled=requestedMode==='--shuffle',unpacked=requestedMode==='--unpack',mode=packedVariant?packedVariant.mode:absolute?'--mmx-extended':widen||standard?'--packed-extended':decimalStore||decimal||unpacked||shuffled?undefined:rounding?'--register':align||doubleShuffle||half||extraction?'--scalar-vector-transfer':floatArithmetic?'--float-compare':requestedMode;
if(!directory||(mode&&mode!=='--transfer'&&mode!=='--control-load'&&mode!=='--environment'&&mode!=='--packed-shift'&&!['--arithmetic','--status','--register','--divide','--register-divide','--memory','--multiply','--memory-multiply','--register-multiply','--store','--load','--store-fault','--mmx','--packed','--mmx-transfer','--stack','--float-store','--float-fault','--load-view','--mmx-extended','--packed-extended','--integer-float','--integer-float-fault','--float-integer','--float-integer-complete','--scalar-integer-float','--float-compare','--status-aliases','--scalar-vector-transfer'].includes(mode)))throw new Error('VM.WASM COLD.WASM HARDWARE-RECORDS [--arithmetic|--status|--register|--divide|--register-divide|--memory|--multiply|--memory-multiply|--register-multiply|--store|--load|--store-fault|--mmx|--packed|--mmx-transfer|--stack|--float-store|--float-fault|--load-view|--mmx-extended|--packed-extended|--integer-float|--integer-float-fault|--float-integer|--float-integer-complete|--scalar-integer-float|--float-compare|--status-aliases|--scalar-vector-transfer]');
const shifted=mode==='--packed-shift',environment=mode==='--environment',control=mode==='--control-load',transfer=mode==='--transfer',scalarMoves=mode==='--scalar-vector-transfer',statusAliases=mode==='--status-aliases',floatCompare=mode==='--float-compare',scalarIntegerFloat=mode==='--scalar-integer-float',floatIntegerComplete=mode==='--float-integer-complete',floatInteger=floatIntegerComplete||mode==='--float-integer',integerFloatFault=mode==='--integer-float-fault',integerFloat=integerFloatFault||mode==='--integer-float',simdFault=floatCompare||scalarIntegerFloat||integerFloatFault||floatInteger,mmxExtended=mode==='--mmx-extended',packedExtended=mode==='--packed-extended',loadView=mode==='--load-view',floatFault=mode==='--float-fault',floating=floatFault||mode==='--float-store',stack=mode==='--stack',arithmetic=mode==='--arithmetic',status=statusAliases||mode==='--status',registerDivide=mode==='--register-divide',registerMultiply=mode==='--register-multiply',register=transfer||stack||registerMultiply||registerDivide||mode==='--register',
  moves=mode==='--mmx-transfer',packed=packedExtended||mode==='--packed',mmx=mmxExtended||mode==='--mmx',storeFault=floatFault||mode==='--store-fault',load=mode==='--load',store=storeFault||mode==='--store',multiply=mode==='--multiply',memoryMultiply=mode==='--memory-multiply',divide=mode==='--divide',ieee=mode==='--memory',
  prefix=extraction?'vector-extract':floatArithmetic?'float-arithmetic':decimalStore?'x87-bcd-store':decimal?'x87-bcd':shuffled?'vector-shuffle':unpacked?'vector-unpack':shifted?'packed-shift':environment?'x87-environment':control?'x87-control':transfer?'x87-transfer':scalarMoves?'scalar-vector-transfer':statusAliases?'x87-status-alias':floatCompare?'float-compare':scalarIntegerFloat?'scalar-integer-float':floatInteger?'vector-float-integer':integerFloatFault?'vector-integer-float-fault':integerFloat?'vector-integer-float':mmxExtended?'mmx-extended':packedExtended?'packed-extended':loadView?'x87-load-view':floatFault?'x87-float-store-fault':floating?'x87-float-store':stack?'x87-stack':moves?'mmx-transfer':packed?'packed-binary':mmx?'mmx-binary':storeFault?'x87-store-fault':load?'x87-ieee-load':store?'x87-integer-store':memoryMultiply?'x87-memory-multiply':multiply?'x87-integer-multiply':registerMultiply?'x87-register-multiply':ieee?'x87-memory-arithmetic':registerDivide?'x87-register-divide':divide?'x87-division':register?'x87-register':status?'x87-status':arithmetic?'x87-arithmetic':'x87-integer',
  forms=extraction?1024:minmax?1024:floatArithmetic?4096:decimalStore?256:decimal?128:shuffled?768:unpacked?42:shifted?12288:environment?8:control?1:transfer?73:scalarMoves?240:statusAliases?96:floatCompare?1024:scalarIntegerFloat?1280:floatIntegerComplete?2048:floatInteger?1152:integerFloat?240:mmxExtended?243:packedExtended?405:loadView?132:floatFault?5:floating?260:stack?144:moves?60:packed?1485:mmx?891:storeFault?8:load?96:store?384:(multiply||memoryMultiply)?224:registerMultiply?27:ieee?1120:registerDivide?54:divide?448:register?81:status?172:arithmetic?576:192;
const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cm=new WebAssembly.Memory({initial:32}),cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,
  segments=cpu+1408,port=cpu+2048,codeView=port+64,entry=0x400000n;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let comparisons=0,modules=0;
const cached=new Map();
const recordPrefix=trig||exponential?`x87-${inputMode.slice(2)}`:binarySpecial?'x87-binary-special':extract?'x87-extract':root?'x87-root':examine?'x87-examine':integralRound||pairwise||dot||squareRoot||approximate||formatChange?'float-arithmetic':packedVariant?packedVariant.prefix:widen?'vector-widen':absolute?'mmx-absolute':standard?'packed-standard':rounding?'x87-round':prefix,recordForms=trig||exponential?448:binarySpecial?224:extract?448:root?320:examine?8:quadFloatInteger?768:packedIntegerFloat?480:squareRoot||approximate||formatChange?1024:dot?12288:integralRound?3072:pairwise?1536:packedVariant?packedVariant.forms:widen?540:absolute?81:standard?720:align?2048:signmask?8:doubleShuffle?400:half?100:rounding?320:forms;
let approximateWords=0,maximumRelativeError=0;
function approximateContract(raw,result,reciprocalRoot,product){
  const magnitude=raw&0x7fffffff,sign=raw>>>31,exponent=magnitude>>>23,fraction=magnitude&0x7fffff;
  if(!exponent)return result===((sign<<31)>>>0)+0x7f800000;
  if(exponent===255){if(fraction)return result===((raw|0x00400000)>>>0);
    return result===(reciprocalRoot&&sign?0xffc00000:(sign<<31)>>>0);}
  if(reciprocalRoot&&sign)return result===0xffc00000;
  const word=Buffer.alloc(4);word.writeUInt32LE(raw);const input=word.readFloatLE();word.writeUInt32LE(result);const output=word.readFloatLE();
  const reference=reciprocalRoot?1/Math.sqrt(input):1/input,limit=1.5*2**-12,minNormal=2**-126;
  if(!Number.isFinite(output)||((result>>>31)!==sign)||((result&0x7f800000)===0&&output!==0))return false;
  // Only the ISA's tiny-result transition band permits a zero approximation.
  if(output===0)return !reciprocalRoot&&Math.abs(reference)<=minNormal*(1+limit);
  const relative=Math.abs((output-reference)/reference);if(product)maximumRelativeError=Math.max(maximumRelativeError,relative);
  return relative<=(product?1.3e-7:limit);
}
for(let form=0;form<(underflow?128:recordForms);++form){if(shifted&&Math.floor(form/256)%3!==0&&form%256!==0)continue;const file=suffix=>readFile(path.join(directory,`${recordPrefix}${underflow?'-underflow':''}-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source'),native=await file('cases'),operands=register||(decimalStore||decimal||unpacked||shuffled||shifted||scalarMoves||floatCompare||scalarIntegerFloat||floatInteger||integerFloat||loadView||floating||mmx||packed||moves)&&!meta.bytes?null:await file(status?'operands':'integers');
  const writes=decimalStore||store||(environment||scalarMoves||floating||moves)&&meta.store;
  const operandStride=meta.operandStride??8;
  const written=writes?await file('written'):null;
  const writtenStride=meta.writtenStride??8;assert([8,16,128].includes(writtenStride));
  const trigReference=trigContract?await file('reference'):null;
  if(trigReference)assert.equal(trigReference.length,meta.native*48);
  const logReference=logContract?await file('reference'):null;if(logReference)assert.equal(logReference.length,meta.native*32);
  const faultRows=storeFault||simdFault?await file('faults'):null,errors=storeFault?await file('errors'):null;
  assert.equal(meta.stateBytes,1256);assert.equal(native.length,meta.native*2512);if(operands)assert.equal(operands.length,meta.native*operandStride);
  assert.equal(source.length,meta.sourceBytes);assert(((decimalStore||decimal||unpacked||shuffled||shifted||scalarMoves||floatCompare||scalarIntegerFloat||floatInteger||integerFloat||loadView||floating||status||register||mmx||packed||moves)&&meta.bytes===0)||[2,4,8,10,14,16,28,94,108].includes(meta.bytes));
  const operandOffset=meta.operandOffset??256;assert([256,4096,4097].includes(operandOffset));
  const key=source.toString('hex');let made=cached.get(key);
  if(!made){c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0,`${prefix} ${key} must compile`);
    const n=Number(cv.getBigUint64(cr+40,true)),instance=(await WebAssembly.instantiate(c.subarray(co,co+n),
      {machine:{memory,access:vm.vm_access,read_pair:vm.vm_read_pair,read_extent:vm.vm_read_extent,floating_wait:vm.vm_floating_wait,write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end}})).instance;
    made={fn:instance.exports.cut,binding:cv.getUint32(cr+76,true)};cached.set(key,made);++modules;cc.compiler_close();
  }
  for(let row=0;row<meta.native;++row){vm.vm_close();a.fill(0,dir);
    const before=native.subarray(row*2512,row*2512+1256),after=native.subarray(row*2512+1256,(row+1)*2512);a.set(before,cpu);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);put(cpu+20488,storeFault&&(row&1)?0x9065:0x9067);
    a.fill(0x90,cpu+24576,cpu+28672);a.set(source,cpu+24576);if(operands)a.set(operands.subarray(row*operandStride,row*operandStride+(writes?writtenStride:meta.bytes)),cpu+24576+operandOffset);
    put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,6,6,dir+2048,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),made.fn);
    assert.equal(vm.vm_source_publish(meta.sourceBytes,1,made.binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const result=vm.vm_run(port,9n,1),fault=(storeFault||simdFault)&&faultRows[row];
    if(fault){assert.equal(result,simdFault?155n:115n);assert.equal(v.getUint32(port+24,true),simdFault?19:14);assert.equal(v.getUint32(port+28,true),simdFault?0:errors.readUInt32LE(row*4));
      assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);}
    else{assert([1n,...(writes?[5n]:[])].includes(result),`${prefix} result ${form}/${row}: ${result}`);assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);}
    if(writes){
      assert(a.subarray(cpu+24576+operandOffset,cpu+24576+operandOffset+writtenStride).equals(written.subarray(row*writtenStride,(row+1)*writtenStride)),`${prefix} memory ${form}/${row}`);}
    const actual=a.subarray(cpu,cpu+1256);let expected=after;
    if(logContract&&logarithmOne){const top=(before.readUInt16LE(1234)>>11)&7,slot=(top+1)&7,x=before.readBigUInt64LE(1152+top*8),y=before.readBigUInt64LE(1152+slot*8);
      const xe=before.readUInt16LE(1216+top*2)&32767,ye=before.readUInt16LE(1216+slot*2)&32767;
      const nan=(xe===32767&&(x&((1n<<63n)-1n))!==0n)||(ye===32767&&(y&((1n<<63n)-1n))!==0n);
      if(!nan&&(xe>16381||(xe===16381&&x>0x95f619980c4336f7n))){expected=Buffer.from(after);before.copy(expected,1152,1152,1232);
        const cw=before.readUInt16LE(1232),tag=before.readUInt16LE(1236),empty=((tag>>(top*2))&3)===3||((tag>>(slot*2))&3)===3;
        let sw=(before.readUInt16LE(1234)&~0x200)|1|(empty?64:0);if(cw&1){
          expected.writeBigUInt64LE(0xc000000000000000n,1152+slot*8);expected.writeUInt16LE(65535,1216+slot*2);
          expected.writeUInt16LE((tag&~(3<<(slot*2)))|(2<<(slot*2))|(3<<(top*2)),1236);sw=(sw&~0x3800)|(slot<<11);
          expected.writeUInt16LE(before.readUInt16LE(1238),1238);
        }else{sw|=0x8080;expected.writeUInt16LE(tag,1236);expected.writeUInt16LE(0x1f9,1238);}
        expected.writeUInt16LE(sw,1234);expected.writeBigUInt64LE(before.readBigUInt64LE(384),1240);++undefinedRepresentatives;
      }
    }
    if(logContract){const at=row*32,rs=logReference.readBigUInt64LE(at);if(rs){
      expected=Buffer.from(after);const fraction=logReference.readBigUInt64LE(at+8),originalExponent=Number(logReference.readBigInt64LE(at+16));
      const sign=Number(logReference.readBigUInt64LE(at+24)),cw=before.readUInt16LE(1232),top=(before.readUInt16LE(1234)>>11)&7,slot=(top+1)&7;
      const sigAt=1152+slot*8,seAt=1216+slot*2,rc=(cw>>10)&3;let exponent=originalExponent,reference=(rs<<64n)+fraction;
      const xSig=before.readBigUInt64LE(1152+top*8),ySig=before.readBigUInt64LE(sigAt),oneBit=x=>x!==0n&&(x&(x-1n))===0n;
      const exactNormalBoundary=!logarithmOne&&originalExponent===1&&rs===1n<<63n&&fraction===0n&&oneBit(xSig)&&oneBit(ySig);
      const overflow=exponent>=32767,maskedOverflow=overflow&&!!(cw&8),maskedTiny=exponent<1&&!!(cw&16);
      if(maskedTiny){reference>>=BigInt(1-exponent);exponent=1;}else if(overflow&&!(cw&8))exponent-=24576;
      else if(exponent<1&&!(cw&16))exponent+=24576;
      let rounded=null;
      for(const [label,state] of [['physical',after],['product',actual]]){const se=state.readUInt16LE(seAt),sig=state.readBigUInt64LE(sigAt);
        assert.equal(se>>15,sign,`${label} logarithm sign ${form}/${row}`);
        if(maskedOverflow){const toInfinity=rc===0||(rc===1&&sign===1)||(rc===2&&sign===0);
          assert.equal(se&32767,toInfinity?32767:32766);assert.equal(sig,toInfinity?1n<<63n:(1n<<64n)-1n);
          if(label==='product')rounded=toInfinity?1:0;continue;}
        const storedExponent=(se&32767)||1,physicalWrap=label==='physical'&&exactNormalBoundary&&!(cw&16)&&(state.readUInt16LE(1234)&16);
        const comparisonExponent=exponent+(physicalWrap?24576:0),distance=storedExponent-comparisonExponent;
        assert(distance>=-1&&distance<=1,`${label} logarithm binade ${form}/${row}: ${storedExponent}/${exponent}`);
        const value=sig<<BigInt(64+distance),error=value>reference?value-reference:reference-value,limit=rc===0?1n<<64n:3n<<63n;
        assert(error<limit,`${label} logarithm ISA error ${form}/${row}: ${error}`);
        const ulps=Number(error)/2**64;if(label==='physical')maximumLogPhysicalUlps=Math.max(maximumLogPhysicalUlps,ulps);
        else{maximumLogProductUlps=Math.max(maximumLogProductUlps,ulps);const gap=value-reference,bound=1n<<48n;
          if(gap>bound)rounded=1;else if(gap < -bound)rounded=0;
          else if(gap===0n&&fraction===0n){
            if(!angleContract)rounded=0;
            else if(oneBit(xSig)&&oneBit(ySig)&&!(before.readUInt16LE(1216+top*2)&32768)){
              const xExp=(before.readUInt16LE(1216+top*2)&32767)||1,yExp=(before.readUInt16LE(seAt)&32767)||1;
              const distance=xExp-yExp+xSig.toString(2).length-ySig.toString(2).length;
              // atan(2^-d) is strictly below 2^-d. Its cubic correction is
              // invisible to fp128 for d>=57 but survives our explicit low
              // lane through d=110. Above110 the specified linear representative
              // is exact; its final C1 is zero. Neither case is an oracle skip.
              if(distance>=57){rounded=distance<=110?1:0;++analyticAngleRounding;}
            }
          }}
      }
      if(rounded!==null){assert.equal((actual.readUInt16LE(1234)>>9)&1,rounded,`independent logarithm final C1 ${form}/${row}`);++logarithmC1;
        expected.writeUInt16LE((expected.readUInt16LE(1234)&~0x200)|(rounded<<9),1234);}
      if(exactNormalBoundary){
        // The normalized input powers and the exact integer logarithm yield
        // the minimum normal exactly in this SSA. An approximate hardware
        // log can lie just below it and raise/wrap #U. Do not borrow that CPU's
        // boundary choice: prove this exact case's own payload, #U and pending
        // exception/FOP equation, leaving every other flag/state byte exact.
        assert.equal(actual.readBigUInt64LE(sigAt),1n<<63n);assert.equal(actual.readUInt16LE(seAt)&32767,1);
        assert.equal(actual.readUInt16LE(1234)&16,0);let sw=expected.readUInt16LE(1234)&~16;
        const pending=!!(sw&(~cw)&63);sw=pending?sw|0x8080:sw&~0x8080;expected.writeUInt16LE(sw,1234);
        expected.writeUInt16LE(pending?(0x100|source.at(-1)):before.readUInt16LE(1238),1238);++logarithmExactBoundaries;
      }
      expected.writeBigUInt64LE(actual.readBigUInt64LE(sigAt),sigAt);expected.writeUInt16LE(actual.readUInt16LE(seAt),seAt);++logarithmWords;
      const resultSig=actual.readBigUInt64LE(sigAt),resultExp=actual.readUInt16LE(seAt)&32767;
      const resultTag=!resultExp&&!resultSig?1:!resultExp||resultExp===32767||!(resultSig>>63n)?2:0;
      assert.equal((actual.readUInt16LE(1236)>>(slot*2))&3,resultTag,`own numerical logarithm tag ${form}/${row}`);
      expected.writeUInt16LE((expected.readUInt16LE(1236)&~(3<<(slot*2)))|(resultTag<<(slot*2)),1236);
    }}
    if(trigContract){
      expected=Buffer.from(after);const originalTop=(before.readUInt16LE(1234)>>11)&7,push=['--sincos','--tan'].includes(inputMode);
      let roundedDirection=null;
      for(let output=0;output<(inputMode==='--sincos'?2:1);++output){const at=row*48+output*24;
        const rs=trigReference.readBigUInt64LE(at),fraction=trigReference.readBigUInt64LE(at+8),se=trigReference.readBigUInt64LE(at+16);
        if(!se)continue;const reference=(rs<<64n)+fraction,exponent=Number(se&32767n),sign=Number(se>>15n);
        const slot=push&&inputMode==='--sincos'&&output===1?(originalTop+7)&7:originalTop;
        const sigAt=1152+slot*8,seAt=1216+slot*2;let product=null;
        for(const [label,state] of [['physical',after],['product',actual]]){const bits=state.readUInt16LE(seAt),sig=state.readBigUInt64LE(sigAt);
          assert.equal(bits>>15,sign,`${label} trig sign ${form}/${row}/${output}`);
          const distance=(bits&32767)-exponent;assert(distance>=-1&&distance<=1,`${label} trig binade ${form}/${row}/${output}`);
          const scaled=sig<<BigInt(64+distance),error=scaled>reference?scaled-reference:reference-scaled;
          const rc=(before.readUInt16LE(1232)>>10)&3,limit=rc===0?1n<<64n:3n<<63n;
          assert(error<limit,`${label} trig ISA error ${form}/${row}/${output}: ${error}`);
          const ulps=Number(error)/2**64;if(label==='product'){maximumProductUlps=Math.max(maximumProductUlps,ulps);product=scaled;}
          else maximumPhysicalUlps=Math.max(maximumPhysicalUlps,ulps);
        }
        // C1 belongs to this implementation's final magnitude rounding, not
        // another CPU's different internal polynomial. A 2^-20 ulp enclosure
        // exceeds the independently measured DD and fp128 reference errors.
        const gap=product-reference,bound=1n<<44n;if(gap>bound)roundedDirection=1;else if(gap < -bound)roundedDirection=0;
        expected.writeBigUInt64LE(actual.readBigUInt64LE(sigAt),sigAt);expected.writeUInt16LE(actual.readUInt16LE(seAt),seAt);++trigWords;
      }
      if(roundedDirection!==null){assert.equal((actual.readUInt16LE(1234)>>9)&1,roundedDirection,`independent final trig C1 ${form}/${row}`);++independentC1;
        expected.writeUInt16LE((expected.readUInt16LE(1234)&~0x200)|(roundedDirection<<9),1234);}
    }
    if(approximate){assert.equal(meta.width,4);assert([0,1].includes(meta.op));assert.equal(meta.target,9);assert.equal(meta.source,7);
      expected=Buffer.from(after);for(let lane=0;lane<(meta.packed?4:1);++lane){const at=128+meta.target*16+lane*4;
        const raw=meta.bytes?operands.readUInt32LE(row*operandStride+lane*4):before.readUInt32LE(128+meta.source*16+lane*4);
        const result=actual.readUInt32LE(at),nativeWord=after.readUInt32LE(at);
        assert(approximateContract(raw,nativeWord,!!meta.op,false),`physical ISA approximation ${form}/${row}/${lane}`);
        assert(approximateContract(raw,result,!!meta.op,true),`emitted ISA approximation ${form}/${row}/${lane}: ${raw.toString(16)} -> ${result.toString(16)}`);
        expected.writeUInt32LE(result,at);++approximateWords;}}
    if(diagnosticMode==='--diagnostic'&&!actual.equals(expected)){++mismatchCount;
      const differences=Array.from(expected.entries()).filter(([offset,byte])=>actual[offset]!==byte);
      for(const [offset] of differences)differentOffsets.set(offset,(differentOffsets.get(offset)??0)+1);
      if(mismatches.length<24)mismatches.push({form,row,differences:differences.map(([offset,byte])=>[offset,actual[offset],byte])});
      if(structuralMismatches.length<24&&differences.some(([offset,byte])=>offset!==1235||(actual[offset]^byte)!==2))
        structuralMismatches.push({form,row,differences:differences.map(([offset,byte])=>[offset,actual[offset],byte])});
    }else assert(actual.equals(expected),`${prefix} full state ${form}/${row}; byte differences: ${Array.from(expected.entries())
      .filter(([offset,byte])=>actual[offset]!==byte).slice(0,24).map(([offset,byte])=>`${offset}:${actual[offset].toString(16)}/${byte.toString(16)}`).join(',')}`);++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({format:'native-x87-full-state-c-v2',mode:inputMode??'--integer-load',status:mismatchCount?'fail':'pass',comparisons,modules,
  ...(diagnosticMode?{mismatchCount,differentOffsets:Object.fromEntries(differentOffsets),mismatches,structuralMismatches}:{}),
  ...(trigContract?{numericComparison:'Independent fp128 architectural-period error enclosure, not physical CPU bit identity; C1 checked against own final rounding; every other state byte exact',trigWords,independentC1,maximumProductUlps,maximumPhysicalUlps}:{}),
  ...(logContract?{numericComparison:'Independent scaled fp128 error enclosure, not physical CPU bit identity; own C1/tag and exact boundaries checked independently; out-of-domain epsilon uses independently stated invalid representative, not skips',logarithmWords,logarithmC1,logarithmExactBoundaries,undefinedRepresentatives,analyticAngleRounding,maximumLogProductUlps,maximumLogPhysicalUlps}:{}),
  ...(approximate?{numericComparison:'ISA relative-error and special-value contract, NOT CPU bit equality; all non-output state is byte-exact',approximateWords,maximumRelativeError,isaRelativeErrorLimit:1.5*2**-12}:{}),
  oracle:packedVariant||widen||standard||absolute?'physical Windows MMX/XMM/FPU/RFLAGS/full-tag; register aliases, memory, address-size/REX.W, signed/saturation/wrap edges and deterministic random; other GPR invariance architectural':moves?'physical Windows RAX/FPU/RFLAGS/full-tag/memory; other GPR invariance architectural':
    storeFault?'actual x86 reference-build VM FPU/signal frame; write protection and invalid/precision priority; GPR/RF invariance architectural':
    status?'physical Windows FPU/RFLAGS; IM/DM,relation,alias,tag,TOP,pop matrix; GPR invariance architectural':
    'physical Windows FPU/RFLAGS; GPR invariance architectural; PC/RC/exception-mask matrix',linuxBoot:'not-tested'},null,2));
if(mismatchCount)process.exitCode=1;
