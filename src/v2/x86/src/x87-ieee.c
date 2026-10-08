#include <x86/semantics.h>
#include "x87-expression.h"
typedef struct {pl_operand sig,se,classes;} ieee_expression;
/* Raw binary interchange -> exact extended fields. NaN signaling/payload
 * and source denormal class survive; consuming operations own exceptions. */
static ieee_expression ieee_value(expression *e,pl_u32 bits,pl_operand x)
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
