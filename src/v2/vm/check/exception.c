#include <vm/exception.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536];
static vm_memory_page pages[7];
static vm_memory_branch branches[6];
static vm_memory memory;
static machine_state cpu, before;
static machine_segments segments;
static vm_fault_delivery delivery;
static unsigned failures, cases;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"exception: line %u case %u\n",(unsigned)__LINE__,cases); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value)
{ for (pl_u32 i=0u;i<8u;++i) arena[at+i]=(pl_u8)(value>>(i*8u)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 v=0u; for(pl_u32 i=0u;i<8u;++i)v|=(pl_u64)arena[at+i]<<(i*8u);return v; }
static pl_u32 stack_offset(pl_u64 at)
{ return 24576u+(pl_u32)(at & 4095u); }
static void reset(pl_u64 rsp, pl_u64 rip, pl_u64 flags, pl_u32 vector, pl_u32 gate)
{
    memset(arena,0,sizeof arena);
    put(0u,9u); put(16u,0x400000u); put(24u,(pl_u64)(vector==14u?2u:0u)<<32u|vector);
    put(4096u,0x2023u); put(8192u,0x3023u); put(12288u,0xe3u);
    put(16384u+8u,0x00af9b000000ffffull); put(16384u+16u,0x00cf93000000ffffull);
    put(20480u+vector*16u,0x9000u|8ull<<16u|(pl_u64)gate<<40u);
    const pl_u64 addresses[]={0x1000u,0x2000u,0x3000u,0x4000u,0x5000u,rsp&~4095ull};
    for(pl_u32 i=0u;i<6u;++i)pages[i]=(vm_memory_page){addresses[i],4096u+i*4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,7u,branches,9u));
    cpu=(machine_state){0}; cpu.cr0=0x80010011u;cpu.cr3=0x1000u;cpu.cr4=32u;cpu.efer=0x500u;
    cpu.rip=rip;cpu.rflags=flags;cpu.registers[4]=rsp;cpu.retired=123u;
    cpu.system[MACHINE_SYSTEM_CS]=8u;cpu.system[MACHINE_SYSTEM_SS]=16u;
    cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4000u;cpu.system[MACHINE_SYSTEM_GDTR_LIMIT]=23u;
    cpu.system[MACHINE_SYSTEM_IDTR_BASE]=0x5000u;cpu.system[MACHINE_SYSTEM_IDTR_LIMIT]=4095u;
    cpu.system[MACHINE_SYSTEM_CR2]=0xabcdefu;
    segments=(machine_segments){0};segments.version=1u;
    segments.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu};
    segments.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,0xc093u};
    delivery=(vm_fault_delivery){0};before=cpu;
}
static void check_case(const pl_u64 *row)
{
    pl_u32 kind=(pl_u32)row[0]>>5u, vector=kind==0u?14u:kind==1u?6u:13u;
    if(kind==3u)return; /* INT3 is a trap, not the pending-fault API. */
    pl_u32 gate=0x8eu+((pl_u32)row[0]>>4u&1u), first=kind==1u?0u:1u;
    pl_u64 rip=row[6u+first];
    reset(row[1],rip,row[2],vector,gate);
    EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery));
    EXPECT(cpu.registers[4]==row[3] && cpu.rflags==row[4]);
    EXPECT(cpu.rip==0x9000u && cpu.system[MACHINE_SYSTEM_CS]==8u && cpu.retired==123u);
    EXPECT(cpu.system[MACHINE_SYSTEM_CR2]==row[12]);
    pl_u32 words=kind==1u?5u:6u;
    for(pl_u32 i=0u;i<words;++i)EXPECT(get(stack_offset(cpu.registers[4])+i*8u)==row[6u+i]);
    if(first)cpu.registers[4]+=8u;
    /* The oracle's #UD/#GP handler advances RIP; #PF retries the same store. */
    if(kind)put(stack_offset(cpu.registers[4]),rip+2u);
    EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments));
    EXPECT(cpu.registers[4]==row[14] && cpu.rflags==(row[13]|0x10000u));
    /* A successful ordinary instruction clears restored RF; IRETQ itself
     * does not. The system oracle records after its retried/skipped cut. */
    EXPECT((cpu.rflags&~0x10000ull)==row[13]);
    EXPECT(cpu.rip==rip+(kind?2u:0u) && cpu.retired==123u);
    ++cases;
}
int main(int argc,char **argv)
{
    if(argc==2){
        FILE *input=fopen(argv[1],"r");if(!input)return 2;
        unsigned rows=0u; pl_u64 row[15];
        for (;;) {
            unsigned i;
            for (i=0u;i<15u;++i) if (fscanf(input,"%llx",&row[i])!=1) break;
            if (!i) break;
            if (i!=15u) { fclose(input);return 2; }
            check_case(row); ++rows;
        }
        fclose(input);EXPECT(rows==128u && cases==96u);
    }else{
        /* Kernel-shaped successful entry/return and exact pending failures. */
        for(pl_u32 gate=0x8eu;gate<=0x8fu;++gate)for(pl_u32 alignment=0u;alignment<16u;++alignment){
            reset(0x108f00u-alignment,0x1000204u,0x603u,14u,gate);
            EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery));
            EXPECT(cpu.registers[4]==((before.registers[4]&~15ull)-48u));
            EXPECT(cpu.rflags==(gate==0x8eu?0x403u:0x603u));
            EXPECT(get(stack_offset(cpu.registers[4]))==2u && cpu.retired==before.retired);
            cpu.registers[4]+=8u;EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments));
            EXPECT(cpu.rip==before.rip && cpu.registers[4]==before.registers[4] && cpu.rflags==0x10603u);
            ++cases;
        }
    }
    reset(0x108f00u,0x1000204u,2u,14u,0x8fu);
    pages[4].kind=VM_MEMORY_DEFERRED;
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==2u);
    EXPECT(cpu.system[MACHINE_SYSTEM_CR2]==0x400000u && delivery.stage==1u && !delivery.pushed);
    EXPECT(cpu.rip==before.rip && cpu.registers[4]==before.registers[4]);
    pages[4].kind=VM_MEMORY_RAM;pages[5].kind=VM_MEMORY_DEFERRED;
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==2u && delivery.stage==4u);
    put(24u,0u); /* The original fault remains C-owned after a page wait. */
    pages[5].kind=VM_MEMORY_RAM;
    EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery) && !delivery.stage);
    EXPECT(get(stack_offset(cpu.registers[4]))==2u);
    reset(0x108f00u,0x1000204u,2u,14u,0x8fu);
    put(20480u+14u*16u,0x9000u|8ull<<16u|0x0full<<40u);
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==91u);
    EXPECT(get(24u)==(114ull<<32u|11u) && !delivery.stage);
    EXPECT(cpu.rip==before.rip && cpu.registers[4]==before.registers[4]);
    reset(0x108f00u,0x1000204u,2u,14u,0x8fu);
    arena[20480u+14u*16u+4u]=1u;
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==6u && !delivery.stage);
    reset(0x108f00u,0x1000204u,2u,14u,0x8fu);put(0u,8u);
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==5u && !delivery.stage);
    /* A two-page frame aliases and overwrites its own IDT gate before the
     * lower stack page is supplied. Resume must retain the already-read gate,
     * not reconstruct/replay the event from a now-different descriptor. */
    reset(0x108010u,0x1000204u,2u,0u,0x8fu);
    pages[5].offset=20480u;
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,7u,branches,9u));
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==2u);
    EXPECT(delivery.stage==4u && delivery.pushed==2u && get(20480u)==0x108010u);
    EXPECT(cpu.rip==before.rip && cpu.registers[4]==before.registers[4]);
    EXPECT(!vm_memory_append(&memory,0x107000u,(pl_u32)memory.next_offset,3u));
    EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery) && !delivery.stage);
    EXPECT(cpu.rip==0x9000u && cpu.registers[4]==0x107fe8u && cpu.retired==123u);
    reset(0x108f00u,0x1000204u,2u,14u,0x8fu);
    cpu.registers[4]=0x800000000001ull;before=cpu;
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==99u && !delivery.stage);
    EXPECT(cpu.rip==before.rip && cpu.registers[4]==before.registers[4]);
    if(failures)return 1;
    printf("Long-mode CPL0 fault/IRETQ: %u cases green; TSS/IST/outer/secondary escalation NOT tested\n",cases);
    return 0;
}
