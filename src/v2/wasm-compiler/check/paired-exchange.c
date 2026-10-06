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
static pl_u8 source[4096],module[65536],alternate[65536],elf_bytes[131072];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 registers[16],flags,vector,error,fault_rip,fault_address;
static void exception(int number,siginfo_t *info,void *pointer)
{
    (void)number; __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (pl_u32 i=0u;i<16u;++i) registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL]; vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR]; fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address=(pl_u64)(uintptr_t)info->si_addr; trapped=1; siglongjmp(recovery,1);
}
static void observe(const machine_state *state,const void *code)
{ trapped=0; if (!sigsetjmp(recovery,1)) native_stack_cut(state,code); }
static pl_u64 random_word(pl_u64 *seed)
{ *seed^=*seed<<13u; *seed^=*seed>>7u; *seed^=*seed<<17u; return *seed; }
static void put(pl_u8 *target,pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) target[i]=(pl_u8)(value>>(8u*i)); }
static pl_u64 get(const pl_u8 *target)
{ pl_u64 value=0u; for (pl_u32 i=0u;i<8u;++i) value|=(pl_u64)target[i]<<(8u*i); return value; }
static int save(const char *directory,pl_u32 form,const char *suffix,const void *data,size_t bytes)
{
    if (!directory) return 0;
    char path[4096]; int n=snprintf(path,sizeof path,"%s/paired-exchange-%u.%s",directory,form,suffix);
    if (n<1 || (size_t)n>=sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,bytes,file)==bytes ? 0 : -1; if (fclose(file)) status=-1; return status;
}
static pl_u32 encoding(pl_u32 form)
{
    pl_u32 at=0u,wide=form&1u,kind=form/8u;
    if (form&2u) source[at++]=0xf0u;
    if (form&4u) source[at++]=0x67u;
    if (wide || kind==2u) source[at++]=(pl_u8)(0x40u|(wide ? 8u : 0u)|(kind==2u ? 1u : 0u));
    source[at++]=0x0fu; source[at++]=0xc7u;
    if (!kind) source[at++]=0x0fu;
    else if (kind==1u) { source[at++]=0x4cu; source[at++]=0x24u; source[at++]=16u; }
    else if (kind==2u) { source[at++]=0x4du; source[at++]=32u; }
    else if (kind<7u) { static const pl_u8 bases[]={0u,2u,1u,3u}; source[at++]=(pl_u8)(8u|bases[kind-3u]); }
    else if (kind==7u) { source[at++]=0x4cu; source[at++]=0x77u; source[at++]=16u; }
    else { source[at++]=0x0du; pl_u32 displacement=0x1020u-(at+4u);
        for (pl_u32 i=0u;i<4u;++i) source[at++]=(pl_u8)(displacement>>(8u*i)); }
    return at;
}
static int check_frontier(const pl_x86_map *map,pl_u32 size)
{
    pl_u8 prefix[4096],emitted[4096],saved[4096];
    memset(prefix,0x90,sizeof prefix); prefix[0]=0x89u; prefix[1]=0xc0u;
    memcpy(prefix+2u,map->bytes,size); memcpy(saved,prefix,sizeof saved);
    pl_x86_map prefixed=*map; prefixed.bytes=prefix;
    pl_x86_image image={&prefixed,1u,0u,map->address};
    wasm_cut_options options={image.entry,2u,sizeof emitted}; wasm_cut_report report; pl_u64 bytes;
    if (wasm_compiler_emit_code_cut(&image,9u,&options,emitted,sizeof emitted,&bytes,&report)
            || report.source_bytes!=2u || report.source_instructions!=1u
            || report.continuation!=image.entry+2u || report.boundary!=WASM_CUT_MEMORY) return -1;
    options.entry+=2u; options.maximum_source_instructions=1u;
    if (wasm_compiler_emit_code_cut(&image,9u,&options,emitted,sizeof emitted,&bytes,&report)
            || report.source_bytes!=size || report.boundary!=WASM_CUT_MEMORY || memcmp(prefix,saved,sizeof saved)) return -1;
    static const pl_u8 refused[][5]={{0x64,0x48,0x0f,0xc7,0x0f},{0x65,0x48,0x0f,0xc7,0x0f},
        {0x48,0x0f,0xc7,0xcf,0x90},{0xf0,0x0f,0xc7,0xcf,0x90}};
    for (pl_u32 rank=0u;rank<5u;++rank) {
        if (rank<4u) memcpy(prefix,refused[rank],5u); else memcpy(prefix,map->bytes,size);
        memcpy(saved,prefix,sizeof saved); options.entry=image.entry;
        memset(emitted,0xa5,sizeof emitted); memset(&report,0xa5,sizeof report); bytes=77u;
        if(rank==2u || rank==3u){if(check_fault_admission(&image,&options,6u) || memcmp(prefix,saved,sizeof saved))return -1;continue;}
        if(rank<2u){
            if(check_segment_admission(&image,&options,prefix[0])||memcmp(prefix,saved,sizeof saved))return -1;
            continue;
        }
        if (wasm_compiler_emit_code_cut(&image,9u,&options,emitted,rank<4u ? sizeof emitted : 1u,&bytes,&report)
                !=(rank<4u ? WASM_COMPILER_ERROR_GRAMMAR : WASM_COMPILER_ERROR_CAPACITY)
                || bytes!=77u || memcmp(prefix,saved,sizeof saved)) return -1;
        for (size_t i=0u;i<sizeof emitted;++i) if (emitted[i]!=0xa5u) return -1;
        for (size_t i=0u;i<sizeof report;++i) if (((const pl_u8 *)&report)[i]!=0xa5u) return -1;
    }
    return 0;
}
int main(int argc,char **argv)
{
    int observe_only=argc==3 && !strcmp(argv[2],"--observe");
    const char *elf_directory=argc==4 && !strcmp(argv[2],"--elf") ? argv[3] : NULL;
    if (argc!=1 && argc!=2 && !observe_only && !elf_directory) return 2;
    const char *directory=argc>=2 ? argv[1] : NULL;
    stack_t old_stack,stack={.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if (sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_segv)) return 1;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,8192u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    const pl_u64 addresses[]={0x23456000u,0x200023456000ull};
    pl_u8 *ram[2]={MAP_FAILED,MAP_FAILED}; int status=1;
    pl_u32 comparisons=0u,alignment_faults=0u,page_faults=0u; pl_u64 seed=0x94197cdefdd8461ull;
    if (code==MAP_FAILED) goto finish;
    for (pl_u32 i=0u;i<2u;++i) {
        ram[i]=mmap((void *)(uintptr_t)addresses[i],8192u,PROT_READ|PROT_WRITE,
            MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
        if (ram[i]==MAP_FAILED) goto finish;
    }
    for (pl_u32 form=0u;form<72u;++form) {
        memset(source,0x90,sizeof source); pl_u32 size=encoding(form),wide=form&1u,kind=form/8u;
        pl_u32 bytes=wide ? 16u : 8u; memcpy(code,source,sizeof source); memset(code+4096,0xa5,4096u);
        code[size]=0xffu; code[size+1u]=0x25u; memset(code+size+2u,0,4u);
        put(code+size+6u,(pl_u64)(uintptr_t)native_stack_capture);
        pl_u64 records[256][45],faults[256][45];
        for (pl_u32 row=0u;row<256u;++row) {
            machine_state before={0};
            for (pl_u32 rank=0u;rank<16u;++rank) before.registers[rank]=random_word(&seed);
            before.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u32 offset=row%4u==0u ? 0u : row%4u==1u ? 4080u : row%4u==2u ? 1u : 4093u;
            pl_u32 owner=form&4u ? 0u : 1u;
            pl_u64 address=kind==8u ? 0x401020u : addresses[owner]+offset;
            before.registers[4]=addresses[owner]+2048u;
            if (!kind) before.registers[7]=address;
            else if (kind==1u) before.registers[4]=address-16u;
            else if (kind==2u) before.registers[13]=address-32u;
            else if (kind<7u) { const pl_u32 bases[]={0u,2u,1u,3u}; before.registers[bases[kind-3u]]=address; }
            else if (kind==7u) { before.registers[6]=row&15u; before.registers[7]=address-16u-before.registers[6]*2u; }
            if ((form&4u) && kind!=8u) {
                const pl_u32 base[]={7u,4u,13u,0u,2u,1u,3u,7u};
                before.registers[base[kind]]|=0x200000000000ull;
            }
            pl_u64 low=random_word(&seed),high=random_word(&seed);
            if (row&8u) { low=wide ? before.registers[0] : (pl_u32)before.registers[0]
                | ((pl_u64)(pl_u32)before.registers[2]<<32u); high=before.registers[2]; }
            put((pl_u8 *)(uintptr_t)address,low); if (wide) put((pl_u8 *)(uintptr_t)address+8u,high);
            observe(&before,code);
            int misaligned=wide && (address&15u);
            if (trapped && (!misaligned || vector!=13u || error || fault_rip!=0x400000u
                    || (flags&~0x10000ull)!=before.rflags)) goto finish;
            if (!trapped && ((native_stack_result[16]^before.rflags)&~0x40ull)) goto finish;
            if (!!trapped!=!!misaligned) goto finish;
            for (pl_u32 rank=0u;rank<16u;++rank) {
                pl_u64 actual=trapped ? registers[rank] : native_stack_result[rank];
                if ((trapped || (rank!=0u && rank!=2u)) && actual!=before.registers[rank]) goto finish;
                records[row][rank]=before.registers[rank]; records[row][17u+rank]=actual;
            }
            records[row][16]=before.rflags; records[row][33]=trapped ? flags : native_stack_result[16];
            records[row][34]=trapped ? fault_rip : 0x400000u+size;
            records[row][35]=address; records[row][36]=low; records[row][37]=wide ? high : 0u;
            records[row][38]=get((const pl_u8 *)(uintptr_t)address);
            records[row][39]=wide ? get((const pl_u8 *)(uintptr_t)address+8u) : 0u;
            records[row][40]=trapped ? vector : 0u; records[row][41]=trapped ? error : 0u;
            records[row][42]=trapped ? fault_address : 0u; records[row][43]=0u; records[row][44]=0u;
            ++comparisons; if (trapped) ++alignment_faults;
            put((pl_u8 *)(uintptr_t)address,low); if (wide) put((pl_u8 *)(uintptr_t)address+8u,high);
            pl_u8 *protected_page=(pl_u8 *)(uintptr_t)((address+bytes-1u)&~4095ull);
            if (mprotect(protected_page,4096u,row&16u ? PROT_READ : PROT_NONE)) goto finish;
            observe(&before,code);
            if (mprotect(protected_page,4096u,PROT_READ|PROT_WRITE|(kind==8u ? PROT_EXEC : 0))) goto finish;
            if (!trapped || vector!=(misaligned ? 13u : 14u) || (misaligned && error)
                    || fault_rip!=0x400000u || (flags&~0x10000ull)!=before.rflags) goto finish;
            memcpy(faults[row],records[row],sizeof records[row]);
            for (pl_u32 rank=0u;rank<16u;++rank) {
                if (registers[rank]!=before.registers[rank]) goto finish;
                faults[row][17u+rank]=registers[rank];
            }
            faults[row][33]=flags; faults[row][34]=fault_rip; faults[row][38]=low;
            faults[row][39]=wide ? high : 0u; faults[row][40]=vector; faults[row][41]=error;
            faults[row][42]=fault_address; faults[row][43]=(pl_u64)(uintptr_t)protected_page;
            faults[row][44]=row&16u ? 1u : 0u;
            if (get((const pl_u8 *)(uintptr_t)address)!=low
                    || (wide && get((const pl_u8 *)(uintptr_t)address+8u)!=high)) goto finish;
            if (vector==14u) ++page_faults;
        }
        pl_x86_map map={source,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u}; wasm_cut_options options={image.entry,1u,sizeof module};
        wasm_cut_report report={0}; pl_u64 emitted=0u;
        if (!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report);
            if (compiled || report.source_bytes!=size || report.source_instructions!=1u
                    || report.boundary!=WASM_CUT_MEMORY || report.flags_written!=0x40u
                    || report.memory_bytes!=bytes || (report.memory_access&3u)!=3u || report.written_registers!=5u
                    || check_frontier(&map,size)) {
                fprintf(stderr,"paired exchange form %u red: compiler=%d\n",form,compiled); goto finish;
            }
            if (elf_directory) {
                char path[4096]; int n=snprintf(path,sizeof path,"%s/paired-exchange-%u.optimized.elf",elf_directory,form);
                if (n<1 || (size_t)n>=sizeof path) goto finish;
                FILE *file=fopen(path,"rb"); if (!file) goto finish;
                size_t length=fread(elf_bytes,1u,sizeof elf_bytes,file);
                int failed=ferror(file) || !feof(file); if (fclose(file)) failed=1;
                wasm_compiler compiler; pl_u8 elf_module[65536]; pl_u64 elf_emitted=0u; wasm_cut_report elf_report;
                if (failed || wasm_compiler_open(&compiler,elf_bytes,length)
                        || wasm_compiler_emit_cut(&compiler,&options,elf_module,sizeof elf_module,&elf_emitted,&elf_report)
                        || elf_emitted!=emitted || memcmp(elf_module,module,(size_t)emitted)
                        || elf_report.source_bytes!=size || elf_report.memory_bytes!=bytes) {
                    fprintf(stderr,"optimized ELF pair form %u red\n",form); goto finish;
                }
            }
        }
        char json[256]; int length=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"instructions\":1,\"bytes\":%u,\"kind\":%u,\"access\":%u,\"native\":256,\"words\":45}\n",
            form,size,bytes,kind,report.memory_access);
        if (length<1 || (size_t)length>=sizeof json || save(directory,form,"json",json,(size_t)length)
                || save(directory,form,"source-page",source,sizeof source) || save(directory,form,"cases",records,sizeof records)
                || save(directory,form,"faults",faults,sizeof faults)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)emitted))) goto finish;
    }
    status=0;
finish:
    if (code!=MAP_FAILED && munmap(code,8192u)) status=1;
    for (pl_u32 i=0u;i<2u;++i) if (ram[i]!=MAP_FAILED && munmap(ram[i],8192u)) status=1;
    if (sigaction(SIGSEGV,&old_segv,NULL) || sigaltstack(&old_stack,NULL)) status=1;
    if (!status) printf("paired-exchange native: %u comparisons, %u alignment faults, %u page faults\n",
        comparisons,alignment_faults,page_faults);
    return status;
}
