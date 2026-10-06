#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include "segment-admission.h"
#include <machine/state.h>
#include <machine/memory.h>
#include <x86/decode.h>
#include <signal.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>

extern void native_vector(const machine_state *,const void *,const void *,void *,void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
typedef struct {
    machine_state before,after;
    pl_u64 address,old_low,old_high,new_low,new_high,vector,error,fault_address;
} observation;
static observation records[128];
static pl_u8 source[4096],module[65536],alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 fault_registers[16],fault_flags,vector,error,fault_rip,fault_address;
static _Alignas(16) pl_u8 fault_fpu[512],host[512],initial[512],before[512],after[512];
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
{
    __asm__ volatile("fxsave64 %0":"=m"(host));
    trapped=0;
    if(!sigsetjmp(recovery,1))native_vector(state,code,initial,before,after);
    __asm__ volatile("sfence" ::: "memory"); /* Observe non-temporal stores too. */
    if(trapped)memcpy(after,fault_fpu,sizeof after);
    __asm__ volatile("fxrstor64 %0"::"m"(host):"memory");
}
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u; *seed^=*seed>>7u; *seed^=*seed<<17u; return *seed; }
static void put(void *target,pl_u64 value,pl_u32 bytes)
{ for(pl_u32 i=0u;i<bytes;++i)((pl_u8 *)target)[i]=(pl_u8)(value>>(8u*i)); }
static pl_u64 word(const void *target,pl_u32 bytes)
{ pl_u64 value=0u; for(pl_u32 i=0u;i<bytes;++i)value|=(pl_u64)((const pl_u8 *)target)[i]<<(8u*i); return value; }
static int save(const char *directory,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if(!directory)return 0;
    char name[4096]; int n=snprintf(name,sizeof name,"%s/vector-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx"); if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1; if(fclose(file))status=-1; return status;
}
/* Six ordinary families have load/store/register forms. MOVNTPS/MOVNTPD
 * have memory-store forms only. Twelve MOVDQU forms vary address topology.
 * Eight PADDQ forms and twelve logical families use the same precise operand
 * boundary, with distinct-register/alias and six memory address topologies.
 * Twelve unpack encodings add the same forms, including ignored source halves.
 * The three narrower packed additions expose carry isolation and doubling.
 * PSHUFB adds all selector bits, self-alias and the same memory topologies.
 * Immediate logical shifts cover all widths, both directions and count cuts.
 * Dword/high-word/low-word permutations share the eight operand topologies. */
