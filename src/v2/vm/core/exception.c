#include <vm/exception.h>
#include "memory-internal.h"
#include "segments-internal.h"
#include <stddef.h>
#include <machine/control.h>

static int canonical(pl_u64 address)
{ return address >> 47u == 0u || address >> 47u == 0x1ffffu; }
static machine_result fault(pl_u8 *port, const machine_state *state, pl_u32 vector, pl_u32 error)
{
    vm_memory_store(port + offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_vector),vector,4u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_error),error,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,vector);
}
static int admitted(vm_memory *memory, pl_u32 port, const machine_state *state,
                    const machine_segments *segments)
{
    if (state && segments) {
        pl_u32 cpl=(pl_u32)state->system[MACHINE_SYSTEM_CS]&3u;
        pl_u32 cs=segments->cache[MACHINE_SEGMENT_CS].attributes, dpl=(cs>>5u)&3u;
        /* A forged outer selector with a kernel-only cache is not an admitted
         * CPU state. Reject it before consuming a pending interrupt. */
        if (cpl && ((cs&0x98u)!=0x98u || ((cs&4u)?dpl>cpl:dpl!=cpl))) return 0;
    }
    return memory && memory->bytes && memory->generation && state && segments
        && !(port & 7u) && (pl_u64)port + sizeof(machine_memory_port) <= memory->reserved_bytes
        && segments->version == MACHINE_SEGMENTS_ABI_VERSION && segments->interrupt_shadow <= MACHINE_SHADOW_STI
        && (segments->cache[MACHINE_SEGMENT_CS].attributes & 0x2000u)
        && !(segments->cache[MACHINE_SEGMENT_CS].attributes & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
        && !(state->rflags & 0x20000u) && !(state->cr4 & (1ull << 23u));
}

static machine_result enter(vm_memory *memory, pl_u32 port_offset, machine_state *state,
    machine_segments *segments, vm_fault_delivery *delivery, pl_u32 kind, pl_u32 vector, pl_u32 error,
    pl_u64 next_rip)
{
    vm_memory_abort(memory);
    if (!delivery || !admitted(memory,port_offset,state,segments)) return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port = memory->bytes + port_offset;
    if (vm_memory_load(port,8u) != memory->generation) return MACHINE_RESULT_STALE_GENERATION;
    vm_mmu_context context = {state->cr0,state->cr3,state->cr4,state->efer,0u};
    pl_u32 irq=kind==VM_EVENT_INTERRUPT,external=irq||kind==VM_EVENT_DEBUG_TRAP;
    int software=kind==VM_EVENT_SOFTWARE;
    int trap=software||kind==VM_EVENT_DEBUG_TRAP;
    if (!delivery->stage) {
        if (kind==VM_EVENT_FAULT && vector != 0u && vector != 1u && vector != 6u && vector != 7u && vector != 10u && vector != 11u
                && vector != 12u && vector != 13u && vector != 14u && vector != 17u)
            return MACHINE_RESULT_ENTRY_MAP;
        if (kind==VM_EVENT_FAULT && vector == 14u) state->system[MACHINE_SYSTEM_CR2] =
            vm_memory_load(port + offsetof(machine_memory_port,fault_address),8u);
        if(vector==1u){state->system[MACHINE_SYSTEM_DR0+7u]&=~0x2000ull;
            if(kind==VM_EVENT_DEBUG_TRAP)state->system[MACHINE_SYSTEM_DR0+6u]&=~15ull;}
        *delivery = (vm_fault_delivery){.generation=memory->generation,.stage=1u,.kind=kind,
            .context={state->rip,state->cr0,state->cr3,state->cr4,state->efer},
            .frame={state->system[MACHINE_SYSTEM_SS] & 65535u,state->registers[4],
                    trap ? state->rflags & ~0x10000ull : state->rflags | (irq ? 0u : 0x10000u),
                    state->system[MACHINE_SYSTEM_CS] & 65535u,trap ? next_rip : state->rip,error},
            .words=kind==VM_EVENT_FAULT && vector >= 10u ? 6u : 5u,.stack=state->registers[4] & ~15ull,
            .descriptor_address=vector * 16u};
    } else if (delivery->kind != kind || delivery->stage > 4u || (delivery->words != 5u && delivery->words != 6u)
            || delivery->pushed > delivery->words
            || delivery->generation != memory->generation || delivery->context[0] != state->rip
            || delivery->context[1] != state->cr0 || delivery->context[2] != state->cr3
            || delivery->context[3] != state->cr4 || delivery->context[4] != state->efer
            || delivery->frame[1] != state->registers[4]
            || (trap && delivery->frame[4]!=next_rip)
            || (delivery->frame[2] & (irq ? ~0ull : ~0x10000ull))
                != (state->rflags & (irq ? ~0ull : ~0x10000ull))
            || delivery->frame[3] != (state->system[MACHINE_SYSTEM_CS] & 65535u)
            || delivery->frame[0] != (state->system[MACHINE_SYSTEM_SS] & 65535u)) {
        *delivery = (vm_fault_delivery){0}; return MACHINE_RESULT_ENTRY_MAP;
    }
    machine_result result = 0u;
    if (delivery->stage == 1u) {
        pl_u64 index = delivery->descriptor_address, base = state->system[MACHINE_SYSTEM_IDTR_BASE];
        pl_u32 idt_error = (pl_u32)(index / 2u) | 2u | external;
        if (index + 15u > state->system[MACHINE_SYSTEM_IDTR_LIMIT]) {
            result = fault(port,state,13u,idt_error); goto done;
        }
        if (base > ~0ull - index - 15u) { result = fault(port,state,13u,0u); goto done; }
        pl_u8 gate[16];
        result = vm_mmu_read_record(memory,port_offset,&context,base + index,16u,MACHINE_MEMORY_READ,gate);
        if (result) goto done;
        pl_u32 type = gate[5] & 31u;
        if ((type != 14u && type != 15u) || (gate[4] & 0xf8u)
                || vm_memory_load(gate + 12u,4u)) {
            result = fault(port,state,13u,idt_error); goto done;
        }
        if (software && (state->system[MACHINE_SYSTEM_CS]&3u)>((gate[5]>>5u)&3u)) {
            result=fault(port,state,13u,idt_error);goto done;
        }
        if (!(gate[5] & 128u)) { result = fault(port,state,11u,idt_error); goto done; }
        if (gate[4] & 7u) { result = MACHINE_RESULT_ENTRY_MAP; goto done; }
        delivery->selector = (pl_u32)vm_memory_load(gate + 2u,2u);
        delivery->target = vm_memory_load(gate,2u) | vm_memory_load(gate + 6u,2u) << 16u
                         | vm_memory_load(gate + 8u,4u) << 32u;
        delivery->gate_type = type;
        delivery->stage = 2u;
    }
    if (delivery->stage == 2u) {
        pl_u64 value;
        result = vm_descriptor_read(memory,port_offset,state,segments,delivery->selector,
                             external,&delivery->descriptor_address,&value);
        if (result) goto done;
        pl_u32 access = (pl_u32)(value >> 40u) & 255u, selector_error = (delivery->selector & 0xfffcu) | external;
        delivery->code = vm_segment_cache_decode(value);
        if ((access & 0x18u) != 0x18u || (access & 96u)
                || (delivery->code.attributes & 0x6000u) != 0x2000u) {
            result = fault(port,state,13u,selector_error); goto done;
        }
        if (!(access & 128u)) { result = fault(port,state,11u,selector_error); goto done; }
        /* The accepted inner transition targets non-conforming CPL0 code.
         * Conforming outer-origin entries require a different stack rule. */
        if ((delivery->frame[3]&3u) && (access&4u)) { result=MACHINE_RESULT_ENTRY_MAP;goto done; }
        if (!canonical(delivery->target)) { result = fault(port,state,13u,0u); goto done; }
        delivery->descriptor_access = access;
        delivery->stage = 3u;
    }
    if (delivery->stage == 3u) {
        /* A privilege switch uses TSS.RSP0, never the interrupted user stack.
         * Bit 8 pins the successfully read stack across a later Accessed-write
         * residency wait, without growing the bounded event frontier. */
        if ((delivery->frame[3]&3u) && !(delivery->descriptor_access&256u)) {
            const machine_segment_cache *tss=segments->cache+MACHINE_SEGMENT_TR;
            if ((tss->attributes&MACHINE_SEGMENT_UNUSABLE) || (tss->attributes&0x9fu)!=0x8bu
                    || tss->limit<103u || tss->base>~0ull-11u
                    || !canonical(tss->base+4u) || !canonical(tss->base+11u)) {
                result=MACHINE_RESULT_ENTRY_MAP;goto done;
            }
            result=vm_mmu_access(memory,port_offset,&context,tss->base+4u,8u,MACHINE_MEMORY_READ,0u);
            if(result)goto done;
            delivery->stack=vm_memory_load(port+offsetof(machine_memory_port,value),8u)&~15ull;
            delivery->descriptor_access|=256u;
        }
        if (!canonical(delivery->stack)) { result = fault(port,state,12u,0u); goto done; }
        result = vm_descriptor_accessed(memory,port_offset,state,delivery->descriptor_address,delivery->descriptor_access&255u);
        if (result) goto done;
        delivery->stage = 4u;
    }
    while (delivery->pushed < delivery->words) {
        pl_u64 address = delivery->stack - (delivery->pushed + 1u) * 8u;
        result = vm_mmu_access(memory,port_offset,&context,address,8u,
                               MACHINE_MEMORY_WRITE | MACHINE_MEMORY_STACK,delivery->frame[delivery->pushed]);
        if (result) goto done;
        ++delivery->pushed;
    }
    state->registers[4] = delivery->stack - delivery->words * 8u;
    if (delivery->frame[3]&3u) {
        state->system[MACHINE_SYSTEM_SS]=0u;
        segments->cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0u,MACHINE_SEGMENT_UNUSABLE};
    }
    state->system[MACHINE_SYSTEM_CS] = delivery->selector & ~3u;
    segments->cache[MACHINE_SEGMENT_CS] = delivery->code;
    state->rip = delivery->target;
    state->rflags &= ~0x34100ull;
    if (delivery->gate_type == 14u) state->rflags &= ~0x200ull;
    segments->interrupt_shadow = 0u;
done:
    if (result != machine_result_make(MACHINE_RESULT_BARRIER,0u)) *delivery = (vm_fault_delivery){0};
    return result;
}

