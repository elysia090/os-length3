#include <vm/segments.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[32768];static vm_memory_page pages[6];static vm_memory_branch branches[5];static vm_memory memory;
static machine_state cpu;static machine_segments segments;static unsigned checks;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"descriptor query: line %u check %u\n",(unsigned)__LINE__,checks);return 1;}++checks;}while(0)
static void put(pl_u32 at,pl_u64 value){for(pl_u32 n=0u;n<8u;++n)arena[at+n]=(pl_u8)(value>>(n*8u));}
static pl_u64 get(pl_u32 at){pl_u64 v=0u;for(pl_u32 n=0u;n<8u;++n)v|=(pl_u64)arena[at+n]<<(n*8u);return v;}
static int reset(pl_u32 cpl,pl_u32 table,pl_u32 kind)
{
    memset(arena,0,sizeof arena);put(0u,9u);put(8u,0x1122334455667788ull);put(48u,0x8877665544332211ull);
    put(4096u,0x2027u);put(8192u,0x3027u);put(12288u,kind==VM_MEMORY_FAULT?0xe2u:0xe3u); // Guest P=0, not an untrusted host-cache fault.
    for(pl_u32 n=0u;n<6u;++n)pages[n]=(vm_memory_page){(n+1ull)*4096u,(n+1u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
    pages[table?4u:3u].kind=kind==VM_MEMORY_FAULT?VM_MEMORY_RAM:kind;
    if(vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u))return 1;
    cpu=(machine_state){.cr0=0x80010011u,.cr3=0x1000u,.cr4=32u,.efer=0x500u,.rip=0x6000u,.rflags=0xa93u,.retired=42u};
    cpu.system[MACHINE_SYSTEM_CS]=8u|cpl;cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4000u;cpu.system[MACHINE_SYSTEM_GDTR_LIMIT]=15u;cpu.system[MACHINE_SYSTEM_LDTR]=0x50u;
    segments=(machine_segments){.version=MACHINE_SEGMENTS_ABI_VERSION};segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu|(cpl<<5u);
    segments.cache[MACHINE_SEGMENT_LDTR]=(machine_segment_cache){0x5000u,15u,0x82u};
    put((table?20480u:16384u)+8u,0xabcdf0123456789aull);return 0;
}
int main(void)
{
    for(pl_u32 cpl=0u;cpl<4u;++cpl)for(pl_u32 table=0u;table<2u;++table)for(pl_u32 kind=1u;kind<=3u;++kind){
        EXPECT(!reset(cpl,table,kind));machine_state old=cpu;machine_segments hidden=segments;
        pl_u64 raw=get((table?20480u:16384u)+8u);machine_result result=vm_descriptor_query(&memory,0u,&cpu,&segments,8u|(table?4u:0u)|cpl);
        EXPECT(result==(kind==VM_MEMORY_RAM?0u:kind==VM_MEMORY_FAULT?115u:2u));
        EXPECT(!memcmp(&cpu,&old,sizeof cpu)&&!memcmp(&segments,&hidden,sizeof segments));
        EXPECT(get((table?20480u:16384u)+8u)==raw); // No descriptor Accessed bit write.
        EXPECT(get(8u)==(kind==VM_MEMORY_RAM?raw:0x1122334455667788ull));EXPECT(get(48u)==(kind==VM_MEMORY_RAM?1u:0x8877665544332211ull));
        if(kind==VM_MEMORY_DEFERRED){pages[table?4u:3u].kind=VM_MEMORY_RAM;EXPECT(!vm_descriptor_query(&memory,0u,&cpu,&segments,8u|(table?4u:0u)|cpl));EXPECT(get(8u)==raw&&get(48u)==1u);}
        if(kind==VM_MEMORY_FAULT){EXPECT(get(16u)==0x4008u+(table?4096u:0u));EXPECT(get(24u)==14u);}
    }
    for(pl_u32 absent=0u;absent<4u;++absent){EXPECT(!reset(3u,0u,VM_MEMORY_DEFERRED));pl_u32 selector=absent==0u?0u:absent==1u?3u:absent==2u?16u:12u;
        if(absent==3u)segments.cache[MACHINE_SEGMENT_LDTR].attributes=MACHINE_SEGMENT_UNUSABLE;
        machine_state old=cpu;machine_segments hidden=segments;EXPECT(!vm_descriptor_query(&memory,0u,&cpu,&segments,selector));EXPECT(!get(8u)&&!get(48u));
        EXPECT(!memcmp(&cpu,&old,sizeof cpu)&&!memcmp(&segments,&hidden,sizeof segments));}
    EXPECT(!reset(0u,0u,VM_MEMORY_RAM));put(0u,8u);machine_state old=cpu;
    EXPECT(vm_descriptor_query(&memory,0u,&cpu,&segments,8u)==MACHINE_RESULT_STALE_GENERATION);EXPECT(get(8u)==0x1122334455667788ull&&get(48u)==0x8877665544332211ull);
    EXPECT(!memcmp(&cpu,&old,sizeof cpu));
    EXPECT(!reset(0u,0u,VM_MEMORY_RAM));EXPECT(vm_descriptor_query(&memory,4u,&cpu,&segments,8u)==MACHINE_RESULT_ENTRY_MAP);
    EXPECT(vm_descriptor_query(&memory,0u,&cpu,&segments,65536u)==MACHINE_RESULT_ENTRY_MAP);
    printf("descriptor query: %u extent/generation/GDT/LDT/supervisor/fault/wait/retry/state assertions; no native-oracle claim\n",checks);return 0;
}
