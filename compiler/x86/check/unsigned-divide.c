#include "scalar-plan.h"
#include <stdio.h>
static pl_u64 random_word(pl_u64 *state)
{*state^=*state<<13u;*state^=*state>>7u;*state^=*state<<17u;return *state;}
static int compare(const pl_plan *plan,pl_u64 high,pl_u64 low,pl_u64 divisor)
{
    pl_u64 input[]={high,low,divisor,0u,0u},out[3];if(check_scalar_plan(plan,input,out))return 1;
    pl_u64 invalid=high>=divisor;if(out[2]!=invalid)return 1;
    if(invalid)return out[0]!=0u||out[1]!=0u;
    pl_u64 quotient,remainder;
    /* Independent CPU operation, never evaluated on an invalid dividend. */
    __asm__ volatile("divq %[divisor]":"=a"(quotient),"=d"(remainder):"a"(low),"d"(high),[divisor]"r"(divisor):"cc");
    if(out[0]!=quotient||out[1]!=remainder){fprintf(stderr,"unsigned quotient differs %016llx:%016llx / %016llx\n",
        (unsigned long long)high,(unsigned long long)low,(unsigned long long)divisor);return 1;}
    return 0;
}
int main(void)
{
    _Alignas(8) pl_u8 scratch[65536];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
    if(pl_x86_unsigned_divide_plan(&arena,&plan))return 1;
    const pl_u64 words[]={0u,1u,2u,3u,0xffffffffu,0x100000000ull,0x100000001ull,
        0x7fffffffffffffffull,0x8000000000000000ull,0x80000000ffffffffull,~1ull,~0ull};
    pl_u32 comparisons=0u;pl_u64 seed=0x2468ace113579bdfull;
    for(pl_u32 d=0u;d<sizeof words/sizeof words[0];++d)for(pl_u32 h=0u;h<sizeof words/sizeof words[0];++h)
    for(pl_u32 l=0u;l<sizeof words/sizeof words[0];++l){if(compare(&plan,words[h],words[l],words[d]))return 1;++comparisons;}
    for(pl_u32 bit=0u;bit<64u;++bit){pl_u64 d=1ull<<bit;
        for(pl_u32 l=0u;l<sizeof words/sizeof words[0];++l){if(compare(&plan,d-1u,words[l],d)||compare(&plan,d,words[l],d))return 1;comparisons+=2u;}}
    for(pl_u32 n=0u;n<1000000u;++n){pl_u64 d=random_word(&seed),h=random_word(&seed),l=random_word(&seed);
        if((n&3u)&&d)h%=d;
        if((n&31u)==0u)h=d?d-1u:0u;
        if(compare(&plan,h,l,d))return 1;
        ++comparisons;}
    printf("Unsigned 128/64 SSA: %u independent divq/fault cases, %u abstract nodes / span %u / arena %u; NOT execution/minimum claim\n",
        comparisons,plan.node_count,plan.span,arena.used);return 0;
}
