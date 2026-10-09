#define _GNU_SOURCE
#include "x87-observation.h"
#include <sys/mman.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
#include <stdio.h>
#include <stddef.h>
/* Independent source-page versus stack-fault priority. Native CPU only. */
static sigjmp_buf recovery;
static _Alignas(16) pl_u8 host[512],input[512],before[512],after[512];
static volatile sig_atomic_t trapped;
static pl_u64 vector,error;
static void put(pl_u8 *p,pl_u64 x,unsigned n){for(unsigned i=0u;i<n;++i)p[i]=(pl_u8)(x>>(i*8u));}
static void handler(int sig,siginfo_t *info,void *pointer)
{
    (void)sig;(void)info;const ucontext_t *c=pointer;memcpy(after,c->uc_mcontext.fpregs,512u);
    vector=(pl_u64)c->uc_mcontext.gregs[REG_TRAPNO];error=(pl_u64)c->uc_mcontext.gregs[REG_ERR];trapped=1;siglongjmp(recovery,1);
}
int main(void)
{
    struct sigaction action={.sa_sigaction=handler,.sa_flags=SA_SIGINFO},old;sigemptyset(&action.sa_mask);
    if(sigaction(SIGSEGV,&action,&old))return 1;
    pl_u8 *code=mmap(NULL,8192u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(code==MAP_FAILED)return 1;
    code[0]=0xdbu;code[1]=0x2du;put(code+2u,4090u,4u);code[6]=0xc3u;
    put(code+4096u,1u,8u);put(code+4104u,0u,2u);
    for(unsigned full=0u;full<2u;++full)for(unsigned unmask=0u;unmask<2u;++unmask)for(unsigned absent=0u;absent<2u;++absent){
        if(mprotect(code+4096u,4096u,absent?PROT_NONE:PROT_READ))return 1;
        memset(input,0,sizeof input);put(input,unmask?0x37eu:0x37fu,2u);put(input+2u,0x4700u,2u);
        input[4]=(pl_u8)(full?255u:127u);put(input+24u,0x1f80u,4u);
        for(unsigned r=0u;r<8u;++r){put(input+32u+r*16u,0x8000000000000000ull+r,8u);put(input+40u+r*16u,0x3fffu,2u);}
        trapped=0;__asm__ volatile("fxsave64 %0":"=m"(host)::"memory");
        if(!sigsetjmp(recovery,1)){
            __asm__ volatile("fxrstor64 %[input]\n\tfxsave64 %[before]\n\tcall *%[code]\n\tfxsave64 %[after]"
                :[before]"=m"(before),[after]"=m"(after):[input]"m"(input),[code]"r"(code):"memory","cc",
                 "xmm0","xmm1","xmm2","xmm3","xmm4","xmm5","xmm6","xmm7",
                 "xmm8","xmm9","xmm10","xmm11","xmm12","xmm13","xmm14","xmm15");
        }
        __asm__ volatile("fxrstor64 %0"::"m"(host):"memory",
            "xmm0","xmm1","xmm2","xmm3","xmm4","xmm5","xmm6","xmm7",
            "xmm8","xmm9","xmm10","xmm11","xmm12","xmm13","xmm14","xmm15");
        machine_state a={0},b={0};check_x87_project(&a,before);check_x87_project(&b,after);
        int same=!memcmp(&a.x87_significand,&b.x87_significand,sizeof(machine_state)-offsetof(machine_state,x87_significand));
        printf("{\"full\":%u,\"unmask\":%u,\"absent\":%u,\"trapped\":%u,\"vector\":%llu,\"error\":%llu,\"beforeSW\":%u,\"afterSW\":%u,\"unchanged\":%s}\n",
            full,unmask,absent,!!trapped,(unsigned long long)(trapped?vector:0u),(unsigned long long)(trapped?error:0u),a.x87_status,b.x87_status,same?"true":"false");
        if(!!trapped!=!!absent||(trapped&&(vector!=14u||error!=4u||!same)))return 1;
    }
    if(munmap(code,8192u)||sigaction(SIGSEGV,&old,NULL))return 1;
    puts("FLD80: 8 independent source-page/stack-priority observations");return 0;
}
