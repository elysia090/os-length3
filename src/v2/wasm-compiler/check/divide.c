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
extern void native_cut(machine_state *, const void *);
static pl_u8 page[4096], module[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 registers[16], flags, vector, error, fault_rip;
static void exception(int number, siginfo_t *info, void *pointer)
{
    (void)number; (void)info; __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context=pointer;
    static const int ranks[]={REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (pl_u32 rank=0u;rank<16u;++rank) registers[rank]=(pl_u64)context->uc_mcontext.gregs[ranks[rank]];
    flags=(pl_u64)context->uc_mcontext.gregs[REG_EFL]; vector=(pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error=(pl_u64)context->uc_mcontext.gregs[REG_ERR]; fault_rip=(pl_u64)context->uc_mcontext.gregs[REG_RIP];
    trapped=1; siglongjmp(recovery,1);
}
static void observe(machine_state *state,const void *code)
{ trapped=0; if (!sigsetjmp(recovery,1)) native_cut(state,code); }
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static int save(const char *directory, pl_u32 form, const char *suffix, const void *data, size_t bytes)
{
    if (!directory) return 0;
    char path[4096]; int n=snprintf(path,sizeof path,"%s/divide-%u.%s",directory,form,suffix);
    if (n<1 || (size_t)n >= sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,bytes,file) == bytes ? 0 : -1;
    if (fclose(file)) status=-1;
    return status;
}
int main(int argc,char **argv)
{
    int observe_only=argc == 3 && !strcmp(argv[2],"--observe");
    if (argc != 1 && argc != 2 && !observe_only) return 2;
    const char *directory=argc >= 2 ? argv[1] : NULL;
    struct sigaction old,action={.sa_sigaction=exception,.sa_flags=SA_SIGINFO}; sigemptyset(&action.sa_mask);
    if (sigaction(SIGFPE,&action,&old)) return 1;
    pl_u8 *code=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    int status=1; pl_u32 observations=0u,faults=0u; pl_u64 seed=0xab98765432cd1234ull;
    if (code == MAP_FAILED) goto finish;
    for (pl_u32 form=0u;form<24u;++form) {
        pl_u32 width=8u << (form/8u), signed_divide=(form/4u)%2u, variant=form%4u;
        pl_u32 n=0u; memset(page,0x90,sizeof page);
        if (width == 16u) page[n++]=0x66u;
        if (!variant) page[n++]=0x41u;
        page[n++]=width == 8u ? 0xf6u : 0xf7u;
        page[n++]=(pl_u8)((signed_divide ? 0xf8u : 0xf0u)
            | (!variant ? 4u : variant == 1u ? 0u : variant == 2u ? 2u : width == 8u ? 4u : 1u));
        memcpy(code,page,sizeof page); code[n]=0xc3u;
        pl_u64 records[512][35];
        for (pl_u32 row=0u;row<512u;++row) {
            machine_state before={0},actual;
            for (pl_u32 rank=0u;rank<16u;++rank) before.registers[rank]=random_word(&seed);
            before.rflags=0x202u|(random_word(&seed)&0xcd5u);
            pl_u64 mask=(1ull << width)-1u,sign=1ull << (width-1u);
            const pl_u64 boundary[]={0u,1u,2u,sign-1u,sign,sign+1u,mask-1u,mask};
            if (row<256u) {
                pl_u32 divisor=!variant ? 12u : variant == 1u ? 0u : variant == 2u ? 2u : width == 8u ? 0u : 1u;
                pl_u32 shift=width == 8u && variant == 3u ? 8u : 0u;
                pl_u32 dividend_bits=width == 8u ? 16u : width;
                pl_u64 low_mask=(1ull << dividend_bits)-1u;
                before.registers[0]=(before.registers[0]&~low_mask)|boundary[(row >> 3u)%8u];
                before.registers[2]=(before.registers[2]&~mask)|boundary[(row >> 6u)%8u];
                before.registers[divisor]=(before.registers[divisor]&~(mask << shift))
                    | (boundary[row%8u] << shift);
            }
            /* Include exact two-word minimum / -1 and signed remainder cases. */
            if (!variant && row >= 256u && row<272u) {
                before.registers[0]=row%2u ? mask : 0u;
                before.registers[2]=row%4u < 2u ? sign : mask;
                if (width == 8u) before.registers[0]=row%2u ? 0xffffu : 0x8000u;
                before.registers[12]=row%8u < 4u ? mask : 2u;
            }
            actual=before; observe(&actual,code);
            before.registers[4]=actual.registers[4];
            if (trapped && (vector || error || fault_rip != (pl_u64)(uintptr_t)code
                    || (flags&~0x10000ull) != before.rflags)) goto finish;
            for (pl_u32 rank=0u;rank<16u;++rank) {
                pl_u64 value=trapped ? registers[rank] : actual.registers[rank];
                if (trapped && value != before.registers[rank]) goto finish;
                records[row][rank]=before.registers[rank]; records[row][17u+rank]=value;
            }
            if (!trapped && ((actual.rflags^before.rflags)&~0x8d5ull)) goto finish;
            records[row][16]=before.rflags;
            /* Undefined arithmetic flags are not compared as a hardware law. */
            records[row][33]=trapped ? before.rflags : actual.rflags;
            records[row][34]=(pl_u64)(unsigned)trapped;
            ++observations; if (trapped) ++faults;
        }
        pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image={&map,1u,0u,0x400000u};
        wasm_cut_options options={image.entry,1u,sizeof module}; wasm_cut_report report; pl_u64 bytes=0u;
        if (!observe_only) {
            int compiled=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if (compiled || report.source_bytes != n || report.source_instructions != 1u
                    || report.memory_bytes || report.flags_written || report.boundary != WASM_CUT_SYSTEM) {
                fprintf(stderr,"divide form %u red: compiler=%d\n",form,compiled); goto finish;
            }
            /* A prior pure write must retire before the possibly faulting
             * instruction. The divider is not fused into that earlier cut. */
            pl_u8 prefix[4096]; memset(prefix,0x90,sizeof prefix); prefix[0]=0x89u; prefix[1]=0xc0u;
            memcpy(prefix+2u,page,n); pl_x86_map prefixed=map; prefixed.bytes=prefix;
            pl_x86_image composed={&prefixed,1u,0u,image.entry}; wasm_cut_options two={image.entry,2u,sizeof module};
            wasm_cut_report prior; pl_u64 prior_bytes=0u; pl_u8 prior_module[4096];
            if (wasm_compiler_emit_code_cut(&composed,9u,&two,prior_module,sizeof prior_module,&prior_bytes,&prior)
                    || prior.source_instructions != 1u || prior.source_bytes != 2u
                    || prior.continuation != image.entry+2u || prior.boundary != WASM_CUT_SYSTEM) goto finish;
            static const pl_u8 refused[][4]={{0xf0,0xf7,0xf9,0},
                {0x48,0xf7,0xf9,0},{0xf7,0x39,0,0}};
            for (pl_u32 rank=0u;rank<3u;++rank) {
                memcpy(prefix,refused[rank],4u); pl_u64 unchanged=77u;
                wasm_cut_report saved; memset(&saved,0xa5,sizeof saved); memset(prior_module,0xa5,sizeof prior_module);
                if (wasm_compiler_emit_code_cut(&composed,9u,&options,prior_module,sizeof prior_module,&unchanged,&saved)
                        != WASM_COMPILER_ERROR_GRAMMAR || unchanged != 77u) goto finish;
                for (size_t byte=0u;byte<sizeof prior_module;++byte) if (prior_module[byte] != 0xa5u) goto finish;
                for (size_t byte=0u;byte<sizeof saved;++byte) if (((const pl_u8 *)&saved)[byte] != 0xa5u) goto finish;
            }
        }
        char json[256]; int length=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"instructions\":1,\"native\":512,\"words\":35}\n",form,n);
        if (length<1 || (size_t)length >= sizeof json || save(directory,form,"json",json,(size_t)length)
                || save(directory,form,"source-page",page,sizeof page) || save(directory,form,"cases",records,sizeof records)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)bytes))) goto finish;
    }
    status=0;
finish:
    if (code != MAP_FAILED && munmap(code,4096u)) status=1;
    if (sigaction(SIGFPE,&old,NULL)) status=1;
    if (!status) printf("Register division: %u actual x86 observations / %u #DE frames%s\n",observations,faults,
        observe_only ? "; lowering not tested" : "");
    return status;
}
