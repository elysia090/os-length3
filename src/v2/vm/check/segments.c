#include <vm/segments.h>
#include <stdio.h>
#include <string.h>
#include <stddef.h>
static _Alignas(8) pl_u8 arena[32768];
static int failures;
static vm_memory_branch branches[3];
static vm_memory *physical;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr, "segments: line %u\n", (unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ if(physical&&at>=physical->reserved_bytes)EXPECT(!vm_memory_external_write(physical,at,8u));
  for (pl_u32 i = 0u; i < 8u; ++i) arena[at + i] = (pl_u8)(value >> (i * 8u)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 value = 0u; for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)arena[at + i] << (i * 8u); return value; }
static machine_state state, saved;
static machine_segments segments, old;
static void reset(pl_u32 cpl)
{
    if(physical)vm_memory_forget_walks(physical);
    state = (machine_state){0}; state.cr0 = 0x80010001u; state.cr3 = 0x1000u;
    state.cr4 = 32u; state.efer = 0x500u; state.rip = 0x1000204u;
    state.system[MACHINE_SYSTEM_CS] = 16u | cpl;
    state.system[MACHINE_SYSTEM_GDTR_BASE] = 0x4000u;
    state.system[MACHINE_SYSTEM_GDTR_LIMIT] = 31u;
    segments = (machine_segments){0}; segments.version = MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS].attributes = 0xa09bu;
    for (pl_u32 i = 0u; i < 8u; ++i) {
        if (i == MACHINE_SEGMENT_CS) continue;
        segments.cache[i] = (machine_segment_cache){0xabcdefu, 123u, MACHINE_SEGMENT_UNUSABLE};
    }
    memset(arena, 0, sizeof arena); put(0u, 9u);
    put(4096u, 0x2027u); put(8192u, 0x3027u); put(12288u, 0xe7u);
    saved = state; old = segments;
}
static void unchanged(pl_u32 rank)
{
    machine_state copy = state;
    copy.system[MACHINE_SYSTEM_ES + rank] = saved.system[MACHINE_SYSTEM_ES + rank];
    EXPECT(!memcmp(&copy, &saved, sizeof copy));
}
int main(void)
{
    vm_memory_page pages[4] = {
        {0x1000u,4096u,3u,VM_MEMORY_RAM,0u,0u},
        {0x2000u,8192u,3u,VM_MEMORY_RAM,0u,0u},
        {0x3000u,12288u,3u,VM_MEMORY_RAM,0u,0u},
        {0x4000u,16384u,3u,VM_MEMORY_RAM,0u,0u},
    };
    vm_memory memory;
    EXPECT(!vm_memory_open(&memory, arena, sizeof arena, 4096u, pages, 4u, 4u, branches, 9u));
    physical=&memory;
    /* Every null selector and CPL; null SS is legal only for CPL<3, RPL=CPL. */
    unsigned cases = 0u;
    for (pl_u32 cpl = 0u; cpl < 4u; ++cpl)
    for (pl_u32 selector = 0u; selector < 4u; ++selector)
    for (pl_u32 rank = 0u; rank < 6u; ++rank) {
        if (rank == MACHINE_SEGMENT_CS) continue;
        reset(cpl);
        int fault = rank == MACHINE_SEGMENT_SS && (cpl == 3u || selector != cpl);
        EXPECT(vm_segment_load(&memory, 0u, &state, &segments, rank, selector)
               == (fault ? machine_result_make(MACHINE_RESULT_FAULT,13u) : 0u));
        if (fault) {
            EXPECT(!memcmp(&state, &saved, sizeof state)); EXPECT(!memcmp(&segments, &old, sizeof old));
            EXPECT(get(16u) == state.rip && get(24u) == 13u);
        } else {
            EXPECT(state.system[MACHINE_SYSTEM_ES + rank] == selector);
            EXPECT(!segments.cache[rank].base && (segments.cache[rank].attributes & MACHINE_SEGMENT_UNUSABLE));
            EXPECT(segments.interrupt_shadow == (rank == MACHINE_SEGMENT_SS)); unchanged(rank);
        }
        ++cases;
    }
    /* Type and privilege failures precede present/Accessed-bit writes. */
    for (pl_u32 cpl = 0u; cpl < 4u; ++cpl)
    for (pl_u32 rpl = 0u; rpl < 4u; ++rpl)
    for (pl_u32 dpl = 0u; dpl < 4u; ++dpl)
    for (pl_u32 type = 0u; type < 32u; ++type)
    for (pl_u32 present = 0u; present < 2u; ++present)
    for (pl_u32 ss = 0u; ss < 2u; ++ss) {
        reset(cpl);
        pl_u32 rank = ss ? MACHINE_SEGMENT_SS : MACHINE_SEGMENT_DS;
        pl_u64 descriptor = 0x12ca00345678bcddull
            | ((pl_u64)(type | dpl * 32u | present * 128u) << 40u);
        put(16384u + 24u, descriptor);
        int code = !!(type & 8u), conforming = code && (type & 4u);
        int invalid = !(type & 16u) || (ss ? (code || !(type & 2u) || rpl != cpl || dpl != cpl)
                                           : ((code && !(type & 2u)) || (!conforming && (cpl > dpl || rpl > dpl))));
        pl_u32 vector = invalid ? 13u : !present ? (ss ? 12u : 11u) : 0u;
        EXPECT(vm_segment_load(&memory, 0u, &state, &segments, rank, 24u | rpl)
               == (vector ? machine_result_make(MACHINE_RESULT_FAULT,vector) : 0u));
        if (vector) {
            EXPECT(!memcmp(&state, &saved, sizeof state)); EXPECT(!memcmp(&segments, &old, sizeof old));
            EXPECT(get(24u) == ((pl_u64)24u << 32u | vector));
            EXPECT(get(16384u + 24u) == descriptor);
        } else {
            EXPECT(state.system[MACHINE_SYSTEM_ES + rank] == (24u | rpl));
            EXPECT(segments.cache[rank].base == 0x12345678u);
            EXPECT(segments.cache[rank].limit == 0xabcddfffu);
            EXPECT(get(16384u + 24u) == (descriptor | 1ull << 40u)); unchanged(rank);
        }
        ++cases;
    }
    reset(0u); put(16384u + 24u, 0x00cf92000000ffffull);
    /* A-clear descriptor on a guest read-only page faults before cache commit. */
    put(12288u, 0xe5u); memory.write_touched = 0u;
    EXPECT(vm_segment_load(&memory, 0u, &state, &segments, MACHINE_SEGMENT_DS,24u)
           == machine_result_make(MACHINE_RESULT_FAULT,14u));
    EXPECT(!memcmp(&state, &saved, sizeof state) && !memcmp(&segments, &old, sizeof old));
    EXPECT(get(24u) == (3ull << 32u | 14u));
    /* An already-accessed descriptor needs no guest write on a read-only page. */
    reset(3u); put(12288u,0xe5u); put(16384u + 24u,0x00cff3000000ffffull);
    memory.write_touched = 0u;
    EXPECT(!vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_FS,27u));
    EXPECT(!memory.write_touched && segments.cache[MACHINE_SEGMENT_FS].limit == 0xffffffffu);
    /* LDT bounds/type and supervisor page permissions are independent of CPL. */
    reset(3u); segments.cache[MACHINE_SEGMENT_LDTR] = (machine_segment_cache){0x4000u,31u,0x82u};
    put(16384u + 24u,0x12caf3345678bcddull);
    EXPECT(!vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_GS,31u));
    EXPECT(segments.cache[MACHINE_SEGMENT_GS].base == 0x12345678u);
    segments.cache[MACHINE_SEGMENT_LDTR].limit = 30u; old = segments; saved = state;
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_GS,31u) == 107u);
    EXPECT(get(24u) == (28ull << 32u | 13u));
    EXPECT(!memcmp(&state,&saved,sizeof state) && !memcmp(&segments,&old,sizeof old));
    reset(0u); state.system[MACHINE_SYSTEM_GDTR_BASE] = 0x7fffffffffe0ull; saved = state;
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_DS,24u) == 115u);
    EXPECT(!memcmp(&state,&saved,sizeof state) && !memcmp(&segments,&old,sizeof old));
    state.system[MACHINE_SYSTEM_GDTR_BASE] += 1u; saved = state;
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_DS,24u) == 107u);
    EXPECT(get(24u) == (24ull << 32u | 13u));
    reset(0u); put(12288u,0xe7u); pages[3].kind = VM_MEMORY_DEFERRED;
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_DS,24u) == 2u);
    EXPECT(!memcmp(&state,&saved,sizeof state) && !memcmp(&segments,&old,sizeof old));
    pages[3].kind = VM_MEMORY_RAM;
    reset(0u); state.system[MACHINE_SYSTEM_GDTR_LIMIT] = 30u; saved = state;
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_DS,24u) == 107u);
    EXPECT(!memcmp(&state,&saved,sizeof state) && !memcmp(&segments,&old,sizeof old));
    reset(0u); EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_DS,12u) == 107u);
    reset(0u); segments.version = 0u;
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_DS,0u) == 6u);
    reset(0u); put(0u,8u);
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,MACHINE_SEGMENT_DS,0u) == 5u);
    if (failures) return 1;
    printf("Long-mode segment load: %u selector/type/privilege cases green; exception entry NOT tested\n", cases);
    return 0;
}
