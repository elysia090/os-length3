#define _GNU_SOURCE
#include <machine/state.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <signal.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <ucontext.h>
extern void native_stack_cut(const machine_state *,const void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
static pl_u8 alternate[65536];static sigjmp_buf recovery;static volatile sig_atomic_t trapped;
static pl_u64 registers[16],flags,vector,error,fault_rip,fault_address;
static void exception(int number,siginfo_t *info,void *pointer)
{
    (void)number;__asm__ volatile("cld" ::: "cc");const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for(pl_u32 i=0u;i<16u;++i)registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL];vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR];fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address=(pl_u64)(uintptr_t)info->si_addr;trapped=1;siglongjmp(recovery,1);
}
static void observe(const machine_state *cpu,const void *code)
{trapped=0;if(!sigsetjmp(recovery,1))native_stack_cut(cpu,code);}
static void put(void *at,pl_u64 value,pl_u32 bytes){for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)at)[i]=(pl_u8)(value>>(8u*i));}
typedef struct {pl_u64 before[17],after[17],rip,vector,error,address,window;pl_u8 bytes[256];} record;
static record records[12];
static int save(const char *dir,pl_u32 form,const char *suffix,const void *bytes,size_t n)
{
    if(!dir)return 0;
    char path[4096];int size=snprintf(path,sizeof path,"%s/enter-%u.%s",dir,form,suffix);if(size<1||(size_t)size>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;int bad=fwrite(bytes,1u,n,file)!=n;if(fclose(file))bad=1;return bad;
}
int main(int argc,char **argv)
{
    if(argc!=1&&argc!=2)return 2;
    const char *dir=argc==2?argv[1]:NULL;
    stack_t old_stack,stack={.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv,old_bus,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};sigemptyset(&action.sa_mask);
    if(sigaltstack(&stack,&old_stack)||sigaction(SIGSEGV,&action,&old_segv)||sigaction(SIGBUS,&action,&old_bus))return 1;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x12340000u,131072u,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    if(code==MAP_FAILED||ram==MAP_FAILED)return 1;
    const pl_u8 prefixes[]={0u,0x48u,0x67u,0x64u,0x65u,0x66u,0xf2u,0xf3u};
    const pl_u32 levels[]={0u,1u,2u,3u,15u,22u,31u,32u,63u,127u,214u,255u};
    const pl_u32 allocations[]={0u,1u,16u,4095u,4096u,0x8949u,65535u};
    pl_u32 forms=0u,rows=0u,faults=0u,changed_fault_memory=0u,changed_fault_registers=0u;int failed=1;
    for(pl_u32 p=0u;p<8u;++p)for(pl_u32 level=0u;level<12u;++level)for(pl_u32 a=0u;a<7u;++a){
        pl_u32 width=prefixes[p]==0x66u?2u:8u,n=0u,nesting=levels[level]&31u,allocation=allocations[a];
        if(prefixes[p])code[n++]=prefixes[p];
        code[n++]=0xc8u;put(code+n,allocation,2u);n+=2u;code[n++]=(pl_u8)levels[level];
        pl_u8 source[8];memcpy(source,code,n);code[n]=0xffu;code[n+1u]=0x25u;put(code+n+2u,0u,4u);put(code+n+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
        for(pl_u32 phase=0u;phase<12u;++phase){
            if(mprotect(ram,131072u,PROT_READ|PROT_WRITE))goto done;
            for(pl_u32 i=0u;i<131072u;++i)ram[i]=(pl_u8)(i*13u+0x5bu);
            machine_state cpu={0};for(pl_u32 i=0u;i<16u;++i)cpu.registers[i]=0x123456789abc0000ull+i;
            cpu.registers[4]=0x12358000u;cpu.registers[5]=cpu.registers[4]-128u;cpu.rflags=0x202u|(phase&1u?0xcd5u:0u);
            if(phase==1u)cpu.registers[5]=cpu.registers[4];
            if(phase==2u)cpu.registers[5]=cpu.registers[4]-width*2u;
            if(phase==3u&&mprotect(ram+0x17000u,4096u,PROT_READ))goto done;
            if(phase==4u){cpu.registers[5]=0x12344000u+width*(nesting/2u);if(mprotect(ram+0x3000u,4096u,PROT_NONE))goto done;}
            if(phase==5u){cpu.registers[4]=0x12348000u+width*2u;if(mprotect(ram+0x7000u,4096u,PROT_READ))goto done;}
            if(phase==6u){pl_u64 final=cpu.registers[4]-width*(nesting?nesting+1u:1u)-allocation;
                if(mprotect(ram+((final-0x12340000u)&~4095ull),4096u,PROT_READ))goto done;}
            if(phase==7u){if(forms%3u==0u)cpu.registers[4]=0x8000000000000000ull;
                else if(forms%3u==1u)cpu.registers[5]=0x8000000000000000ull;else cpu.registers[4]=0x12360000u;}
            if(phase==8u)cpu.registers[5]=0x12340000u;
            if(phase==9u&&allocation>=4096u){cpu.registers[4]=0x12348fffu+allocation+width*(nesting?nesting+1u:1u);
                if(mprotect(ram+0x9000u,4096u,PROT_READ))goto done;}
            if(phase==10u){cpu.registers[4]=0x12347078u;cpu.registers[5]=cpu.registers[4]-2u*width;}
            if(phase==11u){cpu.registers[4]=0x12348078u;cpu.registers[5]=0x12349080u;}
            record *r=records+phase;memset(r,0,sizeof *r);memcpy(r->before,cpu.registers,sizeof cpu.registers);r->before[16]=cpu.rflags;
            observe(&cpu,code);
            if(mprotect(ram,131072u,PROT_READ|PROT_WRITE))goto done;
            memcpy(r->after,trapped?registers:native_stack_result,sizeof cpu.registers);r->after[16]=trapped?flags&~0x10000ull:native_stack_result[16];
            r->rip=trapped?fault_rip:0x400000u+n;r->vector=trapped?vector:0u;r->error=trapped?error:0u;r->address=trapped?fault_address:0u;
            pl_u64 sp=cpu.registers[4];if(sp>=0x12340100u&&sp<=0x12360000u){r->window=sp-256u;memcpy(r->bytes,ram+(r->window-0x12340000u),256u);}
            pl_u32 changed=0u;for(pl_u32 i=0u;i<131072u;++i){pl_u8 expected=(pl_u8)(i*13u+0x5bu);
                if(ram[i]!=expected){++changed;if(!r->window||0x12340000u+i<r->window||0x12340000u+i>=r->window+256u){fprintf(stderr,"ENTER write outside stack window\n");goto done;}}}
            if(trapped){++faults;changed_fault_memory+=changed!=0u;changed_fault_registers+=memcmp(r->before,r->after,16u*sizeof(pl_u64))!=0;
                if(fault_rip!=0x400000u)goto done;}
            ++rows;
        }
        char json[320];int size=snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"bytes\":%u,\"nestingRaw\":%u,\"allocation\":%u,\"native\":12,\"recordBytes\":%zu,\"ramBase\":\"305397760\",\"ramBytes\":131072,\"oracle\":\"native reference x86 build VM\"}\n",n,width,levels[level],allocation,sizeof(record));
        if(size<1||(size_t)size>=sizeof json||save(dir,forms,"json",json,(size_t)size)||save(dir,forms,"source",source,n)||save(dir,forms,"cases",records,sizeof records))goto done;
        ++forms;
    }
    printf("{\"format\":\"native-enter-observation-v1\",\"status\":\"observed\",\"forms\":%u,\"rows\":%u,\"faults\":%u,\"faultsWithRamChanges\":%u,\"faultsWithRegisterChanges\":%u,\"linuxBoot\":\"not-tested\"}\n",forms,rows,faults,changed_fault_memory,changed_fault_registers);failed=0;
done:if(munmap(code,4096u)||munmap(ram,131072u)||sigaction(SIGSEGV,&old_segv,NULL)||sigaction(SIGBUS,&old_bus,NULL)||sigaltstack(&old_stack,NULL))failed=1;return failed;
}
