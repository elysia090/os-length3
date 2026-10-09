#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[256][2];static pl_u8 operands[256][16];
static void put(pl_u8 *at,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)at[i]=(pl_u8)(x>>(i*8u));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t size)
{char name[4096];int n=snprintf(name,sizeof name,"%s/packed-shift-%u.%s",dir,form,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
 FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,size,file)!=size;if(fclose(file))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    for(unsigned form=0u;form<48u;++form){unsigned wide=form/24u,family=(form/3u)%8u,role=form%3u,width=family<3u?16u:family<6u?32u:64u,
        left=family==0u||family==3u||family==6u,arithmetic=family==2u||family==5u,length=wide?5u:4u;DWORD previous;
        for(unsigned row=0u;row<256u;++row){if(!VirtualProtect(code,4096u,PAGE_READWRITE,&previous))return 1;
            unsigned at=0u;if(wide)code[at++]=0x66u;code[at++]=0x0fu;
            if(!role){code[at++]=(pl_u8)(width==16u?0x71u:width==32u?0x72u:0x73u);code[at++]=(pl_u8)(0xc1u|((left?6u:arithmetic?4u:2u)<<3u));code[at++]=(pl_u8)row;}
            else{code[at++]=(pl_u8)(arithmetic?width==16u?0xe1u:0xe2u:(left?0xf0u:0xd0u)+(width==16u?1u:width==32u?2u:3u));
                code[at++]=(pl_u8)(role==1u?0xc8u:0x0du);if(role==2u){put(code+at,4096u-at-4u,4u);at+=4u;}}
            length=at;code[at]=0xc3u;
            if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&previous)||!FlushInstructionCache(GetCurrentProcess(),code,at+1u))return 1;
            _Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];unsigned top=row&7u;
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=0x55u;
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned rank=0u;rank<8u;++rank){unsigned logical=(rank+8u-top)&7u;
                put(input+32u+logical*16u,0x8123456789abcdefull+row*11u+rank*37u,8u);put(input+40u+logical*16u,0x3fffu+rank,2u);}
            for(unsigned rank=0u;rank<32u;++rank)put(input+160u+rank*8u,0x8123456789abcdefull+row*11u+rank*37u,8u);
            pl_u64 count=row<128u?row:row<192u?(1ull<<32u)|(row&15u):~0ull-row;
            if(role==1u){if(wide){put(input+160u,count,8u);put(input+168u,0xdeadbeef12345678ull,8u);}
                else put(input+32u+((8u-top)&7u)*16u,count,8u);}
            put(operands[row],count,8u);put(operands[row]+8u,0xdeadbeef12345678ull,8u);memcpy(code+4096u,operands[row],16u);
            machine_state *first=records[row],*last=first+1u;memset(first,0,sizeof *first);
            for(unsigned rank=0u;rank<16u;++rank)first->registers[rank]=0xabcdef0123450000ull+rank;
            first->rip=0x400000u;first->rflags=0xa92u;first->cr0=0x80010031u;first->cr3=0x1000u;first->cr4=0x620u;first->efer=0xd00u;
            first->system[MACHINE_SYSTEM_CS]=19u;first->system[MACHINE_SYSTEM_DR0+7u]=0x400u;first->retired=42u;*last=*first;
            check_x87_hardware_full(first,last,code,input,before,after,tags);check_x87_project(first,before);check_x87_project(last,after);
            first->x87_tag=tags[0];last->x87_tag=tags[1];last->rip+=length;++last->retired;
            // Immediate rows have distinct source bytes; each row is therefore
            // its own immutable compiler input, not a repaired native result.
            if(!role){char json[192];int n=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":1,\"bytes\":0}\n",length);
                unsigned index=form*256u+row;
                if(n<1||(size_t)n>=sizeof json||save(argv[1],index,"json",json,(size_t)n)||save(argv[1],index,"source",code,length)
                    ||save(argv[1],index,"cases",records[row],sizeof records[row]))return 1;}
        }
        if(role){char json[192];int n=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":256,\"bytes\":%u,\"operandOffset\":4096,\"operandStride\":16}\n",length,role==2u?(wide?16u:8u):0u);
            unsigned index=form*256u;
            if(n<1||(size_t)n>=sizeof json||save(argv[1],index,"json",json,(size_t)n)||save(argv[1],index,"source",code,length)
                ||save(argv[1],index,"cases",records,sizeof records)||save(argv[1],index,"integers",operands,sizeof operands))return 1;}
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    puts("Packed shift: 12288 independent full FPU/XMM/flags/tag observations, all immediate bytes and oversized 64-bit counts");return 0;
#endif
}
