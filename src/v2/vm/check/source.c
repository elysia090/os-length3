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
int main(void)
{
    vm_sources_open(&sources,9u,3u);
    EXPECT(probe(0x400080u,1024u) == 1);
    EXPECT(!vm_sources_publish(&sources,7u,2u,&row));
    pl_u32 slot = row.slot;
    EXPECT(probe(0x400080u,1024u) == 0 && row.slot == slot && row.source_bytes == 7u);
    /* Actual RAM writes, including reservation commit, must notify before
     * changing an aliased physical payload. Direct helper calls are not enough. */
    static pl_u8 ram[16384]; vm_memory memory;
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
    mmu_alias();
    if (!failures) puts("source admission: bounded zero-copy source/write frontier green (100000 replacement cases)");
    return failures != 0;
}
