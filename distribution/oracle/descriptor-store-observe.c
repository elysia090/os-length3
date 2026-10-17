/* Native reference observations only; never a guest execution implementation. */
#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>

static sigjmp_buf continuation;
static volatile sig_atomic_t vector;
static uint64_t error, fault_address, fault_rip, fault_flags;
static void fault(int number, siginfo_t *info, void *pointer)
{
    (void)number;
    ucontext_t *context=pointer;
    vector=(sig_atomic_t)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(uint64_t)context->uc_mcontext.gregs[REG_ERR];
    fault_address=(uint64_t)(uintptr_t)info->si_addr;
    fault_rip=(uint64_t)context->uc_mcontext.gregs[REG_RIP];
    fault_flags=(uint64_t)context->uc_mcontext.gregs[REG_EFL];
    siglongjmp(continuation,1);
}
static void observe(uint8_t *code, uint8_t *target)
{
    vector=0; error=0u; fault_address=0u; fault_rip=0u; fault_flags=0u;
    if (!sigsetjmp(continuation,1))
        ((void (*)(uint8_t *))(uintptr_t)code)(target);
}

int main(void)
{
    uint8_t *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_32BIT,-1,0);
    uint8_t *payload=mmap(NULL,8192u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_32BIT,-1,0);
    if (code==MAP_FAILED || payload==MAP_FAILED) { perror("mmap"); return 2; }
    struct sigaction action={.sa_sigaction=fault,.sa_flags=SA_SIGINFO};
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGSEGV,&action,NULL)) { perror("sigaction"); return 2; }
    uint8_t descriptor[10]; unsigned rows=0u;
    puts("{\"format\":\"native-descriptor-store-observation-v1\",\"rows\":[");
    for (unsigned table=0u;table<2u;++table)
    for (unsigned prefix=0u;prefix<3u;++prefix)
    for (unsigned address32=0u;address32<2u;++address32)
    for (unsigned end=0u;end<3u;++end)
    for (unsigned protection=0u;protection<3u;++protection) {
        unsigned offset=end==0u ? 4085u : end==1u ? 4086u : 4094u, at=0u;
        if (address32) code[at++]=0x67u;
        if (prefix) code[at++]=(uint8_t)(prefix==1u ? 0x66u : 0x48u);
        code[at++]=0x0fu; code[at++]=0x01u; code[at++]=(uint8_t)(0x07u+table*8u);
        code[at++]=0xc3u;
        if (mprotect(payload+4096u,4096u,PROT_READ|PROT_WRITE)) return 2;
        /* The address-size-32 instruction needs a low reference destination
         * too, not a stack pointer truncated to 32 bits. Route every native
         * call through a current signal continuation, including this probe. */
        observe(code,payload);
        if (vector) {
            fprintf(stderr,"reference descriptor capture faulted (trap %d)\n",vector);
            return 2;
        }
        memcpy(descriptor,payload,sizeof descriptor);
        memset(payload,0xa5,8192u);
        if (protection && mprotect(payload+4096u,4096u,
            protection==1u ? PROT_NONE : PROT_READ)) return 2;
        observe(code,payload+offset);
        if (mprotect(payload+4096u,4096u,PROT_READ|PROT_WRITE)) return 2;
        if (vector && vector!=14) {
            fprintf(stderr,"reference refuses store (trap %d); UMIP/kernel emulation not proven\n",vector);
            return 2;
        }
        printf("%s{\"table\":%u,\"prefix\":%u,\"address32\":%u,\"offset\":%u,"
            "\"protection\":%u,\"vector\":%d,\"error\":%" PRIu64 ","
            "\"faultOffset\":%" PRIu64 ",\"faultRipAtSource\":%s,\"faultFlags\":%" PRIu64 ","
            "\"descriptor\":[",rows++ ? ",\n" : "",table,prefix,address32,offset,
            protection,vector,error,vector ? fault_address-(uint64_t)(uintptr_t)payload : 0u,
            !vector || fault_rip==(uint64_t)(uintptr_t)code ? "true" : "false",fault_flags);
        for (unsigned byte=0u;byte<10u;++byte) printf("%s%u",byte ? "," : "",descriptor[byte]);
        printf("],\"payload\":[");
        for (unsigned byte=0u;byte<16u;++byte) printf("%s%u",byte ? "," : "",payload[offset-3u+byte]);
        puts("]}");
        /* No bytes outside this bounded record may have been changed. */
        for (unsigned byte=0u;byte<8192u;++byte)
            if ((byte<offset || byte>=offset+10u) && payload[byte]!=0xa5u) return 1;
    }
    puts("]}");
    if (munmap(code,4096u) || munmap(payload,8192u)) return 2;
    return rows==108u ? 0 : 1;
}
