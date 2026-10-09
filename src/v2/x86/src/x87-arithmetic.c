#include <x86/semantics.h>
#include "x87-expression.h"
typedef struct {pl_operand hi,lo;} pair;
typedef struct {pl_operand sig,exp,increment,inexact;} rounded;
int pl_x86_x87_integer_arithmetic_lower(const pl_x86_instruction *i,pl_x86_x87_integer_arithmetic *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_READS_MEMORY;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=1u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_WRITES_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *m=i->operands;
    if(m->kind!=PL_X86_OPERAND_MEMORY||(m->bits!=16u&&m->bits!=32u))return 0;
    pl_u32 width=m->bits/8u,fop=(pl_u32)(i->machine_argument>>16u)&0x7ffu,operation=(pl_u32)(i->machine_argument>>36u);
    pl_u32 kind=(pl_u32)i->machine_argument&255u;
    if((kind==12u&&(operation!=0u&&operation!=2u&&operation!=3u))||(kind==16u&&operation>1u)
        ||(kind==7u&&operation)||(kind!=12u&&kind!=16u&&kind!=7u))return 0;
    pl_u32 group=kind==7u?1u:kind==16u?6u+operation:operation==0u?0u:operation==2u?4u:5u;
    if((fop>>8u)!=(width==4u?2u:6u)||((fop>>3u)&7u)!=group||(fop&0xc0u)==0xc0u
        ||i->machine_argument!=(kind|((pl_u64)width<<8u)|((pl_u64)fop<<16u)|((pl_u64)operation<<36u)))return 0;
    if(kind==16u)operation+=4u;
    if(kind==7u)operation=1u;
    *out=(pl_x86_x87_integer_arithmetic){(pl_u8)width,(pl_u8)operation,(pl_u16)fop};return 1;
}
int pl_x86_x87_register_arithmetic_lower(const pl_x86_instruction *i,pl_x86_x87_register_arithmetic *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=2u||i->operand_count<2u
        ||i->operand_count>PL_X86_MAX_OPERANDS||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)
        ||(i->flags&required)!=required||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,fop=(pl_u32)(i->machine_argument>>16u)&0x7ffu,primary=i->opcode;
    if((primary!=0xd8u&&primary!=0xdcu&&primary!=0xdeu)||(fop>>8u)!=(primary&7u)||(fop&0xc0u)!=0xc0u)return 0;
    pl_u32 group=(fop>>3u)&7u,index=fop&7u,pop=primary==0xdeu;
    if((kind==8u&&group!=0u)||(kind==9u&&group!=1u)||(kind==13u&&group!=4u&&group!=5u)||(kind==15u&&group!=6u&&group!=7u)
        ||(kind!=8u&&kind!=9u&&kind!=13u&&kind!=15u))return 0;
    pl_u32 destination=primary==0xd8u?0u:index,source=primary==0xd8u?index:0u;
    pl_u32 reverse=(kind==13u||kind==15u)&&(primary==0xd8u?group==(kind==15u?7u:5u):group==(kind==15u?6u:4u));
    pl_u32 operation=kind==8u?0u:kind==9u?1u:kind==15u?(reverse?5u:4u):reverse?3u:2u;
    pl_u32 options=(kind==8u||kind==9u)?pop:reverse|(pop<<1u);
    if(i->machine_argument!=(kind|((pl_u64)fop<<16u)|((pl_u64)source<<32u)|((pl_u64)destination<<36u)|((pl_u64)options<<40u)))return 0;
    for(pl_u32 n=0u;n<2u;++n){const pl_x86_operand *o=i->operands+n;const pl_x86_register *r=&o->value.reg;
        if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||r->class_id!=PL_X86_REGISTER_X87||r->bits!=80u
            ||r->flags||r->index!=(n?source:destination))return 0;}
    *out=(pl_x86_x87_register_arithmetic){(pl_u8)source,(pl_u8)destination,(pl_u8)operation,(pl_u8)pop,(pl_u16)fop};return 1;
}
int pl_x86_x87_memory_arithmetic_lower(const pl_x86_instruction *i,pl_x86_x87_integer_arithmetic *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_READS_MEMORY;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=1u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_WRITES_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *m=i->operands;if(m->kind!=PL_X86_OPERAND_MEMORY||(m->bits!=32u&&m->bits!=64u))return 0;
    pl_u32 kind=(pl_u32)i->machine_argument&255u,width=m->bits/8u,fop=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    pl_u32 options=(pl_u32)(i->machine_argument>>40u),group=kind==8u?0u:kind==9u?1u:kind==13u?4u+options:6u+options;
    if((kind!=8u&&kind!=9u&&kind!=13u&&kind!=15u)||options>((kind==8u||kind==9u)?0u:1u)
        ||(fop>>8u)!=(width==4u?0u:4u)||((fop>>3u)&7u)!=group||(fop&0xc0u)==0xc0u
        ||i->machine_argument!=(kind|((pl_u64)width<<8u)|((pl_u64)fop<<16u)|((pl_u64)options<<40u)))return 0;
    *out=(pl_x86_x87_integer_arithmetic){(pl_u8)width,(pl_u8)(kind==8u?0u:kind==9u?1u:kind==13u?2u+options:4u+options),(pl_u16)fop};return 1;
}
static pl_operand add(expression *e,pl_operand a,pl_operand b){return binary(e,89u,a,b);}
static pl_operand sub(expression *e,pl_operand a,pl_operand b){return binary(e,96u,a,b);}
static pl_operand xor(expression *e,pl_operand a,pl_operand b){return binary(e,86u,a,b);}
static pl_operand shl(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_LANE64_SHL,a,b);}
static pl_operand shr(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_LANE64_SHR,a,b);}
static pl_operand nz(expression *e,pl_operand a){pl_operand zero=equal(e,a,constant(0u));return not(e,zero);}
static pl_operand less(expression *e,pl_operand a,pl_operand b){return compare(e,a,b,2u);}
static pl_operand bit(expression *e,pl_operand a,pl_u32 n){pl_operand v=shift(e,a,n);return bit_and(e,v,constant(1u));}
/* Total shift of a two-word residual. At/above 128 only nonzero survives;
 * modulo-word shifts are guarded, including distance zero and exactly 64. */
