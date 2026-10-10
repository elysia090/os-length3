// Independent assembly inputs, not product decoder tables or numeric helpers.
// GNU as supplies each exact encoding; none of these instructions is executed
// by this generator. Feature labels name the frozen development-standard-v2.
export const catalog = [];
const add = (feature, names, shape, options = {}) => {
  for (const name of names.split(' ')) catalog.push({feature, name, shape, ...options});
};
add('integer', 'mov add adc sub sbb and or xor cmp test xchg', 'gpr-rm', {widths:[8,16,32,64]});
add('integer', 'imul', 'gpr-rm', {widths:[16,32,64]});
add('integer', 'bsf bsr', 'gpr-rm', {widths:[16,32,64]});
add('integer', 'push pop', 'rm', {widths:[16,64]});
add('integer', 'bswap', 'register', {widths:[32,64]});
add('integer', 'seto setno setb setae sete setne setbe seta sets setns setp setnp setl setge setle setg', 'rm', {widths:[8]});
add('integer', 'shl shr sar rol ror rcl rcr', 'gpr-count', {widths:[8,16,32,64]});
add('integer', 'shld shrd', 'gpr-double-count', {widths:[16,32,64]});
add('integer', 'inc dec neg not mul imul div idiv', 'rm', {widths:[8,16,32,64]});
add('integer', 'bt bts btr btc', 'gpr-rm', {widths:[16,32,64], reverse:true});
add('integer', 'cmpxchg xadd', 'gpr-rm', {widths:[8,16,32,64], reverse:true});
add('integer', 'cmovo cmovno cmovb cmovae cmove cmovne cmovbe cmova cmovs cmovns cmovp cmovnp cmovl cmovge cmovle cmovg', 'gpr-rm', {widths:[16,32,64]});
add('popcnt', 'popcnt', 'gpr-rm', {widths:[16,32,64]});
add('sse4.2', 'crc32', 'crc');
add('sse', 'movups movaps addps mulps subps divps minps maxps sqrtps rcpps rsqrtps andps andnps orps xorps unpcklps unpckhps', 'xmm-rm', {memoryBits:128});
add('sse', 'movss addss mulss subss divss minss maxss sqrtss rcpss rsqrtss', 'xmm-rm', {memoryBits:32});
add('sse', 'comiss ucomiss', 'xmm-rm', {memoryBits:32});
add('sse', 'shufps cmpps', 'xmm-rm-imm', {memoryBits:128});
add('sse', 'cmpss', 'xmm-rm-imm', {memoryBits:32});
add('sse2', 'movupd movapd movdqa movdqu addpd mulpd subpd divpd minpd maxpd sqrtpd andpd andnpd orpd xorpd unpcklpd unpckhpd', 'xmm-rm', {memoryBits:128});
add('sse2', 'movsd addsd mulsd subsd divsd minsd maxsd sqrtsd comisd ucomisd', 'xmm-rm', {memoryBits:64});
add('sse2', 'shufpd cmppd', 'xmm-rm-imm', {memoryBits:128});
add('sse2', 'cmpsd', 'xmm-rm-imm', {memoryBits:64});
add('sse2', 'paddb paddw paddd paddq paddsb paddsw paddusb paddusw psubb psubw psubd psubq psubsb psubsw psubusb psubusw pcmpeqb pcmpeqw pcmpeqd pcmpgtb pcmpgtw pcmpgtd pand pandn por pxor pmullw pmulhw pmulhuw pmuludq pmaddwd psadbw pminub pminsw pmaxub pmaxsw pavgb pavgw packsswb packssdw packuswb punpcklbw punpcklwd punpckldq punpcklqdq punpckhbw punpckhwd punpckhdq punpckhqdq', 'xmm-rm', {memoryBits:128});
add('sse2', 'pshufd pshuflw pshufhw', 'xmm-rm-imm', {memoryBits:128});
add('sse2', 'psllw pslld psllq psrlw psrld psrlq psraw psrad', 'xmm-rm', {memoryBits:128});
add('sse2', 'psllw pslld psllq psrlw psrld psrlq psraw psrad pslldq psrldq', 'xmm-imm');
add('sse3', 'haddps haddpd hsubps hsubpd addsubps addsubpd', 'xmm-rm', {memoryBits:128});
add('sse3', 'movddup', 'xmm-rm', {memoryBits:64});
add('sse3', 'movsldup movshdup', 'xmm-rm', {memoryBits:128});
add('ssse3', 'pshufb phaddw phaddd phaddsw phsubw phsubd phsubsw pmaddubsw pmulhrsw psignb psignw psignd pabsb pabsw pabsd', 'xmm-rm', {memoryBits:128});
add('ssse3', 'palignr', 'xmm-rm-imm', {memoryBits:128});
add('sse4.1', 'pblendvb blendvps blendvpd pcmpeqq ptest pmuldq pmulld packusdw pminsb pminsd pminuw pminud pmaxsb pmaxsd pmaxuw pmaxud phminposuw', 'xmm-rm', {memoryBits:128});
add('sse4.1', 'blendps blendpd pblendw dpps dppd mpsadbw roundps roundpd', 'xmm-rm-imm', {memoryBits:128});
add('sse4.1', 'roundss insertps', 'xmm-rm-imm', {memoryBits:32});
add('sse4.1', 'roundsd', 'xmm-rm-imm', {memoryBits:64});
for (const [name,bits] of [['pmovsxbw',64],['pmovsxbd',32],['pmovsxbq',16],['pmovsxwd',64],['pmovsxwq',32],['pmovsxdq',64],['pmovzxbw',64],['pmovzxbd',32],['pmovzxbq',16],['pmovzxwd',64],['pmovzxwq',32],['pmovzxdq',64]])
  add('sse4.1', name, 'xmm-rm', {memoryBits:bits});
