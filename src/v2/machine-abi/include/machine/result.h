/* One homogeneous result token for blocks, dispatchers, and machine steps. */

#ifndef MACHINE_RESULT_H
#define MACHINE_RESULT_H

#include <support/types.h>

typedef pl_u64 machine_result;

#define MACHINE_RESULT_KIND_BITS 3u
#define MACHINE_RESULT_KIND_MASK 7u

enum machine_result_kind {
    MACHINE_RESULT_DIRECT = 0,
    MACHINE_RESULT_RESOLVE_RIP = 1,
    MACHINE_RESULT_BARRIER = 2,
    MACHINE_RESULT_FAULT = 3,
    MACHINE_RESULT_HALT = 4,
    MACHINE_RESULT_STALE_GENERATION = 5,
    MACHINE_RESULT_ENTRY_MAP = 6,
    MACHINE_RESULT_TRANSITION = 7,
};

/* Host-residency wait and bounded execution yield are not guest exceptions.
 * A latched one-instruction entry remains pinned until it finishes or faults. */
enum machine_barrier_reason {
    MACHINE_BARRIER_RESOURCE = 0u,
    MACHINE_BARRIER_QUANTUM = 1u,
    MACHINE_BARRIER_CLOCK = 2u,
    MACHINE_BARRIER_CONSOLE = 3u,
};
#define MACHINE_REPEAT_MAX_ELEMENTS 256u

static inline machine_result machine_result_make(pl_u32 kind, pl_u64 payload)
{
    return (payload << MACHINE_RESULT_KIND_BITS)
         | (pl_u64)(kind & MACHINE_RESULT_KIND_MASK);
}

static inline pl_u32 machine_result_kind(machine_result result)
{
    return (pl_u32)result & MACHINE_RESULT_KIND_MASK;
}

static inline pl_u64 machine_result_payload(machine_result result)
{
    return result >> MACHINE_RESULT_KIND_BITS;
}

static inline pl_u64 machine_transition_payload(pl_u32 arm,
                                                pl_i32 rip_delta)
{
    return ((pl_u64)(pl_u32)rip_delta << 1u) | (pl_u64)(arm & 1u);
}

static inline int machine_transition_open(pl_u64 payload, pl_u32 *arm,
                                          pl_i32 *rip_delta)
{
    if (!arm || !rip_delta || payload >> 33u) return 0;
    *arm = (pl_u32)payload & 1u;
    *rip_delta = (pl_i32)(pl_u32)(payload >> 1u);
    return 1;
}

#endif /* MACHINE_RESULT_H */
