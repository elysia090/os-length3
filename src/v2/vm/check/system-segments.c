#include <vm/segments.h>
#include <stdio.h>
#include <string.h>
#include <stddef.h>
static _Alignas(8) pl_u8 arena[32768];
static vm_memory memory;
static vm_memory_page pages[6];
static vm_memory_branch branches[5];
static machine_state state, before;
static machine_segments segments, hidden;
static unsigned failures, cases, writes;
#define EXPECT(x) do { if (!(x)) { if (failures < 12u) fprintf(stderr,"system segment: %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) arena[at+i]=(pl_u8)(value>>(8u*i)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 value=0u; for (pl_u32 i=0u;i<8u;++i) value|=(pl_u64)arena[at+i]<<(8u*i); return value; }
static void observe(void *owner, pl_u32 offset, pl_u32 bytes)
{ (void)owner; if (offset>=20480u) { EXPECT(bytes<=16u); ++writes; } }
static void reset(pl_u32 cpl, pl_u32 offset)
{
    memset(arena,0,sizeof arena); put(0u,9u);
    for (pl_u32 i=0u;i<6u;++i) pages[i]=(vm_memory_page){(i+1u)*4096u,(i+1u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u));
    put(4096u,0x2023u); put(8192u,0x3023u); put(12288u,0x4023u);
    put(16384u+5u*8u,0x5063u); put(16384u+6u*8u,0x6063u);
    state=(machine_state){0}; state.rip=0x400000u; state.rflags=0x8d7u;
    state.cr0=0x80010001u; state.cr3=0x1000u; state.cr4=32u; state.efer=0xd00u;
    state.system[MACHINE_SYSTEM_CS]=8u|cpl;
    state.system[MACHINE_SYSTEM_GDTR_BASE]=0x5000u+offset-24u;
    state.system[MACHINE_SYSTEM_GDTR_LIMIT]=39u;
    segments=(machine_segments){0}; segments.version=MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu;
    segments.cache[MACHINE_SEGMENT_LDTR]=(machine_segment_cache){123u,45u,0x82u};
    segments.cache[MACHINE_SEGMENT_TR]=(machine_segment_cache){567u,89u,0x89u};
    before=state; hidden=segments; writes=0u; memory.before_write=observe;
}
static void unchanged(void)
{ EXPECT(!memcmp(&state,&before,sizeof state)); EXPECT(!memcmp(&segments,&hidden,sizeof segments)); }
static void run(pl_u32 rank, pl_u32 selector, pl_u32 vector, pl_u32 error)
{
    machine_result result=vm_segment_load(&memory,0u,&state,&segments,rank,selector);
    EXPECT(result==(vector ? machine_result_make(MACHINE_RESULT_FAULT,vector) : 0u));
    if (vector) { unchanged(); EXPECT(get(24u)==((pl_u64)error<<32u|vector)); EXPECT(!writes); }
    ++cases;
}
int main(void)
{
    /* CPL is checked before null/TI and descriptor reads. DPL/RPL are not
     * access gates for these privileged system-selector loads. */
    for (pl_u32 cpl=0u;cpl<4u;++cpl) for (pl_u32 rpl=0u;rpl<4u;++rpl)
    for (pl_u32 dpl=0u;dpl<4u;++dpl) for (pl_u32 type=0u;type<32u;++type)
    for (pl_u32 present=0u;present<2u;++present) for (pl_u32 rank=6u;rank<8u;++rank) {
        reset(cpl,64u);
        pl_u64 low=0x120000345678bcddull|((pl_u64)(type|dpl*32u|present*128u)<<40u);
        put(20480u+64u,low); put(20480u+72u,0xffff8000u);
        pl_u32 vector=cpl || type!=(rank==6u ? 2u : 9u) ? 13u : !present ? 11u : 0u;
        run(rank,24u|rpl,vector,cpl ? 0u : 24u);
        EXPECT(get(20480u+64u)==(low|(!vector && rank==7u ? 2ull<<40u : 0u)));
        if (!vector) {
            EXPECT(state.system[MACHINE_SYSTEM_ES+rank]==(24u|rpl));
            EXPECT(segments.cache[rank].base==0xffff800012345678ull);
            EXPECT(segments.cache[rank].limit==0xbcddu);
            EXPECT(segments.cache[rank].attributes==(type|dpl*32u|128u|(rank==7u ? 2u : 0u)));
            state.system[MACHINE_SYSTEM_ES+rank]=before.system[MACHINE_SYSTEM_ES+rank];
            segments.cache[rank]=hidden.cache[rank]; unchanged();
            EXPECT(writes==(rank==7u));
        }
    }
    for (pl_u32 cpl=0u;cpl<4u;++cpl) for (pl_u32 selector=0u;selector<8u;++selector)
    for (pl_u32 rank=6u;rank<8u;++rank) {
        reset(cpl,64u); pl_u32 vector=cpl || rank==7u || (selector&4u) ? 13u : 0u;
        run(rank,selector,vector,cpl || selector<4u ? 0u : 4u);
        if (!vector) EXPECT(segments.cache[rank].attributes==MACHINE_SEGMENT_UNUSABLE);
    }
    /* Whole descriptor bounds, then low type/present, then the upper type.
     * No upper-page #PF is allowed to mask a low-half #GP/#NP. */
    for (pl_u32 rank=6u;rank<8u;++rank) for (pl_u32 mode=0u;mode<6u;++mode) {
        reset(0u,4088u); pl_u64 low=(pl_u64)(rank==6u ? 0x82u : 0x89u)<<40u;
        if (mode==0u) state.system[MACHINE_SYSTEM_GDTR_LIMIT]=38u;
        if (mode==1u) low=0x90ull<<40u;
        if (mode==2u) low&=~(128ull<<40u);
        put(20480u+4088u,low);
        if (mode<4u) put(16384u+48u,0u);
        if (mode==4u) put(24576u,1ull<<40u);
        if (mode==5u) put(16384u+48u,0x6061u);
        before=state;
        pl_u32 vector=mode==2u ? 11u : mode==3u || (mode==5u && rank==7u) ? 14u : mode==5u ? 0u : 13u;
        run(rank,24u,vector,vector==14u ? (mode==5u ? 3u : 0u) : 24u);
    }
    /* A host residency wait does not publish TR, change the busy bit, or
     * leave a writable reservation. Retrying the same pinned inputs retires
     * the descriptor update once. Guest page-walk A/D effects may persist. */
    reset(0u,4088u); put(20480u+4088u,0x89ull<<40u); pages[5].kind=VM_MEMORY_DEFERRED;
    EXPECT(vm_segment_load(&memory,0u,&state,&segments,7u,24u)==2u); unchanged();
    EXPECT(!writes && !memory.reservation.parts);
    pages[5].kind=VM_MEMORY_RAM;
    EXPECT(!vm_segment_load(&memory,0u,&state,&segments,7u,24u)); EXPECT(writes==2u);
    before=state; hidden=segments; writes=0u; run(7u,24u,13u,24u);
    reset(0u,64u); put(0u,8u); EXPECT(vm_segment_load(&memory,0u,&state,&segments,7u,24u)==5u); unchanged();
    /* Record reservation is bounded, all-or-nothing, and cannot be committed
     * by the old scalar API or after a mismatched generation/record size. */
    vm_mmu_context context={0x80010001u,0x1000u,32u,0xd00u,0u};
    for (pl_u32 mode=0u;mode<5u;++mode) {
        reset(0u,4088u); pl_u8 record[16]; memset(record,0x5a,sizeof record);
        if (!mode) {
            put(16384u+48u,0x6061u);
            EXPECT(vm_mmu_reserve_record(&memory,0u,&context,0x5ff8u,16u,record)==115u);
            for (pl_u32 i=0u;i<16u;++i) EXPECT(record[i]==0x5au);
            EXPECT(!memory.reservation.parts);
        } else {
            EXPECT(!vm_mmu_reserve_record(&memory,0u,&context,0x5ff8u,16u,record));
            memset(record,0x5a,sizeof record);
            if (mode==1u) EXPECT(vm_memory_commit(&memory,0u,123u)==6u);
            if (mode==2u) EXPECT(vm_memory_commit_record(&memory,0u,record,8u)==6u);
            if (mode==3u) { put(0u,8u); EXPECT(vm_memory_commit_record(&memory,0u,record,16u)==5u); }
            if (mode==4u) { vm_memory_abort(&memory); EXPECT(vm_memory_commit_record(&memory,0u,record,16u)==6u); }
            EXPECT(!memory.reservation.parts);
            for (pl_u32 i=0u;i<16u;++i) EXPECT(arena[24568u+i]==0u);
        }
        EXPECT(!writes); ++cases;
    }
    if (failures) { fprintf(stderr,"%u failures / %u models\n",failures,cases); return 1; }
    printf("System descriptor loads: %u models green; no task switch or SMP claim\n",cases);
    return 0;
}
