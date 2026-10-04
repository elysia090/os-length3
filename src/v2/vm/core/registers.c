#include <vm/registers.h>
#include "memory-internal.h"
#include <stddef.h>

static machine_result gp(pl_u8 *port, const machine_state *state)
{
    vm_memory_store(port + offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_vector),13u,4u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_error),0u,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,13u);
}

machine_result vm_control_write(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, const machine_segments *segments, pl_u32 rank, pl_u64 value)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !physical->generation || !state || !segments
            || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > physical->reserved_bytes
            || segments->version != MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow > MACHINE_SHADOW_STI
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes & 0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || (state->rflags & 0x20100u) || (state->efer & 0x500u) != 0x500u
            || (state->cr0 & 0x80000001u) != 0x80000001u
            || !(state->cr4 & 32u) || (state->cr4 & ~VM_CPU_CR4_VISIBLE)
            || (rank != 0u && rank != 2u && rank != 3u && rank != 4u && rank != 8u))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port = physical->bytes + port_offset;
    if (vm_memory_load(port,8u) != physical->generation) return MACHINE_RESULT_STALE_GENERATION;
    if (state->system[MACHINE_SYSTEM_CS] & 3u) return gp(port,state);
    pl_u64 *destination;
    if (rank == 0u) {
        /* Low reserved bits are ignored; ET is fixed at one. Long mode
         * cannot clear PG. Check NW/CD and PE against the supplied value. */
        if ((value >> 32u) || (value & 0x80000001u) != 0x80000001u
                || (value & 0x60000000u) == 0x20000000u) return gp(port,state);
        value = (value & 0xe005003full) | 16u;
        destination = &state->cr0;
    } else if (rank == 3u) {
        /* PCIDE is absent: bit 63 is reserved, not a no-flush request.
         * PWT/PCD survive; bits 11:5 and 2:0 are architecturally ignored. */
        if (value >> VM_CPU_PHYSICAL_BITS) return gp(port,state);
        value &= ~0xfe7ull; destination = &state->cr3;
    } else if (rank == 4u) {
        if ((value & ~VM_CPU_CR4_VISIBLE) || !(value & 32u)) return gp(port,state);
        destination = &state->cr4;
    } else if (rank == 8u) {
        if (value & ~15ull) return gp(port,state);
        destination = &state->system[MACHINE_SYSTEM_CR8];
    } else destination = &state->system[MACHINE_SYSTEM_CR2];
    *destination = value;
    /* Arithmetic flags are undefined by MOV CR; preserve the incoming
     * representative. No address walk, guest RAM write or retirement here. */
    return 0u;
}