add('sse4.2', 'pcmpgtq', 'xmm-rm', {memoryBits:128});
add('sse4.2', 'pcmpestrm pcmpestri pcmpistrm pcmpistri', 'xmm-rm-imm', {memoryBits:128});
add('mmx', 'movq paddb paddw paddd paddsb paddsw paddusb paddusw psubb psubw psubd psubsb psubsw psubusb psubusw pcmpeqb pcmpeqw pcmpeqd pcmpgtb pcmpgtw pcmpgtd pand pandn por pxor pmullw pmulhw pmaddwd packsswb packssdw packuswb punpckhbw punpckhwd punpckhdq', 'mmx-rm', {memoryBits:64});
add('mmx', 'punpcklbw punpcklwd punpckldq', 'mmx-rm', {memoryBits:32});
add('sse2-mmx', 'paddq psubq pmulhuw pmuludq psadbw pminub pminsw pmaxub pmaxsw pavgb pavgw', 'mmx-rm', {memoryBits:64});
add('ssse3-mmx', 'pshufb phaddw phaddd phaddsw phsubw phsubd phsubsw pmaddubsw pmulhrsw psignb psignw psignd pabsb pabsw pabsd', 'mmx-rm', {memoryBits:64});
add('x87', 'fsin fcos fsincos fptan fpatan f2xm1 fyl2x fyl2xp1 fscale fprem fprem1 fsqrt frndint fxtract ftst fxam fchs fabs fld1 fldz fldpi fldl2t fldl2e fldlg2 fldln2 fninit fnclex fwait', 'implicit');
add('machine', 'clc stc cmc cld std lahf sahf cbw cwde cdqe cwd cdq cqo nop pause cpuid rdtsc syscall sysretq cli sti hlt clts swapgs ud2', 'implicit');
// UD2 is intentionally an architectural fault, not an unsupported input.
catalog.find(row => row.name === 'ud2').fault = true;
// Feature absence has architectural meaning. Do not confuse these deliberate
// #UD witnesses with a missing implementation of an advertised instruction.
for (const assembly of ['vaddps ymm0, ymm1, ymm2','aesenc xmm0, xmm1','pclmulqdq xmm0, xmm1, 0','xgetbv','xsetbv','rdrand rax','rdseed rax','xsave64 [rax]'])
  catalog.push({feature:'absent-feature',name:assembly,shape:'implicit',fault:true});
