#include "x87-expression.h"
typedef struct {pl_operand high,low;} wide_word;
static wide_word square(expression *e,pl_operand q)
{
    pl_operand a=bit_and(e,q,constant(0xffffffffu)),b=shift(e,q,32u);
    pl_operand aa=binary(e,PL_OPCODE_MULR,a,a),ab=binary(e,PL_OPCODE_MULR,a,b),bb=binary(e,PL_OPCODE_MULR,b,b);
    pl_operand cross=binary(e,PL_OPCODE_LANE64_SHL,ab,constant(33u)),low=binary(e,89u,aa,cross);
    pl_operand carry=compare(e,low,aa,2u),upper=shift(e,ab,31u),high=binary(e,89u,bb,upper);high=binary(e,89u,high,carry);
    return(wide_word){high,low};
}
radical_expression unsigned_radical_value(expression *e,pl_operand sig,pl_operand parity)
{
    // Numeric S is normalized, so 2^126 <= N < 2^128. Complete the high
    // bit to keep every unreachable special-value arm total as well.
    sig=bit_or(e,sig,constant(0x8000000000000000ull));
    pl_operand high=shift(e,sig,1u);high=select(e,sig,high,parity);
    pl_operand low=binary(e,PL_OPCODE_LANE64_SHL,sig,constant(63u));low=select(e,constant(0u),low,parity);
    pl_operand q=constant(~0ull);
    // Integer Newton from the upper endpoint. The relative-error recurrence
    // d' = d*d/(2*(1+d)), d<=1, bounds step six below 2^-99. Integer
    // flooring cannot cross floor(root). Thus q is floor(root) or +1.
    // The sole overflowing quotient already has floor(root)==UINT64_MAX.
    for(pl_u32 step=0u;step<6u;++step){quotient_expression divided=unsigned_divide_value(e,high,low,q);
        pl_operand t=select(e,constant(~0ull),divided.quotient,divided.invalid);
        pl_operand half_q=shift(e,q,1u),half_t=shift(e,t,1u),sum=binary(e,89u,half_q,half_t);
        pl_operand odd=bit_and(e,q,t);odd=bit_and(e,odd,constant(1u));q=binary(e,89u,sum,odd);
        q=bit_or(e,q,constant(0x8000000000000000ull));}
    wide_word squared=square(e,q);pl_operand same_high=equal(e,high,squared.high),over_low=compare(e,low,squared.low,2u);
    pl_operand above=bit_and(e,same_high,over_low),over_high=compare(e,high,squared.high,2u);above=bit_or(e,above,over_high);
    q=binary(e,96u,q,above);squared=square(e,q);
    pl_operand exact_high=equal(e,high,squared.high),exact_low=equal(e,low,squared.low),exact=bit_and(e,exact_high,exact_low);
    pl_operand remainder_low=binary(e,96u,low,squared.low),borrow=compare(e,low,squared.low,2u);
    pl_operand remainder_high=binary(e,96u,high,squared.high);remainder_high=binary(e,96u,remainder_high,borrow);
    // (q+1/2)^2=q^2+q+1/4. N is integral, so a 64-bit-significand
    // nearest increment needs precisely N-q^2>q; an exact half is impossible.
    pl_operand large_remainder=not(e,equal(e,remainder_high,constant(0u))),above_half=compare(e,q,remainder_low,2u);
    above_half=bit_or(e,above_half,large_remainder);return(radical_expression){q,exact,above_half};
}
