#include <x86/semantics.h>
#include "angle.h"
typedef struct {pl_u64 high,low;} coefficient;
int pl_x86_x87_trig_supported(const pl_x86_instruction *i)
{
    if(!i)return 0;
    pl_u32 variant=(pl_u32)(i->machine_argument>>44u),required=PL_X86_INSTRUCTION_MAY_TRAP|PL_X86_INSTRUCTION_PRECISE_CUT|PL_X86_INSTRUCTION_BARRIER;
    const pl_u32 opcodes[]={0x1ffu,0x1feu,0x1fbu,0x1f2u};
    return variant<4u&&i->status==PL_X86_DECODE_VALID&&i->encoding==PL_X86_ENCODING_LEGACY
        &&i->machine_operation==PL_X86_MACHINE_X87&&i->machine_argument==(48u|((pl_u64)opcodes[variant]<<16u)|((pl_u64)variant<<44u))
        &&i->opcode==0xd9u&&!i->visible_operand_count&&(i->flow==PL_X86_FLOW_NEXT||i->flow==PL_X86_FLOW_SYSTEM)
        &&(i->flags&required)==required&&!(i->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_READS_MEMORY|PL_X86_INSTRUCTION_WRITES_MEMORY|PL_X86_INSTRUCTION_TRAP_AFTER))
        &&i->source_bytes&&i->source_bytes<=15u&&i->source_bytes==i->length&&i->fallthrough-i->rip==i->length;
}
int pl_x86_x87_exponential_supported(const pl_x86_instruction *i)
{
    if(!i)return 0;
    pl_x86_instruction equivalent=*i;
    if(i->machine_argument!=(58u|(0x1f0ull<<16u)))return 0;
    equivalent.machine_argument=48u|(0x1ffull<<16u);return pl_x86_x87_trig_supported(&equivalent);
}
static int transcendental_result_plan(pl_u32 cosine,pl_u32 exponential,pl_arena *arena,pl_plan *out)
{
    if(cosine>1u||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,160u,480u,0u,8u))return PL_ERROR_ARENA;
    pl_operand a={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},cw={PL_OPERAND_LOCAL,2u},empty={PL_OPERAND_LOCAL,3u},full={PL_OPERAND_LOCAL,4u};
    pl_operand sig={PL_OPERAND_LOCAL,5u},result_se={PL_OPERAND_LOCAL,6u},outcome={PL_OPERAND_LOCAL,7u};
    pl_operand exponent=bit_and(&e,se,constant(32767u)),zero_exp=equal(&e,exponent,constant(0u)),zero_sig=equal(&e,a,constant(0u));
    pl_operand zero=bit_and(&e,zero_exp,zero_sig),full_exp=equal(&e,exponent,constant(32767u)),j=shift(&e,a,63u);
    pl_operand unsupported=bit_and(&e,not(&e,zero_exp),not(&e,j)),fraction=bit_and(&e,a,constant(0x7fffffffffffffffull));
    pl_operand nan=bit_and(&e,full_exp,not(&e,equal(&e,fraction,constant(0u)))),inf=bit_and(&e,full_exp,not(&e,nan));
    pl_operand signaling=bit_and(&e,nan,not(&e,bit_and(&e,shift(&e,a,62u),constant(1u))));
    pl_operand indefinite=bit_or(&e,empty,unsupported);if(!exponential)indefinite=bit_or(&e,indefinite,inf);
    indefinite=bit_or(&e,indefinite,full);pl_operand invalid=bit_or(&e,indefinite,signaling);
    pl_operand denormal=bit_and(&e,zero_exp,not(&e,zero_sig)),special=bit_or(&e,invalid,nan);
    if(exponential)special=bit_or(&e,special,inf);
    denormal=bit_and(&e,denormal,not(&e,special));
    pl_operand range=not(&e,compare(&e,exponent,constant(16446u),2u));range=bit_and(&e,range,not(&e,full_exp));range=bit_and(&e,range,not(&e,indefinite));
    pl_operand tiny=compare(&e,exponent,constant(16351u),2u),tiny_sig=cosine?constant(0x8000000000000000ull):a;
    pl_operand tiny_se=cosine?constant(16383u):select(&e,bit_or(&e,se,constant(1u)),se,bit_and(&e,zero_exp,j));
    pl_operand outside=constant(0u);if(exponential){range=constant(0u);tiny=constant(0u);
        pl_operand greater_exp=compare(&e,constant(16383u),exponent,2u),one_exp=equal(&e,exponent,constant(16383u));
        pl_operand greater_sig=compare(&e,constant(0x8000000000000000ull),a,2u);greater_sig=bit_and(&e,greater_sig,one_exp);
        outside=bit_or(&e,greater_exp,greater_sig);outside=bit_and(&e,outside,not(&e,full_exp));
        sig=select(&e,a,sig,outside);result_se=select(&e,se,result_se,outside);
        pl_operand endpoint=bit_and(&e,one_exp,equal(&e,a,constant(0x8000000000000000ull))),sign=shift(&e,se,15u);
        pl_operand endpoint_se=select(&e,constant(0xbffeu),constant(16383u),sign);
        sig=select(&e,constant(0x8000000000000000ull),sig,endpoint);result_se=select(&e,endpoint_se,result_se,endpoint);
        pl_operand c1_clear=bit_or(&e,outside,endpoint);outcome=select(&e,constant(0u),outcome,c1_clear);
        pl_operand infinity_se=select(&e,constant(0xbfffu),constant(32767u),sign);
        sig=select(&e,constant(0x8000000000000000ull),sig,inf);result_se=select(&e,infinity_se,result_se,inf);
    }else{sig=select(&e,tiny_sig,sig,tiny);result_se=select(&e,tiny_se,result_se,tiny);}
    pl_operand numeric=not(&e,bit_or(&e,special,range)),precision=bit_and(&e,numeric,not(&e,zero));
    pl_operand rounded=bit_and(&e,outcome,constant(0x200u));rounded=select(&e,constant(0u),rounded,tiny);
    rounded=select(&e,constant(0u),rounded,not(&e,numeric));
    pl_operand underflow=exponential?bit_and(&e,shift(&e,outcome,4u),constant(1u)):cosine?constant(0u):bit_and(&e,zero_exp,not(&e,j));underflow=bit_and(&e,underflow,precision);
    if(!exponential&&!cosine){
        // An unmasked underflow publishes the unbounded 64-bit result with
        // exponent +24576. Even a one-bit raw denormal therefore has a normal
        // wrapped payload/tag, not the original denormal representation.
        pl_operand um=bit_and(&e,cw,constant(16u)),wrapped=bit_and(&e,underflow,not(&e,um));
        pl_operand leading=leading_zeros(&e,a),wrapped_sig=binary(&e,PL_OPCODE_LANE64_SHL,a,leading);
        pl_operand wrapped_exp=binary(&e,96u,constant(24577u),leading),sign=bit_and(&e,se,constant(32768u));
        wrapped_exp=bit_or(&e,wrapped_exp,sign);sig=select(&e,wrapped_sig,sig,wrapped);result_se=select(&e,wrapped_exp,result_se,wrapped);
    }
    pl_operand raised=bit_or(&e,invalid,binary(&e,PL_OPCODE_LANE64_SHL,denormal,constant(1u)));
    raised=bit_or(&e,raised,binary(&e,PL_OPCODE_LANE64_SHL,underflow,constant(4u)));
    raised=bit_or(&e,raised,binary(&e,PL_OPCODE_LANE64_SHL,precision,constant(5u)));
    pl_operand suppress_i=bit_and(&e,invalid,not(&e,bit_and(&e,cw,constant(1u))));
    pl_operand suppress_d=bit_and(&e,denormal,not(&e,bit_and(&e,cw,constant(2u))));pl_operand suppress=bit_or(&e,suppress_i,suppress_d);
    pl_operand early_raised=bit_or(&e,invalid,binary(&e,PL_OPCODE_LANE64_SHL,denormal,constant(1u)));
    raised=select(&e,early_raised,raised,suppress);rounded=select(&e,constant(0u),rounded,suppress);
    pl_operand quiet=bit_or(&e,a,constant(0x4000000000000000ull));sig=select(&e,quiet,sig,nan);result_se=select(&e,se,result_se,nan);
    sig=select(&e,constant(0xc000000000000000ull),sig,indefinite);result_se=select(&e,constant(65535u),result_se,indefinite);
    pl_operand valid_zero=bit_and(&e,zero,not(&e,indefinite));sig=select(&e,tiny_sig,sig,valid_zero);result_se=select(&e,tiny_se,result_se,valid_zero);
    pl_operand result_exp=bit_and(&e,result_se,constant(32767u)),tag=select(&e,constant(2u),constant(0u),equal(&e,result_exp,constant(32767u)));
    tag=select(&e,constant(2u),tag,equal(&e,result_exp,constant(0u)));tag=select(&e,constant(1u),tag,bit_and(&e,equal(&e,result_exp,constant(0u)),equal(&e,sig,constant(0u))));
    pl_operand stack_fault=bit_or(&e,empty,full);raised=bit_or(&e,raised,binary(&e,PL_OPCODE_LANE64_SHL,stack_fault,constant(6u)));
    rounded=select(&e,constant(0x200u),rounded,full);outcome=bit_or(&e,raised,rounded);
    outcome=bit_or(&e,outcome,binary(&e,PL_OPCODE_LANE64_SHL,tag,constant(18u)));
    suppress=bit_or(&e,suppress,range);outcome=bit_or(&e,outcome,binary(&e,PL_OPCODE_LANE64_SHL,suppress,constant(16u)));
    outcome=bit_or(&e,outcome,binary(&e,PL_OPCODE_LANE64_SHL,range,constant(10u)));outcome=bit_or(&e,outcome,constant((exponential?0x200ull:0x600ull)<<32u));
    raw.locals[0]=sig;raw.locals[1]=result_se;raw.locals[2]=outcome;for(pl_u32 n=3u;n<8u;++n)raw.locals[n]=(pl_operand){PL_OPERAND_LOCAL,n};
    if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u,0u,0u,0u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_trig_result_plan(pl_u32 cosine,pl_arena *arena,pl_plan *out)
{return transcendental_result_plan(cosine,0u,arena,out);}
int pl_x86_x87_exponential_result_plan(pl_arena *arena,pl_plan *out)
{return transcendental_result_plan(0u,1u,arena,out);}
int pl_x86_compensated_divide_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,96u,224u,0u,4u))return PL_ERROR_ARENA;
    compensated a={{PL_OPERAND_LOCAL,0u},{PL_OPERAND_LOCAL,1u}},b={{PL_OPERAND_LOCAL,2u},{PL_OPERAND_LOCAL,3u}};
    compensated r=compensated_divide(&e,a,b);raw.locals[0]=r.high;raw.locals[1]=r.low;
    raw.locals[2]=(pl_operand){PL_OPERAND_LOCAL,2u};raw.locals[3]=(pl_operand){PL_OPERAND_LOCAL,3u};if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,0u,0u};return pl_compact_projected(&raw,live,arena,out);
}
/* Each pair is RN64(+-1/n!), RN64(exact rational - high). Horner on
 * |r|<=Pi/4 retains the residual in the common compensated SSA. The first
 * omitted terms are |r|^29/29! and |r|^28/28!, respectively. */
