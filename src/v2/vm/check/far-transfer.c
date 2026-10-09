#include <vm/control.h>
#include <machine/control.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536];static vm_memory_page pages[6];static vm_memory_branch branches[5];static vm_memory memory;
static machine_state cpu;static machine_segments segments;static vm_fault_delivery frontier;static unsigned checks,cases;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"far transfer line=%u case=%u\n",(unsigned)__LINE__,cases);return 1;}++checks;}while(0)
static void put(pl_u32 at,pl_u64 value,pl_u32 n){for(pl_u32 i=0u;i<n;++i)arena[at+i]=(pl_u8)(value>>(i*8u));}
static pl_u64 get(pl_u32 at,pl_u32 n){pl_u64 value=0u;for(pl_u32 i=0u;i<n;++i)value|=(pl_u64)arena[at+i]<<(i*8u);return value;}
static int reset(pl_u32 cpl,pl_u32 dpl,pl_u32 conform)
{
    memset(arena,0,sizeof arena);put(0u,9u,8u);put(4096u,0x2027u,8u);put(8192u,0x3027u,8u);put(12288u,0xe7u,8u);
    for(pl_u32 n=0u;n<6u;++n)pages[n]=(vm_memory_page){(n+1ull)*4096u,(n+1u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
    if(vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u))return 1;
    cpu=(machine_state){.cr0=0x80010011u,.cr3=0x1000u,.cr4=32u,.efer=0x500u,.rip=0x6000u,.rflags=0xa93u,.retired=42u};cpu.registers[4]=0x5e00u;
    cpu.system[MACHINE_SYSTEM_CS]=8u|cpl;cpu.system[MACHINE_SYSTEM_SS]=16u|cpl;cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4000u;cpu.system[MACHINE_SYSTEM_GDTR_LIMIT]=47u;
    segments=(machine_segments){.version=MACHINE_SEGMENTS_ABI_VERSION};segments.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu|(cpl<<5u)};
    segments.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,0xc093u|(cpl<<5u)};segments.cache[MACHINE_SEGMENT_TR]=(machine_segment_cache){0x6000u,103u,0x8bu};
    put(16384u+24u,0x00af9a000000ffffull|((pl_u64)dpl<<45u)|((pl_u64)conform<<42u),8u);
    put(16384u+32u,0x0000ec0000186789ull,8u);put(16384u+40u,0u,8u); // DPL3 gate -> selector24/offset0x6789.
    for(pl_u32 rank=0u;rank<3u;++rank)put(24576u+4u+rank*8u,0x5c08u-rank*64u,8u);
    frontier=(vm_fault_delivery){0};return 0;
}
int main(void)
{
    for(pl_u32 cpl=0u;cpl<4u;++cpl)for(pl_u32 rpl=0u;rpl<4u;++rpl)for(pl_u32 conform=0u;conform<2u;++conform)
    for(pl_u32 bytes=2u;bytes<=8u;bytes*=2u)for(pl_u32 call=0u;call<2u;++call){++cases;EXPECT(!reset(cpl,conform?0u:cpl,conform));machine_state old=cpu;
        pl_u64 target=0x12345678u&(~0ull>>(64u-bytes*8u));machine_result result=vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(bytes,call),target,24u|rpl,0x6004u);
        if(!conform&&rpl>cpl){EXPECT(result==107u);EXPECT(get(28u,4u)==24u);EXPECT(!memcmp(&cpu,&old,sizeof cpu));}
        else{EXPECT(!result);EXPECT(cpu.rip==target&&cpu.system[MACHINE_SYSTEM_CS]==(24u|cpl)&&cpu.rflags==old.rflags&&cpu.retired==old.retired);
            EXPECT(cpu.registers[4]==old.registers[4]-2u*bytes*call);if(call){EXPECT(get((pl_u32)old.registers[4]-bytes,bytes)==old.system[MACHINE_SYSTEM_CS]);EXPECT(get((pl_u32)old.registers[4]-2u*bytes,bytes)==(0x6004u&(~0ull>>(64u-bytes*8u))));}}
        EXPECT(!frontier.stage);
    }
    for(pl_u32 cpl=0u;cpl<4u;++cpl)for(pl_u32 conform=0u;conform<2u;++conform)for(pl_u32 call=0u;call<2u;++call){++cases;EXPECT(!reset(cpl,0u,conform));machine_state old=cpu;
        machine_result result=vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(4u,call),0x1234u,35u,0x6004u);
        if(!call&&!conform&&cpl){EXPECT(result==107u);EXPECT(get(28u,4u)==24u);EXPECT(!memcmp(&cpu,&old,sizeof cpu));}
        else{pl_u32 next=conform?cpl:0u,inner=call&&!conform&&cpl;pl_u64 sp=inner?0x5c08u:0x5e00u;EXPECT(!result);
            EXPECT(cpu.rip==0x6789u&&cpu.system[MACHINE_SYSTEM_CS]==(24u|next)&&cpu.registers[4]==sp-(call?(inner?32u:16u):0u));
            if(inner){EXPECT(cpu.system[MACHINE_SYSTEM_SS]==0u);EXPECT(get((pl_u32)sp-8u,8u)==old.system[MACHINE_SYSTEM_SS]);EXPECT(get((pl_u32)sp-16u,8u)==old.registers[4]);}
            if(call){EXPECT(get((pl_u32)sp-(inner?24u:8u),8u)==old.system[MACHINE_SYSTEM_CS]);EXPECT(get((pl_u32)sp-(inner?32u:16u),8u)==0x6004u);}}
        EXPECT(!frontier.stage);
    }
    // The first CS store aliases the already-validated code descriptor. The
    // later residency wait must retain the chosen code and completed store.
    ++cases;EXPECT(!reset(0u,0u,0u));cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4fe8u;cpu.registers[4]=0x5008u;
    put(20480u,0x00af9a000000ffffull,8u);pages[3].kind=VM_MEMORY_DEFERRED;machine_state old=cpu;
    EXPECT(vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,24u,0x6004u)==2u);
    EXPECT(!memcmp(&cpu,&old,sizeof cpu));EXPECT(frontier.pushed==1u&&get(20480u,8u)==8u);
    pages[3].kind=VM_MEMORY_RAM;EXPECT(!vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,24u,0x6004u));
    EXPECT(cpu.rip==0x1234u&&cpu.registers[4]==0x4ff8u&&get(20472u,8u)==0x6004u);EXPECT(!frontier.stage);
    ++cases;EXPECT(!reset(0u,0u,0u));old=cpu;EXPECT(vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,0u,0x6004u)==107u);EXPECT(!memcmp(&cpu,&old,sizeof cpu));
    // Code Accessed is visible before target #GP. CALL also writes its frame,
    // without publishing architectural RSP/CS/RIP on the failed transfer.
    for(pl_u32 call=0u;call<2u;++call){++cases;EXPECT(!reset(0u,0u,0u));old=cpu;
        EXPECT(vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,call),0x800000000000ull,24u,0x6004u)==107u);
        EXPECT(!memcmp(&cpu,&old,sizeof cpu));EXPECT(get(16384u+29u,1u)==0x9bu);EXPECT(!frontier.stage);
        EXPECT(get(0x5df8u,8u)==(call?8u:0u));EXPECT(get(0x5df0u,8u)==(call?0x6004u:0u));
    }
    // Every retained phase has a deterministic retry; no completed descriptor
    // access or frame store is replayed, even if the consumed bytes change.
    for(pl_u32 phase=0u;phase<5u;++phase){++cases;EXPECT(!reset(3u,0u,0u));old=cpu;
        pl_u32 page=3u,stage=1u;
        if(phase==1u){cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4fd8u;old=cpu;put(0x4ff0u,0x00af9a000000ffffull,8u);
            put(0x4ff8u,0x0000ec0000186789ull,8u);put(0x5000u,0u,8u);page=4u;stage=2u;}
        else if(phase==2u){pages[3].rights=1u;stage=4u;}
        else if(phase==3u){page=5u;stage=5u;}
        else if(phase==4u){page=4u;stage=6u;}
        if(phase!=2u)pages[page].kind=VM_MEMORY_DEFERRED;
        EXPECT(vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,35u,0x6004u)==2u);
        EXPECT(frontier.stage==stage);EXPECT(!memcmp(&cpu,&old,sizeof cpu));EXPECT(!memory.reservation.parts);
        // A repeated wait is identical, rather than advancing a hidden cursor.
        vm_fault_delivery saved=frontier;
        EXPECT(vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,35u,0x6004u)==2u);
        EXPECT(!memcmp(&frontier,&saved,sizeof saved));
        pages[page].kind=VM_MEMORY_RAM;pages[page].rights=3u;
        EXPECT(!vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,35u,0x6004u));
        EXPECT(cpu.rip==0x6789u&&cpu.registers[4]==0x5be8u&&cpu.system[MACHINE_SYSTEM_CS]==24u&&cpu.system[MACHINE_SYSTEM_SS]==0u);
        EXPECT(!frontier.stage&&!memory.reservation.parts);
    }
    for(pl_u32 bad=0u;bad<17u;++bad){++cases;EXPECT(!reset(3u,0u,0u));pages[3].kind=VM_MEMORY_DEFERRED;
        EXPECT(vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,35u,0x6004u)==2u);
        pl_u32 word=machine_transfer_word(8u,1u),selector=35u,at=0u;pl_u64 target=0x1234u,next=0x6004u;
        switch(bad){case 0:++target;break;case 1:--selector;break;case 2:++next;break;case 3:word^=4u;break;
        case 4:++cpu.rip;break;case 5:++cpu.rflags;break;case 6:++cpu.registers[4];break;case 7:cpu.system[MACHINE_SYSTEM_SS]^=8u;break;
        case 8:cpu.system[MACHINE_SYSTEM_CS]^=8u;break;case 9:cpu.cr0^=8u;break;case 10:cpu.cr3^=4096u;break;
        case 11:cpu.cr4^=128u;break;case 12:cpu.efer^=2048u;break;case 13:++frontier.generation;break;
        case 14:put(0u,8u,8u);break;case 15:word=3u;break;default:at=1u;break;}
        old=cpu;machine_result expected=bad==14u?MACHINE_RESULT_STALE_GENERATION:MACHINE_RESULT_ENTRY_MAP;
        EXPECT(vm_far_transfer(&memory,at,&cpu,&segments,&frontier,word,target,selector,next)==expected);
        EXPECT(!frontier.stage&&!memory.reservation.parts);EXPECT(!memcmp(&cpu,&old,sizeof cpu));
    }
    // Selector/gate failures do not publish CPU state. Required table halves
    // and reserved high bits are checked before following the destination.
    for(pl_u32 bad=0u;bad<7u;++bad){++cases;EXPECT(!reset(3u,0u,0u));old=cpu;pl_u32 vector=13u,error=32u;
        switch(bad){case 0:put(0x4025u,0x6cu,1u);vector=11u;break;case 1:put(0x4025u,0x8cu,1u);break;
        case 2:cpu.system[MACHINE_SYSTEM_GDTR_LIMIT]=39u;old=cpu;break;case 3:put(0x4028u,1ull<<32u,8u);break;
        case 4:put(0x4022u,0u,2u);error=0u;break;case 5:put(0x401du,0x1au,1u);vector=11u;error=24u;break;
        default:put(0x401du,0x92u,1u);error=24u;break;}
        EXPECT(vm_far_transfer(&memory,0u,&cpu,&segments,&frontier,machine_transfer_word(8u,1u),0x1234u,35u,0x6004u)==machine_result_make(MACHINE_RESULT_FAULT,vector));
        EXPECT(get(28u,4u)==error&&!frontier.stage);EXPECT(!memcmp(&cpu,&old,sizeof cpu));
    }
    printf("far transfer: %u cases/%u full-state/frame/fault/gate/alias-wait assertions; independent CPU oracle separate\n",cases,checks);return 0;
}
