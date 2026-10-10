/* Independent physical x86 data observation; no product decoder or emitter. */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <xmmintrin.h>
#include <emmintrin.h>
int main(void)
{
    unsigned comparisons=0u;
    for(unsigned wide=0u;wide<2u;++wide){unsigned bytes=wide?16u:8u;
        for(unsigned mask=0u;mask<(1u<<bytes);++mask){
            _Alignas(16) uint8_t data[16],select[16],actual[64];
            unsigned offset=mask%17u;
            for(unsigned i=0u;i<16u;++i){data[i]=(uint8_t)(i*37u+mask);select[i]=(uint8_t)(((mask>>i)&1u)*128u|((i*7u+mask)&127u));}
            memset(actual,0xa5,sizeof actual);
            if(wide)_mm_maskmoveu_si128(_mm_loadu_si128((const __m128i *)(const void *)data),
                _mm_loadu_si128((const __m128i *)(const void *)select),(char *)actual+offset);
            else {
                /* Some compilers replace the MMX intrinsic with SSE2. Keep
                 * the actual eight-byte instruction in this CPU oracle. */
                __asm__ volatile("movq %0, %%mm0\n\tmovq %1, %%mm1\n\tmaskmovq %%mm1, %%mm0\n\temms"
                    : : "m"(data),"m"(select),"D"(actual+offset) : "mm0","mm1","memory");
            }
            _mm_sfence();
            for(unsigned i=0u;i<sizeof actual;++i){unsigned n=i-offset;
                uint8_t expected=i>=offset&&n<bytes&&((mask>>n)&1u)?data[n]:0xa5u;
                if(actual[i]!=expected){fprintf(stderr,"physical masked store %u/%u/%u\n",wide,mask,i);return 1;}}
            ++comparisons;
        }
    }
    printf("Physical x86 masked stores: %u all-mask memory observations; normal resident bytes only, not fault/FPU-state proof\n",comparisons);
    return 0;
}
