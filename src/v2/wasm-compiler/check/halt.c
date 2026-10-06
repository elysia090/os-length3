#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include "fault-admission.h"
#include <signal.h>
#include <setjmp.h>
#include <sys/mman.h>
#include <ucontext.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

static pl_u8 page[4096], module[65536], arena_bytes[32768];
static sigjmp_buf fault;
static volatile sig_atomic_t vector;
static volatile pl_u64 fault_rip;
static void capture(int signal_number, siginfo_t *info, void *context)
{
    (void)signal_number; (void)info;
    ucontext_t *cpu = context;
    vector = (sig_atomic_t)cpu->uc_mcontext.gregs[REG_TRAPNO];
    fault_rip = (pl_u64)cpu->uc_mcontext.gregs[REG_RIP];
    siglongjmp(fault,1);
}
static int native_fault(void)
{
    /* User-mode execution is an independent native #GP oracle, not evidence
     * of privileged HLT/IRQ wake or Linux boot. */
    struct sigaction action = {0}, previous;
    action.sa_sigaction = capture; action.sa_flags = SA_SIGINFO;
    sigemptyset(&action.sa_mask);
    if (sigaction(SIGSEGV,&action,&previous)) return 8;
    pl_u8 *native = mmap(0,4096,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if (native == MAP_FAILED) { sigaction(SIGSEGV,&previous,0); return 9; }
    native[0] = 0xf4; native[1] = 0xc3;
    int valid = 0;
    if (!mprotect(native,4096,PROT_READ|PROT_EXEC)) {
        if (!sigsetjmp(fault,1)) { void (*entry)(void); memcpy(&entry,&native,sizeof entry); entry(); }
        else valid = vector == 13 && fault_rip == (pl_u64)(uintptr_t)native;
    }
    if (munmap(native,4096) || sigaction(SIGSEGV,&previous,0) || !valid) return 12;
    return 0;
}
int main(void)
{
    pl_x86_map map = {page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image = {&map,1u,0u,map.address};
    wasm_cut_options options = {map.address,8u,sizeof module};
    wasm_cut_report report;
    pl_u64 emitted = 0u;
    const pl_u8 forms[][3] = {{0xf4},{0x66,0xf4},{0x48,0xf4},{0x67,0xf4},{0x2e,0xf4}};
    const pl_u32 sizes[] = {1u,2u,2u,2u,2u};
    pl_u32 refusals = 0u;
    for (pl_u32 form = 0u; form < sizeof sizes/sizeof sizes[0]; ++form) {
        memset(page,0x90,sizeof page); memcpy(page,forms[form],sizes[form]);
        pl_x86_instruction instruction;
        if (pl_x86_decode_profile(&image,map.address,&instruction)
                || !pl_x86_halt_supported(&instruction)) return 1;
        pl_arena arena = {arena_bytes,sizeof arena_bytes,0u};
        pl_x86_semantic semantic;
        if (pl_x86_lower(&instruction,&arena,&semantic)
                || semantic.successor_count != 1u
                || semantic.successor[0] != map.address + sizes[form]) return 2;
        if (wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
                || report.source_instructions != 1u || report.source_bytes != sizes[form]
                || report.continuation != map.address + sizes[form]
                || report.boundary != WASM_CUT_SYSTEM || report.memory_bytes) return 3;
        for (pl_u32 bit = 0u; bit < 32u; ++bit) {
            pl_x86_instruction changed = instruction; changed.flags ^= 1u << bit;
            if (!pl_x86_halt_supported(&changed)) ++refusals;
        }
        pl_x86_instruction changed = instruction; changed.machine_argument = 1u;
        if (pl_x86_halt_supported(&changed)) return 4;
        changed = instruction; ++changed.fallthrough;
        if (pl_x86_halt_supported(&changed)) return 5;
    }
    memset(page,0x90,sizeof page); page[1] = 0xf4;
    if (wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&emitted,&report)
            || report.source_instructions != 1u || report.continuation != map.address + 1u
            || report.boundary != WASM_CUT_SYSTEM) return 6;
    page[0] = 0xf0; page[1] = 0xf4;
    if (check_fault_admission(&image,&options,6u)) return 7;
    int status = native_fault();
    if (status) return status;
    printf("halt: 5 shared/native-cold forms, %u descriptor refusals, native CPL3 #GP; privileged wake separate\n",refusals);
    return 0;
}
