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

/* TSC's remaining time boundary refuses admission rather than inventing #GP.
 * Syscall configuration has an architectural owner independent of whether
 * the generated syscall control transfer is already admitted. */

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
 * bank is a fixed prefix: inactive GS, MISC_ENABLE, STAR, LSTAR, CSTAR, FMASK.
 * An absent rank denotes its declared reset value; a read never creates it.
 * A write initializes only intervening ranks and never truncates later ones.
 * No dictionary, duplicate/reordered key or uncounted word is live state. */
#define MACHINE_MSR_BANK_COUNT 6u
static inline pl_u32 machine_msr_rank_key(pl_u32 rank)
{ return rank<2u ? (rank ? MACHINE_MSR_MISC_ENABLE : MACHINE_MSR_KERNEL_GS_BASE)
                  : MACHINE_MSR_STAR+rank-2u; }
static inline pl_u64 machine_msr_rank_reset(pl_u32 rank)
{ return rank==1u ? MACHINE_MISC_RESET : 0u; }
static inline int machine_msr_rank_value_valid(pl_u32 rank, pl_u64 value)
{
    if (rank==0u || rank==3u) return value>>47u==0u || value>>47u==0x1ffffu;
    if (rank==1u) return !(value&~(MACHINE_MISC_WRITABLE|MACHINE_MISC_READ_ONLY))
        && (value&MACHINE_MISC_READ_ONLY)==MACHINE_MISC_READ_ONLY;
    if (rank==2u) return !(value&0xffffffffu);
    if (rank==5u) return !(value>>32u);
    /* Intel CSTAR is unused, not a dereferenced canonical target. */
    return rank==4u;
}
static inline int machine_msr_bank_valid(const machine_state *state)
{
    if (state->msr_count>MACHINE_MSR_BANK_COUNT) return 0;
    for (pl_u32 rank=0u;rank<state->msr_count;++rank)
        if (state->msr_keys[rank]!=machine_msr_rank_key(rank)
                || !machine_msr_rank_value_valid(rank,state->msr_values[rank])) return 0;
    if (state->msr_count>=2u && (state->msr_values[1]&MACHINE_MISC_XD_DISABLE)
            && (state->efer&0x800u)) return 0;
    return 1;
}
static inline pl_u64 machine_misc_enable(const machine_state *state)
{ return state->msr_count>=2u ? state->msr_values[1] : MACHINE_MISC_RESET; }
#endif
