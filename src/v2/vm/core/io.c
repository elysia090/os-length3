#include <vm/io.h>
#include "memory-internal.h"
#include <stddef.h>
static machine_result context(vm_memory *physical, pl_u32 port,
    const machine_state *state, const machine_segments *segments)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !physical->generation || !state || !segments
            || (port & 7u) || (pl_u64)port + sizeof(machine_memory_port) > physical->reserved_bytes
            || segments->version != MACHINE_SEGMENTS_ABI_VERSION || segments->interrupt_shadow > MACHINE_SHADOW_STI
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes & 0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || (state->rflags & 0x20100u) || (state->efer & 0x500u) != 0x500u
            || (state->efer & ~0xd01ull) || (state->cr0 & 0x80000001u) != 0x80000001u
            || !(state->cr4 & 32u) || (state->cr4 & ~VM_CPU_CR4_VISIBLE)) return MACHINE_RESULT_ENTRY_MAP;
    return vm_memory_load(physical->bytes + port,8u) == physical->generation ? 0u : MACHINE_RESULT_STALE_GENERATION;
}
static machine_result gp(vm_memory *physical, pl_u32 port, const machine_state *state)
{
    pl_u8 *output = physical->bytes + port;
    vm_memory_store(output + offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(output + offsetof(machine_memory_port,fault_vector),13u,4u);
    vm_memory_store(output + offsetof(machine_memory_port,fault_error),0u,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,13u);
}
static machine_result permission(vm_memory *physical, pl_u32 port, const machine_state *state,
    const machine_segments *segments, pl_u32 coordinate, pl_u32 bytes)
{
    pl_u32 cpl = (pl_u32)state->system[MACHINE_SYSTEM_CS] & 3u;
    if (cpl <= ((state->rflags >> 12u) & 3u)) return 0u;
    const machine_segment_cache *tr = &segments->cache[MACHINE_SEGMENT_TR];
    if ((tr->attributes & (MACHINE_SEGMENT_UNUSABLE | 0x90u)) != 0x80u
            || (tr->attributes & 15u) != 11u) return MACHINE_RESULT_ENTRY_MAP;
    if (tr->limit < 103u) return gp(physical,port,state);
    vm_mmu_context supervisor = {state->cr0,state->cr3,state->cr4,state->efer,0u};
    pl_u8 word[2];
    if (tr->base > ~0ull - 103u) return gp(physical,port,state);
    machine_result result = vm_mmu_read_record(physical,port,&supervisor,tr->base + 102u,2u,MACHINE_MEMORY_READ,word);
    if (result) return result;
    pl_u32 offset = (pl_u32)vm_memory_load(word,2u) + (coordinate >> 3u);
    /* x86 reads two bitmap bytes even for an aligned one-byte transfer. */
    if (offset + 1u > tr->limit || tr->base > ~0ull - offset - 1u) return gp(physical,port,state);
    result = vm_mmu_read_record(physical,port,&supervisor,tr->base + offset,2u,MACHINE_MEMORY_READ,word);
    if (result) return result;
    return ((vm_memory_load(word,2u) >> (coordinate & 7u)) & ((1u << bytes) - 1u))
        ? gp(physical,port,state) : 0u;
}
machine_result vm_io_transfer(vm_memory *physical, pl_u32 port,
    const machine_state *state, const machine_segments *segments,
    vm_clock *clock, vm_pit *pit, vm_pic *pic, vm_rtc *rtc, vm_uart *uart, vm_console *console, vm_post *post,
    pl_u32 coordinate, pl_u32 transfer, pl_u64 value)
{
    machine_result result = context(physical,port,state,segments);
    if (result) return result;
    pl_u32 bytes = transfer & 255u, write = (transfer >> 8u) & 1u;
    if (!clock || !pit || coordinate > 65535u || (transfer & ~0x1ffu)
            || (bytes != 1u && bytes != 2u && bytes != 4u)) return MACHINE_RESULT_ENTRY_MAP;
    if(vm_console_pending(console) && (coordinate!=0x3f8u || bytes!=1u || !write))
        return MACHINE_RESULT_ENTRY_MAP;
    result = permission(physical,port,state,segments,coordinate,bytes);
    if (result) return result;
    pl_u32 byte = write ? (pl_u32)value & 255u : 0u;
    /* One UART is wired at 3F8h. The other three legacy UART ranges and
     * removed ISA DMA page ports have no bus target: byte reads float high,
     * writes create no register/IRQ/output. This is not an unknown-port
     * default; unsupported widths and other coordinates still refuse. */
    pl_u32 serial_base=coordinate & ~7u;
    if (bytes==1u && (((coordinate & ~15u)==0x80u
            && ((0x8e8eu >> (coordinate & 15u)) & 1u))
            || serial_base==0x2e8u || serial_base==0x2f8u || serial_base==0x3e8u)) {
        if (clock->stage) return MACHINE_RESULT_ENTRY_MAP;
        if (!write) vm_memory_store(physical->bytes+port+offsetof(machine_memory_port,value),255u,8u);
        return 0u;
    }
    if (coordinate == 0x80u && bytes == 1u && write && post) {
        if (clock->stage) return MACHINE_RESULT_ENTRY_MAP;
        post->byte = (pl_u8)byte; post->valid = 1u; return 0u;
    }
    if(bytes==1u && uart && vm_uart_accepts(coordinate)){
        if(clock->stage)return MACHINE_RESULT_ENTRY_MAP;
        int transfer_result=vm_uart_transfer(uart,clock->now,coordinate,write,&byte);
        if(transfer_result==1){
            result=vm_console_write(console,physical,port,state,byte);
            if(result)return result;
            if(vm_uart_transmit_commit(uart,byte) || vm_console_consume(console))return MACHINE_RESULT_ENTRY_MAP;
        }else if(transfer_result)return MACHINE_RESULT_ENTRY_MAP;
        if(pic)vm_pic_set_irq(pic,4u,(pl_u32)vm_uart_irq(uart));
        if(!write)vm_memory_store(physical->bytes+port+offsetof(machine_memory_port,value),byte,8u);
        return 0u;
    }
    if (bytes==1u && vm_pic_accepts(pic,coordinate,write,byte)) {
        /* No external input can intervene in a synchronous register access.
         * Do not consume or overwrite an outstanding sampled-clock ticket. */
        if (clock->stage || vm_pic_transfer(pic,coordinate,write,&byte)) return MACHINE_RESULT_ENTRY_MAP;
        if (!write) vm_memory_store(physical->bytes+port+offsetof(machine_memory_port,value),byte,8u);
        return 0u;
    }
    if (bytes==1u && vm_rtc_accepts(rtc,coordinate,write,byte)) {
        if (coordinate==0x70u) {
            if (clock->stage || vm_rtc_transfer(rtc,clock->now,coordinate,write,&byte)) return MACHINE_RESULT_ENTRY_MAP;
        } else {
            /* The selected CMOS register is part of the continuation key.
             * A different access cannot consume this sampled-clock reply. */
            result=vm_clock_sample(clock,physical,port,state,((pl_u64)rtc->index<<32u)
                | ((pl_u64)transfer<<16u) | coordinate,write ? value : 0u);
            if (result) return result;
            if (vm_rtc_transfer(rtc,clock->now,coordinate,write,&byte)) return MACHINE_RESULT_ENTRY_MAP;
            vm_clock_consume(clock);
            if (pic) vm_pic_set_irq(pic,8u,(pl_u32)vm_rtc_irq(rtc));
        }
        if (!write) vm_memory_store(physical->bytes+port+offsetof(machine_memory_port,value),byte,8u);
        return 0u;
    }
    if (bytes != 1u || !vm_pit_accepts(coordinate,write,byte)) return MACHINE_RESULT_ENTRY_MAP;
    result = vm_clock_sample(clock,physical,port,state,((pl_u64)transfer << 16u) | coordinate,write ? value : 0u);
    if (result) return result;
    if (vm_pit_transfer(pit,clock->now,pic,coordinate,write,&byte)) return MACHINE_RESULT_ENTRY_MAP;
    if (!write) vm_memory_store(physical->bytes + port + offsetof(machine_memory_port,value),byte,8u);
    vm_clock_consume(clock); return 0u;
}
machine_result vm_time_read(vm_memory *physical, pl_u32 port,
    const machine_state *state, const machine_segments *segments, vm_clock *clock, const vm_console *console)
{
    machine_result result = context(physical,port,state,segments);
    if (result) return result;
    if(vm_console_pending(console))return MACHINE_RESULT_ENTRY_MAP;
    if ((state->cr4 & 4u) && (state->system[MACHINE_SYSTEM_CS] & 3u)) return gp(physical,port,state);
    result = vm_clock_sample(clock,physical,port,state,0x100000000ull,0u);
    if (result) return result;
    vm_memory_store(physical->bytes + port + offsetof(machine_memory_port,value),clock->now,8u);
    vm_clock_consume(clock); return 0u;
}
