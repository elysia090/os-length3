#include "../core/memory-internal.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
int main(void)
{
    pl_u8 source[40],actual[40],expected[40];pl_u64 seed=0x1234567890abcdefull;
    pl_u32 comparisons=0u;
    for(pl_u32 row=0u;row<16384u;++row){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
        for(pl_u32 i=0u;i<40u;++i)source[i]=(pl_u8)(seed>>(i%8u*8u));
        for(pl_u32 n=1u;n<=8u;++n)for(pl_u32 offset=0u;offset<16u;++offset){
            pl_u64 reference=0u;for(pl_u32 i=0u;i<n;++i)reference|=(pl_u64)source[offset+i]<<(i*8u);
            if(vm_memory_load(source+offset,n)!=reference)return 1;
            memset(actual,0xa5,sizeof actual);memset(expected,0xa5,sizeof expected);
            for(pl_u32 i=0u;i<n;++i)expected[offset+i]=(pl_u8)(seed>>(i*8u));
            vm_memory_store(actual+offset,seed,n);if(memcmp(actual,expected,sizeof actual))return 1;++comparisons;
        }
    }
    // ASan red zones immediately follow the legal borrowed extent. A fast
    // width projection must never load/store a larger parent word.
    for(pl_u32 n=1u;n<=8u;++n){pl_u8 *p=malloc(n);if(!p)return 1;
        memset(p,0x5a,n);pl_u64 value=vm_memory_load(p,n);vm_memory_store(p,value,n);free(p);}
    printf("physical word access: %u unaligned exact-extent comparisons; allocation-edge guards\n",comparisons);
    return 0;
}
