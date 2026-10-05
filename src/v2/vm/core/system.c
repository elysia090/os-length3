#include <vm/system.h>
#include "memory-internal.h"
#include <stddef.h>
static int canonical(pl_u64 value)
{ return value>>47u==0u || value>>47u==0x1ffffu; }
static machine_result fault(pl_u8 *port,const machine_state *state,pl_u32 vector)
{
    vm_memory_store(port+offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_vector),vector,4u);
    vm_memory_store(port+offsetof(machine_memory_port,fault_error),0u,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,vector);
}
machine_result vm_system_transfer(vm_memory *physical,pl_u32 port_offset,
    machine_state *state,machine_segments *segments,pl_u32 operation,pl_u64 next_rip)
{
    vm_memory_abort(physical);
    if(state && segments) {
        pl_u32 cpl=(pl_u32)state->system[MACHINE_SYSTEM_CS]&3u;
        pl_u32 cs=segments->cache[MACHINE_SEGMENT_CS].attributes,dpl=(cs>>5u)&3u;
        if((cs&0x98u)!=0x98u || (cpl && ((cs&4u)?dpl>cpl:dpl!=cpl)))
            return MACHINE_RESULT_ENTRY_MAP;
    }
    if(!physical || !physical->bytes || !physical->generation || !state || !segments
            || (port_offset&7u) || (pl_u64)port_offset+sizeof(machine_memory_port)>physical->reserved_bytes
            || segments->version!=MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow>MACHINE_SHADOW_STI
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes&0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes&(0x4000u|MACHINE_SEGMENT_UNUSABLE))
            || (state->rflags&0x20100u) || (state->efer&0x500u)!=0x500u || (state->efer&~0xd01ull)
            || (state->cr0&0x80000001u)!=0x80000001u || !(state->cr4&32u)
            || (state->cr4&~VM_CPU_CR4_VISIBLE) || !machine_msr_bank_valid(state)
            || operation>MACHINE_SYSTEM_RETURN64
            || (operation==MACHINE_SYSTEM_RETURN64 ? next_rip!=0u
                : next_rip-state->rip<1u || next_rip-state->rip>15u)) return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port=physical->bytes+port_offset;
    if(vm_memory_load(port,8u)!=physical->generation)return MACHINE_RESULT_STALE_GENERATION;
    if(!(state->efer&1u))return fault(port,state,6u);
    pl_u64 star=state->msr_count>2u?state->msr_values[2]:0u;
    pl_u32 cs,ss;pl_u64 target,flags;
    if(operation==MACHINE_SYSTEM_RETURN64) {
        target=state->registers[1];
        if((state->system[MACHINE_SYSTEM_CS]&3u)||!canonical(target))return fault(port,state,13u);
        flags=(state->registers[11]&0x3c7fd7u)|2u;
        cs=(((pl_u32)(star>>48u)+16u)&65535u)|3u;
        ss=(((pl_u32)(star>>48u)+8u)&65535u)|3u;
    } else {
        target=state->msr_count>3u?state->msr_values[3]:0u;
        pl_u64 mask=state->msr_count>5u?state->msr_values[5]:0u;
        /* RF is cleared before flags are saved; bit 1 remains fixed even if
         * the supplied FMASK contains it. Neither transfer accesses RSP. */
        pl_u64 saved=state->rflags&~0x10000ull;
        flags=(saved&~mask)|2u;
        cs=(pl_u32)(star>>32u)&65532u;
        ss=((pl_u32)(star>>32u)+8u)&65535u;
        state->registers[1]=next_rip;state->registers[11]=saved;
    }
    state->rip=target;state->rflags=flags;
    state->system[MACHINE_SYSTEM_CS]=cs;state->system[MACHINE_SYSTEM_SS]=ss;
    segments->cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,
        operation==MACHINE_SYSTEM_CALL64?0xa09bu:0xa0fbu};
    segments->cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,
        operation==MACHINE_SYSTEM_CALL64?0xc093u:0xc0f3u};
    segments->interrupt_shadow=0u;
    return 0u;
}
