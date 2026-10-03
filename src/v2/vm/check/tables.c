#include <vm/tables.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536], saved[8192];
static vm_memory memory;
static vm_memory_page pages[6];
static vm_memory_branch branches[5];
static machine_state state;
static vm_table_frontier frontier;
static unsigned failures, writes;
static const pl_u32 port=2048u;
static const pl_u64 base=0x400000u;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"tables: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ for (unsigned i=0u;i<8u;++i) arena[at+i]=(pl_u8)(value>>(8u*i)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 value=0u; for (unsigned i=0u;i<8u;++i) value|=(pl_u64)arena[at+i]<<(8u*i); return value; }
static void watch(void *owner, pl_u32 at, pl_u32 bytes)
{ (void)owner; (void)bytes; if (at>=28672u) ++writes; }
static void reset(unsigned resident_second)
{
    memset(arena,0,sizeof arena); memset(arena+28672u,0xa5,8192u); put(port,9u);
    for (unsigned i=0u;i<4u;++i) {
        pages[i]=(vm_memory_page){(i+1ull)*4096u,(i+2u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
        put(pages[i].offset+(i==2u ? 16u : 0u),(i==3u ? 0x8000u : (i+2ull)*4096u)|0x67u);
    }
    put(20488u,0x9067u);
    pages[4]=(vm_memory_page){0x8000u,28672u,3u,VM_MEMORY_RAM,0u,0u};
    pages[5]=(vm_memory_page){0x9000u,32768u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,5u+resident_second,6u,branches,9u));
    memory.before_write=watch; writes=0u; frontier=(vm_table_frontier){0};
    state=(machine_state){.cr0=0x80010001u,.cr3=0x1000u,.cr4=32u,.efer=0xd00u,.rip=0x1234u,.rflags=0x10002u};
    state.system[MACHINE_SYSTEM_CS]=8u;
    state.system[MACHINE_SYSTEM_GDTR_BASE]=0x0123456789abcdefull;
    state.system[MACHINE_SYSTEM_GDTR_LIMIT]=0xfedcu;
    state.system[MACHINE_SYSTEM_IDTR_BASE]=0xffff800000123456ull;
    state.system[MACHINE_SYSTEM_IDTR_LIMIT]=0x4321u;
}
static void fault(machine_result result, pl_u32 vector, pl_u64 address, pl_u32 error)
{
    EXPECT(result==machine_result_make(MACHINE_RESULT_FAULT,vector));
    EXPECT(get(port+16u)==address && get(port+24u)==((pl_u64)error<<32u|vector));
}
int main(void)
{
    unsigned cases=0u;
    for (unsigned table=0u;table<2u;++table)
    for (unsigned offset=4085u;offset<4096u;++offset)
    for (unsigned cpl=0u;cpl<4u;++cpl)
    for (unsigned umip=0u;umip<2u;++umip)
    for (unsigned protection=0u;protection<3u;++protection) {
        reset(1u); state.system[MACHINE_SYSTEM_CS]|=cpl; state.cr4|=(pl_u64)umip<<11u;
        unsigned slot=table ? MACHINE_SYSTEM_IDTR_BASE : MACHINE_SYSTEM_GDTR_BASE;
        if (protection) put(20488u,protection==1u ? 0u : 0x9065u);
        machine_state before=state; memcpy(saved,arena+28672u,sizeof saved);
        machine_result result=vm_table_transfer(&memory,port,&state,&frontier,base+offset,table,2u);
        EXPECT(!memcmp(&state,&before,sizeof state)); EXPECT(!frontier.stage);
        if (umip && cpl) fault(result,13u,state.rip,0u);
        else if (protection && offset>=4087u) {
            fault(result,14u,base+4096u,(protection==2u ? 1u : 0u)|2u|(cpl==3u ? 4u : 0u));
            /* A complete limit store survives a later base fault. A limit
             * that itself crosses the protected page has not committed. */
            if (offset<=4094u) for (unsigned i=0u;i<2u;++i)
                saved[offset+i]=(pl_u8)(state.system[slot+1u]>>(8u*i));
        } else {
            EXPECT(!result);
            for (unsigned i=0u;i<10u;++i) saved[offset+i]=(pl_u8)
                ((i<2u ? state.system[slot+1u] : state.system[slot])>>(i<2u ? 8u*i : 8u*(i-2u)));
        }
        EXPECT(!memcmp(saved,arena+28672u,sizeof saved)); ++cases;
    }
    /* Physical supply resumes at the next store, never replaying the limit. */
    for (unsigned table=0u;table<2u;++table)
    for (unsigned offset=4087u;offset<4096u;++offset) {
        reset(0u); machine_state before=state;
        EXPECT(vm_table_transfer(&memory,port,&state,&frontier,base+offset,table,2u)==MACHINE_RESULT_BARRIER);
        EXPECT(frontier.stage==(offset<=4094u ? 2u : 1u));
        unsigned committed=writes;
        EXPECT(committed==(offset<=4094u ? 1u : 0u));
        EXPECT(get(port+32u)==0x9000u && (pl_u32)get(port+40u)>0u);
        EXPECT(!memcmp(&state,&before,sizeof state));
        EXPECT(!vm_memory_append(&memory,0x9000u,32768u,3u));
        EXPECT(!vm_table_transfer(&memory,port,&state,&frontier,base+offset,table,2u));
        EXPECT(!frontier.stage && writes==3u-(offset==4094u ? 1u : 0u));
        EXPECT(!memcmp(&state,&before,sizeof state)); ++cases;
    }
    /* A mismatched suspended transfer cannot finish another instruction. */
    for (unsigned field=0u;field<12u;++field) {
        reset(0u);
        EXPECT(vm_table_transfer(&memory,port,&state,&frontier,base+4094u,0u,2u)==MACHINE_RESULT_BARRIER);
        machine_state before=state; unsigned committed=writes;
        pl_u64 address=base+4094u; pl_u32 table=0u, access=2u;
        switch (field) {
        case 0u: ++state.rip; break; case 1u: state.rflags^=1u; break;
        case 2u: state.cr0^=16u; break; case 3u: state.cr3^=8u; break;
        case 4u: state.cr4^=128u; break; case 5u: state.efer^=2048u; break;
        case 6u: state.system[MACHINE_SYSTEM_CS]^=1u; break;
        case 7u: ++state.system[MACHINE_SYSTEM_GDTR_BASE]; break;
        case 8u: ++state.system[MACHINE_SYSTEM_GDTR_LIMIT]; break;
        case 9u: ++address; break; case 10u: table=1u; break; default: access=1u; break;
        }
        before=state;
        EXPECT(vm_table_transfer(&memory,port,&state,&frontier,address,table,access)==MACHINE_RESULT_ENTRY_MAP);
        EXPECT(!frontier.stage && writes==committed && !memcmp(&state,&before,sizeof state)); ++cases;
    }
    if (!failures) printf("C descriptor transfer: %u state/fault/wait models green (not a native ISA oracle)\n",cases);
    return failures ? 1 : 0;
}
