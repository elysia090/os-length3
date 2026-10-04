#ifndef VM_CLOCK_H
#define VM_CLOCK_H
#include <vm/memory.h>
#include <machine/state.h>
#include <machine/io.h>
typedef struct {
    pl_u64 issued, ticket, generation, rip, key, value, now;
    pl_u64 acknowledged, acknowledged_generation, acknowledged_time;
    pl_u32 port, stage;
} vm_clock;
#define VM_CLOCK_BOUNDARY_KEY (~0ull)
/* Serialized single-vCPU owner. Rebind cancels pending events, never reuses
 * a ticket; close resets device time but retains the issue high-water mark.
 * A fresh Worker requires a fresh, externally assigned generation. */
void vm_clock_abort(vm_clock *clock);
void vm_clock_close(vm_clock *clock);
machine_result vm_clock_sample(vm_clock *clock, vm_memory *physical,
    pl_u32 port, const machine_state *state, pl_u64 key, pl_u64 value);
/* Supervisor-only sample at a completed instruction boundary. Uses the same
 * ticket frontier as guest-triggered requests; no architectural retirement.
 * A reply is consumed only by the matching retry, never by another device. */
machine_result vm_clock_boundary_sample(vm_clock *clock, vm_memory *physical,
    pl_u32 port, const machine_state *state);
int vm_clock_reply(vm_clock *clock, pl_u64 generation, pl_u32 port,
    const machine_state *state, pl_u64 ticket, pl_u64 nanoseconds);
void vm_clock_consume(vm_clock *clock);
#endif
