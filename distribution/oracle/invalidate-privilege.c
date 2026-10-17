/* Actual native CPL3 #GP, not a modeled fault or product backend. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdint.h>
#include <signal.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <ucontext.h>
#include <string.h>
static sigjmp_buf escape;
static volatile sig_atomic_t trapped, vector, error;
static uintptr_t fault_rip;
static void handler(int signal, siginfo_t *info, void *context)
{
    (void)info;
    const ucontext_t *cpu=context;
    trapped=signal; vector=(sig_atomic_t)cpu->uc_mcontext.gregs[REG_TRAPNO];
    error=(sig_atomic_t)cpu->uc_mcontext.gregs[REG_ERR];
    fault_rip=(uintptr_t)cpu->uc_mcontext.gregs[REG_RIP];
    siglongjmp(escape,1);
}
int main(int argc, char **argv)
{
    if (argc!=2) return 2;
    struct sigaction action={0};
    action.sa_sigaction=handler; action.sa_flags=SA_SIGINFO;
    if (sigemptyset(&action.sa_mask) || sigaction(SIGSEGV,&action,0)
            || sigaction(SIGILL,&action,0)) return 1;
    void *code=mmap(0,4096u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if (code==MAP_FAILED) return 1;
    void (*call)(void); _Static_assert(sizeof call==sizeof code,"native x86 pointer ABI");
    memcpy(&call,&code,sizeof call);
    for (unsigned rank=0u;rank<84u;++rank) {
        char path[4096];
        int n=snprintf(path,sizeof path,"%s/invalidate-%u.source-page",argv[1],rank);
        if (n<=0 || (size_t)n>=sizeof path || mprotect(code,4096u,PROT_READ|PROT_WRITE)) return 1;
        FILE *input=fopen(path,"rb");
        if (!input) return 1;
        int bad=fread(code,1u,4096u,input)!=4096u || fgetc(input)!=EOF;
        if (fclose(input) || bad || mprotect(code,4096u,PROT_READ|PROT_EXEC)) return 1;
        trapped=vector=error=0; fault_rip=0u;
        if (!sigsetjmp(escape,1)) call();
        if (trapped!=SIGSEGV || vector!=13 || error || fault_rip!=(uintptr_t)code) {
            fprintf(stderr,"INVLPG CPL3 rank %u: signal=%d vector=%d error=%d\n",
                rank,(int)trapped,(int)vector,(int)error); return 1;
        }
    }
    if (munmap(code,4096u)) return 1;
    puts("Actual native CPL3 INVLPG: 84 precise #GP(0) frames green; not CPL0 or Linux boot");
    return 0;
}
