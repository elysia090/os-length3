#define _GNU_SOURCE
#include <signal.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static sigjmp_buf pending;
static volatile sig_atomic_t trapped;
static void fault(int signal_number)
{ trapped=signal_number; siglongjmp(pending,1); }
static int observe(uint8_t *target,unsigned wide)
{
    trapped=0;
    if(!sigsetjmp(pending,1)) {
        if(wide)__asm__ volatile("fxsave64 (%0)"::"r"(target):"memory");
        else __asm__ volatile("fxsave (%0)"::"r"(target):"memory");
    }
    return trapped;
}
int main(void)
{
    struct sigaction action={0},old;
    action.sa_handler=fault; sigemptyset(&action.sa_mask);
    if(sigaction(SIGSEGV,&action,&old))return 1;
    uint8_t *pages=mmap(NULL,8192u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(pages==MAP_FAILED || mprotect(pages+4096u,4096u,PROT_NONE))return 1;
    _Alignas(16) uint8_t host[512];
    __asm__ volatile("fxsave64 %0":"=m"(host));
    for(unsigned wide=0u;wide<2u;++wide) {
        _Alignas(16) uint8_t image[512]; memset(image,0xa5,sizeof image);
        if(wide)__asm__ volatile("fxsave64 %0":"=m"(image));
        else __asm__ volatile("fxsave %0":"=m"(image));
        unsigned changes=0u,tail=0u;
        for(unsigned i=0u;i<512u;++i) {
            if(image[i]!=0xa5u)++changes;
            if(i>=464u && image[i]!=0xa5u)++tail;
        }
        printf("FXSAVE rexw=%u changed=%u software-tail-changed=%u mask=%02x%02x%02x%02x\n",
            wide,changes,tail,image[31],image[30],image[29],image[28]);
        if(tail)return 1;
        for(unsigned end=512u;end>=16u;end-=16u) {
            memset(pages,0xa5,4096u); int signal_number=observe(pages+4096u-end,wide);
            unsigned changed=0u;
            for(unsigned i=4096u-end;i<4096u;++i)changed+=pages[i]!=0xa5u;
            printf("FXSAVE rexw=%u resident-prefix=%u trap=%d changed-prefix=%u\n",wide,end,signal_number,changed);
        }
    }
    __asm__ volatile("fxrstor64 %0"::"m"(host):"memory");
    if(sigaction(SIGSEGV,&old,NULL) || munmap(pages,8192u))return 1;
    return 0;
}
