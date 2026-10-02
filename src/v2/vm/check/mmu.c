#include <vm/mmu.h>
#include <stdio.h>
#include <string.h>

static _Alignas(8) pl_u8 arena[65536], saved[65536];
static vm_memory memory;
static vm_memory_page pages[6];
static pl_u32 entries[4];
static const pl_u64 base = 0x400000u;
static const pl_u32 port = 2048u;
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr, "mmu: line %u\n", (unsigned)__LINE__); ++failures; } } while (0)

static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 i = 0u; i < 8u; ++i) arena[at + i] = (pl_u8)(value >> (8u * i)); }
static pl_u64 get(pl_u32 at)
{
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)arena[at + i] << (8u * i);
    return value;
}
static vm_mmu_context context(void)
{ return (vm_mmu_context){ 0x80010001ull, 0x1000u, 32u, 0xd00u, 0u }; }
static void reset(pl_u64 address)
{
    const pl_u32 shifts[] = {39u, 30u, 21u, 12u};
    memset(arena, 0, sizeof arena); put(port, 9u);
    for (pl_u32 i = 0u; i < 4u; ++i) {
        pages[i] = (vm_memory_page){ (i + 1ull) * 4096u, (i + 2u) * 4096u,
                                     3u, VM_MEMORY_RAM, 0u, 0u };
        entries[i] = pages[i].offset + (pl_u32)((address >> shifts[i]) & 511u) * 8u;
        put(entries[i], (i == 3u ? 0x8000u : (i + 2ull) * 4096u) | 7u);
    }
    pages[4] = (vm_memory_page){0x8000u, 28672u, 3u, VM_MEMORY_RAM, 0u, 0u};
    pages[5] = (vm_memory_page){0x9000u, 32768u, 3u, VM_MEMORY_RAM, 0u, 0u};
    put(entries[3] + 8u, 0x9007u);
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 6u, 9u) == 0);
}
static machine_result access(vm_mmu_context *cpu, pl_u64 address, pl_u32 bytes, pl_u32 flags, pl_u64 value)
{ return vm_mmu_access(&memory, port, cpu, address, bytes, flags, value); }
static void expect_fault(machine_result result, pl_u64 address, pl_u32 vector, pl_u32 error)
{
    EXPECT(machine_result_kind(result) == MACHINE_RESULT_FAULT);
    EXPECT(machine_result_payload(result) == vector);
    EXPECT(get(port + 16u) == address);
    EXPECT(get(port + 24u) == ((pl_u64)error << 32u | vector));
}

