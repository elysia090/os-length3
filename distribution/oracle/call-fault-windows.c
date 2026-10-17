/* Independent Windows-native CALL fault observations, not an equivalence
 * pass. Windows exception codes are not x86 vector numbers. This observer
 * does not link any product/compiler/VM code and never retries a red as green. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cpuid.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern void call_fault_windows_enter(const uint64_t *,uint64_t,const void *);
extern void call_fault_windows_resume(void);
extern uint64_t call_fault_windows_stack;
static uint64_t actual[16],fault_rip,fault_flags,exception_address;
static DWORD fault_code;
static volatile LONG armed,seen;
static LONG CALLBACK record_exception(EXCEPTION_POINTERS *exception)
{
    __asm__ volatile("cld" ::: "cc");
    if(!armed || exception->ExceptionRecord->ExceptionCode!=EXCEPTION_ACCESS_VIOLATION)
        return EXCEPTION_CONTINUE_SEARCH;
    const CONTEXT *context=exception->ContextRecord;
    if(context->Rip!=0x400000u && context->Rip!=0x8000000000000000ull)
        return EXCEPTION_CONTINUE_SEARCH;
    const uint64_t registers[]={context->Rax,context->Rcx,context->Rdx,context->Rbx,
        context->Rsp,context->Rbp,context->Rsi,context->Rdi,context->R8,context->R9,
        context->R10,context->R11,context->R12,context->R13,context->R14,context->R15};
    memcpy(actual,registers,sizeof actual);fault_rip=context->Rip;fault_flags=context->EFlags;
    fault_code=exception->ExceptionRecord->ExceptionCode;
    exception_address=(uint64_t)(uintptr_t)exception->ExceptionRecord->ExceptionAddress;
    seen=1;armed=0;
    /* Resume the native observer, never the faulting test instruction. */
    exception->ContextRecord->Rsp=call_fault_windows_stack;
    exception->ContextRecord->Rip=(DWORD64)(uintptr_t)call_fault_windows_resume;
    exception->ContextRecord->EFlags&=~(DWORD)0x100u;
    return EXCEPTION_CONTINUE_EXECUTION;
}
static uint64_t random_word(uint64_t *seed)
{ *seed^=*seed<<13;*seed^=*seed>>7;*seed^=*seed<<17;return *seed; }
int main(int argc,char **argv)
{
    unsigned repetitions=512u;
    if(argc>2)return 2;
    if(argc==2) {
        char *end;unsigned long n=strtoul(argv[1],&end,10);
        if(!*argv[1] || *end || n<1 || n>100000)return 2;
        repetitions=(unsigned)n;
    }
    static const unsigned char sources[][5]={{0xff,0xd0},{0xff,0x10},{0xff,0x10},
        {0x43,0xff,0x54,0xb5,0x7f},{0xff,0x54,0x24,0xf8},{0x41,0xff,0xd4}};
    static const unsigned sizes[]={2,2,2,5,4,3},ends[]={4088,4093,4096,4080};
    static const uint64_t flags[]={0x202,0xa12,0x613};
    static const uint64_t reproduced[]={0xfc1238424f40a5f9ull,0x30fe5bd9faac7af2ull,
        0x26f8b476d017de87ull,0x35470589a264b0faull,0x12340ff8,0x9600c724cf4debd5ull,
        0xa31847d6a2572542ull,0x7c3aa5e49629b88ull,0x95048ffb8759bcbfull,
        0x152f2bb111a3c006ull,0x86957d76ef7c4606ull,0x86d97d3fab67ff0aull,
        0x8000000000000000ull,0x176ec353a8682010ull,0xb0fe9d57f992f450ull,0xf6d0120ce726c5b8ull};
    const uint64_t entry=0x400000,base=0x12340000,target=0x8000000000000000ull;
    unsigned char *code=VirtualAlloc((void *)(uintptr_t)entry,65536,MEM_RESERVE|MEM_COMMIT,PAGE_EXECUTE_READWRITE);
    /* Windows VEH dispatch uses the faulting user stack, unlike sigaltstack.
     * Reserve ample native handler stack below the same exact test RSP. */
    unsigned char *arena=VirtualAlloc((void *)(uintptr_t)(base-0x40000),0x60000,
        MEM_RESERVE|MEM_COMMIT,PAGE_READWRITE);
    if(code!=(void *)(uintptr_t)entry || arena!=(void *)(uintptr_t)(base-0x40000))return 1;
    unsigned char *ram=arena+0x40000;
    void *handler=AddVectoredExceptionHandler(1,record_exception);if(!handler)return 1;
    unsigned a,b,c,d;const unsigned leaves[]={0,1,0x40000000};
    for(unsigned i=0;i<3;++i) {
        __cpuid(leaves[i],a,b,c,d);
        printf("CALL-WINDOWS cpuid %x %08x %08x %08x %08x\n",leaves[i],a,b,c,d);
    }
    unsigned total=0,all_stored=0,all_untouched=0,all_original=0,all_advanced=0,all_rf=0;
    uint64_t seed=0xcabbedadd00dab1eull;
    for(unsigned form=0;form<6;++form)for(unsigned edge=0;edge<4;++edge)
        for(unsigned f=0;f<3;++f)for(unsigned history=0;history<3;++history) {
        memcpy(code,sources[form],sizes[form]);if(!FlushInstructionCache(GetCurrentProcess(),code,sizes[form]))return 1;
        unsigned stored=0,untouched=0,original=0,advanced=0,rf=0;
        uint64_t before=form==0 || form==5?0x5a5a5a5a5a5a5a5aull:target;
        for(unsigned repeat=0;repeat<repetitions;++repeat) {
            DWORD old;DWORD protection=history==0?PAGE_READWRITE:history==1?PAGE_READONLY:PAGE_NOACCESS;
            if(!VirtualProtect(ram+4096,4096,protection,&old)
                    || !VirtualProtect(ram+4096,4096,PAGE_READWRITE,&old))return 1;
            uint64_t gpr[16];for(unsigned i=0;i<16;++i)gpr[i]=random_word(&seed);
            if(form==5)memcpy(gpr,reproduced,sizeof gpr);
            gpr[4]=base+ends[edge]+8;memcpy(ram+ends[edge],&before,8);
            if(form==0)gpr[0]=target;
            else if(form==1) {gpr[0]=base+128;memcpy(ram+128,&target,8);}
            else if(form==2)gpr[0]=base+ends[edge];
            else if(form==3) {gpr[14]&=127;gpr[13]=base+ends[edge]-127-gpr[14]*4;}
            else if(form==5)gpr[12]=target;
            seen=0;armed=1;call_fault_windows_enter(gpr,flags[f],code);armed=0;
            uint64_t expected[16];memcpy(expected,gpr,sizeof expected);expected[4]-=8;
            int original_frame=fault_rip==entry && !memcmp(gpr,actual,sizeof gpr);
            int advanced_frame=fault_rip==target && !memcmp(expected,actual,sizeof expected);
            if(!seen || fault_code!=EXCEPTION_ACCESS_VIOLATION || exception_address!=fault_rip
                    || (fault_flags&~0x10000ull)!=flags[f] || (!original_frame && !advanced_frame)) {
                fprintf(stderr,"CALL-WINDOWS frame red %u %u %u %u %u code=%lx rip=%llx flags=%llx\n",
                    form,edge,f,history,repeat,(unsigned long)fault_code,
                    (unsigned long long)fault_rip,(unsigned long long)fault_flags);return 1;
            }
            original+=(unsigned)original_frame;advanced+=(unsigned)advanced_frame;
            rf+=(unsigned)!!(fault_flags&0x10000ull);
            uint64_t after;memcpy(&after,ram+ends[edge],8);
            if(after==entry+sizes[form])++stored;
            else if(after==before)++untouched;
            else {fputs("CALL-WINDOWS unknown payload\n",stderr);return 1;}
        }
        total+=repetitions;all_stored+=stored;all_untouched+=untouched;
        all_original+=original;all_advanced+=advanced;all_rf+=rf;
        printf("CALL-WINDOWS row %u %u %u %u %u %u %u %u %u %u\n",
            form,edge,f,history,repetitions,stored,untouched,original,advanced,rf);
    }
    printf("CALL-WINDOWS complete %u %u %u %u %u %u\n",total,all_stored,all_untouched,all_original,all_advanced,all_rf);
    if(!RemoveVectoredExceptionHandler(handler) || !VirtualFree(code,0,MEM_RELEASE)
            || !VirtualFree(arena,0,MEM_RELEASE))return 1;
    return 0;
}
