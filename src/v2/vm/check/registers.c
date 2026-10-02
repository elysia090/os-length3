/* Intel SDM control-write model; not a CPL0 hardware exception oracle. */
#include <vm/registers.h>
#include <x86/profile.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[8192];
static machine_state state, before;
static machine_segments segments, old;
static unsigned failures, cases;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"registers: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 i = 0u; i < 8u; ++i) arena[at + i] = (pl_u8)(value >> (i * 8u)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 value = 0u; for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)arena[at + i] << (i * 8u); return value; }
static void reset(pl_u32 cpl)
{
    memset(arena,0,sizeof arena); put(0u,9u);
    state = (machine_state){0}; state.cr0 = 0x80010011u; state.cr3 = 0x1000u;
    state.cr4 = 32u; state.efer = 0x500u; state.rip = 0x1000255u; state.rflags = 2u;
    state.system[MACHINE_SYSTEM_CS] = 16u | cpl; state.retired = 28u;
    segments = (machine_segments){0}; segments.version = MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS].attributes = 0xa09bu;
    before = state; old = segments;
}
static void check(vm_memory *memory, pl_u32 rank, pl_u64 input, pl_u64 expected, int invalid)
{
    EXPECT(vm_control_write(memory,0u,&state,&segments,rank,input)
        == (invalid ? machine_result_make(MACHINE_RESULT_FAULT,13u) : 0u));
    machine_state wanted = before;
    if (!invalid) {
        if (rank == 0u) wanted.cr0 = expected;
        else if (rank == 2u) wanted.system[MACHINE_SYSTEM_CR2] = expected;
        else if (rank == 3u) wanted.cr3 = expected;
        else if (rank == 4u) wanted.cr4 = expected;
        else wanted.system[MACHINE_SYSTEM_CR8] = expected;
    } else {
        EXPECT(get(16u) == before.rip && get(24u) == 13u);
    }
    EXPECT(!memcmp(&state,&wanted,sizeof state)); EXPECT(!memcmp(&segments,&old,sizeof old));
    ++cases;
}
int main(void)
{
    vm_memory memory;
    vm_memory_page page = {0x1000u,4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,&page,1u,1u,NULL,9u));
    pl_x86_cpuid_result basic = pl_x86_profile_cpuid(1u,0u);
    /* TSD/PCE are architectural. The remaining exposed CR4 bits require
     * PSE/PAE/PGE/FXSR/SSE. Unsupported extension words must remain zero. */
    pl_u64 visible = (1u << 2u) | (1u << 8u);
    if (basic.edx & (1u << 1u)) visible |= 3u;
    if (basic.edx & (1u << 2u)) visible |= 1u << 3u;
    if (basic.edx & (1u << 3u)) visible |= 1u << 4u;
    if (basic.edx & (1u << 6u)) visible |= 1u << 5u;
    if (basic.edx & (1u << 7u)) visible |= 1u << 6u;
    if (basic.edx & (1u << 13u)) visible |= 1u << 7u;
    if (basic.edx & (1u << 24u)) visible |= 1u << 9u;
    if (basic.edx & (1u << 25u)) visible |= 1u << 10u;
    EXPECT(visible == VM_CPU_CR4_VISIBLE);
    EXPECT(!PL_X86_CPUID_7_0_EBX && !PL_X86_CPUID_7_0_ECX && !PL_X86_CPUID_7_0_EDX);
    EXPECT(!(basic.ecx & ((1u << 5u) | (1u << 6u) | (1u << 17u) | (1u << 26u))));
    EXPECT((PL_X86_CPUID_80000008_EAX & 255u) == VM_CPU_PHYSICAL_BITS);
    static const pl_u32 ranks[] = {0u,2u,3u,4u,8u};
    for (pl_u32 r = 0u; r < 5u; ++r) for (pl_u32 bit = 0u; bit < 64u; ++bit) {
        pl_u32 rank = ranks[r]; pl_u64 value = 1ull << bit, expected = value; int invalid = 0;
        reset(0u);
        if (!rank) {
            value |= 0x80000001u; expected = (value & 0xe005003full) | 16u;
            invalid = bit >= 32u || bit == 29u;
        } else if (rank == 3u) {
            expected &= ~0xfe7ull; invalid = bit >= 40u;
        } else if (rank == 4u) {
            value |= 32u; expected = value; invalid = !(VM_CPU_CR4_VISIBLE & (1ull << bit));
        } else if (rank == 8u) invalid = bit >= 4u;
        check(&memory,rank,value,expected,invalid);
    }
    /* Values cover ET forcing, ignored CR0/CR3 bits, NW+CD, no-flush bit,
     * noncanonical CR2, all legal CR4 subsets and every task-priority value. */
    for (pl_u32 flags = 0u; flags < 128u; ++flags) {
        reset(0u); pl_u64 value = 32u;
        static const pl_u32 bits[] = {2u,4u,5u,7u,8u,9u,10u};
        for (pl_u32 i = 0u; i < 7u; ++i) if (flags & (1u << i)) value |= 1ull << bits[i];
        check(&memory,4u,value,value,0);
    }
    reset(0u); check(&memory,0u,0xffffffffu,0xe005003fu,0);
    reset(0u); check(&memory,0u,0x80000001u,0x80000011u,0);
    reset(0u); check(&memory,0u,0x80000000u,0u,1);
    reset(0u); check(&memory,0u,0x11u,0u,1);
    reset(0u); check(&memory,4u,0u,0u,1);
    reset(0u); check(&memory,3u,0x12345fffull,0x12345018ull,0);
    reset(0u); check(&memory,2u,0x8000000000000001ull,0x8000000000000001ull,0);
    for (pl_u32 value = 0u; value < 16u; ++value) { reset(0u); check(&memory,8u,value,value,0); }
    for (pl_u32 cpl = 1u; cpl < 4u; ++cpl) for (pl_u32 r = 0u; r < 5u; ++r) {
        reset(cpl); check(&memory,ranks[r],ranks[r] == 4u ? 32u : 0u,0u,1);
    }
    reset(0u); put(0u,8u);
    EXPECT(vm_control_write(&memory,0u,&state,&segments,4u,32u) == MACHINE_RESULT_STALE_GENERATION);
    EXPECT(!memcmp(&state,&before,sizeof state));
    put(0u,9u);
    memory.reservation = (vm_memory_reservation){9u,0u,1u,{4096u,0u},{8u,0u}};
    EXPECT(vm_control_write(&memory,0u,&state,&segments,1u,0u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(!memory.reservation.parts);
    EXPECT(vm_memory_commit(&memory,0u,42u) == MACHINE_RESULT_ENTRY_MAP);
    EXPECT(!memcmp(&state,&before,sizeof state));
    if (failures) return 1;
    printf("Control writes: %u privilege/bit/normalization model cases green; no hardware fault-entry claim\n",cases);
    return 0;
}
