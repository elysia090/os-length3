#include <vm/exception.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536];
static vm_memory_page pages[8];
static vm_memory_branch branches[7];
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
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,8u,branches,9u));
    cpu=(machine_state){0}; cpu.cr0=0x80010011u;cpu.cr3=0x1000u;cpu.cr4=32u;cpu.efer=0x500u;
    cpu.rip=rip;cpu.rflags=flags;cpu.registers[4]=rsp;cpu.retired=123u;
    cpu.system[MACHINE_SYSTEM_CS]=8u;cpu.system[MACHINE_SYSTEM_SS]=16u;
    cpu.system[MACHINE_SYSTEM_GDTR_BASE]=0x4000u;cpu.system[MACHINE_SYSTEM_GDTR_LIMIT]=23u;
    cpu.system[MACHINE_SYSTEM_IDTR_BASE]=0x5000u;cpu.system[MACHINE_SYSTEM_IDTR_LIMIT]=4095u;
    cpu.system[MACHINE_SYSTEM_CR2]=0xabcdefu;
    segments=(machine_segments){0};segments.version=MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu};
    segments.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0xffffffffu,0xc093u};
    delivery=(vm_fault_delivery){0};before=cpu;
}
static void check_case(const pl_u64 *row)
{
    pl_u32 kind=(pl_u32)row[0]>>5u, vector=kind==0u?14u:kind==1u?6u:kind==3u?3u:13u;
    pl_u32 gate=0x8eu+((pl_u32)row[0]>>4u&1u), first=kind==1u||kind==3u?0u:1u;
    pl_u64 rip=row[6u+first];
    reset(row[1],rip-(kind==3u?1u:0u),row[2],vector,gate);
    EXPECT(!(kind==3u ? vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,3u,rip)
                       : vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)));
    EXPECT(cpu.registers[4]==row[3] && cpu.rflags==row[4]);
    EXPECT(cpu.rip==0x9000u && cpu.system[MACHINE_SYSTEM_CS]==8u && cpu.retired==123u);
    EXPECT(cpu.system[MACHINE_SYSTEM_CR2]==row[12]);
    pl_u32 words=first?6u:5u;
    for(pl_u32 i=0u;i<words;++i)EXPECT(get(stack_offset(cpu.registers[4])+i*8u)==row[6u+i]);
    if(first)cpu.registers[4]+=8u;
    /* The oracle's #UD/#GP handler advances RIP; #PF retries the same store. */
    if(kind==1u||kind==2u)put(stack_offset(cpu.registers[4]),rip+2u);
    EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments,0u));
    EXPECT(cpu.registers[4]==row[14] && cpu.rflags==(row[13]|(kind==3u?0u:0x10000u)));
    /* A successful ordinary instruction clears restored RF; IRETQ itself
     * does not. The system oracle records after its retried/skipped cut. */
    EXPECT((cpu.rflags&~0x10000ull)==row[13]);
    EXPECT(cpu.rip==rip+((kind==1u||kind==2u)?2u:0u) && cpu.retired==123u);
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
        fclose(input);EXPECT(rows==128u && cases==128u);
    }else{
        /* Kernel-shaped successful entry/return and exact pending failures. */
        for(pl_u32 gate=0x8eu;gate<=0x8fu;++gate)for(pl_u32 alignment=0u;alignment<16u;++alignment){
            reset(0x108f00u-alignment,0x1000204u,0x603u,14u,gate);
            EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery));
            EXPECT(cpu.registers[4]==((before.registers[4]&~15ull)-48u));
            EXPECT(cpu.rflags==(gate==0x8eu?0x403u:0x603u));
            EXPECT(get(stack_offset(cpu.registers[4]))==2u && cpu.retired==before.retired);
            cpu.registers[4]+=8u;EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments,0u));
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
    unsigned interrupts=0u;
    for(pl_u32 vector=0u;vector<256u;vector+=8u)for(pl_u32 rf=0u;rf<2u;++rf) {
        reset(0x108f03u,0x1000204u,0x603u|(pl_u64)rf<<16u,vector,0x8eu);
        vm_pic pic;vm_pic_reset(&pic);
        pl_u32 value=0x13u;EXPECT(!vm_pic_transfer(&pic,0x20u,1u,&value));
        value=vector;EXPECT(!vm_pic_transfer(&pic,0x21u,1u,&value));
        value=1u;EXPECT(!vm_pic_transfer(&pic,0x21u,1u,&value));
        EXPECT(!vm_pic_set_irq(&pic,0u,1u));
        pages[4].kind=VM_MEMORY_DEFERRED;
        EXPECT(vm_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,&pic)==2u);
        EXPECT(delivery.kind==VM_EVENT_INTERRUPT && delivery.stage==1u && delivery.words==5u);
        EXPECT(pic.chip[0].service==1u && !(pic.chip[0].request&1u));
        vm_pic accepted=pic;
        EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==6u && delivery.stage==1u);
        EXPECT(vm_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,&pic)==2u);
        EXPECT(!memcmp(&pic,&accepted,sizeof pic));
        pages[4].kind=VM_MEMORY_RAM;
        EXPECT(!vm_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,&pic));
        EXPECT(!memcmp(&pic,&accepted,sizeof pic) && !delivery.stage);
        EXPECT(cpu.retired==123u && cpu.system[MACHINE_SYSTEM_CR2]==0xabcdefu);
        EXPECT(cpu.registers[4]==0x108ed8u);
        EXPECT(get(stack_offset(cpu.registers[4]))==before.rip);
        EXPECT(get(stack_offset(cpu.registers[4])+16u)==before.rflags);
        EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments,0u));
        EXPECT(cpu.rflags==before.rflags && cpu.registers[4]==before.registers[4]);
        ++interrupts;
    }
    /* IRQ frame stores can alias their already-read IDT gate. A page wait
     * retains the target and acknowledged PIC without replaying either. */
    reset(0x108010u,0x1000204u,0x202u,0u,0x8eu);
    pages[5].offset=20480u;
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,7u,branches,9u));
    vm_pic pic;vm_pic_reset(&pic);pl_u32 value=0x13u;
    EXPECT(!vm_pic_transfer(&pic,0x20u,1u,&value));value=0u;
    EXPECT(!vm_pic_transfer(&pic,0x21u,1u,&value));value=1u;
    EXPECT(!vm_pic_transfer(&pic,0x21u,1u,&value));EXPECT(!vm_pic_set_irq(&pic,0u,1u));
    EXPECT(vm_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,&pic)==2u);
    EXPECT(delivery.kind==VM_EVENT_INTERRUPT && delivery.stage==4u && delivery.pushed==2u);
    EXPECT(get(20480u)==before.registers[4] && cpu.rip==before.rip && cpu.registers[4]==before.registers[4]);
    vm_pic accepted=pic;
    EXPECT(!vm_memory_append(&memory,0x107000u,(pl_u32)memory.next_offset,3u));
    EXPECT(!vm_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,&pic));
    EXPECT(!memcmp(&pic,&accepted,sizeof pic) && !delivery.stage && cpu.rip==0x9000u);
    EXPECT(cpu.registers[4]==0x107fe8u && cpu.retired==123u);
    unsigned software=0u;
    for(pl_u32 vector=1u;vector<=3u;vector+=2u)
    for(pl_u32 gate=0x8eu;gate<=0x8fu;++gate)for(pl_u32 alignment=0u;alignment<16u;++alignment)
    for(pl_u32 rf=0u;rf<2u;++rf) {
        reset(0x108f00u-alignment,0x1000204u,0x603u|((pl_u64)rf<<16u),vector,gate);
        if(vector==1u){cpu.system[MACHINE_SYSTEM_DR0+6u]=0xffffefffu;cpu.system[MACHINE_SYSTEM_DR0+7u]=0x2400u;}
        EXPECT(!vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,
            vector|(vector==1u?MACHINE_SOFTWARE_DEBUG_TRAP:0u),before.rip+1u));
        EXPECT(cpu.retired==123u && cpu.rip==0x9000u && !delivery.stage);
        EXPECT(cpu.registers[4]==((before.registers[4]&~15ull)-40u));
        EXPECT(get(stack_offset(cpu.registers[4]))==before.rip+1u);
        EXPECT(get(stack_offset(cpu.registers[4])+16u)==(before.rflags&~0x10000ull));
        EXPECT(cpu.rflags==(gate==0x8eu?0x403u:0x603u));
        EXPECT(cpu.system[MACHINE_SYSTEM_CR2]==before.system[MACHINE_SYSTEM_CR2]);
        if(vector==1u)EXPECT(cpu.system[MACHINE_SYSTEM_DR0+6u]==0xffffeff0u&&cpu.system[MACHINE_SYSTEM_DR0+7u]==0x400u);
        EXPECT(!vm_interrupt_return(&memory,0u,&cpu,&segments,0u));
        EXPECT(cpu.rip==before.rip+1u && cpu.registers[4]==before.registers[4] && cpu.rflags==0x603u);
        ++software;
    }
    /* Every INT n is software delivery, even if n also names a processor
     * fault. INT 1 must leave debug registers alone; it is not F1. */
    unsigned generic=0u;
    for(pl_u32 vector=0u;vector<256u;++vector)for(pl_u32 gate=0x8eu;gate<=0x8fu;++gate){
        reset(0x108f03u,0x1000204u,0x10603u,vector,gate);
        cpu.system[MACHINE_SYSTEM_DR0+6u]=0xffffefffu;cpu.system[MACHINE_SYSTEM_DR0+7u]=0x2400u;before=cpu;
        pages[4].kind=VM_MEMORY_DEFERRED;
        EXPECT(vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,vector,before.rip+2u)==2u);
        EXPECT(delivery.kind==VM_EVENT_SOFTWARE&&delivery.words==5u&&!memcmp(&cpu,&before,sizeof cpu));
        vm_fault_delivery pinned=delivery;
        EXPECT(vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,vector^1u,before.rip+2u)==6u);
        EXPECT(!memcmp(&cpu,&before,sizeof cpu)&&!memcmp(&delivery,&pinned,sizeof pinned));
        pages[4].kind=VM_MEMORY_RAM;
        EXPECT(!vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,vector,before.rip+2u));
        EXPECT(cpu.registers[4]==0x108ed8u&&get(stack_offset(cpu.registers[4]))==before.rip+2u);
        EXPECT(get(stack_offset(cpu.registers[4])+16u)==0x603u&&cpu.retired==123u);
        EXPECT(cpu.system[MACHINE_SYSTEM_DR0+6u]==0xffffefffu&&cpu.system[MACHINE_SYSTEM_DR0+7u]==0x2400u);
        EXPECT(cpu.system[MACHINE_SYSTEM_CR2]==before.system[MACHINE_SYSTEM_CR2]);
        ++generic;
    }
    for(pl_u32 vector=0u;vector<256u;++vector){
        reset(0x108f00u,0x300000u,0x603u,vector,0x0eu);
        cpu.system[MACHINE_SYSTEM_CS]=27u;segments.cache[MACHINE_SEGMENT_CS].attributes=0xa0fbu;before=cpu;
        EXPECT(vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,vector,cpu.rip+2u)==107u);
        EXPECT(get(24u)==((pl_u64)(vector*8u+2u)<<32u|13u)&&!memcmp(&cpu,&before,sizeof cpu));
        ++generic;
    }
    for(pl_u32 vector=16u;vector<=19u;vector+=3u){
        reset(0x108f00u,0x1000204u,0x603u,vector,0x8eu);
        EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery));
        EXPECT(cpu.registers[4]==0x108ed8u&&get(stack_offset(cpu.registers[4]))==before.rip);
        EXPECT(get(stack_offset(cpu.registers[4])+16u)==0x10603u&&cpu.retired==123u);
    }
    reset(0x108f00u,0x1000204u,0x603u,1u,0x8eu);
    EXPECT(vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,256u,cpu.rip+1u)==6u);
    EXPECT(!memcmp(&cpu,&before,sizeof cpu)&&!delivery.stage);
    /* Descriptor or frame failure still belongs to the source instruction;
     * it has not been retired or replaced with a successful #BP continuation. */
    for(pl_u32 mode=0u;mode<8u;++mode) {
        reset(0x108f00u,0x1000204u,0x10603u,3u,0x8fu);
        if(mode==0u)cpu.system[MACHINE_SYSTEM_IDTR_LIMIT]=47u;
        if(mode==1u)arena[20480u+3u*16u+5u]&=0x7fu;
        if(mode==2u)arena[20480u+3u*16u+5u]=0x8du;
        if(mode==3u)put(20480u+3u*16u,0x9000u|24ull<<16u|0x8full<<40u);
        if(mode==4u)put(16384u+8u,0x00af1b000000ffffull);
        if(mode==5u)cpu.registers[4]=0x800000000000ull;
        if(mode==6u)arena[20480u+3u*16u+4u]=1u;
        if(mode==7u)cpu.system[MACHINE_SYSTEM_CS]=11u;
        before=cpu;
        EXPECT(vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,3u,before.rip+1u)!=0u);
        EXPECT(!memcmp(&before,&cpu,sizeof cpu) && !delivery.stage);
    }
    reset(0x108010u,0x1000204u,0x10603u,3u,0x8fu);
    put(20480u,get(20480u+48u));cpu.system[MACHINE_SYSTEM_IDTR_BASE]=0x4fd0u;
    pages[5].offset=20480u;
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,7u,branches,9u));before=cpu;
    EXPECT(vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,3u,before.rip+1u)==2u);
    EXPECT(delivery.kind==VM_EVENT_SOFTWARE && delivery.stage==4u && delivery.pushed==2u);
    EXPECT(!memcmp(&before,&cpu,sizeof cpu) && get(20480u)==before.registers[4]);
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==6u && delivery.pushed==2u);
    EXPECT(!vm_memory_append(&memory,0x107000u,(pl_u32)memory.next_offset,3u));
    EXPECT(!vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,3u,before.rip+1u));
    EXPECT(!delivery.stage && cpu.rip==0x9000u && cpu.registers[4]==0x107fe8u && cpu.retired==123u);
    EXPECT(get((pl_u32)memory.next_offset-4096u+4072u)==before.rip+1u);
    unsigned inner=0u;
    for(pl_u32 cpl=1u;cpl<=3u;++cpl)for(pl_u32 gate=0x8eu;gate<=0x8fu;++gate)
    for(pl_u32 align=0u;align<16u;++align) {
        reset(0x108f00u,0x300000u,0x603u,14u,gate);
        EXPECT(!vm_memory_append(&memory,0x7000u,(pl_u32)memory.next_offset,3u));
        put(28672u+4u,0x108f00u-align);
        cpu.registers[4]=0x800000000000ull;cpu.system[MACHINE_SYSTEM_CS]=24u|cpl;
        cpu.system[MACHINE_SYSTEM_SS]=32u|cpl;cpu.system[MACHINE_SYSTEM_TR]=40u;
        segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu|cpl<<5u;
        segments.cache[MACHINE_SEGMENT_SS].attributes=0xc093u|cpl<<5u;
        segments.cache[MACHINE_SEGMENT_TR]=(machine_segment_cache){0x7000u,103u,0x8bu};
        put(16u,0x300000u);put(24u,(pl_u64)(cpl==3u?20u:16u)<<32u|14u);before=cpu;
        machine_state expected=cpu;machine_segments hidden=segments;
        expected.registers[4]=((0x108f00u-align)&~15ull)-48u;
        expected.rip=0x9000u;expected.rflags=gate==0x8eu?0x403u:0x603u;
        expected.system[MACHINE_SYSTEM_CS]=8u;expected.system[MACHINE_SYSTEM_SS]=0u;
        expected.system[MACHINE_SYSTEM_CR2]=0x300000u;
        hidden.cache[MACHINE_SEGMENT_CS]=(machine_segment_cache){0u,0xffffffffu,0xa09bu};
        hidden.cache[MACHINE_SEGMENT_SS]=(machine_segment_cache){0u,0u,MACHINE_SEGMENT_UNUSABLE};
        if(!align) {
            pages[6].kind=VM_MEMORY_DEFERRED;EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==2u);
            EXPECT(delivery.stage==3u&&!delivery.pushed);before.system[MACHINE_SYSTEM_CR2]=0x300000u;
            EXPECT(!memcmp(&cpu,&before,sizeof cpu));pages[6].kind=VM_MEMORY_RAM;
        }
        EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery));
        EXPECT(!memcmp(&cpu,&expected,sizeof cpu)&&!memcmp(&segments,&hidden,sizeof segments));
        const pl_u64 frame[]={cpl==3u?20u:16u,0x300000u,24u|cpl,0x10603u,0x800000000000ull,32u|cpl};
        for(pl_u32 i=0u;i<6u;++i)EXPECT(get(stack_offset(cpu.registers[4])+i*8u)==frame[i]);
        ++inner;
    }
    /* Software gate DPL is checked before Present, unlike processor faults.
     * Refusal must not become successful privileged entry or retirement. */
    for(pl_u32 present=0u;present<2u;++present) {
        reset(0x108f00u,0x300000u,0x603u,3u,present?0x8eu:0x0eu);
        cpu.system[MACHINE_SYSTEM_CS]=27u;segments.cache[MACHINE_SEGMENT_CS].attributes=0xa0fbu;before=cpu;
        EXPECT(vm_software_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,3u,cpu.rip+1u)==107u);
        EXPECT(get(24u)==(26ull<<32u|13u));EXPECT(!memcmp(&cpu,&before,sizeof cpu));
    }
    /* The first four frame stores overwrite the TSS itself before a lower
     * frame page arrives. Neither RSP0 nor those stores may be replayed. */
    reset(0x108f00u,0x300000u,0x603u,14u,0x8eu);
    EXPECT(!vm_memory_append(&memory,0x7000u,(pl_u32)memory.next_offset,3u));put(28676u,0x7020u);
    cpu.registers[4]=0x800000000000ull;cpu.system[MACHINE_SYSTEM_CS]=27u;cpu.system[MACHINE_SYSTEM_SS]=35u;
    segments.cache[MACHINE_SEGMENT_CS].attributes=0xa0fbu;
    segments.cache[MACHINE_SEGMENT_TR]=(machine_segment_cache){0x7000u,103u,0x8bu};before=cpu;
    EXPECT(vm_fault_enter(&memory,0u,&cpu,&segments,&delivery)==2u);
    EXPECT(delivery.stage==4u&&delivery.pushed==4u&&delivery.stack==0x7020u);
    EXPECT(get(28676u)!=0x7020u&&cpu.rip==before.rip&&cpu.registers[4]==before.registers[4]);
    /* Supply only the absent lower frame page; the event owner stays pinned. */
    EXPECT(!vm_memory_append(&memory,0x6000u,(pl_u32)memory.next_offset,3u));
    EXPECT(!vm_fault_enter(&memory,0u,&cpu,&segments,&delivery));
    EXPECT(cpu.registers[4]==0x6ff0u&&cpu.rip==0x9000u&&cpu.retired==before.retired);
    EXPECT(get(36848u)==2u&&get(36856u)==before.rip);
    /* Inconsistent selector/cache privilege must leave both PIC and CPU
     * untouched; accepting the event then refusing TSS would lose the IRQ. */
    reset(0x108f00u,0x300000u,0x202u,40u,0x8eu);cpu.system[MACHINE_SYSTEM_CS]=11u;before=cpu;
    vm_pic_reset(&pic);value=0x13u;EXPECT(!vm_pic_transfer(&pic,0x20u,1u,&value));value=40u;
    EXPECT(!vm_pic_transfer(&pic,0x21u,1u,&value));value=1u;
    EXPECT(!vm_pic_transfer(&pic,0x21u,1u,&value));EXPECT(!vm_pic_set_irq(&pic,0u,1u));accepted=pic;
    EXPECT(vm_interrupt_enter(&memory,0u,&cpu,&segments,&delivery,&pic)==6u);
    EXPECT(!memcmp(&pic,&accepted,sizeof pic)&&!memcmp(&cpu,&before,sizeof cpu)&&!delivery.stage);
    if(failures)return 1;
    printf("Long-mode fault/IRET: %u; PIC IRQ: %u; explicit traps: %u; generic INT: %u; inner faults: %u; #MF/#XM no error slot\n",cases,interrupts,software,generic,inner);
    return 0;
}
