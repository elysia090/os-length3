#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
enum { ROWS=64 };
static machine_state records[ROWS][2];static pl_u64 operands[ROWS][2];static pl_u8 faults[ROWS];
static volatile LONG armed,trapped;static uintptr_t target_rip,resume_rip;
static LONG CALLBACK conversion_exception(EXCEPTION_POINTERS *e)
{
    DWORD code=e->ExceptionRecord->ExceptionCode;
    if(!armed||(code!=EXCEPTION_FLT_INEXACT_RESULT&&code!=EXCEPTION_FLT_INVALID_OPERATION)||e->ContextRecord->Rip!=target_rip)return EXCEPTION_CONTINUE_SEARCH;
    trapped=1;armed=0;e->ContextRecord->Rip=resume_rip;return EXCEPTION_CONTINUE_EXECUTION;
}
static void put(pl_u8 *p,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(x>>(i*8u));}
static pl_u64 random_word(pl_u64 *s){*s^=*s<<13u;*s^=*s>>7u;*s^=*s<<17u;return *s;}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t n)
{
    char name[4096];int m=snprintf(name,sizeof name,"%s/vector-float-integer-%u.%s",dir,form,suffix);if(m<1||(size_t)m>=sizeof name)return 1;
    FILE *f=fopen(name,"wbx");if(!f)return 1;int bad=fwrite(data,1u,n,f)!=n;if(fclose(f))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int rounded_mode=argc==3&&!strcmp(argv[2],"--rounded"),quad_mode=argc==3&&!strcmp(argv[2],"--quad");
    if(argc!=2&&!rounded_mode&&!quad_mode)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    PVOID handler=AddVectoredExceptionHandler(1u,conversion_exception);if(!handler)return 1;
    const pl_u8 targets[]={0u,5u,7u},sources[]={0u,7u,15u};
    const pl_u32 floats[]={0u,0x80000000u,0x3f800000u,0xbf800000u,0x3fc00000u,0xbfc00000u,0x3f000000u,0xbf000000u,
        0x4effffffu,0xceffffffu,0x4f000000u,0xcf000000u,0x4f000001u,0xcf000001u,0x7f800000u,0xff800000u,
        0x7fc12345u,0xffc12345u,0x7f812345u,0xff812345u,1u,0x80000001u,0x007fffffu,0x807fffffu,
        0x00800000u,0x80800000u,0x3f7fffffu,0xbf7fffffu,0x3fc00001u,0xbfc00001u,0x7f7fffffu,0xff7fffffu,
        0x5effffffu,0xdeffffffu,0x5f000000u,0xdf000000u,0x5f000001u,0xdf000001u,0x5d800000u,0xdd800000u};
    const pl_u64 doubles[]={0u,0x8000000000000000ull,0x3ff0000000000000ull,0xbff0000000000000ull,0x3ff8000000000000ull,0xbff8000000000000ull,0x3fe0000000000000ull,0xbfe0000000000000ull,
        0x41dfffffffc00000ull,0xc1dfffffffc00000ull,0x41e0000000000000ull,0xc1e0000000000000ull,0x41e0000000000001ull,0xc1e0000000000001ull,0x7ff0000000000000ull,0xfff0000000000000ull,
        0x7ff8123456789abcull,0xfff8123456789abcull,0x7ff0123456789abcull,0xfff0123456789abcull,1u,0x8000000000000001ull,0x000fffffffffffffull,0x800fffffffffffffull,
        0x0010000000000000ull,0x8010000000000000ull,0x41dfffffffe00000ull,0xc1e0000000100000ull,0x41dfffffffd00000ull,0xc1dfffffffd00000ull,0x7fefffffffffffffull,0xffefffffffffffffull,
        0x43dfffffffffffffull,0xc3dfffffffffffffull,0x43e0000000000000ull,0xc3e0000000000000ull,0x43e0000000000001ull,0xc3e0000000000001ull,0x43b0000000000000ull,0xc3b0000000000000ull};
    unsigned form=0u;pl_u64 seed=0x291a8f0305657badull;
    for(unsigned kind=quad_mode?8u:0u;kind<(quad_mode?10u:8u);++kind)for(unsigned dst=0u;dst<(kind>=3u&&kind<=6u?1u:3u);++dst)for(unsigned src=0u;src<4u;++src)
    for(unsigned rc=0u;rc<4u;++rc)for(unsigned daz=0u;daz<2u;++daz)for(unsigned masks=0u;masks<4u;++masks,++form){
        unsigned scalar=kind>=3u&&kind<=6u,wide=kind==2u||kind==4u||kind==6u||kind==7u;
        unsigned memory=src==3u,target=scalar?0u:kind>=7u?sources[dst]:targets[dst],source=memory?0u:sources[src],n=0u,bytes=kind>=8u?16u:scalar?(wide?8u:4u):wide?16u:8u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(scalar)code[n++]=(pl_u8)(wide?0xf2u:0xf3u);
        else if(kind==2u)code[n++]=0x66u;
        else if(kind==7u)code[n++]=(pl_u8)(rounded_mode?0xf2u:0x66u);
        else if(kind>=8u)code[n++]=(pl_u8)(kind==8u?0x66u:0xf3u);
        unsigned rex=(kind==5u||kind==6u?8u:0u)|(target>=8u?4u:0u)|(source>=8u?1u:0u);
        if(rex)code[n++]=(pl_u8)(0x40u|rex);
        code[n++]=0x0fu;code[n++]=(pl_u8)(kind>=8u?0x5bu:kind==7u?0xe6u:kind==1u||(rounded_mode&&scalar)?0x2du:0x2cu);
        code[n++]=(pl_u8)((memory?0u:0xc0u)|((target&7u)<<3u)|(memory?5u:source&7u));
        if(memory){put(code+n,4096u-n-4u,4u);n+=4u;}code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        target_rip=(uintptr_t)code;resume_rip=(uintptr_t)(code+n);
        for(unsigned row=0u;row<ROWS;++row){unsigned top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            unsigned first=row%40u,second=row<40u?(row*7u+5u)%40u:first;
            pl_u64 lo=wide?doubles[first]:(pl_u64)floats[first]|((pl_u64)floats[second]<<32u);
            pl_u64 hi=wide?doubles[second]:random_word(&seed);
            operands[row][0]=lo;operands[row][1]=hi;put(code+4096u,lo,8u);put(code+4104u,hi,8u);
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=(pl_u8)(row&8u?0x5au:255u);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);
            pl_u32 mxcsr=(0x1f80u&~((masks&1u?128u:0u)|(masks&2u?4096u:0u)))|(rc<<13u)|(daz<<6u)|(row&16u?0x3fu:0u);
            put(input+24u,mxcsr,4u);
            for(unsigned r=0u;r<8u;++r){unsigned logical=(r+8u-top)&7u;put(input+32u+logical*16u,random_word(&seed),8u);put(input+40u+logical*16u,0x3fffu,2u);}
            for(unsigned r=0u;r<32u;++r)put(input+160u+r*8u,random_word(&seed),8u);
            if(!memory){put(input+160u+source*16u,lo,8u);put(input+168u+source*16u,hi,8u);}
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(unsigned r=0u;r<16u;++r)a->registers[r]=0xabcdef0123450000ull+r;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=1568u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            trapped=0;armed=1;check_x87_hardware_full(a,b,code,input,before,after,tags);armed=0;
            check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tags[1];faults[row]=(pl_u8)!!trapped;
            if(!trapped){b->rip+=n;++b->retired;}
        }
        char json[256];int m=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":%u,\"bytes\":%u,\"operandOffset\":4096,\"operandStride\":16,\"rc\":%u,\"daz\":%u,\"masks\":%u}\n",n,sizeof(machine_state),ROWS,memory?bytes:0u,rc,daz,masks);
        if(m<1||(size_t)m>=sizeof json||save(argv[1],form,"json",json,(size_t)m)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands)||save(argv[1],form,"faults",faults,sizeof faults))return 1;
    }
    if(!RemoveVectoredExceptionHandler(handler)||!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("MMX/GPR32/GPR64/XMM floating conversion: %u forms/%u complete FP/MXCSR/tag/flags rows\n",form,form*ROWS);return 0;
#endif
}
