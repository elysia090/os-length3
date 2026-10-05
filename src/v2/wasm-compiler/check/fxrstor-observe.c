#define _GNU_SOURCE
#include <signal.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>

static sigjmp_buf pending;
static volatile sig_atomic_t trapped;
static volatile sig_atomic_t vector;
static uint8_t fault_image[512];
static void fault(int number, siginfo_t *info, void *opaque)
{
    (void)info;
    ucontext_t *context=opaque;
    memcpy(fault_image,context->uc_mcontext.fpregs,sizeof fault_image);
    vector=(sig_atomic_t)context->uc_mcontext.gregs[REG_TRAPNO];
    trapped=number; siglongjmp(pending,1);
}
static int observe(uint8_t *target,unsigned wide)
{
    trapped=vector=0;
    if(!sigsetjmp(pending,1)) {
        if(wide)__asm__ volatile("fxrstor64 (%0)"::"r"(target):"memory");
        else __asm__ volatile("fxrstor (%0)"::"r"(target):"memory");
    }
    return trapped;
}
int main(void)
{
    struct sigaction action={0},old;
    action.sa_sigaction=fault;action.sa_flags=SA_SIGINFO;sigemptyset(&action.sa_mask);
    if(sigaction(SIGSEGV,&action,&old))return 1;
    uint8_t *pages=mmap(NULL,8192u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(pages==MAP_FAILED || mprotect(pages+4096u,4096u,PROT_NONE))return 1;
    _Alignas(16) uint8_t host[512],initial[512],image[512],observed[512];
    __asm__ volatile("fxsave64 %0":"=m"(host));
    memcpy(initial,host,512u);memcpy(image,host,512u);
    initial[24u]=0x80u;initial[25u]=0x1fu;image[24u]=0x80u;image[25u]=0x3fu;
    for(unsigned i=160u;i<416u;++i)image[i]=(uint8_t)(i*73u+11u);
    for(unsigned wide=0u;wide<2u;++wide)for(unsigned invalid=0u;invalid<2u;++invalid) {
        image[26u]=(uint8_t)invalid;
        for(unsigned end=512u;end>=16u;end-=16u) {
            memcpy(pages+4096u-end,image,end);
            __asm__ volatile("fxrstor64 %1\n\tfxsave64 %0":"=m"(observed):"m"(initial):"memory");
            int signal_number=observe(pages+4096u-end,wide);
            unsigned changed=0u;
            if(signal_number)for(unsigned i=0u;i<416u;++i)changed+=fault_image[i]!=observed[i];
            printf("FXRSTOR rexw=%u invalid-mxcsr=%u resident-prefix=%u signal=%d vector=%d changed-fpu=%u\n",
                wide,invalid,end,signal_number,vector,changed);
        }
    }
    __asm__ volatile("fxrstor64 %0"::"m"(host):"memory");
    if(sigaction(SIGSEGV,&old,NULL) || munmap(pages,8192u))return 1;
    return 0;
}
