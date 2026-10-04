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

extern void native_stack_cut(const machine_state *, const void *);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
static pl_u8 page[4096], module[65536], alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 registers[16], flags, vector, error, fault_rip, fault_address;
static void exception(int number, siginfo_t *info, void *pointer)
{
    (void)number;
    __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context = pointer;
    static const int ranks[] = {REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (pl_u32 i = 0u; i < 16u; ++i) registers[i] = (pl_u64)context->uc_mcontext.gregs[ranks[i]];
    flags = (pl_u64)context->uc_mcontext.gregs[REG_EFL];
    vector = (pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    error = (pl_u64)context->uc_mcontext.gregs[REG_ERR];
    fault_rip = (pl_u64)context->uc_mcontext.gregs[REG_RIP];
    fault_address = (pl_u64)(uintptr_t)info->si_addr;
    trapped = 1; siglongjmp(recovery,1);
}
static void observe(const machine_state *state, const void *code)
{ trapped = 0; if (!sigsetjmp(recovery,1)) native_stack_cut(state,code); }
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static void put(pl_u8 *target, pl_u64 value, pl_u32 bytes)
{ for (pl_u32 i = 0u; i < bytes; ++i) target[i] = (pl_u8)(value >> (i * 8u)); }
static pl_u64 word(const pl_u8 *source)
{ pl_u64 value; memcpy(&value,source,sizeof value); return value; }
static int save(const char *directory, pl_u32 form, const char *suffix, const void *data, size_t bytes)
{
    if (!directory) return 0;
    char path[4096]; int n = snprintf(path,sizeof path,"%s/call-%u.%s",directory,form,suffix);
    if (n < 1 || (size_t)n >= sizeof path) return -1;
    FILE *file = fopen(path,"wbx"); if (!file) return -1;
    int status = fwrite(data,1u,bytes,file) == bytes ? 0 : -1;
    if (fclose(file)) status = -1;
    return status;
}
int main(int argc, char **argv)
{
    /* --observe produces independent hardware receipts even when lowering is
     * still red. The normal check also requires exact compiler admission. */
    int observe_only = argc == 3 && !strcmp(argv[2],"--observe");
    if (argc != 1 && argc != 2 && !observe_only) return 2;
    const char *directory = argc >= 2 ? argv[1] : NULL;
    stack_t old_stack, stack = {.ss_sp=alternate,.ss_size=sizeof alternate};
    struct sigaction old_segv, old_bus, action = {.sa_sigaction=exception,.sa_flags=SA_SIGINFO | SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if (sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_segv)
            || sigaction(SIGBUS,&action,&old_bus)) return 1;
    pl_u8 *code = mmap((void *)(uintptr_t)0x400000u,4096u,PROT_READ | PROT_WRITE | PROT_EXEC,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,-1,0);
    pl_u8 *ram = mmap((void *)(uintptr_t)0x12340000u,8192u,PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,-1,0);
    int status = 1; pl_u32 faults = 0u, observed = 0u;
    if (code == MAP_FAILED || ram == MAP_FAILED) goto finish;
    pl_u64 seed = 0xcabbedadd00dab1eull;
    for (pl_u32 form = 0u; form < 27u; ++form) {
        memset(page,0x90,sizeof page); pl_u32 at = 0u, mode = form - 16u;
        if (form < 16u) {
            if (form >= 8u) page[at++] = 0x41u;
            page[at++] = 0xffu; page[at++] = (pl_u8)(0xd0u | (form & 7u));
        } else {
            if (mode == 1u || mode == 3u || mode == 5u) page[at++] = 0x67u;
            if (mode == 7u) page[at++] = 0x43u;
            if (mode == 10u) page[at++] = 0x41u;
            page[at++] = 0xffu;
            if (mode < 2u) page[at++] = 0x10u;
            else if (mode < 4u) { page[at++] = 0x54u; page[at++] = 0x24u; page[at++] = 0x7fu; }
            else if (mode < 6u) { page[at++] = 0x94u; page[at++] = 0xcbu; put(page + at,(pl_u32)-4096,4u); at += 4u; }
            else if (mode == 6u) { page[at++] = 0x15u; put(page + at,0x800u - at - 4u,4u); at += 4u; }
            else if (mode == 7u) { page[at++] = 0x54u; page[at++] = 0xb5u; page[at++] = 0x7fu; }
            else if (mode == 9u) { page[at++] = 0x54u; page[at++] = 0x24u; page[at++] = 0xf8u; }
            else { page[at++] = 0x14u; page[at++] = 0x24u; }
        }
        pl_x86_map map = {page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image = {&map,1u,0u,0x400000u};
        wasm_cut_options options = {image.entry,1u,sizeof module};
        wasm_cut_report report; pl_u64 bytes = 0u;
        if (!observe_only) {
            int compiled = wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
            if (compiled || report.source_bytes != at || report.source_instructions != 1u
                    || report.boundary != WASM_CUT_CONTROL || report.written_registers != 16u
                    || !(report.read_registers & 16u) || report.flags_written || report.memory_bytes != 8u) {
                fprintf(stderr,"indirect CALL form %u red: compiler=%d\n",form,compiled); goto finish;
            }
        }
        pl_u64 records[256][44];
        for (pl_u32 row = 0u; row < 256u; ++row) {
            if (mprotect(ram + 4096u,4096u,PROT_READ | PROT_WRITE)) goto finish;
            memcpy(code,page,sizeof page); memset(ram,0x5a,8192u);
            /* The target trampoline changes no guest register/flag. CALL RSP
             * can push into the same writable executable page, without
             * relying on the host capture function's read-only text. */
            code[0xc00u]=0xffu; code[0xc01u]=0x25u; put(code + 0xc02u,0u,4u);
            put(code + 0xc06u,(pl_u64)(uintptr_t)native_stack_capture,8u);
            machine_state state = {0};
            for (pl_u32 i=0u;i<16u;++i) state.registers[i]=random_word(&seed);
            state.rflags=0x202u | (random_word(&seed) & 0xcd5u);
            pl_u32 phase=row % 16u;
            if (form == 4u && phase > 1u && phase < 7u) phase=0u;
            pl_u64 target=phase == 1u || phase == 3u ? 0x8000000000000000ull : 0x400c00u;
            pl_u64 rsp=0x12340000u + (row % 3u == 0u ? 4101u : row % 3u == 1u ? 4104u : 4088u);
            if (phase == 2u || phase == 3u) rsp=0x12343000u;
            pl_u64 operand=0u;
            if (form < 16u) state.registers[form]=target;
            else {
                operand=0x12340000u + (row % 3u == 0u ? 4093u : row % 3u == 1u ? 4096u : 4080u);
                if (mode < 2u) state.registers[0]=operand;
                else if (mode < 4u) { rsp=operand - 127u; }
                else if (mode < 6u) { state.registers[1]&=127u; state.registers[3]=operand + 4096u - state.registers[1] * 8u; }
                else if (mode == 6u) operand=0x400800u;
                else if (mode == 7u) { state.registers[14]&=127u; state.registers[13]=operand - 127u - state.registers[14] * 4u; }
                else if (mode < 10u) { rsp=0x12340000u + 4088u; operand=rsp - (mode == 9u ? 8u : 0u); }
                else state.registers[12]=operand;
                if (mode == 1u) state.registers[0]|=0x1234567800000000ull;
                if (mode == 3u) { /* 32-bit operand address, still 64-bit stack. */ rsp |= 0x1234567800000000ull; }
                if (mode == 5u) { state.registers[1]|=0x345600000000ull; state.registers[3]|=0x1234567800000000ull; }
                put(operand == 0x400800u ? code + 0x800u : ram + (operand - 0x12340000u),target,8u);
            }
            state.registers[4]=form == 4u ? target : rsp;
            pl_u64 stack_address=state.registers[4] - 8u;
            pl_u8 *stack_word=NULL;
            if (stack_address >= 0x12340000u && stack_address <= 0x12342000u - 8u) stack_word=ram + (stack_address - 0x12340000u);
            else if (stack_address >= 0x400000u && stack_address <= 0x401000u - 8u) stack_word=code + (stack_address - 0x400000u);
            pl_u64 before=stack_word ? word(stack_word) : 0u;
            /* Read/stack fault competition uses real protection, not a mocked
             * access callback. Register-target cases isolate the stack fault. */
            if (phase == 4u || phase == 5u || phase == 6u) {
                int protection=phase == 5u ? PROT_READ : PROT_NONE;
                if (mprotect(ram + 4096u,4096u,protection)) goto finish;
            }
            observe(&state,code);
            if (mprotect(ram + 4096u,4096u,PROT_READ | PROT_WRITE)) goto finish;
            if (trapped && (fault_rip != 0x400000u || (flags & ~0x10000ull) != state.rflags
                    || (vector != 12u && vector != 13u && vector != 14u))) {
                fprintf(stderr,"CALL unexpected hardware frame form=%u row=%u vector=%llu rip=%llx\n",form,row,
                    (unsigned long long)vector,(unsigned long long)fault_rip); goto finish;
            }
            for (pl_u32 reg=0u;reg<16u;++reg) {
                pl_u64 actual=trapped ? registers[reg] : native_stack_result[reg];
                pl_u64 wanted=reg == 4u && !trapped ? state.registers[reg] - 8u : state.registers[reg];
                if (actual != wanted) {
                    fprintf(stderr,"CALL register form=%u row=%u reg=%u wanted=%llx actual=%llx\n",
                        form,row,reg,(unsigned long long)wanted,(unsigned long long)actual);
                    goto finish;
                }
                records[row][reg]=state.registers[reg]; records[row][17u + reg]=actual;
            }
            pl_u64 after=stack_word ? word(stack_word) : 0u;
            /* Near CALL's return-address store precedes the target #GP.
             * Its payload effect survives that fault, unlike RSP/RIP. */
            int stored = !trapped || vector == 13u;
            if ((stored && (!stack_word || after != 0x400000u + at))
                    || (!stored && before != after) || (!trapped && native_stack_result[16] != state.rflags)) {
                fprintf(stderr,"CALL stack publication form=%u row=%u vector=%llu before=%llx after=%llx\n",form,row,
                    (unsigned long long)(trapped?vector:0u),(unsigned long long)before,(unsigned long long)after);
                fprintf(stderr,"CALL inputs phase=%u target=%llx operand=%llx stack=%llx rsp=%llx flags=%llx\n",
                    phase,(unsigned long long)target,(unsigned long long)operand,
                    (unsigned long long)stack_address,(unsigned long long)state.registers[4],
                    (unsigned long long)state.rflags);
                if (trapped) fprintf(stderr,"CALL frame error=%llx rip=%llx rsp=%llx flags=%llx si_addr=%llx\n",
                    (unsigned long long)error,(unsigned long long)fault_rip,(unsigned long long)registers[4],
                    (unsigned long long)flags,(unsigned long long)fault_address);
                fprintf(stderr,"CALL initial GPRs:");
                for (pl_u32 i=0u;i<16u;++i) fprintf(stderr," %llx",(unsigned long long)state.registers[i]);
                fputc('\n',stderr);
                fprintf(stderr,"CALL bytes:");
                for (pl_u32 i=0u;i<at;++i) fprintf(stderr," %02x",(unsigned)code[i]);
                fputc('\n',stderr); goto finish;
            }
            records[row][16]=state.rflags; records[row][33]=state.rflags;
            records[row][34]=trapped ? 0x400000u : target;
            records[row][35]=trapped ? vector : 0u; records[row][36]=trapped ? error : 0u;
            records[row][37]=operand; records[row][38]=target; records[row][39]=stack_address;
            records[row][40]=before; records[row][41]=after;
            records[row][42]=!trapped ? 0u : vector == 14u ? fault_address : vector == 12u ? stack_address : target;
            records[row][43]=phase;
            if (trapped) ++faults;
            ++observed;
        }
        char json[256]; int n=snprintf(json,sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"native\":256,\"words\":44}\n",form,at);
        if (n < 1 || (size_t)n >= sizeof json || save(directory,form,"json",json,(size_t)n)
                || save(directory,form,"source-page",page,sizeof page)
                || save(directory,form,"cases",records,sizeof records)
                || (!observe_only && save(directory,form,"wasm",module,(size_t)bytes))) goto finish;
    }
    status=0;
finish:
    if (code != MAP_FAILED && munmap(code,4096u)) status=1;
    if (ram != MAP_FAILED && munmap(ram,8192u)) status=1;
    if (sigaction(SIGSEGV,&old_segv,NULL) || sigaction(SIGBUS,&old_bus,NULL) || sigaltstack(&old_stack,NULL)) status=1;
    if (!status) printf("indirect CALL: %u actual x86 CPU/stack observations, %u exception frames%s\n",observed,faults,
        observe_only ? "; lowering not tested" : "");
    return status;
}
