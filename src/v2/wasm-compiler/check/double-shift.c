#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include "segment-admission.h"
#include <machine/state.h>
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
enum { FORMS=222, WORDS=43, ROWS=512 };
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
    char name[4096];int n=snprintf(name,sizeof name,"%s/double-shift-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx");if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1;if(fclose(file))status=-1;return status;
}
typedef struct { pl_u32 width,kind,right,count_kind,count,destination,source_register,size,instructions; } form_t;
static form_t encode(pl_u32 form)
{
    static const pl_u32 counts[]={0u,1u,15u,16u,17u,31u,32u,33u,63u,64u,255u};
    form_t f={0};pl_u32 rank=form<102u?form:form-102u,per_width=form<102u?17u:20u;
    f.width=16u<<((rank/per_width)%3u);f.right=rank/(per_width*3u);
    pl_u32 flavor=rank%per_width;f.count_kind=flavor<12u?flavor:0u;
    f.count=f.count_kind?counts[f.count_kind-1u]:0u;f.source_register=2u;f.destination=11u;f.instructions=1u;
    f.kind=form<102u?(flavor<12u?0u:flavor-11u):6u;
    if(f.kind==1u)f.source_register=7u;
    if(f.kind==3u)f.source_register=1u;
    if(form>=102u && flavor>=12u) {
        if(flavor==12u)f.source_register=11u;
        if(flavor==13u || flavor==15u)f.destination=1u;
        if(flavor==14u || flavor==15u)f.source_register=1u;
        if(flavor==16u)f.destination=4u;
        if(flavor==18u) { f.source_register=12u;f.destination=15u; }
        if(flavor==19u) { f.count_kind=2u;f.count=1u;f.instructions=4u; }
    }
    pl_u32 at=0u;
    if(form>=102u && flavor==17u) {
        static const pl_u8 prefix[]={0x48u,0x83u,0xc2u,7u};
        memcpy(source,prefix,sizeof prefix);at=sizeof prefix;f.instructions=2u;
    }
    if(f.kind==1u)source[at++]=0x67u;
    if(f.width==16u)source[at++]=0x66u;
    pl_u32 rex=(f.width==64u?8u:0u)|(f.source_register>=8u?4u:0u)
        |((f.kind==4u || (f.kind==6u && f.destination>=8u))?1u:0u);
    if(rex)source[at++]=(pl_u8)(0x40u|rex);
    source[at++]=0x0fu;source[at++]=(pl_u8)((f.right?0xacu:0xa4u)+!f.count_kind);
    pl_u32 selector=(f.source_register&7u)<<3u;
    if(f.kind<2u || f.kind==3u)source[at++]=(pl_u8)(selector|7u);
    else if(f.kind==2u) { source[at++]=(pl_u8)(selector|0x44u);source[at++]=0x24u;source[at++]=16u; }
    else if(f.kind==4u) { source[at++]=(pl_u8)(selector|0x44u);source[at++]=0x8cu;source[at++]=7u; }
    else if(f.kind==5u) {
        source[at++]=(pl_u8)(selector|5u);pl_u32 displacement=2048u-(at+4u+!!f.count_kind);
        for(pl_u32 i=0u;i<4u;++i)source[at++]=(pl_u8)(displacement>>(8u*i));
    } else source[at++]=(pl_u8)(selector|0xc0u|(f.destination&7u));
    if(f.count_kind)source[at++]=(pl_u8)f.count;
    if(form>=102u && flavor==19u) {
        /* Three consumers observe CF/ZF/OF before any later flag kill. */
        static const pl_u8 suffix[]={0x0fu,0x92u,0xc3u,0x0fu,0x94u,0xc1u,0x40u,0x0fu,0x90u,0xc5u};
        memcpy(source+at,suffix,sizeof suffix);at+=sizeof suffix;
    }
    f.size=at;return f;
}
static int admission(void)
{
    pl_u8 page[4096];pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
    for(pl_u32 form=0u;form<102u;++form) {
        memset(source,0x90,sizeof source);form_t f=encode(form);
        memset(page,0x90,sizeof page);memcpy(page+1u,source,f.size);
        wasm_cut_report report;pl_u64 emitted=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions!=1u || report.source_bytes!=1u || report.memory_bytes)return -1;
    }
    static const pl_u8 prefixes[]={0xf0u,0x64u,0x65u};
    for(pl_u32 width=16u;width<=64u;width*=2u)
    for(pl_u32 refusal=0u;refusal<3u;++refusal) {
        memset(page,0x90,sizeof page);pl_u32 at=0u;page[at++]=prefixes[refusal];
        if(width==16u)page[at++]=0x66u;
        if(width==64u)page[at++]=0x48u;
        page[at++]=0x0fu;page[at++]=0xadu;page[at]=0x17u;
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
    pl_u8 *ram[2]={MAP_FAILED,MAP_FAILED};int status=1;
    pl_u32 faults=0u,observed=0u,zero_write_faults=0u,undefined_results=0u;
    if(code==MAP_FAILED)goto finish;
    for(pl_u32 i=0u;i<2u;++i) {
        ram[i]=mmap((void *)(uintptr_t)addresses[i],8192u,PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
        if(ram[i]==MAP_FAILED)goto finish;
    }
    static const pl_u32 edge_counts[]={0u,1u,7u,8u,15u,16u,17u,31u,32u,33u,63u,64u,65u,127u,128u,255u};
    pl_u64 seed=0x57a31c59abd26e40ull;
    for(pl_u32 form=0u;form<FORMS;++form) {
        memset(source,0x90,sizeof source);form_t f=encode(form);pl_u32 bytes=f.width/8u;
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,f.instructions,sizeof module};
        pl_u64 emitted=0u;wasm_cut_report report={0};
        if(!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if(compiled || report.source_bytes!=f.size || report.source_instructions!=f.instructions
                || (f.kind<6u && (report.boundary!=WASM_CUT_MEMORY || report.written_registers
                    || report.memory_bytes!=bytes || (report.memory_access&3u)!=3u))) {
                fprintf(stderr,"double shift %u red: compiler=%d\n",form,compiled);goto finish;
            }
        }
        pl_u64 records[ROWS][WORDS];
        for(pl_u32 row=0u;row<ROWS;++row) {
            pl_u32 phase=f.kind==6u?0u:row<256u?0u:row%16u,owner=phase==10u?1u:0u;
            pl_u8 saved[2][8192],saved_code[4096];
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC))goto finish;
            for(pl_u32 i=0u;i<2u;++i) {
                if(mprotect(ram[i],8192u,PROT_READ|PROT_WRITE))goto finish;
                for(pl_u32 j=0u;j<8192u;++j)saved[i][j]=ram[i][j]=(pl_u8)(j*37u+row+i*91u);
            }
            memcpy(code,source,sizeof source);code[f.size]=0xffu;code[f.size+1u]=0x25u;
            put(code+f.size+2u,0u,4u);put(code+f.size+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
            machine_state state={0};
            for(pl_u32 i=0u;i<16u;++i)state.registers[i]=random_word(&seed);
            state.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u32 raw_count=row<256u?row:edge_counts[(row-256u)/16u];
            if(row>=256u) {
                /* Independently cross count edges with value/sign/carry
                 * edges. Keep full parents distinguishable from low words. */
                pl_u64 mask=f.width==64u?~0ull:(1ull<<f.width)-1u,sign=1ull<<(f.width-1u);
                const pl_u64 values[]={0u,mask,1u,sign,sign-1u,sign+1u,mask-1u,0xaaaaaaaaaaaaaaaaull,
                    0x5555555555555555ull,2u,mask>>1u,mask^sign,0x123456789abcdef0ull,~sign,3u,~3ull};
                if(f.kind==6u)state.registers[f.destination]=values[row%16u];
                if(f.kind==6u || (f.source_register!=7u && f.source_register!=12u))
                    state.registers[f.source_register]=values[(row%16u+5u)%16u];
            }
            state.registers[1]=(state.registers[1]&~255ull)|raw_count;
            pl_u32 effective=(f.count_kind?f.count:raw_count)&(f.width==64u?63u:31u);
            pl_u64 operand=phase>=1u && phase<=3u?addresses[owner]+4095u
                :phase==5u?0x8000000000000000ull:phase==6u?addresses[owner]+12288u
                :addresses[owner]+512u+row%8u;
            if(f.kind==0u || f.kind==1u || f.kind==3u)state.registers[7]=operand;
            else if(f.kind==2u)state.registers[4]=operand-16u;
            else if(f.kind==4u)state.registers[12]=operand-state.registers[1]*4u-7u;
            else if(f.kind==5u)operand=0x400800u;
            else operand=0u;
            if(f.kind==1u) { state.registers[7]|=0xabcdef9800000000ull;operand=(pl_u32)operand;owner=0u; }
            pl_u8 *target=NULL;
            for(pl_u32 i=0u;i<2u;++i)if(operand>=addresses[i] && operand+bytes<=addresses[i]+8192u)target=ram[i]+operand-addresses[i];
            if(f.kind==5u)target=code+2048u;
            if(target && (phase==8u || phase==9u || phase==11u))put(target,phase==8u?0u:phase==9u?~0ull:1ull<<(f.width-1u),bytes);
            for(pl_u32 i=0u;i<2u;++i)memcpy(saved[i],ram[i],8192u);
            memcpy(saved_code,code,4096u);pl_u64 before=target?word(target,bytes):0u;
            if(phase==2u && mprotect(ram[owner]+4096u,4096u,PROT_READ))goto finish;
            if(phase==3u && mprotect(ram[owner]+4096u,4096u,PROT_NONE))goto finish;
            if((phase==4u || phase==7u || phase==14u) && mprotect(ram[owner],8192u,PROT_READ))goto finish;
            if(f.kind==5u && (phase==4u || phase==7u || phase==14u)
                && mprotect(code,4096u,PROT_READ|PROT_EXEC))goto finish;
            observe(&state,code);
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC))goto finish;
            for(pl_u32 i=0u;i<2u;++i)if(mprotect(ram[i],8192u,PROT_READ|PROT_WRITE))goto finish;
            if(trapped && (fault_rip!=image.entry || (flags&~0x10000ull)!=state.rflags
                || (vector!=12u && vector!=13u && vector!=14u)))goto finish;
            for(pl_u32 reg=0u;reg<16u;++reg) {
                pl_u64 actual=trapped?registers[reg]:native_stack_result[reg];
                if((trapped || f.kind<6u) && actual!=state.registers[reg])goto finish;
                records[row][reg]=state.registers[reg];records[row][17u+reg]=actual;
            }
            pl_u64 after=target?word(target,bytes):0u;
            if(!trapped && target) {
                if(f.kind==5u)put(saved_code+2048u,after,bytes);
                else for(pl_u32 i=0u;i<2u;++i)if(operand>=addresses[i] && operand+bytes<=addresses[i]+8192u)
                    put(saved[i]+operand-addresses[i],after,bytes);
            }
            for(pl_u32 i=0u;i<2u;++i)if(memcmp(saved[i],ram[i],8192u))goto finish;
            if(memcmp(saved_code,code,4096u))goto finish;
            pl_u64 undefined=!effective?0u:effective>f.width?0x8d5u:0x10u|(effective!=1u?0x800u:0u);
            records[row][16]=state.rflags;records[row][33]=trapped?state.rflags:native_stack_result[16];
            records[row][34]=trapped?image.entry:image.entry+f.size;
            records[row][35]=trapped?vector:0u;records[row][36]=trapped?error:0u;
            records[row][37]=trapped?(vector==14u?fault_address:operand):0u;
            records[row][38]=operand;records[row][39]=before;records[row][40]=after;
            records[row][41]=trapped?~0ull:~undefined;
            records[row][42]=!trapped && effective>f.width?0u:~0ull;
            if(!records[row][42])++undefined_results;
            if(trapped) { ++faults;if(!effective && vector==14u && (error&2u))++zero_write_faults; }
            ++observed;
        }
        char json[360];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"bytes\":%u,\"sourceBytes\":%u,\"native\":512,\"words\":43,\"kind\":%u,\"right\":%u,\"countKind\":%u,\"count\":%u,\"destination\":%u,\"sourceRegister\":%u,\"instructions\":%u}\n",
            form,bytes,f.size,f.kind,f.right,f.count_kind,f.count,f.destination,f.source_register,f.instructions);
        if(n<1 || (size_t)n>=sizeof json || save(directory,form,"json",json,(size_t)n)
            || save(directory,form,"source-page",source,sizeof source) || save(directory,form,"cases",records,sizeof records)
            || (!observe_only && save(directory,form,"wasm",module,(size_t)emitted)))goto finish;
    }
    if(!observe_only && admission())goto finish;
    status=0;
finish:
    if(code!=MAP_FAILED && munmap(code,4096u))status=1;
    for(pl_u32 i=0u;i<2u;++i)if(ram[i]!=MAP_FAILED && munmap(ram[i],8192u))status=1;
    if(sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGBUS,&old_bus,NULL) || sigaltstack(&old_stack,NULL))status=1;
    if(!status)printf("double shift: %u actual x86 CPU/RAM observations, %u fault frames, %u masked-zero write faults, %u undefined destinations%s\n",
        observed,faults,zero_write_faults,undefined_results,observe_only?"; lowering not tested":"");
    return status;
}