machine_result vm_fault_enter(vm_memory *memory, pl_u32 port, machine_state *state,
                              machine_segments *segments, vm_fault_delivery *delivery)
{
    if (!delivery || (delivery->stage && delivery->kind!=VM_EVENT_FAULT) || !admitted(memory,port,state,segments))
        return MACHINE_RESULT_ENTRY_MAP;
    return enter(memory,port,state,segments,delivery,VM_EVENT_FAULT,
        (pl_u32)vm_memory_load(memory->bytes+port+offsetof(machine_memory_port,fault_vector),4u),
        (pl_u32)vm_memory_load(memory->bytes+port+offsetof(machine_memory_port,fault_error),4u),0u);
}
machine_result vm_interrupt_enter(vm_memory *memory, pl_u32 port, machine_state *state,
    machine_segments *segments, vm_fault_delivery *delivery, vm_pic *pic)
{
    vm_memory_abort(memory);
    if (!delivery || !pic || !admitted(memory,port,state,segments)) return MACHINE_RESULT_ENTRY_MAP;
    if (vm_memory_load(memory->bytes+port,8u)!=memory->generation) return MACHINE_RESULT_STALE_GENERATION;
    pl_u32 vector=0u;
    if (delivery->stage) {
        if (delivery->kind!=VM_EVENT_INTERRUPT) return MACHINE_RESULT_ENTRY_MAP;
    } else {
        if ((state->rflags&0x100u) || (state->system[MACHINE_SYSTEM_DR0+7u]&255u))
            return MACHINE_RESULT_ENTRY_MAP;
        if (!(state->rflags&0x200u) || segments->interrupt_shadow || !vm_pic_pending(pic))
            return MACHINE_RESULT_ENTRY_MAP;
        /* Reject incompatible cascade wiring without partial acknowledgement. */
        vm_pic accepted=*pic;
        int selected=vm_pic_acknowledge(&accepted);
        if (selected<0) return MACHINE_RESULT_ENTRY_MAP;
        vector=(pl_u32)selected;
        *pic=accepted;
    }
    return enter(memory,port,state,segments,delivery,VM_EVENT_INTERRUPT,vector,0u,0u);
}

