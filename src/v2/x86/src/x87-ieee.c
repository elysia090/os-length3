#include <x86/semantics.h>
#include "x87-expression.h"
/* Raw binary interchange -> exact extended fields. NaN signaling/payload
 * and source denormal class survive; consuming operations own exceptions. */
ieee_expression ieee_value(expression *e,pl_u32 bits,pl_operand x)
{
    pl_u32 fraction_bits=bits==32u?23u:52u,bias=bits==32u?127u:1023u;
    pl_u64 exponent_mask=bits==32u?255u:2047u,fraction_mask=(1ull<<fraction_bits)-1u;
    pl_operand exponent=shift(e,x,fraction_bits);exponent=bit_and(e,exponent,constant(exponent_mask));
    pl_operand fraction=bit_and(e,x,constant(fraction_mask)),sign=shift(e,x,bits-1u);sign=bit_and(e,sign,constant(1u));
    pl_operand zero_exp=equal(e,exponent,constant(0u)),zero_fraction=equal(e,fraction,constant(0u));
    pl_operand nonzero_fraction=not(e,zero_fraction),denormal=bit_and(e,zero_exp,nonzero_fraction);
    pl_operand full_exp=equal(e,exponent,constant(exponent_mask)),nan=bit_and(e,full_exp,nonzero_fraction);
    pl_operand quiet=shift(e,fraction,fraction_bits-1u);quiet=bit_and(e,quiet,constant(1u));
    pl_operand signaling=not(e,quiet);signaling=bit_and(e,signaling,nan);
    pl_operand normal_sig=bit_or(e,fraction,constant(1ull<<fraction_bits));normal_sig=binary(e,PL_OPCODE_LANE64_SHL,normal_sig,constant(63u-fraction_bits));
    pl_operand normal_exp=binary(e,89u,exponent,constant(16383u-bias));
    pl_operand leading=leading_zeros(e,fraction),sub_sig=binary(e,PL_OPCODE_LANE64_SHL,fraction,leading);
    pl_operand sub_exp=binary(e,96u,constant(16384u-bias-fraction_bits+63u),leading);sub_exp=select(e,constant(0u),sub_exp,zero_fraction);
    pl_operand sig=select(e,sub_sig,normal_sig,zero_exp),exp=select(e,sub_exp,normal_exp,zero_exp);
    exp=select(e,constant(32767u),exp,full_exp);
    pl_operand sign_word=binary(e,PL_OPCODE_LANE64_SHL,sign,constant(15u)),se=bit_or(e,sign_word,exp);
    pl_operand zero=bit_and(e,zero_exp,zero_fraction),snan_word=binary(e,PL_OPCODE_LANE64_SHL,signaling,constant(1u));
    pl_operand zero_word=binary(e,PL_OPCODE_LANE64_SHL,zero,constant(2u)),classes=bit_or(e,denormal,snan_word);classes=bit_or(e,classes,zero_word);
    return(ieee_expression){sig,se,classes};
}
int pl_x86_x87_ieee_plan(pl_u32 bits,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||(bits!=32u&&bits!=64u))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,64u,192u,0u,5u))return PL_ERROR_ARENA;
    ieee_expression value=ieee_value(&e,bits,(pl_operand){PL_OPERAND_LOCAL,0u});
    raw.locals[0]=value.sig;raw.locals[1]=value.se;raw.locals[2]=value.classes;
    raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};raw.locals[4]=(pl_operand){PL_OPERAND_LOCAL,4u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_memory_load_lower(const pl_x86_instruction *i,pl_x86_x87_integer_load *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER|PL_X86_INSTRUCTION_READS_MEMORY;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=1u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_WRITES_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED)))return 0;
    const pl_x86_operand *m=i->operands;if(m->kind!=PL_X86_OPERAND_MEMORY||(m->bits!=32u&&m->bits!=64u))return 0;
    pl_u32 width=m->bits/8u,fop=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    if((fop>>8u)!=(width==4u?1u:5u)||((fop>>3u)&7u)||(fop&0xc0u)==0xc0u
        ||i->machine_argument!=(10u|((pl_u64)width<<8u)|((pl_u64)fop<<16u)))return 0;
    *out=(pl_x86_x87_integer_load){(pl_u8)width,(pl_u16)fop};return 1;
}
int pl_x86_x87_raw_load_lower(const pl_x86_instruction *i,pl_x86_x87_raw_load *out)
{
    pl_u32 required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    if(!i||!out||i->status!=PL_X86_DECODE_VALID||i->encoding!=PL_X86_ENCODING_LEGACY
        ||i->machine_operation!=PL_X86_MACHINE_X87||i->visible_operand_count!=1u
        ||(i->flow!=PL_X86_FLOW_NEXT&&i->flow!=PL_X86_FLOW_SYSTEM)||(i->flags&required)!=required
        ||(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED|PL_X86_INSTRUCTION_WRITES_MEMORY
            |PL_X86_INSTRUCTION_TRAP_AFTER|PL_X86_INSTRUCTION_PRIVILEGED))
        ||!i->source_bytes||i->source_bytes>15u||i->length!=i->source_bytes||i->fallthrough-i->rip!=i->source_bytes)return 0;
    const pl_x86_operand *o=i->operands;pl_u32 op=(pl_u32)(i->machine_argument>>16u)&0x7ffu;
    if(o->kind==PL_X86_OPERAND_MEMORY){
        if(o->bits!=80u||i->opcode!=0xdbu||!(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)
            ||(op>>8u)!=3u||((op>>3u)&7u)!=5u||(op&0xc0u)==0xc0u
            ||i->machine_argument!=(10u|(10ull<<8u)|((pl_u64)op<<16u)))return 0;
        *out=(pl_x86_x87_raw_load){10u,1u,0u,(pl_u16)op};return 1;
    }
    if(o->kind!=PL_X86_OPERAND_REGISTER||o->bits!=80u||o->value.reg.class_id!=PL_X86_REGISTER_X87
        ||o->value.reg.bits!=80u||o->value.reg.index>=8u||o->value.reg.flags||i->opcode!=0xd9u
        ||(i->flags&PL_X86_INSTRUCTION_READS_MEMORY)||op!=(0x1c0u|o->value.reg.index)
        ||i->machine_argument!=(10u|((pl_u64)op<<16u)|((pl_u64)o->value.reg.index<<32u)))return 0;
    *out=(pl_x86_x87_raw_load){10u,0u,(pl_u8)o->value.reg.index,(pl_u16)op};return 1;
}
int pl_x86_x87_load_plan(pl_u32 bits,pl_u32 format,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||format>2u||(format==2u?bits!=80u:format==1u?(bits!=16u&&bits!=32u&&bits!=64u):(bits!=32u&&bits!=64u)))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,96u,384u,0u,5u))return PL_ERROR_ARENA;
    pl_operand input={PL_OPERAND_LOCAL,0u},cw={PL_OPERAND_LOCAL,1u},full={PL_OPERAND_LOCAL,2u},sig,se,zero,denormal=constant(0u),signaling=constant(0u);
    pl_operand source_empty=format==2u?(pl_operand){PL_OPERAND_LOCAL,4u}:constant(0u),stack_fault=bit_or(&e,full,source_empty);
    if(format==1u){integer_expression v=integer_value(&e,bits,input);sig=v.sig;se=v.se;zero=v.zero;}
    else if(format==2u){sig=input;se=(pl_operand){PL_OPERAND_LOCAL,3u};
        pl_operand exp=bit_and(&e,se,constant(32767u)),ze=equal(&e,exp,constant(0u)),zs=equal(&e,sig,constant(0u));zero=bit_and(&e,ze,zs);}
    else{ieee_expression v=ieee_value(&e,bits,input);sig=v.sig;se=v.se;denormal=bit_and(&e,v.classes,constant(1u));
        signaling=shift(&e,v.classes,1u);signaling=bit_and(&e,signaling,constant(1u));zero=shift(&e,v.classes,2u);zero=bit_and(&e,zero,constant(1u));}
    pl_operand quiet=binary(&e,PL_OPCODE_LANE64_SHL,signaling,constant(62u));sig=bit_or(&e,sig,quiet);
    sig=select(&e,constant(0xc000000000000000ull),sig,stack_fault);se=select(&e,constant(0xffffu),se,stack_fault);
    pl_operand ie=bit_or(&e,stack_fault,signaling),valid=not(&e,ie),de=bit_and(&e,denormal,valid);
    pl_operand exponent=bit_and(&e,se,constant(32767u)),special=equal(&e,exponent,constant(32767u));
    if(format==2u){pl_operand ze=equal(&e,exponent,constant(0u)),j=shift(&e,sig,63u),no_j=not(&e,j);
        special=bit_or(&e,special,ze);special=bit_or(&e,special,no_j);}
    pl_operand tag=select(&e,constant(2u),constant(0u),special);tag=select(&e,constant(1u),tag,zero);tag=select(&e,constant(2u),tag,stack_fault);
    // IEEE denormal loading is exact: even an unmasked DE publishes the
    // normalized value and pushes while latching the deferred exception.
    pl_operand im=bit_and(&e,cw,constant(1u)),unmask_i=not(&e,im);pl_operand suppress=bit_and(&e,unmask_i,ie);
    pl_operand raised=binary(&e,PL_OPCODE_LANE64_SHL,de,constant(1u));raised=bit_or(&e,raised,ie);
    /* Register-source underflow precedes destination overflow: when both
     * are empty/full, IE/SF is set but C1 describes underflow, not overflow. */
    pl_operand source_present=not(&e,source_empty),overflow=bit_and(&e,full,source_present);
    pl_operand stack=binary(&e,PL_OPCODE_LANE64_SHL,stack_fault,constant(6u)),c1=binary(&e,PL_OPCODE_LANE64_SHL,overflow,constant(9u));raised=bit_or(&e,raised,stack);raised=bit_or(&e,raised,c1);
    pl_operand no_write=binary(&e,PL_OPCODE_LANE64_SHL,suppress,constant(16u)),tag_word=binary(&e,PL_OPCODE_LANE64_SHL,tag,constant(18u));
    pl_operand outcome=bit_or(&e,raised,no_write);outcome=bit_or(&e,outcome,tag_word);
    raw.locals[0]=sig;raw.locals[1]=se;raw.locals[2]=outcome;raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};raw.locals[4]=(pl_operand){PL_OPERAND_LOCAL,4u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_memory_relation_plan(pl_u32 bits,pl_u32 integer,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out||integer>1u||(integer?(bits!=16u&&bits!=32u):(bits!=32u&&bits!=64u)))return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,PL_X86_X87_MEMORY_RELATION_MAX_NODES,640u,0u,5u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},sa={PL_OPERAND_LOCAL,1u},input={PL_OPERAND_LOCAL,2u},empty={PL_OPERAND_LOCAL,4u};
    pl_operand sig,se,denormal=constant(0u);
    if(integer){integer_expression value=integer_value(&e,bits,input);sig=value.sig;se=value.se;}
    else{ieee_expression value=ieee_value(&e,bits,input);sig=value.sig;se=value.se;denormal=bit_and(&e,value.classes,constant(1u));}
    relation_expression value=x87_relation(&e,1u,a,sa,sig,se,empty,denormal);
    raw.locals[0]=value.relation;raw.locals[1]=value.raised;raw.locals[2]=value.empty;
    raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};raw.locals[4]=empty;
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