for (const assembly of ['pushfq','popfq','ret','ret 16','leave','enter 32, 3','int 128','iretq',
  'mov rax, cr0','mov rax, cr3','mov rax, cr4','mov cr0, rax','mov cr3, rax','mov cr4, rax',
  'rdmsr','wrmsr','lgdt [rax]','lidt [rax]','sgdt [rax]','sidt [rax]','invlpg [rax]',
  'fxsave64 [rax]','fxrstor64 [rax]','ldmxcsr [rax]','stmxcsr [rax]',
  'in al, dx','in eax, dx','out dx, al','out dx, eax','rep movsb','rep movsq','rep stosb','rep stosq',
  'repe cmpsb','repne scasb','lock cmpxchg16b [rax]','lock cmpxchg8b [rax]',
  'lock add QWORD PTR [rax], rbx','lock xadd QWORD PTR [rax], rbx','lock bts QWORD PTR [rax], rbx'])
  catalog.push({feature:'machine',name:assembly,shape:'implicit'});
for (const assembly of ['movzx eax, ah','movsx eax, ah','mov al, ah','mov ah, al','add ah, bh',
  'movzx r15d, BYTE PTR [r12+127]','movsx r15, WORD PTR [r13-128]','movsxd r15, DWORD PTR [r12+r9*8]',
  'lea r15, [r12+r9*8-2147483648]','lea r15d, [r12d+r9d*8+2147483647]',
  'movd xmm15, r15d','movd r15d, xmm15','movq xmm15, r15','movq r15, xmm15',
  'pmovmskb r15d, xmm15','movmskps r15d, xmm15','movmskpd r15d, xmm15',
  'pinsrb xmm15, r15d, 255','pinsrw xmm15, r15d, 255','pinsrd xmm15, r15d, 255','pinsrq xmm15, r15, 255',
  'pextrb r15d, xmm15, 255','pextrw r15d, xmm15, 255','pextrd r15d, xmm15, 255','pextrq r15, xmm15, 255',
  'extractps r15d, xmm15, 255','movntdqa xmm15, XMMWORD PTR [r12]',
  'cvtsi2ss xmm15, r15','cvtsi2sd xmm15, r15','cvtss2si r15, xmm15','cvtsd2si r15, xmm15',
  'cvttss2si r15, xmm15','cvttsd2si r15, xmm15','cvtss2sd xmm15, xmm0','cvtsd2ss xmm15, xmm0',
  'cvtdq2ps xmm15, xmm0','cvtps2dq xmm15, xmm0','cvttps2dq xmm15, xmm0','cvtps2pd xmm15, xmm0',
  'cvtpd2ps xmm15, xmm0','cvtdq2pd xmm15, xmm0','cvtpd2dq xmm15, xmm0','cvttpd2dq xmm15, xmm0',
  'fisttp QWORD PTR [r12]','fld TBYTE PTR [r12]','fstp TBYTE PTR [r12]','fbld TBYTE PTR [r12]','fbstp TBYTE PTR [r12]',
  'fadd st, st(7)','fsub st, st(7)','fsubr st, st(7)','fmul st, st(7)','fdiv st, st(7)','fdivr st, st(7)',
  'faddp st(7), st','fucomip st, st(7)','fcomip st, st(7)','fxch st(7)','ffree st(7)'])
  catalog.push({feature:'operand-boundary',name:assembly,shape:'implicit'});

const registers = {
  8:['al','cl','dl','bl','spl','bpl','sil','dil',...Array.from({length:8},(_,i)=>`r${i+8}b`)],
  16:['ax','cx','dx','bx','sp','bp','si','di',...Array.from({length:8},(_,i)=>`r${i+8}w`)],
  32:['eax','ecx','edx','ebx','esp','ebp','esi','edi',...Array.from({length:8},(_,i)=>`r${i+8}d`)],
  64:['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi',...Array.from({length:8},(_,i)=>`r${i+8}`)]
};
const sizes = {8:'BYTE',16:'WORD',32:'DWORD',64:'QWORD',128:'XMMWORD'};
const xmm = i => `xmm${i}`;
const immediateEdges = [0,1,7,8,15,16,31,32,63,64,127,128,255];

