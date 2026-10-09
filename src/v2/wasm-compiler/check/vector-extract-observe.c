#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
static machine_state records[32][2];
static void put(pl_u8 *p,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(x>>(8u*i));}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t n)
{char path[4096];int m=snprintf(path,sizeof path,"%s/vector-extract-%u.%s",dir,form,suffix);if(m<1||(size_t)m>=sizeof path)return 1;
 FILE *file=fopen(path,"wbx");if(!file)return 1;int bad=fwrite(data,1u,n,file)!=n;if(fclose(file))bad=1;return bad;}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(4096u);if(!code)return 1;
    pl_u64 seed=0x98173564abfce023ull;
    for(unsigned form=0u;form<1024u;++form){unsigned control=form&255u,mmx=(form>>8u)&1u,wide=form>>9u,n=0u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(!mmx)code[n++]=0x66u;
        // This observer captures actual RAX; other GPRs are invariance-only.
        code[n++]=(pl_u8)(wide?0x48u:0x40u);code[n++]=0x0fu;code[n++]=0xc5u;code[n++]=0xc3u;code[n++]=(pl_u8)control;code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        for(unsigned row=0u;row<32u;++row){unsigned top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=(pl_u8)(row&8u?0x5au:255u);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);put(input+24u,0x1f80u,4u);
            for(unsigned r=0u;r<8u;++r){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;unsigned logical=(r+8u-top)&7u;
                put(input+32u+logical*16u,seed,8u);put(input+40u+logical*16u,r%3u?0x3fffu:0u,2u);}
            for(unsigned r=0u;r<32u;++r){seed^=seed<<13u;seed^=seed>>7u;seed^=seed<<17u;put(input+160u+r*8u,seed,8u);}
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(unsigned r=0u;r<16u;++r)a->registers[r]=0xabcdef0123450000ull+r;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=1568u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            check_x87_hardware_full(a,b,code,input,before,after,tags);check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tags[1];b->rip+=n;++b->retired;
        }
        char json[128];int m=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":1256,\"native\":32,\"bytes\":0}\n",n);
        if(m<1||(size_t)m>=sizeof json||save(argv[1],form,"json",json,(size_t)m)||save(argv[1],form,"source",code,n)||save(argv[1],form,"cases",records,sizeof records))return 1;
    }
    if(!VirtualFree(code,0u,MEM_RELEASE))return 1;
    puts("PEXTRW:32768 complete physical states; all immediates, MMX/XMM and ignored REX.W");return 0;
#endif
}
