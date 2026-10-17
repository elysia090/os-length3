#include <softfloat.h>
#include "../../compiler/x86/check/scalar-plan.h"
#include <stdio.h>
#include <stdint.h>
#include <string.h>
static pl_u64 seed=0xba3832fed781093aull;
static pl_u64 random_word(void){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;return seed;}
int main(void)
{
    const pl_u32 exponents[]={0u,1u,16319u,16320u,16321u,16382u,16383u,16384u,16414u,16415u,16447u,16448u,16449u,16511u,32766u};
    const pl_u8 rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    const pl_u32 pcs[]={0u,2u,3u},operations[]={0u,2u,3u};pl_u32 samples=0u,max_nodes=0u,max_span=0u;
    for(pl_u32 width=16u;width<=32u;width+=16u)for(pl_u32 op=0u;op<3u;++op){
        _Alignas(8) pl_u8 scratch[131072];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        if(pl_x86_x87_integer_arithmetic_plan(width,operations[op],&arena,&plan))return 1;
        if(plan.node_count>max_nodes)max_nodes=plan.node_count;
        if(plan.span>max_span)max_span=plan.span;
        for(pl_u32 row=0u;row<40000u;++row){pl_u64 sig=random_word(),integer_word=random_word();
            pl_u32 exp=exponents[row%(sizeof exponents/sizeof exponents[0])],sign=(pl_u32)(random_word()&1u);
            if(exp)sig|=1ull<<63u;else sig&=~(1ull<<63u);
            if(row%19u==0u){sig=0u;exp=0u;}
            pl_u32 pc=pcs[row%3u],rc=(row/3u)%4u,cw=0x7fu|(pc<<8u)|(rc<<10u);pl_u16 se=(pl_u16)(exp|(sign<<15u));
            pl_u64 mask=(1ull<<width)-1u,sign_bit=1ull<<(width-1u),bits=((integer_word&mask)^sign_bit)-sign_bit;
            int64_t integer;memcpy(&integer,&bits,sizeof integer);
            extF80_roundingPrecision=pc==0u?32u:pc==2u?64u:80u;softfloat_roundingMode=rounding[rc];softfloat_detectTininess=softfloat_tininess_afterRounding;
            softfloat_exceptionFlags=0u;extFloat80_t a={.signif=sig,.signExp=se},b=i64_to_extF80(integer);
            extFloat80_t expected=op==0u?extF80_add(a,b):op==1u?extF80_sub(a,b):extF80_sub(b,a);
            pl_u32 raised=(!exp&&sig?2u:0u)|((softfloat_exceptionFlags&softfloat_flag_inexact)?32u:0u)
                |((softfloat_exceptionFlags&softfloat_flag_underflow)?16u:0u)|((softfloat_exceptionFlags&softfloat_flag_overflow)?8u:0u);
            pl_u64 input[]={sig,se,integer_word,cw,0u},out[3]={0u};
            if(check_scalar_plan(&plan,input,out)||out[0]!=expected.signif||out[1]!=expected.signExp||(out[2]&127u)!=raised){
                fprintf(stderr,"finite SSA mismatch width=%u op=%u row=%u A=%016llx/%04x I=%016llx CW=%04x expected=%016llx/%04x flags=%02x actual=%016llx/%04llx flags=%02llx\n",
                    width,operations[op],row,(unsigned long long)sig,se,(unsigned long long)integer_word,cw,(unsigned long long)expected.signif,
                    expected.signExp,raised,(unsigned long long)out[0],(unsigned long long)out[1],(unsigned long long)(out[2]&127u));return 1;}
            ++samples;
        }
    }
    printf("{\"format\":\"canonical-finite-integer-arithmetic-ssa-v1\",\"status\":\"pass\",\"samples\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"oracle\":\"official SoftFloat 3e; masked finite results only\"}\n",samples,max_nodes,max_span);return 0;
}