int main(void)
{
    vm_mmu_context cpu = context(); reset(base);
    EXPECT(access(&cpu, base + 4093u, 8u, 2u, 0x8877665544332211ull) == 0u);
    EXPECT(arena[28672u + 4093u] == 0x11u && arena[32768u] == 0x44u);
    EXPECT(access(&cpu, base + 4093u, 8u, 1u, 0u) == 0u);
    EXPECT(get(port + 8u) == 0x8877665544332211ull);
    for (pl_u32 i = 0u; i < 4u; ++i) EXPECT(get(entries[i]) & 32u);
    EXPECT((get(entries[3]) & 96u) == 96u && (get(entries[3] + 8u) & 96u) == 96u);

    reset(base); put(entries[3] + 8u, 0u); memset(arena + 28672u, 0xa5, 8192u);
    memcpy(saved, arena, sizeof arena);
    expect_fault(access(&cpu, base + 4093u, 8u, 2u, 0u), base + 4096u, 14u, 2u);
    EXPECT(memcmp(saved + 28672u, arena + 28672u, 8192u) == 0);
    EXPECT(get(entries[0]) & 32u); /* Ancestor A is an architectural side effect. */
    EXPECT(get(port + 8u) == 0u);

    reset(base); pages[1].kind = VM_MEMORY_DEFERRED;
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_BARRIER);
    EXPECT(get(port + 32u) == 0x2000u);
    EXPECT(get(port + 40u) == ((pl_u64)17u << 32u | 8u));
    EXPECT(get(port + 24u) == 0u); /* A host miss does not manufacture #PF. */
    reset(base); pages[0].rights = 1u;
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_BARRIER);
    EXPECT(get(port + 40u) == ((pl_u64)18u << 32u | 8u));
    EXPECT(!(get(entries[0]) & 32u));
    reset(base); pages[4].kind = VM_MEMORY_DEFERRED;
    EXPECT(access(&cpu, base + 7u, 4u, 1u, 0u) == MACHINE_RESULT_BARRIER);
    EXPECT(get(port + 32u) == 0x8007u && get(port + 40u) == ((pl_u64)17u << 32u | 4u));

    reset(base); put(entries[0], get(entries[0]) | (1ull << 40u));
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 9u);
    reset(base); put(entries[1], get(entries[1]) | 128u);
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 9u); /* Unexposed 1 GiB. */
    reset(base); cpu.efer &= ~(1ull << 11u); put(entries[3], get(entries[3]) | (1ull << 63u));
    expect_fault(access(&cpu, base, 8u, 9u, 0u), base, 14u, 9u);
    reset(base); put(entries[0], 1ull << 40u);
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 0u); /* Not-present first. */

    cpu = context(); reset(base); put(entries[2], 0x200083u); pages[5].address = 0x200000u;
    EXPECT(vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 6u, 9u) == 0);
    EXPECT(access(&cpu, base + 256u, 8u, 2u, 0x1234u) == 0u);
    EXPECT(get(32768u + 256u) == 0x1234u && (get(entries[2]) & 96u) == 96u);
    put(entries[2], 0x202083u);
    expect_fault(access(&cpu, base, 8u, 1u, 0u), base, 14u, 9u);
    reset(base); cpu = context();
    expect_fault(access(&cpu, 0x800000000000ull, 8u, 1u, 0u), 0x800000000000ull, 13u, 0u);
    expect_fault(access(&cpu, ~0ull, 2u, 5u, 0u), ~0ull, 12u, 0u);
    cpu.cr4 |= 1ull << 12u;
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    cpu = context(); cpu.efer &= ~0x100ull; memcpy(saved, arena, sizeof arena);
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    cpu = context(); cpu.cr4 |= 128u; put(entries[3], get(entries[3]) | 256u);
    EXPECT(access(&cpu, base, 8u, 1u, 0u) == 0u); /* PGE/global, no cached TLB. */
    cpu = context(); put(port, 8u); memcpy(saved, arena, sizeof arena);
    EXPECT(access(&cpu, base, 8u, 2u, 0u) == MACHINE_RESULT_STALE_GENERATION);
    EXPECT(memcmp(saved, arena, sizeof arena) == 0);
    reset(0xffff800000400000ull);
    EXPECT(access(&cpu, 0xffff800000400000ull, 8u, 2u, 0x1234u) == 0u);
    EXPECT(get(28672u) == 0x1234u);

    /* Exhaustive permissions meet over all four levels, both privilege
     * classes, supervisor WP settings and read/write/execute directions. */
    pl_u32 comparisons = 0u;
    for (pl_u32 pattern = 0u; pattern < 4096u; ++pattern)
        for (pl_u32 direction = 0u; direction < 3u; ++direction)
            for (pl_u32 mode = 0u; mode < 4u; ++mode) {
                reset(base); cpu = context();
                cpu.cpl = mode & 1u ? 3u : 0u;
                if (!(mode & 2u)) cpu.cr0 &= ~0x10000ull;
                int all_user = 1, all_write = 1, any_nx = 0;
                for (pl_u32 level = 0u; level < 4u; ++level) {
                    pl_u32 bits = (pattern >> (level * 3u)) & 7u;
                    pl_u64 entry = get(entries[level]) & ~6ull;
                    if (bits & 1u) entry |= 4u; else all_user = 0;
                    if (bits & 2u) entry |= 2u; else all_write = 0;
                    if (bits & 4u) { entry |= 1ull << 63u; any_nx = 1; }
                    put(entries[level], entry);
                }
                pl_u32 flags = direction == 0u ? 1u : direction == 1u ? 2u : 9u;
                int denied = (cpu.cpl == 3u && !all_user)
                           || (direction == 1u && !all_write && (cpu.cpl == 3u || (mode & 2u)))
                           || (direction == 2u && any_nx);
                machine_result result = access(&cpu, base, 8u, flags, 0x1234u);
                if (denied) expect_fault(result, base, 14u,
                    1u | (direction == 1u ? 2u : 0u) | (cpu.cpl == 3u ? 4u : 0u)
                       | (direction == 2u ? 16u : 0u));
                else EXPECT(result == 0u);
                ++comparisons;
            }
    if (!failures) printf("four-level MMU: green (%u permission cases; no CPU fault delivery/boot oracle)\n", comparisons);
    return failures ? 1 : 0;
}
