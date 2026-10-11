#include <vm/mmu.h>
#include "../core/memory-internal.h"
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536];static vm_memory m;static vm_memory_page pages[8];static vm_memory_branch branches[7];
static unsigned failures,reads,writes,checks;static pl_u64 reg;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"mmio line %u\n",(unsigned)__LINE__);++failures;}}while(0)
static machine_result device(void *owner,pl_u64 address,pl_u32 bytes,pl_u32 access,pl_u32 phase,pl_u64 *value)
{
    (void)owner;if(address!=0x9000u||bytes!=4u||(access&3u)>2u)return MACHINE_RESULT_ENTRY_MAP;
    if(!phase)++checks;else if(phase==1u){++reads;*value=reg;}else{++writes;reg=(pl_u32)*value;}return 0;
}
int main(void)
{
    memset(arena,0,sizeof arena);vm_memory_store(arena+2048,9u,8u);
    for(pl_u32 n=0u;n<4u;++n)pages[n]=(vm_memory_page){(n+1ull)*4096u,(n+2u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
    pages[4]=(vm_memory_page){0x8000u,24576u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&m,arena,sizeof arena,4096u,pages,5u,8u,branches,9u));
    pl_u64 next=m.next_offset;EXPECT(!vm_memory_append_device(&m,0x9000u));EXPECT(m.next_offset==next);
    m.device_transfer=device;vm_mmu_context cpu={0x80010001u,0x1000u,32u,0xd00u,0u};
    vm_memory_store(arena+8192,0x2067u,8u);vm_memory_store(arena+12288,0x3067u,8u);
    vm_memory_store(arena+16384+16u,0x4067u,8u);vm_memory_store(arena+20480,0x9067u,8u);
    reg=0x12345678u;EXPECT(!vm_mmu_access(&m,2048u,&cpu,0x400000u,4u,1u,0u));EXPECT(reads==1u&&vm_memory_load(arena+2056,8u)==reg);
    EXPECT(!vm_mmu_read_pair(&m,2048u,&cpu,0x400000u,4u,1u));EXPECT(reads==2u&&vm_memory_load(arena+2096,8u)==0u);
    EXPECT(!vm_mmu_read_extent(&m,2048u,&cpu,0x400000u,4u,1u));EXPECT(reads==3u);
    EXPECT(vm_memory_load(arena+2096,4u)==2056u&&vm_memory_load(arena+2104,4u)==4u);
    EXPECT(!vm_mmu_write_begin(&m,2048u,&cpu,0x400000u,4u,2u));EXPECT(!writes);
    EXPECT(!vm_memory_write_word(&m,2048u,0u,4u,0xaabbccddu));EXPECT(!writes);
    EXPECT(!vm_memory_write_end(&m,2048u));EXPECT(writes==1u&&reg==0xaabbccddu);
    EXPECT(!vm_mmu_write_begin(&m,2048u,&cpu,0x400000u,4u,2u));vm_memory_abort(&m);
    EXPECT(vm_memory_write_end(&m,2048u)==MACHINE_RESULT_ENTRY_MAP&&writes==1u);
    EXPECT(!vm_mmu_write_begin(&m,2048u,&cpu,0x400000u,4u,2u));
    EXPECT(vm_memory_write_word(&m,2048u,0u,1u,7u)==MACHINE_RESULT_ENTRY_MAP&&writes==1u);
    EXPECT(vm_mmu_reserve(&m,2048u,&cpu,0x400000u,4u,3u)==MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_mmu_access(&m,2048u,&cpu,0x400000u,8u,1u,0u)==MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_mmu_access(&m,2048u,&cpu,0x400fffu,4u,1u,0u)==MACHINE_RESULT_ENTRY_MAP);
    EXPECT(!vm_memory_access(&m,2048u,0x9000u,4u,2u,0x76543210u));EXPECT(writes==2u&&reg==0x76543210u);
    unsigned before=checks+reads+writes;
    EXPECT(!vm_memory_external_write(&m,20480u,8u));
    vm_memory_store(arena+20480,0x9065u,8u);
    EXPECT(vm_mmu_access(&m,2048u,&cpu,0x400000u,4u,2u,1u)==115u);EXPECT(checks+reads+writes==before);
    vm_memory_store(arena+2048,8u,8u);EXPECT(vm_mmu_access(&m,2048u,&cpu,0x400000u,4u,1u,0u)==5u);
    EXPECT(checks+reads+writes==before);EXPECT(!m.write_touched);
    if(failures)return 1;
    puts("MMIO: translation/rights before device; no payload slot/RFO; one read or commit; abort/stale/refusal fences");return 0;
}
