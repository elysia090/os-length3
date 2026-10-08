#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include "fault-admission.h"
#include "../src/cut-internal.h"
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

extern void native_vector(const machine_state *,const void *,const void *,void *,void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
typedef struct {
    machine_state before,after;
    pl_u64 address,old_low,old_high,new_low,new_high,vector,error,fault_address;
} observation;
static observation records[64];
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
    char name[4096]; int n=snprintf(name,sizeof name,"%s/vector-scalar-%u.%s",directory,form,suffix);
    if(n<1 || (size_t)n>=sizeof name)return -1;
    FILE *file=fopen(name,"wbx"); if(!file)return -1;
    int status=fwrite(data,1u,bytes,file)==bytes?0:-1; if(fclose(file))status=-1; return status;
}
/* All 16 GPRs in both directions/widths; six address topologies; both
 * memory MOVQ encodings; low/high/aliased XMM-only MOVQ encodings;
 * four selected-half families, both directions and all six memory topologies. */
enum { SCALAR_FORMS=156u };
typedef struct { pl_u32 kind,store,reg,width,vector,target,source,general,half,high; } form_info;
static pl_u32 encoding(pl_u32 form,form_info *info)
{
    *info=(form_info){0}; pl_u32 at=0u,rex,opcode,modrm;
    if(form<64u) {
        info->reg=1u;info->width=form<32u?32u:64u;
        info->store=form%2u;info->general=(form%32u)/2u;
        info->vector=(info->general*7u+8u)%16u;
        source[at++]=0x66u;
        rex=0x40u|(info->width==64u?8u:0u)|((info->vector>>3u)<<2u)|(info->general>>3u);
        source[at++]=(pl_u8)rex;source[at++]=0x0fu;
        source[at++]=(pl_u8)(info->store?0x7eu:0x6eu);
        source[at++]=(pl_u8)(0xc0u|((info->vector&7u)<<3u)|(info->general&7u));
        return at;
    }
    if(form>=100u && form<108u) {
        static const pl_u32 pairs[][2]={{9u,11u},{0u,15u},{15u,0u},{9u,9u}};
        info->reg=1u;info->width=64u;info->target=pairs[form%4u][0];info->source=pairs[form%4u][1];
        pl_u32 field=form<104u?info->target:info->source,rm=form<104u?info->source:info->target;
        source[at++]=(pl_u8)(form<104u?0xf3u:0x66u);
        source[at++]=(pl_u8)(0x40u|((field>>3u)<<2u)|(rm>>3u));source[at++]=0x0fu;
        source[at++]=(pl_u8)(form<104u?0x7eu:0xd6u);
        source[at++]=(pl_u8)(0xc0u|((field&7u)<<3u)|(rm&7u));return at;
    }
    if(form>=108u) {
        pl_u32 local=form-108u,family=local/12u;
        info->half=1u;info->high=family>=2u;info->kind=1u+(local%12u)/2u;
        info->store=local%2u;info->width=64u;info->vector=9u;
    } else info->kind=1u+(form<88u?(form-64u)/4u:(form-88u)/2u);
    if(!info->half) {info->store=form%2u;info->width=form>=88u || ((form-64u)%4u)>=2u?64u:32u;info->vector=9u;}
    if(info->kind==1u)source[at++]=0x67u;
    if(!info->half || (form-108u)/12u%2u)
        source[at++]=(pl_u8)(!info->half && form>=88u&&!info->store?0xf3u:0x66u);
    rex=0x44u|(!info->half&&form<88u&&info->width==64u?8u:0u)|(info->kind==3u?1u:0u);
    source[at++]=(pl_u8)rex;source[at++]=0x0fu;
    opcode=info->half?(info->high?0x16u:0x12u)+info->store
        :form>=88u?(info->store?0xd6u:0x7eu):(info->store?0x7eu:0x6eu);source[at++]=(pl_u8)opcode;
    modrm=1u<<3u;
    if(info->kind==1u)source[at++]=(pl_u8)(modrm|7u);
    else if(info->kind==2u) {source[at++]=(pl_u8)(modrm|0x44u);source[at++]=0x24u;source[at++]=12u;}
    else if(info->kind==3u) {source[at++]=(pl_u8)(modrm|0x44u);source[at++]=0x8cu;source[at++]=7u;}
    else if(info->kind==4u) {source[at++]=(pl_u8)(modrm|5u);put(source+at,2048u-at-4u,4u);at+=4u;}
    else if(info->kind==5u) {source[at++]=(pl_u8)(modrm|0x45u);source[at++]=0xf8u;}
    else {source[at++]=(pl_u8)(modrm|0x87u);put(source+at,0xfffff001u,4u);at+=4u;}
    return at;
}
static int admission(void)
{
    pl_u8 page[4096]; pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address}; wasm_cut_options options={map.address,8u,sizeof module};
    for(pl_u32 form=0u;form<SCALAR_FORMS;++form) {
        form_info info;
        memset(source,0x90,sizeof source);pl_u32 size=encoding(form,&info);
        memset(page,0x90,sizeof page);memcpy(page+1u,source,size);
        wasm_cut_report report;pl_u64 emitted=0u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_instructions!=1u || report.source_bytes!=1u || report.memory_bytes)return -1;
        options.entry=map.address+1u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_instructions!=1u || report.source_bytes!=size
                || report.memory_bytes!=(info.reg?0u:info.width/8u) || report.boundary!=WASM_CUT_SYSTEM)return -1;
        options.entry=map.address;
    }
    static const pl_u8 invalid[][6]={{0xf0u,0x66u,0x0fu,0x6eu,0x07u},
        {0xc5u,0xf9u,0x6eu,0x07u},{0x64u,0x66u,0x0fu,0x6eu,0x07u},
        {0x65u,0x66u,0x0fu,0x7eu,0x07u},{0x0fu,0x6eu,0x07u}};
    for(pl_u32 i=0u;i<sizeof invalid/sizeof invalid[0];++i) {
        memset(page,0x90,sizeof page);memcpy(page,invalid[i],sizeof invalid[i]);
        if(i==0u || i==1u){if(check_fault_admission(&image,&options,6u))return -1;continue;}
        if(invalid[i][0]==0x64u||invalid[i][0]==0x65u){
            if(check_segment_admission(&image,&options,invalid[i][0]))return -1;
            continue;
        }
        if(i==4u){wasm_cut_report report;pl_u64 bytes=0u;
            if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)||report.memory_bytes!=4u)return -1;
            continue;}
        memset(module,0xa5,sizeof module);wasm_cut_report report;memset(&report,0xa5,sizeof report);
        wasm_cut_report old=report;pl_u64 emitted=77u;
        if(wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)!=WASM_COMPILER_ERROR_GRAMMAR
                || emitted!=77u || memcmp(&report,&old,sizeof report))return -1;
        for(pl_u32 j=0u;j<sizeof module;++j)if(module[j]!=0xa5u)return -1;
    }
    /* Typed descriptors must not admit a wider read, a second memory operand,
     * an invented alignment requirement or a different register binding. Bit
     * 32 alone selects another valid half, so it is not a malformed descriptor. */
    pl_u32 rejected=0u;
    for(pl_u32 form=108u;form<SCALAR_FORMS;form+=12u) {
        form_info info;memset(source,0x90,sizeof source);(void)encoding(form,&info);
        memcpy(page,source,sizeof page);pl_x86_instruction instruction;
        if(pl_x86_decode_profile(&image,map.address,&instruction)
                || !cut_vector_scalar_supported(&instruction))return -1;
        for(pl_u32 bit=0u;bit<64u;++bit)if(bit!=32u) {
            pl_x86_instruction changed=instruction;changed.machine_argument^=1ull<<bit;
            if(cut_vector_scalar_supported(&changed))return -1;
            ++rejected;
        }
        pl_x86_instruction changed=instruction;changed.operands[1].bits=128u;
        if(cut_vector_scalar_supported(&changed))return -1;
        ++rejected;changed=instruction;changed.flags|=PL_X86_INSTRUCTION_LOCKED;
        if(cut_vector_scalar_supported(&changed))return -1;
        ++rejected;
    }
    printf("selected-half typed descriptor refusals: %u\n",rejected);
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
    for(pl_u32 form=0u;form<SCALAR_FORMS;++form) {
        form_info info;
        memset(source,0x90,sizeof source);pl_u32 size=encoding(form,&info);
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,map.address};wasm_cut_options options={map.address,8u,sizeof module};
        wasm_cut_report report={0};pl_u64 emitted=0u;
        if(!observe_only) {
            int result=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if(result || report.source_bytes!=size || report.source_instructions!=1u
                    || report.memory_bytes!=(info.reg?0u:info.width/8u) || report.boundary!=WASM_CUT_SYSTEM
                    || report.written_registers!=(form<64u&&info.store?1u<<info.general:0u) || report.flags_written
                    || (report.memory_access&3u)!=(info.reg?0u:info.store?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ)) {
                fprintf(stderr,"scalar vector %u red: compiler=%d\n",form,result);goto finish;
            }
        }
        for(pl_u32 row=0u;row<64u;++row) {
            pl_u32 phase=row%16u;
            if(mprotect(code,4096u,PROT_READ|PROT_WRITE|PROT_EXEC) || mprotect(ram,8192u,PROT_READ|PROT_WRITE))goto finish;
            memcpy(code,source,sizeof source);code[size]=0xffu;code[size+1u]=0x25u;
            put(code+size+2u,0u,4u);put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture,8u);
            for(pl_u32 i=0u;i<8192u;++i)ram[i]=(pl_u8)(i*37u+row);
            observation *record=&records[row];memset(record,0,sizeof *record);
            machine_state *state=&record->before;
            for(pl_u32 i=0u;i<16u;++i)state->registers[i]=random_word(&seed);
            state->rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u64 operand=phase>=1u && phase<=3u?0x12341000ull-info.width/16u:phase==5u?0x8000000000000000ull
                :phase==6u?0x12343000u:phase>=8u?0x12340200u+(phase-8u):0x12340200u;
            if(info.half && phase>=8u)operand=0x12341000ull-(phase-7u);
            state->registers[4u]=0x12341c00u;
            if(info.kind==1u)state->registers[7u]=operand;
            else if(info.kind==2u)state->registers[4u]=operand-12u;
            else if(info.kind==3u)state->registers[12u]=operand-state->registers[1u]*4u-7u;
            else if(info.kind==4u)operand=0x400800u;
            else if(info.kind==5u)state->registers[5u]=operand+8u;
            else if(info.kind==6u)state->registers[7u]=operand+4095u;
            if(info.kind==1u)state->registers[7u]|=0xabcdef9800000000ull;
            if(info.reg)operand=0u;
            pl_u8 *target=operand>=0x12340000u && operand+16u<=0x12342000u?ram+(size_t)(operand-0x12340000u)
                :info.kind==4u?code+2048u:NULL;
            if(target) {put(target,random_word(&seed),8u);put(target+8u,random_word(&seed),8u);}
            record->address=operand;record->old_low=target?word(target,8u):0u;record->old_high=target?word(target+8u,8u):0u;
            pl_u8 saved[8192],saved_code[4096];memcpy(saved,ram,sizeof saved);memcpy(saved_code,code,sizeof saved_code);
            if(phase==2u && mprotect(ram+4096u,4096u,PROT_READ))goto finish;
            if(phase==3u && mprotect(ram+4096u,4096u,PROT_NONE))goto finish;
            if(phase==4u && mprotect(ram,8192u,PROT_READ))goto finish;
            if(info.kind==4u && phase==4u && mprotect(code,4096u,PROT_READ|PROT_EXEC))goto finish;
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
                record->after.registers[i]=actual;
                if((trapped || form>=64u || !info.store || i!=info.general) && actual!=state->registers[i]) {fprintf(stderr,"vector GPR %u/%u/%u\n",form,row,i);goto finish;}
            }
            if(trapped) {
                record->vector=vector;record->error=error;record->fault_address=vector==14u?fault_address:operand;++faults;
                if(memcmp(state->xmm,record->after.xmm,sizeof state->xmm))goto finish;
            } else {
                record->after.rflags=native_stack_result[16u];record->after.rip+=size;++record->after.retired;
                if(record->after.rflags!=state->rflags || (!target&&!info.reg))goto finish;
            }
            record->new_low=target?word(target,8u):0u;record->new_high=target?word(target+8u,8u):0u;
            if(!trapped && info.store && !info.reg) {
                pl_u8 *expected=info.kind==4u?saved_code+2048u:saved+(size_t)(operand-0x12340000u);
                put(expected,record->new_low,info.width/8u);
            }
            if(memcmp(saved,ram,sizeof saved) || memcmp(saved_code,code,sizeof saved_code)) {
                fprintf(stderr,"vector partial/unrelated RAM write %u/%u\n",form,row);goto finish;
            }
            if(!trapped) {
                pl_u64 input=form>=100u && form<108u?state->xmm[info.source*2u]:info.store?state->xmm[info.vector*2u+info.high]
                    :info.reg?state->registers[info.general]:record->old_low;
                if(info.width==32u)input&=0xffffffffu;
                if(info.store) {
                    if((info.reg?record->after.registers[info.general]:record->new_low&(info.width==32u?0xffffffffu:~0ull))!=input)goto finish;
                } else {
                    pl_u32 target_index=form>=100u && form<108u?info.target:info.vector;
                    if(record->after.xmm[target_index*2u+info.high]!=input
                            || record->after.xmm[target_index*2u+(1u-info.high)]
                                !=(info.half?state->xmm[target_index*2u+(1u-info.high)]:0u))goto finish;
                }
            }
            ++observations;
        }
        char json[384];int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"native\":64,\"stateBytes\":%zu,\"recordBytes\":%zu,\"kind\":%u,\"store\":%u,\"register\":%u,\"width\":%u,\"gpr\":%u,\"xmm\":%u,\"selectedHalf\":%u,\"high\":%u}\n",
            size,sizeof(machine_state),sizeof(observation),info.kind,info.store,info.reg,info.width,info.general,info.vector,info.half,info.high);
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
    if(!status)printf("scalar vector transfers: %u actual x86 CPU/RAM observations, %u fault frames%s; CR0/CR4 require separate models\n",
        observations,faults,observe_only?"; lowering not tested":"");
    return status;
}
