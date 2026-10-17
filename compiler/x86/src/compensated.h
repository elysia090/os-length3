#ifndef X86_COMPENSATED_H
#define X86_COMPENSATED_H
#include "x87-expression.h"
/* A normalized mantissa is two nonoverlapping nearest-even binary64 lanes.
 * An independent integer exponent keeps every internal scale representable.
 * These construction routines emit the common SSA, never a runtime helper. */
typedef struct {pl_operand high,low;} compensated;
/* |t|<=0.2; same rational fraction as atanh, with z=-t*t. */
compensated compensated_inverse_tangent(expression *e,compensated t);
static inline pl_operand fp_add(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_IEEE64_ADD,a,b);}
static inline pl_operand fp_subtract(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_IEEE64_SUBTRACT,a,b);}
static inline pl_operand fp_multiply(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_IEEE64_MULTIPLY,a,b);}
static inline pl_operand fp_divide(expression *e,pl_operand a,pl_operand b){return binary(e,PL_OPCODE_IEEE64_DIVIDE,a,b);}
static inline compensated two_sum(expression *e,pl_operand a,pl_operand b)
{
    pl_operand sum=fp_add(e,a,b),b_part=fp_subtract(e,sum,a),a_part=fp_subtract(e,sum,b_part);
    pl_operand a_error=fp_subtract(e,a,a_part),b_error=fp_subtract(e,b,b_part),error=fp_add(e,a_error,b_error);
    return(compensated){sum,error};
}
static inline compensated compensated_add(expression *e,compensated a,compensated b)
{
    compensated sum=two_sum(e,a.high,b.high);pl_operand tail=fp_add(e,a.low,b.low);tail=fp_add(e,sum.low,tail);
    return two_sum(e,sum.high,tail);
}
static inline compensated compensated_negate(expression *e,compensated a)
{
    pl_operand sign=constant(0x8000000000000000ull);a.high=binary(e,86u,a.high,sign);a.low=binary(e,86u,a.low,sign);return a;
}
static inline compensated compensated_multiply(expression *e,compensated a,compensated b)
{
    // Dekker splitting: normalized high lanes do not overflow the splitter.
    // Every discarded cross term is retained before the final renormalization.
    pl_operand splitter=constant(0x41a0000002000000ull),ac=fp_multiply(e,a.high,splitter),bc=fp_multiply(e,b.high,splitter);
    pl_operand at=fp_subtract(e,ac,a.high),bt=fp_subtract(e,bc,b.high),ah=fp_subtract(e,ac,at),bh=fp_subtract(e,bc,bt);
    pl_operand al=fp_subtract(e,a.high,ah),bl=fp_subtract(e,b.high,bh),product=fp_multiply(e,a.high,b.high);
    pl_operand error=fp_multiply(e,ah,bh);error=fp_subtract(e,error,product);
    pl_operand term=fp_multiply(e,ah,bl);error=fp_add(e,error,term);term=fp_multiply(e,al,bh);error=fp_add(e,error,term);
    term=fp_multiply(e,al,bl);error=fp_add(e,error,term);term=fp_multiply(e,a.high,b.low);error=fp_add(e,error,term);
    term=fp_multiply(e,a.low,b.high);error=fp_add(e,error,term);term=fp_multiply(e,a.low,b.low);error=fp_add(e,error,term);
    return two_sum(e,product,error);
}
static inline compensated compensated_divide(expression *e,compensated a,compensated b)
{
    pl_operand q=fp_divide(e,a.high,b.high);compensated first={q,constant(0u)},product=compensated_multiply(e,first,b);
    product=compensated_negate(e,product);compensated residual=compensated_add(e,a,product);
    pl_operand rest=fp_add(e,residual.high,residual.low),low=fp_divide(e,rest,b.high);return two_sum(e,q,low);
}
static inline compensated compensated_significand(expression *e,pl_operand sig)
{
    pl_operand hi=shift(e,sig,32u),lo=bit_and(e,sig,constant(0xffffffffu));
    hi=binary(e,PL_OPCODE_IEEE64_FROM_UNSIGNED,hi,constant(0u));lo=binary(e,PL_OPCODE_IEEE64_FROM_UNSIGNED,lo,constant(0u));
    hi=fp_multiply(e,hi,constant(0x3e00000000000000ull));lo=fp_multiply(e,lo,constant(0x3c00000000000000ull));
    return two_sum(e,hi,lo);
}
#endif