enum { VECTOR_FORMS=432u };
static pl_u32 permutation_width(pl_u32 form)
{ return form<360u || form>=408u?0u:form<368u || form>=384u?32u:16u; }
static pl_u32 permutation_high(pl_u32 form)
{ return form>=368u && form<376u; }
static pl_u32 permutation_two(pl_u32 form)
{ return form>=384u && form<392u; }
static pl_u32 permutation_fixed(pl_u32 form)
{ return form>=392u && form<408u; }
static pl_u32 permutation_control(pl_u32 form)
{ return form<360u || form>=408u?0u:form<392u?0x93u:form<400u?0xf5u:0xa0u; }
static pl_u32 comparison_width(pl_u32 form)
{ return form<408u?0u:8u<<((form-408u)/8u); }
static pl_u32 shift_width(pl_u32 form)
{ return form<264u || form>=360u?0u:form<296u?32u:form<328u?64u:16u; }
static pl_u32 shift_count(pl_u32 form)
{
    static const pl_u32 counts[]={0u,1u,2u,7u,8u,12u,15u,16u,20u,31u,32u,33u,63u,64u,127u,255u};
    return form<264u || form>=360u?0u:counts[(form-264u)%16u];
}
static pl_u32 shift_left(pl_u32 form)
{ return form>=264u && form<360u && ((form-264u)/16u&1u); }
static pl_u32 unpack_width(pl_u32 form)
{
    static const pl_u32 widths[]={8u,16u,32u,64u,8u,16u,32u,64u,32u,32u,64u,64u};
    return form<136u || form>=232u?0u:widths[(form-136u)/8u];
}
static pl_u32 unpack_high(pl_u32 form)
{
    pl_u32 family=form<136u || form>=232u?0u:(form-136u)/8u;
    return (family>=4u && family<8u) || family==9u || family==11u;
}
static pl_u32 add_width(pl_u32 form)
{
    static const pl_u32 widths[]={32u,8u,16u};
    return form>=232u && form<256u?widths[(form-232u)/8u]:form>=32u && form<40u?64u:0u;
}
static pl_u32 encoding(pl_u32 form,pl_u32 *kind,pl_u32 *store,pl_u32 *reg,pl_u32 *aligned)
{
    if(form>=264u && form<360u) {
        pl_u32 width=shift_width(form);
        *kind=*store=*aligned=0u;*reg=1u;
        source[0]=0x66u;source[1]=0x41u;source[2]=0x0fu;
        source[3]=(pl_u8)(width==16u?0x71u:width==32u?0x72u:0x73u);
        source[4]=(pl_u8)(shift_left(form)?0xf1u:0xd1u);source[5]=(pl_u8)shift_count(form);
        return 6u;
    }
    if(form>=32u) {
        pl_u32 local=(form-32u)%8u,family=form<40u?0u:1u+(form-40u)/8u;
        static const pl_u8 opcodes[]={0xd4u,0xefu,0xdbu,0xebu,0xdfu,
            0x57u,0x54u,0x56u,0x55u,0x57u,0x54u,0x56u,0x55u};
        static const pl_u8 unpack[]={0x60u,0x61u,0x62u,0x6cu,0x68u,0x69u,0x6au,0x6du,
            0x14u,0x15u,0x14u,0x15u};
        static const pl_u8 add[]={0xfeu,0xfcu,0xfdu};
        int is_unpack=form>=136u && form<232u,is_add=form>=232u && form<256u;
        int is_shuffle=form>=256u && form<264u,is_permutation=form>=360u && form<408u;
        int is_compare=form>=408u;
        if(is_unpack)family=(form-136u)/8u;else if(is_add)family=(form-232u)/8u;
        *kind=local<2u?0u:local-1u;*store=0u;*reg=local<2u;*aligned=!*reg;
        pl_u32 at=0u;if(*kind==1u)source[at++]=0x67u;
        if(is_permutation && !permutation_two(form))
            source[at++]=(pl_u8)(form<368u?0x66u:form<376u || permutation_fixed(form)?0xf3u:0xf2u);
        else if(!is_permutation && (is_shuffle || is_add
            || (is_unpack?(family<8u || family>=10u):(family<5u || family>=9u))))source[at++]=0x66u;
        source[at++]=(pl_u8)(*reg || *kind==3u?0x45u:0x44u);
        source[at++]=0x0fu;
        if(is_permutation)source[at++]=(pl_u8)(permutation_two(form)?0xc6u
            :permutation_fixed(form)?form<400u?0x16u:0x12u:0x70u);
        else if(is_shuffle) {source[at++]=0x38u;source[at++]=0x00u;}
        else source[at++]=is_compare?(pl_u8)(0x74u+(form-408u)/8u)
            :is_add?add[family]:is_unpack?unpack[family]:opcodes[family];
        if(*reg)source[at++]=(pl_u8)(local?0xc9u:0xcbu);
        else if(*kind==1u)source[at++]=0x0fu;
        else if(*kind==2u) {source[at++]=0x4cu;source[at++]=0x24u;source[at++]=12u;}
        else if(*kind==3u) {source[at++]=0x4cu;source[at++]=0x8cu;source[at++]=7u;}
        else if(*kind==4u) {source[at++]=0x0du;put(source+at,2048u-at-4u
            -(pl_u32)(is_permutation && !permutation_fixed(form)),4u);at+=4u;}
        else if(*kind==5u) {source[at++]=0x4du;source[at++]=0xf8u;}
        else {source[at++]=0x8fu;put(source+at,0xfffff001u,4u);at+=4u;}
        if(is_permutation && !permutation_fixed(form))source[at++]=(pl_u8)permutation_control(form);
        return at;
    }
    pl_u32 family=form<18u?form/3u:form<20u?form-12u:0u;
    *kind=form<20u?0u:1u+(form-20u)/2u;
    *store=form<18u?form%3u==1u:form<20u?1u:(form-20u)%2u;
    *reg=form<18u && form%3u==2u;
    *aligned=family==1u || family==3u || family==5u || family>=6u;
    pl_u32 at=0u;
    if(*kind==1u)source[at++]=0x67u;
    if(family<2u)source[at++]=(pl_u8)(family?0x66u:0xf3u);
    else if(family==4u || family==5u || family==7u)source[at++]=0x66u;
    source[at++]=(pl_u8)(*kind==3u || *reg?0x45u:0x44u);
    source[at++]=0x0fu;
    source[at++]=(pl_u8)(family<2u?(*store?0x7fu:0x6fu)
        :family>=6u?0x2bu:family==3u || family==5u?(*store?0x29u:0x28u):(*store?0x11u:0x10u));
    if(*reg)source[at++]=0xcbu; /* xmm11 -> xmm9 (REX.R), including raw NaN bits. */
    else if(*kind<2u)source[at++]=0x0fu; /* xmm9, [rdi] */
    else if(*kind==2u) {source[at++]=0x4cu;source[at++]=0x24u;source[at++]=12u;}
    else if(*kind==3u) {source[at++]=0x4cu;source[at++]=0x8cu;source[at++]=7u;}
    else if(*kind==4u) {source[at++]=0x0du;put(source+at,2048u-at-4u,4u);at+=4u;}
    else if(*kind==5u) {source[at++]=0x4du;source[at++]=0xf8u;}
    else {source[at++]=0x8fu;put(source+at,0xfffff001u,4u);at+=4u;}
    return at;
}
static int admission(void)
{
    pl_u8 page[4096]; pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address}; wasm_cut_options options={map.address,8u,sizeof module};
    for(pl_u32 form=0u;form<VECTOR_FORMS;++form) {
        pl_u32 kind,store,reg,aligned;
        memset(source,0x90,sizeof source);pl_u32 size=encoding(form,&kind,&store,&reg,&aligned);
        memset(page,0x90,sizeof page);memcpy(page+1u,source,size);
        wasm_cut_report report;pl_u64 emitted=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_instructions!=1u || report.source_bytes!=1u || report.memory_bytes)return -1;
        options.entry=map.address+1u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_instructions!=1u || report.source_bytes!=size
                || report.memory_bytes!=(reg?0u:16u) || report.boundary!=WASM_CUT_SYSTEM)return -1;
        options.entry=map.address;
    }
    static const pl_u8 invalid[][6]={{0xf0u,0xf3u,0x0fu,0x6fu,0x07u},
        {0xc5u,0xfau,0x6fu,0x07u},{0x64u,0xf3u,0x0fu,0x6fu,0x07u},
        {0x65u,0xf3u,0x0fu,0x7fu,0x07u},{0x0fu,0x6fu,0x07u},
        {0x0fu,0x60u,0xc1u},{0xc5u,0xf9u,0x62u,0xc1u},
        {0xf0u,0x66u,0x0fu,0x62u,0xc1u},{0x64u,0x66u,0x0fu,0x62u,0x07u},
        {0x65u,0x66u,0x0fu,0x6du,0x07u},
        {0x0fu,0x38u,0x00u,0xc1u}, /* MMX is outside the XMM contract. */
        {0xc4u,0xe2u,0x79u,0x00u,0xc1u},
        {0xf0u,0x66u,0x0fu,0x38u,0x00u,0xc1u},
        {0x64u,0x66u,0x0fu,0x38u,0x00u,0x07u},
        {0x65u,0x66u,0x0fu,0x38u,0x00u,0x07u},
        {0x0fu,0x72u,0xd1u,0x0cu}, /* MMX packed shifts remain outside XMM. */
        {0xc5u,0xf9u,0x72u,0xd1u,0x0cu},
        {0xf0u,0x66u,0x0fu,0x72u,0xd1u,0x0cu},
        {0x0fu,0x70u,0xc1u,0x93u},
        {0xc5u,0xf9u,0x70u,0xc1u,0x93u},
        {0xf0u,0x66u,0x0fu,0x70u,0xc1u,0x93u},
        {0x64u,0x66u,0x0fu,0x70u,0x07u,0x93u},
        {0x65u,0xf2u,0x0fu,0x70u,0x07u,0x93u}};
    for(pl_u32 i=0u;i<sizeof invalid/sizeof invalid[0];++i) {
        memset(page,0x90,sizeof page);memcpy(page,invalid[i],sizeof invalid[i]);
        if(invalid[i][0]==0x64u||invalid[i][0]==0x65u){
            if(check_segment_admission(&image,&options,invalid[i][0]))return -1;
            continue;
        }
        memset(module,0xa5,sizeof module);wasm_cut_report report;memset(&report,0xa5,sizeof report);
        wasm_cut_report old=report;pl_u64 emitted=77u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)!=WASM_COMPILER_ERROR_GRAMMAR
                || emitted!=77u || memcmp(&report,&old,sizeof report))return -1;
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
    pl_u64 seed=0x2352250940811235ull;int status=1;pl_u32 observations=0u,faults=0u;
    for(pl_u32 form=0u;form<VECTOR_FORMS;++form) {
        pl_u32 kind,store,reg,aligned;
        memset(source,0x90,sizeof source);pl_u32 size=encoding(form,&kind,&store,&reg,&aligned);
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
        wasm_cut_report report={0};pl_u64 emitted=0u;
        if(!observe_only) {
            int result=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if(result || report.source_bytes!=size || report.source_instructions!=1u
                    || report.memory_bytes!=(reg?0u:16u) || report.boundary!=WASM_CUT_SYSTEM
                    || report.written_registers || report.flags_written
                    || (report.memory_access&3u)!=(reg?0u:store?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ)) {
                pl_x86_instruction decoded={0};int decode=pl_x86_decode_profile(&image,map.address,&decoded);
                fprintf(stderr,"vector %u red: compiler=%d decode=%d argument=%llx operand-bits=%u/%u register-bits=%u/%u\n",
                    form,result,decode,(unsigned long long)decoded.machine_argument,decoded.operands[0].bits,
                    decoded.operands[1].bits,decoded.operands[0].value.reg.bits,decoded.operands[1].value.reg.bits);goto finish;
            }
        }
        for(pl_u32 row=0u;row<128u;++row) {
            pl_u32 phase=row%16u;
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC) || mprotect(ram,8192u,PROT_READ|PROT_WRITE))goto finish;
            memcpy(code,source,sizeof source);code[size]=0xffu;code[size+1u]=0x25u;
            put(code+size+2u,0u,4u);put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
            for(pl_u32 i=0u;i<8192u;++i)ram[i]=(pl_u8)(i*37u+row);
            observation *record=&records[row];memset(record,0,sizeof *record);
            machine_state *state=&record->before;
            for(pl_u32 i=0u;i<16u;++i)state->registers[i]=random_word(&seed);
            state->rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u64 operand=phase>=1u && phase<=3u?0x12340ff8ull:phase==5u?0x8000000000000000ull
                :phase==6u?0x12343000u:phase>=8u?0x12340200u+(phase-8u):0x12340200u;
            state->registers[4u]=0x12341c00u;
            if(kind<2u)state->registers[7u]=operand;
            else if(kind==2u)state->registers[4u]=operand-12u;
            else if(kind==3u)state->registers[12u]=operand-state->registers[1u]*4u-7u;
            else if(kind==4u)operand=0x400800u;
            else if(kind==5u)state->registers[5u]=operand+8u;
            else state->registers[7u]=operand+4095u;
            if(kind==1u)state->registers[7u]|=0xabcdef9800000000ull;
            pl_u8 *target=operand>=0x12340000u && operand+16u<=0x12342000u?ram+(size_t)(operand-0x12340000u)
                :kind==4u?code+2048u:NULL;
            if(target) {put(target,random_word(&seed),8u);put(target+8u,random_word(&seed),8u);}
            record->address=operand;record->old_low=target?word(target,8u):0u;record->old_high=target?word(target+8u,8u):0u;
            pl_u8 saved[8192],saved_code[4096];memcpy(saved,ram,sizeof saved);memcpy(saved_code,code,sizeof saved_code);
            if(phase==2u && mprotect(ram+4096u,4096u,PROT_READ))goto finish;
            if(phase==3u && mprotect(ram+4096u,4096u,PROT_NONE))goto finish;
            if(phase==4u && mprotect(ram,8192u,PROT_READ))goto finish;
            if(kind==4u && phase==4u && mprotect(code,4096u,PROT_READ|PROT_EXEC))goto finish;
            memset(initial,0,sizeof initial);put(initial,0x37fu,2u);put(initial+24u,random_word(&seed)&0xffffu,4u);
            for(pl_u32 i=0u;i<32u;++i)put(initial+160u+i*8u,random_word(&seed),8u);
            observe(state,code);
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC) || mprotect(ram,8192u,PROT_READ|PROT_WRITE))goto finish;
            state->mxcsr=(pl_u32)word(before+24u,4u);memcpy(state->xmm,before+160u,sizeof state->xmm);
            if(memcmp(before,after,160u)) {fprintf(stderr,"vector FPU preservation %u/%u\n",form,row);goto finish;}
            state->rip=map.address;state->cr0=0x80010011u;state->cr3=0x1000u;state->cr4=0x220u;state->efer=0xd00u;
            state->system[MACHINE_SYSTEM_CS]=19u;state->system[MACHINE_SYSTEM_DR0+6u]=0xffff0ff0u;
            state->system[MACHINE_SYSTEM_DR0+7u]=0x400u;state->msr_keys[0u]=0x87654321u;state->retired=42u;
            record->after=*state;memcpy(record->after.xmm,after+160u,sizeof state->xmm);
            if(trapped && (fault_rip!=map.address || (fault_flags&~0x10000ull)!=state->rflags
                    || (vector!=12u && vector!=13u && vector!=14u))) {fprintf(stderr,"vector unexpected fault %u/%u vector=%llu\n",form,row,(unsigned long long)vector);goto finish;}
            for(pl_u32 i=0u;i<16u;++i) {
                pl_u64 actual=trapped?fault_registers[i]:native_stack_result[i];
                if(actual!=state->registers[i]) {fprintf(stderr,"vector GPR %u/%u/%u\n",form,row,i);goto finish;}
            }
            if(trapped) {
                record->vector=vector;record->error=error;record->fault_address=vector==14u?fault_address:operand;++faults;
                if(memcmp(state->xmm,record->after.xmm,sizeof state->xmm))goto finish;
            } else {
                record->after.rflags=native_stack_result[16u];record->after.rip+=size;++record->after.retired;
                if(record->after.rflags!=state->rflags || (!target&&!reg))goto finish;
            }
            record->new_low=target?word(target,8u):0u;record->new_high=target?word(target+8u,8u):0u;
            if(!trapped && store) {
                pl_u8 *expected=kind==4u?saved_code+2048u:saved+(size_t)(operand-0x12340000u);
                put(expected,record->new_low,8u);put(expected+8u,record->new_high,8u);
            }
            if(memcmp(saved,ram,sizeof saved) || memcmp(saved_code,code,sizeof saved_code)) {
                fprintf(stderr,"vector partial/unrelated RAM write %u/%u\n",form,row);goto finish;
            }
            if(!trapped) {
                int alias=form>=32u && (form-32u)%8u==1u;
                pl_u64 low=store?state->xmm[18u]:reg?state->xmm[alias?18u:22u]:record->old_low;
                pl_u64 high=store?state->xmm[19u]:reg?state->xmm[alias?19u:23u]:record->old_high;
                if(form>=32u && form<40u) {low+=state->xmm[18u];high+=state->xmm[19u];}
                else if(form>=40u && form<136u) {
                    pl_u32 logic=(form-40u)/8u%4u;
                    pl_u64 a=state->xmm[18u],b=state->xmm[19u];
                    low=logic==0u?a^low:logic==1u?a&low:logic==2u?a|low:~a&low;
                    high=logic==0u?b^high:logic==1u?b&high:logic==2u?b|high:~b&high;
                }
                else if(form>=136u && form<232u) {
                    /* Independent element-by-element oracle, not the lowered
                     * word-spreading network. All shifts stay below 64 bits. */
                    pl_u32 width=unpack_width(form),upper=unpack_high(form);
                    pl_u64 a=state->xmm[18u+upper],b=upper?high:low;
                    pl_u64 mask=width==64u?~0ull:(1ull<<width)-1u;
                    low=0u;high=0u;
                    for(pl_u32 i=0u;i<64u/width;++i) {
                        pl_u32 position=i*width*2u;
                        pl_u64 *left=position<64u?&low:&high;
                        pl_u64 *right=position+width<64u?&low:&high;
                        *left|=((a>>(i*width))&mask)<<(position&63u);
                        *right|=((b>>(i*width))&mask)<<((position+width)&63u);
                    }
                }
                else if(form>=232u && form<256u) {
                    pl_u32 width=add_width(form);pl_u64 mask=(1ull<<width)-1u;
                    pl_u64 source_words[]={low,high};low=0u;high=0u;
                    for(pl_u32 half=0u;half<2u;++half)for(pl_u32 i=0u;i<64u/width;++i) {
                        pl_u32 shift=i*width;pl_u64 a=(state->xmm[18u+half]>>shift)&mask;
                        pl_u64 b=(source_words[half]>>shift)&mask;
                        *(half?&high:&low)|=((a+b)&mask)<<shift;
                    }
                }
                else if(form>=256u && form<264u) {
                    pl_u8 values[16],selectors[16],result[16];
                    put(values,state->xmm[18u],8u);put(values+8u,state->xmm[19u],8u);
                    put(selectors,low,8u);put(selectors+8u,high,8u);
                    for(pl_u32 i=0u;i<16u;++i)
                        result[i]=(selectors[i]&128u)?0u:values[selectors[i]&15u];
                    low=word(result,8u);high=word(result+8u,8u);
                }
                else if(form>=264u && form<360u) {
                    pl_u32 width=shift_width(form),count=shift_count(form);
                    pl_u64 mask=width==64u?~0ull:(1ull<<width)-1u;low=high=0u;
                    if(count<width)for(pl_u32 half=0u;half<2u;++half)for(pl_u32 i=0u;i<64u/width;++i) {
                        pl_u32 at=i*width;pl_u64 value=(state->xmm[18u+half]>>at)&mask;
                        *(half?&high:&low)|=(shift_left(form)?(value<<count)&mask:value>>count)<<at;
                    }
                }
                else if(form>=408u) {
                    pl_u32 width=comparison_width(form);
                    pl_u64 mask=(1ull<<width)-1u,old[]={low,high};low=high=0u;
                    for(pl_u32 half=0u;half<2u;++half)for(pl_u32 lane=0u;lane<64u/width;++lane) {
                        pl_u32 shift=lane*width;
                        if(((state->xmm[18u+half]>>shift)&mask)==((old[half]>>shift)&mask))
                            *(half?&high:&low)|=mask<<shift;
                    }
                }
                else if(form>=360u) {
                    /* Independent element extraction/copy, not the compiler's
                     * sixteen static byte-coordinate emission. */
                    pl_u8 old[16],result[16];put(old,low,8u);put(old+8u,high,8u);memcpy(result,old,16u);
                    pl_u32 bytes=permutation_width(form)/8u,start=permutation_high(form)?8u:0u;
                    pl_u8 left[16];put(left,state->xmm[18u],8u);put(left+8u,state->xmm[19u],8u);
                    for(pl_u32 lane=0u;lane<4u;++lane) {
                        pl_u32 selected=(permutation_control(form)>>(lane*2u))&3u;
                        const pl_u8 *owner=permutation_two(form) && lane<2u?left:old;
                        memcpy(result+start+lane*bytes,owner+start+selected*bytes,bytes);
                    }
                    low=word(result,8u);high=word(result+8u,8u);
                }
                if((store?record->new_low:record->after.xmm[18u])!=low
                        || (store?record->new_high:record->after.xmm[19u])!=high)goto finish;
            }
            ++observations;
        }
        char json[768];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"native\":128,\"stateBytes\":%zu,\"recordBytes\":%zu,\"kind\":%u,\"store\":%u,\"register\":%u,\"aligned\":%u,\"add\":%u,\"logic\":%u,\"unpackWidth\":%u,\"unpackHigh\":%u,\"addWidth\":%u,\"shuffle\":%u,\"shiftWidth\":%u,\"shiftCount\":%u,\"shiftLeft\":%u,\"permutationWidth\":%u,\"permutationHigh\":%u,\"permutationControl\":%u,\"permutationTwo\":%u,\"permutationFixed\":%u,\"comparisonWidth\":%u}\n",
            size,sizeof(machine_state),sizeof(observation),kind,store,reg,aligned,
            (pl_u32)(form>=32u && form<40u),form>=40u && form<136u?1u+(form-40u)/8u%4u:0u,
            unpack_width(form),unpack_high(form),add_width(form),(pl_u32)(form>=256u && form<264u),
            shift_width(form),shift_count(form),shift_left(form),permutation_width(form),permutation_high(form),
            permutation_control(form),permutation_two(form),permutation_fixed(form),comparison_width(form));
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
    if(!status)printf("vector transfers/additions/logic/unpack/shuffle/shift/permutation: %u actual x86 CPU/RAM observations, %u fault frames%s; CR0/CR4 require separate models\n",
        observations,faults,observe_only?"; lowering not tested":"");
    return status;
}
