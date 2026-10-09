#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[64][2];static pl_u8 initial[64][16],written[64][16];
static void put(pl_u8 *at,pl_u64 value,unsigned n)
{for(unsigned i=0u;i<n;++i)at[i]=(pl_u8)(value>>(i*8u));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t bytes)
{
    char name[4096];int n=snprintf(name,sizeof name,"%s/x87-float-store-%u.%s",dir,form,suffix);
    if(n<1||(size_t)n>=sizeof name)return 1;
    FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,bytes,file)!=bytes;if(fclose(file))bad=1;return bad;
}
static void sample(unsigned row,unsigned width,pl_u64 *sig,pl_u16 *se)
{
    static const pl_u64 values[]={0u,0u,0x8000000000000000ull,0x8000000000000001ull,
        0x8000000000000000ull,0xc000000000000000ull,1u,0x7fffffffffffffffull,
        0x8000000000000000ull,0x8000000000000000ull,~0ull,0x8000000000000000ull,
        0xc000000000000001ull,0x8000000000000001ull,1u,0x8000000000000000ull};
    static const pl_u16 exponents[]={0u,0x8000u,0x3fffu,0x3fffu,0xbfffu,0x3fffu,0u,0u,0u,1u,0x7ffeu,0x7fffu,0x7fffu,0x7fffu,1u,0x3fffu};
    row&=31u;if(row<16u){*sig=values[row];*se=exponents[row];return;}
    unsigned fraction=width==4u?23u:52u,bias=width==4u?127u:1023u,min=16384u-bias,max=16383u+bias;
    *sig=0x8000000000000000ull;unsigned exponent=min;
    switch(row){case 16:break;case 17:--exponent;*sig=~0ull;break;case 18:--exponent;break;
    case 19:exponent-=fraction;break;case 20:exponent-=fraction+1u;break;case 21:exponent-=fraction+2u;break;
    case 22:exponent-=fraction+1u;++*sig;break;case 23:exponent-=fraction+1u;*sig=~0ull;break;
    case 24:exponent=max;*sig=~0ull;break;case 25:exponent=max;break;case 26:exponent=max+1u;break;
    case 27:exponent=max+10u;++*sig;break;case 28:exponent=0x3fffu;*sig+=1ull<<(62u-fraction);break;
    case 29:exponent=0x3fffu;*sig+=(1ull<<(63u-fraction))+(1ull<<(62u-fraction));break;
    case 30:exponent=0x7fffu;*sig=0x4000000000000000ull;break;default:exponent=0u;*sig=1u;break;}
    *se=(pl_u16)exponent;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    const unsigned masks[]={0u,1u,2u,8u,16u,32u,57u},register_masks[]={0u,1u,32u};
    const pl_u8 primary[]={0xd9u,0xd9u,0xddu,0xddu,0xdbu},groups[]={2u,3u,2u,3u,7u},widths[]={4u,4u,8u,8u,10u};
    for(unsigned form=0u;form<260u;++form){unsigned memory=form<140u,kind=memory?form%5u:(form-140u)%40u,
        mode=memory?form/5u:(form-140u)/40u,rc=memory?mode%4u:0u,mask=memory?masks[mode/4u]:register_masks[mode],
        width=memory?widths[kind]:10u,length=memory?6u:2u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        code[0]=memory?primary[kind]:(pl_u8)(kind<16u?0xddu:kind<32u?0xdfu:0xd9u);
        code[1]=memory?(pl_u8)((groups[kind]<<3u)|5u):(pl_u8)((kind<8u||(kind>=16u&&kind<24u)?0xd0u:0xd8u)+(kind&7u));
        if(memory)put(code+2u,4090u,4u);
        code[length]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,length+1u))return 1;
        for(unsigned row=0u;row<64u;++row){unsigned top=(row+form)&7u;pl_u64 sig;pl_u16 se,tags[2];sample(row,width,&sig,&se);
            se^=(pl_u16)((form&1u)<<15u);_Alignas(16) pl_u8 input[512]={0},before[512],after[512];
            put(input,(0x37fu|(rc<<10u))&~mask,2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4]=(pl_u8)(row>=32u?255u&~(1u<<top):255u);put(input+6u,0x123u,2u);
            put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned rank=0u;rank<8u;++rank){unsigned logical=(rank+8u-top)&7u;
                put(input+32u+logical*16u,0x8000000000000000ull+rank,8u);put(input+40u+logical*16u,0x3fffu,2u);}
            put(input+32u,sig,8u);put(input+40u,se,2u);memset(initial[row],0x5a,16u);memcpy(code+4096u,initial[row],16u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);
            for(unsigned rank=0u;rank<16u;++rank)a->registers[rank]=0xabcdef0123450000ull+rank;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            check_x87_hardware_full(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);
            a->x87_tag=tags[0];b->x87_tag=tags[1];if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
            if(b->x87_dp==(pl_u64)(uintptr_t)(code+4096u))b->x87_dp=a->rip+4096u;
            memcpy(written[row],code+4096u,16u);b->rip+=length;++b->retired;
        }
        char json[256];int n=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":64,\"bytes\":%u,\"store\":%s,\"operandOffset\":4096,\"operandStride\":16,\"writtenStride\":16,\"rc\":%u,\"unmask\":%u}\n",length,sizeof(machine_state),memory?width:0u,memory?"true":"false",rc,mask);
        if(n<1||(size_t)n>=sizeof json||save(argv[1],form,"json",json,(size_t)n)||save(argv[1],form,"source",code,length)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",initial,sizeof initial)||save(argv[1],form,"written",written,sizeof written))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    puts("Floating stores: 260 independent memory/register forms,16640 complete FPU/tag/flags/memory observations");return 0;
#endif
}
