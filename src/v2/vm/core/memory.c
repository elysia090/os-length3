#include <vm/memory.h>
#include "memory-internal.h"
#include <stddef.h>
#include <stdint.h>

static int canonical(pl_u64 address)
{ return address >> 47u == 0u || address >> 47u == 0x1ffffu; }

int vm_memory_open(vm_memory *memory, pl_u8 *bytes, pl_u64 byte_count,
                   pl_u32 reserved_bytes, const vm_memory_page *pages,
                   pl_u32 page_count, pl_u64 generation)
{
    if (!memory) return -1;
    *memory = (vm_memory){ 0 };
    if (!bytes || !generation || (page_count && !pages)
            || ((uintptr_t)bytes & 7u) || byte_count > 0x100000000ull
            || reserved_bytes < sizeof(machine_memory_port)
            || reserved_bytes > byte_count) return -1;
    for (pl_u32 i = 0u; i < page_count; ++i) {
        const vm_memory_page *page = pages + i;
        if ((page->address & 4095u) || !canonical(page->address)
                || (i && pages[i - 1u].address >= page->address)) return -1;
        if (page->kind == VM_MEMORY_RAM) {
            if ((page->offset & 4095u) || page->offset < reserved_bytes
                    || (pl_u64)page->offset + 4096u > byte_count
                    || !page->rights || page->rights & ~3u) return -1;
        } else if (page->kind == VM_MEMORY_FAULT) {
            if (page->fault_vector != 14u || !page->rights || page->rights & ~3u) return -1;
        } else if (page->kind != VM_MEMORY_DEFERRED) return -1;
    }
    *memory = (vm_memory){ .bytes = bytes, .byte_count = byte_count, .pages = pages,
        .page_count = page_count, .reserved_bytes = reserved_bytes, .generation = generation };
    return 0;
}

const vm_memory_page *vm_memory_find(const vm_memory *memory, pl_u64 address)
{
    pl_u64 page = address & ~4095ull;
    pl_u32 first = 0u, end = memory->page_count;
    while (first < end) {
        pl_u32 middle = first + (end - first) / 2u;
        pl_u64 candidate = memory->pages[middle].address;
        if (candidate < page) first = middle + 1u;
        else end = middle;
    }
    return first < memory->page_count && memory->pages[first].address == page
         ? memory->pages + first : NULL;
}

static pl_u64 read_word(const pl_u8 *bytes)
{ return vm_memory_load(bytes, 8u); }
static void write_word(pl_u8 *bytes, pl_u64 value, pl_u32 count)
{ vm_memory_store(bytes, value, count); }

static machine_result fault(pl_u8 *port, pl_u64 address,
                             pl_u32 vector, pl_u32 error)
{
    write_word(port + offsetof(machine_memory_port, fault_address), address, 8u);
    write_word(port + offsetof(machine_memory_port, fault_vector), vector, 4u);
    write_word(port + offsetof(machine_memory_port, fault_error), error, 4u);
    return machine_result_make(MACHINE_RESULT_FAULT, vector);
}

static machine_result defer(pl_u8 *port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    write_word(port + offsetof(machine_memory_port, request_address), address, 8u);
    write_word(port + offsetof(machine_memory_port, request_bytes), bytes, 4u);
    write_word(port + offsetof(machine_memory_port, request_access), access, 4u);
    return machine_result_make(MACHINE_RESULT_BARRIER, 0u);
}

machine_result vm_memory_access(vm_memory *memory, pl_u32 port_offset,
                                pl_u64 address, pl_u32 bytes,
                                pl_u32 access, pl_u64 value)
{
    vm_memory_abort(memory);
    if (!memory || !memory->bytes || !memory->generation || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > memory->reserved_bytes
            || (bytes != 1u && bytes != 2u && bytes != 4u && bytes != 8u)
            || (access & ~7u) || ((access & 3u) != MACHINE_MEMORY_READ
                                && (access & 3u) != MACHINE_MEMORY_WRITE))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    pl_u8 *port = memory->bytes + port_offset;
    if (read_word(port + offsetof(machine_memory_port, generation)) != memory->generation)
        return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
    if (!canonical(address) || address > ~0ull - (bytes - 1u)
            || !canonical(address + bytes - 1u))
        return fault(port, address, access & MACHINE_MEMORY_STACK ? 12u : 13u, 0u);
    /* Preflight every fragment before touching payload. Missing translations,
     * nonresident RAM, devices and permission misses request admission. Only
     * an explicitly cached architectural exception is a guest page fault. */
    pl_u32 offsets[2], lengths[2], parts = 0u, consumed = 0u;
    while (consumed < bytes) {
        pl_u64 current = address + consumed;
        const vm_memory_page *page = vm_memory_find(memory, current);
        if (!page || page->kind == VM_MEMORY_DEFERRED)
            return defer(port, address, bytes, access);
        if (page->kind == VM_MEMORY_FAULT && (page->rights & (access & 3u)))
            return fault(port, current, page->fault_vector, page->fault_error);
        if (page->kind != VM_MEMORY_RAM || !(page->rights & (access & 3u)))
            return defer(port, address, bytes, access);
        pl_u32 offset = (pl_u32)(current & 4095u);
        pl_u32 length = 4096u - offset;
        if (length > bytes - consumed) length = bytes - consumed;
        offsets[parts] = page->offset + offset; lengths[parts++] = length;
        consumed += length;
    }
    if (access & MACHINE_MEMORY_WRITE) {
        consumed = 0u;
        for (pl_u32 part = 0u; part < parts; ++part) {
            write_word(memory->bytes + offsets[part], value >> (consumed * 8u), lengths[part]);
            memory->write_touched = 1u;
            consumed += lengths[part];
        }
    } else {
        value = 0u;
        consumed = 0u;
        for (pl_u32 part = 0u; part < parts; ++part)
            for (pl_u32 i = 0u; i < lengths[part]; ++i)
                value |= (pl_u64)memory->bytes[offsets[part] + i] << (consumed++ * 8u);
        write_word(port + offsetof(machine_memory_port, value), value, 8u);
    }
    return machine_result_make(MACHINE_RESULT_DIRECT, 0u);
}

void vm_memory_abort(vm_memory *memory)
{ if (memory) memory->reservation = (vm_memory_reservation){ 0 }; }

machine_result vm_memory_commit(vm_memory *memory, pl_u32 port_offset, pl_u64 value)
{
    if (!memory) return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation saved = memory->reservation;
    vm_memory_abort(memory);
    if (!memory->bytes || !memory->generation || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > memory->reserved_bytes)
        return MACHINE_RESULT_ENTRY_MAP;
    if (read_word(memory->bytes + port_offset) != memory->generation)
        return MACHINE_RESULT_STALE_GENERATION;
    if (saved.generation != memory->generation || saved.port != port_offset
            || !saved.parts || saved.parts > 2u) return MACHINE_RESULT_ENTRY_MAP;
    pl_u32 consumed = 0u;
    for (pl_u32 i = 0u; i < saved.parts; ++i) {
        write_word(memory->bytes + saved.offsets[i], value >> (consumed * 8u), saved.lengths[i]);
        consumed += saved.lengths[i];
    }
    memory->write_touched = 1u;
    return 0u;
}
