#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[64][2];static pl_u8 operands[64][16],written[64][16];
static const char *prefix_name="x87-bcd";
static void put(pl_u8 *at,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)at[i]=(pl_u8)(x>>(8u*i));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t size)
{char name[4096];int n=snprintf(name,sizeof name,"%s/%s-%u.%s",dir,prefix_name,form,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
 FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,size,file)!=size;if(fclose(file))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    unsigned store=argc==3&&!strcmp(argv[2],"--store");if(argc!=2&&!store)return 2;
    if(store)prefix_name="x87-bcd-store";
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;pl_u64 seed=0x81a234bc45ef6789ull;
    const pl_u64 special[]={0u,1u,9u,10u,99u,100u,99999999u,100000000u,999999999999999999ull};
    for(unsigned form=0u;form<(store?256u:128u);++form){unsigned mode=form&(store?127u:63u),pc=mode&3u,rc=(mode>>2u)&3u,full=(mode>>4u)&1u,
        unmask=(mode>>5u)&1u,unmask_p=store?(mode>>6u)&1u:0u,prefix=form>>(store?7u:6u),n=0u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(prefix)code[n++]=0x66u;
        code[n++]=0xdfu;code[n++]=(pl_u8)(store?0x35u:0x25u);put(code+n,4096u-n-4u,4u);n+=4u;code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(unsigned row=0u;row<64u;++row){unsigned top=row&7u,next=(top+7u)&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,(0x7fu|(pc<<8u)|(rc<<10u))&~unmask&~(unmask_p?32u:0u),2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4]=(pl_u8)(store?(full?255u&~(1u<<top):255u):(full?255u:255u&~(1u<<next)));
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned rank=0u;rank<8u;++rank){put(input+32u+rank*16u,0x8000000000000000ull+rank,8u);put(input+40u+rank*16u,0x3fffu,2u);}
            seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;
            pl_u64 magnitude=row<18u?special[row/2u]:seed%1000000000000000000ull;memset(operands[row],0,16u);
            for(unsigned digit=0u;digit<18u;++digit){pl_u8 d=(pl_u8)(magnitude%10u);magnitude/=10u;operands[row][digit/2u]|=(pl_u8)(d<<((digit&1u)*4u));}
            operands[row][9]=(pl_u8)(row&1u?128u:0u);memcpy(code+4096u,operands[row],16u);
            if(store){pl_u64 sig=0u;pl_u16 se=0u;unsigned index=row/2u;
                pl_u64 value=index==0u?0u:index==1u?1u:index>=4u&&index<=8u?(index==4u?999999999999999999ull:1000000000000000000ull):index==9u?2u:seed%2000000000000000000ull;
                if(value){unsigned leading=(unsigned)__builtin_clzll(value);sig=value<<leading;se=(pl_u16)(16383u+63u-leading);}
                if(index==2u){sig=0x8000000000000000ull;se=0x3ffeu;} // 0.5
                if(index==3u){sig=0xc000000000000000ull;se=0x3fffu;} // 1.5
                if(index==6u)sig-=8u; // 10^18 - 0.5
                if(index==7u)sig+=8u; // 10^18 + 0.5
                if(index==8u)--sig;
                if(index==9u)sig+=1ull<<61u; // 2.5
                if(index==10u){sig=0x8000000000000000ull;se=0x7fffu;}
                if(index==11u){sig=0xc000000000000001ull;se=0x7fffu;}
                if(index==12u){sig=0x8000000000000001ull;se=0x7fffu;}
                if(index==13u){sig=1u;se=1u;}
                if(index==14u){sig=1u;se=0u;}
                if(index==15u){sig=~0ull;se=0x7ffeu;}
                se=(pl_u16)(se|(row&1u?0x8000u:0u));put(input+32u,sig,8u);put(input+40u,se,2u);
                for(unsigned byte=0u;byte<16u;++byte)operands[row][byte]=(pl_u8)(0x5au^row*17u^byte*37u);
                memcpy(code+4096u,operands[row],16u);
            }
            machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
            for(unsigned rank=0u;rank<16u;++rank)first->registers[rank]=0xabcdef0123450000ull+rank;
            first->rip=0x400000u;first->rflags=0xa92u;first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;first->retired=42u;*last=*first;
            check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
            if(store)memcpy(written[row],code+4096u,16u);
            first->x87_tag=tags[0];last->x87_tag=tags[1];
            if(last->x87_ip==(pl_u64)(uintptr_t)code)last->x87_ip=first->rip;
            if(last->x87_dp==(pl_u64)(uintptr_t)(code+4096u))last->x87_dp=first->rip+4096u;
            last->rip+=n;++last->retired;
        }
        char json[256];int j=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":64,\"bytes\":10,\"operandOffset\":4096,\"operandStride\":16,\"store\":%u,\"writtenStride\":16}\n",n,store);
        if(j<1||(size_t)j>=sizeof json||save(argv[1],form,"json",json,(size_t)j)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands)
            ||(store&&save(argv[1],form,"written",written,sizeof written)))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("%s:%u independent full-state observations, PC/RC/full/IM/PM/prefix and signed18-digit/zero/boundary cases\n",prefix_name,store?16384u:8192u);return 0;
#endif
}
