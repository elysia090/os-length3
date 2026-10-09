#include <x86/semantics.h>
#include "scalar-plan.h"
#include <softfloat.h>
#include <stdio.h>
static _Alignas(8) pl_u8 scratch[4][24576];
static pl_u64 random_word(pl_u64 *s){*s^=*s<<13u;*s^=*s>>7u;*s^=*s<<17u;return *s;}
int main(void)
{
    pl_plan plans[4];unsigned comparisons=0u;
    const uint_fast8_t rc[]={softfloat_round_near_even,softfloat_round_min,softfloat_round_max,softfloat_round_minMag};
    const pl_u64 edges[]={0u,1u,~0ull,0x8000000000000000ull,0x7fffffffffffffffull,0x7fffffffffffefffull,
        0x01000001u,0xfffffffffeffffffull,0x0020000000000001ull,0xffdfffffffffffffull,0x7fffffffu,0x80000000u,
        0x4000000000000001ull,0xbfffffffffffffffull,0x02000003u,0x0040000000000003ull};
    pl_u64 seed=0x03115aed239348ccull;
    for(unsigned kind=0u;kind<4u;++kind){pl_arena arena={scratch[kind],sizeof scratch[kind],0u};
        if(pl_x86_signed_float_plan(kind&1u?64u:32u,kind&2u?64u:32u,&arena,plans+kind))return 1;
        for(unsigned row=0u;row<65536u;++row){pl_u64 x=row<64u?edges[(row>>2u)&15u]:random_word(&seed),input[]={x,row&3u,0u,0u,0u},out[2];
            if(check_scalar_projection(plans+kind,input,out,2u))return 1;
            softfloat_roundingMode=rc[row&3u];softfloat_exceptionFlags=0u;
            pl_u64 expected=kind&2u?(kind&1u?i64_to_f64((int64_t)x).v:i32_to_f64((int32_t)x).v)
                :(kind&1u?i64_to_f32((int64_t)x).v:i32_to_f32((int32_t)x).v);
            pl_u64 inexact=!!(softfloat_exceptionFlags&softfloat_flag_inexact);
            if(out[0]!=expected||out[1]!=inexact){fprintf(stderr,"signed float kind=%u row=%u input=%llx got=%llx/%llu expected=%llx/%llu\n",kind,row,
                (unsigned long long)x,(unsigned long long)out[0],(unsigned long long)out[1],(unsigned long long)expected,(unsigned long long)inexact);return 1;}
            ++comparisons;
        }
    }
    printf("signed integer -> IEEE: %u official SoftFloat bits/inexact comparisons; product execution separate\n",comparisons);return 0;
}
