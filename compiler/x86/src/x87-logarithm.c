#include <x86/semantics.h>
#include "compensated.h"
typedef struct {pl_u64 high,low;} coefficient;
typedef struct {pl_operand exponent,zero,denormal,nan,infinite,signaling,unsupported,sign;} value_class;
static value_class classify(expression *e,pl_operand sig,pl_operand se)
{
    pl_operand exponent=bit_and(e,se,constant(32767u)),zero_exp=equal(e,exponent,constant(0u)),zero_sig=equal(e,sig,constant(0u));
    pl_operand zero=bit_and(e,zero_exp,zero_sig),denormal=bit_and(e,zero_exp,not(e,zero_sig));
    pl_operand fraction=bit_and(e,sig,constant(0x7fffffffffffffffull)),full=equal(e,exponent,constant(32767u));
    pl_operand nan=bit_and(e,full,not(e,equal(e,fraction,constant(0u)))),infinite=bit_and(e,full,not(e,nan));
    pl_operand quiet=bit_and(e,shift(e,sig,62u),constant(1u)),signaling=bit_and(e,nan,not(e,quiet));
    pl_operand unsupported=bit_and(e,not(e,zero_exp),not(e,shift(e,sig,63u))),sign=shift(e,se,15u);
    return(value_class){exponent,zero,denormal,nan,infinite,signaling,unsupported,sign};
}
int pl_x86_x87_logarithm_supported(const pl_x86_instruction *i)
{
    if(!i||i->machine_argument!=(58u|(0x1f1ull<<16u)|(1ull<<44u)))return 0;
    pl_x86_instruction equivalent=*i;equivalent.machine_argument=48u|(0x1ffull<<16u);return pl_x86_x87_trig_supported(&equivalent);
}
int pl_x86_x87_logarithm_one_supported(const pl_x86_instruction *i)
{
    if(!i||i->machine_argument!=(58u|(0x1f9ull<<16u)|(2ull<<44u)))return 0;
    pl_x86_instruction equivalent=*i;equivalent.machine_argument=48u|(0x1ffull<<16u);return pl_x86_x87_trig_supported(&equivalent);
}
static int logarithm_result_plan(pl_u32 operation,pl_arena *arena,pl_plan *out)
{
    pl_u32 plus_one=operation==1u,arctangent=operation==2u;
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,256u,704u,0u,9u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},sa={PL_OPERAND_LOCAL,1u},b={PL_OPERAND_LOCAL,2u},sb={PL_OPERAND_LOCAL,3u};
    pl_operand cw={PL_OPERAND_LOCAL,4u},empty={PL_OPERAND_LOCAL,5u},sig={PL_OPERAND_LOCAL,6u},se={PL_OPERAND_LOCAL,7u},outcome={PL_OPERAND_LOCAL,8u};
    value_class x=classify(&e,a,sa),y=classify(&e,b,sb);pl_operand nan=bit_or(&e,x.nan,y.nan);
    pl_operand x_one=bit_and(&e,equal(&e,x.exponent,constant(16383u)),equal(&e,a,constant(0x8000000000000000ull)));
    pl_operand less_one=compare(&e,x.exponent,constant(16383u),2u);pl_operand sign=binary(&e,86u,less_one,y.sign);
    pl_operand negative_x=bit_and(&e,x.sign,not(&e,x.zero)),log_infinite=bit_or(&e,x.zero,x.infinite);
    if(plus_one){
        // |x| <= 1-sqrt(2)/2. The irrational boundary lies strictly between
        // adjacent extended significands: the floor is the largest admissible
        // coordinate. Outside the specified domain, the representative is a
        // floating invalid result, never a missing instruction or #UD.
        pl_operand larger_exp=compare(&e,constant(16381u),x.exponent,2u),same_exp=equal(&e,x.exponent,constant(16381u));
        pl_operand larger_sig=compare(&e,constant(0x95f619980c4336f7ull),a,2u);larger_sig=bit_and(&e,larger_sig,same_exp);
        negative_x=bit_or(&e,larger_exp,larger_sig);x_one=x.zero;less_one=x.sign;sign=binary(&e,86u,less_one,y.sign);log_infinite=constant(0u);
    }
    pl_operand conflict=bit_and(&e,y.zero,log_infinite),unit_infinite=bit_and(&e,x_one,y.infinite);conflict=bit_or(&e,conflict,unit_infinite);
    conflict=bit_or(&e,conflict,negative_x);conflict=bit_and(&e,conflict,not(&e,nan));
    pl_operand zero_angle=constant(0u);if(arctangent){
        conflict=constant(0u);log_infinite=constant(0u);sign=y.sign;
        pl_operand horizontal=bit_and(&e,x.infinite,not(&e,y.infinite));horizontal=bit_or(&e,horizontal,y.zero);
        zero_angle=bit_and(&e,horizontal,not(&e,x.sign));
    }
    pl_operand indefinite=bit_or(&e,x.unsupported,y.unsupported);indefinite=bit_or(&e,indefinite,empty);indefinite=bit_or(&e,indefinite,conflict);
    pl_operand signaling=bit_or(&e,x.signaling,y.signaling),invalid=bit_or(&e,indefinite,signaling);
    pl_operand ze=bit_and(&e,x.zero,not(&e,y.zero));ze=bit_and(&e,ze,not(&e,y.infinite));ze=bit_and(&e,ze,not(&e,invalid));ze=bit_and(&e,ze,not(&e,nan));
    if(plus_one||arctangent)ze=constant(0u);
    pl_operand priority=bit_or(&e,invalid,nan);priority=bit_or(&e,priority,ze);
    pl_operand de=bit_or(&e,x.denormal,y.denormal);de=bit_and(&e,de,not(&e,priority));
    pl_operand special=priority;if(!arctangent){special=bit_or(&e,special,x.infinite);special=bit_or(&e,special,y.infinite);}
    pl_operand zero=arctangent?zero_angle:bit_or(&e,x_one,y.zero);
    special=bit_or(&e,special,zero);pl_operand rounded=bit_and(&e,outcome,constant(0x238u));rounded=select(&e,constant(0u),rounded,special);
    pl_operand numeric_tiny=equal(&e,bit_and(&e,se,constant(32767u)),constant(0u));numeric_tiny=bit_and(&e,numeric_tiny,not(&e,special));
    rounded=bit_or(&e,rounded,binary(&e,PL_OPCODE_LANE64_SHL,numeric_tiny,constant(4u)));
    pl_operand precision=binary(&e,PL_OPCODE_LANE64_SHL,not(&e,special),constant(5u));rounded=bit_or(&e,rounded,precision);
    pl_operand suppress_i=bit_and(&e,invalid,not(&e,bit_and(&e,cw,constant(1u))));
    pl_operand suppress_d=bit_and(&e,de,not(&e,bit_and(&e,cw,constant(2u))));
    pl_operand suppress_z=bit_and(&e,ze,not(&e,bit_and(&e,cw,constant(4u))));pl_operand suppress=bit_or(&e,suppress_i,suppress_d);suppress=bit_or(&e,suppress,suppress_z);
    rounded=select(&e,constant(0u),rounded,suppress);
    pl_operand raised=bit_or(&e,invalid,binary(&e,PL_OPCODE_LANE64_SHL,de,constant(1u)));raised=bit_or(&e,raised,binary(&e,PL_OPCODE_LANE64_SHL,ze,constant(2u)));
    raised=bit_or(&e,raised,binary(&e,PL_OPCODE_LANE64_SHL,empty,constant(6u)));outcome=bit_or(&e,raised,rounded);
    pl_operand infinity=bit_or(&e,log_infinite,y.infinite),sign_word=binary(&e,PL_OPCODE_LANE64_SHL,sign,constant(15u));
    if(!arctangent){pl_operand inf_se=bit_or(&e,sign_word,constant(32767u));sig=select(&e,constant(0x8000000000000000ull),sig,infinity);se=select(&e,inf_se,se,infinity);}
    sig=select(&e,constant(0u),sig,zero);se=select(&e,sign_word,se,zero);
    pl_operand aq=bit_or(&e,a,constant(0x4000000000000000ull)),bq=bit_or(&e,b,constant(0x4000000000000000ull));
    pl_operand larger_a=compare(&e,bq,aq,2u),equal_payload=equal(&e,aq,bq),positive_tie=compare(&e,sa,sb,2u);
    positive_tie=bit_and(&e,positive_tie,equal_payload);larger_a=bit_or(&e,larger_a,positive_tie);
    pl_operand same_class=equal(&e,x.signaling,y.signaling),quiet_wins=bit_and(&e,y.signaling,not(&e,x.signaling));
    pl_operand choose_a=select(&e,larger_a,quiet_wins,same_class);choose_a=bit_or(&e,choose_a,not(&e,y.nan));choose_a=bit_and(&e,choose_a,x.nan);
    pl_operand nan_sig=select(&e,aq,bq,choose_a),nan_se=select(&e,sa,sb,choose_a);sig=select(&e,nan_sig,sig,nan);se=select(&e,nan_se,se,nan);
    sig=select(&e,constant(0xc000000000000000ull),sig,indefinite);se=select(&e,constant(65535u),se,indefinite);
    pl_operand result_exp=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,result_exp,constant(0u)),full_exp=equal(&e,result_exp,constant(32767u));
    pl_operand tag=select(&e,constant(2u),constant(0u),bit_or(&e,zero_exp,full_exp));pl_operand result_zero=bit_and(&e,zero_exp,equal(&e,sig,constant(0u)));
    tag=select(&e,constant(1u),tag,result_zero);outcome=bit_or(&e,outcome,binary(&e,PL_OPCODE_LANE64_SHL,tag,constant(18u)));
    outcome=bit_or(&e,outcome,binary(&e,PL_OPCODE_LANE64_SHL,suppress,constant(16u)));
    raw.locals[0]=sig;raw.locals[1]=se;raw.locals[2]=outcome;for(pl_u32 n=3u;n<9u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u,0u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_logarithm_result_plan(pl_arena *arena,pl_plan *out)
{return logarithm_result_plan(0u,arena,out);}
int pl_x86_x87_logarithm_one_result_plan(pl_arena *arena,pl_plan *out)
{return logarithm_result_plan(1u,arena,out);}
int pl_x86_x87_arctangent_result_plan(pl_arena *arena,pl_plan *out)
{return logarithm_result_plan(2u,arena,out);}
/* [6/6] Pade of atanh(t)/t, matching its first thirteen exact coefficients
 * 1/(2k+1). Centering m at one bounds |t|=(m-1)/(m+1) by
 * (sqrt(2)-1)/(sqrt(2)+1). No subtraction of two nearly equal logarithms. */
static const coefficient numerator[]={
    {0x3ff0000000000000ull,0u},{0xc0064b17e4b17e4bull,0xbc87e4b17e4b17e5ull},
    {0x40071f9c457433a5ull,0x3c967bc53b36c301ull},{0xbff5e8d2c0d13a0bull,0xbc8594900c02160full},
    {0x3fd28e63d5044163ull,0xbc5980fc7849cd7dull},{0xbf96a985e83e9b64ull,0x3bf5bad3b1bca8afull},
    {0x3f319a0cf8035f43ull,0xbbc8201d211bafffull}
};
static const coefficient denominator[]={
    {0x3ff0000000000000ull,0u},{0xc008f5c28f5c28f6ull,0x3c9eb851eb851eb8ull},
    {0x400dd7ee30f9525dull,0x3cafb8c3e54975fcull},{0xc0010dacae4553a3ull,0xbc91f7bb4f2f6244ull},
    {0x3fe2d9381eee4ef8ull,0xbc8462e2979bb57cull},{0xbfb1bd61fefe6871ull,0x3c56f3a816383257ull},
    {0x3f62ec2443318078ull,0x3bf34d885921b6bfull}
};
static compensated polynomial(expression *e,const coefficient *c,compensated z)
{
    compensated p={constant(c[6].high),constant(c[6].low)};
    for(pl_u32 n=6u;n;--n){p=compensated_multiply(e,p,z);compensated term={constant(c[n-1u].high),constant(c[n-1u].low)};
        p=compensated_add(e,p,term);}return p;
}
static compensated logarithm_fraction(expression *e,compensated t)
{
    compensated z=compensated_multiply(e,t,t),p=polynomial(e,numerator,z),q=polynomial(e,denominator,z);
    compensated r=compensated_divide(e,p,q);r=compensated_multiply(e,r,t);
    const compensated conversion={constant(0x40071547652b82feull),constant(0x3c8777d0ffda0d24ull)};
    return compensated_multiply(e,r,conversion);
}
compensated compensated_inverse_tangent(expression *e,compensated t)
{
    compensated z=compensated_multiply(e,t,t);z=compensated_negate(e,z);
    compensated p=polynomial(e,numerator,z),q=polynomial(e,denominator,z),r=compensated_divide(e,p,q);
    return compensated_multiply(e,r,t);
}
static int logarithm_value_plan(pl_u32 plus_one,pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,896u,1952u,0u,4u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},y={PL_OPERAND_LOCAL,2u},ys={PL_OPERAND_LOCAL,3u};
    pl_operand extra_exponent=constant(0u);compensated r;
    if(plus_one){
        pl_operand exp=bit_and(&e,se,constant(32767u));exp=select(&e,constant(1u),exp,equal(&e,exp,constant(0u)));
        pl_operand exponent=binary(&e,96u,exp,constant(16383u)),tiny=compare(&e,exp,constant(16273u),2u),large=compare(&e,constant(16381u),exp,2u);
        pl_operand clamp=bit_or(&e,tiny,large),used_exp=select(&e,constant(0u),exponent,clamp);used_exp=binary(&e,89u,used_exp,constant(1023u));
        pl_operand scale=binary(&e,PL_OPCODE_LANE64_SHL,used_exp,constant(52u));compensated x=compensated_significand(&e,a);
        pl_operand sign=bit_and(&e,se,constant(32768u));sign=binary(&e,PL_OPCODE_LANE64_SHL,sign,constant(48u));
        x.high=binary(&e,86u,x.high,sign);x.low=binary(&e,86u,x.low,sign);
        const compensated inverse_ln2={constant(0x3ff71547652b82feull),constant(0x3c7777d0ffda0d24ull)};
        compensated small=compensated_multiply(&e,x,inverse_ln2);x.high=fp_multiply(&e,x.high,scale);x.low=fp_multiply(&e,x.low,scale);
        const compensated two={constant(0x4000000000000000ull),constant(0u)};compensated d=compensated_add(&e,x,two),t=compensated_divide(&e,x,d);
        r=logarithm_fraction(&e,t);r.high=select(&e,small.high,r.high,tiny);r.low=select(&e,small.low,r.low,tiny);extra_exponent=select(&e,exponent,constant(0u),tiny);
    }else{
    pl_operand leading=leading_zeros(&e,a),normalized=binary(&e,PL_OPCODE_LANE64_SHL,a,leading);
    normalized=bit_or(&e,normalized,constant(0x8000000000000000ull));pl_operand exponent=bit_and(&e,se,constant(32767u));
    exponent=select(&e,constant(1u),exponent,equal(&e,exponent,constant(0u)));exponent=binary(&e,96u,exponent,constant(16383u));exponent=binary(&e,96u,exponent,leading);
    compensated m=compensated_significand(&e,normalized);pl_operand upper=compare(&e,constant(0xb504f333f9de6484ull),normalized,2u);
    pl_operand half_high=fp_multiply(&e,m.high,constant(0x3fe0000000000000ull)),half_low=fp_multiply(&e,m.low,constant(0x3fe0000000000000ull));
    m.high=select(&e,half_high,m.high,upper);m.low=select(&e,half_low,m.low,upper);exponent=binary(&e,89u,exponent,upper);
    const compensated one={constant(0x3ff0000000000000ull),constant(0u)},minus_one={constant(0xbff0000000000000ull),constant(0u)};
    compensated difference=compensated_add(&e,m,minus_one),sum=compensated_add(&e,m,one),t=compensated_divide(&e,difference,sum);
    r=logarithm_fraction(&e,t);
    pl_operand sign=shift(&e,exponent,63u),mask=binary(&e,96u,constant(0u),sign),magnitude=binary(&e,86u,exponent,mask);
    magnitude=binary(&e,89u,magnitude,sign);pl_operand integer=binary(&e,PL_OPCODE_IEEE64_FROM_UNSIGNED,magnitude,constant(0u));
    pl_operand sign_word=binary(&e,PL_OPCODE_LANE64_SHL,sign,constant(63u));integer=binary(&e,86u,integer,sign_word);
    compensated power={integer,constant(0u)};r=compensated_add(&e,r,power);
    }
    compensated multiplier=compensated_significand(&e,y);pl_operand y_sign=bit_and(&e,ys,constant(32768u));y_sign=binary(&e,PL_OPCODE_LANE64_SHL,y_sign,constant(48u));
    multiplier.high=binary(&e,86u,multiplier.high,y_sign);multiplier.low=binary(&e,86u,multiplier.low,y_sign);r=compensated_multiply(&e,r,multiplier);
    pl_operand y_exp=bit_and(&e,ys,constant(32767u));y_exp=select(&e,constant(1u),y_exp,equal(&e,y_exp,constant(0u)));y_exp=binary(&e,96u,y_exp,constant(16383u));
    y_exp=binary(&e,89u,y_exp,extra_exponent);
    raw.locals[0]=r.high;raw.locals[1]=r.low;raw.locals[2]=y_exp;raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_logarithm_value_plan(pl_arena *arena,pl_plan *out)
{return logarithm_value_plan(0u,arena,out);}
int pl_x86_x87_logarithm_one_value_plan(pl_arena *arena,pl_plan *out)
{return logarithm_value_plan(1u,arena,out);}
