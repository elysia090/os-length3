#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include "fault-admission.h"
#include "segment-admission.h"
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
    (void)number;__asm__ volatile("cld" ::: "cc");
    const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for(pl_u32 i=0u;i<16u;++i)registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL];vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR];fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address=(pl_u64)(uintptr_t)info->si_addr;trapped=1;siglongjmp(recovery,1);
}
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u;*seed^=*seed>>7u;*seed^=*seed<<17u;return *seed; }
static void put(pl_u8 *target,pl_u64 value,pl_u32 bytes)
{ for(pl_u32 i=0u;i<bytes;++i)target[i]=(pl_u8)(value>>(8u*i)); }
static pl_u64 word(const pl_u8 *target,pl_u32 bytes)
{ pl_u64 value=0u;for(pl_u32 i=0u;i<bytes;++i)value|=(pl_u64)target[i]<<(8u*i);return value; }
static void observe(const machine_state *state,const void *code)
{ trapped=0;if(!sigsetjmp(recovery,1))native_stack_cut(state,code); }
static int save(const char *directory,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!directory)return 0;
    char name[4096];int n=snprintf(name,sizeof name,"%s/memory-shift-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx");if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1;if(fclose(file))status=-1;return status;
}
static pl_u32 encoding(pl_u32 form,pl_u32 *width,pl_u32 *kind,pl_u32 *operation,pl_u32 *count_kind,pl_u32 *count)
{
    static const pl_u32 selectors[]={0u,1u,4u,5u,7u},counts[]={0u,1u,7u,8u,15u,16u,31u,32u,63u,64u,255u};
    if(form<260u) {
        *operation=selectors[form/52u];*width=8u<<((form/13u)%4u);*kind=0u;
        *count_kind=form%13u;*count=*count_kind<2u?*count_kind:counts[*count_kind-2u];
    } else {
        pl_u32 extra=form-260u;*operation=selectors[extra/16u];*width=8u<<((extra/4u)%4u);
        *kind=extra%4u+1u;*count_kind=0u;*count=0u;
    }
    pl_u32 at=0u;
    if(*kind==1u)source[at++]=0x67u;
    if(*width==16u)source[at++]=0x66u;
    if(*width==64u || *kind==3u)source[at++]=(pl_u8)((*width==64u?0x48u:0x40u)|(*kind==3u?1u:0u));
    source[at++]=(pl_u8)((*count_kind==0u?0xd2u:*count_kind==1u?0xd0u:0xc0u)+(*width!=8u));
    pl_u32 selector=*operation<<3u;
    if(*kind<2u)source[at++]=(pl_u8)(selector|7u);
    else if(*kind==2u) { source[at++]=(pl_u8)(selector|0x44u);source[at++]=0x24u;source[at++]=16u; }
    else if(*kind==3u) { source[at++]=(pl_u8)(selector|0x44u);source[at++]=0x8cu;source[at++]=7u; }
    else {
        source[at++]=(pl_u8)(selector|5u);pl_u32 displacement=2048u-(at+4u);
        for(pl_u32 i=0u;i<4u;++i)source[at++]=(pl_u8)(displacement>>(8u*i));
    }
    if(*count_kind>=2u)source[at++]=(pl_u8)*count;
    return at;
}
static pl_u64 defined_flags(pl_u32 width,pl_u32 operation,pl_u32 count)
{
    if(!count)return ~0ull;
    pl_u64 undefined=operation<2u?0u:0x10u;
    if(count!=1u)undefined|=0x800u;
    if(operation!=7u && operation>=4u && count>=width)undefined|=1u;
    return ~undefined;
}
static int check_admission(void)
{
    pl_u8 page[4096];pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
    for(pl_u32 form=0u;form<340u;++form) {
        pl_u32 width,kind,operation,count_kind,count;memset(source,0x90,sizeof source);
        pl_u32 size=encoding(form,&width,&kind,&operation,&count_kind,&count);
        memset(page,0x90,sizeof page);memcpy(page+1u,source,size);
        wasm_cut_report report;pl_u64 emitted=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions!=1u || report.source_bytes!=1u || report.memory_bytes)return -1;
        options.entry=map.address+1u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_bytes!=size || report.boundary!=WASM_CUT_MEMORY)return -1;
        options.entry=map.address;
    }
    static const pl_u8 prefixes[]={0xf0u,0x64u,0x65u};
    for(pl_u32 width=8u;width<=64u;width*=2u)
    for(pl_u32 refusal=0u;refusal<5u;++refusal) {
        memset(page,0x90,sizeof page);pl_u32 at=0u;
        if(refusal<3u)page[at++]=prefixes[refusal];
        if(width==16u)page[at++]=0x66u;
        if(width==64u)page[at++]=0x48u;
        page[at++]=(pl_u8)(width==8u?0xd2u:0xd3u);
        page[at]=(pl_u8)((refusal<3u?7u:refusal-1u)<<3u|7u);
        if(refusal==0u){if(check_fault_admission(&image,&options,6u))return -1;continue;}
        memset(module,0xa5,sizeof module);wasm_cut_report report;memset(&report,0xa5,sizeof report);
        if(refusal==1u||refusal==2u){
            if(check_segment_admission(&image,&options,page[0]))return -1;
            continue;
        }
        wasm_cut_report before=report;pl_u64 emitted=77u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)!=WASM_COMPILER_ERROR_GRAMMAR
            || emitted!=77u || memcmp(&report,&before,sizeof report))return -1;
        for(pl_u32 i=0u;i<sizeof module;++i)if(module[i]!=0xa5u)return -1;
    }
    return 0;
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
    const pl_u64 addresses[]={0x12340000u,0x200012340000ull};
    pl_u8 *ram[2]={MAP_FAILED,MAP_FAILED};int status=1;pl_u32 faults=0u,observed=0u,zero_write_faults=0u;
    if(code==MAP_FAILED) { perror("shift code mmap");goto finish; }
    for(pl_u32 i=0u;i<2u;++i) {
        ram[i]=mmap((void *)(uintptr_t)addresses[i],8192u,PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
        if(ram[i]==MAP_FAILED) { perror("shift RAM mmap");goto finish; }
    }
    static const pl_u32 edge_counts[]={0u,1u,7u,8u,15u,16u,31u,32u,63u,64u,65u,127u,128u,255u,33u,17u};
    pl_u64 seed=0x8731c59abd26e40full;
    for(pl_u32 form=0u;form<340u;++form) {
        memset(source,0x90,sizeof source);pl_u32 width,kind,operation,count_kind,count;
        pl_u32 size=encoding(form,&width,&kind,&operation,&count_kind,&count),bytes=width/8u;
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
        pl_u64 emitted=0u;wasm_cut_report report={0};
        if(!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if(compiled || report.source_bytes!=size || report.source_instructions!=1u
                || report.boundary!=WASM_CUT_MEMORY || report.written_registers || report.memory_bytes!=bytes
                || (report.memory_access&3u)!=3u) {
                fprintf(stderr,"memory shift %u red: compiler=%d\n",form,compiled);goto finish;
            }
        }
        pl_u64 records[512][42];
        for(pl_u32 row=0u;row<512u;++row) {
            pl_u32 phase=row<256u?0u:row%16u,owner=phase==10u?1u:0u;
            pl_u8 saved[2][8192],saved_code[4096];
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC))goto finish;
            for(pl_u32 i=0u;i<2u;++i) {
                if(mprotect(ram[i],8192u,PROT_READ|PROT_WRITE))goto finish;
                for(pl_u32 j=0u;j<8192u;++j)saved[i][j]=ram[i][j]=(pl_u8)(j*37u+row+i*91u);
            }
            memcpy(code,source,sizeof source);code[size]=0xffu;code[size+1u]=0x25u;
            put(code+size+2u,0u,4u);put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
            machine_state state={0};
            for(pl_u32 i=0u;i<16u;++i)state.registers[i]=random_word(&seed);
            state.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u32 raw_count=row<256u?row:edge_counts[(row-256u)/16u];
            state.registers[1]=(state.registers[1]&~255ull)|raw_count;
            pl_u32 effective=(count_kind?count:raw_count)&(width==64u?63u:31u);
            pl_u64 operand=phase>=1u && phase<=3u?addresses[owner]+4095u
                :phase==5u?0x8000000000000000ull:phase==6u?addresses[owner]+12288u
                :addresses[owner]+512u+row%8u;
            if(kind==0u || kind==1u)state.registers[7]=operand;
            else if(kind==2u)state.registers[4]=operand-16u;
            else if(kind==3u)state.registers[12]=operand-state.registers[1]*4u-7u;
            else operand=0x400800u;
            if(kind==1u) { state.registers[7]|=0xabcdef9800000000ull;operand=(pl_u32)operand;owner=0u; }
            pl_u8 *target=NULL;
            for(pl_u32 i=0u;i<2u;++i)if(operand>=addresses[i] && operand+bytes<=addresses[i]+8192u)target=ram[i]+operand-addresses[i];
            if(kind==4u)target=code+2048u;
            if(target && (phase==8u || phase==9u || phase==11u))put(target,phase==8u?0u:phase==9u?~0ull:1ull<<(width-1u),bytes);
            for(pl_u32 i=0u;i<2u;++i)memcpy(saved[i],ram[i],8192u);
            memcpy(saved_code,code,4096u);pl_u64 before=target?word(target,bytes):0u;
            if(phase==2u && mprotect(ram[owner]+4096u,4096u,PROT_READ))goto finish;
            if(phase==3u && mprotect(ram[owner]+4096u,4096u,PROT_NONE))goto finish;
            if((phase==4u || phase==7u || phase==14u) && mprotect(ram[owner],8192u,PROT_READ))goto finish;
            if(kind==4u && (phase==4u || phase==7u || phase==14u)
                && mprotect(code,4096u,PROT_READ|PROT_EXEC))goto finish;
            observe(&state,code);
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC))goto finish;
            for(pl_u32 i=0u;i<2u;++i)if(mprotect(ram[i],8192u,PROT_READ|PROT_WRITE))goto finish;
            if(trapped && (fault_rip!=image.entry || (flags&~0x10000ull)!=state.rflags
                || (vector!=12u && vector!=13u && vector!=14u)))goto finish;
            for(pl_u32 reg=0u;reg<16u;++reg) {
                pl_u64 actual=trapped?registers[reg]:native_stack_result[reg];
                if(actual!=state.registers[reg]) { fprintf(stderr,"shift CPU %u/%u/%u\n",form,row,reg);goto finish; }
                records[row][reg]=state.registers[reg];records[row][17u+reg]=actual;
            }
            pl_u64 after=target?word(target,bytes):0u;
            if(!trapped) {
                if(!target)goto finish;
                if(kind==4u)put(saved_code+2048u,after,bytes);
                else for(pl_u32 i=0u;i<2u;++i)if(operand>=addresses[i] && operand+bytes<=addresses[i]+8192u)
                    put(saved[i]+operand-addresses[i],after,bytes);
            }
            for(pl_u32 i=0u;i<2u;++i)if(memcmp(saved[i],ram[i],8192u))goto finish;
            if(memcmp(saved_code,code,4096u))goto finish;
            records[row][16]=state.rflags;records[row][33]=trapped?state.rflags:native_stack_result[16];
            records[row][34]=trapped?image.entry:image.entry+size;
            records[row][35]=trapped?vector:0u;records[row][36]=trapped?error:0u;
            records[row][37]=trapped?(vector==14u?fault_address:operand):0u;
            records[row][38]=operand;records[row][39]=before;records[row][40]=after;
            records[row][41]=trapped?~0ull:defined_flags(width,operation,effective);
            if(trapped) { ++faults;if(!effective && vector==14u && (error&2u))++zero_write_faults; }
            ++observed;
        }
        char json[280];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"bytes\":%u,\"sourceBytes\":%u,\"native\":512,\"words\":42,\"kind\":%u,\"operation\":%u,\"countKind\":%u,\"count\":%u}\n",
            form,bytes,size,kind,operation,count_kind,count);
        if(n<1 || (size_t)n>=sizeof json || save(directory,form,"json",json,(size_t)n)
            || save(directory,form,"source-page",source,sizeof source) || save(directory,form,"cases",records,sizeof records)
            || (!observe_only && save(directory,form,"wasm",module,(size_t)emitted)))goto finish;
    }
    if(!observe_only && check_admission())goto finish;
    status=0;
finish:
    if(code!=MAP_FAILED && munmap(code,4096u))status=1;
    for(pl_u32 i=0u;i<2u;++i)if(ram[i]!=MAP_FAILED && munmap(ram[i],8192u))status=1;
    if(sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGBUS,&old_bus,NULL) || sigaltstack(&old_stack,NULL))status=1;
    if(!status)printf("memory shift: %u actual x86 CPU/RAM observations, %u fault frames, %u masked-zero write faults%s\n",
        observed,faults,zero_write_faults,observe_only?"; lowering not tested":"");
    return status;
}
