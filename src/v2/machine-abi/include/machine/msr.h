#ifndef MACHINE_MSR_H
#define MACHINE_MSR_H

#include <machine/state.h>

/* Serialized, precise long-mode register boundary. Generated cuts import
 * machine.msr: (i32 port, i32 operation, i32 key, i64 value) -> i64 result.
 * A successful READ supplies port.value; WRITE/SWAP_GS publish only the MSR
 * or hidden cache. The generated cut owns GPRs, RIP, flags and retirement.
 * Keys are architectural ECX[31:0], not an index into an arbitrary dictionary. */
enum machine_msr_operation {
    MACHINE_MSR_READ = 0u, MACHINE_MSR_WRITE, MACHINE_MSR_SWAP_GS,
};
#define MACHINE_MSR_EFER 0xc0000080u
#define MACHINE_MSR_FS_BASE 0xc0000100u
#define MACHINE_MSR_GS_BASE 0xc0000101u
#define MACHINE_MSR_KERNEL_GS_BASE 0xc0000102u
#define MACHINE_MSR_TSC 0x10u
#define MACHINE_MSR_STAR 0xc0000081u
#define MACHINE_MSR_LSTAR 0xc0000082u
#define MACHINE_MSR_CSTAR 0xc0000083u
#define MACHINE_MSR_SYSCALL_MASK 0xc0000084u
#define MACHINE_MSR_MISC_ENABLE 0x1a0u

/* TSC/SYSCALL belong to the declared CPU profile. Their remaining
 * time/control boundaries are not implemented here: refuse admission,
 * rather than invent #GP for an architecturally available register. */

/* This CPU has no PMU/BTS/PEBS, thermal/power control or MONITOR. Fast
 * strings reset enabled; Limit CPUID and XD-disable reset clear. The two
 * unavailable status bits are read-only. Accepted writes preserve them.
 * A write changing status or disabling XD with NXE active is an explicit
 * remaining admission boundary, not an invented architectural fault. */
#define MACHINE_MISC_FAST_STRINGS 1ull
#define MACHINE_MISC_LIMIT_CPUID (1ull << 22u)
#define MACHINE_MISC_XD_DISABLE (1ull << 34u)
#define MACHINE_MISC_READ_ONLY 0x1800ull
#define MACHINE_MISC_WRITABLE (MACHINE_MISC_FAST_STRINGS | MACHINE_MISC_LIMIT_CPUID | MACHINE_MISC_XD_DISABLE)
#define MACHINE_MISC_RESET (MACHINE_MISC_READ_ONLY | MACHINE_MISC_FAST_STRINGS)

/* EFER and active FS/GS bases already have canonical owners. The residual
 * bank has fixed ranks: 0=inactive KERNEL_GS_BASE, 1=MISC_ENABLE. An absent
 * bank denotes both reset values; count=1 denotes only the inactive base.
 * Creating rank 1 also installs a reset rank 0. Never reorder, duplicate or
 * accept an unknown key on resume. Uncounted words are not live state. */
static inline int machine_msr_bank_valid(const machine_state *state)
{
    if (state->msr_count > 2u) return 0;
    if (state->msr_count && (state->msr_keys[0] != MACHINE_MSR_KERNEL_GS_BASE
            || !(state->msr_values[0] >> 47u == 0u || state->msr_values[0] >> 47u == 0x1ffffu))) return 0;
    if (state->msr_count == 2u && (state->msr_keys[1] != MACHINE_MSR_MISC_ENABLE
            || (state->msr_values[1] & ~(MACHINE_MISC_WRITABLE | MACHINE_MISC_READ_ONLY))
            || (state->msr_values[1] & MACHINE_MISC_READ_ONLY) != MACHINE_MISC_READ_ONLY
            || ((state->msr_values[1] & MACHINE_MISC_XD_DISABLE) && (state->efer & 0x800u)))) return 0;
    return 1;
}
static inline pl_u64 machine_misc_enable(const machine_state *state)
{ return state->msr_count == 2u ? state->msr_values[1] : MACHINE_MISC_RESET; }
#endif
