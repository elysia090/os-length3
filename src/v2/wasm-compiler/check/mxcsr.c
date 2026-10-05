#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <machine/memory.h>
#include <signal.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>

extern void native_stack_cut(const machine_state *,const void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
typedef struct {
    machine_state before,after;
    pl_u64 address,old_word,new_word,vector,error,fault_address;
} observation;
static observation records[256];
static pl_u8 source[4096],module[65536],alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 fault_registers[16],fault_flags,vector,error,fault_rip,fault_address;
static _Alignas(16) pl_u8 fault_fpu[512];
static void exception(int number,siginfo_t *info,void *pointer)
{
    (void)number; __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for(pl_u32 i=0u;i<16u;++i)fault_registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    fault_flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL];
    vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR];
    fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address=(pl_u64)(uintptr_t)info->si_addr;
    memcpy(fault_fpu,context->uc_mcontext.fpregs,sizeof fault_fpu);
    trapped=1; siglongjmp(recovery,1);
}
static void observe(const machine_state *state,const void *code)
{ trapped=0; if(!sigsetjmp(recovery,1))native_stack_cut(state,code); }
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u; *seed^=*seed>>7u; *seed^=*seed<<17u; return *seed; }
static void put(void *target,pl_u64 value,pl_u32 bytes)
{ for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)target)[i]=(pl_u8)(value>>(8u*i)); }
static pl_u64 word(const void *target,pl_u32 bytes)
{ pl_u64 value=0u; for(pl_u32 i=0u;i<bytes;++i)value|=(pl_u64)((const pl_u8 *)target)[i]<<(8u*i); return value; }
static int save(const char *directory,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!directory)return 0;
    char name[4096]; int n=snprintf(name,sizeof name,"%s/mxcsr-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx"); if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1; if(fclose(file))status=-1; return status;
}
static pl_u32 encoding(pl_u32 form)
{
    pl_u32 kind=form%8u,store=form/8u,at=0u;
    if(kind==1u)source[at++]=0x67u;
    if(kind==3u || kind==4u)source[at++]=0x41u;
    source[at++]=0x0fu; source[at++]=0xaeu;
    pl_u32 selector=store?0x18u:0x10u;
    if(kind<2u)source[at++]=(pl_u8)(selector|7u);
    else if(kind==2u) { source[at++]=(pl_u8)(selector|0x44u);source[at++]=0x24u;source[at++]=12u; }
    else if(kind==3u)source[at++]=(pl_u8)selector;
    else if(kind==4u) { source[at++]=(pl_u8)(selector|0x44u);source[at++]=0x8cu;source[at++]=7u; }
    else if(kind==5u) { source[at++]=(pl_u8)(selector|5u);put(source+at,2048u-at-4u,4u);at+=4u; }
    else if(kind==6u) { source[at++]=(pl_u8)(selector|0x45u);source[at++]=0xf8u; }
    else { source[at++]=(pl_u8)(selector|0x87u);put(source+at,0xfffff001u,4u);at+=4u; }
    return at;
}
static int admission(void)
{
    pl_u8 page[4096]; pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address}; wasm_cut_options options={map.address,8u,sizeof module};
    for(pl_u32 form=0u;form<16u;++form) {
        memset(source,0x90,sizeof source); pl_u32 size=encoding(form);
        memset(page,0x90,sizeof page);memcpy(page+1u,source,size);
        wasm_cut_report report;pl_u64 emitted=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_instructions!=1u || report.source_bytes!=1u || report.memory_bytes)return -1;
        options.entry=map.address+1u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_instructions!=1u || report.source_bytes!=size
                || report.memory_bytes!=4u || report.boundary!=WASM_CUT_SYSTEM)return -1;
        options.entry=map.address;
    }
    static const pl_u8 invalid[][5]={{0xf0u,0x0fu,0xaeu,0x17u},{0x0fu,0xaeu,0xd0u},
        {0xc5u,0xf8u,0xaeu,0x17u},{0x64u,0x0fu,0xaeu,0x17u},{0x65u,0x0fu,0xaeu,0x1fu},
        {0xf0u,0x0fu,0xaeu,0x0fu}};
    for(pl_u32 i=0u;i<sizeof invalid/sizeof invalid[0];++i) {
        memset(page,0x90,sizeof page);memcpy(page,invalid[i],sizeof invalid[i]);
        memset(module,0xa5,sizeof module);wasm_cut_report report;memset(&report,0xa5,sizeof report);
        wasm_cut_report before=report;pl_u64 emitted=77u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)!=WASM_COMPILER_ERROR_GRAMMAR
                || emitted!=77u || memcmp(&report,&before,sizeof report))return -1;
        for(pl_u32 j=0u;j<sizeof module;++j)if(module[j]!=0xa5u)return -1;
    }
    return 0;
}
int main(int argc,char **argv)
{
    int observe_only=argc==3 && !strcmp(argv[2],"--observe");
    if(argc!=1 && argc!=2 && !observe_only)return 2;
    const char *directory=argc>=2?argv[1]:NULL;
    stack_t old_stack,stack={.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv,old_bus,old_ill,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if(sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_segv)
            || sigaction(SIGBUS,&action,&old_bus) || sigaction(SIGILL,&action,&old_ill))return 1;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x12340000u,8192u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    if(code==MAP_FAILED || ram==MAP_FAILED)return 1;
    pl_u64 seed=0x185255004080ff21ull;int status=1;pl_u32 observations=0u,faults=0u;
    for(pl_u32 form=0u;form<16u;++form) {
        memset(source,0x90,sizeof source);pl_u32 size=encoding(form),kind=form%8u,store=form/8u;
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
        wasm_cut_report report={0};pl_u64 emitted=0u;
        if(!observe_only) {
            int result=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if(result || report.source_bytes!=size || report.source_instructions!=1u || report.memory_bytes!=4u
                    || report.boundary!=WASM_CUT_SYSTEM || report.written_registers || report.flags_written
                    || (report.memory_access&3u)!=(store?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ)) {
                fprintf(stderr,"MXCSR %u red: compiler=%d\n",form,result);goto finish;
            }
        }
        for(pl_u32 row=0u;row<256u;++row) {
            pl_u32 phase=row%16u;
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC) || mprotect(ram,8192u,PROT_READ|PROT_WRITE))goto finish;
            memcpy(code,source,sizeof source);code[size]=0xffu;code[size+1u]=0x25u;
            put(code+size+2u,0u,4u);put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
            for(pl_u32 i=0u;i<8192u;++i)ram[i]=(pl_u8)(i*37u+row);
            observation *record=&records[row];memset(record,0,sizeof *record);
            machine_state *state=&record->before;
            for(pl_u32 i=0u;i<16u;++i)state->registers[i]=random_word(&seed);
            state->rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u64 operand=phase>=1u && phase<=3u?0x12340fffull:phase==5u?0x8000000000000000ull
                :phase==6u?0x12343000u:0x12340200u+row%4u;
            state->registers[4u]=0x12341c00u;
            if(kind<2u)state->registers[7u]=operand;
            else if(kind==2u)state->registers[4u]=operand-12u;
            else if(kind==3u)state->registers[8u]=operand;
            else if(kind==4u)state->registers[12u]=operand-state->registers[1u]*4u-7u;
            else if(kind==5u)operand=0x400800u;
            else if(kind==6u)state->registers[5u]=operand+8u;
            else state->registers[7u]=operand+4095u;
            if(kind==1u)state->registers[7u]|=0xabcdef9800000000ull;
            pl_u8 *target=operand>=0x12340000u && operand+4u<=0x12342000u?ram+(size_t)(operand-0x12340000u)
                :kind==5u?code+2048u:NULL;
            pl_u32 value=(pl_u32)random_word(&seed)&0xffffu;
            if(phase==8u)value=0u;else if(phase==9u)value=0xffffu;
            else if(phase>=10u)value|=1u<<(16u+(row/16u)%16u);
            if(target)put(target,value,4u);
            record->address=operand;record->old_word=target?word(target,4u):0u;
            pl_u8 saved[8192],saved_code[4096];memcpy(saved,ram,sizeof saved);memcpy(saved_code,code,sizeof saved_code);
            if(phase==2u && mprotect(ram+4096u,4096u,PROT_READ))goto finish;
            if(phase==3u && mprotect(ram+4096u,4096u,PROT_NONE))goto finish;
            if(phase==4u && mprotect(ram,8192u,PROT_READ))goto finish;
            if(kind==5u && phase==4u && mprotect(code,4096u,PROT_READ|PROT_EXEC))goto finish;
            _Alignas(16) pl_u8 host[512],before[512],after[512];
            pl_u32 initial=(pl_u32)random_word(&seed)&0xffffu;
            __asm__ volatile("fxsave64 %[host]\n\tldmxcsr %[initial]\n\tfxsave64 %[before]"
                :[host]"=m"(host),[before]"=m"(before):[initial]"m"(initial):"memory");
            observe(state,code);
            if(trapped)memcpy(after,fault_fpu,sizeof after);
            else __asm__ volatile("fxsave64 %0":"=m"(after));
            __asm__ volatile("fxrstor64 %0"::"m"(host):"memory");
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC) || mprotect(ram,8192u,PROT_READ|PROT_WRITE))goto finish;
            state->mxcsr=(pl_u32)word(before+24u,4u);
            /* The fixture records actual MXCSR and GPR/flags. Other owner fields
             * are retained byte-exactly; FPU image checks independently rule out
             * hidden x87/XMM changes, without an FP arithmetic oracle. */
            if(memcmp(before,after,24u) || memcmp(before+28u,after+28u,388u)) {
                fprintf(stderr,"MXCSR FPU preservation %u/%u\n",form,row);goto finish;
            }
            state->rip=map.address;state->cr0=0x80010011u;state->cr3=0x1000u;state->cr4=0x220u;state->efer=0xd00u;
            state->system[MACHINE_SYSTEM_CS]=19u;state->system[MACHINE_SYSTEM_DR0+6u]=0xffff0ff0u;
            state->system[MACHINE_SYSTEM_DR0+7u]=0x400u;state->msr_keys[0u]=0x87654321u;state->retired=42u;
            record->after=*state;record->after.mxcsr=(pl_u32)word(after+24u,4u);
            if(trapped && (fault_rip!=map.address || (fault_flags&~0x10000ull)!=state->rflags
                    || (vector!=12u && vector!=13u && vector!=14u)))goto finish;
            for(pl_u32 i=0u;i<16u;++i) {
                pl_u64 actual=trapped?fault_registers[i]:native_stack_result[i];
                if(actual!=state->registers[i]) { fprintf(stderr,"MXCSR GPR %u/%u/%u\n",form,row,i);goto finish; }
            }
            if(trapped) {
                record->vector=vector;record->error=error;record->fault_address=vector==14u?fault_address:operand;++faults;
                if(record->after.mxcsr!=state->mxcsr)goto finish;
            } else {
                record->after.rflags=native_stack_result[16u];record->after.rip+=size;++record->after.retired;
                if(record->after.rflags!=state->rflags || !target)goto finish;
            }
            record->new_word=target?word(target,4u):0u;
            if(!trapped && store) { if(kind==5u)put(saved_code+2048u,record->new_word,4u);
                else put(saved+(size_t)(operand-0x12340000u),record->new_word,4u); }
            if(memcmp(saved,ram,sizeof saved) || memcmp(saved_code,code,sizeof saved_code))goto finish;
            if(!trapped && (!store?record->after.mxcsr!=record->old_word:record->new_word!=state->mxcsr))goto finish;
            ++observations;
        }
        char json[256];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"native\":256,\"stateBytes\":%zu,\"recordBytes\":%zu,\"kind\":%u,\"store\":%u}\n",
            size,sizeof(machine_state),sizeof(observation),kind,store);
        if(n<1 || (size_t)n>=sizeof json || save(directory,form,"json",json,(size_t)n)
            || save(directory,form,"source-page",source,sizeof source) || save(directory,form,"cases",records,sizeof records)
            || (!observe_only && save(directory,form,"wasm",module,(size_t)emitted)))goto finish;
    }
    if(!observe_only && admission())goto finish;
    status=0;
finish:
    if(munmap(code,4096u) || munmap(ram,8192u))status=1;
    if(sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGBUS,&old_bus,NULL) || sigaction(SIGILL,&old_ill,NULL)
            || sigaltstack(&old_stack,NULL))status=1;
    if(!status)printf("MXCSR: %u actual x86 CPU/memory observations, %u fault frames%s; CR0/CR4 faults require system/model checks\n",
        observations,faults,observe_only?"; lowering not tested":"");
    return status;
}