static pair right_jam(expression *e,pair a,pl_operand distance)
{
    pl_operand small=less(e,distance,constant(64u)),zero=equal(e,distance,constant(0u));
    pl_operand back=sub(e,constant(64u),distance),cross=shl(e,a.hi,back);
    cross=select(e,constant(0u),cross,zero);
    pl_operand hi=shr(e,a.hi,distance),lo=shr(e,a.lo,distance);lo=bit_or(e,lo,cross);
    pl_operand mask=shl(e,constant(1u),distance);mask=sub(e,mask,constant(1u));
    pl_operand lost=bit_and(e,a.lo,mask);lost=nz(e,lost);lo=bit_or(e,lo,lost);
    pl_operand excess=sub(e,distance,constant(64u)),tail=shr(e,a.hi,excess);
    mask=shl(e,constant(1u),excess);mask=sub(e,mask,constant(1u));
    lost=bit_and(e,a.hi,mask);lost=bit_or(e,lost,a.lo);lost=nz(e,lost);tail=bit_or(e,tail,lost);
    pl_operand all=bit_or(e,a.hi,a.lo);all=nz(e,all);
    pl_operand wide=less(e,distance,constant(128u));tail=select(e,tail,all,wide);
    hi=select(e,hi,constant(0u),small);lo=select(e,lo,tail,small);return(pair){hi,lo};
}
/* Exponents carry an extra +128 bias so cancellation never needs an
 * implementation-defined signed comparison or a negative C shift. */