machine_result vm_software_interrupt_enter(vm_memory *memory, pl_u32 port, machine_state *state,
    machine_segments *segments, vm_fault_delivery *delivery, pl_u32 vector, pl_u64 next_rip)
{
    pl_u32 kind=vector==MACHINE_EXCEPTION_DEBUG?VM_EVENT_DEBUG_TRAP:VM_EVENT_SOFTWARE;
    if (!delivery || !admitted(memory,port,state,segments) || (vector!=MACHINE_EXCEPTION_BREAKPOINT&&vector!=MACHINE_EXCEPTION_DEBUG)
            || !((next_rip-state->rip)>=1u && (next_rip-state->rip)<=15u)
            || (delivery->stage && delivery->kind!=kind)) return MACHINE_RESULT_ENTRY_MAP;
    return enter(memory,port,state,segments,delivery,kind,vector,0u,next_rip);
}

machine_result vm_interrupt_return(vm_memory *memory, pl_u32 port_offset,
    machine_state *state, machine_segments *segments,pl_u32 return_word)
{
    vm_memory_abort(memory);
    pl_u32 bytes=machine_return_bytes(return_word);
    if (!bytes||(return_word&MACHINE_RETURN_DISCARD_MASK)||!admitted(memory,port_offset,state,segments))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port = memory->bytes + port_offset;
    if (vm_memory_load(port,8u) != memory->generation) return MACHINE_RESULT_STALE_GENERATION;
    if (state->rflags & 0x4000u) return fault(port,state,13u,0u);
    pl_u32 cpl=(pl_u32)state->system[MACHINE_SYSTEM_CS]&3u;
    vm_mmu_context context = {state->cr0,state->cr3,state->cr4,state->efer,cpl};
    if(state->registers[4]>~0ull-(3u*bytes-1u))return fault(port,state,12u,0u);
    pl_u64 frame[5];
    for (pl_u32 i = 0u; i < 3u; ++i) {
        pl_u32 width = i == 1u ? 2u : bytes;
        machine_result result = vm_mmu_access(memory,port_offset,&context,state->registers[4] + i * bytes,
            width,MACHINE_MEMORY_READ | MACHINE_MEMORY_STACK,0u);
        if (result) return result;
        frame[i] = vm_memory_load(port + offsetof(machine_memory_port,value),width);
    }
    pl_u32 selector = (pl_u32)frame[1] & 65535u, error = selector & 0xfffcu;
    pl_u32 return_cpl = selector & 3u;
    pl_u64 address, value;
    machine_result result = vm_descriptor_read(memory,port_offset,state,segments,selector,0u,&address,&value);
    if (result) return result;
    pl_u32 access = (pl_u32)(value >> 40u) & 255u;
    machine_segment_cache code = vm_segment_cache_decode(value);
    pl_u32 dpl = (access >> 5u) & 3u;
    if ((access & 0x18u) != 0x18u || return_cpl<cpl
            || ((access & 4u) ? dpl > return_cpl : dpl != return_cpl)
            || (code.attributes & 0x6000u) != 0x2000u)
        return fault(port,state,13u,error);
    if (!(access & 128u)) return fault(port,state,11u,error);
    /* Loading CS can set its descriptor Accessed bit before a later SS
     * check fails. Architectural register publication is still deferred. */
    result = vm_descriptor_accessed(memory,port_offset,state,address,access);
    if (result) return result;
    if(state->registers[4]>~0ull-(5u*bytes-1u))return fault(port,state,12u,0u);
    /* CS checks precede outer stack operands. Selector slots have 8-byte
     * spacing, but only the low two bytes are read; SS precedes RSP. Reading
     * discarded bytes changes #PF priority/address at page boundaries. */
    for (pl_u32 rank = 0u; rank < 2u; ++rank) {
        pl_u32 i = 4u-rank, width = rank ? bytes : 2u;
        result = vm_mmu_access(memory,port_offset,&context,state->registers[4] + i * bytes,
            width,MACHINE_MEMORY_READ | MACHINE_MEMORY_STACK,0u);
        if (result) return result;
        frame[i] = vm_memory_load(port + offsetof(machine_memory_port,value),width);
    }
    pl_u32 ss = (pl_u32)frame[4] & 65535u;
    if ((ss & 3u) != return_cpl) return fault(port,state,13u,ss & 0xfffcu);
    machine_segment_cache stack = {0u,0u,MACHINE_SEGMENT_UNUSABLE | return_cpl << 5u};
    pl_u64 stack_address = 0u; pl_u32 stack_access = 1u;
    if (ss & 0xfffcu) {
        result = vm_descriptor_read(memory,port_offset,state,segments,ss,0u,&stack_address,&value);
        if (result) return result;
        stack_access = (pl_u32)(value >> 40u) & 255u;
        if ((stack_access & 0x1au) != 0x12u || ((stack_access >> 5u) & 3u) != return_cpl)
            return fault(port,state,13u,ss & 0xfffcu);
        if (!(stack_access & 128u)) return fault(port,state,12u,ss & 0xfffcu);
        stack = vm_segment_cache_decode(value);
    } else if (return_cpl == 3u) return fault(port,state,13u,0u);
    result = vm_descriptor_accessed(memory,port_offset,state,stack_address,stack_access);
    if (result) return result;
    /* RIP legality follows the descriptor loads and their Accessed writes.
     * Merely restoring RSP does not dereference it: a non-canonical restored
     * stack pointer faults only when a subsequent instruction uses it. */
    if (!canonical(frame[0])) return fault(port,state,13u,0u);
    state->rip = frame[0]; state->registers[4] = frame[3];
    state->system[MACHINE_SYSTEM_CS] = selector; state->system[MACHINE_SYSTEM_SS] = ss;
    segments->cache[MACHINE_SEGMENT_CS] = code; segments->cache[MACHINE_SEGMENT_SS] = stack;
    /* Outer return invalidates only data/non-conforming caches whose old
     * descriptor privilege is now too strong. Conforming code remains usable.
     * No architectural selector/cache publication precedes the checks above. */
    if(return_cpl>cpl)vm_segments_outer(state,segments,return_cpl);
    /* CPL0 restores IOPL/IF/VIF/VIP; VM remains unchanged. Reserved bits
     * use the architectural fixed-zero/fixed-one representative. */
    pl_u64 mask=0x4dd5u;
    if(bytes!=2u)mask|=0x250000u; /* RF/AC/ID */
    if(cpl<=((state->rflags>>12u)&3u))mask|=0x200u;
    if(!cpl){mask|=0x3000u;if(bytes!=2u)mask|=0x180000u;}
    state->rflags=(frame[2]&mask)|(state->rflags&~mask&0x3f7fd5u)|2u;
    segments->interrupt_shadow = 0u;
    return 0u;
}
