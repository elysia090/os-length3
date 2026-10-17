#include <x86/semantics.h>
#include "compensated.h"
static compensated choose(expression *e,compensated yes,compensated no,pl_operand predicate)
{return(compensated){select(e,yes.high,no.high,predicate),select(e,yes.low,no.low,predicate)};}
int pl_x86_x87_arctangent_supported(const pl_x86_instruction *i)
{
    if(!i||i->machine_argument!=(58u|(0x1f3ull<<16u)|(3ull<<44u)))return 0;
    pl_x86_instruction equivalent=*i;equivalent.machine_argument=48u|(0x1ffull<<16u);return pl_x86_x87_trig_supported(&equivalent);
}
int pl_x86_x87_arctangent_prepare_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,320u,800u,0u,9u))return PL_ERROR_ARENA;
    pl_operand x={PL_OPERAND_LOCAL,0u},xs={PL_OPERAND_LOCAL,1u},y={PL_OPERAND_LOCAL,2u},ys={PL_OPERAND_LOCAL,3u};
    pl_operand xl=leading_zeros(&e,x),yl=leading_zeros(&e,y),xn=binary(&e,PL_OPCODE_LANE64_SHL,x,xl),yn=binary(&e,PL_OPCODE_LANE64_SHL,y,yl);
    xn=bit_or(&e,xn,constant(0x8000000000000000ull));yn=bit_or(&e,yn,constant(0x8000000000000000ull));
    pl_operand xe=bit_and(&e,xs,constant(32767u)),ye=bit_and(&e,ys,constant(32767u));
    xe=select(&e,constant(1u),xe,equal(&e,xe,constant(0u)));ye=select(&e,constant(1u),ye,equal(&e,ye,constant(0u)));
    xe=binary(&e,89u,xe,constant(128u));ye=binary(&e,89u,ye,constant(128u));xe=binary(&e,96u,xe,xl);ye=binary(&e,96u,ye,yl);
    pl_operand bigger=compare(&e,xe,ye,2u),same_exp=equal(&e,xe,ye),same_larger=compare(&e,xn,yn,2u);
    same_larger=bit_and(&e,same_larger,same_exp);bigger=bit_or(&e,bigger,same_larger);
    pl_operand small_sig=select(&e,xn,yn,bigger),large_sig=select(&e,yn,xn,bigger),small_exp=select(&e,xe,ye,bigger),large_exp=select(&e,ye,xe,bigger);
    pl_operand distance=binary(&e,96u,large_exp,small_exp),tiny=compare(&e,constant(110u),distance,2u);
    compensated a=compensated_significand(&e,small_sig),b=compensated_significand(&e,large_sig),ratio=compensated_divide(&e,a,b);
    pl_operand used=select(&e,constant(110u),distance,tiny),scale_exp=binary(&e,96u,constant(1023u),used),scale=binary(&e,PL_OPCODE_LANE64_SHL,scale_exp,constant(52u));
    compensated r={fp_multiply(&e,ratio.high,scale),fp_multiply(&e,ratio.low,scale)};
    // Exact dyadic cuts 51/256 and 171/256 make the three Mobius reductions
    // stay inside |u|<0.2; no transcendental comparison or scan is required.
    pl_operand middle=compare(&e,constant(0x3fc9800000000000ull),r.high,2u),upper=compare(&e,constant(0x3fe5600000000000ull),r.high,2u);
    const compensated zero={constant(0u),constant(0u)},one={constant(0x3ff0000000000000ull),constant(0u)};
    const compensated tangent_pi8={constant(0x3fda827999fcef32ull),constant(0x3c708b2fb1366ea9ull)};
    const compensated pi8={constant(0x3fd921fb54442d18ull),constant(0x3c71a62633145c07ull)},pi4={constant(0x3fe921fb54442d18ull),constant(0x3c81a62633145c07ull)};
    compensated center=choose(&e,tangent_pi8,zero,middle);center=choose(&e,one,center,upper);
    compensated base=choose(&e,pi8,zero,middle);base=choose(&e,pi4,base,upper);
    compensated negative=compensated_negate(&e,center),numerator=compensated_add(&e,r,negative),denominator=compensated_multiply(&e,r,center);
    denominator=compensated_add(&e,denominator,one);compensated u=compensated_divide(&e,numerator,denominator);
    pl_operand offset=binary(&e,96u,constant(0u),distance),flags=bit_or(&e,bigger,binary(&e,PL_OPCODE_LANE64_SHL,tiny,constant(1u)));
    raw.locals[0]=u.high;raw.locals[1]=u.low;raw.locals[2]=base.high;raw.locals[3]=base.low;
    raw.locals[4]=ratio.high;raw.locals[5]=ratio.low;raw.locals[6]=offset;raw.locals[7]=flags;raw.locals[8]=(pl_operand){PL_OPERAND_LOCAL,8u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,1u,1u,1u,1u,1u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_arctangent_value_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,672u,1472u,0u,4u))return PL_ERROR_ARENA;
    compensated u={{PL_OPERAND_LOCAL,0u},{PL_OPERAND_LOCAL,1u}},base={{PL_OPERAND_LOCAL,2u},{PL_OPERAND_LOCAL,3u}};
    compensated r=compensated_inverse_tangent(&e,u);r=compensated_add(&e,r,base);
    raw.locals[0]=r.high;raw.locals[1]=r.low;raw.locals[2]=(pl_operand){PL_OPERAND_LOCAL,2u};raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_arctangent_finish_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,160u,416u,0u,9u))return PL_ERROR_ARENA;
    compensated r={{PL_OPERAND_LOCAL,0u},{PL_OPERAND_LOCAL,1u}},ratio={{PL_OPERAND_LOCAL,6u},{PL_OPERAND_LOCAL,7u}};
    pl_operand x={PL_OPERAND_LOCAL,2u},xs={PL_OPERAND_LOCAL,3u},y={PL_OPERAND_LOCAL,4u},ys={PL_OPERAND_LOCAL,5u},packed={PL_OPERAND_LOCAL,8u};
    // packed: low16 exponent distance, bit16 swap, bit17 tiny. Distance is
    // at most32766+63. It is a transient value, not an executable descriptor.
    pl_operand bigger=bit_and(&e,shift(&e,packed,16u),constant(1u)),tiny=bit_and(&e,shift(&e,packed,17u),constant(1u));
    pl_operand distance=bit_and(&e,packed,constant(65535u)),offset=binary(&e,96u,constant(0u),distance);
    const compensated zero={constant(0u),constant(0u)},pi={constant(0x400921fb54442d18ull),constant(0x3ca1a62633145c07ull)},half_pi={constant(0x3ff921fb54442d18ull),constant(0x3c91a62633145c07ull)};
    compensated negative=compensated_negate(&e,r),complement=compensated_add(&e,half_pi,negative);r=choose(&e,complement,r,bigger);
    pl_operand xsign=shift(&e,xs,15u),ysign=shift(&e,ys,15u);negative=compensated_negate(&e,r);complement=compensated_add(&e,pi,negative);r=choose(&e,complement,r,xsign);
    pl_operand small_angle=bit_and(&e,tiny,not(&e,bigger));small_angle=bit_and(&e,small_angle,not(&e,xsign));
    compensated large_angle=choose(&e,half_pi,pi,bigger);r=choose(&e,large_angle,r,tiny);r=choose(&e,ratio,r,small_angle);offset=select(&e,offset,constant(0u),small_angle);
    pl_operand xe=bit_and(&e,xs,constant(32767u)),ye=bit_and(&e,ys,constant(32767u));
    pl_operand xinf=bit_and(&e,equal(&e,xe,constant(32767u)),equal(&e,x,constant(0x8000000000000000ull)));
    pl_operand yinf=bit_and(&e,equal(&e,ye,constant(32767u)),equal(&e,y,constant(0x8000000000000000ull)));
    pl_operand xzero=bit_and(&e,equal(&e,xe,constant(0u)),equal(&e,x,constant(0u))),yzero=bit_and(&e,equal(&e,ye,constant(0u)),equal(&e,y,constant(0u)));
    pl_operand y_axis=bit_or(&e,xzero,yinf);y_axis=bit_and(&e,y_axis,not(&e,xinf));r=choose(&e,half_pi,r,y_axis);
    pl_operand x_axis=bit_and(&e,xinf,not(&e,yinf));x_axis=bit_or(&e,x_axis,yzero);compensated x_value=choose(&e,pi,zero,xsign);r=choose(&e,x_value,r,x_axis);
    offset=select(&e,constant(0u),offset,bit_or(&e,x_axis,y_axis));pl_operand sign_word=binary(&e,PL_OPCODE_LANE64_SHL,ysign,constant(63u));
    r.high=binary(&e,86u,r.high,sign_word);r.low=binary(&e,86u,r.low,sign_word);
    raw.locals[0]=r.high;raw.locals[1]=r.low;raw.locals[2]=offset;for(pl_u32 n=3u;n<9u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u,0u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
