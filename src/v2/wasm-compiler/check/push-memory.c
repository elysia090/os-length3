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
static pl_u8 source[4096],module[65536],alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 registers[16],flags,vector,error,fault_rip,fault_address;
static void exception(int number,siginfo_t *info,void *pointer)
{
    (void)number; __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for(pl_u32 i=0u;i<16u;++i) registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL];vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR];fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address=(pl_u64)(uintptr_t)info->si_addr;trapped=1;siglongjmp(recovery,1);
}
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed; }
static void put(pl_u8 *target,pl_u64 value)
{ for(pl_u32 i=0u;i<8u;++i)target[i]=(pl_u8)(value>>(8u*i)); }
static pl_u64 word(const pl_u8 *target,pl_u32 bytes)
{ pl_u64 value=0u;for(pl_u32 i=0u;i<bytes;++i)value|=(pl_u64)target[i]<<(8u*i);return value; }
static void observe(const machine_state *state,const void *code)
{ trapped=0;if(!sigsetjmp(recovery,1))native_stack_cut(state,code); }
static int save(const char *directory,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!directory)return 0;
    char name[4096];int n=snprintf(name,sizeof name,"%s/push-memory-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx");if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1;if(fclose(file))status=-1;return status;
}
static pl_u32 encoding(pl_u32 form,pl_u32 *width,pl_u32 *address32,pl_u32 *kind)
{
    pl_u32 at=0u;*width=form&1u?16u:64u;*address32=form<24u && (form&2u);*kind=form/4u;
    if(form>=24u) { *width=64u;*address32=0u;*kind=form&1u?1u:0u;source[at++]=(pl_u8)(form<26u?0x3eu:0x36u); }
    if(*address32)source[at++]=0x67u;
    if(*width==16u)source[at++]=0x66u;
    if(*kind==3u)source[at++]=0x43u;
    source[at++]=0xffu;
    if(*kind==0u) { source[at++]=0x74u;source[at++]=0x24u;source[at++]=40u; }
    else if(*kind==1u)source[at++]=0x37u;
    else if(*kind==2u) { source[at++]=0x75u;source[at++]=0u; }
    else if(*kind==3u) { source[at++]=0x74u;source[at++]=0x8cu;source[at++]=16u; }
    else if(*kind==4u) { source[at++]=0x35u;pl_u32 disp=2048u-(at+4u);
        for(pl_u32 i=0u;i<4u;++i)source[at++]=(pl_u8)(disp>>(i*8u)); }
    else { source[at++]=0x34u;source[at++]=0x24u; }
    return at;
}
int main(int argc,char **argv)
{
    int observe_only=argc==3 && !strcmp(argv[2],"--observe");
    if(argc!=1 && argc!=2 && !observe_only)return 2;
    const char *directory=argc>=2?argv[1]:NULL;
    stack_t old_stack,stack={.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv,old_bus,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if(sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_segv) || sigaction(SIGBUS,&action,&old_bus))return 1;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    const pl_u64 addresses[]={0x12340000u,0x23450000u,0x200012340000ull};
    pl_u8 *ram[3]={MAP_FAILED,MAP_FAILED,MAP_FAILED};
    int status=1;pl_u32 faults=0u,observed=0u;
    if(code==MAP_FAILED) { perror("PUSH code mmap");goto finish; }
    for(pl_u32 i=0u;i<3u;++i) {
        ram[i]=mmap((void *)(uintptr_t)addresses[i],8192u,PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
        if(ram[i]==MAP_FAILED) { perror("PUSH RAM mmap");goto finish; }
    }
    pl_u64 seed=0x97bc531ade8642efull;
    for(pl_u32 form=0u;form<28u;++form) {
        memset(source,0x90,sizeof source);pl_u32 width,address32,kind;
        pl_u32 size=encoding(form,&width,&address32,&kind),bytes=width/8u;
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
        pl_u64 emitted=0u;wasm_cut_report report={0};
        if(!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if(compiled || report.source_bytes!=size || report.source_instructions!=1u
                || report.boundary!=WASM_CUT_MEMORY || report.written_registers!=16u
                || report.flags_written || report.memory_bytes!=bytes
                || report.memory_access!=(MACHINE_MEMORY_READ|MACHINE_MEMORY_WRITE|MACHINE_MEMORY_STACK)) {
                fprintf(stderr,"memory PUSH form %u red: compiler=%d bytes=%llu access=%u writes=%u boundary=%u\n",
                    form,compiled,(unsigned long long)report.memory_bytes,report.memory_access,
                    report.written_registers,report.boundary);goto finish;
            }
        }
        pl_u64 records[128][41];
        for(pl_u32 row=0u;row<128u;++row) {
            pl_u32 phase=row%16u,owner=phase==10u?2u:0u;
            pl_u8 saved[3][8192];
            for(pl_u32 i=0u;i<3u;++i) {
                if(mprotect(ram[i],8192u,PROT_READ|PROT_WRITE))goto finish;
                for(pl_u32 j=0u;j<8192u;++j)saved[i][j]=ram[i][j]=(pl_u8)(j*37u+row+i*91u);
            }
            memcpy(code,source,sizeof source);code[size]=0xffu;code[size+1u]=0x25u;
            put(code+size+2u,0u);put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture);
            machine_state state={0};
            for(pl_u32 i=0u;i<16u;++i)state.registers[i]=random_word(&seed);
            state.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u64 rsp=addresses[owner]+768u+row%8u;
            if(phase==1u || phase==4u || phase==7u)rsp=addresses[owner]+4096u+bytes-1u;
            if(phase==5u || phase==6u)rsp=0x8000000000000000ull;
            if(phase==9u)rsp=addresses[owner]+12288u;
            pl_u64 operand=phase==2u || phase==3u || phase==9u?addresses[1]+4095u
                :phase==5u?0x8000000000000000ull
                :phase==11u?rsp-bytes:phase==15u?addresses[1]+12288u:addresses[1]+512u+row%8u;
            if(kind==0u || kind==5u) {
                if(phase==2u || phase==3u)rsp=addresses[owner]+4095u-(kind==0u?40u:0u);
                operand=rsp+(kind==0u?40u:0u);
            } else if(kind==1u)state.registers[7]=operand;
            else if(kind==2u)state.registers[5]=operand;
            else if(kind==3u) { state.registers[9]=row%8u;state.registers[12]=operand-16u-state.registers[9]*4u; }
            else operand=0x400800u;
            state.registers[4]=rsp;
            if(address32) {
                operand=(pl_u32)operand;
                if(kind==1u)state.registers[7]|=0xabcdef9800000000ull;
                if(kind==2u)state.registers[5]|=0xabcdef9800000000ull;
                if(kind==3u) { state.registers[12]|=0xabcdef9800000000ull;state.registers[9]|=0x40000000ull; }
            }
            if(phase==3u || phase==9u) {
                if(mprotect(ram[1]+4096u,4096u,PROT_NONE))goto finish;
                if((kind==0u || kind==5u) && phase==3u && mprotect(ram[0]+4096u,4096u,PROT_NONE))goto finish;
            }
            if(phase==4u && mprotect(ram[owner]+4096u,4096u,PROT_READ))goto finish;
            if(phase==7u && mprotect(ram[owner]+4096u,4096u,PROT_NONE))goto finish;
            if(phase==8u && mprotect(ram[1],8192u,PROT_READ))goto finish;
            if(phase==14u && mprotect(ram[owner],8192u,PROT_READ))goto finish;
            pl_u64 value=0u,destination=rsp-bytes;
            for(pl_u32 i=0u;i<3u;++i)if(operand>=addresses[i] && operand+bytes<=addresses[i]+8192u)
                value=word(saved[i]+operand-addresses[i],bytes);
            if(kind==4u)value=word(source+2048u,bytes);
            observe(&state,code);
            for(pl_u32 i=0u;i<3u;++i)if(mprotect(ram[i],8192u,PROT_READ|PROT_WRITE))goto finish;
            if(trapped && (fault_rip!=image.entry || (flags&~0x10000ull)!=state.rflags
                || (vector!=12u && vector!=13u && vector!=14u)))goto finish;
            for(pl_u32 reg=0u;reg<16u;++reg) {
                pl_u64 actual=trapped?registers[reg]:native_stack_result[reg];
                pl_u64 wanted=state.registers[reg]-(!trapped && reg==4u?bytes:0u);
                if(actual!=wanted) { fprintf(stderr,"PUSH CPU %u/%u/%u\n",form,row,reg);goto finish; }
                records[row][reg]=state.registers[reg];records[row][17u+reg]=actual;
            }
            if(!trapped) {
                if(native_stack_result[16]!=state.rflags)goto finish;
                if(destination<addresses[owner] || destination+bytes>addresses[owner]+8192u)goto finish;
                for(pl_u32 i=0u;i<bytes;++i)saved[owner][destination-addresses[owner]+i]=(pl_u8)(value>>(8u*i));
            }
            for(pl_u32 i=0u;i<3u;++i)if(memcmp(saved[i],ram[i],8192u)) {
                fprintf(stderr,"PUSH unexpected payload %u/%u\n",form,row);goto finish;
            }
            records[row][16]=state.rflags;records[row][33]=state.rflags;
            records[row][34]=trapped?image.entry:image.entry+size;
            records[row][35]=trapped?vector:0u;records[row][36]=trapped?error:0u;
            records[row][37]=!trapped?0u:vector==14u?fault_address
                :operand>>47u!=0u && operand>>47u!=0x1ffffu?operand:destination;
            records[row][38]=destination;records[row][39]=value;records[row][40]=operand;
            if(trapped)++faults;
            ++observed;
        }
        char json[256];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"bytes\":%u,\"sourceBytes\":%u,\"native\":128,\"words\":41,\"address32\":%s,\"kind\":%u}\n",
            form,bytes,size,address32?"true":"false",kind);
        if(n<1 || (size_t)n>=sizeof json || save(directory,form,"json",json,(size_t)n)
            || save(directory,form,"source-page",source,sizeof source) || save(directory,form,"cases",records,sizeof records)
            || (!observe_only && save(directory,form,"wasm",module,(size_t)emitted)))goto finish;
    }
    if(!observe_only) {
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
        pl_u64 emitted=0u;wasm_cut_report report;
        memset(source,0x90,sizeof source);source[1]=0xffu;source[2]=0x74u;source[3]=0x24u;source[4]=40u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions!=1u || report.source_bytes!=1u || report.memory_bytes)goto finish;
        static const pl_u8 prefixes[]={0xf0u,0x64u,0x65u};
        for(pl_u32 i=0u;i<3u;++i) {
            source[0]=prefixes[i];source[1]=0xffu;source[2]=0x37u;memset(module,0xa5,sizeof module);
            memset(&report,0xa5,sizeof report);wasm_cut_report before=report;emitted=77u;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)!=WASM_COMPILER_ERROR_GRAMMAR
                || emitted!=77u || memcmp(&report,&before,sizeof report))goto finish;
            for(pl_u32 j=0u;j<sizeof module;++j)if(module[j]!=0xa5u)goto finish;
        }
    }
    status=0;
finish:
    if(code!=MAP_FAILED && munmap(code,4096u))status=1;
    for(pl_u32 i=0u;i<3u;++i)if(ram[i]!=MAP_FAILED && munmap(ram[i],8192u))status=1;
    if(sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGBUS,&old_bus,NULL) || sigaltstack(&old_stack,NULL))status=1;
    if(!status)printf("memory PUSH: %u actual x86 CPU/RAM observations, %u fault frames%s\n",observed,faults,
        observe_only?"; lowering not tested":"");
    return status;
}
