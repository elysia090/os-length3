#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[512][2];
typedef struct {pl_u64 sig;pl_u16 se;} raw;
static const raw values[]={
    {0x8000000000000000ull,0x3fffu},{0u,0u},{1u,0u},{0x8000000000000001ull,0x7fffu},
    {0xc000000000000001ull,0xffffu},{1u,1u},{0x8123456789abcdefull,0xbfffu},{0x8000000000000000ull,0x7fffu}
};
static void put(pl_u8 *at,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)at[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t size)
{char name[4096];int n=snprintf(name,sizeof name,"%s/x87-transfer-%u.%s",dir,form,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
 FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,size,file)!=size;if(fclose(file))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(4096u);if(!code)return 1;
    for(unsigned form=0u;form<73u;++form){DWORD previous;unsigned other=form<64u?form&7u:0u;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))return 1;
        code[0]=(pl_u8)(form<64u?form<32u?0xdau:0xdbu:0xd9u);
        code[1]=(pl_u8)(form<64u?0xc0u+((form>>3u)&3u)*8u+other:form<66u?0xe0u+(form-64u):0xe8u+(form-66u));code[2]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,3u))return 1;
        for(unsigned row=0u;row<512u;++row){unsigned top=row&7u,empties=(row>>3u)&3u,flags=(row>>5u)&7u;
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,(0x37fu|(((row>>6u)&3u)<<10u))&~((row>>8u)&1u),2u);put(input+2u,0x4700u|(top<<11u),2u);
            input[4]=255u;
            // Constants write TOP-1; their overflow matrix uses that slot.
            unsigned destination=form>=66u?(top+7u)&7u:top;
            if(empties&1u)input[4]&=(pl_u8)~(1u<<destination);
            if((empties&2u)&&form<64u)input[4]&=(pl_u8)~(1u<<((top+other)&7u));
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned rank=0u;rank<8u;++rank){unsigned logical=(rank+8u-top)&7u;const raw *value=values+((row>>5u)+rank)%8u;
                put(input+32u+logical*16u,value->sig,8u);put(input+40u+logical*16u,value->se,2u);}
            machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
            for(unsigned rank=0u;rank<16u;++rank)first->registers[rank]=0xabcdef0123450000ull+rank;
            first->rip=0x400000u;first->rflags=0xa92u|(flags&1u)|((flags&2u)<<1u)|((flags&4u)<<4u);
            first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;first->retired=42u;*last=*first;
            check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
            first->x87_tag=tags[0];last->x87_tag=tags[1];if(last->x87_ip==(pl_u64)(uintptr_t)code)last->x87_ip=first->rip;
            last->rip+=2u;++last->retired;
        }
        char json[160];int n=snprintf(json,sizeof json,"{\"sourceBytes\":2,\"stateBytes\":%zu,\"native\":512,\"bytes\":0,\"fullTagObserved\":true}\n",sizeof(machine_state));
        if(n<1||(size_t)n>=sizeof json||save(argv[1],form,"json",json,(size_t)n)||save(argv[1],form,"source",code,2u)
            ||save(argv[1],form,"cases",records,sizeof records))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    puts("FCMOV/sign/constants: 73 independent encodings,37376 full FPU/tag/flags observations including masked/unmasked stack outcomes");return 0;
#endif
}
