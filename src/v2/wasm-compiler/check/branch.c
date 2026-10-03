#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <signal.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <ucontext.h>

extern void native_stack_cut(const machine_state *state, const void *entry);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
static pl_u8 page[4096], module[65536], alternate[65536];
static sigjmp_buf recovery;
static volatile sig_atomic_t trapped;
static pl_u64 trap_number, trap_error, trap_flags, trap_registers[16], trap_rip;
static void exception(int signal, siginfo_t *info, void *pointer)
{
    (void)signal; (void)info;
    __asm__ volatile("cld" ::: "cc");
    const ucontext_t *context = pointer;
    static const int registers[] = {REG_RAX,REG_RCX,REG_RDX,REG_RBX,REG_RSP,REG_RBP,REG_RSI,REG_RDI,
        REG_R8,REG_R9,REG_R10,REG_R11,REG_R12,REG_R13,REG_R14,REG_R15};
    for (pl_u32 i = 0u; i < 16u; ++i) trap_registers[i] = (pl_u64)context->uc_mcontext.gregs[registers[i]];
    trap_number = (pl_u64)context->uc_mcontext.gregs[REG_TRAPNO];
    trap_error = (pl_u64)context->uc_mcontext.gregs[REG_ERR];
    trap_flags = (pl_u64)context->uc_mcontext.gregs[REG_EFL];
    trap_rip = (pl_u64)context->uc_mcontext.gregs[REG_RIP];
    trapped = 1; siglongjmp(recovery,1);
}
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
/* Keep the returns-twice boundary out of the generator's automatic state. */
static void observe(const machine_state *state, const void *code)
{
    trapped = 0;
    if (!sigsetjmp(recovery,1)) native_stack_cut(state,code);
}
static int write_record(const char *directory, pl_u32 form, const char *suffix, const void *data, size_t bytes)
{
    char path[4096];
    int n = snprintf(path,sizeof path,"%s/branch-%u.%s",directory,form,suffix);
    if (n < 1 || (size_t)n >= sizeof path) return -1;
    FILE *file = fopen(path,"wbx"); if (!file) return -1;
    int status = fwrite(data,1u,bytes,file) == bytes ? 0 : -1;
    if (fclose(file)) status = -1;
    return status;
}
static void put(pl_u8 *target, pl_u64 value, pl_u32 bytes)
{ for (pl_u32 i = 0u; i < bytes; ++i) target[i] = (pl_u8)(value >> (i * 8u)); }
static int prefix(const char *directory, pl_u8 *code)
{
    /* A potentially faulting successor is not part of the pure prefix.
     * In particular its CONTROL classification cannot suppress fallthrough. */
    const pl_u8 source[] = {0x48u,0x8du,0x80u,0x31u,0u,0u,0u,0xffu,0xe0u};
    memset(page,0x90,sizeof page); memcpy(page,source,sizeof source); memcpy(code,page,sizeof page);
    machine_state state = {0}; state.rflags = 0x202u;
    state.registers[0] = (pl_u64)(uintptr_t)native_stack_capture - 49u;
    observe(&state,code);
    if (trapped || native_stack_result[0] != (pl_u64)(uintptr_t)native_stack_capture
            || native_stack_result[16] != state.rflags) return -1;
    pl_x86_map map = {page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image = {&map,1u,0u,0x400000u};
    wasm_cut_options options = {image.entry,1024u,sizeof module};
    wasm_cut_report report; pl_u64 bytes;
    if (wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report)
            || report.source_instructions != 1u || report.source_bytes != 7u
            || report.boundary == WASM_CUT_CONTROL || report.continuation != image.entry + 7u) {
        fputs("pure prefix before indirect JMP red: successor must not suppress fallthrough\n",stderr); return -1;
    }
    if (directory) {
        /* Form 24 is a prefix witness, not a 25th indirect instruction form. */
        const char json[] = "{\"entry\":\"4194304\",\"form\":24,\"instructions\":1024,\"sourceBytes\":7,\"memory\":false}\n";
        if (write_record(directory,24u,"json",json,sizeof json - 1u)
                || write_record(directory,24u,"source-page",page,sizeof page)
                || write_record(directory,24u,"wasm",module,(size_t)bytes)) return -1;
    }
    return 0;
}
int main(int argc, char **argv)
{
    if (argc != 1 && argc != 2) return 2;
    stack_t old_stack, stack = {.ss_sp = alternate,.ss_size = sizeof alternate};
    struct sigaction old_action, action = {.sa_sigaction = exception,.sa_flags = SA_SIGINFO | SA_ONSTACK};
    sigemptyset(&action.sa_mask);
    if (sigaltstack(&stack,&old_stack) || sigaction(SIGSEGV,&action,&old_action)) return 1;
    pl_u8 *code = mmap(NULL,4096u,PROT_READ | PROT_WRITE | PROT_EXEC,MAP_PRIVATE | MAP_ANONYMOUS,-1,0);
    pl_u8 *ram = mmap((void *)(uintptr_t)0x12340000u,8192u,PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE,-1,0);
    int status = 1;
    if (code == MAP_FAILED || ram == MAP_FAILED) goto finish;
    if (prefix(argc == 2 ? argv[1] : NULL,code)) goto finish;
    pl_u64 seed = 0xbaddeadbaebeedafull;
    for (pl_u32 form = 0u; form < 24u; ++form) {
        memset(page,0x90,sizeof page); pl_u32 at = 0u, mode = form - 16u;
        if (form < 16u) {
            if (form >= 8u) page[at++] = 0x41u;
            page[at++] = 0xffu; page[at++] = (pl_u8)(0xe0u | (form & 7u));
        } else {
            if (mode == 1u || mode == 3u || mode == 5u) page[at++] = 0x67u;
            if (mode == 7u) page[at++] = 0x43u;
            page[at++] = 0xffu;
            if (mode < 2u) page[at++] = 0x20u;
            else if (mode < 4u) { page[at++] = 0x64u; page[at++] = 0x24u; page[at++] = 0x7fu; }
            else if (mode < 6u) {
                page[at++] = 0xa4u; page[at++] = 0xcbu; put(page + at,(pl_u32)-4096,4u); at += 4u;
            } else if (mode == 6u) { page[at++] = 0x25u; put(page + at,0x800u - at - 4u,4u); at += 4u; }
            else { page[at++] = 0x64u; page[at++] = 0xb5u; page[at++] = 0x7fu; }
        }
        pl_x86_map map = {page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image image = {&map,1u,0u,0x400000u};
        wasm_cut_options options = {image.entry,1u,sizeof module};
        wasm_cut_report report; pl_u64 bytes;
        int compiled = wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        if (compiled || report.source_instructions != 1u || report.source_bytes != at
                || report.boundary != WASM_CUT_CONTROL || report.written_registers || report.flags_written
                || report.memory_bytes != (form < 16u ? 0u : 8u)) {
            fprintf(stderr,"indirect branch form %u red: compiler=%d\n",form,compiled); goto finish;
        }
        memcpy(code,page,4096u);
        pl_u64 records[256][38];
        for (pl_u32 row = 0u; row < 256u; ++row) {
            machine_state state = {0};
            for (pl_u32 i = 0u; i < 16u; ++i) state.registers[i] = random_word(&seed);
            state.rflags = 0x202u | (random_word(&seed) & 0xcd5u);
            pl_u64 target = row % 8u == 1u ? 0x8000000000000000ull : (pl_u64)(uintptr_t)native_stack_capture;
            pl_u64 operand = 0u;
            if (form < 16u) state.registers[form] = target;
            else {
                pl_u32 offset = row % 3u == 0u ? 4093u : row % 3u == 1u ? 4096u : 4080u;
                operand = (pl_u64)(uintptr_t)(ram + offset); put(ram + offset,target,8u);
                if (mode < 2u) state.registers[0] = operand;
                else if (mode < 4u) state.registers[4] = operand - 127u;
                else if (mode < 6u) {
                    state.registers[1] &= 127u; state.registers[3] = operand + 4096u - state.registers[1] * 8u;
                } else if (mode == 6u) { put(code + 0x800u,target,8u); operand = 0x400800u; }
                else { state.registers[14] &= 127u; state.registers[13] = operand - 127u - state.registers[14] * 4u; }
                if (mode == 1u) state.registers[0] |= 0x1234567800000000ull;
                if (mode == 3u) state.registers[4] |= 0x1234567800000000ull;
                if (mode == 5u) { state.registers[1] |= 0x345600000000ull; state.registers[3] |= 0x1234567800000000ull; }
            }
            observe(&state,code);
            int fault = row % 8u == 1u;
            if ((int)trapped != fault) { fprintf(stderr,"branch hardware fault expectation %u/%u\n",form,row); goto finish; }
            if (fault && (trap_number != 13u || trap_error || trap_rip != (pl_u64)(uintptr_t)code
                    || (trap_flags & ~0x10000ull) != state.rflags)) goto finish;
            for (pl_u32 reg = 0u; reg < 16u; ++reg) {
                pl_u64 actual = fault ? trap_registers[reg] : native_stack_result[reg];
                if (actual != state.registers[reg]) goto finish;
                records[row][reg] = state.registers[reg]; records[row][17u + reg] = actual;
            }
            if (!fault && native_stack_result[16] != state.rflags) goto finish;
            records[row][16] = state.rflags; records[row][33] = state.rflags;
            records[row][34] = fault ? image.entry : target;
            records[row][35] = fault ? trap_number : 0u; records[row][36] = fault ? trap_error : 0u;
            records[row][37] = operand;
        }
        if (argc == 2) {
            char json[256]; int n = snprintf(json,sizeof json,
                "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"memory\":%s,\"native\":256,\"faults\":32}\n",
                form,at,form < 16u ? "false" : "true");
            if (n < 1 || (size_t)n >= sizeof json || write_record(argv[1],form,"json",json,(size_t)n)
                    || write_record(argv[1],form,"source-page",page,sizeof page)
                    || write_record(argv[1],form,"wasm",module,(size_t)bytes)
                    || write_record(argv[1],form,"cases",records,sizeof records)) goto finish;
        }
    }
    status = 0;
finish:
    if (code != MAP_FAILED && munmap(code,4096u)) status = 1;
    if (ram != MAP_FAILED && munmap(ram,8192u)) status = 1;
    if (sigaction(SIGSEGV,&old_action,NULL) || sigaltstack(&old_stack,NULL)) status = 1;
    if (!status) puts("indirect branch: 6144 native x86 CPU comparisons (768 actual #GP frames; pending ABI excludes exception-frame RF)");
    return status;
}
