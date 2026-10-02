#include <vm/tables.h>
#include "memory-internal.h"
#include <stddef.h>

machine_result vm_table_load(vm_memory *physical, pl_u32 port_offset,
                              machine_state *state, pl_u64 address,
                              pl_u32 rank, pl_u32 access)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !physical->generation || !state
            || rank > 1u || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > physical->reserved_bytes
            || (access & ~7u) || (access & 3u) != MACHINE_MEMORY_READ
            || (state->efer & 0x500u) != 0x500u || (state->rflags & 0x70100u))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port = physical->bytes + port_offset;
    if (vm_memory_load(port,8u) != physical->generation) return MACHINE_RESULT_STALE_GENERATION;
    pl_u32 cpl = (pl_u32)state->system[MACHINE_SYSTEM_CS] & 3u;
    if (cpl) {
        vm_memory_store(port + offsetof(machine_memory_port,fault_address),state->rip,8u);
        vm_memory_store(port + offsetof(machine_memory_port,fault_vector),13u,4u);
        vm_memory_store(port + offsetof(machine_memory_port,fault_error),0u,4u);
        return machine_result_make(MACHINE_RESULT_FAULT,13u);
    }
    vm_mmu_context context = {state->cr0,state->cr3,state->cr4,state->efer,cpl};
    pl_u8 descriptor[10];
    machine_result result = vm_mmu_read_record(physical,port_offset,&context,address,10u,access,descriptor);
    if (result) return result;
    pl_u32 base = rank ? MACHINE_SYSTEM_IDTR_BASE : MACHINE_SYSTEM_GDTR_BASE;
    /* The operand address must be canonical, not the loaded base. Linux may
     * install a table pointer before the mapping that will eventually use it. */
    state->system[base] = vm_memory_load(descriptor + 2u,8u);
    state->system[base + 1u] = vm_memory_load(descriptor,2u);
    return 0u;
}
