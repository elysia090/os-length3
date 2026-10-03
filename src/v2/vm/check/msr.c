/* Independent Intel SDM register model; system-mode oracle is separate. */
#include <vm/msr.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[8192];
static machine_state state;
static machine_segments segments;
static unsigned failures, cases;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"msr: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 i = 0u; i < 8u; ++i) arena[at+i] = (pl_u8)(value >> (i*8u)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 value = 0u; for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)arena[at+i] << (i*8u); return value; }
static void reset(pl_u32 cpl)
{
    memset(arena,0,sizeof arena); put(0u,9u);
    state = (machine_state){0}; state.cr0 = 0x80010011u; state.cr3 = 0x1000u;
    state.cr4 = 32u; state.efer = 0x500u; state.rip = 0x1000255u; state.rflags = 0x10202u;
    state.system[MACHINE_SYSTEM_CS] = 16u | cpl; state.retired = 28u;
    segments = (machine_segments){0}; segments.version = MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS].attributes = 0xa09bu;
    segments.cache[MACHINE_SEGMENT_FS] = (machine_segment_cache){0x123456u,123u,0x10000u};
    segments.cache[MACHINE_SEGMENT_GS] = (machine_segment_cache){0xffff800012340000ull,456u,0xc093u};
}
static void check(vm_memory *memory, pl_u32 key, pl_u64 value, int invalid)
{
    machine_state wanted = state;
    machine_segments hidden = segments;
    EXPECT(vm_msr_transfer(memory,0u,&state,&segments,MACHINE_MSR_WRITE,key,value)
        == (invalid ? machine_result_make(MACHINE_RESULT_FAULT,13u) : 0u));
    if (!invalid) {
        if (key == MACHINE_MSR_EFER) wanted.efer = (value & ~0x400ull) | 0x400u;
        else if (key == MACHINE_MSR_FS_BASE) hidden.cache[MACHINE_SEGMENT_FS].base = value;
        else if (key == MACHINE_MSR_GS_BASE) hidden.cache[MACHINE_SEGMENT_GS].base = value;
        else {
            wanted.msr_count = 1u; wanted.msr_keys[0] = key; wanted.msr_values[0] = value;
        }
        EXPECT(!vm_msr_transfer(memory,0u,&state,&segments,MACHINE_MSR_READ,key,0u));
        EXPECT(get(8u) == (key == MACHINE_MSR_EFER ? wanted.efer : value));
    } else EXPECT(get(16u) == state.rip && get(24u) == 13u);
    EXPECT(!memcmp(&state,&wanted,sizeof state)); EXPECT(!memcmp(&segments,&hidden,sizeof hidden));
    ++cases;
}
int main(void)
{
    vm_memory memory;
    vm_memory_page page = {0x1000u,4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,&page,1u,1u,NULL,9u));
    const pl_u32 keys[] = {MACHINE_MSR_EFER,MACHINE_MSR_FS_BASE,MACHINE_MSR_GS_BASE,MACHINE_MSR_KERNEL_GS_BASE};
    const pl_u64 boundaries[] = {0u,1u,0x7fffffffffffull,0x800000000000ull,
        0xffff7fffffffffffull,0xffff800000000000ull,~0ull};
    for (pl_u32 cpl = 0u; cpl < 4u; ++cpl)
    for (pl_u32 k = 0u; k < 4u; ++k)
    for (pl_u32 n = 0u; n < 71u; ++n) {
        reset(cpl); pl_u64 value = n < 64u ? 1ull << n : boundaries[n-64u];
        if (!k) value |= 0x100u;
        int invalid = cpl != 0u || (!k ? !!(value & ~0xd01ull)
            : !(value >> 47u == 0u || value >> 47u == 0x1ffffu));
        check(&memory,keys[k],value,invalid);
    }
    for (pl_u32 bits = 0u; bits < 16u; ++bits) {
        reset(0u);
        /* The selected four bits are SCE/LME/LMA/NXE. */
        pl_u64 value = (bits & 1u) | ((bits & 2u) ? 0x100u : 0u)
            | ((bits & 4u) ? 0x400u : 0u) | ((bits & 8u) ? 0x800u : 0u);
        check(&memory,MACHINE_MSR_EFER,value,!(value & 0x100u));
    }
    reset(0u); EXPECT(!vm_msr_transfer(&memory,0u,&state,&segments,0u,MACHINE_MSR_KERNEL_GS_BASE,0u));
    EXPECT(!get(8u) && !state.msr_count);
    const pl_u32 unknown[] = {0u,0xffffffffu,0xc0000103u,0x10u,0x174u};
    for (pl_u32 key = 0u; key < 5u; ++key) for (pl_u32 op = 0u; op < 2u; ++op) {
        reset(0u); machine_state before = state; machine_segments hidden = segments;
        EXPECT(vm_msr_transfer(&memory,0u,&state,&segments,op,unknown[key],0u) == 107u);
        EXPECT(!memcmp(&before,&state,sizeof state) && !memcmp(&hidden,&segments,sizeof hidden));
    }
    for (pl_u32 cpl = 0u; cpl < 4u; ++cpl) {
        reset(cpl); machine_state before = state; machine_segments hidden = segments;
        EXPECT(vm_msr_transfer(&memory,0u,&state,&segments,2u,0u,0u) == (cpl ? 107u : 0u));
        if (!cpl) {
            EXPECT(!segments.cache[MACHINE_SEGMENT_GS].base);
            EXPECT(state.msr_values[0] == hidden.cache[MACHINE_SEGMENT_GS].base);
            EXPECT(!vm_msr_transfer(&memory,0u,&state,&segments,2u,0u,0u));
            before.msr_count = 1u; before.msr_keys[0] = MACHINE_MSR_KERNEL_GS_BASE;
        }
        EXPECT(!memcmp(&before,&state,sizeof state) && !memcmp(&hidden,&segments,sizeof hidden));
    }
    for (pl_u32 bad = 0u; bad < 7u; ++bad) {
        reset(0u);
        if (!bad) state.msr_count = 33u;
        if (bad == 1u) { state.msr_count = 1u; state.msr_keys[0] = MACHINE_MSR_GS_BASE; }
        if (bad == 2u) { state.msr_count = 1u; state.msr_keys[0] = MACHINE_MSR_KERNEL_GS_BASE; state.msr_values[0] = 1ull << 47u; }
        if (bad == 3u) state.rflags |= 0x100u;
        if (bad == 4u) state.efer |= 2u;
        if (bad == 5u) segments.cache[MACHINE_SEGMENT_FS].base = 1ull << 47u;
        if (bad == 6u) segments.cache[MACHINE_SEGMENT_GS].base = 1ull << 47u;
        machine_state before = state; machine_segments hidden = segments;
        EXPECT(vm_msr_transfer(&memory,0u,&state,&segments,1u,MACHINE_MSR_GS_BASE,0u) == MACHINE_RESULT_ENTRY_MAP);
        EXPECT(!memcmp(&before,&state,sizeof state) && !memcmp(&hidden,&segments,sizeof hidden));
    }
    reset(0u); put(0u,8u); machine_state before = state; machine_segments hidden = segments;
    memory.reservation = (vm_memory_reservation){9u,0u,1u,{4096u,0u},{8u,0u}};
    EXPECT(vm_msr_transfer(&memory,0u,&state,&segments,1u,MACHINE_MSR_GS_BASE,0u) == MACHINE_RESULT_STALE_GENERATION);
    EXPECT(!memory.reservation.parts && !memcmp(&before,&state,sizeof state) && !memcmp(&hidden,&segments,sizeof hidden));
    if (failures) return 1;
    printf("MSR: %u privilege/value model cases, precise refusal, reset and SWAPGS green; no hardware fault-entry claim\n",cases);
    return 0;
}
