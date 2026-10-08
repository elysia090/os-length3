#define _GNU_SOURCE
#include <machine/state.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <signal.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <ucontext.h>
extern void native_stack_cut(const machine_state *,const void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
static pl_u8 alternate[65536];static sigjmp_buf recovery;static volatile sig_atomic_t trapped;
static pl_u64 registers[16],flags,vector,error,fault_rip,fault_address;
static void exception(int number,siginfo_t *info,void *pointer)
{
    (void)number;__asm__ volatile("cld" ::: "cc");const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for(pl_u32 i=0u;i<16u;++i)registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL];vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];error=(pl_u64)context->uc_mcontext.gregs[REG_ERR];
    fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];fault_address=(pl_u64)(uintptr_t)info->si_addr;trapped=1;siglongjmp(recovery,1);
}
static void observe(const machine_state *cpu,const void *code){trapped=0;if(!sigsetjmp(recovery,1))native_stack_cut(cpu,code);}
static void put(void *at,pl_u64 value,pl_u32 bytes){for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)at)[i]=(pl_u8)(value>>(8u*i));}
typedef struct {pl_u64 before[17],after[17],rip,vector,error,address,changed;struct {pl_u32 offset,byte;} changes[16];} record;
static record records[64];
static int save(const char *dir,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!dir)return 0;
    char path[4096];int size=snprintf(path,sizeof path,"%s/string-io-%u.%s",dir,form,suffix);
    if(size<1||(size_t)size>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int bad=fwrite(data,1u,bytes,file)!=bytes;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2&&(argc!=3||strcmp(argv[2],"--deny-only")))return 2;
    const char *dir=argc>=2?argv[1]:NULL;pl_u32 deny_only=argc==3;
    stack_t old_stack,stack={.ss_sp=alternate,.ss_size=sizeof alternate};struct sigaction old_segv,old_bus,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};sigemptyset(&action.sa_mask);
    if(sigaltstack(&stack,&old_stack)||sigaction(SIGSEGV,&action,&old_segv)||sigaction(SIGBUS,&action,&old_bus)){perror("signal setup");return 1;}
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x12340000u,8192u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    if(code==MAP_FAILED||ram==MAP_FAILED){perror("oracle mmap");return 1;}
    const pl_u8 repeats[]={0u,0xf2u,0xf3u};pl_u32 forms=0u,rows=0u,faults=0u;int failed=1;
    for(pl_u32 rex=0u;rex<2u;++rex)for(pl_u32 addr=0u;addr<2u;++addr)for(pl_u32 rep=0u;rep<3u;++rep)for(pl_u32 write=0u;write<2u;++write)for(pl_u32 w=0u;w<3u;++w){
        pl_u32 width=w==0u?1u:w==1u?2u:4u,n=0u;
        if(repeats[rep])code[n++]=repeats[rep];
        if(addr)code[n++]=0x67u;
        if(width==2u)code[n++]=0x66u;
        if(rex)code[n++]=0x4du;
        code[n++]=(pl_u8)((write?0x6eu:0x6cu)|(width==1u?0u:1u));pl_u8 source[8];memcpy(source,code,n);
        code[n]=0xffu;code[n+1u]=0x25u;put(code+n+2u,0u,4u);put(code+n+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
        for(pl_u32 row=0u;row<64u;++row){pl_u32 allow=deny_only?0u:row&1u,direction=(row>>1u)&1u,phase=(row>>2u)&7u,count=(row>>5u)?3u:0u;
            if(syscall(SYS_ioperm,0x2e8u,4u,allow)){perror("ioperm");goto done;}
            if(mprotect(ram,8192u,PROT_READ|PROT_WRITE))goto done;
            for(pl_u32 i=0u;i<8192u;++i)ram[i]=(pl_u8)(i*13u+0x5bu);
            machine_state cpu={0};for(pl_u32 i=0u;i<16u;++i)cpu.registers[i]=0x123456789abc0000ull+i;
            cpu.registers[1]=count;cpu.registers[2]=0x2e8u;cpu.registers[4]=0x12341f00u;cpu.rflags=0x202u|(direction?0x400u:0u);
            pl_u64 address=phase==0u?0x12340100u:phase==1u?0x12340fffu:phase==2u?0x12342000u:
                phase==3u?0x8000000000000000ull:phase==4u?0x12341000u-width:phase==5u?0x12340000u+width:0x12340180u;
            if(phase==1u||phase==4u)if(mprotect(ram+4096u,4096u,PROT_NONE))goto done;
            if(phase==6u){if(mprotect(ram,4096u,PROT_READ))goto done;}
            if(phase==7u&&addr){address|=0xfeed000000000000ull;cpu.registers[1]|=0xbeef000000000000ull;}
            cpu.registers[write?6u:7u]=address;
            record *r=records+row;memcpy(r->before,cpu.registers,sizeof cpu.registers);r->before[16]=cpu.rflags;observe(&cpu,code);
            if(mprotect(ram,8192u,PROT_READ|PROT_WRITE))goto done;
            memcpy(r->after,trapped?registers:native_stack_result,sizeof cpu.registers);r->after[16]=trapped?flags&~0x10000ull:native_stack_result[16];
            r->rip=trapped?fault_rip:0x400000u+n;r->vector=trapped?vector:0u;r->error=trapped?error:0u;r->address=trapped?fault_address:0u;r->changed=0u;
            for(pl_u32 i=0u;i<8192u;++i)if(ram[i]!=(pl_u8)(i*13u+0x5bu)){
                if(r->changed>=16u){fprintf(stderr,"unexpected IO payload extent\n");goto done;}
                r->changes[r->changed].offset=i;r->changes[r->changed].byte=ram[i];++r->changed;}
            if(trapped){if(fault_rip!=0x400000u){fprintf(stderr,"native string IO trap outside source form=%u row=%u rip=%llx vector=%llu\n",forms,row,(unsigned long long)fault_rip,(unsigned long long)vector);goto done;}++faults;}++rows;
        }
        pl_u32 effective_bytes=rex&&width==2u?4u:width;
        char json[256];int size=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"bytes\":%u,\"addressBits\":%u,\"repeated\":%u,\"write\":%u,\"native\":64,\"recordBytes\":%zu,\"ioPort\":744,\"deniedOnly\":%u}\n",n,effective_bytes,addr?32u:64u,rep!=0u,write,sizeof(record),deny_only);
        if(size<1||(size_t)size>=sizeof json||save(dir,forms,"json",json,(size_t)size)||save(dir,forms,"source",source,n)||save(dir,forms,"cases",records,sizeof records))goto done;
        ++forms;
    }
    printf("{\"format\":\"native-string-io-v1\",\"status\":\"observed\",\"forms\":%u,\"rows\":%u,\"faults\":%u,\"oracle\":\"reference x86 VM, absent COM2, Linux TSS ioperm\",\"linuxBoot\":\"not-tested\"}\n",forms,rows,faults);failed=0;
done:if(failed)fprintf(stderr,"native string IO stopped after forms=%u rows=%u\n",forms,rows);
    syscall(SYS_ioperm,0x2e8u,4u,0u);if(munmap(code,4096u)||munmap(ram,8192u)||sigaction(SIGSEGV,&old_segv,NULL)||sigaction(SIGBUS,&old_bus,NULL)||sigaltstack(&old_stack,NULL))failed=1;return failed;
}
