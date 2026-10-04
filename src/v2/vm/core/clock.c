#include <vm/clock.h>
#include "memory-internal.h"
#include <stddef.h>
void vm_clock_abort(vm_clock *clock)
{ if (clock) { clock->stage = 0u; clock->acknowledged = 0u; } }
void vm_clock_close(vm_clock *clock)
{
    if (clock) { pl_u64 issued = clock->issued; *clock = (vm_clock){0}; clock->issued = issued; }
}
machine_result vm_clock_sample(vm_clock *clock, vm_memory *physical,
    pl_u32 port, const machine_state *state, pl_u64 key, pl_u64 value)
{
    if (!clock || !physical || !physical->bytes || !physical->generation || !state
            || (port & 7u) || (pl_u64)port + sizeof(machine_memory_port) > physical->reserved_bytes)
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *output = physical->bytes + port;
    if (vm_memory_load(output,8u) != physical->generation) return MACHINE_RESULT_STALE_GENERATION;
    if (clock->stage) {
        if (clock->generation != physical->generation || clock->port != port
                || clock->rip != state->rip || clock->key != key || clock->value != value)
            return MACHINE_RESULT_ENTRY_MAP;
        if (clock->stage == 2u) return 0u;
    } else {
        if (clock->issued == ~0ull) return MACHINE_RESULT_ENTRY_MAP;
        clock->ticket = ++clock->issued; clock->generation = physical->generation;
        clock->port = port; clock->rip = state->rip; clock->key = key; clock->value = value;
        clock->stage = 1u;
    }
    vm_memory_store(output + offsetof(machine_memory_port,request_address),clock->ticket,8u);
    vm_memory_store(output + offsetof(machine_memory_port,request_bytes),0u,4u);
    vm_memory_store(output + offsetof(machine_memory_port,request_access),MACHINE_CLOCK_REQUEST,4u);
    return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_CLOCK);
}
int vm_clock_reply(vm_clock *clock, pl_u64 generation, pl_u32 port,
    const machine_state *state, pl_u64 ticket, pl_u64 nanoseconds)
{
    if (!clock || !state || !generation || !ticket) return -1;
    if (!clock->stage)
        return ticket == clock->ticket && port == clock->port
            && ticket == clock->acknowledged && generation == clock->acknowledged_generation
            && nanoseconds == clock->acknowledged_time ? 0 : -1;
    if (generation != clock->generation || port != clock->port || state->rip != clock->rip
            || ticket != clock->ticket || nanoseconds < clock->now) return -1;
    if (clock->stage == 2u) return nanoseconds == clock->now ? 0 : -1;
    clock->now = nanoseconds; clock->stage = 2u;
    return 0;
}
void vm_clock_consume(vm_clock *clock)
{
    clock->acknowledged = clock->ticket; clock->acknowledged_generation = clock->generation;
    clock->acknowledged_time = clock->now; clock->stage = 0u;
}
machine_result vm_clock_boundary_sample(vm_clock *clock, vm_memory *physical,
    pl_u32 port, const machine_state *state)
{
    machine_result result = vm_clock_sample(clock,physical,port,state,VM_CLOCK_BOUNDARY_KEY,0u);
    if (!result) vm_clock_consume(clock);
    return result;
}
