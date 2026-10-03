#include <vm/tables.h>
#include "memory-internal.h"
#include <stddef.h>

machine_result vm_table_transfer(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, vm_table_frontier *frontier, pl_u64 address,
    pl_u32 rank, pl_u32 access)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !physical->generation || !state || !frontier
            || rank > 1u || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > physical->reserved_bytes
            || (access & ~7u) || ((access & 3u) != MACHINE_MEMORY_READ
                && (access & 3u) != MACHINE_MEMORY_WRITE)
            || (state->efer & 0x500u) != 0x500u || (state->rflags & 0x60100u))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port = physical->bytes + port_offset;
    if (vm_memory_load(port,8u) != physical->generation) return MACHINE_RESULT_STALE_GENERATION;
    pl_u32 cpl = (pl_u32)state->system[MACHINE_SYSTEM_CS] & 3u;
    int store=(access & 3u)==MACHINE_MEMORY_WRITE;
    pl_u32 base=rank ? MACHINE_SYSTEM_IDTR_BASE : MACHINE_SYSTEM_GDTR_BASE;
    if (frontier->stage && (!store || frontier->stage>2u
            || frontier->generation!=physical->generation || frontier->port!=port_offset
            || frontier->address!=address || frontier->rank!=rank || frontier->access!=access
            || frontier->context[0]!=state->rip || frontier->context[1]!=state->rflags
            || frontier->context[2]!=state->cr0 || frontier->context[3]!=state->cr3
            || frontier->context[4]!=state->cr4 || frontier->context[5]!=state->efer
            || frontier->context[6]!=state->system[MACHINE_SYSTEM_CS]
            || frontier->base!=state->system[base] || frontier->limit!=state->system[base+1u])) {
        *frontier=(vm_table_frontier){0}; return MACHINE_RESULT_ENTRY_MAP;
    }
    if (cpl && (!store || (state->cr4 & (1u<<11u)))) {
        vm_memory_store(port + offsetof(machine_memory_port,fault_address),state->rip,8u);
        vm_memory_store(port + offsetof(machine_memory_port,fault_vector),13u,4u);
        vm_memory_store(port + offsetof(machine_memory_port,fault_error),0u,4u);
        return machine_result_make(MACHINE_RESULT_FAULT,13u);
    }
    vm_mmu_context context = {state->cr0,state->cr3,state->cr4,state->efer,cpl};
    if (store) {
        if (state->system[base+1u]>65535u) return MACHINE_RESULT_ENTRY_MAP;
        if (!frontier->stage) *frontier=(vm_table_frontier){
            .generation=physical->generation,.address=address,.port=port_offset,
            .rank=rank,.access=access,.stage=1u,.base=state->system[base],
            .limit=state->system[base+1u],.context={state->rip,state->rflags,
                state->cr0,state->cr3,state->cr4,state->efer,state->system[MACHINE_SYSTEM_CS]}};
        machine_result result=0u;
        if (frontier->stage==1u) {
            result=vm_mmu_access(physical,port_offset,&context,address,2u,access,frontier->limit);
            if (result) goto done;
            frontier->stage=2u;
        }
        result=vm_mmu_access(physical,port_offset,&context,address+2u,8u,access,frontier->base);
done:
        if (machine_result_kind(result)!=MACHINE_RESULT_BARRIER) *frontier=(vm_table_frontier){0};
        return result;
    }
    pl_u8 descriptor[10];
    machine_result result = vm_mmu_read_record(physical,port_offset,&context,address,10u,access,descriptor);
    if (result) return result;
    /* The operand address must be canonical, not the loaded base. Linux may
     * install a table pointer before the mapping that will eventually use it. */
    state->system[base] = vm_memory_load(descriptor + 2u,8u);
    state->system[base + 1u] = vm_memory_load(descriptor,2u);
    return 0u;
}
