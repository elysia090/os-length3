#ifndef X86_ANGLE_H
#define X86_ANGLE_H
#include "compensated.h"

typedef struct {pl_operand high,low;} wide_product;
typedef struct {pl_operand quadrant,magnitude_high,magnitude_low,negative;compensated value;} reduced_angle;

/* Four base-2^32 products, with no discarded carry or host wide integer. */
static inline wide_product multiply_wide(expression *e,pl_operand a,pl_operand b)
{
    pl_operand a0=bit_and(e,a,constant(0xffffffffu)),a1=shift(e,a,32u);
    pl_operand b0=bit_and(e,b,constant(0xffffffffu)),b1=shift(e,b,32u);
    pl_operand p00=binary(e,PL_OPCODE_MULR,a0,b0),p01=binary(e,PL_OPCODE_MULR,a0,b1);
    pl_operand p10=binary(e,PL_OPCODE_MULR,a1,b0),p11=binary(e,PL_OPCODE_MULR,a1,b1);
    pl_operand middle=shift(e,p00,32u),part=bit_and(e,p01,constant(0xffffffffu));
    middle=binary(e,89u,middle,part);part=bit_and(e,p10,constant(0xffffffffu));middle=binary(e,89u,middle,part);
    pl_operand high=binary(e,89u,p11,shift(e,p01,32u));part=shift(e,p10,32u);high=binary(e,89u,high,part);
    part=shift(e,middle,32u);high=binary(e,89u,high,part);
    pl_operand low=binary(e,PL_OPCODE_LANE64_SHL,middle,constant(32u));part=bit_and(e,p00,constant(0xffffffffu));
    low=bit_or(e,low,part);return(wide_product){high,low};
}
static inline pl_operand add_with_carry(expression *e,pl_operand a,pl_operand b,pl_operand *carry)
{
    pl_operand sum=binary(e,89u,a,b),overflow=compare(e,sum,a,2u);*carry=binary(e,89u,*carry,overflow);return sum;
}

/* |x| = significand * 2^(exponent-63), -1 <= exponent <= 62.
 * Pi = C90FDAA22168C234C * 2^-66 is the architectural 66-bit constant.
 * P = Pi*2^64; M=floor(2^192/P). For N<2^128, floor(N*M/2^192)
 * underestimates floor(N/P) by at most one. One exact residual correction
 * therefore suffices. Nearest reduction has no tie: P is odd.
 * Inputs outside the domain are classified before this pure projection is
 * published; the projection itself uses total, bounded word operations. */
static inline reduced_angle reduce_angle(expression *e,pl_operand significand,pl_operand exponent)
{
    const pl_u64 p_low=0x243f6a8885a308d3ull,m_low=0x000315e206d13b5full,m_high=0x517cc1b727220a95ull;
    pl_operand distance=binary(e,89u,exponent,constant(2u));
    pl_operand n_low=binary(e,PL_OPCODE_LANE64_SHL,significand,distance);
    pl_operand back=binary(e,96u,constant(64u),distance),n_high=binary(e,PL_OPCODE_LANE64_SHR,significand,back);
    pl_operand full=equal(e,distance,constant(64u));n_low=select(e,constant(0u),n_low,full);
    wide_product p00=multiply_wide(e,n_low,constant(m_low)),p01=multiply_wide(e,n_low,constant(m_high));
    wide_product p10=multiply_wide(e,n_high,constant(m_low)),p11=multiply_wide(e,n_high,constant(m_high));
    pl_operand carry=constant(0u),column=add_with_carry(e,p00.high,p01.low,&carry);
    column=add_with_carry(e,column,p10.low,&carry);(void)column;
    pl_operand next_carry=constant(0u);column=add_with_carry(e,p01.high,p10.high,&next_carry);
    column=add_with_carry(e,column,p11.low,&next_carry);column=add_with_carry(e,column,carry,&next_carry);(void)column;
    pl_operand quotient=binary(e,89u,p11.high,next_carry);
    wide_product product=multiply_wide(e,quotient,constant(p_low));
    pl_operand upper=binary(e,PL_OPCODE_MULR,quotient,constant(3u));product.high=binary(e,89u,product.high,upper);
    pl_operand borrow=compare(e,n_low,product.low,2u),low=binary(e,96u,n_low,product.low);
    pl_operand high=binary(e,96u,n_high,product.high);high=binary(e,96u,high,borrow);
    pl_operand high_greater=compare(e,constant(3u),high,2u),high_equal=equal(e,high,constant(3u));
    pl_operand low_ge=not(e,compare(e,low,constant(p_low),2u)),correct=bit_and(e,high_equal,low_ge);correct=bit_or(e,correct,high_greater);
    pl_operand corrected_low=binary(e,96u,low,constant(p_low)),corrected_high=binary(e,96u,high,constant(3u));
    borrow=compare(e,low,constant(p_low),2u);corrected_high=binary(e,96u,corrected_high,borrow);
    low=select(e,corrected_low,low,correct);high=select(e,corrected_high,high,correct);quotient=binary(e,89u,quotient,correct);
    high_greater=compare(e,constant(1u),high,2u);high_equal=equal(e,high,constant(1u));
    pl_operand low_greater=compare(e,constant(0x921fb54442d18469ull),low,2u),reverse=bit_and(e,high_equal,low_greater);
    reverse=bit_or(e,reverse,high_greater);quotient=binary(e,89u,quotient,reverse);
    borrow=compare(e,constant(p_low),low,2u);corrected_low=binary(e,96u,constant(p_low),low);
    corrected_high=binary(e,96u,constant(3u),high);corrected_high=binary(e,96u,corrected_high,borrow);
    low=select(e,corrected_low,low,reverse);high=select(e,corrected_high,high,reverse);
    pl_operand upper32=shift(e,low,32u),lower32=bit_and(e,low,constant(0xffffffffu));
    pl_operand a=binary(e,PL_OPCODE_IEEE64_FROM_UNSIGNED,high,constant(0u));a=fp_multiply(e,a,constant(0x3fe0000000000000ull));
    pl_operand b=binary(e,PL_OPCODE_IEEE64_FROM_UNSIGNED,upper32,constant(0u));b=fp_multiply(e,b,constant(0x3de0000000000000ull));
    pl_operand c=binary(e,PL_OPCODE_IEEE64_FROM_UNSIGNED,lower32,constant(0u));c=fp_multiply(e,c,constant(0x3be0000000000000ull));
    compensated value=two_sum(e,a,b),tail={c,constant(0u)};value=compensated_add(e,value,tail);
    compensated negative=compensated_negate(e,value);value.high=select(e,negative.high,value.high,reverse);value.low=select(e,negative.low,value.low,reverse);
    pl_operand quadrant=bit_and(e,quotient,constant(3u));return(reduced_angle){quadrant,high,low,reverse,value};
}
#endif