static rounded round_value(expression *e,pair a,pl_operand exponent,pl_operand drop,pl_operand rc,pl_operand sign)
{
    pl_operand unit=shl(e,constant(1u),drop),mask=sub(e,unit,constant(1u));
    pl_operand discarded=bit_and(e,a.hi,mask),any=bit_or(e,discarded,a.lo),inexact=nz(e,any);
    pl_operand half_shift=sub(e,drop,constant(1u)),half=shl(e,constant(1u),half_shift);
    pl_operand greater=less(e,half,discarded),at_half=equal(e,half,discarded),sticky=nz(e,a.lo);
    pl_operand half_sticky=bit_and(e,at_half,sticky);greater=bit_or(e,greater,half_sticky);
    pl_operand no_tail=not(e,sticky),tie=bit_and(e,at_half,no_tail);
    pl_operand full=equal(e,drop,constant(0u));
    pl_operand full_greater=less(e,constant(0x8000000000000000ull),a.lo),full_tie=equal(e,a.lo,constant(0x8000000000000000ull));
    greater=select(e,full_greater,greater,full);tie=select(e,full_tie,tie,full);
    pl_operand parity=shr(e,a.hi,drop);parity=bit_and(e,parity,constant(1u));
    pl_operand tied_odd=bit_and(e,tie,parity),nearest=bit_or(e,greater,tied_odd);
    pl_operand down=equal(e,rc,constant(1u)),up=equal(e,rc,constant(2u)),positive=not(e,sign);
    down=bit_and(e,down,sign);up=bit_and(e,up,positive);pl_operand directed=bit_or(e,down,up);
    directed=bit_and(e,directed,inexact);pl_operand near=equal(e,rc,constant(0u)),increment=select(e,nearest,directed,near);
    pl_operand keep=xor(e,mask,constant(~0ull)),base=bit_and(e,a.hi,keep),delta=shl(e,increment,drop);
    pl_operand sig=add(e,base,delta),carry=less(e,sig,base);sig=select(e,constant(0x8000000000000000ull),sig,carry);
    exponent=add(e,exponent,carry);return(rounded){sig,exponent,increment,inexact};
}
static int ieee_result(expression *e,pl_plan *raw,pl_u32 bits,pl_u32 operation,pl_u64 bias,
    pl_operand hi,pl_operand lo,pl_operand exponent,pl_operand sign,pl_operand nonzero,
    pl_operand a,pl_operand sa,pl_operand b,pl_operand sb,pl_operand da,pl_operand db,
    pl_operand original_a,pl_operand original_b,pl_operand mxcsr,pl_arena *arena,pl_plan *out)
{
    pl_u32 f=bits==32u?23u:52u,format_bias=bits==32u?127u:1023u,drop=63u-f;
    pl_u64 full=bits==32u?255u:2047u,fraction_mask=(1ull<<f)-1u,min=16384u-format_bias+bias,max=16383u-format_bias+full+bias;
    pl_operand rc=shift(e,mxcsr,13u);rc=bit_and(e,rc,constant(3u));
    rounded normal=round_value(e,(pair){hi,lo},exponent,constant(drop),rc,sign);
    pl_operand below=less(e,exponent,constant(min)),distance=sub(e,constant(min),exponent);distance=select(e,distance,constant(0u),below);
    pair scaled=right_jam(e,(pair){hi,lo},distance);
    rounded gradual=round_value(e,scaled,constant(min),constant(drop),rc,sign);
    pl_operand sig=select(e,gradual.sig,normal.sig,below),adjusted=select(e,gradual.exp,normal.exp,below);
    pl_operand top=shift(e,gradual.sig,63u),stored_exp=sub(e,adjusted,constant(16383u-format_bias+bias));
    stored_exp=select(e,top,stored_exp,below);stored_exp=select(e,stored_exp,constant(0u),nonzero);
    pl_operand overflow=not(e,less(e,normal.exp,constant(max))),tiny=less(e,normal.exp,constant(min));tiny=bit_and(e,tiny,nonzero);
    pl_operand inexact=select(e,gradual.inexact,normal.inexact,below),um=bit(e,mxcsr,11u),ftz=bit(e,mxcsr,15u);
    pl_operand flush=bit_and(e,tiny,um);flush=bit_and(e,flush,ftz);
    pl_operand u=bit_or(e,inexact,not(e,um));u=bit_or(e,u,flush);u=bit_and(e,u,tiny);
    pl_operand masked_overflow=bit_and(e,overflow,bit(e,mxcsr,10u));pl_operand p=bit_or(e,inexact,masked_overflow);p=bit_or(e,p,flush);
    // Unmasked tininess stops before denormalization rounding. Its precision
    // flag describes the unbounded-exponent working-precision result.
    pl_operand unmasked_tiny=bit_and(e,tiny,not(e,um));p=select(e,normal.inexact,p,unmasked_tiny);
    pl_operand near=equal(e,rc,constant(0u)),down=equal(e,rc,constant(1u)),up=equal(e,rc,constant(2u));
    down=bit_and(e,down,sign);up=bit_and(e,up,not(e,sign));pl_operand inf=bit_or(e,near,down);inf=bit_or(e,inf,up);
    pl_operand payload=shift(e,sig,drop);payload=bit_and(e,payload,constant(fraction_mask));stored_exp=shl(e,stored_exp,constant(f));payload=bit_or(e,payload,stored_exp);
    pl_operand over_value=select(e,constant(full<<f),constant(((full-1u)<<f)|fraction_mask),inf);payload=select(e,over_value,payload,overflow);
    payload=select(e,constant(0u),payload,flush);pl_operand sign_bits=shl(e,sign,constant(bits-1u));payload=bit_or(e,payload,sign_bits);
    pl_operand raised=shl(e,overflow,constant(3u)),u_bits=shl(e,u,constant(4u)),p_bits=shl(e,p,constant(5u));raised=bit_or(e,raised,u_bits);raised=bit_or(e,raised,p_bits);
    pl_operand ea=bit_and(e,sa,constant(32767u)),eb=bit_and(e,sb,constant(32767u)),all_a=equal(e,ea,constant(32767u)),all_b=equal(e,eb,constant(32767u));
    pl_operand fraction_a=bit_and(e,a,constant(0x7fffffffffffffffull)),fraction_b=bit_and(e,b,constant(0x7fffffffffffffffull));
    pl_operand nan_a=bit_and(e,all_a,nz(e,fraction_a)),nan_b=bit_and(e,all_b,nz(e,fraction_b)),nan=bit_or(e,nan_a,nan_b);
    pl_operand sna=bit_and(e,nan_a,not(e,bit(e,a,62u))),snb=bit_and(e,nan_b,not(e,bit(e,b,62u))),invalid=bit_or(e,sna,snb);
    pl_operand za=equal(e,a,constant(0u)),zb=equal(e,b,constant(0u)),both_all=bit_and(e,all_a,all_b),conflict,ze=constant(0u);
    if(operation==1u){pl_operand ai_bz=bit_and(e,all_a,zb),bi_az=bit_and(e,all_b,za);conflict=bit_or(e,ai_bz,bi_az);}
    else if(operation>=4u){pl_operand both_zero=bit_and(e,za,zb);conflict=bit_or(e,both_all,both_zero);ze=bit_and(e,zb,not(e,za));ze=bit_and(e,ze,not(e,all_a));}
    else{pl_operand as=bit(e,sa,15u),bs=bit(e,sb,15u);if(operation==2u)bs=xor(e,bs,constant(1u));conflict=bit_and(e,both_all,not(e,equal(e,as,bs)));}
    conflict=bit_and(e,conflict,not(e,nan));invalid=bit_or(e,invalid,conflict);
    pl_operand priority=bit_or(e,nan,invalid);priority=bit_or(e,priority,ze);pl_operand de=bit_or(e,da,db);de=bit_and(e,de,not(e,priority));
    // Precomputation exceptions stop later flags only when unmasked. QNaN,
    // invalid and zero-divide results never enter numeric rounding.
    pl_operand early=bit_or(e,nan,conflict);early=bit_or(e,early,ze);early=bit_or(e,early,all_a);early=bit_or(e,early,all_b);
    pl_operand unmask_d=bit_and(e,de,not(e,bit(e,mxcsr,8u)));raised=select(e,constant(0u),raised,early);raised=select(e,constant(0u),raised,unmask_d);
    pl_operand de_bits=shl(e,de,constant(1u)),ze_bits=shl(e,ze,constant(2u));raised=bit_or(e,raised,invalid);raised=bit_or(e,raised,de_bits);raised=bit_or(e,raised,ze_bits);
    pl_operand inf_sign=sign;if(operation<4u&&operation!=1u){inf_sign=select(e,bit(e,sa,15u),bit(e,sb,15u),all_a);if(operation==2u){pl_operand source_sign=xor(e,bit(e,sb,15u),constant(1u));inf_sign=select(e,bit(e,sa,15u),source_sign,all_a);}}
    pl_operand inf_bits=shl(e,inf_sign,constant(bits-1u));inf_bits=bit_or(e,inf_bits,constant(full<<f));pl_operand special=inf_bits;
    if(operation>=4u){pl_operand result_zero=bit_or(e,all_b,za);special=select(e,sign_bits,special,result_zero);}
    pl_operand any_all=bit_or(e,all_a,all_b);any_all=bit_or(e,any_all,ze);payload=select(e,special,payload,any_all);
    pl_operand nan_bits=select(e,original_a,original_b,nan_a);nan_bits=bit_or(e,nan_bits,constant(1ull<<(f-1u)));payload=select(e,nan_bits,payload,nan);
    payload=select(e,constant((1ull<<(bits-1u))|(full<<f)|(1ull<<(f-1u))),payload,conflict);
    raw->locals[0]=payload;raw->locals[1]=raised;raw->locals[2]=(pl_operand){PL_OPERAND_LOCAL,2u};
    if(e->failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,0u};return pl_compact_projected(raw,live,arena,out);
}
static int arithmetic_plan(pl_u32 bits,pl_u32 integer,pl_u32 operation,pl_u32 ieee,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits&&(integer?(bits!=16u&&bits!=32u):(bits!=32u&&bits!=64u)))||operation>5u)return PL_ERROR_PLAN;
    int division=operation>=4u,multiplication=operation==1u;pl_u64 bias=(division||multiplication)?65536u:128u;
    pl_plan raw={.instructions=1u};expression e={0};
    pl_u32 locals=ieee?3u:bits?5u:6u;
    if(pl_builder_open(&e.builder,&raw,arena,PL_X86_X87_ARITHMETIC_MAX_NODES,2048u,0u,locals))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},sa={PL_OPERAND_LOCAL,1u},input={PL_OPERAND_LOCAL,2u};
    pl_operand cw={PL_OPERAND_LOCAL,bits?3u:4u},empty={PL_OPERAND_LOCAL,bits?4u:5u};
    pl_operand b=input,sb={PL_OPERAND_LOCAL,3u};
    pl_operand source_denormal=constant(0u),original_a=a,original_b=sa,den_a=constant(0u),den_b=constant(0u),mxcsr=input;
    if(ieee){
        ieee_expression av=ieee_value(&e,ieee,original_a),bv=ieee_value(&e,ieee,original_b);
        den_a=bit_and(&e,av.classes,constant(1u));den_b=bit_and(&e,bv.classes,constant(1u));pl_operand daz=bit(&e,mxcsr,6u);
        pl_operand flush_a=bit_and(&e,den_a,daz),flush_b=bit_and(&e,den_b,daz),sign_a=bit_and(&e,av.se,constant(32768u)),sign_b=bit_and(&e,bv.se,constant(32768u));
        a=select(&e,constant(0u),av.sig,flush_a);sa=select(&e,sign_a,av.se,flush_a);b=select(&e,constant(0u),bv.sig,flush_b);sb=select(&e,sign_b,bv.se,flush_b);
        den_a=bit_and(&e,den_a,not(&e,daz));den_b=bit_and(&e,den_b,not(&e,daz));pl_operand rc_bits=shift(&e,mxcsr,3u);rc_bits=bit_and(&e,rc_bits,constant(3u<<10u));cw=bit_or(&e,constant(0x37fu),rc_bits);
    }
    else if(bits&&integer){integer_expression value=integer_value(&e,bits,input);b=value.sig;sb=value.se;}
    else if(bits){ieee_expression value=ieee_value(&e,bits,input);b=value.sig;sb=value.se;source_denormal=bit_and(&e,value.classes,constant(1u));}
    pl_operand ea=bit_and(&e,sa,constant(0x7fffu)),eb=bit_and(&e,sb,constant(0x7fffu));
    pl_operand za=equal(&e,ea,constant(0u)),zb=equal(&e,eb,constant(0u));
    pl_operand ae=select(&e,constant(1u),ea,za),be=select(&e,constant(1u),eb,zb);
    pl_operand as=shift(&e,sa,15u),bs=shift(&e,sb,15u);
    if(operation==3u)as=xor(&e,as,constant(1u));
    if(operation==2u)bs=xor(&e,bs,constant(1u));
    pl_operand hi,lo,exponent,sign,nonzero,same_sign=equal(&e,as,bs);
    if(division){
        pl_operand numerator=operation==5u?b:a,denominator=operation==5u?a:b;
        pl_operand ne=operation==5u?be:ae,de=operation==5u?ae:be;
        pl_operand nl=leading_zeros(&e,numerator),dl=leading_zeros(&e,denominator);
        numerator=shl(&e,numerator,nl);denominator=shl(&e,denominator,dl);
        pl_operand den_nonzero=nz(&e,denominator);denominator=select(&e,denominator,constant(0x8000000000000000ull),den_nonzero);
        pl_operand small=less(&e,numerator,denominator),half=shift(&e,numerator,1u);
        pl_operand h=select(&e,numerator,half,small),last=bit_and(&e,numerator,constant(1u));last=shl(&e,last,constant(63u));
        pl_operand l=select(&e,constant(0u),last,small);
        quotient_expression value=unsigned_divide_value(&e,h,l,denominator);hi=value.quotient;
        // Only remainder zero, below/tied/above half can affect the shared
        // round/jam consumer. Preserve that complete observation, not another
        // 64 quotient bits which the output can never distinguish.
        pl_operand carry=shift(&e,value.remainder,63u),twice=shl(&e,value.remainder,constant(1u));
        pl_operand above=less(&e,denominator,twice);above=bit_or(&e,above,carry);
        pl_operand tied=equal(&e,denominator,twice),no_carry=not(&e,carry);tied=bit_and(&e,tied,no_carry);
        lo=select(&e,constant(0x8000000000000001ull),constant(1u),above);
        lo=select(&e,constant(0x8000000000000000ull),lo,tied);pl_operand tail=nz(&e,value.remainder);lo=select(&e,lo,constant(0u),tail);
        exponent=sub(&e,ne,nl);exponent=sub(&e,exponent,de);exponent=add(&e,exponent,dl);
        exponent=add(&e,exponent,constant(16383u+bias));exponent=sub(&e,exponent,small);
        sign=xor(&e,as,bs);nonzero=nz(&e,hi);exponent=select(&e,exponent,constant(bias),nonzero);
    }else if(multiplication){
        pl_operand al=leading_zeros(&e,a),bl=leading_zeros(&e,b),av=shl(&e,a,al),bv=shl(&e,b,bl);
        pl_operand a0=bit_and(&e,av,constant(0xffffffffu)),a1=shift(&e,av,32u),b0=bit_and(&e,bv,constant(0xffffffffu)),b1=shift(&e,bv,32u);
        pl_operand p00=binary(&e,PL_OPCODE_MULR,a0,b0),p10=binary(&e,PL_OPCODE_MULR,a1,b0);
        pl_operand p01=binary(&e,PL_OPCODE_MULR,a0,b1),p11=binary(&e,PL_OPCODE_MULR,a1,b1);
        pl_operand low_upper=shift(&e,p00,32u),t=add(&e,low_upper,p10),t_low=bit_and(&e,t,constant(0xffffffffu));
        pl_operand u=add(&e,p01,t_low),t_high=shift(&e,t,32u),u_high=shift(&e,u,32u);
        pl_operand product_hi=add(&e,p11,t_high);product_hi=add(&e,product_hi,u_high);
        pl_operand product_lo=binary(&e,PL_OPCODE_MULR,av,bv),wide=shift(&e,product_hi,63u);
        pl_operand shifted_hi=shl(&e,product_hi,constant(1u)),cross=shift(&e,product_lo,63u);shifted_hi=bit_or(&e,shifted_hi,cross);
        pl_operand shifted_lo=shl(&e,product_lo,constant(1u));hi=select(&e,product_hi,shifted_hi,wide);lo=select(&e,product_lo,shifted_lo,wide);
        exponent=add(&e,ae,be);exponent=sub(&e,exponent,al);exponent=sub(&e,exponent,bl);
        exponent=add(&e,exponent,constant(bias-16383u));exponent=add(&e,exponent,wide);
        sign=xor(&e,as,bs);nonzero=nz(&e,hi);exponent=select(&e,exponent,constant(bias),nonzero);
    }else{
    pl_operand equal_exp=equal(&e,ae,be),less_exp=less(&e,ae,be),less_sig=less(&e,a,b);
    pl_operand at_exp_less=bit_and(&e,equal_exp,less_sig),bigger_b=bit_or(&e,less_exp,at_exp_less);
    pl_operand large=select(&e,b,a,bigger_b),small=select(&e,a,b,bigger_b);
    pl_operand le=select(&e,be,ae,bigger_b),se=select(&e,ae,be,bigger_b);sign=select(&e,bs,as,bigger_b);
    pl_operand distance=sub(&e,le,se);pair aligned=right_jam(&e,(pair){small,constant(0u)},distance);
    pl_operand sum=add(&e,large,aligned.hi),carry=less(&e,sum,large);
    pl_operand sum_hi=shift(&e,sum,1u);sum_hi=bit_or(&e,sum_hi,constant(0x8000000000000000ull));
    pl_operand sum_bit=bit_and(&e,sum,constant(1u));sum_bit=shl(&e,sum_bit,constant(63u));
    pl_operand sum_lo=shift(&e,aligned.lo,1u);sum_lo=bit_or(&e,sum_lo,sum_bit);
    pl_operand sum_sticky=bit_and(&e,aligned.lo,constant(1u));sum_lo=bit_or(&e,sum_lo,sum_sticky);
    sum_hi=select(&e,sum_hi,sum,carry);sum_lo=select(&e,sum_lo,aligned.lo,carry);
    pl_operand borrowed=nz(&e,aligned.lo),difference=sub(&e,large,aligned.hi);difference=sub(&e,difference,borrowed);
    pl_operand difference_lo=sub(&e,constant(0u),aligned.lo);
    pl_operand value_hi=select(&e,sum_hi,difference,same_sign),value_lo=select(&e,sum_lo,difference_lo,same_sign);
    pair value={value_hi,value_lo};
    pl_operand addition_carry=bit_and(&e,carry,same_sign);exponent=add(&e,le,constant(bias));exponent=add(&e,exponent,addition_carry);
    pl_operand high_zero=equal(&e,value.hi,constant(0u)),any=bit_or(&e,value.hi,value.lo);nonzero=nz(&e,any);
    hi=select(&e,value.lo,value.hi,high_zero);lo=select(&e,constant(0u),value.lo,high_zero);
    pl_operand high_adjust=shl(&e,high_zero,constant(6u));exponent=sub(&e,exponent,high_adjust);
    pl_operand leading=leading_zeros(&e,hi),back=sub(&e,constant(64u),leading),cross=shr(&e,lo,back);
    pl_operand no_shift=equal(&e,leading,constant(0u));cross=select(&e,constant(0u),cross,no_shift);
    hi=shl(&e,hi,leading);hi=bit_or(&e,hi,cross);lo=shl(&e,lo,leading);exponent=sub(&e,exponent,leading);
    exponent=select(&e,exponent,constant(bias),nonzero);
    }
    pl_operand rc=shift(&e,cw,10u);rc=bit_and(&e,rc,constant(3u));
    pl_operand negative_zero=equal(&e,rc,constant(1u)),zero_sign=select(&e,as,negative_zero,same_sign);
    if(!division&&!multiplication)sign=select(&e,sign,zero_sign,nonzero);
    if(ieee)return ieee_result(&e,&raw,ieee,operation,bias,hi,lo,exponent,sign,nonzero,a,sa,b,sb,den_a,den_b,original_a,original_b,mxcsr,arena,out);
    pl_operand pc=shift(&e,cw,8u);pc=bit_and(&e,pc,constant(3u));
    pl_operand short_pc=equal(&e,pc,constant(0u)),double_pc=equal(&e,pc,constant(2u));
    pl_operand drop=select(&e,constant(11u),constant(0u),double_pc);drop=select(&e,constant(40u),drop,short_pc);
    rounded normal=round_value(&e,(pair){hi,lo},exponent,drop,rc,sign);
    pl_operand subnormal=less(&e,exponent,constant(1u+bias)),under_shift=sub(&e,constant(1u+bias),exponent);
    under_shift=select(&e,under_shift,constant(0u),subnormal);
    pair scaled=right_jam(&e,(pair){hi,lo},under_shift);
    pl_operand scale_exponent=select(&e,constant(bias),exponent,subnormal);
    rounded gradual=round_value(&e,scaled,scale_exponent,drop,rc,sign);
    pl_operand gradual_top=shift(&e,gradual.sig,63u),gradual_exp=add(&e,constant(bias),gradual_top);
    gradual_exp=select(&e,gradual_exp,gradual.exp,subnormal);
    pl_operand tiny=equal(&e,gradual_exp,constant(bias));tiny=bit_and(&e,tiny,nonzero);
    pl_operand overflow=less(&e,normal.exp,constant(32767u+bias));overflow=not(&e,overflow);
    pl_operand um=bit(&e,cw,4u),unmasked_um=not(&e,um),om=bit(&e,cw,3u),unmasked_om=not(&e,om);
    pl_operand tiny_cause=bit_or(&e,gradual.inexact,unmasked_um),underflow=bit_and(&e,tiny,tiny_cause);
    pl_operand wrapped_under=bit_and(&e,underflow,unmasked_um),wrapped_over=bit_and(&e,overflow,unmasked_om);
    pl_operand wrapped=bit_or(&e,wrapped_under,wrapped_over),wrapped_exp=add(&e,normal.exp,constant(24576u));
    pl_operand over_exp=sub(&e,normal.exp,constant(24576u));wrapped_exp=select(&e,over_exp,wrapped_exp,wrapped_over);
    pl_operand down=equal(&e,rc,constant(1u)),up=equal(&e,rc,constant(2u)),positive=not(&e,sign),near=equal(&e,rc,constant(0u));
    down=bit_and(&e,down,sign);up=bit_and(&e,up,positive);pl_operand to_inf=bit_or(&e,down,up);to_inf=bit_or(&e,to_inf,near);
    pl_operand unit=shl(&e,constant(1u),drop),mask=sub(&e,unit,constant(1u)),max_sig=xor(&e,mask,constant(~0ull));
    pl_operand overflow_sig=select(&e,constant(0x8000000000000000ull),max_sig,to_inf);
    pl_operand overflow_exp=select(&e,constant(32767u+bias),constant(32766u+bias),to_inf);
    pl_operand result_sig=select(&e,overflow_sig,gradual.sig,overflow),result_exp=select(&e,overflow_exp,gradual_exp,overflow);
    result_sig=select(&e,normal.sig,result_sig,wrapped);result_exp=select(&e,wrapped_exp,result_exp,wrapped);
    pl_operand increment=select(&e,normal.increment,gradual.increment,wrapped),inexact=select(&e,normal.inexact,gradual.inexact,wrapped);
    pl_operand masked_over=bit_and(&e,overflow,om);inexact=bit_or(&e,inexact,masked_over);
    /* Masked overflow rounds to infinity or the finite maximum even when
     * the unbounded significand addition had no discarded fraction. */
    increment=select(&e,to_inf,increment,masked_over);
    pl_operand raised=shl(&e,overflow,constant(3u)),u=shl(&e,underflow,constant(4u)),p=shl(&e,inexact,constant(5u));
    raised=bit_or(&e,raised,u);raised=bit_or(&e,raised,p);
    result_exp=sub(&e,result_exp,constant(bias));pl_operand sign_word=shl(&e,sign,constant(15u)),result_se=bit_or(&e,result_exp,sign_word);
    pl_operand ja=bit(&e,a,63u),jb=bit(&e,b,63u),nonzero_ea=not(&e,za),nonzero_eb=not(&e,zb);
    pl_operand no_ja=not(&e,ja),no_jb=not(&e,jb),ua=bit_and(&e,nonzero_ea,no_ja),ub=(bits&&integer)?constant(0u):bit_and(&e,nonzero_eb,no_jb);
    pl_operand unsupported=bit_or(&e,ua,ub),all_ea=equal(&e,ea,constant(32767u)),all_eb=(bits&&integer)?constant(0u):equal(&e,eb,constant(32767u));
    pl_operand fa=bit_and(&e,a,constant(0x7fffffffffffffffull)),fb=bit_and(&e,b,constant(0x7fffffffffffffffull));
    pl_operand fraction_a=nz(&e,fa),fraction_b=nz(&e,fb),nan_a=bit_and(&e,all_ea,fraction_a),nan_b=bit_and(&e,all_eb,fraction_b);
    pl_operand nan=bit_or(&e,nan_a,nan_b),qa=bit(&e,a,62u),qb=bit(&e,b,62u),sna=not(&e,qa),snb=not(&e,qb);
    sna=bit_and(&e,nan_a,sna);snb=bit_and(&e,nan_b,snb);pl_operand signaling=bit_or(&e,sna,snb);
    /* Raw NaN signs/payloads precede arithmetic sign changes. Quiet wins
     * over signaling; within one class use larger payload, then positive
     * sign on an equal-payload tie. The integer projection has no NaN. */
    pl_operand a_quiet=bit_or(&e,a,constant(0x4000000000000000ull)),b_quiet=bit_or(&e,b,constant(0x4000000000000000ull));
    pl_operand larger_a=less(&e,b_quiet,a_quiet),equal_payload=equal(&e,a_quiet,b_quiet),positive_tie=less(&e,sa,sb);
    positive_tie=bit_and(&e,equal_payload,positive_tie);larger_a=bit_or(&e,larger_a,positive_tie);
    pl_operand same_class=equal(&e,sna,snb),b_not_nan=not(&e,nan_b),a_not_signaling=not(&e,sna);
    pl_operand b_signaling=bit_and(&e,snb,a_not_signaling);
    pl_operand choose_a=select(&e,larger_a,b_signaling,same_class);choose_a=bit_or(&e,choose_a,b_not_nan);choose_a=bit_and(&e,choose_a,nan_a);
    pl_operand nan_sig=(bits&&integer)?a_quiet:select(&e,a_quiet,b_quiet,choose_a),nan_se=(bits&&integer)?sa:select(&e,sa,sb,choose_a);
    pl_operand both_all=bit_and(&e,all_ea,all_eb),opposed=not(&e,same_sign),conflict=bit_and(&e,both_all,opposed);
    pl_operand a_zero=equal(&e,a,constant(0u)),b_zero=equal(&e,b,constant(0u));a_zero=bit_and(&e,a_zero,za);b_zero=bit_and(&e,b_zero,zb);
    pl_operand zero_division=constant(0u);
    if(multiplication){pl_operand ai_bz=bit_and(&e,all_ea,b_zero),bi_az=bit_and(&e,all_eb,a_zero);conflict=bit_or(&e,ai_bz,bi_az);}
    if(division){pl_operand both_zero=bit_and(&e,a_zero,b_zero);conflict=bit_or(&e,both_all,both_zero);
        pl_operand den_zero=operation==5u?a_zero:b_zero,num_zero=operation==5u?b_zero:a_zero,num_all=operation==5u?all_eb:all_ea;
        pl_operand no_num_zero=not(&e,num_zero),finite_num=not(&e,num_all);zero_division=bit_and(&e,den_zero,no_num_zero);
        zero_division=bit_and(&e,zero_division,finite_num);}
    pl_operand no_nan=not(&e,nan);conflict=bit_and(&e,conflict,no_nan);
    pl_operand indefinite=bit_or(&e,empty,unsupported);indefinite=bit_or(&e,indefinite,conflict);
    pl_operand invalid=bit_or(&e,indefinite,signaling),any_all=bit_or(&e,all_ea,all_eb),special=bit_or(&e,indefinite,any_all);
    pl_operand no_invalid=not(&e,invalid);zero_division=bit_and(&e,zero_division,no_invalid);zero_division=bit_and(&e,zero_division,no_nan);
    special=bit_or(&e,special,zero_division);
    raised=select(&e,constant(0u),raised,special);increment=select(&e,constant(0u),increment,special);
    pl_operand inf_sign=(division||multiplication)?sign:select(&e,as,bs,all_ea);inf_sign=shl(&e,inf_sign,constant(15u));
    pl_operand inf_se=bit_or(&e,inf_sign,constant(32767u)),special_sig=select(&e,nan_sig,constant(0x8000000000000000ull),nan);
    pl_operand special_se=select(&e,nan_se,inf_se,nan);
    if(division){pl_operand den_all=operation==5u?all_ea:all_eb,num_zero=operation==5u?b_zero:a_zero;
        pl_operand result_zero=bit_or(&e,den_all,num_zero);special_sig=select(&e,constant(0u),special_sig,result_zero);
        special_se=select(&e,sign_word,special_se,result_zero);
        special_sig=select(&e,nan_sig,special_sig,nan);special_se=select(&e,nan_se,special_se,nan);}
    pl_operand special_result=bit_or(&e,any_all,zero_division);
    result_sig=select(&e,special_sig,result_sig,special_result);result_se=select(&e,special_se,result_se,special_result);
    result_sig=select(&e,constant(0xc000000000000000ull),result_sig,indefinite);result_se=select(&e,constant(0xffffu),result_se,indefinite);
    pl_operand nonzero_a=nz(&e,a),nonzero_b=nz(&e,b),da=bit_and(&e,za,nonzero_a),db=bits?source_denormal:bit_and(&e,zb,nonzero_b);
    pl_operand denormal=bit_or(&e,da,db),im=bit(&e,cw,0u),dm=bit(&e,cw,1u),priority=bit_or(&e,invalid,nan);
    priority=bit_or(&e,priority,zero_division);
    pl_operand ie=select(&e,constant(1u),constant(0u),invalid),de=select(&e,constant(0u),denormal,priority);
    pl_operand de_bits=shl(&e,de,constant(1u)),unmask_i=not(&e,im),unmask_d=not(&e,dm);
    unmask_i=bit_and(&e,unmask_i,invalid);unmask_d=bit_and(&e,unmask_d,de);pl_operand suppress=bit_or(&e,unmask_i,unmask_d);
    if(division){pl_operand zm=bit(&e,cw,2u),unmask_z=not(&e,zm);unmask_z=bit_and(&e,unmask_z,zero_division);suppress=bit_or(&e,suppress,unmask_z);}
    raised=select(&e,constant(0u),raised,suppress);increment=select(&e,constant(0u),increment,suppress);
    raised=bit_or(&e,raised,ie);raised=bit_or(&e,raised,de_bits);pl_operand ze=shl(&e,zero_division,constant(2u));raised=bit_or(&e,raised,ze);
    pl_operand sf=shl(&e,empty,constant(6u));raised=bit_or(&e,raised,sf);
    pl_operand r_exp=bit_and(&e,result_se,constant(32767u)),zero_exp=equal(&e,r_exp,constant(0u)),zero_sig=equal(&e,result_sig,constant(0u));
    pl_operand result_zero=bit_and(&e,zero_exp,zero_sig),special_tag=equal(&e,r_exp,constant(32767u));special_tag=bit_or(&e,special_tag,zero_exp);
    pl_operand top_bit=shift(&e,result_sig,63u),no_top=not(&e,top_bit);special_tag=bit_or(&e,special_tag,no_top);
    pl_operand tag=select(&e,constant(2u),constant(0u),special_tag);tag=select(&e,constant(1u),tag,result_zero);
    pl_operand c1=shl(&e,increment,constant(9u)),no_write=shl(&e,suppress,constant(16u)),tag_word=shl(&e,tag,constant(18u));
    pl_operand outcome=bit_or(&e,raised,c1);outcome=bit_or(&e,outcome,no_write);outcome=bit_or(&e,outcome,tag_word);
    raw.locals[0]=result_sig;raw.locals[1]=result_se;raw.locals[2]=outcome;
    for(pl_u32 local=3u;local<locals;++local)raw.locals[local]=(pl_operand){PL_OPERAND_LOCAL,local};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_integer_arithmetic_plan(pl_u32 bits,pl_u32 operation,pl_arena *arena,pl_plan *out)
{return bits==16u||bits==32u?arithmetic_plan(bits,1u,operation,0u,arena,out):PL_ERROR_PLAN;}
int pl_x86_x87_memory_arithmetic_plan(pl_u32 bits,pl_u32 operation,pl_arena *arena,pl_plan *out)
{return bits==32u||bits==64u?arithmetic_plan(bits,0u,operation,0u,arena,out):PL_ERROR_PLAN;}
int pl_x86_x87_register_arithmetic_plan(pl_u32 operation,pl_arena *arena,pl_plan *out)
{return arithmetic_plan(0u,0u,operation,0u,arena,out);}
int pl_x86_float_arithmetic_plan(pl_u32 bits,pl_u32 operation,pl_arena *arena,pl_plan *out)
{return (bits==32u||bits==64u)&&operation<=3u?arithmetic_plan(0u,0u,operation==3u?4u:operation,bits,arena,out):PL_ERROR_PLAN;}
