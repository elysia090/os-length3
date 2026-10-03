#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
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
static pl_u8 page[4096], module[65536], alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 registers[16], flags, vector, error, fault_rip, fault_address;
static void exception(int number, siginfo_t *info, void *pointer)
{
    (void)number; __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context = pointer;
    static const int ranks[] = {REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (pl_u32 i=0u;i<16u;++i) registers[i]=(pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL]; vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR]; fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address=(pl_u64)(uintptr_t)info->si_addr; trapped=1; siglongjmp(recovery,1);
}
static void observe(const machine_state *state, const void *code)
{ trapped=0; if (!sigsetjmp(recovery,1)) native_stack_cut(state,code); }
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static void put(pl_u8 *target, pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) target[i]=(pl_u8)(value >> (i*8u)); }
static int save(const char *directory, pl_u32 form, const char *suffix, const void *data, size_t bytes)
{
    if (!directory) return 0;
    char path[4096]; int n=snprintf(path,sizeof path,"%s/leave-%u.%s",directory,form,suffix);
    if (n < 1 || (size_t)n >= sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,bytes,file) == bytes ? 0 : -1; if (fclose(file)) status=-1; return status;
}
int main(int argc, char **argv)
{
    int observe_only=argc == 3 && !strcmp(argv[2],"--observe");
    if (argc != 1 && argc != 2 && !observe_only) return 2;
    const char *directory=argc >= 2 ? argv[1] : NULL;
    stack_t old_stack, stack={.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv,old_bus,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO|SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if (sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_segv) || sigaction(SIGBUS,&action,&old_bus)) return 1;
    pl_u8 *code=mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram=mmap((void *)(uintptr_t)0x12340000u,8192u,PROT_READ|PROT_WRITE,
        MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);
    int status=1; pl_u32 faults=0u, observed=0u;
    if (code == MAP_FAILED || ram == MAP_FAILED) goto finish;
    pl_u64 seed=0xcabbedadd00dab1eull;
    static const pl_u8 encodings[][3]={{0xc9,0,0},{0x48,0xc9,0},{0x67,0xc9,0},
        {0x66,0xc9,0},{0x67,0x66,0xc9},{0x64,0x48,0xc9}};
    static const pl_u32 sizes[]={1u,2u,2u,2u,3u,3u};
    for (pl_u32 form=0u;form<6u;++form) {
        memset(page,0x90,sizeof page); memcpy(page,encodings[form],sizes[form]);
        pl_u32 width=form == 3u || form == 4u ? 16u : 64u;
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u}; wasm_cut_options options={image.entry,1u,sizeof module};
        wasm_cut_report report; pl_u64 bytes=0u;
        if (!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if (compiled || report.source_bytes != sizes[form] || report.source_instructions != 1u
                    || report.boundary != WASM_CUT_MEMORY || report.written_registers != 48u
                    || report.read_registers != 32u || report.flags_written || report.memory_bytes != width/8u) {
                fprintf(stderr,"LEAVE form %u red: compiler=%d\n",form,compiled); goto finish;
            }
        }
        pl_u64 records[256][38];
        for (pl_u32 row=0u;row<256u;++row) {
            if (mprotect(ram+4096u,4096u,PROT_READ|PROT_WRITE)) goto finish;
            memcpy(code,page,sizeof page); memset(ram,0x5a,8192u);
            code[sizes[form]]=0xffu; code[sizes[form]+1u]=0x25u; put(code+sizes[form]+2u,0u);
            put(code+sizes[form]+6u,(pl_u64)(uintptr_t)native_stack_capture);
            machine_state state={0};
            for (pl_u32 i=0u;i<16u;++i) state.registers[i]=random_word(&seed);
            state.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u32 phase=row%8u,offset=row%3u == 0u ? 4095u : row%3u == 1u ? 4093u : 4088u;
            state.registers[4]=phase == 4u ? 0x8000000000000000ull : 0x12340123u;
            state.registers[5]=phase == 1u ? 0x8000000000000000ull : phase == 2u ? 0x12343000u
                : 0x12340000u+offset;
            if (phase == 3u && mprotect(ram+4096u,4096u,PROT_NONE)) goto finish;
            observe(&state,code);
            if (mprotect(ram+4096u,4096u,PROT_READ|PROT_WRITE)) goto finish;
            if (trapped && (fault_rip != 0x400000u || (flags & ~0x10000ull) != state.rflags
                    || (vector != 12u && vector != 13u && vector != 14u))) goto finish;
            for (pl_u32 reg=0u;reg<16u;++reg) {
                pl_u64 actual=trapped ? registers[reg] : native_stack_result[reg], wanted=state.registers[reg];
                if (!trapped && reg == 4u) wanted=state.registers[5]+width/8u;
                if (!trapped && reg == 5u) wanted=width == 64u ? 0x5a5a5a5a5a5a5a5aull
                    : (state.registers[5]&~0xffffull)|0x5a5au;
                if (actual != wanted) { fprintf(stderr,"LEAVE CPU form=%u row=%u reg=%u\n",form,row,reg); goto finish; }
                records[row][reg]=state.registers[reg]; records[row][17u+reg]=actual;
            }
            if (!trapped && native_stack_result[16] != state.rflags) goto finish;
            records[row][16]=state.rflags; records[row][33]=state.rflags;
            records[row][34]=trapped ? image.entry : image.entry+sizes[form];
            records[row][35]=trapped ? vector : 0u; records[row][36]=trapped ? error : 0u;
            records[row][37]=!trapped ? 0u : vector == 14u ? fault_address : state.registers[5];
            if (trapped) ++faults;
            ++observed;
        }
        char json[256]; int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"bytes\":%u,\"sourceBytes\":%u,\"native\":256,\"words\":38}\n",
            form,width/8u,sizes[form]);
        if (n < 1 || (size_t)n >= sizeof json || save(directory,form,"json",json,(size_t)n)
                || save(directory,form,"source-page",page,sizeof page) || save(directory,form,"cases",records,sizeof records)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)bytes))) goto finish;
    }
    status=0;
finish:
    if (code != MAP_FAILED && munmap(code,4096u)) status=1;
    if (ram != MAP_FAILED && munmap(ram,8192u)) status=1;
    if (sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGBUS,&old_bus,NULL) || sigaltstack(&old_stack,NULL)) status=1;
    if (!status) printf("LEAVE: %u actual x86 CPU observations, %u exception frames%s\n",observed,faults,
        observe_only ? "; lowering not tested" : "");
    return status;
}
