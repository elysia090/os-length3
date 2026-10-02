#include <vm/mmu.h>
#include "memory-internal.h"
#include <stddef.h>

#define PHYSICAL_MASK 0x000000fffffff000ull
#define NX (1ull << 63u)
#define PRESENT 1u
#define WRITABLE 2u
#define USER 4u
#define ACCESSED 32u
#define DIRTY 64u
#define LARGE 128u

static machine_result pending(pl_u8 *port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    vm_memory_store(port + offsetof(machine_memory_port, request_address), address, 8u);
    vm_memory_store(port + offsetof(machine_memory_port, request_bytes), bytes, 4u);
    vm_memory_store(port + offsetof(machine_memory_port, request_access),
                    access | VM_MMU_PHYSICAL_REQUEST, 4u);
    return machine_result_make(MACHINE_RESULT_BARRIER, 0u);
}

static machine_result exception(pl_u8 *port, pl_u64 address, pl_u32 vector, pl_u32 error)
{
    vm_memory_store(port + offsetof(machine_memory_port, fault_address), address, 8u);
    vm_memory_store(port + offsetof(machine_memory_port, fault_vector), vector, 4u);
    vm_memory_store(port + offsetof(machine_memory_port, fault_error), error, 4u);
    return machine_result_make(MACHINE_RESULT_FAULT, vector);
}

static machine_result resident_word(vm_memory *memory, pl_u8 *port,
                                    pl_u64 address, pl_u32 access, pl_u32 bytes,
                                    pl_u8 **result)
{
    const vm_memory_page *page = vm_memory_find(memory, address);
    if (!page || page->kind != VM_MEMORY_RAM || !(page->rights & access))
        return pending(port, address, bytes, access);
    *result = memory->bytes + page->offset + (pl_u32)(address & 4095u);
    return 0u;
}

static int context_supported(const vm_mmu_context *context)
{
    /* Long mode and 4 KiB/2 MiB paging only; control-register legality must
     * already be enforced at the compiled machine-operation boundary. */
    pl_u64 forbidden = (1ull << 12u) | (1ull << 17u) | (1ull << 20u)
                     | (1ull << 21u) | (1ull << 22u) | (1ull << 24u);
    return context && context->cpl <= 3u
        && (context->cr0 & 0x80000001ull) == 0x80000001ull
        && (context->cr4 & 32u) && !(context->cr4 & forbidden)
        && (context->efer & 0x500u) == 0x500u
        && !(context->cr3 & ~0x000000ffffffffffull)
        && !(context->cr3 & 0xfe7u);
}

