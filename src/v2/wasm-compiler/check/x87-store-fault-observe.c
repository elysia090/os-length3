#define _GNU_SOURCE
#include "x87-observation.h"
#include <sys/mman.h>
#include <signal.h>
#include <setjmp.h>
#include <ucontext.h>
#include <stdio.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
/* Test-only actual CPU fault ordering. The signal frame is copied before
 * restoring the host FPU; no product compiler/VM determines the observation. */
static sigjmp_buf recovery;
static _Alignas(16) pl_u8 host[512],input[512],before[512],after[512];
static volatile sig_atomic_t trapped;
static pl_u64 vector,error;
static machine_state records[12][2];static pl_u64 initial[12],written[12];static pl_u8 fault_rows[12];static pl_u32 fault_errors[12];
static pl_u8 float_initial[12][16],float_written[12][16];static const char *record_prefix="x87-store-fault";
static int save(const char *dir,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!dir)return 0;
    char name[4096];int n=snprintf(name,sizeof name,"%s/%s-%u.%s",dir,record_prefix,form,suffix);if(n<1||(size_t)n>=sizeof name)return 1;
    FILE *file=fopen(name,"wbx");if(!file)return 1;int bad=fwrite(data,1u,bytes,file)!=bytes;if(fclose(file))bad=1;return bad;
}
static void handler(int number,siginfo_t *info,void *pointer)
{
    (void)number;(void)info;const ucontext_t *context=pointer;
    memcpy(after,context->uc_mcontext.fpregs,512u);vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR];trapped=1;siglongjmp(recovery,1);
}
static void put(pl_u8 *at,pl_u64 value,pl_u32 bytes)
{for(pl_u32 n=0u;n<bytes;++n)at[n]=(pl_u8)(value>>(n*8u));}
int main(int argc,char **argv)
{
    int floating=(argc==2&&!strcmp(argv[1],"--float"))||(argc==3&&!strcmp(argv[2],"--float"));
    if(argc>3||(argc==3&&!floating))return 2;
    static const char *directory;
    directory=argc>=2&&!(argc==2&&floating)?argv[1]:NULL;
    if(floating)record_prefix="x87-float-store-fault";
    struct sigaction action={.sa_sigaction=handler,.sa_flags=SA_SIGINFO},old;sigemptyset(&action.sa_mask);
    if(sigaction(SIGSEGV,&action,&old))return 1;
    pl_u8 *code=mmap(0,8192u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);if(code==MAP_FAILED)return 1;
    const pl_u8 primary[]={0xdfu,0xdbu,0xdfu,0xdbu,0xdfu,0xdfu,0xdbu,0xddu},group[]={2u,2u,3u,3u,7u,1u,1u,1u};
    const pl_u8 widths[]={2u,4u,2u,4u,8u,2u,4u,8u};
    const pl_u8 float_primary[]={0xd9u,0xd9u,0xddu,0xddu,0xdbu},float_group[]={2u,3u,2u,3u,7u},float_width[]={4u,4u,8u,8u,10u};
    pl_u32 forms=floating?5u:8u,samples=floating?6u:4u;
    pl_u32 rows=0u,faults=0u,suppressed_faults=0u;
    for(pl_u32 form=0u;form<forms;++form)for(pl_u32 sample=0u;sample<samples;++sample)for(pl_u32 readonly=0u;readonly<2u;++readonly){
        if(mprotect(code,8192u,PROT_READ|PROT_WRITE|PROT_EXEC))return 1;
        pl_u32 width=floating?float_width[form]:widths[form];
        pl_u32 source_group=floating?float_group[form]:group[form];
        code[0]=floating?float_primary[form]:primary[form];code[1]=(pl_u8)((source_group<<3u)|5u);put(code+2u,4090u,4u);code[6]=0xc3u;
        memset(code+4096u,0x5a,4096u);memset(input,0,sizeof input);
        put(input,sample==0u?0x37fu:sample==1u?0x37eu:sample==2u?0x35fu:sample==4u?0x377u:sample==5u?0x36fu:0x37eu,2u);
        input[4]=sample==3u?254u:255u;put(input+24u,0x1f80u,4u);
        put(input+32u,0xc000000000000000ull,8u);
        put(input+40u,sample==2u?0x3fffu:0x7fffu,2u);
        if(floating){pl_u32 bias=width==4u?127u:1023u;
            put(input+32u,sample==0u?0xc000000000000000ull:sample==1u?0x8000000000000001ull:sample==2u?0x8000000000000001ull:0x8000000000000000ull,8u);
            put(input+40u,sample<=1u?0x7fffu:sample==4u?16384u+bias:sample==5u?16383u-bias:0x3fffu,2u);}
        for(pl_u32 n=1u;n<8u;++n){put(input+32u+n*16u,0x8000000000000000ull,8u);put(input+40u+n*16u,0x3fffu,2u);}
        if(mprotect(code,4096u,PROT_READ|PROT_EXEC)||mprotect(code+4096u,4096u,readonly?PROT_READ:PROT_READ|PROT_WRITE))return 1;
        trapped=0;__asm__ volatile("fxsave64 %0":"=m"(host)::"memory");
        if(!sigsetjmp(recovery,1)){
            __asm__ volatile("fxrstor64 %[input]\n\tfxsave64 %[before]\n\tcall *%[code]\n\tfxsave64 %[after]"
                :[before]"=m"(before),[after]"=m"(after):[input]"m"(input),[code]"r"(code):"memory","cc",
                 "xmm0","xmm1","xmm2","xmm3","xmm4","xmm5","xmm6","xmm7",
                 "xmm8","xmm9","xmm10","xmm11","xmm12","xmm13","xmm14","xmm15");
        }
        // The host image predates sigsetjmp: restoring it can also replace
        // compiler-live XMM values. Declare that clobber, including the fault
        // path; diagnostic printing must not accidentally hide this hazard.
        __asm__ volatile("fxrstor64 %0"::"m"(host):"memory",
            "xmm0","xmm1","xmm2","xmm3","xmm4","xmm5","xmm6","xmm7",
            "xmm8","xmm9","xmm10","xmm11","xmm12","xmm13","xmm14","xmm15");
        machine_state first={0},last={0};check_x87_project(&first,before);check_x87_project(&last,after);
        int same=memcmp(&first.x87_significand,&last.x87_significand,sizeof(machine_state)-offsetof(machine_state,x87_significand))==0;
        if(trapped)++faults;else if(readonly)++suppressed_faults;
        if(directory)printf("{\"form\":%u,\"sample\":%u,\"readonly\":%u,\"fault\":%u,\"vector\":%llu,\"error\":%llu,\"beforeSW\":%u,\"afterSW\":%u,\"fpuUnchanged\":%s}\n",
            form,sample,readonly,!!trapped,(unsigned long long)(trapped?vector:0u),(unsigned long long)(trapped?error:0u),first.x87_status,last.x87_status,same?"true":"false");++rows;
        int suppress=floating?(sample==3u||(width!=10u&&(sample==1u||sample==4u||sample==5u))):sample==1u||sample==3u;
        if(!!trapped!=(readonly&&!suppress)||(trapped&&(vector!=14u||error!=7u||!same))){
            fprintf(stderr,"Store oracle mismatch form=%u sample=%u readonly=%u trap=%u vector=%llu error=%llu unchanged=%u\n",
                form,sample,readonly,!!trapped,(unsigned long long)vector,(unsigned long long)error,(unsigned)same);return 1;}
        pl_u32 row=sample*2u+readonly;machine_state *a=records[row],*b=a+1u;
        memset(a,0,sizeof *a);a->rip=0x400000u;a->rflags=0x10202u;a->cr0=0x80010031u;a->cr3=0x1000u;a->cr4=32u;a->efer=0xd00u;
        a->system[MACHINE_SYSTEM_CS]=19u;a->system[MACHINE_SYSTEM_DR0+7u]=0x400u;a->retired=42u;*b=*a;
        check_x87_project(a,before);check_x87_project(b,after);
        if(b->x87_ip==(pl_u64)(uintptr_t)code)b->x87_ip=a->rip;
        if(b->x87_dp==(pl_u64)(uintptr_t)(code+4096u))b->x87_dp=a->rip+4096u;
        if(!trapped){b->rip+=6u;b->rflags=0x202u;++b->retired;}
        initial[row]=0x5a5a5a5a5a5a5a5aull;memcpy(written+row,code+4096u,8u);fault_rows[row]=(pl_u8)!!trapped;fault_errors[row]=(pl_u32)(trapped?error:0u);
        memset(float_initial[row],0x5a,16u);memcpy(float_written[row],code+4096u,16u);
        if(row==samples*2u-1u){char json[256];pl_u32 count=samples*2u,stride=floating?16u:8u;
            int n=snprintf(json,sizeof json,"{\"sourceBytes\":6,\"stateBytes\":%zu,\"native\":%u,\"bytes\":%u,\"store\":true,\"operandOffset\":4096,\"operandStride\":%u,\"writtenStride\":%u}\n",sizeof(machine_state),count,width,stride,stride);
            if(n<1||(size_t)n>=sizeof json||save(directory,form,"json",json,(size_t)n)||save(directory,form,"source",code,6u)
                ||save(directory,form,"cases",records,count*sizeof records[0])||save(directory,form,"integers",floating?(const void *)float_initial:(const void *)initial,count*stride)
                ||save(directory,form,"written",floating?(const void *)float_written:(const void *)written,count*stride)||save(directory,form,"faults",fault_rows,count)
                ||save(directory,form,"errors",fault_errors,count*sizeof fault_errors[0]))return 1;}
    }
    if(munmap(code,8192u)||sigaction(SIGSEGV,&old,0))return 1;
    printf("%s store ordering: %u rows, %u faults, %u readonly non-faults\n",floating?"Floating":"Integer",rows,faults,suppressed_faults);
    return rows==(floating?60u:64u)&&faults==(floating?13u:16u)&&suppressed_faults==(floating?17u:16u)?0:1;
}
