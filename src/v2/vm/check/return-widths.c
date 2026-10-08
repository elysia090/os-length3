#include <vm/control.h>
#include <vm/exception.h>
#include <machine/control.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536];static vm_memory_page pages[6];static vm_memory_branch branches[6];static vm_memory memory;
static machine_state cpu;static machine_segments segments;static unsigned failures,returns,faults;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"return widths: line %u\n",(unsigned)__LINE__);++failures;}}while(0)
static void put(pl_u32 at,pl_u64 value,pl_u32 bytes)
{for(pl_u32 i=0u;i<bytes;++i)arena[at+i]=(pl_u8)(value>>(i*8u));}
static void reset(pl_u32 cpl,pl_u32 rpl,pl_u32 bytes,pl_u32 interrupt,pl_u32 discard,pl_u32 iopl)
{
    memset(arena,0,sizeof arena);put(0u,9u,8u);put(4096u,0x2027u,8u);put(8192u,0x3027u,8u);put(12288u,0xe7u,8u);
    put(16384u+24u,0x00af9a000000ffffull|((pl_u64)rpl<<45u),8u);put(16384u+32u,0x00cf92000000ffffull|((pl_u64)rpl<<45u),8u);
    for(pl_u32 i=0u;i<6u;++i)pages[i]=(vm_memory_page){(i+1ull)*4096u,4096u+i*4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u));
    cpu=(machine_state){0};cpu.cr0=0x80010011u;cpu.cr3=0x1000u;cpu.cr4=32u;cpu.efer=0x500u;
    cpu.rip=0x6000u;cpu.rflags=2u|((pl_u64)iopl<<12u)|0x300000u;cpu.registers[4]=0x5e00u;cpu.retired=123u;
    cpu.system[MACHINE_SYSTEM_CS]=8u|cpl;cpu.system[MACHINE_SYSTEM_SS]=16u|cpl;
    cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4000u;cpu.system[MACHINE_SYSTEM_GDTR_LIMIT]=39u;
    segments=(machine_segments){.version=MACHINE_SEGMENTS_ABI_VERSION};
    for(pl_u32 i=0u;i<MACHINE_SEGMENT_COUNT;++i)segments.cache[i].attributes=MACHINE_SEGMENT_UNUSABLE;
    segments.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu|(cpl<<5u)};
    segments.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,0xc093u|(cpl<<5u)};
    pl_u32 at=20480u+0xe00u;put(at,0x123456u,bytes);put(at+bytes,24u|rpl,2u);
    if(interrupt){put(at+2u*bytes,0x1d7fd5u,bytes);at+=3u*bytes;}
    else at+=2u*bytes+discard;
    put(at,0x654321u,bytes);put(at+bytes,32u|rpl,2u);
}
int main(void)
{
    for(pl_u32 interrupt=0u;interrupt<2u;++interrupt)for(pl_u32 bytes=2u;bytes<=8u;bytes*=2u)
    for(pl_u32 cpl=0u;cpl<4u;++cpl)for(pl_u32 rpl=cpl;rpl<4u;++rpl)for(pl_u32 iopl=0u;iopl<4u;++iopl)
    for(pl_u32 discard=0u;discard<(interrupt?1u:2u);++discard){pl_u32 drop=discard?7u:0u;
        reset(cpl,rpl,bytes,interrupt,drop,iopl);machine_state expected=cpu;machine_segments hidden=segments;
        pl_u64 narrow=~0ull>>(64u-bytes*8u);expected.rip=0x123456u&narrow;expected.system[MACHINE_SYSTEM_CS]=24u|rpl;
        hidden.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu|(rpl<<5u)};
        if(interrupt||rpl>cpl){expected.registers[4]=(0x654321u&narrow)+(interrupt?0u:drop);
            expected.system[MACHINE_SYSTEM_SS]=32u|rpl;hidden.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,0xc093u|(rpl<<5u)};}
        else expected.registers[4]+=2u*bytes+drop;
        if(interrupt){pl_u64 mask=0x4dd5u;if(bytes!=2u)mask|=0x250000u;if(cpl<=iopl)mask|=0x200u;
            if(!cpl){mask|=0x3000u;if(bytes!=2u)mask|=0x180000u;}
            expected.rflags=(0x1d7fd5u&narrow&mask)|(expected.rflags&~mask&0x3f7fd5u)|2u;}
        machine_result result=interrupt?vm_interrupt_return(&memory,0u,&cpu,&segments,machine_return_word(bytes,0u)):
            vm_far_return(&memory,0u,&cpu,&segments,machine_return_word(bytes,drop));
        EXPECT(!result);EXPECT(!memcmp(&cpu,&expected,sizeof cpu));EXPECT(!memcmp(&segments,&hidden,sizeof segments));++returns;
        reset(cpl,rpl,bytes,interrupt,drop,iopl);machine_state old=cpu;machine_segments caches=segments;put(20480u+0xe00u+bytes,3u,2u);
        result=interrupt?vm_interrupt_return(&memory,0u,&cpu,&segments,machine_return_word(bytes,0u)):
            vm_far_return(&memory,0u,&cpu,&segments,machine_return_word(bytes,drop));
        EXPECT(result==107u);EXPECT(!memcmp(&cpu,&old,sizeof cpu)&&!memcmp(&segments,&caches,sizeof segments));++faults;
    }
    if(failures)return 1;
    printf("Return widths: %u full-state same/outer/CPL/IOPL/parameter models, %u preserved-state null-selector faults\n",returns,faults);return 0;
}
