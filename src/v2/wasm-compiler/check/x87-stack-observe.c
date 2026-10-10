#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[1024][2];static const char *prefix="x87-stack";
static void put(pl_u8 *at,pl_u64 value,pl_u32 bytes)
{for(pl_u32 i=0u;i<bytes;++i)at[i]=(pl_u8)(value>>(i*8u));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t bytes)
{
    char name[4096];int n=snprintf(name,sizeof name,"%s/%s-%u.%s",dir,prefix,form,suffix);
    if(n<1||(size_t)n>=sizeof name)return 1;
    FILE *file=fopen(name,"wbx");if(!file)return 1;
    int bad=fwrite(data,1u,bytes,file)!=bytes;if(fclose(file))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int examine=argc==3&&!strcmp(argv[2],"--examine");if(argc!=2&&!examine)return 2;
    if(examine)prefix="x87-examine";
    pl_u8 *code=check_x87_allocate(4096u);if(!code)return 1;
    const pl_u8 prefixes[]={0u,0x66u,0x67u,0x48u,0x64u,0x65u,0xf2u,0xf3u};
    const pl_u64 sigs[]={0u,1u,0x8000000000000000ull,0x8000000000000001ull,0u,1u,0x8000000000000000ull,
        0x8000000000000001ull,0xc000000000000000ull,0x7fffffffffffffffull,0x8000000000000000ull,
        0x8000000000000001ull,0xc000000000000001ull,0u,1u,0x7fffffffffffffffull};
    const pl_u16 exps[]={0u,0u,0u,0u,1u,1u,1u,1u,0x3fffu,0x3fffu,0x7fffu,0x7fffu,0x7fffu,0x7fffu,0x7fffu,0x7fffu};
    unsigned rows=examine?1024u:128u;
    for(unsigned form=0u;form<(examine?8u:144u);++form){DWORD previous;unsigned law=form/8u,p=form&7u,length=0u;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))return 1;
        if(p)code[length++]=prefixes[p];
        code[length++]=(pl_u8)(examine?0xd9u:law<8u?0xdd:law<16u?0xdf:0xd9);code[length++]=(pl_u8)(examine?0xe5u:law<16u?0xc0+(law&7u):law==16u?0xf6:0xf7);code[length]=0xc3;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,length+1u))return 1;
        for(unsigned row=0u;row<rows;++row){unsigned top=examine?(row>>4u)&7u:row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,0x37fu|((row>>3u)&3u)<<10u,2u);put(input+2u,(top<<11u)|((row&8u)?0x4700u:0u),2u);
            input[4]=(pl_u8)(examine?((row>>7u)&3u)==0u?255u:((row>>7u)&3u)==1u?0u:((row>>7u)&3u)==2u?0x55u:0xaau:row<32u?255u:row<64u?0u:row<96u?0x55u:0xaau);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned rank=0u;rank<8u;++rank){unsigned logical=(rank+8u-top)&7u;
                put(input+32u+logical*16u,0x8000000000000000ull+rank*123u,8u);put(input+40u+logical*16u,0x3fffu,2u);}
            if(examine){put(input+32u,sigs[row&15u],8u);put(input+40u,exps[row&15u]|((row&512u)?0x8000u:0u),2u);}
            for(unsigned rank=0u;rank<32u;++rank)put(input+160u+rank*8u,0x123456789abc0000ull+rank,8u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);
            for(unsigned rank=0u;rank<16u;++rank)a->registers[rank]=0xabcdef0123450000ull+rank;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            check_x87_hardware_full(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);
            a->x87_tag=tags[0];b->x87_tag=tags[1];if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
            b->rip+=length;++b->retired;
        }
        char json[192];int n=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":%u,\"bytes\":0,\"fullTagObserved\":true}\n",length,sizeof(machine_state),rows);
        if(n<1||(size_t)n>=sizeof json||save(argv[1],form,"json",json,(size_t)n)||save(argv[1],form,"source",code,length)
            ||save(argv[1],form,"cases",records,rows*sizeof records[0]))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    if(examine)puts("FXAM: 8 encodings / 8192 full FPU/flags/tag observations");
    else puts("FFREE/FFREEP/TOP: 144 independent encodings, 18432 full FPU/flags/tag observations; other GPR invariance architectural");
    return 0;
#endif
}
