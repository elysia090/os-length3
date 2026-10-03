#include <vm/msr.h>
#include "memory-internal.h"
#include <stddef.h>

static int canonical(pl_u64 value)
{ return value >> 47u == 0u || value >> 47u == 0x1ffffu; }
static machine_result gp(pl_u8 *port, const machine_state *state)
{
    vm_memory_store(port + offsetof(machine_memory_port,fault_address),state->rip,8u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_vector),13u,4u);
    vm_memory_store(port + offsetof(machine_memory_port,fault_error),0u,4u);
    return machine_result_make(MACHINE_RESULT_FAULT,13u);
}
machine_result vm_msr_transfer(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments,
    pl_u32 operation, pl_u32 key, pl_u64 value)
{
    vm_memory_abort(physical);
    if (!physical || !physical->bytes || !physical->generation || !state || !segments
            || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > physical->reserved_bytes
            || segments->version != MACHINE_SEGMENTS_ABI_VERSION || segments->mov_ss_shadow > 1u
            || !(segments->cache[MACHINE_SEGMENT_CS].attributes & 0x2000u)
            || (segments->cache[MACHINE_SEGMENT_CS].attributes & (0x4000u | MACHINE_SEGMENT_UNUSABLE))
            || (state->rflags & 0x20100u) || (state->efer & 0x500u) != 0x500u
            || (state->efer & ~0xd01ull) || (state->cr0 & 0x80000001u) != 0x80000001u
            || !(state->cr4 & 32u) || (state->cr4 & ~VM_CPU_CR4_VISIBLE)
            || operation > MACHINE_MSR_SWAP_GS || !machine_msr_bank_valid(state)
            || !canonical(segments->cache[MACHINE_SEGMENT_FS].base)
            || !canonical(segments->cache[MACHINE_SEGMENT_GS].base))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u8 *port = physical->bytes + port_offset;
    if (vm_memory_load(port,8u) != physical->generation) return MACHINE_RESULT_STALE_GENERATION;
    if (state->system[MACHINE_SYSTEM_CS] & 3u) return gp(port,state);
    if (operation != MACHINE_MSR_SWAP_GS && (key == MACHINE_MSR_TSC
            || key == MACHINE_MSR_STAR || key == MACHINE_MSR_LSTAR
            || key == MACHINE_MSR_CSTAR || key == MACHINE_MSR_SYSCALL_MASK))
        return MACHINE_RESULT_ENTRY_MAP;
    pl_u64 *destination;
    if (operation == MACHINE_MSR_SWAP_GS) {
        pl_u64 inactive = state->msr_count ? state->msr_values[0] : 0u;
        state->msr_keys[0] = MACHINE_MSR_KERNEL_GS_BASE;
        state->msr_values[0] = segments->cache[MACHINE_SEGMENT_GS].base;
        if (!state->msr_count) state->msr_count = 1u;
        segments->cache[MACHINE_SEGMENT_GS].base = inactive;
        return 0u;
    }
    if (key == MACHINE_MSR_EFER) destination = &state->efer;
    else if (key == MACHINE_MSR_FS_BASE) destination = &segments->cache[MACHINE_SEGMENT_FS].base;
    else if (key == MACHINE_MSR_GS_BASE) destination = &segments->cache[MACHINE_SEGMENT_GS].base;
    else if (key == MACHINE_MSR_KERNEL_GS_BASE) destination = &state->msr_values[0];
    else if (key == MACHINE_MSR_MISC_ENABLE) destination = &state->msr_values[1];
    else return gp(port,state);
    if (operation == MACHINE_MSR_READ) {
        vm_memory_store(port + offsetof(machine_memory_port,value),
            key == MACHINE_MSR_MISC_ENABLE ? machine_misc_enable(state)
                : key == MACHINE_MSR_KERNEL_GS_BASE && !state->msr_count ? 0u : *destination,8u);
        return 0u;
    }
    if (key == MACHINE_MSR_EFER) {
        if ((value & ~0xd01ull) || ((value ^ state->efer) & 0x100u)
                || ((value & 0x800u) && (machine_misc_enable(state) & MACHINE_MISC_XD_DISABLE))) return gp(port,state);
        value = (value & ~0x400ull) | (state->efer & 0x400u);
    } else if (key == MACHINE_MSR_MISC_ENABLE) {
        if (value & ~(MACHINE_MISC_WRITABLE | MACHINE_MISC_READ_ONLY)) return gp(port,state);
        if ((value & MACHINE_MISC_READ_ONLY) != MACHINE_MISC_READ_ONLY
                || ((value & MACHINE_MISC_XD_DISABLE) && (state->efer & 0x800u)))
            return MACHINE_RESULT_ENTRY_MAP;
    } else if (!canonical(value)) return gp(port,state);
    if (key == MACHINE_MSR_KERNEL_GS_BASE) {
        state->msr_keys[0] = key; if (!state->msr_count) state->msr_count = 1u;
    } else if (key == MACHINE_MSR_MISC_ENABLE) {
        if (!state->msr_count) {
            state->msr_keys[0] = MACHINE_MSR_KERNEL_GS_BASE; state->msr_values[0] = 0u;
        }
        state->msr_keys[1] = key; state->msr_count = 2u;
    }
    *destination = value;
    return 0u;
}
