/* Independent fixed-profile Intel SDM model. System oracle is separate. */
#include <vm/debug.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[8192];
static machine_state state;
static machine_segments segments;
static unsigned failures,cases;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"debug: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at,pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) arena[at+i]=(pl_u8)(value>>(i*8u)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 v=0u; for (pl_u32 i=0u;i<8u;++i) v|=(pl_u64)arena[at+i]<<(i*8u); return v; }
static void reset(pl_u32 cpl,pl_u32 gd)
{
    memset(arena,0,sizeof arena); put(0u,9u);
    state=(machine_state){0}; state.cr0=0x80010011u; state.cr3=0x1000u;
    state.cr4=32u; state.efer=0x500u; state.rip=0x400000u; state.rflags=0x10202u;
    state.system[MACHINE_SYSTEM_CS]=8u|cpl; state.retired=42u;
    for (pl_u32 i=0u;i<6u;++i) state.system[MACHINE_SYSTEM_DR0+i]=0xa5a5a5a5a5a5a5a5ull+i;
    state.system[MACHINE_SYSTEM_DR0+6u]=0xffff0ff0u;
    state.system[MACHINE_SYSTEM_DR0+7u]=0x400u|(gd ? 0x2000u : 0u);
    segments=(machine_segments){0}; segments.version=MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu;
}
int main(void)
{
    vm_memory memory;
    vm_memory_page page={0x1000u,4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,&page,1u,1u,NULL,9u));
    const pl_u64 edges[]={0u,~0ull,0xffff0ff0u,0xffff23ffu,0x400u,
        0x7fffffffffffull,0x800000000000ull,0xffff7fffffffffffull,0xffff800000000000ull};
    for (pl_u32 cpl=0u;cpl<4u;++cpl) for (pl_u32 gd=0u;gd<2u;++gd)
    for (pl_u32 write=0u;write<2u;++write) for (pl_u32 rank=0u;rank<8u;++rank)
    for (pl_u32 n=0u;n<73u;++n) {
        reset(cpl,gd);
        pl_u64 value=n<64u ? 1ull<<n : edges[n-64u];
        pl_u32 target=rank==4u || rank==5u ? rank+2u : rank;
        pl_u32 vector=cpl ? 13u : gd ? 1u : write && target>=6u && (value>>32u) ? 13u : 0u;
        machine_state wanted=state; machine_segments hidden=segments;
        if (vector==1u) wanted.system[MACHINE_SYSTEM_DR0+6u]|=1ull<<13u;
        else if (!vector && write) wanted.system[MACHINE_SYSTEM_DR0+target]=target<6u ? value
            : target==6u ? (value&0xe00fu)|0xffff0ff0u : (value&0xffff23ffu)|0x400u;
        EXPECT(vm_debug_transfer(&memory,0u,&state,&segments,write,rank,value)
            ==(vector ? machine_result_make(MACHINE_RESULT_FAULT,vector) : 0u));
        EXPECT(!memcmp(&state,&wanted,sizeof state) && !memcmp(&segments,&hidden,sizeof hidden));
        if (vector) EXPECT(get(16u)==state.rip && get(24u)==vector);
        else if (!write) EXPECT(get(8u)==wanted.system[MACHINE_SYSTEM_DR0+target]);
        ++cases;
    }
    reset(0u,0u); machine_state before=state;
    put(0u,8u); EXPECT(vm_debug_transfer(&memory,0u,&state,&segments,1u,7u,0u)==5u);
    EXPECT(!memcmp(&state,&before,sizeof state)); put(0u,9u);
    EXPECT(vm_debug_transfer(&memory,1u,&state,&segments,1u,7u,0u)==6u);
    EXPECT(vm_debug_transfer(&memory,0u,&state,&segments,2u,7u,0u)==6u);
    EXPECT(vm_debug_transfer(&memory,0u,&state,&segments,1u,8u,0u)==6u);
    state.cr4|=8u; before=state;
    EXPECT(vm_debug_transfer(&memory,0u,&state,&segments,0u,4u,0u)==6u);
    EXPECT(!memcmp(&state,&before,sizeof state));
    if (failures) return 1;
    printf("Debug-register owner: %u model cases green; active breakpoint execution remains explicit\n",cases);
    return 0;
}
