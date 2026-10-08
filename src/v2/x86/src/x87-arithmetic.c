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
    if(operation!=0u&&operation!=2u&&operation!=3u)return 0;
    pl_u32 group=operation==0u?0u:operation==2u?4u:5u;
    if((fop>>8u)!=(width==4u?2u:6u)||((fop>>3u)&7u)!=group||(fop&0xc0u)==0xc0u
        ||i->machine_argument!=(12u|((pl_u64)width<<8u)|((pl_u64)fop<<16u)|((pl_u64)operation<<36u)))return 0;
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
    if((kind==8u&&group!=0u)||(kind==13u&&group!=4u&&group!=5u)||(kind!=8u&&kind!=13u))return 0;
    pl_u32 destination=primary==0xd8u?0u:index,source=primary==0xd8u?index:0u;
    pl_u32 reverse=kind==13u&&(primary==0xd8u?group==5u:group==4u),operation=kind==8u?0u:reverse?3u:2u;
    pl_u32 options=kind==8u?pop:reverse|(pop<<1u);
    if(i->machine_argument!=(kind|((pl_u64)fop<<16u)|((pl_u64)source<<32u)|((pl_u64)destination<<36u)|((pl_u64)options<<40u)))return 0;
    for(pl_u32 n=0u;n<2u;++n){const pl_x86_operand *o=i->operands+n;const pl_x86_register *r=&o->value.reg;
        if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||r->class_id!=PL_X86_REGISTER_X87||r->bits!=80u
            ||r->flags||r->index!=(n?source:destination))return 0;}
    *out=(pl_x86_x87_register_arithmetic){(pl_u8)source,(pl_u8)destination,(pl_u8)operation,(pl_u8)pop,(pl_u16)fop};return 1;
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
static int arithmetic_plan(pl_u32 bits,pl_u32 operation,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits!=0u&&bits!=16u&&bits!=32u)||(operation!=0u&&operation!=2u&&operation!=3u))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    pl_u32 locals=bits?5u:6u;
    if(pl_builder_open(&e.builder,&raw,arena,PL_X86_X87_ARITHMETIC_MAX_NODES,2048u,0u,locals))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},sa={PL_OPERAND_LOCAL,1u},input={PL_OPERAND_LOCAL,2u};
    pl_operand cw={PL_OPERAND_LOCAL,bits?3u:4u},empty={PL_OPERAND_LOCAL,bits?4u:5u};
    pl_operand b=input,sb={PL_OPERAND_LOCAL,3u};
    if(bits){integer_expression integer=integer_value(&e,bits,input);b=integer.sig;sb=integer.se;}
    pl_operand ea=bit_and(&e,sa,constant(0x7fffu)),eb=bit_and(&e,sb,constant(0x7fffu));
    pl_operand za=equal(&e,ea,constant(0u)),zb=equal(&e,eb,constant(0u));
    pl_operand ae=select(&e,constant(1u),ea,za),be=select(&e,constant(1u),eb,zb);
    pl_operand as=shift(&e,sa,15u),bs=shift(&e,sb,15u);
    if(operation==3u)as=xor(&e,as,constant(1u));
    if(operation==2u)bs=xor(&e,bs,constant(1u));
    pl_operand equal_exp=equal(&e,ae,be),less_exp=less(&e,ae,be),less_sig=less(&e,a,b);
    pl_operand at_exp_less=bit_and(&e,equal_exp,less_sig),bigger_b=bit_or(&e,less_exp,at_exp_less);
    pl_operand large=select(&e,b,a,bigger_b),small=select(&e,a,b,bigger_b);
    pl_operand le=select(&e,be,ae,bigger_b),se=select(&e,ae,be,bigger_b),sign=select(&e,bs,as,bigger_b);
    pl_operand distance=sub(&e,le,se);pair aligned=right_jam(&e,(pair){small,constant(0u)},distance);
    pl_operand same_sign=equal(&e,as,bs),sum=add(&e,large,aligned.hi),carry=less(&e,sum,large);
    pl_operand sum_hi=shift(&e,sum,1u);sum_hi=bit_or(&e,sum_hi,constant(0x8000000000000000ull));
    pl_operand sum_bit=bit_and(&e,sum,constant(1u));sum_bit=shl(&e,sum_bit,constant(63u));
    pl_operand sum_lo=shift(&e,aligned.lo,1u);sum_lo=bit_or(&e,sum_lo,sum_bit);
    pl_operand sum_sticky=bit_and(&e,aligned.lo,constant(1u));sum_lo=bit_or(&e,sum_lo,sum_sticky);
    sum_hi=select(&e,sum_hi,sum,carry);sum_lo=select(&e,sum_lo,aligned.lo,carry);
    pl_operand borrowed=nz(&e,aligned.lo),difference=sub(&e,large,aligned.hi);difference=sub(&e,difference,borrowed);
    pl_operand difference_lo=sub(&e,constant(0u),aligned.lo);
    pl_operand value_hi=select(&e,sum_hi,difference,same_sign),value_lo=select(&e,sum_lo,difference_lo,same_sign);
    pair value={value_hi,value_lo};
    pl_operand addition_carry=bit_and(&e,carry,same_sign),exponent=add(&e,le,constant(128u));exponent=add(&e,exponent,addition_carry);
    pl_operand high_zero=equal(&e,value.hi,constant(0u)),any=bit_or(&e,value.hi,value.lo),nonzero=nz(&e,any);
    pl_operand hi=select(&e,value.lo,value.hi,high_zero),lo=select(&e,constant(0u),value.lo,high_zero);
    pl_operand high_adjust=shl(&e,high_zero,constant(6u));exponent=sub(&e,exponent,high_adjust);
    pl_operand leading=leading_zeros(&e,hi),back=sub(&e,constant(64u),leading),cross=shr(&e,lo,back);
    pl_operand no_shift=equal(&e,leading,constant(0u));cross=select(&e,constant(0u),cross,no_shift);
    hi=shl(&e,hi,leading);hi=bit_or(&e,hi,cross);lo=shl(&e,lo,leading);exponent=sub(&e,exponent,leading);
    exponent=select(&e,exponent,constant(128u),nonzero);
    pl_operand rc=shift(&e,cw,10u);rc=bit_and(&e,rc,constant(3u));
    pl_operand negative_zero=equal(&e,rc,constant(1u)),zero_sign=select(&e,as,negative_zero,same_sign);
    sign=select(&e,sign,zero_sign,nonzero);
    pl_operand pc=shift(&e,cw,8u);pc=bit_and(&e,pc,constant(3u));
    pl_operand short_pc=equal(&e,pc,constant(0u)),double_pc=equal(&e,pc,constant(2u));
    pl_operand drop=select(&e,constant(11u),constant(0u),double_pc);drop=select(&e,constant(40u),drop,short_pc);
    rounded normal=round_value(&e,(pair){hi,lo},exponent,drop,rc,sign);
    pl_operand subnormal=less(&e,exponent,constant(129u)),under_shift=sub(&e,constant(129u),exponent);
    under_shift=select(&e,under_shift,constant(0u),subnormal);
    pair scaled=right_jam(&e,(pair){hi,lo},under_shift);
    pl_operand scale_exponent=select(&e,constant(128u),exponent,subnormal);
    rounded gradual=round_value(&e,scaled,scale_exponent,drop,rc,sign);
    pl_operand gradual_top=shift(&e,gradual.sig,63u),gradual_exp=add(&e,constant(128u),gradual_top);
    gradual_exp=select(&e,gradual_exp,gradual.exp,subnormal);
    pl_operand tiny=equal(&e,gradual_exp,constant(128u));tiny=bit_and(&e,tiny,nonzero);
    pl_operand overflow=less(&e,normal.exp,constant(32767u+128u));overflow=not(&e,overflow);
    pl_operand um=bit(&e,cw,4u),unmasked_um=not(&e,um),om=bit(&e,cw,3u),unmasked_om=not(&e,om);
    pl_operand tiny_cause=bit_or(&e,gradual.inexact,unmasked_um),underflow=bit_and(&e,tiny,tiny_cause);
    pl_operand wrapped_under=bit_and(&e,underflow,unmasked_um),wrapped_over=bit_and(&e,overflow,unmasked_om);
    pl_operand wrapped=bit_or(&e,wrapped_under,wrapped_over),wrapped_exp=add(&e,normal.exp,constant(24576u));
    pl_operand over_exp=sub(&e,normal.exp,constant(24576u));wrapped_exp=select(&e,over_exp,wrapped_exp,wrapped_over);
    pl_operand down=equal(&e,rc,constant(1u)),up=equal(&e,rc,constant(2u)),positive=not(&e,sign),near=equal(&e,rc,constant(0u));
    down=bit_and(&e,down,sign);up=bit_and(&e,up,positive);pl_operand to_inf=bit_or(&e,down,up);to_inf=bit_or(&e,to_inf,near);
    pl_operand unit=shl(&e,constant(1u),drop),mask=sub(&e,unit,constant(1u)),max_sig=xor(&e,mask,constant(~0ull));
    pl_operand overflow_sig=select(&e,constant(0x8000000000000000ull),max_sig,to_inf);
    pl_operand overflow_exp=select(&e,constant(32767u+128u),constant(32766u+128u),to_inf);
    pl_operand result_sig=select(&e,overflow_sig,gradual.sig,overflow),result_exp=select(&e,overflow_exp,gradual_exp,overflow);
    result_sig=select(&e,normal.sig,result_sig,wrapped);result_exp=select(&e,wrapped_exp,result_exp,wrapped);
    pl_operand increment=select(&e,normal.increment,gradual.increment,wrapped),inexact=select(&e,normal.inexact,gradual.inexact,wrapped);
    pl_operand masked_over=bit_and(&e,overflow,om);inexact=bit_or(&e,inexact,masked_over);
    /* Masked overflow rounds to infinity or the finite maximum even when
     * the unbounded significand addition had no discarded fraction. */
    increment=select(&e,to_inf,increment,masked_over);
    pl_operand raised=shl(&e,overflow,constant(3u)),u=shl(&e,underflow,constant(4u)),p=shl(&e,inexact,constant(5u));
    raised=bit_or(&e,raised,u);raised=bit_or(&e,raised,p);
    result_exp=sub(&e,result_exp,constant(128u));pl_operand sign_word=shl(&e,sign,constant(15u)),result_se=bit_or(&e,result_exp,sign_word);
    pl_operand ja=bit(&e,a,63u),jb=bit(&e,b,63u),nonzero_ea=not(&e,za),nonzero_eb=not(&e,zb);
    pl_operand no_ja=not(&e,ja),no_jb=not(&e,jb),ua=bit_and(&e,nonzero_ea,no_ja),ub=bits?constant(0u):bit_and(&e,nonzero_eb,no_jb);
    pl_operand unsupported=bit_or(&e,ua,ub),all_ea=equal(&e,ea,constant(32767u)),all_eb=bits?constant(0u):equal(&e,eb,constant(32767u));
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
    pl_operand nan_sig=bits?a_quiet:select(&e,a_quiet,b_quiet,choose_a),nan_se=bits?sa:select(&e,sa,sb,choose_a);
    pl_operand both_all=bit_and(&e,all_ea,all_eb),opposed=not(&e,same_sign),conflict=bit_and(&e,both_all,opposed);
    pl_operand no_nan=not(&e,nan);conflict=bit_and(&e,conflict,no_nan);
    pl_operand indefinite=bit_or(&e,empty,unsupported);indefinite=bit_or(&e,indefinite,conflict);
    pl_operand invalid=bit_or(&e,indefinite,signaling),any_all=bit_or(&e,all_ea,all_eb),special=bit_or(&e,indefinite,any_all);
    raised=select(&e,constant(0u),raised,special);increment=select(&e,constant(0u),increment,special);
    pl_operand inf_sign=select(&e,as,bs,all_ea);inf_sign=shl(&e,inf_sign,constant(15u));
    pl_operand inf_se=bit_or(&e,inf_sign,constant(32767u)),special_sig=select(&e,nan_sig,constant(0x8000000000000000ull),nan);
    pl_operand special_se=select(&e,nan_se,inf_se,nan);
    result_sig=select(&e,special_sig,result_sig,any_all);result_se=select(&e,special_se,result_se,any_all);
    result_sig=select(&e,constant(0xc000000000000000ull),result_sig,indefinite);result_se=select(&e,constant(0xffffu),result_se,indefinite);
    pl_operand nonzero_a=nz(&e,a),nonzero_b=nz(&e,b),da=bit_and(&e,za,nonzero_a),db=bits?constant(0u):bit_and(&e,zb,nonzero_b);
    pl_operand denormal=bit_or(&e,da,db),im=bit(&e,cw,0u),dm=bit(&e,cw,1u),priority=bit_or(&e,invalid,nan);
    pl_operand ie=select(&e,constant(1u),constant(0u),invalid),de=select(&e,constant(0u),denormal,priority);
    pl_operand de_bits=shl(&e,de,constant(1u)),unmask_i=not(&e,im),unmask_d=not(&e,dm);
    unmask_i=bit_and(&e,unmask_i,invalid);unmask_d=bit_and(&e,unmask_d,de);pl_operand suppress=bit_or(&e,unmask_i,unmask_d);
    raised=select(&e,constant(0u),raised,suppress);increment=select(&e,constant(0u),increment,suppress);
    raised=bit_or(&e,raised,ie);raised=bit_or(&e,raised,de_bits);pl_operand sf=shl(&e,empty,constant(6u));raised=bit_or(&e,raised,sf);
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
{return bits==16u||bits==32u?arithmetic_plan(bits,operation,arena,out):PL_ERROR_PLAN;}
int pl_x86_x87_register_arithmetic_plan(pl_u32 operation,pl_arena *arena,pl_plan *out)
{return arithmetic_plan(0u,operation,arena,out);}
