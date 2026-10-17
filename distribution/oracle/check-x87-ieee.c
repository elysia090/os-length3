#include <softfloat.h>
#include "../../compiler/x86/check/scalar-plan.h"
#include <stdio.h>
int main(void)
{
    pl_u64 seed=0x341fdbea49139826ull;pl_u32 samples=0u,max_nodes=0u,max_span=0u;
    for(pl_u32 bits=32u;bits<=64u;bits+=32u){_Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_ieee_plan(bits,&arena,&plan))return 1;
        if(plan.node_count>max_nodes)max_nodes=plan.node_count;
        if(plan.span>max_span)max_span=plan.span;
        pl_u32 fraction_bits=bits==32u?23u:52u;pl_u64 exp_mask=bits==32u?255u:2047u,frac_mask=(1ull<<fraction_bits)-1u;
        for(pl_u32 row=0u;row<100000u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;pl_u64 x=seed;
            if(row%5u==0u)x&=frac_mask;
            if(row%7u==0u)x=(x&frac_mask)|(exp_mask<<fraction_bits);
            if(row==0u)x=0u;
            if(row==1u)x=1ull<<(bits-1u);
            if(row==2u)x=1u;
            if(row==3u)x=(exp_mask<<fraction_bits)|1u;
            if(row==4u)x=frac_mask;
            pl_u64 exp=(x>>fraction_bits)&exp_mask,frac=x&frac_mask;
            pl_u64 signal=exp==exp_mask&&frac&&!(frac>>(fraction_bits-1u));
            pl_u64 classes=(!exp&&frac?1u:0u)|(signal<<1u)|(!exp&&!frac?4u:0u);
            softfloat_exceptionFlags=0u;extFloat80_t expected;
            if(bits==32u)expected=f32_to_extF80((float32_t){(pl_u32)x});else expected=f64_to_extF80((float64_t){x});
            /* The pure raw projection deliberately does not quiet SNaN;
             * match the reference's conversion after accounting for it. */
            if(signal)expected.signif&=~(1ull<<62u);
            pl_u64 input[]={x,0u,0u,0u,0u},out[3]={0u};
            if(check_scalar_plan(&plan,input,out)||out[0]!=expected.signif||out[1]!=expected.signExp||out[2]!=classes
                ||softfloat_exceptionFlags!=(signal?softfloat_flag_invalid:0u)){
                fprintf(stderr,"IEEE%u projection differs row=%u word=%016llx\n",bits,row,(unsigned long long)x);return 1;}
            ++samples;
        }
    }
    printf("{\"format\":\"raw-ieee-extended-ssa-v1\",\"status\":\"pass\",\"samples\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"oracle\":\"official SoftFloat; raw signaling retained explicitly\"}\n",samples,max_nodes,max_span);return 0;
}
