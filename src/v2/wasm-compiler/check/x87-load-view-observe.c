#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
typedef struct {pl_u64 sig;pl_u16 se;pl_u8 empty;} value;
static const value values[]={
    {0u,0u,0u},{0x8000000000000000ull,0x3fffu,0u},{1u,0u,0u},{0x8000000000000000ull,0u,0u},
    {0x8000000000000001ull,0x7fffu,0u},{0xc000000000000001ull,0xffffu,0u},{1u,1u,0u},{0x8000000000000000ull,0x3fffu,1u}
};
static machine_state records[64][2];static pl_u8 operands[64][16];
static void put(pl_u8 *at,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)at[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t bytes)
{
    char name[4096];int n=snprintf(name,sizeof name,"%s/x87-load-view-%u.%s",dir,form,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
    FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,bytes,file)!=bytes;if(fclose(file))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    for(unsigned form=0u;form<132u;++form){unsigned kind=form%33u,mode=form/33u,memory=!kind,exchange=kind>=9u,
        index=kind<9u?(kind?kind-1u:0u):(kind-9u)&7u,length=memory?6u:2u,full=mode&1u,unmask=mode>>1u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        code[0]=memory?0xdbu:!exchange?0xd9u:kind<17u?0xd9u:kind<25u?0xddu:0xdfu;
        code[1]=memory?0x2du:(pl_u8)((exchange?0xc8u:0xc0u)|index);
        if(memory)put(code+2u,4090u,4u);
        code[length]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,length+1u))return 1;
        for(unsigned row=0u;row<64u;++row){unsigned top=(row+form)&7u,next=(top+7u)&7u,other=(top+index)&7u;
            const value *a=values+(row&7u),*b=values+(row>>3u);_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,(0x37fu|((row&3u)<<10u))&~unmask,2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4]=(pl_u8)(full?255u:255u&~(1u<<next));put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned r=0u;r<8u;++r){unsigned logical=(r+8u-top)&7u;put(input+32u+logical*16u,0x8000000000000000ull+r,8u);put(input+40u+logical*16u,0x3fffu,2u);}
            if(exchange){put(input+32u,a->sig,8u);put(input+40u,a->se,2u);if(a->empty)input[4]&=(pl_u8)~(1u<<top);}
            if(!memory){const value *v=exchange?b:a;put(input+32u+index*16u,v->sig,8u);put(input+40u+index*16u,v->se,2u);
                if(v->empty)input[4]&=(pl_u8)~(1u<<other);else input[4]|=(pl_u8)(1u<<other);}
            memset(operands[row],0,16u);put(operands[row],a->sig,8u);put(operands[row]+8u,a->se,2u);memcpy(code+4096u,operands[row],16u);
            machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
            for(unsigned r=0u;r<16u;++r)first->registers[r]=0xabcdef0123450000ull+r;
            first->rip=0x400000u;first->rflags=0xa92u|(row&1u);first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;first->retired=42u;*last=*first;
            check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
            first->x87_tag=tags[0];last->x87_tag=tags[1];if(last->x87_ip==(pl_u64)(uintptr_t)code)last->x87_ip=first->rip;
            if(last->x87_dp==(pl_u64)(uintptr_t)(code+4096u))last->x87_dp=first->rip+4096u;
            last->rip+=length;++last->retired;
        }
        char json[256];int n=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":64,\"bytes\":%u,\"operandOffset\":4096,\"operandStride\":16,\"unmask\":%u}\n",length,sizeof(machine_state),memory?10u:0u,unmask);
        if(n<1||(size_t)n>=sizeof json||save(argv[1],form,"json",json,(size_t)n)||save(argv[1],form,"source",code,length)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    puts("Extended load/exchange: 132 independent forms,8448 complete FPU/flags/full-tag states");return 0;
#endif
}
