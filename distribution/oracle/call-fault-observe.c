/* Observe, do not prescribe, near CALL's payload on a noncanonical target.
 * An architectural fault frame and its RAM side effects are separate facts.
 * This fixture has no product/compiler dependency and never treats a retry
 * as a successful test. It is also an isolated diagnostic initramfs /init. */
#define _GNU_SOURCE
#include <cpuid.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/reboot.h>
#include <ucontext.h>
#include <unistd.h>

extern void call_fault_enter(const uint64_t *, uint64_t, const void *);
static unsigned char alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static uint64_t actual[16], fault_flags, fault_vector, fault_error, fault_rip;
static void exception(int number, siginfo_t *info, void *pointer)
{
    (void)number; (void)info;
    __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,
        REG_RSI,REG_RDI,REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (unsigned i=0;i<16;++i) actual[i]=(uint64_t)context->uc_mcontext.gregs[ranks[i]];
    fault_flags=(uint64_t)context->uc_mcontext.gregs[REG_EFL];
    fault_vector=(uint64_t)context->uc_mcontext.gregs[REG_TRAPNO];
    fault_error=(uint64_t)context->uc_mcontext.gregs[REG_ERR];
    fault_rip=(uint64_t)context->uc_mcontext.gregs[REG_RIP];
    trapped=1; siglongjmp(recovery,1);
}
static void observe(const uint64_t *gpr, uint64_t flags, const void *code)
{ trapped=0; if (!sigsetjmp(recovery,1)) call_fault_enter(gpr,flags,code); }
static uint64_t random_word(uint64_t *seed)
{ *seed^=*seed<<13; *seed^=*seed>>7; *seed^=*seed<<17; return *seed; }
static int run(unsigned repetitions)
{
    static const unsigned char sources[][5]={
        {0xff,0xd0},                 /* call *%rax */
        {0xff,0x10},                 /* call *(%rax), disjoint target */
        {0xff,0x10},                 /* call *(%rax), target/stack alias */
        {0x43,0xff,0x54,0xb5,0x7f}, /* call *127(%r13,%r14,4), alias */
        {0xff,0x54,0x24,0xf8},       /* call *-8(%rsp), alias */
        {0x41,0xff,0xd4},            /* call *%r12, reproduced full-fixture red */
    };
    static const unsigned sizes[]={2,2,2,5,4,3};
    static const unsigned ends[]={4088,4093,4096,4080};
    static const uint64_t flags[]={0x202,0xa12,0x613};
    static const uint64_t reproduced[16]={
        0xfc1238424f40a5f9ull,0x30fe5bd9faac7af2ull,0x26f8b476d017de87ull,0x35470589a264b0faull,
        0x12340ff8,0x9600c724cf4debd5ull,0xa31847d6a2572542ull,0x7c3aa5e49629b88ull,
        0x95048ffb8759bcbfull,0x152f2bb111a3c006ull,0x86957d76ef7c4606ull,0x86d97d3fab67ff0aull,
        0x8000000000000000ull,0x176ec353a8682010ull,0xb0fe9d57f992f450ull,0xf6d0120ce726c5b8ull,
    };
    const uint64_t entry=0x400000,base=0x12340000,target=0x8000000000000000ull;
    unsigned char *code=mmap((void *)(uintptr_t)entry,4096,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    unsigned char *ram=mmap((void *)(uintptr_t)base,8192,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    if (code==MAP_FAILED || ram==MAP_FAILED) return 1;
    stack_t old_stack, stack={.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv,old_bus,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if (sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_segv)
        || sigaction(SIGBUS,&action,&old_bus)) return 1;
    unsigned a,b,c,d;
    __cpuid(0,a,b,c,d);
    printf("CALL-FAULT cpu %08x %08x %08x %08x\n",a,b,c,d);
    __cpuid(1,a,b,c,d);
    printf("CALL-FAULT feature %08x %08x %08x %08x\n",a,b,c,d);
    __cpuid(0x40000000,a,b,c,d);
    printf("CALL-FAULT hypervisor %08x %08x %08x %08x\n",a,b,c,d);
    unsigned total=0,mixed=0,advanced=0;
    uint64_t seed=0xcabbedadd00dab1eull;
    for (unsigned form=0;form<6;++form) for (unsigned edge=0;edge<4;++edge)
        for (unsigned f=0;f<3;++f) for (unsigned history=0;history<3;++history) {
        memcpy(code,sources[form],sizes[form]);
        unsigned stored=0,untouched=0,original_frames=0,advanced_frames=0;
        uint64_t before=form==0 || form==5 ? 0x5a5a5a5a5a5a5a5aull : target;
        for (unsigned repeat=0;repeat<repetitions;++repeat) {
            /* Match permission transitions in the larger oracle, but restore
             * full write permission BEFORE executing the tested instruction. */
            int protection=history==0 ? PROT_READ|PROT_WRITE : history==1 ? PROT_READ : PROT_NONE;
            if (mprotect(ram+4096,4096,protection)
                || mprotect(ram+4096,4096,PROT_READ|PROT_WRITE)) return 1;
            uint64_t gpr[16];
            for (unsigned i=0;i<16;++i) gpr[i]=random_word(&seed);
            if (form==5) memcpy(gpr,reproduced,sizeof gpr);
            gpr[4]=base+ends[edge]+8;
            memcpy(ram+ends[edge],&before,8);
            if (form==0) gpr[0]=target;
            else if (form==1) { gpr[0]=base+128; memcpy(ram+128,&target,8); }
            else if (form==2) gpr[0]=base+ends[edge];
            else if (form==3) { gpr[14]&=127; gpr[13]=base+ends[edge]-127-gpr[14]*4; }
            else if (form==5) gpr[12]=target;
            observe(gpr,flags[f],code);
            int original_frame=fault_rip==entry && !memcmp(gpr,actual,sizeof gpr);
            uint64_t expected[16]; memcpy(expected,gpr,sizeof expected); expected[4]-=8;
            int advanced_frame=fault_rip==target && !memcmp(expected,actual,sizeof expected);
            if (!trapped || fault_vector!=13 || fault_error
                || fault_flags!=(flags[f]|0x10000) || (!original_frame && !advanced_frame)) {
                fprintf(stderr,"CALL-FAULT frame red %u %u %u %u %u vector=%llu error=%llx rip=%llx flags=%llx\n",
                    form,edge,f,history,repeat,(unsigned long long)fault_vector,
                    (unsigned long long)fault_error,(unsigned long long)fault_rip,
                    (unsigned long long)fault_flags);
                return 1;
            }
            /* These are distinct observations, not interchangeable expected
             * frames. In particular, a committed RSP/RIP is NOT equivalence
             * to the original-instruction #GP required by the product check. */
            if (original_frame) ++original_frames;
            else { ++advanced_frames; ++advanced; }
            uint64_t after; memcpy(&after,ram+ends[edge],8);
            if (after==entry+sizes[form]) ++stored;
            else if (after==before) ++untouched;
            else {
                fprintf(stderr,"CALL-FAULT unknown payload %u %u %u %u %u before=%llx after=%llx\n",
                    form,edge,f,history,repeat,(unsigned long long)before,(unsigned long long)after);
                return 1;
            }
            ++total;
        }
        if (stored && untouched) ++mixed;
        printf("CALL-FAULT row %u %u %u %u %u %u %u %u %u\n",form,edge,f,history,
            repetitions,stored,untouched,original_frames,advanced_frames);
    }
    if (sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGBUS,&old_bus,NULL)
        || sigaltstack(&old_stack,NULL) || munmap(code,4096) || munmap(ram,8192)) return 1;
    printf("CALL-FAULT complete %u %u %u\n",total,mixed,advanced);
    return 0;
}
int main(int argc, char **argv)
{
    unsigned repetitions=512;
    if (argc>2) return 2;
    if (argc==2) {
        char *end; unsigned long n=strtoul(argv[1],&end,10);
        if (!*argv[1] || *end || n<1 || n>100000) return 2;
        repetitions=(unsigned)n;
    }
    int status=run(repetitions);
    if (status) puts("CALL-FAULT error");
    fflush(NULL);
    /* The external reference process uses -no-reboot; stop only that oracle.
     * This diagnostic has no dependency on guest ACPI poweroff support. */
    if (getpid()==1) { reboot(RB_AUTOBOOT); for (;;) pause(); }
    return status;
}
