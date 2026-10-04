#include <vm/debug.h>
#include "memory-internal.h"
#include <stddef.h>

static machine_result fault(pl_u8 *port, const machine_state *state, pl_u32 vector)
{
    vm_memory_store(port+offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_vector),vector,4u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_error),0u,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,vector);
}

machine_result vm_debug_transfer(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, const machine_segments *segments,
    pl_u32 write, pl_u32 rank, pl_u64 value)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !physical->generation || !state || !segments
            || (port_offset&7u)
            || (pl_u64)port_offset+sizeof(machine_memory_port)>physical->reserved_bytes
            || segments->version!=MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow > MACHINE_SHADOW_STI
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes&0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes&(0x4000u|MACHINE_SEGMENT_UNUSABLE))
            || (state->rflags&0x20100u) || (state->efer&0x500u)!=0x500u
            || (state->cr0&0x80000001u)!=0x80000001u
            || !(state->cr4&32u) || (state->cr4&~VM_CPU_CR4_VISIBLE)
            || write>1u || rank>=8u) return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port=physical->bytes+port_offset;
    if (vm_memory_load(port,8u)!=physical->generation) return MACHINE_RESULT_STALE_GENERATION;
    if (state->system[MACHINE_SYSTEM_CS]&3u) return fault(port,state,13u);
    if (state->system[MACHINE_SYSTEM_DR0+7u]&0x2000u) {
        state->system[MACHINE_SYSTEM_DR0+6u]|=0x2000u;
        return fault(port,state,1u);
    }
    if (rank==4u || rank==5u) rank+=2u;
    pl_u64 *destination=&state->system[MACHINE_SYSTEM_DR0+rank];
    if (!write) {
        vm_memory_store(port+offsetof(machine_memory_port,value),*destination,8u);
        return 0u;
    }
    if (rank>=6u) {
        if (value>>32u) return fault(port,state,13u);
        /* No RTM: DR6 reserved ones include bit 16, DR7.RTM is fixed zero.
         * Preserve only status/control fields and their defined fixed bits. */
        value=rank==6u ? (value&0xe00full)|0xffff0ff0ull
                      : (value&0xffff23ffull)|0x400u;
    }
    *destination=value;
    return 0u;
}
