#include <vm/memory.h>
#include <stdio.h>
#include <string.h>
#include <stddef.h>

static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr, "memory: line %u\n", (unsigned)__LINE__); ++failures; } } while (0)
static _Alignas(8) pl_u8 arena[32768], saved[32768];
static const pl_u32 port_offset = 2048u;
static const pl_u64 base = 0x123456000ull;

static void write64(pl_u32 offset, pl_u64 value)
{ for (pl_u32 i = 0u; i < 8u; ++i) arena[offset + i] = (pl_u8)(value >> (8u * i)); }
static pl_u64 read64(pl_u32 offset)
{
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)arena[offset + i] << (8u * i);
    return value;
}
static void accept_request_metadata(void)
{ memcpy(saved + port_offset + 32u, arena + port_offset + 32u, 16u); }
static vm_memory_page ram(pl_u64 address, pl_u32 offset)
{ return (vm_memory_page){ address, offset, 3u, VM_MEMORY_RAM, 0u, 0u }; }

int main(void)
{
    vm_memory memory;
    vm_memory_page pages[] = { ram(base, 8192u), ram(base + 4096u, 24576u),
        { base + 8192u, 0u, 3u, VM_MEMORY_FAULT, 14u, 6u },
        { base + 12288u, 0u, 3u, VM_MEMORY_DEFERRED, 0u, 0u } };
    memset(arena, 0xa5, sizeof arena); write64(port_offset, 9u);
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 4u, 9u) == 0);
    EXPECT(vm_memory_access(&memory, port_offset, base + 4093u, 8u, 2u, 0xfedcba9876543210ull) == 0u);
    EXPECT(arena[8192u + 4093u] == 0x10u && arena[24576u] == 0x76u);
    EXPECT(vm_memory_access(&memory, port_offset, base + 4093u, 8u, 1u, 0u) == 0u);
    EXPECT(read64(port_offset + 8u) == 0xfedcba9876543210ull);
    memcpy(saved, arena, sizeof arena);
    machine_result result = vm_memory_access(&memory, port_offset, base + 8189u, 8u, 2u, 0u);
    EXPECT(machine_result_kind(result) == MACHINE_RESULT_FAULT && machine_result_payload(result) == 14u);
    EXPECT(read64(port_offset + offsetof(machine_memory_port, fault_address)) == base + 8192u);
    EXPECT(arena[port_offset + offsetof(machine_memory_port, fault_error)] == 6u);
    /* Fault metadata is the only allowed mutation; even the first valid page
     * of a cross-page store stays untouched. */
    memcpy(saved + port_offset + 16u, arena + port_offset + 16u, 16u);
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    for (pl_u32 access = 1u; access <= 2u; ++access) {
        memcpy(saved, arena, sizeof arena);
        EXPECT(machine_result_kind(vm_memory_access(&memory, port_offset, base + 12288u, 8u, access, 0u)) == MACHINE_RESULT_BARRIER);
        EXPECT(machine_result_kind(vm_memory_access(&memory, port_offset, 0x222200000ull, 8u, access, 0u)) == MACHINE_RESULT_BARRIER);
        EXPECT(read64(port_offset + 32u) == 0x222200000ull);
        EXPECT(read64(port_offset + 40u) == ((pl_u64)access << 32u | 8u));
        accept_request_metadata();
        EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    }
    for (pl_u32 access = 1u; access <= 5u; access += 4u) {
        result = vm_memory_access(&memory, port_offset, 0x800000000000ull, 8u, access, 0u);
        EXPECT(machine_result_kind(result) == MACHINE_RESULT_FAULT);
        EXPECT(machine_result_payload(result) == (access & 4u ? 12u : 13u));
    }
    result = vm_memory_access(&memory, port_offset, 0x7fffffffffffull, 2u, 1u, 0u);
    EXPECT(machine_result_payload(result) == 13u);
    result = vm_memory_access(&memory, port_offset, ~0ull, 2u, 5u, 0u);
    EXPECT(machine_result_payload(result) == 12u);
    write64(port_offset, 8u); memcpy(saved, arena, sizeof arena);
    EXPECT(vm_memory_access(&memory, port_offset, base, 8u, 2u, 0u) == MACHINE_RESULT_STALE_GENERATION);
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    write64(port_offset, 9u);
    memcpy(saved, arena, sizeof arena);
    for (pl_u32 width = 0u; width <= 16u; ++width) {
        if (width == 1u || width == 2u || width == 4u || width == 8u) continue;
        EXPECT(vm_memory_access(&memory, port_offset, base, width, 2u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    }
    for (pl_u32 offset = 4096u - (pl_u32)sizeof(machine_memory_port) + 1u; offset < 4105u; ++offset)
        EXPECT(vm_memory_access(&memory, offset, base, 8u, 2u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_memory_access(&memory, port_offset, base, 8u, 3u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    pages[1].rights = 1u;
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 4u, 9u) == 0);
    EXPECT(vm_memory_access(&memory, port_offset, base + 4094u, 8u, 2u, 0u) == MACHINE_RESULT_BARRIER);
    accept_request_metadata();
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    pages[1].rights = 3u;
    pages[2].rights = 2u;
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 4u, 9u) == 0);
    EXPECT(vm_memory_access(&memory, port_offset, base + 8192u, 8u, 1u, 0u) == MACHINE_RESULT_BARRIER);
    accept_request_metadata();
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    pages[2].rights = 3u;
    pl_u64 seed = 0x814137856cbeadcfull;
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 4u, 9u) == 0);
    for (pl_u32 i = 0u; i < 100000u; ++i) {
        seed ^= seed << 13u; seed ^= seed >> 7u; seed ^= seed << 17u;
        pl_u32 width = 1u << (i & 3u);
        pl_u32 offset = (pl_u32)(seed % (8192u - width + 1u));
        EXPECT(vm_memory_access(&memory, port_offset, base + offset, width, 2u, seed) == 0u);
        EXPECT(vm_memory_access(&memory, port_offset, base + offset, width, 1u, 0u) == 0u);
        EXPECT(read64(port_offset + 8u) == (width == 8u ? seed : seed & ((1ull << (width * 8u)) - 1u)));
    }
    /* Kernel-half addresses are coordinates, never truncated host offsets;
     * virtual aliases intentionally refer to the same resident physical page. */
    vm_memory_page aliases[] = { ram(base, 8192u), ram(0xffff800000001000ull, 8192u) };
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, aliases, 2u, 9u) == 0);
    EXPECT(vm_memory_access(&memory, port_offset, base, 8u, 2u, 0x8877665544332211ull) == 0u);
    EXPECT(vm_memory_access(&memory, port_offset, aliases[1].address, 8u, 1u, 0u) == 0u);
    EXPECT(read64(port_offset + 8u) == 0x8877665544332211ull);
    /* Revoked/rejected reopen clears old authority; it cannot keep using it. */
    pages[0].offset = 0u;
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 4u, 9u) != 0);
    EXPECT(!memory.bytes && !memory.generation);
    EXPECT(vm_memory_access(&memory, port_offset, base, 8u, 1u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    if (!failures) puts("resident RAM boundary: green (100000 round trips; not an MMU/boot)");
    return failures ? 1 : 0;
}
