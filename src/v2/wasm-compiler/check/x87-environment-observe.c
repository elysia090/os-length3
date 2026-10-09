#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[256][2];static pl_u8 operands[256][128],written[256][128];
static void put(pl_u8 *at,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)at[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t size)
{char name[4096];int n=snprintf(name,sizeof name,"%s/x87-environment-%u.%s",dir,form,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
 FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,size,file)!=size;if(fclose(file))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    for(unsigned form=0u;form<8u;++form){unsigned op=form>>1u,narrow=form&1u,restore=op&1u,full=op>=2u,
            env=narrow?14u:28u,bytes=env+(full?80u:0u),length=narrow?7u:6u;DWORD previous;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))return 1;
        unsigned at=0u;if(narrow)code[at++]=0x66u;code[at++]=(pl_u8)(full?0xddu:0xd9u);code[at++]=(pl_u8)(restore?0x25u:0x35u);
        put(code+at,4096u-length,4u);code[length]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,length+1u))return 1;
        for(unsigned row=0u;row<256u;++row){unsigned top=row&7u,newtop=(row>>3u)&7u;
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u)|((row>>6u)&3u),2u);input[4]=(pl_u8)(row<128u?0x55u:0xaau);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u+row,8u);put(input+16u,0x56780000u+row,8u);put(input+24u,0x1f80u,4u);
            for(unsigned rank=0u;rank<8u;++rank){unsigned logical=(rank+8u-top)&7u;
                put(input+32u+logical*16u,0x8000000000000000ull+rank,8u);put(input+40u+logical*16u,0x3fffu,2u);}
            memset(operands[row],0xa5,128u);
            if(restore){unsigned step=narrow?2u:4u;
                put(operands[row],(row*40503u+12345u)&65535u,2u);put(operands[row]+step,0x8080u|(newtop<<11u)|((row>>5u)&63u),2u);
                put(operands[row]+step*2u,(row*41719u+301u)&65535u,2u);
                put(operands[row]+step*3u,0x87654321u+row,narrow?2u:4u);
                put(operands[row]+step*4u,0x7654u,2u);if(!narrow)put(operands[row]+18u,0xf123u+row,2u);
                put(operands[row]+step*5u,0x12345678u+row,narrow?2u:4u);put(operands[row]+step*6u,0x5432u,2u);
                if(full)for(unsigned rank=0u;rank<8u;++rank){put(operands[row]+env+rank*10u,0x8123456789abcdefull+row+rank,8u);
                    put(operands[row]+env+rank*10u+8u,0xbfffu+rank,2u);}
            }
            memcpy(code+4096u,operands[row],128u);
            machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
            for(unsigned rank=0u;rank<16u;++rank)first->registers[rank]=0xabcdef0123450000ull+rank;
            first->rip=0x400000u;first->rflags=0xa92u;first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=32u;first->efer=0xd00u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;first->retired=42u;*last=*first;
            check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
            first->x87_tag=tags[0];last->x87_tag=tags[1];memcpy(written[row],code+4096u,128u);last->rip+=length;++last->retired;
        }
        char json[256];int n=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":256,\"bytes\":%u,\"operandOffset\":4096,\"operandStride\":128,\"writtenStride\":128,\"store\":%s,\"fullTagObserved\":true}\n",length,bytes,restore?"false":"true");
        if(n<1||(size_t)n>=sizeof json||save(argv[1],form,"json",json,(size_t)n)||save(argv[1],form,"source",code,length)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands)||save(argv[1],form,"written",written,sizeof written))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    puts("FNSTENV/FLDENV/FNSAVE/FRSTOR: 2048 independent exact memory/FPU/full-tag/flags observations");return 0;
#endif
}
