#include "x87-hardware.h"
#include <stdio.h>
#ifdef _WIN32
enum { ROWS=128 };
static machine_state records[ROWS][2];static pl_u64 operands[ROWS];static pl_u8 faults[ROWS];
static volatile LONG armed,trapped;static uintptr_t target_rip,resume_rip;
static LONG CALLBACK precision_exception(EXCEPTION_POINTERS *e)
{
    if(!armed||e->ExceptionRecord->ExceptionCode!=EXCEPTION_FLT_INEXACT_RESULT||e->ContextRecord->Rip!=target_rip)return EXCEPTION_CONTINUE_SEARCH;
    trapped=1;armed=0;e->ContextRecord->Rip=resume_rip;return EXCEPTION_CONTINUE_EXECUTION;
}
static void put(pl_u8 *p,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(x>>(i*8u));}
static pl_u64 random_word(pl_u64 *s){*s^=*s<<13u;*s^=*s>>7u;*s^=*s<<17u;return *s;}
static int save(const char *dir,unsigned form,const char *suffix,const void *data,size_t n)
{
    char name[4096];int m=snprintf(name,sizeof name,"%s/scalar-integer-float-%u.%s",dir,form,suffix);if(m<1||(size_t)m>=sizeof name)return 1;
    FILE *f=fopen(name,"wbx");if(!f)return 1;int bad=fwrite(data,1u,n,f)!=n;if(fclose(f))bad=1;return bad;
}
#endif
int main(int argc,char **argv)
{
#ifndef _WIN32
    (void)argc;(void)argv;return 2;
#else
    if(argc!=2)return 2;
    pl_u8 *code=check_x87_allocate(8192u);if(!code)return 1;
    PVOID handler=AddVectoredExceptionHandler(1u,precision_exception);if(!handler)return 1;
    const pl_u8 targets[]={0u,5u,7u,9u,15u};
    const pl_u64 edges[]={0u,1u,~0ull,0x8000000000000000ull,0x7fffffffffffffffull,0x8000000000000001ull,0x01000000u,0x01000001u,
        0x01000003u,0xfffffffffeffffffull,0xfffffffffefffffdull,0x7fffffffu,0x80000000u,0x7fffffc0u,0x80000040u,0x40000001u,
        0x0020000000000000ull,0x0020000000000001ull,0x0020000000000003ull,0xffdfffffffffffffull,0x0040000000000001ull,0xffbfffffffffffffull,
        0x7ffffffffffffbffull,0x7ffffffffffffc00ull,0x7ffffffffffffc01ull,0x80000000000003ffull,0x8000000000000400ull,0x8000000000000401ull,
        0x4000000000000001ull,0xbfffffffffffffffull,0x00000000ffffffffull,0xabcdef017fffffffull};
    unsigned form=0u;pl_u64 seed=0x3aea0034fac12e77ull;
    for(unsigned input=4u;input<=8u;input+=4u)for(unsigned output=4u;output<=8u;output+=4u)
    for(unsigned dst=0u;dst<5u;++dst)for(unsigned memory=0u;memory<2u;++memory)for(unsigned rc=0u;rc<4u;++rc)
    for(unsigned modes=0u;modes<2u;++modes)for(unsigned unmask=0u;unmask<2u;++unmask)for(unsigned prefix=0u;prefix<2u;++prefix,++form){
        unsigned target=targets[dst],n=0u;DWORD old;if(!VirtualProtect(code,4096u,PAGE_READWRITE,&old))return 1;
        if(prefix)code[n++]=0x67u;
        code[n++]=(pl_u8)(output==4u?0xf3u:0xf2u);
        unsigned rex=(input==8u?8u:0u)|(target>=8u?4u:0u);if(rex)code[n++]=(pl_u8)(0x40u|rex);
        code[n++]=0x0fu;code[n++]=0x2au;code[n++]=(pl_u8)((memory?0u:0xc0u)|((target&7u)<<3u)|(memory?5u:0u));
        if(memory){put(code+n,4096u-n-4u,4u);n+=4u;}code[n]=0xc3u;
        if(!VirtualProtect(code,4096u,PAGE_EXECUTE_READ,&old)||!FlushInstructionCache(GetCurrentProcess(),code,n+1u))return 1;
        target_rip=(uintptr_t)code;resume_rip=(uintptr_t)(code+n);
        for(unsigned row=0u;row<ROWS;++row){unsigned top=row&7u;_Alignas(16) pl_u8 image[512]={0},before[512],after[512];pl_u16 tags[2];
            pl_u64 value=row<64u?edges[row&31u]:random_word(&seed);operands[row]=value;put(code+4096u,value,8u);
            put(image,0x37fu,2u);put(image+2u,0x4700u|(top<<11u),2u);image[4]=(pl_u8)(row&8u?0x5au:255u);
            put(image+6u,0x123u,2u);put(image+8u,0x12340000u,8u);put(image+16u,0x56780000u,8u);
            put(image+24u,(0x1f80u&~(unmask?4096u:0u))|(rc<<13u)|(modes?0x8040u:0u)|(row&16u?0x3fu:0u),4u);
            for(unsigned r=0u;r<8u;++r){unsigned logical=(r+8u-top)&7u;put(image+32u+logical*16u,random_word(&seed),8u);put(image+40u+logical*16u,0x3fffu,2u);}
            for(unsigned r=0u;r<32u;++r)put(image+160u+r*8u,random_word(&seed),8u);
            machine_state *a=records[row],*b=a+1u;memset(a,0,sizeof *a);for(unsigned r=0u;r<16u;++r)a->registers[r]=0xabcdef0123450000ull+r;
            if(!memory)a->registers[0]=value;
            a->rip=0x400000u;a->rflags=0xa92u|(row&1u);a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=1568u;a->efer=0xd00u;
            a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
            trapped=0;armed=1;check_x87_hardware_full(a,b,code,image,before,after,tags);armed=0;
            check_x87_project(a,before);check_x87_project(b,after);a->x87_tag=tags[0];b->x87_tag=tags[1];faults[row]=(pl_u8)!!trapped;
            if(!trapped){b->rip+=n;++b->retired;}
        }
        char json[256];int m=snprintf(json,sizeof json,"{\"sourceBytes\":%u,\"stateBytes\":%zu,\"native\":%u,\"bytes\":%u,\"operandOffset\":4096,\"rc\":%u,\"input\":%u,\"output\":%u,\"modes\":%u,\"unmask\":%u}\n",n,sizeof(machine_state),ROWS,memory?input:0u,rc,input,output,modes,unmask);
        if(m<1||(size_t)m>=sizeof json||save(argv[1],form,"json",json,(size_t)m)||save(argv[1],form,"source",code,n)
            ||save(argv[1],form,"cases",records,sizeof records)||save(argv[1],form,"integers",operands,sizeof operands)||save(argv[1],form,"faults",faults,sizeof faults))return 1;
    }
    if(!RemoveVectoredExceptionHandler(handler)||!VirtualFree(code,0u,MEM_RELEASE))return 1;
    printf("CVTSI2SS/SD: %u profiles/%u complete RAX/FP/MXCSR/tag/flags rows\n",form,form*ROWS);return 0;
#endif
}