export function* inputs({full = true} = {}) {
  // All register pairs in full mode. Boundary mode covers equality, REX and
  // low/high register coordinates, but does not claim a Cartesian product.
  const numbers = full ? Array.from({length:16},(_,i)=>i) : [0,1,7,8,15];
  const addresses = [];
  for (const bits of [32,64]) {
    for (let base = 0; base < 16; ++base)
      for (const displacement of [0,-128,127,-2147483648,2147483647])
        addresses.push({bits,expression:`${registers[bits][base]}${displacement<0?'': '+'}${displacement}`,role:'base-displacement'});
    for (let index = 0; index < 16; ++index) if (index !== 4)
      for (const scale of [1,2,4,8])
        addresses.push({bits,expression:`${registers[bits][12]}+${registers[bits][index]}*${scale}+17`,role:'scaled-index'});
  }
  for (const displacement of [-2147483648,0,2147483647])
    addresses.push({bits:64,expression:`rip${displacement<0?'':'+'}${displacement}`,role:'rip-relative'});
  for (const row of catalog) for (const width of row.widths ?? [0]) {
    const make = (assembly,dimensions) => ({feature:row.feature,family:row.name,shape:row.shape,width,...dimensions,assembly,fault:!!row.fault});
    if (row.shape === 'implicit') { yield make(row.name,{}); continue; }
    if (row.shape === 'crc') {
      for (const sourceWidth of [8,16,32,64]) for (const dst of numbers) for (const src of numbers)
        yield make(`crc32 ${registers[sourceWidth===64?64:32][dst]}, ${registers[sourceWidth][src]}`,{dst,src,sourceWidth});
      continue;
    }
    const mmx=row.shape.startsWith('mmx'),indices=mmx?numbers.filter(i=>i<8):numbers;
    const vector = row.shape.startsWith('xmm')||mmx,reg = mmx ? i=>`mm${i}` : vector ? xmm : i => registers[width][i];
    const immediate = row.shape.endsWith('-imm');
    for (const dst of indices) {
      if (row.shape === 'rm'||row.shape==='register') yield make(`${row.name} ${reg(dst)}`,{dst});
      else if (row.shape === 'xmm-imm') for (const imm of immediateEdges)
        yield make(`${row.name} ${reg(dst)}, ${imm}`,{dst,imm});
      else if (row.shape === 'gpr-count') {
        yield make(`${row.name} ${reg(dst)}, cl`,{dst,count:'cl'});
        for (const imm of immediateEdges) yield make(`${row.name} ${reg(dst)}, ${imm}`,{dst,imm});
      } else for (const src of indices) {
        const operands = `${reg(dst)}, ${reg(src)}`;
        if (row.shape === 'gpr-double-count') {
          yield make(`${row.name} ${operands}, cl`,{dst,src,count:'cl'});
          for (const imm of [0,1,width-1,width,255]) yield make(`${row.name} ${operands}, ${imm}`,{dst,src,imm});
        } else {
          yield make(`${row.name} ${operands}${immediate?', 0':''}`,{dst,src,...(immediate?{imm:0}:{})});
          if (immediate && dst===src && dst===0)
            for (let imm=1;imm<256;++imm) yield make(`${row.name} ${operands}, ${imm}`,{dst,src,imm});
        }
      }
    }
    if (['gpr-count','gpr-double-count','xmm-imm','register'].includes(row.shape)) continue;
    // Address dimensions are exhaustive individually; not every combination
    // of address, destination, immediate and payload is sampled.
    for (const address of addresses) for (const dst of mmx?[0,5,7]:[0,8,15]) {
      const memory = `${sizes[row.memoryBits ?? width]} PTR [${address.expression}]`;
      const operands = row.shape==='rm' ? memory : row.reverse ? `${memory}, ${reg(dst)}` : `${reg(dst)}, ${memory}`;
      yield make(`${row.name} ${operands}${immediate?', 255':''}`,{dst,addressBits:address.bits,addressRole:address.role});
    }
  }
}
