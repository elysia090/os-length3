#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[8192][2];static pl_u64 operands[8192];
static void put(pl_u8 *at,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)at[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,const char *suffix,const void *data,size_t size)
{char name[4096];int n=snprintf(name,sizeof name,"%s/x87-control-0.%s",dir,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
 FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,size,file)!=size;if(fclose(file))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    code[0]=0xd9u;code[1]=0x2du;put(code+2u,4090u,4u);code[6]=0xc3u;DWORD previous;
    if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,7u))return 1;
    for(unsigned row=0u;row<8192u;++row){_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];unsigned top=row&7u;
        put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u)|((row>>6u)&63u),2u);input[4]=0x55u;
        put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
        for(unsigned rank=0u;rank<8u;++rank){unsigned logical=(rank+8u-top)&7u;put(input+32u+logical*16u,0x8000000000000000ull+rank,8u);put(input+40u+logical*16u,0x3fffu,2u);}
        operands[row]=(row*40503u+12345u)&65535u;put(code+4096u,operands[row],2u);
        machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
        for(unsigned rank=0u;rank<16u;++rank)first->registers[rank]=0xabcdef0123450000ull+rank;
        first->rip=0x400000u;first->rflags=0xa92u;first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
        first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;first->retired=42u;*last=*first;
        check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
        first->x87_tag=tags[0];last->x87_tag=tags[1];last->rip+=6u;++last->retired;
    }
    const char json[]="{\"sourceBytes\":6,\"stateBytes\":1256,\"native\":8192,\"bytes\":2,\"operandOffset\":4096,\"operandStride\":8,\"fullTagObserved\":true}\n";
    if(save(argv[1],"json",json,sizeof json-1u)||save(argv[1],"source",code,6u)||save(argv[1],"cases",records,sizeof records)||save(argv[1],"integers",operands,sizeof operands))return 1;
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    puts("FLDCW: 8192 independent raw-word/pending/full-tag/FPU/flags observations");return 0;
#endif
}
