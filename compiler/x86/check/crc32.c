#include <x86/semantics.h>
#include "scalar-plan.h"
#include <stdio.h>
static pl_u32 table[256];
int main(void)
{
    for(pl_u32 byte=0u;byte<256u;++byte){pl_u32 value=byte;
        for(pl_u32 bit=0u;bit<8u;++bit)value=(value>>1u)^((value&1u)?0x82f63b78u:0u);
        table[byte]=value;}
    pl_u64 seed=0x6372633332636173ull;unsigned comparisons=0u;
    for(pl_u32 bits=8u;bits<=64u;bits*=2u){
        _Alignas(8) pl_u8 scratch[98304];pl_arena arena={scratch,sizeof scratch,0u};pl_plan plan;
        int status=pl_x86_crc32_plan(bits,&arena,&plan);if(status){fprintf(stderr,"CRC32 plan bits%u status%d used%llu\n",bits,status,(unsigned long long)arena.used);return 1;}
        for(pl_u32 n=0u;n<65536u;++n){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
            pl_u64 inputs[]={seed^0xa5a5a5a500000000ull,n<256u?n:seed*0x9e3779b97f4a7c15ull},result;
            pl_u32 expected=(pl_u32)inputs[0];for(pl_u32 i=0u;i<bits/8u;++i)expected=(expected>>8u)^table[(expected^(pl_u32)(inputs[1]>>(i*8u)))&255u];
            pl_u64 native=inputs[0],before,after;
#define OBSERVE(OP,SRC,DST) __asm__ volatile("pushfq;pop %[before];" OP " " SRC "," DST ";pushfq;pop %[after]" \
                :[crc]"+a"(native),[before]"=&r"(before),[after]"=&r"(after):[data]"c"(inputs[1]):"cc","memory")
            switch(bits){case 8u:OBSERVE("crc32b","%b[data]","%k[crc]");break;
                case 16u:OBSERVE("crc32w","%w[data]","%k[crc]");break;
                case 32u:OBSERVE("crc32l","%k[data]","%k[crc]");break;
                default:OBSERVE("crc32q","%q[data]","%q[crc]");break;}
#undef OBSERVE
            if(check_scalar_projection(&plan,inputs,&result,1u)||result!=expected||result!=native||before!=after)return 1;
            ++comparisons;
        }
    }
    printf("CRC32C: %u independent native/byte-table/SSA comparisons and unchanged full flags, all operand widths\n",comparisons);return 0;
}
