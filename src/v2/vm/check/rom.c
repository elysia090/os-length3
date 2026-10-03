/* Physical immutability is not a guest page-table permission or cached #PF. */
#include <vm/mmu.h>
#include <vm/supply.h>
#include "../core/memory-internal.h"
#include <stdio.h>
#include <string.h>

static _Alignas(8) pl_u8 arena[65536], expected[16384], header[4096];
static vm_memory_page pages[8];
static vm_memory_branch branches[7];
static pl_u32 observations, observed_bytes;
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"rom: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void observe(void *owner, pl_u32 offset, pl_u32 bytes)
{
    (void)owner; ++observations; observed_bytes += bytes;
    EXPECT((offset >= 20480u && offset+bytes <= 24576u)
           || (offset >= 32768u && offset+bytes <= 36864u));
}
static void reset(vm_memory *memory)
{
    memset(arena,0,sizeof arena); vm_memory_store(arena+2048u,9u,8u);
    for (pl_u32 i=0u;i<4u;++i) {
        pages[i]=(vm_memory_page){(i+1ull)*4096u,(i+1u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
        vm_memory_store(arena+(i+1u)*4096u+(i==2u?16u:0u),(i+2ull)*4096u|0x27u,8u);
    }
    for (pl_u32 i=0u;i<4u;++i) vm_memory_store(arena+16384u+i*8u,(i+5ull)*4096u|0x67u,8u);
    EXPECT(!vm_memory_open(memory,arena,sizeof arena,4096u,pages,4u,8u,branches,9u));
    EXPECT(!vm_memory_append(memory,0x5000u,20480u,3u));
    EXPECT(!vm_memory_append_rom(memory,0x6000u,24576u));
    EXPECT(!vm_memory_append_rom(memory,0x7000u,28672u));
    EXPECT(!vm_memory_append(memory,0x8000u,32768u,3u));
    /* Exact arbitrary ROM bytes, not an implementation tied to erased fill. */
    for (pl_u32 i=0u;i<16384u;++i) arena[20480u+i]=(pl_u8)(i*13u+(i>>8u));
    memory->before_write=observe;
}
int main(int argc, char **argv)
{
    if (argc != 1 && argc != 2) return 2;
    vm_memory memory; reset(&memory);
    vm_mmu_context cpu={0x80010001u,0x1000u,32u,0xd00u,0u};
    pl_u64 seed=0x7124a897c10d34ull;
    pl_u32 cases=0u;
    for (pl_u32 i=0u;i<12000u;++i) {
        seed ^= seed<<13u; seed ^= seed>>7u; seed ^= seed<<17u;
        pl_u32 width=1u<<((pl_u32)seed&3u), at=(pl_u32)(seed>>8u)%(16385u-width);
        if (i<288u) at=4096u*(i/96u+1u)-8u+i%16u;
        pl_u64 value=seed^0xa5a5669912348901ull;
        memcpy(expected,arena+20480u,sizeof expected);
        pl_u64 read=vm_memory_load(expected+at,width);
        pl_u32 touched=0u;
        for (pl_u32 j=0u;j<width;++j) if (at+j<4096u || at+j>=12288u) {
            expected[at+j]=(pl_u8)(value>>(j*8u)); ++touched;
        }
        memory.write_touched=0u; observations=observed_bytes=0u;
        EXPECT(!vm_mmu_access(&memory,2048u,&cpu,0x400000u+at,width,1u,0u));
        EXPECT(vm_memory_load(arena+2056u,8u)==read && !memory.write_touched && !observations);
        if (i%3u==0u) {
            EXPECT(!vm_memory_access(&memory,2048u,0x5000u+at,width,2u,value));
        } else if (i%3u==1u) {
            EXPECT(!vm_mmu_access(&memory,2048u,&cpu,0x400000u+at,width,2u,value));
        } else {
            EXPECT(!vm_mmu_reserve(&memory,2048u,&cpu,0x400000u+at,width,3u));
            EXPECT(vm_memory_load(arena+2056u,8u)==read);
            EXPECT(vm_memory_append_rom(&memory,0x9000u,(pl_u32)memory.next_offset)==-1);
            EXPECT(!vm_memory_commit(&memory,2048u,value));
            EXPECT(vm_memory_commit(&memory,2048u,value)==MACHINE_RESULT_ENTRY_MAP);
        }
        EXPECT(!memcmp(arena+20480u,expected,sizeof expected));
        EXPECT(memory.write_touched==!!touched && observed_bytes==touched && observations==!!touched);
        ++cases;
    }
    /* Paging permissions win even when the physical write would be ignored. */
    reset(&memory); vm_memory_store(arena+16392u,0x6065u,8u); memory.write_touched=0u;
    EXPECT(vm_mmu_access(&memory,2048u,&cpu,0x401000u,8u,2u,0u)==machine_result_make(MACHINE_RESULT_FAULT,14u));
    EXPECT(vm_memory_load(arena+2072u,8u)==0x30000000eull && !memory.write_touched);
    vm_memory_store(arena+16392u,0x8000000000006067ull,8u);
    vm_code_page code={0}, sentinel=code;
    EXPECT(vm_mmu_code_page(&memory,2048u,&cpu,0x401000u,&code)==machine_result_make(MACHINE_RESULT_FAULT,14u));
    EXPECT(!memcmp(&code,&sentinel,sizeof code));
    vm_memory_store(arena+16392u,0x6067u,8u);
    EXPECT(!vm_mmu_code_page(&memory,2048u,&cpu,0x401007u,&code));
    EXPECT(code.offset==24576u && code.bytes==4096u);
    EXPECT(!vm_mmu_reserve(&memory,2048u,&cpu,0x401000u,8u,3u));
    vm_memory_store(arena+2048u,10u,8u);
    EXPECT(vm_memory_commit(&memory,2048u,0u)==MACHINE_RESULT_STALE_GENERATION && !memory.reservation.parts);
    /* Paging-structure A/D bus writes to ROM are also ignored, not dirty RAM.
     * This is a general ROM payload, distinct from the erased boot window. */
    reset(&memory);
    vm_memory_store(arena+12288u+16u,0x6027u,8u);
    vm_memory_store(arena+24576u,0x8007u,8u);
    memory.write_touched=0u; observations=observed_bytes=0u;
    EXPECT(!vm_mmu_access(&memory,2048u,&cpu,0x400000u,8u,1u,0u));
    EXPECT(vm_memory_load(arena+24576u,8u)==0x8007u && !memory.write_touched && !observations);
    EXPECT(!vm_mmu_access(&memory,2048u,&cpu,0x400000u,8u,2u,0xabcdu));
    EXPECT(vm_memory_load(arena+24576u,8u)==0x8007u && observed_bytes==8u && observations==1u);
    EXPECT(vm_memory_load(arena+32768u,8u)==0xabcdu && memory.write_touched);
    /* A later fragment's denied translation must publish no payload writes. */
    reset(&memory); vm_memory_store(arena+16408u,0x8065u,8u);
    memcpy(expected,arena+20480u,sizeof expected); memory.write_touched=0u;
    EXPECT(vm_mmu_reserve(&memory,2048u,&cpu,0x402ffdu,8u,3u)==machine_result_make(MACHINE_RESULT_FAULT,14u));
    EXPECT(!memory.reservation.parts && !memory.write_touched && !memcmp(expected,arena+20480u,sizeof expected));
    /* Virgin typed append cannot create a writable physical alias. */
    EXPECT(vm_memory_append_rom(&memory,0x9000u,24576u)==-1);
    EXPECT(vm_memory_open(&memory,arena,sizeof arena,4096u,pages,8u,8u,branches,9u)==-1);
    /* Supply retry/replay is the same C-owned handshake for machine ROM. */
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,0u,8u,branches,9u));
    vm_boot boot={.header=header,.ram_bytes=0x8000000u};
    vm_page_supply supply={0}; machine_state state={.rip=0xffffffff812357cbull};
    vm_memory_store(arena+2048u,9u,8u); vm_memory_store(arena+2080u,0xf0000u,8u);
    vm_memory_store(arena+2088u,8u,4u); vm_memory_store(arena+2092u,19u,4u);
    vm_supply_capture(&supply,&memory,&state,2048u,MACHINE_RESULT_BARRIER);
    vm_page_request request;
    EXPECT(!vm_supply_prepare(&supply,&memory,&boot,&state,2048u,&request));
    EXPECT(request.source_kind==VM_BOOT_ROM && !request.source_bytes && request.target_offset==4096u);
    pl_u64 ticket=request.ticket;
    EXPECT(!vm_supply_prepare(&supply,&memory,&boot,&state,2048u,&request) && request.ticket==ticket);
    EXPECT(vm_supply_commit(&supply,&memory,&state,2048u,ticket+1u)==-1);
    EXPECT(!vm_supply_commit(&supply,&memory,&state,2048u,ticket));
    EXPECT(pages[0].kind==VM_MEMORY_ROM && memory.page_count==1u);
    EXPECT(vm_supply_commit(&supply,&memory,&state,2048u,ticket)==-1);
    for (pl_u32 i=0u;i<4096u;++i) EXPECT(arena[4096u+i]==0xffu);
    if (argc == 2) {
        FILE *oracle=fopen(argv[1],"r"); if (!oracle) return 2;
        unsigned long long row[6]; pl_u32 rows=0u;
        while (fscanf(oracle,"%llx %llx %llx %llx %llx %llx",row,row+1,row+2,row+3,row+4,row+5)==6) {
            EXPECT(row[0]==0xf0000ull+rows*4093ull);
            for (pl_u32 i=2u;i<6u;++i) EXPECT(row[i]==row[1]);
            reset(&memory); pl_u32 at=(pl_u32)row[0]&4095u;
            vm_memory_store(arena+24576u+at,(pl_u64)row[1],8u);
            pl_u64 address=0x401000u+at;
            EXPECT(!vm_mmu_access(&memory,2048u,&cpu,address,8u,2u,~(pl_u64)row[1]));
            EXPECT(vm_memory_load(arena+24576u+at,8u)==(pl_u64)row[2]);
            EXPECT(!vm_mmu_reserve(&memory,2048u,&cpu,address,8u,3u));
            EXPECT(vm_memory_load(arena+2056u,8u)==(pl_u64)row[3]);
            EXPECT(!vm_memory_commit(&memory,2048u,0x1122334455667788ull));
            EXPECT(vm_memory_load(arena+24576u+at,8u)==(pl_u64)row[4]);
            EXPECT(!vm_mmu_reserve(&memory,2048u,&cpu,address,8u,3u));
            EXPECT(!vm_memory_commit(&memory,2048u,(pl_u64)row[1]+1u));
            EXPECT(vm_memory_load(arena+24576u+at,8u)==(pl_u64)row[5]);
            ++rows;
        }
        EXPECT(feof(oracle) && rows==17u); fclose(oracle);
        if (!failures) printf("Physical ROM: %u independent QEMU bus rows match C-MMU MOV/XCHG/RMW transfers; not CPU flag/exception completeness\n",rows);
    }
    if (!failures) printf("Physical ROM: %u arbitrary-payload/read/write/RMW/cross-page cases green, precise paging and supply; NOT Linux boot\n",cases);
    return failures?1:0;
}
