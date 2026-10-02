/* Descriptor validation at the compiled architectural transaction boundary. */
#include <vm/segments.h>
#include "memory-internal.h"
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
machine_result vm_segment_load(vm_memory *physical, pl_u32 port_offset,
                                machine_state *state, machine_segments *segments,
                                pl_u32 rank, pl_u32 selector)
{
    if (!physical || !state || !segments || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > physical->reserved_bytes
            || segments->version != MACHINE_SEGMENTS_ABI_VERSION || segments->mov_ss_shadow > 1u
            || rank >= 6u || rank == MACHINE_SEGMENT_CS || selector > 65535u
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes & 0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || (state->cr0 & 0x80000001ull) != 0x80000001ull
            || !(state->cr4 & 32u) || (state->efer & 0x500u) != 0x500u
            || (state->rflags & 0x20000u))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP,0u);
    pl_u8 *port = physical->bytes + port_offset;
    if (!physical->generation || vm_memory_load(port,8u) != physical->generation)
        return machine_result_make(MACHINE_RESULT_STALE_GENERATION,0u);
    pl_u32 cpl = (pl_u32)state->system[MACHINE_SYSTEM_CS] & 3u;
    pl_u32 rpl = selector & 3u, error = selector & 0xfffcu;
    machine_segment_cache next = {0u,0u,MACHINE_SEGMENT_UNUSABLE};
    if (!(selector & 0xfffcu)) {
        if (rank == MACHINE_SEGMENT_SS) {
            if (cpl == 3u || rpl != cpl) return fault(port,state,13u,0u);
            next.attributes |= cpl << 5u;
        }
    } else {
        pl_u64 base = state->system[MACHINE_SYSTEM_GDTR_BASE];
        pl_u64 limit = state->system[MACHINE_SYSTEM_GDTR_LIMIT];
        if (limit > 65535u) return machine_result_make(MACHINE_RESULT_ENTRY_MAP,0u);
        if (selector & 4u) {
            const machine_segment_cache *ldt = segments->cache + MACHINE_SEGMENT_LDTR;
            if ((ldt->attributes & MACHINE_SEGMENT_UNUSABLE) || (ldt->attributes & 0x9fu) != 0x82u)
                return fault(port,state,13u,error);
            base = ldt->base; limit = ldt->limit;
        }
        pl_u32 index = selector & 0xfff8u;
        if ((pl_u64)index + 7u > limit || base > ~0ull - index - 7u
                || !canonical(base + index) || !canonical(base + index + 7u))
            return fault(port,state,13u,error);
        pl_u64 address = base + index;
        /* Descriptor fetch/Accessed update is an implicit supervisor access;
         * a CPL3 MOV does not turn it into a user-page access or #AC. */
        vm_mmu_context context = {state->cr0,state->cr3,state->cr4,state->efer,0u};
        machine_result status = vm_mmu_access(physical,port_offset,&context,address,8u,MACHINE_MEMORY_READ,0u);
        if (status) return status;
        pl_u64 descriptor = vm_memory_load(port + offsetof(machine_memory_port,value),8u);
        pl_u32 access = (pl_u32)(descriptor >> 40u) & 255u;
        pl_u32 type = access & 15u, dpl = (access >> 5u) & 3u;
        int code = !!(type & 8u), conforming = code && (type & 4u);
        if (!(access & 16u)
                || (rank == MACHINE_SEGMENT_SS
                    ? (code || !(type & 2u) || rpl != cpl || dpl != cpl)
                    : ((code && !(type & 2u)) || (!conforming && (cpl > dpl || rpl > dpl)))))
            return fault(port,state,13u,error);
        if (!(access & 128u)) return fault(port,state,rank == MACHINE_SEGMENT_SS ? 12u : 11u,error);
        next.base = ((descriptor >> 16u) & 0xffffffu) | ((descriptor >> 32u) & 0xff000000u);
        next.limit = (pl_u32)(descriptor & 65535u) | (pl_u32)((descriptor >> 32u) & 0xf0000u);
        next.attributes = access | (pl_u32)((descriptor >> 40u) & 0xf000u) | 1u;
        if (next.attributes & 0x8000u) next.limit = (next.limit << 12u) | 4095u;
        if (!(access & 1u)) {
            status = vm_mmu_access(physical,port_offset,&context,address + 5u,1u,MACHINE_MEMORY_WRITE,access | 1u);
            if (status) return status;
        }
    }
    /* No architectural publication precedes successful descriptor admission. */
    state->system[MACHINE_SYSTEM_ES + rank] = selector;
    segments->cache[rank] = next;
    if (rank == MACHINE_SEGMENT_SS) segments->mov_ss_shadow = 1u;
    return 0u;
}
