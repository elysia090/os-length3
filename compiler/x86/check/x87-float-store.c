#include <x86/semantics.h>
#include "scalar-plan.h"
#include <softfloat.h>
#include <stdio.h>
static _Alignas(8) pl_u8 scratch[2][65536];
static pl_u64 random_word(pl_u64 *seed)
{*seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed;}
static unsigned flags(unsigned f)
{return(f&softfloat_flag_invalid?1u:0u)|(f&softfloat_flag_overflow?8u:0u)
    |(f&softfloat_flag_underflow?16u:0u)|(f&softfloat_flag_inexact?32u:0u);}
int main(void)
{
    pl_plan plans[2];unsigned comparisons=0u;
    for(unsigned kind=0u;kind<2u;++kind){pl_arena arena={scratch[kind],sizeof scratch[kind],0u};
        if(pl_x86_x87_float_store_plan(kind?64u:32u,&arena,&plans[kind]))return 1;}
    const uint_fast8_t rounding[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    pl_u64 seed=0xc479ed82fb493622ull;
    for(unsigned kind=0u;kind<2u;++kind){unsigned bias=kind?1023u:127u,fraction=kind?52u:23u,min=16384u-bias,max=16383u+bias;
        for(unsigned row=0u;row<300000u;++row){pl_u64 sig=random_word(&seed),sample=random_word(&seed);unsigned exp;
            switch(row&7u){case 0:exp=(unsigned)(sample%32768u);break;case 1:exp=min+(unsigned)(sample%(2u*bias));break;
            case 2:exp=min-2u+(unsigned)(sample%5u);break;case 3:exp=min-fraction-2u+(unsigned)(sample%5u);break;
            case 4:exp=max-2u+(unsigned)(sample%5u);break;case 5:exp=0x3fffu;break;case 6:exp=0u;break;default:exp=32767u;break;}
            if(exp)sig|=1ull<<63u;else sig&=~(1ull<<63u);
            pl_u64 input[]={sig,exp|((sample>>63u)<<15u),0x7fu|((pl_u64)((row>>2u)&3u)<<8u)|((pl_u64)(row&3u)<<10u),0u,0u},out[4];
            if(check_scalar_projection(&plans[kind],input,out,4u))return 1;
            extFloat80_t value={.signif=sig,.signExp=(uint16_t)input[1]};softfloat_roundingMode=rounding[row&3u];
            softfloat_detectTininess=softfloat_tininess_afterRounding;softfloat_exceptionFlags=0u;
            pl_u64 expected=kind?extF80_to_f64(value).v:extF80_to_f32(value).v;unsigned expected_flags=flags(softfloat_exceptionFlags);
            if(out[0]!=expected||(out[2]&63u)!=expected_flags||out[3]){
                fprintf(stderr,"float store bits=%u row=%u sig=%llx se=%llx rc=%u got=%llx/%llx expected=%llx/%x\n",
                    kind?64u:32u,row,(unsigned long long)sig,(unsigned long long)input[1],row&3u,
                    (unsigned long long)out[0],(unsigned long long)(out[2]&63u),(unsigned long long)expected,expected_flags);return 1;}
            ++comparisons;
        }
    }
    printf("IEEE stores: %u official SoftFloat canonical payload/exception comparisons; native stack/suppression/fault tests separate\n",comparisons);return 0;
}
