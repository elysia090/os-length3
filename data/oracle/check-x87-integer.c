#include <softfloat.h>
#include "../../src/v2/x86/check/scalar-plan.h"
#include <stdio.h>
#include <stdint.h>
#include <string.h>
int main(void)
{
    pl_u64 seed=0x393baa2470ffd912ull;pl_u32 samples=0u,max_nodes=0u,max_span=0u;
    const pl_u32 widths[]={16u,32u,64u};
    for(pl_u32 w=0u;w<3u;++w){_Alignas(8) pl_u8 scratch[32768];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        int status=pl_x86_x87_integer_plan(widths[w],&arena,&plan);if(status){fprintf(stderr,"integer plan %u: %d\n",widths[w],status);return 1;}
        if(plan.node_count>max_nodes)max_nodes=plan.node_count;
        if(plan.span>max_span)max_span=plan.span;
        pl_u32 count=widths[w]==16u?65536u:20000u;
        for(pl_u32 i=0u;i<count;++i){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
            pl_u64 x=widths[w]==16u?i:i==0u?0u:i==1u?1u:i==2u?~0ull:i==3u?1ull<<(widths[w]-1u):i==4u?(1ull<<(widths[w]-1u))-1u:seed;
            pl_u64 bits=x;
            if(widths[w]<64u){pl_u64 mask=(1ull<<widths[w])-1u,sign=1ull<<(widths[w]-1u);bits=((bits&mask)^sign)-sign;}
            int64_t value;memcpy(&value,&bits,sizeof value);softfloat_exceptionFlags=0u;
            extFloat80_t expected=i64_to_extF80(value);pl_u64 input[]={x,0u,0u,0u,0u},output[3]={0u};
            if(check_scalar_plan(&plan,input,output)||output[0]!=expected.signif||output[1]!=expected.signExp||output[2]!=(value==0)
                ||softfloat_exceptionFlags){fprintf(stderr,"signed %u mismatch at %u: %016llx/%04llx tag=%llu expected=%016llx/%04x\n",widths[w],i,
                    (unsigned long long)output[0],(unsigned long long)output[1],(unsigned long long)output[2],
                    (unsigned long long)expected.signif,(unsigned)expected.signExp);return 1;}
            ++samples;
        }
    }
    printf("{\"format\":\"signed-integer-ext80-ssa-v1\",\"status\":\"pass\",\"samples\":%u,\"maxAbstractWork\":%u,\"maxAbstractSpan\":%u,\"oracle\":\"official SoftFloat 3e i64_to_extF80\"}\n",samples,max_nodes,max_span);return 0;
}
