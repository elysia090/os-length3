#include <vm/exception.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536];
static vm_memory_page pages[7];
static vm_memory_branch branches[6];
static vm_memory memory;
static machine_state cpu, before;
static machine_segments segments, old_segments;
static unsigned failures, returns, faults, waits, frame_boundaries;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"iret: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) arena[at+i]=(pl_u8)(value>>(i*8u)); }
static void reset(pl_u32 cpl, pl_u32 accessed)
{
    memset(arena,0,sizeof arena);put(0u,9u);
    put(4096u,0x2023u);put(8192u,0x3023u);put(12288u,0xe3u);
    put(16384u+24u,0x00af9a000000ffffull|((pl_u64)cpl<<45u)|((pl_u64)accessed<<40u));
    put(16384u+32u,0x00cf92000000ffffull|((pl_u64)cpl<<45u)|((pl_u64)accessed<<40u));
    for(pl_u32 i=0u;i<6u;++i)pages[i]=(vm_memory_page){(i+1ull)*4096u,4096u+i*4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,7u,branches,9u));
    cpu=(machine_state){0};cpu.cr0=0x80010011u;cpu.cr3=0x1000u;cpu.cr4=32u;cpu.efer=0x500u;
    cpu.rip=0x6000u;cpu.rflags=2u;cpu.registers[4]=0x5e00u;cpu.retired=123u;
    cpu.system[MACHINE_SYSTEM_CS]=8u;cpu.system[MACHINE_SYSTEM_SS]=16u;
    cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4000u;cpu.system[MACHINE_SYSTEM_GDTR_LIMIT]=39u;
    segments=(machine_segments){.version=MACHINE_SEGMENTS_ABI_VERSION,.interrupt_shadow=MACHINE_SHADOW_STI};
    segments.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu};
    segments.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,0xc093u};
    for(pl_u32 i=0u;i<=MACHINE_SEGMENT_GS;++i)if(i!=MACHINE_SEGMENT_CS&&i!=MACHINE_SEGMENT_SS) {
        cpu.system[MACHINE_SYSTEM_ES+i]=16u;
        segments.cache[i]=(machine_segment_cache){0x12345000u+i*4096u,0xffffffffu,0xc093u};
    }
    put(20480u+0xe00u,0x600100u);put(20480u+0xe08u,24u|cpl);put(20480u+0xe10u,0x10603u);
    put(20480u+0xe18u,0x800000000000ull);put(20480u+0xe20u,32u|cpl);
    before=cpu;old_segments=segments;
}
int main(void)
{
    for(pl_u32 cpl=1u;cpl<=3u;++cpl)for(pl_u32 accessed=0u;accessed<2u;++accessed) {
        reset(cpl,accessed);machine_state expected=cpu;machine_segments hidden=segments;
        expected.rip=0x600100u;expected.registers[4]=0x800000000000ull;expected.rflags=0x10603u;
        expected.system[MACHINE_SYSTEM_CS]=24u|cpl;expected.system[MACHINE_SYSTEM_SS]=32u|cpl;
        hidden.interrupt_shadow=0u;hidden.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu|cpl<<5u};
        hidden.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,0xc093u|cpl<<5u};
        for(pl_u32 i=0u;i<=MACHINE_SEGMENT_GS;++i)if(i!=MACHINE_SEGMENT_CS&&i!=MACHINE_SEGMENT_SS) {
            expected.system[MACHINE_SYSTEM_ES+i]=0u;
            hidden.cache[i].attributes=(hidden.cache[i].attributes&~128u)|MACHINE_SEGMENT_UNUSABLE;
        }
        EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments));
        EXPECT(!memcmp(&cpu,&expected,sizeof cpu)&&!memcmp(&segments,&hidden,sizeof segments));
        EXPECT(arena[16384u+29u]==(0x9bu|cpl<<5u)&&arena[16384u+37u]==(0x93u|cpl<<5u));++returns;
    }
    /* A later stack fault must retain the already-completed CS Accessed write,
     * but not publish any architectural register, hidden cache or retirement. */
    reset(3u,0u);arena[16384u+37u]&=127u;
    EXPECT(vm_interrupt_return(&memory,0u,&cpu,&segments)==99u);
    EXPECT(arena[16384u+29u]==0xfbu&&arena[16384u+37u]==0x72u);
    EXPECT(!memcmp(&cpu,&before,sizeof cpu)&&!memcmp(&segments,&old_segments,sizeof segments));++faults;
    reset(3u,0u);put(20480u+0xe00u,0x800000000000ull);
    EXPECT(vm_interrupt_return(&memory,0u,&cpu,&segments)==107u);
    EXPECT(arena[16384u+29u]==0xfbu&&arena[16384u+37u]==0xf3u);
    EXPECT(!memcmp(&cpu,&before,sizeof cpu)&&!memcmp(&segments,&old_segments,sizeof segments));++faults;
    for(pl_u32 rank=3u;rank<=4u;++rank) {
        reset(3u,0u);pages[rank].kind=VM_MEMORY_DEFERRED;
        EXPECT(vm_interrupt_return(&memory,0u,&cpu,&segments)==2u);
        EXPECT(!memcmp(&cpu,&before,sizeof cpu)&&!memcmp(&segments,&old_segments,sizeof segments));
        pages[rank].kind=VM_MEMORY_RAM;EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments));++waits;
    }
    /* Last-page SS selector has only two significant bytes. Null CS must
     * fault before the absent outer stack operands; otherwise SS is read
     * before RSP, including exact cross-page #PF linear provenance. */
    for(pl_u32 invalid=0u;invalid<2u;++invalid)for(pl_u32 align=0u;align<16u;++align) {
        reset(3u,0u);EXPECT(!vm_memory_append(&memory,0x7000u,(pl_u32)memory.next_offset,3u));
        put(12288u,0x7023u);put(28672u+4u*8u,0x4023u);put(28672u+511u*8u,0x5023u);
        cpu.registers[4]=0x1fffe8u-align;before=cpu;
        pl_u32 at=20480u+(pl_u32)(cpu.registers[4]&4095u);
        put(at,0x600100u);put(at+8u,invalid?3u:27u);put(at+16u,0x603u);put(at+24u,0x7e00u);put(at+32u,35u);
        machine_result result=vm_interrupt_return(&memory,0u,&cpu,&segments);
        if(invalid||align<10u) {
            EXPECT(result==(invalid?107u:115u));
            EXPECT(!memcmp(&cpu,&before,sizeof cpu)&&!memcmp(&segments,&old_segments,sizeof segments));
            pl_u64 address=cpu.rip;
            if(!invalid)address=cpu.registers[4]+32u<0x200000u?0x200000u:cpu.registers[4]+32u;
            pl_u64 reported=0u;for(pl_u32 i=0u;i<8u;++i)reported|=(pl_u64)arena[16u+i]<<(i*8u);
            EXPECT(reported==address);EXPECT(arena[16384u+29u]==(invalid?0xfau:0xfbu));
        }else EXPECT(!result&&cpu.rip==0x600100u&&cpu.registers[4]==0x7e00u&&cpu.retired==123u);
        ++frame_boundaries;
    }
    if(failures)return 1;
    printf("CPL0 outer IRETQ: %u full-state returns, %u precise descriptor/target faults, %u residency retries, %u frame-boundary models; no Linux boot claim\n",returns,faults,waits,frame_boundaries);
    return 0;
}
