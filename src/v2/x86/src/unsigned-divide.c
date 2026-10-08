#include <x86/semantics.h>
#include "x87-expression.h"
/* Two normalized base-2^32 digits. Quotient estimates use one-word unsigned
 * division; each estimate needs at most two corrections. Everything else
 * is modular word arithmetic, with explicit guards for zero shifts/inputs. */
static pl_operand add(expression *e,pl_operand a,pl_operand b){return binary(e,89u,a,b);}
static pl_operand sub(expression *e,pl_operand a,pl_operand b){return binary(e,96u,a,b);}
static pl_operand mul(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_MULR,a,b);}
static pl_operand shl(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_LANE64_SHL,a,b);}
static pl_operand less(expression *e,pl_operand a,pl_operand b){return compare(e,a,b,2u);}
static pl_operand quotient(expression *e,pl_operand a,pl_operand b)
{
    pl_operand args[]={constant(0u),a,b,constant(64u)},value=node(e,PL_OPCODE_X86_DIVIDE,args,4u);
    return(pl_operand){PL_OPERAND_PROJECTION,value.value<<8u};
}
static pl_operand digit(expression *e,pl_operand high,pl_operand low,pl_operand dhi,pl_operand dlo)
{
    pl_operand q=quotient(e,high,dhi),product=mul(e,q,dhi),r=sub(e,high,product);
    for(pl_u32 correction=0u;correction<2u;++correction){
        pl_operand over=less(e,q,constant(1ull<<32u));over=not(e,over);
        pl_operand left=mul(e,q,dlo),right=shl(e,r,constant(32u));right=add(e,right,low);
        pl_operand too_big=less(e,right,left),in_word=less(e,r,constant(1ull<<32u));
        pl_operand adjust=bit_or(e,over,too_big);adjust=bit_and(e,adjust,in_word);
        q=sub(e,q,adjust);product=mul(e,adjust,dhi);r=add(e,r,product);
    }
    return q;
}
quotient_expression unsigned_divide_value(expression *builder,pl_operand h,pl_operand l,pl_operand d)
{
    expression e=*builder;
    pl_operand valid=less(&e,h,d),error=not(&e,valid);
    /* H<D also proves D!=0. Safe substitutes make all invalid input graphs
     * total; no engine divide-by-zero or signed-overflow trap is possible. */
    d=select(&e,d,constant(1u),valid);h=select(&e,h,constant(0u),valid);l=select(&e,l,constant(0u),valid);
    pl_operand leading=leading_zeros(&e,d),back=sub(&e,constant(64u),leading),tail=binary(&e,PL_OPCODE_LANE64_SHR,l,back);
    pl_operand no_shift=equal(&e,leading,constant(0u));tail=select(&e,constant(0u),tail,no_shift);
    h=shl(&e,h,leading);h=bit_or(&e,h,tail);l=shl(&e,l,leading);d=shl(&e,d,leading);
    pl_operand dhi=shift(&e,d,32u),dlo=bit_and(&e,d,constant(0xffffffffu));
    pl_operand lhi=shift(&e,l,32u),llo=bit_and(&e,l,constant(0xffffffffu));
    pl_operand qhi=digit(&e,h,lhi,dhi,dlo),middle=shl(&e,h,constant(32u));middle=add(&e,middle,lhi);
    pl_operand product=mul(&e,qhi,d);middle=sub(&e,middle,product);
    pl_operand qlo=digit(&e,middle,llo,dhi,dlo),remainder=shl(&e,middle,constant(32u));remainder=add(&e,remainder,llo);
    product=mul(&e,qlo,d);remainder=sub(&e,remainder,product);remainder=binary(&e,PL_OPCODE_LANE64_SHR,remainder,leading);
    pl_operand result=shl(&e,qhi,constant(32u));result=bit_or(&e,result,qlo);
    result=select(&e,result,constant(0u),valid);remainder=select(&e,remainder,constant(0u),valid);
    *builder=e;return(quotient_expression){result,remainder,error};
}
int pl_x86_unsigned_divide_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,160u,640u,0u,5u))return PL_ERROR_ARENA;
    quotient_expression result=unsigned_divide_value(&e,(pl_operand){PL_OPERAND_LOCAL,0u},
        (pl_operand){PL_OPERAND_LOCAL,1u},(pl_operand){PL_OPERAND_LOCAL,2u});
    raw.locals[0]=result.quotient;raw.locals[1]=result.remainder;raw.locals[2]=result.invalid;
    raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};raw.locals[4]=(pl_operand){PL_OPERAND_LOCAL,4u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
