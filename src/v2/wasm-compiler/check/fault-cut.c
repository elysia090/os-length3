#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <signal.h>
#include <setjmp.h>
#include <stdint.h>
#include <ucontext.h>
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>
static sigjmp_buf jumped;static volatile sig_atomic_t native_vector;
static volatile uintptr_t native_rip;
static pl_u8 page[4096],module[65536],witness[65536];
static void capture(int signum,siginfo_t *info,void *opaque)
{
    (void)signum;(void)info;ucontext_t *state=opaque;
    native_vector=(sig_atomic_t)state->uc_mcontext.gregs[REG_TRAPNO];native_rip=(uintptr_t)state->uc_mcontext.gregs[REG_RIP];
    siglongjmp(jumped,1);
}
static int probe(pl_u8 *memory,const pl_u8 *bytes,pl_u32 count,pl_u32 vector)
{
    if(mprotect(memory,4096,PROT_READ|PROT_WRITE))return 0;
    pl_u8 *entry=memory+4096u-count;memcpy(entry,bytes,count);
    if(mprotect(memory,4096,PROT_READ|PROT_EXEC))return 0;
    if(!sigsetjmp(jumped,1)){void (*run)(void);memcpy(&run,&entry,sizeof run);run();return 0;}
    return native_vector==(sig_atomic_t)vector && native_rip==(uintptr_t)entry;
}
int main(void)
{
    pl_u8 *native=mmap(0,8192,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(native==MAP_FAILED || mprotect(native+4096,4096,PROT_NONE))return 1;
    struct sigaction action={0},old_ill,old_segv;action.sa_sigaction=capture;action.sa_flags=SA_SIGINFO;
    sigemptyset(&action.sa_mask);if(sigaction(SIGILL,&action,&old_ill) || sigaction(SIGSEGV,&action,&old_segv))return 2;
    static const pl_u8 forms[][16]={{0x06},{0xf0,0x90},{0x0f,0x0b},{0xf0,0xf4},{0xf3,0x0f,0x0b},
        {0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66,0x66}};
    static const pl_u32 sizes[]={1,2,2,2,3,15};pl_u64 first_bytes=0u;unsigned cases=0u;int status=3;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};pl_x86_image image={&map,1u,0u,map.address};
    for(pl_u32 i=0u;i<sizeof sizes/sizeof sizes[0];++i){
        pl_u32 vector=i==5u?13u:6u;
        if(!probe(native,forms[i],sizes[i],vector)){fprintf(stderr,"native fault priority form %u vector %u\n",i,(unsigned)native_vector);goto done;}
        memset(page,0x90,sizeof page);memcpy(page+4096u-sizes[i],forms[i],sizes[i]);
        wasm_cut_options options={map.address+4096u-sizes[i],1u,sizeof module};wasm_cut_report report;pl_u64 bytes=0u;
        pl_x86_instruction decoded;pl_x86_fault_cut fault;
        if(pl_x86_decode_profile(&image,options.entry,&decoded) || !pl_x86_fault_cut_lower(&decoded,&fault)
                || fault.bytes!=sizes[i] || fault.vector!=vector)goto done;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
                || report.boundary!=WASM_CUT_FAULT || report.source_bytes!=sizes[i]
                || report.source_instructions!=1u || report.continuation!=options.entry
                || report.read_registers || report.written_registers || report.flags_written)goto done;
        if(i==0u){memcpy(witness,module,(size_t)bytes);first_bytes=bytes;}
        if(vector==6u && (bytes!=first_bytes || memcmp(witness,module,(size_t)bytes)))goto done;
        ++cases;
    }
    status=0;printf("Fault cut: %u native #UD/#GP at page end before inaccessible page; exact decisive extent and shared #UD body\n",cases);
done:
    if(sigaction(SIGILL,&old_ill,0) || sigaction(SIGSEGV,&old_segv,0) || munmap(native,8192))status=1;
    return status;
}
