#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
enum { ROWS=48 };
static machine_state records[ROWS][2];static pl_u8 operands[ROWS][16],faults[ROWS];
static volatile LONG armed,trapped;static uintptr_t target_rip,resume_rip;
static LONG CALLBACK fp_exception(EXCEPTION_POINTERS *e)
{
    DWORD code=e->ExceptionRecord->ExceptionCode;
    if(!armed||e->ContextRecord->Rip!=target_rip||
        (code!=EXCEPTION_FLT_INVALID_OPERATION&&code!=EXCEPTION_FLT_DENORMAL_OPERAND&&code!=EXCEPTION_FLT_DIVIDE_BY_ZERO
         &&code!=EXCEPTION_FLT_OVERFLOW&&code!=EXCEPTION_FLT_UNDERFLOW&&code!=EXCEPTION_FLT_INEXACT_RESULT))return EXCEPTION_CONTINUE_SEARCH;
    trapped=1;armed=0;e->ContextRecord->Rip=resume_rip;return EXCEPTION_CONTINUE_EXECUTION;
}
static void put(pl_u8 *p,pl_u64 value,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(value>>(i*8u));}
static pl_u64 random_word(pl_u64 *s){*s^=*s<<13u;*s^=*s>>7u;*s^=*s<<17u;return *s;}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t n)
{
    char name[4096];int m=snprintf(name,sizeof name,"%s/float-arithmetic-%u.%s",dir,form,suffix);if(m<1||(size_t)m>=sizeof name)return 1;
    FILE *f=fopen(name,"wbx");if(!f)return 1;int bad=fwrite(data,1u,n,f)!=n;if(fclose(f))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    int minmax=argc==3&&!strcmp(argv[2],"--minmax");
    int predicate=argc==3&&!strcmp(argv[2],"--predicate");
    if(argc!=2&&!minmax&&!predicate)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    PVOID handler=AddVectoredExceptionHandler(1u,fp_exception);if(!handler)return 1;
    const pl_u32 floats[]={0u,0x80000000u,0x3f800000u,0xbf800000u,0x3fc00000u,0xbfc00000u,0x7f800000u,0xff800000u,
        0x7fc12345u,0xffc12345u,0x7f812345u,0xff812345u,1u,0x80000001u,0x007fffffu,0x807fffffu,
        0x00800000u,0x80800000u,0x3f7fffffu,0xbf7fffffu,0x7f7fffffu,0xff7fffffu,0x7fc00000u,0x7f800001u};
    const pl_u64 doubles[]={0u,0x8000000000000000ull,0x3ff0000000000000ull,0xbff0000000000000ull,0x3ff8000000000000ull,0xbff8000000000000ull,0x7ff0000000000000ull,0xfff0000000000000ull,
        0x7ff8123456789abcull,0xfff8123456789abcull,0x7ff0123456789abcull,0xfff0123456789abcull,1u,0x8000000000000001ull,0x000fffffffffffffull,0x800fffffffffffffull,
        0x0010000000000000ull,0x8010000000000000ull,0x3fefffffffffffffull,0xbfefffffffffffffull,0x7fefffffffffffffull,0xffefffffffffffffull,0x7ff8000000000000ull,0x7ff0000000000001ull};
    unsigned form=0u;pl_u64 seed=0xdf714adb255b36edull;
    for(unsigned width=4u;width<=8u;width+=4u)for(unsigned packed=0u;packed<(minmax||predicate?1u:2u);++packed)for(unsigned op=minmax?4u:0u;op<(minmax?6u:predicate?8u:4u);++op)
    for(unsigned memory=0u;memory<2u;++memory)for(unsigned profile=0u;profile<16u;++profile)for(unsigned mask=0u;mask<8u;++mask,++form){
        unsigned target=9u,source=7u,n=0u;DWORD old;
        if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(packed){if(width==8u)code[n++]=0x66u;}else code[n++]=(pl_u8)(width==8u?0xf2u:0xf3u);
        code[n++]=0x44u;code[n++]=0x0fu;code[n++]=(pl_u8)(predicate?0xc2u:op==0u?0x58u:op==1u?0x59u:op==2u?0x5cu:op==3u?0x5eu:op==4u?0x5du:0x5fu);
        code[n++]=(pl_u8)((memory?0u:0xc0u)|((target&7u)<<3u)|(memory?5u:source));
        if(memory){put(code+n,4096u-n-4u-(predicate?1u:0u),4u);n+=4u;}
        if(predicate)code[n++]=(pl_u8)(op|(profile<<4u));
        code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        target_rip=(uintptr_t)code;resume_rip=(uintptr_t)(code+n);
        for(unsigned row=0u;row<ROWS;++row){unsigned top=row&7u;_Alignas(16) pl_u8 input[512]={0},before[512],after[512];pl_u16 tags[2];
            put(input,0x37fu,2u);put(input+2u,0x4700u|(top<<11u),2u);input[4]=(pl_u8)(row&8u?0x5au:255u);
            put(input+6u,0x123u,2u);put(input+8u,0x12340000u,8u);put(input+16u,0x56780000u,8u);
            unsigned clear=mask==7u?63u:mask?1u<<(mask-1u):0u;
            put(input+24u,(0x1f80u&~(clear<<7u))|((profile&3u)<<13u)|((profile&4u)?64u:0u)|((profile&8u)?32768u:0u),4u);
            for(unsigned r=0u;r<8u;++r){unsigned logical=(r+8u-top)&7u;put(input+32u+logical*16u,random_word(&seed),8u);put(input+40u+logical*16u,0x3fffu,2u);}
            for(unsigned r=0u;r<32u;++r)put(input+160u+r*8u,random_word(&seed),8u);
            for(unsigned lane=0u;lane<16u/width;++lane){unsigned first=(row+lane*5u)%24u,second=(row*7u+row/24u+5u+lane*3u)%24u;
                pl_u64 av=row<40u?(width==8u?doubles[first]:floats[first]):random_word(&seed),bv=row<40u?(width==8u?doubles[second]:floats[second]):random_word(&seed);
                put(operands[row]+lane*width,bv,width);put(input+160u+target*16u+lane*width,av,width);
                if(!memory)put(input+160u+source*16u+lane*width,bv,width);
            }
            memcpy(code+4096u,operands[row],16u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(unsigned r=0u;r<16u;++r)a->registers[r]=0xabcdef0123450000ull+r;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=1568u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            trapped=0;armed=1;check_x87_hardware_full(a,b,code,input,before,after,tags);armed=0;
            check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tags[1];faults[row]=(pl_u8)!!trapped;
            if(!trapped){b->rip+=n;++b->retired;}
        }
        char json[256];int m=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":%u,\"bytes\":%u,\"operandOffset\":4096,\"operandStride\":16,\"width\":%u,\"packed\":%u,\"op\":%u}\n",n,sizeof(machine_state),ROWS,memory?(packed?16u:width):0u,width,packed,op);
        if(m<1||(size_t)m>=sizeof json||save(argv[1],form,"json",json,(size_t)m)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands)||save(argv[1],form,"faults",faults,sizeof faults))return 1;
    }
    if(!RemoveVectoredExceptionHandler(handler)||!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("SSE %s: %u profiles/%u complete FP/MXCSR/tag/flags rows\n",minmax?"min/max":predicate?"predicates":"add/sub/mul/div",form,form*ROWS);return 0;
#endif
}
