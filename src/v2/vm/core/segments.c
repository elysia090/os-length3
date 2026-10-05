/* Descriptor validation at the compiled architectural transaction boundary. */
#include <vm/segments.h>
#include "memory-internal.h"
#include "segments-internal.h"
#include <stddef.h>

static int canonical(pl_u64 address)
{ return address >> 47u == 0u || address >> 47u == 0x1ffffu; }
int vm_segment_address(const machine_segments *segments, pl_u64 *address, pl_u32 *access)
{
    if (!address || !access) return -1;
    pl_u32 role=*access & (MACHINE_MEMORY_FS | MACHINE_MEMORY_GS);
    if (!role) return 0;
    if (role==(MACHINE_MEMORY_FS | MACHINE_MEMORY_GS)
            || (*access & ((pl_u32)MACHINE_MEMORY_STACK | (pl_u32)VM_MMU_EXECUTE))
            || !segments || segments->version!=MACHINE_SEGMENTS_ABI_VERSION
            || segments->interrupt_shadow>MACHINE_SHADOW_STI) return -1;
    pl_u32 cs=segments->cache[MACHINE_SEGMENT_CS].attributes;
    pl_u32 rank=role==MACHINE_MEMORY_FS ? MACHINE_SEGMENT_FS : MACHINE_SEGMENT_GS;
    pl_u64 base=segments->cache[rank].base;
    if (!(cs & 0x2000u) || (cs & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || !canonical(base)) return -1;
    *address+=base;
    *access &= ~(pl_u32)(MACHINE_MEMORY_FS | MACHINE_MEMORY_GS);
    return 0;
}
static machine_result fault(pl_u8 *port, const machine_state *state, pl_u32 vector, pl_u32 error)
{
    vm_memory_store(port + offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_vector),vector,4u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_error),error,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,vector);
}
static machine_result system_load(vm_memory *physical, pl_u32 port_offset,
                                   machine_state *state, machine_segments *segments,
                                   pl_u32 rank, pl_u32 selector)
{
    pl_u8 *port=physical->bytes+port_offset;
    pl_u32 error=selector&0xfffcu;
    if (state->system[MACHINE_SYSTEM_CS]&3u) return fault(port,state,13u,0u);
    if (!error) {
        if (rank==MACHINE_SEGMENT_TR) return fault(port,state,13u,0u);
        state->system[MACHINE_SYSTEM_LDTR]=selector;
        segments->cache[rank]=(machine_segment_cache){0u,0u,MACHINE_SEGMENT_UNUSABLE};
        return 0u;
    }
    if (selector&4u) return fault(port,state,13u,error);
    pl_u64 base=state->system[MACHINE_SYSTEM_GDTR_BASE];
    pl_u64 limit=state->system[MACHINE_SYSTEM_GDTR_LIMIT];
    pl_u32 index=selector&0xfff8u;
    if (limit>65535u) return MACHINE_RESULT_ENTRY_MAP;
    if ((pl_u64)index+15u>limit || base>~0ull-index-15u
            || !canonical(base+index) || !canonical(base+index+15u))
        return fault(port,state,13u,error);
    pl_u64 address=base+index;
    vm_mmu_context context={state->cr0,state->cr3,state->cr4,state->efer,0u};
    machine_result status=vm_mmu_access(physical,port_offset,&context,address,8u,MACHINE_MEMORY_READ,0u);
    if (status) return status;
    pl_u64 low=vm_memory_load(port+offsetof(machine_memory_port,value),8u);
    pl_u32 access=(pl_u32)(low>>40u)&255u;
    if ((access&31u)!=(rank==MACHINE_SEGMENT_TR ? 9u : 2u)) return fault(port,state,13u,error);
    if (!(access&128u)) return fault(port,state,11u,error);
    status=vm_mmu_access(physical,port_offset,&context,address+8u,8u,MACHINE_MEMORY_READ,0u);
    if (status) return status;
    pl_u64 high=vm_memory_load(port+offsetof(machine_memory_port,value),8u);
    if (high&(15ull<<40u)) return fault(port,state,13u,error);
    machine_segment_cache next=vm_segment_cache_raw(low);
    next.base|=(high&0xffffffffu)<<32u;
    if (rank==MACHINE_SEGMENT_TR) {
        /* All descriptor write rights precede the busy update and cache
         * publication. The pinned ordinary-memory owner serializes this
         * entire implicit RMW; no asynchronous writer or SMP is admitted.
         * Read again after paging A/D writes, which can alias the descriptor. */
        pl_u8 record[16];
        status=vm_mmu_reserve_record(physical,port_offset,&context,address,16u,record);
        if (status) return status;
        record[5]|=2u;
        status=vm_memory_commit_record(physical,port_offset,record,16u);
        if (status) return status;
        next.attributes|=2u; /* The loaded TSS is busy; no task switch. */
    }
    state->system[MACHINE_SYSTEM_ES+rank]=selector;
    segments->cache[rank]=next;
    return 0u;
}
machine_result vm_segment_load(vm_memory *physical, pl_u32 port_offset,
                                machine_state *state, machine_segments *segments,
                                pl_u32 rank, pl_u32 selector)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !state || !segments || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > physical->reserved_bytes
            || segments->version != MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow > MACHINE_SHADOW_STI
            || rank >= MACHINE_SEGMENT_COUNT || rank == MACHINE_SEGMENT_CS || selector > 65535u
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes & 0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || (state->cr0 & 0x80000001ull) != 0x80000001ull
            || !(state->cr4 & 32u) || (state->efer & 0x500u) != 0x500u
            || (state->rflags & 0x20000u))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP,0u);
    pl_u8 *port = physical->bytes + port_offset;
    if (!physical->generation || vm_memory_load(port,8u) != physical->generation)
        return machine_result_make(MACHINE_RESULT_STALE_GENERATION,0u);
    if (rank>=MACHINE_SEGMENT_LDTR) return system_load(physical,port_offset,state,segments,rank,selector);
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
        next = vm_segment_cache_decode(descriptor);
        if (!(access & 1u)) {
            status = vm_mmu_access(physical,port_offset,&context,address + 5u,1u,MACHINE_MEMORY_WRITE,access | 1u);
            if (status) return status;
        }
    }
    /* No architectural publication precedes successful descriptor admission. */
    state->system[MACHINE_SYSTEM_ES + rank] = selector;
    segments->cache[rank] = next;
    if (rank == MACHINE_SEGMENT_SS && !segments->interrupt_shadow)
        segments->interrupt_shadow = MACHINE_SHADOW_MOV_SS;
    return 0u;
}