static machine_result walk(vm_memory *memory, pl_u8 *port,
                            const vm_mmu_context *context, pl_u64 address,
                            pl_u32 access, pl_u64 *physical)
{
    const pl_u32 shifts[] = { 39u, 30u, 21u, 12u };
    pl_u64 table = context->cr3 & PHYSICAL_MASK;
    pl_u32 writable = WRITABLE, user = USER, nx = 0u;
    pl_u32 write = !!(access & MACHINE_MEMORY_WRITE);
    pl_u32 execute = !!(access & VM_MMU_EXECUTE);
    pl_u32 is_user = context->cpl == 3u;
    pl_u32 error = write * 2u | is_user * 4u
                 | (execute && (context->efer & (1ull << 11u)) ? 16u : 0u);
    for (pl_u32 level = 0u; level < 4u; ++level) {
        pl_u64 at = table + ((address >> shifts[level]) & 511u) * 8u;
        pl_u8 *entry_bytes = NULL;
        machine_result status = resident_word(memory, port, at, MACHINE_MEMORY_READ, 8u, &entry_bytes);
        if (status) return status;
        pl_u64 entry = vm_memory_load(entry_bytes, 8u);
        if (!(entry & PRESENT)) return exception(port, address, 14u, error);
        pl_u64 reserved = 0x000fff0000000000ull;
        if (!(context->efer & (1ull << 11u))) reserved |= NX;
        if (level < 2u) reserved |= LARGE; /* No exposed 1 GiB capability. */
        pl_u32 leaf = level == 3u || (level == 2u && (entry & LARGE));
        pl_u32 shift = leaf ? shifts[level] : 12u;
        if (leaf && shift == 21u) reserved |= 0x1fe000u;
        if (entry & reserved) return exception(port, address, 14u, error | 9u);
        writable &= (pl_u32)entry & WRITABLE;
        user &= (pl_u32)entry & USER;
        nx |= !!(entry & NX);
        if (leaf && ((is_user && !user) || (execute && nx)
                || (write && !writable && (is_user || (context->cr0 & 0x10000u)))))
            return exception(port, address, 14u, error | 1u);
        pl_u32 set = ACCESSED | (leaf && write ? DIRTY : 0u);
        if (set & ~(pl_u32)entry) {
            pl_u8 *writable_entry = NULL;
            status = resident_word(memory, port, at, MACHINE_MEMORY_WRITE, 8u, &writable_entry);
            if (status) return status;
            /* Serialized, pinned owner: no competing CPU/device/table writer
             * can occur between this load and store. This is not SMP CAS. */
            vm_memory_store(writable_entry, entry | set, 8u);
            memory->write_touched = 1u;
        }
        if (leaf) {
            pl_u64 offset_mask = (1ull << shift) - 1u;
            *physical = (entry & PHYSICAL_MASK & ~offset_mask) | (address & offset_mask);
            return 0u;
        }
        table = entry & PHYSICAL_MASK;
    }
    return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
}

machine_result vm_mmu_access(vm_memory *memory, pl_u32 port_offset,
                             const vm_mmu_context *context, pl_u64 address,
                             pl_u32 bytes, pl_u32 access, pl_u64 value)
{
    if (!memory || !memory->bytes || !memory->generation || !context_supported(context)
            || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > memory->reserved_bytes
            || (bytes != 1u && bytes != 2u && bytes != 4u && bytes != 8u)
            || (access & ~15u) || ((access & 3u) != MACHINE_MEMORY_READ
                               && (access & 3u) != MACHINE_MEMORY_WRITE)
            || ((access & VM_MMU_EXECUTE) && (access & (MACHINE_MEMORY_WRITE | MACHINE_MEMORY_STACK))))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    pl_u8 *port = memory->bytes + port_offset;
    if (vm_memory_load(port, 8u) != memory->generation)
        return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
    if ((address >> 47u != 0u && address >> 47u != 0x1ffffu)
            || address > ~0ull - (bytes - 1u)
            || ((address + bytes - 1u) >> 47u != 0u && (address + bytes - 1u) >> 47u != 0x1ffffu))
        return exception(port, address, access & MACHINE_MEMORY_STACK ? 12u : 13u, 0u);
    pl_u8 *fragments[2];
    pl_u32 lengths[2], parts = 0u, consumed = 0u;
    while (consumed < bytes) {
        pl_u64 current = address + consumed, physical = 0u;
        machine_result status = walk(memory, port, context, current, access, &physical);
        if (status) return status;
        pl_u32 length = 4096u - (pl_u32)(current & 4095u);
        if (length > bytes - consumed) length = bytes - consumed;
        status = resident_word(memory, port, physical, access & 3u, length, fragments + parts);
        if (status) return status;
        lengths[parts++] = length;
        consumed += length;
    }
    consumed = 0u;
    if (access & MACHINE_MEMORY_WRITE) {
        for (pl_u32 i = 0u; i < parts; ++i) {
            vm_memory_store(fragments[i], value >> (consumed * 8u), lengths[i]);
            memory->write_touched = 1u;
            consumed += lengths[i];
        }
    } else {
        value = 0u;
        for (pl_u32 i = 0u; i < parts; ++i) {
            value |= vm_memory_load(fragments[i], lengths[i]) << (consumed * 8u);
            consumed += lengths[i];
        }
        vm_memory_store(port + offsetof(machine_memory_port, value), value, 8u);
    }
    return 0u;
}
