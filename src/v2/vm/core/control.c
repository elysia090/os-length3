#include <vm/control.h>
#include "memory-internal.h"
#include "segments-internal.h"
#include <stddef.h>
static int canonical(pl_u64 address)
{ return address >> 47u == 0u || address >> 47u == 0x1ffffu; }
static machine_result fault(pl_u8 *port, const machine_state *state, pl_u32 vector, pl_u32 error)
{
    vm_memory_store(port + offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_vector),vector,4u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_error),error,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,vector);
}
machine_result vm_far_return(vm_memory *physical, pl_u32 port_offset,
                              machine_state *state, machine_segments *segments,
                              pl_u32 discard_bytes)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !physical->generation || !state || !segments
            || (port_offset & 7u) || discard_bytes > 65535u
            || (pl_u64)port_offset + sizeof(machine_memory_port) > physical->reserved_bytes
            || segments->version != MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow > MACHINE_SHADOW_STI
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes & 0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || (state->rflags & 0x60100u) || (state->cr4 & (1ull << 23u))) return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port = physical->bytes + port_offset;
    if (vm_memory_load(port,8u) != physical->generation) return MACHINE_RESULT_STALE_GENERATION;
    pl_u32 cpl = (pl_u32)state->system[MACHINE_SYSTEM_CS] & 3u;
    vm_mmu_context context = {state->cr0,state->cr3,state->cr4,state->efer,cpl};
    pl_u8 stack[16];
    machine_result result = vm_mmu_read_record(physical,port_offset,&context,state->registers[4],16u,
        MACHINE_MEMORY_READ | MACHINE_MEMORY_STACK,stack);
    if (result) return result;
    pl_u64 target = vm_memory_load(stack,8u);
    pl_u32 selector = (pl_u32)vm_memory_load(stack + 8u,2u), error = selector & 0xfffcu;
    if (!(selector & 0xfffcu)) return fault(port,state,13u,0u);
    pl_u64 base = state->system[MACHINE_SYSTEM_GDTR_BASE];
    pl_u64 limit = state->system[MACHINE_SYSTEM_GDTR_LIMIT];
    if (limit > 65535u) return MACHINE_RESULT_ENTRY_MAP;
    if (selector & 4u) {
        const machine_segment_cache *ldt = segments->cache + MACHINE_SEGMENT_LDTR;
        if ((ldt->attributes & MACHINE_SEGMENT_UNUSABLE) || (ldt->attributes & 0x9fu) != 0x82u)
            return fault(port,state,13u,error);
        base = ldt->base; limit = ldt->limit;
    }
    pl_u32 index = selector & 0xfff8u;
    if ((pl_u64)index + 7u > limit || base > ~0ull - index - 7u
            || !canonical(base + index) || !canonical(base + index + 7u)) return fault(port,state,13u,error);
    context.cpl = 0u; /* Implicit descriptor access is supervisor-owned. */
    result = vm_mmu_access(physical,port_offset,&context,base + index,8u,MACHINE_MEMORY_READ,0u);
    if (result) return result;
    pl_u64 descriptor = vm_memory_load(port + offsetof(machine_memory_port,value),8u);
    machine_segment_cache next = vm_segment_cache_decode(descriptor);
    /* The future cache has A=1, but the source descriptor still determines
     * whether the implicit Accessed write (and its possible #PF) is required. */
    pl_u32 access = (pl_u32)(descriptor >> 40u) & 255u;
    pl_u32 dpl = (access >> 5u) & 3u, rpl = selector & 3u;
    if ((access & 0x18u) != 0x18u || (next.attributes & 0x6000u) == 0x6000u || rpl < cpl
            || (access & 4u ? dpl > rpl : dpl != rpl)) return fault(port,state,13u,error);
    if (!(access & 128u)) return fault(port,state,11u,error);
    if (rpl != cpl || !(next.attributes & 0x2000u)) return MACHINE_RESULT_ENTRY_MAP;
    if (!canonical(target)) return fault(port,state,13u,0u);
    if (!(access & 1u)) {
        result = vm_mmu_access(physical,port_offset,&context,base + index + 5u,1u,
                              MACHINE_MEMORY_WRITE,access | 1u);
        if (result) return result;
    }
    state->system[MACHINE_SYSTEM_CS] = selector;
    segments->cache[MACHINE_SEGMENT_CS] = next;
    state->registers[4] += 16u + discard_bytes;
    state->rip = target;
    return 0u;
}
