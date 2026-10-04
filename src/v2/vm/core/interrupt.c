#include <vm/interrupt.h>
#include "memory-internal.h"
#include <stddef.h>
machine_result vm_interrupt_flag(vm_memory *memory, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, pl_u32 enable)
{
    vm_memory_abort(memory);
    if (!memory || !memory->bytes || !memory->generation || !state || !segments
            || (port_offset&7u) || (pl_u64)port_offset+sizeof(machine_memory_port)>memory->reserved_bytes
            || segments->version!=MACHINE_SEGMENTS_ABI_VERSION
            || segments->interrupt_shadow>MACHINE_SHADOW_STI || enable>1u
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes&0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes&(0x4000u|MACHINE_SEGMENT_UNUSABLE))
            || (state->rflags&0x20100u) || (state->efer&0x500u)!=0x500u
            || (state->cr0&0x80000001u)!=0x80000001u || !(state->cr4&32u))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port=memory->bytes+port_offset;
    if (vm_memory_load(port,8u)!=memory->generation) return MACHINE_RESULT_STALE_GENERATION;
    /* PVI/VME virtual-8086 behavior is not a second execution path. */
    if (state->cr4&2u) return MACHINE_RESULT_ENTRY_MAP;
    if ((state->system[MACHINE_SYSTEM_CS]&3u)>((state->rflags>>12u)&3u)) {
        vm_memory_store(port+offsetof(machine_memory_port,fault_address),state->rip,8u);
        vm_memory_store(port+offsetof(machine_memory_port,fault_vector),13u,4u);
        vm_memory_store(port+offsetof(machine_memory_port,fault_error),0u,4u);
        return machine_result_make(MACHINE_RESULT_FAULT,13u);
    }
    if (enable) {
        if (!(state->rflags&0x200u) && !segments->interrupt_shadow)
            segments->interrupt_shadow=MACHINE_SHADOW_STI;
        state->rflags|=0x200u;
    } else state->rflags&=~0x200ull;
    return 0u;
}
