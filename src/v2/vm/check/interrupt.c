/* Architectural IF/shadow matrix; the independent system oracle is separate. */
#include <vm/interrupt.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[8192];
static machine_state state;
static machine_segments segments;
static unsigned failures,cases;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"interrupt: line %u case %u\n",(unsigned)__LINE__,cases); ++failures; } } while (0)
static void put(pl_u32 at,pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) arena[at+i]=(pl_u8)(value>>(i*8u)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 v=0u;for(pl_u32 i=0u;i<8u;++i)v|=(pl_u64)arena[at+i]<<(i*8u);return v; }
static void reset(void)
{
    memset(arena,0,sizeof arena);put(0u,9u);
    state=(machine_state){0};state.cr0=0x80010011u;state.cr4=32u;state.efer=0x500u;
    state.rip=0x400000u;state.retired=123u;state.system[MACHINE_SYSTEM_CS]=8u;
    segments=(machine_segments){0};segments.version=MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu;
}
int main(void)
{
    vm_memory memory;
    vm_memory_page page={0x1000u,4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,&page,1u,1u,NULL,9u));
    const pl_u64 arithmetic[]={0u,1u,0x44u,0x880u};
    for(pl_u32 enable=0u;enable<2u;++enable)for(pl_u32 cpl=0u;cpl<4u;++cpl)
    for(pl_u32 iopl=0u;iopl<4u;++iopl)for(pl_u32 old_if=0u;old_if<2u;++old_if)
    for(pl_u32 shadow=0u;shadow<=MACHINE_SHADOW_STI;++shadow)for(pl_u32 n=0u;n<4u;++n){
        reset();state.system[MACHINE_SYSTEM_CS]|=cpl;
        state.rflags=0x10002u|arithmetic[n]|(pl_u64)iopl<<12u|(pl_u64)old_if<<9u;
        segments.interrupt_shadow=shadow;
        machine_state wanted=state;machine_segments hidden=segments;
        if(cpl<=iopl){
            wanted.rflags=enable ? state.rflags|0x200u : state.rflags&~0x200ull;
            if(enable && !old_if && !shadow)hidden.interrupt_shadow=MACHINE_SHADOW_STI;
        }
        EXPECT(vm_interrupt_flag(&memory,0u,&state,&segments,enable)
            ==(cpl>iopl ? machine_result_make(MACHINE_RESULT_FAULT,13u) : 0u));
        EXPECT(!memcmp(&state,&wanted,sizeof state));
        EXPECT(!memcmp(&segments,&hidden,sizeof segments));
        if(cpl>iopl)EXPECT(get(16u)==state.rip && get(24u)==13u);
        ++cases;
    }
    for(pl_u32 bad=0u;bad<8u;++bad){
        reset();state.rflags=0x10002u;
        pl_u32 port=0u,enable=1u;
        switch(bad){
        case 0u:segments.version=1u;break;
        case 1u:segments.interrupt_shadow=3u;break;
        case 2u:state.cr4|=2u;break;
        case 3u:state.rflags|=0x100u;break;
        case 4u:state.rflags|=0x20000u;break;
        case 5u:segments.cache[MACHINE_SEGMENT_CS].attributes|=0x4000u;break;
        case 6u:port=1u;break;
        default:enable=2u;break;
        }
        machine_state before=state;machine_segments hidden=segments;
        EXPECT(vm_interrupt_flag(&memory,port,&state,&segments,enable)==MACHINE_RESULT_ENTRY_MAP);
        EXPECT(!memcmp(&state,&before,sizeof state) && !memcmp(&segments,&hidden,sizeof segments));
    }
    reset();state.rflags=0x10002u;put(0u,8u);machine_state before=state;
    EXPECT(vm_interrupt_flag(&memory,0u,&state,&segments,1u)==MACHINE_RESULT_STALE_GENERATION);
    EXPECT(!memcmp(&state,&before,sizeof state) && !segments.interrupt_shadow);
    if(failures)return 1;
    printf("IF/shadow owner: %u model cases, 8 profile refusals and stale generation green; no system-oracle claim\n",cases);
    return 0;
}
