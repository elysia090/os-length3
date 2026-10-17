#ifndef X86_X87_EXPRESSION_H
#define X86_X87_EXPRESSION_H
#include <x86/ssa-build.h>
/* Sequenced construction events: callers never nest mutating builder calls
 * in C function arguments. Pure arithmetic is shared before compaction. */
typedef struct {pl_builder builder;int failed;} expression;
static inline pl_operand constant(pl_u64 v){return(pl_operand){PL_OPERAND_CONST,v};}
static inline int same(pl_operand a,pl_operand b){return a.kind==b.kind&&a.value==b.value;}
static inline pl_operand node(expression *e,pl_u32 opcode,const pl_operand *args,pl_u32 n)
{
    pl_u32 value=pl_emit_shared(&e->builder,opcode,args,n);if(!value)e->failed=1;
    return(pl_operand){PL_OPERAND_NODE,value};
}
static inline pl_operand binary(expression *e,pl_u32 op,pl_operand a,pl_operand b)
{
    if(op==87u){if(a.kind==PL_OPERAND_CONST&&!a.value)return a;if(b.kind==PL_OPERAND_CONST&&!b.value)return b;if(same(a,b))return a;}
    if(op==88u){if(a.kind==PL_OPERAND_CONST&&!a.value)return b;if(b.kind==PL_OPERAND_CONST&&!b.value)return a;if(same(a,b))return a;}
    if(a.kind==PL_OPERAND_CONST&&b.kind==PL_OPERAND_CONST){
        if(op==87u)return constant(a.value&b.value);
        if(op==88u)return constant(a.value|b.value);
        if(op==PL_OPCODE_LANE64_SHL)return constant(a.value<<(b.value&63u));
        if(op==PL_OPCODE_LANE64_SHR)return constant(a.value>>(b.value&63u));}
    pl_operand args[]={a,b};return node(e,op,args,2u);
}
static inline pl_operand bit_and(expression *e,pl_operand a,pl_operand b){return binary(e,87u,a,b);}
static inline pl_operand bit_or(expression *e,pl_operand a,pl_operand b){return binary(e,88u,a,b);}
static inline pl_operand shift(expression *e,pl_operand a,pl_u32 n){return binary(e,PL_OPCODE_LANE64_SHR,a,constant(n));}
static inline pl_operand compare(expression *e,pl_operand a,pl_operand b,pl_u32 cc)
{
    if(same(a,b))return constant(cc==4u);
    if(a.kind==PL_OPERAND_CONST&&b.kind==PL_OPERAND_CONST)return constant(cc==4u?a.value==b.value:a.value<b.value);
    pl_operand args[]={constant(0u),a,b,constant(64u|(3u<<8u))},v=node(e,PL_OPCODE_X86_COMPARE,args,4u);
    return(pl_operand){PL_OPERAND_PROJECTION,(v.value<<8u)|cc};
}
static inline pl_operand equal(expression *e,pl_operand a,pl_operand b){return compare(e,a,b,4u);}
static inline pl_operand not(expression *e,pl_operand a){return equal(e,a,constant(0u));}
static inline pl_operand select(expression *e,pl_operand yes,pl_operand no,pl_operand predicate)
{
    if(same(yes,no))return yes;
    if(predicate.kind==PL_OPERAND_CONST)return predicate.value?yes:no;
    pl_operand args[]={yes,no,predicate};return node(e,PL_OPCODE_LANE64_SELECT,args,3u);
}
static inline pl_operand leading_zeros(expression *e,pl_operand a)
{
    pl_operand args[]={constant(0u),a,constant(64u),constant(~0ull)};
    pl_operand scan=node(e,PL_OPCODE_X86_BIT_SUMMARY,args,4u);
    pl_operand index={PL_OPERAND_PROJECTION,(scan.value<<8u)|16u};
    return binary(e,96u,constant(63u),index);
}
typedef struct {pl_operand sig,se,zero,sign,leading;} integer_expression;
typedef struct {pl_operand sig,se,classes;} ieee_expression;
ieee_expression ieee_value(expression *e,pl_u32 bits,pl_operand input);
typedef struct {pl_operand quotient,remainder,invalid;} quotient_expression;
quotient_expression unsigned_divide_value(expression *e,pl_operand high,pl_operand low,pl_operand divisor);
typedef struct {pl_operand root,exact,above_half;} radical_expression;
radical_expression unsigned_radical_value(expression *e,pl_operand normalized_significand,pl_operand exponent_parity);
typedef struct {pl_operand relation,raised,empty;} relation_expression;
relation_expression x87_relation(expression *e,pl_u32 ordered,pl_operand a,pl_operand sa,
    pl_operand b,pl_operand sb,pl_operand empty,pl_operand source_denormal);
static inline integer_expression integer_value(expression *e,pl_u32 bits,pl_operand x)
{
    if(bits<64u){x=binary(e,PL_OPCODE_LANE64_SHL,x,constant(64u-bits));x=binary(e,PL_OPCODE_LANE64_SAR,x,constant(64u-bits));}
    pl_operand sign=shift(e,x,63u),negative=binary(e,96u,constant(0u),sign);
    pl_operand magnitude=binary(e,86u,x,negative);magnitude=binary(e,89u,magnitude,sign);
    /* The BSR zero representative is -1: zero has leading count 64. */
    pl_operand leading=leading_zeros(e,magnitude);
    pl_operand sig=binary(e,PL_OPCODE_LANE64_SHL,magnitude,leading);
    pl_operand exponent=binary(e,96u,constant(16383u+63u),leading);
    pl_operand zero=equal(e,magnitude,constant(0u));exponent=select(e,constant(0u),exponent,zero);
    pl_operand sign_word=binary(e,PL_OPCODE_LANE64_SHL,sign,constant(15u));
    pl_operand se=bit_or(e,sign_word,exponent);return(integer_expression){sig,se,zero,sign,leading};
}
#endif
