#include <vm/source.h>
#include <stdio.h>
#include <string.h>
static vm_sources sources;
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"source: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static vm_code_page page = {0x400000u,9u,8192u,4096u};
static vm_execution_row row;
static void put(pl_u8 *bytes, pl_u32 at, pl_u64 value)
{ for (pl_u32 i = 0u; i < 8u; ++i) bytes[at+i] = (pl_u8)(value >> (i*8u)); }
static void mmu_alias(void)
{
    static _Alignas(8) pl_u8 ram[32768]; vm_memory memory;
    vm_memory_page pages[4]; vm_memory_branch branches[3];
    memset(ram,0,sizeof ram); put(ram,0u,9u);
    for (pl_u32 i = 0u; i < 4u; ++i)
        pages[i] = (vm_memory_page){(i+1ull)*4096u,(i+2u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
    put(ram,8192u,0x2007u); put(ram,8200u,0x2007u);
    put(ram,12288u,0x3007u); put(ram,16384u,0x4007u);
    put(ram,16400u,0x4007u); put(ram,20480u,0x1007u);
    EXPECT(!vm_memory_open(&memory,ram,sizeof ram,4096u,pages,4u,4u,branches,9u));
    vm_sources_open(&sources,9u,3u);
    memory.before_write = vm_sources_write; memory.write_owner = &sources;
    vm_mmu_context cpu = {0x80010001u,0x1000u,32u,0xd00u,0u};
    vm_code_page code;
    EXPECT(!vm_mmu_code_page(&memory,0u,&cpu,0x400008u,&code));
    EXPECT(code.offset == 8192u); /* Guest code physically aliases its PML4. */
    EXPECT(vm_sources_probe(&sources,&code,0x400008u,1u,&row) == 1);
    EXPECT(!vm_sources_publish(&sources,8u,1u,&row));
    /* A on another virtual path touches that source before a later #PF. */
    EXPECT(machine_result_kind(vm_mmu_access(&memory,0u,&cpu,0x8000001000ull,1u,9u,0u)) == MACHINE_RESULT_FAULT);
    EXPECT(vm_sources_probe(&sources,&code,0x400008u,1u,&row) == 1);
    EXPECT(!vm_sources_publish(&sources,8u,1u,&row));
    EXPECT(!vm_mmu_reserve(&memory,0u,&cpu,0x400008u,8u,3u));
    EXPECT(!vm_memory_commit(&memory,0u,0x2007u));
    EXPECT(vm_sources_probe(&sources,&code,0x400008u,1u,&row) == 1);
    EXPECT(!vm_sources_publish(&sources,8u,1u,&row));
    EXPECT(!vm_mmu_access(&memory,0u,&cpu,0x400008u,1u,2u,7u));
    EXPECT(vm_sources_probe(&sources,&code,0x400008u,1u,&row) == 1);
}
static int probe(pl_u64 entry, pl_u32 limit)
{ return vm_sources_probe(&sources,&page,entry,limit,&row); }
static void demand_lifetime(void)
{
    /* A repeated, still-valid source must outlive inactive cold sources.
     * This exercises the C owner, not the host emitted-module cache. */
    vm_sources_open(&sources,9u,3u);
    EXPECT(probe(page.address,1024u) == 1);
    EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
    const pl_u32 hot_slot = row.slot;
    pl_u32 hot_misses = 0u, slot_changes = 0u;
    for (pl_u32 i = 0u; i < 4096u; ++i) {
        EXPECT(probe(page.address+1u+(i%4095u),1024u) == 1);
        EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
        if (probe(page.address,1024u) != 0) {
            ++hot_misses;
            EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
        }
        slot_changes += row.slot != hot_slot;
    }
    if (hot_misses) fprintf(stderr,"source: hot source unnecessarily recompiled %u times\n",hot_misses);
    EXPECT(hot_misses == 0u);
    EXPECT(slot_changes == 0u);
    vm_sources_open(&sources,9u,3u);
}
typedef struct {
    pl_u64 entry, stamp;
    pl_u32 offset, limit;
    int valid;
} reference_row;
static reference_row reference[VM_SOURCE_ROWS];
static void reference_check(void)
{
    pl_u64 valid=0u, seen=0u, stamp=0u;
    pl_u32 previous=VM_SOURCE_ROWS, rank=sources.oldest, count=0u;
    for (pl_u32 i=0u;i<VM_SOURCE_ROWS;++i) {
        if (!reference[i].valid) continue;
        valid |= 1ull<<i;
        EXPECT(sources.rows[i].row.entry==reference[i].entry);
        EXPECT(sources.rows[i].offset==reference[i].offset);
        EXPECT(sources.rows[i].limit==reference[i].limit);
        EXPECT(sources.rows[i].row.slot==sources.first_slot+i);
    }
    EXPECT(sources.valid==valid);
    /* Independent test-only scan/timestamps. Production uses neither epochs
     * nor this linear reference algorithm. A cycle cannot hang the test. */
    while (rank<VM_SOURCE_ROWS && count++<VM_SOURCE_ROWS) {
        EXPECT(!(seen&(1ull<<rank)) && reference[rank].valid);
        EXPECT(sources.previous[rank]==previous);
        EXPECT(reference[rank].stamp>stamp);
        seen |= 1ull<<rank; stamp=reference[rank].stamp;
        previous=rank; rank=sources.next[rank];
    }
    EXPECT(rank==VM_SOURCE_ROWS && seen==valid && sources.newest==previous);
    for (pl_u32 b=0u;b<VM_SOURCE_WATCH_BUCKETS;++b) {
        pl_u64 watch=0u, lookup=0u;
        for (pl_u32 i=0u;i<VM_SOURCE_ROWS;++i) {
            if (!reference[i].valid) continue;
            if (((reference[i].offset>>12u)&(VM_SOURCE_WATCH_BUCKETS-1u))==b) watch |= 1ull<<i;
            if (((pl_u32)(reference[i].entry^(reference[i].entry>>8u)^reference[i].limit)
                    &(VM_SOURCE_WATCH_BUCKETS-1u))==b) lookup |= 1ull<<i;
        }
        EXPECT(sources.watch[b]==watch && sources.lookup[b]==lookup);
    }
}
static void demand_reference(void)
{
    pl_u32 random=0x47ac2831u;
    memset(&sources,0xa5,sizeof sources); /* Reopen does not depend on zeroed inactive links. */
    vm_sources_open(&sources,9u,3u); memset(reference,0,sizeof reference);
    for (pl_u32 turn=1u;turn<=20000u;++turn) {
        random=random*1664525u+1013904223u;
        pl_u64 entry=page.address+(pl_u64)((random>>8u)&127u)*16u;
        pl_u32 limit=(random&4u)?1u:1024u, rank=VM_SOURCE_ROWS;
        page.offset=(random&1u)?8192u:0x102000u; /* Colliding physical watch buckets. */
        for (pl_u32 i=0u;i<VM_SOURCE_ROWS;++i)
            if (reference[i].valid && reference[i].entry==entry
                    && reference[i].offset==page.offset && reference[i].limit==limit) rank=i;
        int hit=rank<VM_SOURCE_ROWS;
        if (!hit) {
            for (pl_u32 i=0u;i<VM_SOURCE_ROWS;++i)
                if (!reference[i].valid) { rank=i; break; }
            if (rank==VM_SOURCE_ROWS) {
                rank=0u;
                for (pl_u32 i=1u;i<VM_SOURCE_ROWS;++i)
                    if (reference[i].stamp<reference[rank].stamp) rank=i;
            }
            reference[rank].valid=0;
        }
        EXPECT(probe(entry,limit)==(hit?0:1));
        EXPECT(row.slot==3u+rank);
        if (!hit) {
            if ((random&31u)==0u) {
                /* A failed/cancelled compile owns no valid rank or demand. */
                vm_sources_write(&sources,page.offset+4000u,1u);
                EXPECT(vm_sources_publish(&sources,1u,1u,&row)==-1);
                reference_check(); continue;
            }
            EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
        }
        reference[rank]=(reference_row){entry,turn,page.offset,limit,1};
        if ((random&15u)==2u) {
            pl_u32 at=page.offset+(pl_u32)(entry-page.address);
            vm_sources_write(&sources,at,1u);
            for (pl_u32 i=0u;i<VM_SOURCE_ROWS;++i)
                if (reference[i].valid && reference[i].offset+(pl_u32)(reference[i].entry-page.address)==at)
                    reference[i].valid=0;
        }
        if ((random&255u)==7u) {
            vm_sources_open(&sources,9u,3u); memset(reference,0,sizeof reference);
        }
        reference_check();
    }
    page.offset=8192u; vm_sources_open(&sources,9u,3u);
}
static void crossing_demand(void)
{
    vm_code_page next={page.address+4096u,9u,32768u,4096u};
    const pl_u64 hot=page.address+4095u;
    for (pl_u32 accepted=0u;accepted<2u;++accepted) {
        vm_sources_open(&sources,9u,3u);
        EXPECT(probe(hot,1024u)==1);
        EXPECT(vm_sources_extend(&sources,&next,&row)==1);
        EXPECT(!vm_sources_publish(&sources,2u,1u,&row));
        const pl_u32 hot_slot=row.slot;
        for (pl_u32 i=1u;i<VM_SOURCE_ROWS;++i) {
            EXPECT(probe(page.address+i,1024u)==1);
            EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
        }
        EXPECT(probe(hot,1024u)==2);
        vm_code_page tail=next;
        if (!accepted) tail.generation=10u;
        EXPECT(vm_sources_extend(&sources,&tail,&row)==(accepted?0:-1));
        EXPECT(probe(page.address+VM_SOURCE_ROWS,1024u)==1);
        EXPECT((row.slot==hot_slot)==!accepted);
        EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
        if (accepted) {
            for (pl_u32 i=0u;i<4096u;++i) {
                EXPECT(probe(hot,1024u)==2);
                EXPECT(!vm_sources_extend(&sources,&next,&row) && row.slot==hot_slot);
                int result=probe(page.address+1u+(i%4094u),1024u);
                EXPECT(result==0 || result==1);
                if (result==1) EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
            }
        }
    }
    vm_sources_open(&sources,9u,3u);
}
static void crossing(void)
{
    const pl_u64 entry = page.address+4095u;
    vm_code_page next = {page.address+4096u,9u,32768u,4096u};
    vm_sources_open(&sources,9u,3u);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_publish(&sources,3u,1u,&row) == -1);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
    pl_u32 slot = row.slot;
    EXPECT(probe(entry,1024u) == 2);
    EXPECT(!vm_sources_extend(&sources,&next,&row));
    EXPECT(row.slot == slot && row.source_bytes == 3u);
    /* Two non-contiguous physical owners, exact extent, and no payload copy. */
    vm_sources_write(&sources,page.offset+4094u,1u);
    vm_sources_write(&sources,next.offset+2u,1u);
    EXPECT(probe(entry,1024u) == 2);
    EXPECT(!vm_sources_extend(&sources,&next,&row));
    vm_sources_write(&sources,next.offset+1u,1u);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
    vm_sources_write(&sources,page.offset+4095u,1u);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    vm_sources_write(&sources,next.offset+100u,1u);
    EXPECT(vm_sources_publish(&sources,3u,1u,&row) == -1);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    vm_sources_write(&sources,page.offset+100u,1u);
    EXPECT(vm_sources_publish(&sources,3u,1u,&row) == -1);
    /* Source generation and mapping changes cannot reuse an old tail. */
    EXPECT(probe(entry,1024u) == 1);
    vm_code_page wrong = next; wrong.generation = 10u;
    memset(&row,0xa5,sizeof row); vm_execution_row saved = row;
    EXPECT(vm_sources_extend(&sources,&wrong,&row) == -1);
    EXPECT(!memcmp(&row,&saved,sizeof row));
    EXPECT(vm_sources_publish(&sources,3u,1u,&row) == -1);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    EXPECT(vm_sources_publish(&sources,16u,1u,&row) == -1);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    EXPECT(vm_sources_publish(&sources,3u,2u,&row) == -1);
    EXPECT(probe(entry,1024u) == 1);
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    EXPECT(!vm_sources_publish(&sources,15u,1u,&row));
    EXPECT(probe(entry,1024u) == 2);
    next.offset = 36864u;
    EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
    EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
    /* Collision and physical alias owners must also revoke both extents. */
    for (pl_u32 alias=0u;alias<2u;++alias) {
        next.offset = page.offset+(alias ? 0u : VM_SOURCE_WATCH_BUCKETS*4096u);
        vm_sources_open(&sources,9u,3u);
        EXPECT(probe(entry,1024u) == 1);
        EXPECT(vm_sources_extend(&sources,&next,&row) == 1);
        EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
        vm_sources_write(&sources,next.offset+2u,1u);
        EXPECT(probe(entry,1024u) == 2);
        EXPECT(!vm_sources_extend(&sources,&next,&row));
        vm_sources_write(&sources,next.offset,1u);
        EXPECT(probe(entry,1024u) == 1);
    }
    vm_sources_open(&sources,9u,3u);
}
int main(void)
{
    vm_sources_open(&sources,9u,3u);
    EXPECT(probe(0x400080u,1024u) == 1);
    EXPECT(!vm_sources_publish(&sources,7u,2u,&row));
    pl_u32 slot = row.slot;
    EXPECT(probe(0x400080u,1024u) == 0 && row.slot == slot && row.source_bytes == 7u);
    /* Actual RAM writes, including reservation commit, must notify before
     * changing an aliased physical payload. Direct helper calls are not enough. */
    static _Alignas(8) pl_u8 ram[16384]; vm_memory memory;
    vm_memory_page physical[1] = {{0x400000u,8192u,3u,VM_MEMORY_RAM,0u,0u}};
    EXPECT(!vm_memory_open(&memory,ram,sizeof ram,4096u,physical,1u,1u,0,9u));
    memory.before_write = vm_sources_write; memory.write_owner = &sources;
    memcpy(ram,&page.generation,8u);
    EXPECT(!vm_memory_access(&memory,0u,0x400086u,1u,MACHINE_MEMORY_WRITE,1u));
    EXPECT(probe(0x400080u,1024u) == 1);
    EXPECT(!vm_sources_publish(&sources,7u,2u,&row));
    /* The source is not copied. Writes outside its exact extent do not revoke. */
    vm_sources_write(&sources,8192u + 127u,1u);
    vm_sources_write(&sources,8192u + 135u,8u);
    EXPECT(probe(0x400080u,1024u) == 0);
    vm_sources_write(&sources,8192u + 134u,1u);
    EXPECT(probe(0x400080u,1024u) == 1);
    EXPECT(!vm_sources_publish(&sources,7u,2u,&row));
    /* A page-table alias uses the same physical write observer. */
    vm_sources_write(&sources,8192u + 128u,8u);
    EXPECT(probe(0x400080u,1024u) == 1);
    /* Compile/instantiate may await. Any source-page write cancels the pin. */
    vm_sources_write(&sources,8192u + 512u,1u);
    EXPECT(vm_sources_publish(&sources,7u,2u,&row) == -1);
    EXPECT(probe(0x400080u,1024u) == 1);
    vm_sources_write(&sources,12288u,8u);
    EXPECT(!vm_sources_publish(&sources,7u,2u,&row));
    EXPECT(probe(0x400080u,1u) == 1);
    EXPECT(vm_sources_publish(&sources,7u,2u,&row) == -1);
    EXPECT(probe(0x400080u,1u) == 1);
    EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
    EXPECT(probe(0x400080u,1u) == 0);
    page.offset = 12288u;
    EXPECT(probe(0x400080u,1u) == 1); /* Identical VA, different physical owner. */
    EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
    page.generation = 10u;
    memset(&row,0xa5,sizeof row); vm_execution_row saved = row;
    EXPECT(probe(0x400080u,1u) == -1 && !memcmp(&row,&saved,sizeof row));
    EXPECT(vm_sources_publish(&sources,3u,1u,&row) == -1);
    page.generation = 9u; page.offset = 8192u;
    EXPECT(probe(0x401000u,1u) == -1);
    EXPECT(probe(0x400fffu,1u) == 1);
    EXPECT(vm_sources_publish(&sources,2u,1u,&row) == -1);
    EXPECT(probe(0x400fffu,1u) == 1);
    EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
    EXPECT(probe(0x400fffu,1u) == 0);
    vm_sources_write(&sources,8192u + 4095u,2u);
    EXPECT(probe(0x400fffu,1u) == 1);
    EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
    vm_sources_open(&sources,9u,3u); /* Same generation reset must still revoke. */
    EXPECT(probe(0x400fffu,1u) == 1);
    EXPECT(!vm_sources_publish(&sources,1u,1u,&row));
    /* Many collision/replacement/write cases, always bounded at 64 rows. */
    for (pl_u32 i = 0u; i < 100000u; ++i) {
        pl_u64 at = 0x400000u + (i * 17u % 4090u);
        int result = probe(at,1024u);
        EXPECT(result == 0 || result == 1);
        if (result == 1) EXPECT(!vm_sources_publish(&sources,6u,2u,&row));
        EXPECT(probe(at,1024u) == 0);
        EXPECT(row.slot >= 3u && row.slot < 3u + VM_SOURCE_ROWS);
        vm_sources_write(&sources,8192u + (pl_u32)(at & 4095u) + 5u,1u);
        EXPECT(probe(at,1024u) == 1);
        EXPECT(!vm_sources_publish(&sources,6u,2u,&row));
    }
    vm_sources_open(&sources,0u,3u); EXPECT(probe(0x400000u,1u) == -1);
    vm_sources_open(&sources,9u,VM_EXECUTION_MAX_ROWS); EXPECT(probe(0x400000u,1u) == -1);
    vm_sources_open(&sources,9u,3u); page.offset = 0x102000u;
    EXPECT(probe(0x400080u,1u) == 1); EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
    vm_sources_write(&sources,8192u+128u,1u); /* Same watch bucket, different physical page. */
    EXPECT(probe(0x400080u,1u) == 0);
    vm_sources_write(&sources,0x102080u,1u); EXPECT(probe(0x400080u,1u) == 1);
    EXPECT(!vm_sources_publish(&sources,3u,1u,&row));
    vm_sources_write(&sources,0u,0xffffffffu); EXPECT(probe(0x400080u,1u) == 1);
    page.offset = 8192u;
    demand_lifetime();
    demand_reference();
    crossing_demand();
    crossing();
    mmu_alias();
    if (!failures) puts("source admission: bounded zero-copy source/write frontier green (100000 replacements, 20000 independent LRU/write/reset cases, 4096 hot/cold and crossing demands; no boot speedup claim)");
    return failures != 0;
}