static const coefficient sine[]={
    {0xbfc5555555555555ull,0xbc65555555555555ull},
    {0x3f81111111111111ull,0x3c01111111111111ull},
    {0xbf2a01a01a01a01aull,0xbb6a01a01a01a01aull},
    {0x3ec71de3a556c734ull,0xbb6c154f8ddc6c00ull},
    {0xbe5ae64567f544e4ull,0x3afc062e06d1f209ull},
    {0x3de6124613a86d09ull,0x3a8f28e0cc748ebeull},
    {0xbd6ae7f3e733b81full,0xb9e1d8656b0ee8cbull},
    {0x3ce952c77030ad4aull,0x398ac981465ddc6cull},
    {0xbc62f49b46814157ull,0xb8f2650f61dbdcb4ull},
    {0x3bd71b8ef6dcf572ull,0xb87d043ae40c4647ull},
    {0xbb4761b41316381aull,0x37d3423c7d91404full},
    {0x3ab3f3ccdd165fa9ull,0xb7458ddadf344487ull},
    {0xba1d1ab1c2dccea3ull,0xb6a054d0c78aea14ull}
};
static const coefficient cosine_coefficients[]={
    {0xbfe0000000000000ull,0x0000000000000000ull},
    {0x3fa5555555555555ull,0x3c45555555555555ull},
    {0xbf56c16c16c16c17ull,0x3bef49f49f49f49full},
    {0x3efa01a01a01a01aull,0x3b3a01a01a01a01aull},
    {0xbe927e4fb7789f5cull,0xbb3cbbc05b4fa99aull},
    {0x3e21eed8eff8d898ull,0xbac2aec959e14c06ull},
    {0xbda93974a8c07c9dull,0xba305d6f8a2efd1full},
    {0x3d2ae7f3e733b81full,0x39a1d8656b0ee8cbull},
    {0xbca6827863b97d97ull,0xb94eec01221a8b0bull},
    {0x3c1e542ba4020225ull,0x387ea72b4afe3c2full},
    {0xbb90ce396db7f853ull,0x383aebcdbd20331cull},
    {0x3aff2cf01972f578ull,0xb789ada5fcc1ab14ull},
    {0xba688e85fc6a4e5aull,0x37071c37ebd16540ull}
};
static compensated coefficients(expression *e,pl_u32 n,pl_operand use_cosine)
{
    return(compensated){select(e,constant(cosine_coefficients[n].high),constant(sine[n].high),use_cosine),
        select(e,constant(cosine_coefficients[n].low),constant(sine[n].low),use_cosine)};
}
int pl_x86_x87_trig_value_plan(pl_u32 cosine,pl_arena *arena,pl_plan *out)
{
    if(cosine>1u||!arena||!out)return PL_ERROR_PLAN;
    pl_plan raw={.instructions=1u};expression e={0};
    if(pl_builder_open(&e.builder,&raw,arena,864u,1952u,0u,2u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},exponent=bit_and(&e,se,constant(32767u));
    // Only finite, in-range, non-tiny numeric arms are published by the
    // architectural wrapper. Clamp all other pure arms to a finite mantissa.
    pl_operand small=compare(&e,exponent,constant(16382u),2u),minimum=compare(&e,exponent,constant(15883u),2u);
    pl_operand e64=binary(&e,96u,exponent,constant(16383u));
    pl_operand reduced_exponent=select(&e,constant(~0ull),e64,small);
    reduced_exponent=select(&e,constant(62u),reduced_exponent,not(&e,compare(&e,exponent,constant(16446u),2u)));
    reduced_angle reduced=reduce_angle(&e,bit_or(&e,sig,constant(0x8000000000000000ull)),reduced_exponent);
    compensated tiny=compensated_significand(&e,sig);
    pl_operand scale_exp=binary(&e,89u,e64,constant(1023u));scale_exp=select(&e,constant(523u),scale_exp,minimum);
    pl_operand scale=binary(&e,PL_OPCODE_LANE64_SHL,scale_exp,constant(52u));
    tiny.high=fp_multiply(&e,tiny.high,scale);tiny.low=fp_multiply(&e,tiny.low,scale);
    compensated r={select(&e,tiny.high,reduced.value.high,small),select(&e,tiny.low,reduced.value.low,small)};
    pl_operand quadrant=select(&e,constant(0u),reduced.quadrant,small),odd=bit_and(&e,quadrant,constant(1u));
    pl_operand use_cosine=binary(&e,86u,odd,constant(cosine));
    // The architectural period is 2*Pi, not 2*mathematical pi.
    const compensated ratio={constant(0x3ff0000000000000ull),constant(0x3b98518e2da2e893ull)};
    r=compensated_multiply(&e,r,ratio);compensated z=compensated_multiply(&e,r,r),p=coefficients(&e,12u,use_cosine);
    for(pl_u32 n=12u;n;--n){p=compensated_multiply(&e,p,z);compensated term=coefficients(&e,n-1u,use_cosine);p=compensated_add(&e,p,term);}
    p=compensated_multiply(&e,p,z);const compensated one={constant(0x3ff0000000000000ull),constant(0u)};
    p=compensated_add(&e,p,one);compensated sine_result=compensated_multiply(&e,p,r);
    p.high=select(&e,p.high,sine_result.high,use_cosine);p.low=select(&e,p.low,sine_result.low,use_cosine);
    pl_operand sign=shift(&e,quadrant,1u);if(cosine)sign=binary(&e,86u,sign,odd);
    else{pl_operand source_sign=shift(&e,se,15u);sign=binary(&e,86u,sign,source_sign);}
    pl_operand sign_word=binary(&e,PL_OPCODE_LANE64_SHL,sign,constant(63u));p.high=binary(&e,86u,p.high,sign_word);p.low=binary(&e,86u,p.low,sign_word);
    raw.locals[0]=p.high;raw.locals[1]=p.low;if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u};return pl_compact_projected(&raw,live,arena,out);
}
int pl_x86_x87_exponential_value_plan(pl_arena *arena,pl_plan *out)
{
    if(!arena||!out)return PL_ERROR_PLAN;
    // Diagonal [11/11] Pade: c[k]=(22-k)!*11!/((22)!*(11-k)!*k!).
    // Split even/odd powers; exp(t)-1=2*O(t)/(E(t)-O(t)). No cancellation
    // of exp(t) and one, including a separately scaled tiny-input class.
    static const coefficient c[]={
        {0x3ff0000000000000ull,0u},{0x3fe0000000000000ull,0u},
        {0x3fbe79e79e79e79eull,0x3c5e79e79e79e79eull},{0x3f92492492492492ull,0x3c32492492492492ull},
        {0x3f5ecc07b301ecc0ull,0x3bfecc07b301ecc0ull},{0x3f23299e6401329aull,0xbba9bfecd6619bffull},
        {0x3ee2090d8b4c6bdcull,0x3b7200090486c5a6ull},{0x3e99c3ca34b650f1ull,0x3b36000670f28d2eull},
        {0x3e4b7b825a5c1213ull,0xbaeffff9211f6969ull},{0x3df4f06351093257ull,0x3a8e79f216ab9023ull},
        {0x3d949deba27f3581ull,0x3a2c09caeaff91dcull},{0x3d23fdfbc45c52eaull,0xb9a732d38d943a75ull}
    };
    pl_plan raw={.instructions=1u};expression e={0};if(pl_builder_open(&e.builder,&raw,arena,768u,1728u,0u,3u))return PL_ERROR_ARENA;
    pl_operand sig={PL_OPERAND_LOCAL,0u},se={PL_OPERAND_LOCAL,1u},exp=bit_and(&e,se,constant(32767u));
    exp=select(&e,constant(1u),exp,equal(&e,exp,constant(0u)));pl_operand exponent=binary(&e,96u,exp,constant(16383u));
    pl_operand tiny=compare(&e,exp,constant(16273u),2u),large=compare(&e,constant(16383u),exp,2u);
    pl_operand use_mantissa=bit_or(&e,tiny,large),scale_exp=select(&e,constant(0u),exponent,use_mantissa);
    scale_exp=binary(&e,89u,scale_exp,constant(1023u));pl_operand scale=binary(&e,PL_OPCODE_LANE64_SHL,scale_exp,constant(52u));
    compensated x=compensated_significand(&e,sig);pl_operand sign=bit_and(&e,se,constant(32768u));sign=binary(&e,PL_OPCODE_LANE64_SHL,sign,constant(48u));
    x.high=binary(&e,86u,x.high,sign);x.low=binary(&e,86u,x.low,sign);
    const compensated ln2={constant(0x3fe62e42fefa39efull),constant(0x3c7abc9e3b39803full)};
    compensated small=compensated_multiply(&e,x,ln2);x.high=fp_multiply(&e,x.high,scale);x.low=fp_multiply(&e,x.low,scale);
    compensated t=compensated_multiply(&e,x,ln2),z=compensated_multiply(&e,t,t);
    compensated even={constant(c[10].high),constant(c[10].low)},odd={constant(c[11].high),constant(c[11].low)};
    for(pl_u32 k=10u;k>=2u;k-=2u){even=compensated_multiply(&e,even,z);compensated term={constant(c[k-2u].high),constant(c[k-2u].low)};even=compensated_add(&e,even,term);}
    for(pl_u32 k=11u;k>=3u;k-=2u){odd=compensated_multiply(&e,odd,z);compensated term={constant(c[k-2u].high),constant(c[k-2u].low)};odd=compensated_add(&e,odd,term);}
    odd=compensated_multiply(&e,odd,t);compensated negative_odd=compensated_negate(&e,odd),denominator=compensated_add(&e,even,negative_odd);
    odd.high=fp_add(&e,odd.high,odd.high);odd.low=fp_add(&e,odd.low,odd.low);compensated result=compensated_divide(&e,odd,denominator);
    result.high=select(&e,small.high,result.high,tiny);result.low=select(&e,small.low,result.low,tiny);
    raw.locals[0]=result.high;raw.locals[1]=result.low;raw.locals[2]=select(&e,exponent,constant(0u),tiny);if(e.failed)return PL_ERROR_ARENA;
    const pl_u8 live[]={1u,1u,1u};return pl_compact_projected(&raw,live,arena,out);
}
