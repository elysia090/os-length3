#include <vm/io.h>
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 arena[65536];
static vm_memory memory;
static vm_memory_page pages[6];
static vm_memory_branch branches[5];
static machine_state state;
static machine_segments segments;
static vm_clock clock_owner;
static vm_pit pit;
static vm_pic pic;
static vm_rtc rtc;
static vm_uart uart;
static unsigned failures, permissions;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"io: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static void put(pl_u32 at, pl_u64 value, pl_u32 size)
{ for (pl_u32 i = 0u; i < size; ++i) arena[at+i] = (pl_u8)(value >> (i*8u)); }
static pl_u64 get(pl_u32 at)
{ pl_u64 value=0u; for (pl_u32 i=0u;i<8u;++i) value |= (pl_u64)arena[at+i] << (i*8u); return value; }
static void reset(pl_u32 cpl, pl_u32 iopl)
{
    memset(arena,0,sizeof arena); put(0u,9u,8u);
    for (pl_u32 i = 0u; i < 4u; ++i) {
        pages[i]=(vm_memory_page){(i+1ull)*4096u,(i+2u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
        put(pages[i].offset+(i==2u ? 16u : 0u), (i==3u ? 0x8000u : (i+2ull)*4096u)|3u,8u);
    }
    pages[4]=(vm_memory_page){0x8000u,28672u,3u,VM_MEMORY_RAM,0u,0u};
    pages[5]=(vm_memory_page){0x9000u,32768u,3u,VM_MEMORY_RAM,0u,0u};
    put(20480u+8u,0x9003u,8u);
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u));
    state=(machine_state){0}; state.cr0=0x80010011u; state.cr3=0x1000u; state.cr4=32u;
    state.efer=0x500u; state.rip=0x400001u; state.rflags=0x10202u|((pl_u64)iopl<<12u);
    state.system[MACHINE_SYSTEM_CS]=16u|cpl; state.retired=42u;
    segments=(machine_segments){0}; segments.version=MACHINE_SEGMENTS_ABI_VERSION;
    segments.cache[MACHINE_SEGMENT_CS].attributes=0xa09bu;
    segments.cache[MACHINE_SEGMENT_TR]=(machine_segment_cache){0x400000u,8191u,0x008bu};
    put(28672u+102u,104u,2u);
    vm_clock_close(&clock_owner); vm_pit_reset(&pit); vm_pic_reset(&pic);
    vm_rtc_reset(&rtc);
    vm_uart_reset(&uart);
}
static machine_result io(pl_u32 coordinate, pl_u32 transfer, pl_u64 value)
{ return vm_io_transfer(&memory,0u,&state,&segments,&clock_owner,&pit,&pic,&rtc,&uart,coordinate,transfer,value); }
static machine_result time_read(void)
{ return vm_time_read(&memory,0u,&state,&segments,&clock_owner); }
static pl_u64 ticket(void) { return get(32u); }
static void reply(pl_u64 ns)
{ EXPECT(!vm_clock_reply(&clock_owner,9u,0u,&state,ticket(),ns)); }
static void transfer(pl_u64 ns, pl_u32 coordinate, pl_u32 write, pl_u32 value)
{
    machine_state before=state; machine_segments hidden=segments; vm_pit old=pit;
    EXPECT(io(coordinate,1u|(write ? MACHINE_IO_WRITE : 0u),value)==18u);
    EXPECT(!memcmp(&state,&before,sizeof state) && !memcmp(&segments,&hidden,sizeof hidden)
           && !memcmp(&pit,&old,sizeof pit));
    EXPECT(!get(40u) || (get(40u) == ((pl_u64)MACHINE_CLOCK_REQUEST << 32u)));
    reply(ns); EXPECT(!io(coordinate,1u|(write ? MACHINE_IO_WRITE : 0u),value));
    EXPECT(!memcmp(&state,&before,sizeof state));
}
int main(void)
{
    for (pl_u32 cpl=0u;cpl<4u;++cpl) for (pl_u32 iopl=0u;iopl<4u;++iopl)
    for (pl_u32 width=1u;width<=4u;width*=2u) for (pl_u32 bit=0u;bit<16u;++bit) {
        reset(cpl,iopl); pl_u32 coordinate=0x61u;
        put(28672u+104u+(coordinate>>3u),1u<<bit,2u);
        machine_state before=state; machine_segments hidden=segments; vm_pit old=pit;
        int denied=cpl>iopl && ((1u<<bit) & (((1u<<width)-1u) << (coordinate&7u)));
        EXPECT(io(coordinate,width,0u)==(denied ? 107u : width==1u ? 18u : 6u));
        EXPECT(!memcmp(&state,&before,sizeof state) && !memcmp(&hidden,&segments,sizeof hidden)
            && !memcmp(&old,&pit,sizeof pit));
        EXPECT(clock_owner.stage==(pl_u32)(!denied && width==1u));
        if (denied) EXPECT(get(16u)==state.rip && get(24u)==13u);
        ++permissions;
    }
    reset(3u,0u); segments.cache[MACHINE_SEGMENT_TR].limit=103u;
    EXPECT(io(0x61u,1u,0u)==107u && !clock_owner.stage);
    reset(3u,0u); segments.cache[MACHINE_SEGMENT_TR].limit=116u;
    EXPECT(io(0x61u,1u,0u)==107u); /* second bitmap byte lies outside TSS */
    reset(3u,0u); put(28672u+102u,4083u,2u); pages[5].kind=VM_MEMORY_DEFERRED;
    EXPECT(io(0x61u,1u,0u)==2u && !clock_owner.stage); /* bitmap word crosses page */
    reset(3u,0u); put(28672u+102u,4083u,2u); put(20480u+8u,0u,8u);
    EXPECT(io(0x61u,1u,0u)==115u && !clock_owner.stage);
    EXPECT(get(16u)==0x401000u && get(24u)==14u); /* supervisor #PF */
    reset(3u,0u); put(28672u+102u,0u,2u); segments.cache[MACHINE_SEGMENT_TR].attributes=0u;
    EXPECT(io(0x61u,1u,0u)==6u && !clock_owner.stage);
    reset(0u,0u);
    for (pl_u32 coordinate=0u;coordinate<65536u;coordinate+=127u)
        if(!vm_uart_accepts(coordinate))EXPECT(io(coordinate,1u,0u)==6u && !clock_owner.stage);
    for(pl_u32 cpl=0u;cpl<4u;++cpl)for(pl_u32 iopl=0u;iopl<4u;++iopl)
    for(pl_u32 width=1u;width<=4u;width*=2u)for(pl_u32 bit=0u;bit<16u;++bit){
        reset(cpl,iopl);const pl_u32 coordinate=0x3f9u;
        put(28672u+104u+(coordinate>>3u),1u<<bit,2u);
        machine_state before=state;machine_segments hidden=segments;vm_uart old=uart;
        int denied=cpl>iopl && ((1u<<bit)&(((1u<<width)-1u)<<(coordinate&7u)));
        EXPECT(io(coordinate,width,0u)==(denied ? 107u : width==1u ? 0u : 6u));
        EXPECT(!memcmp(&state,&before,sizeof state) && !memcmp(&segments,&hidden,sizeof hidden)
            && !memcmp(&uart,&old,sizeof old) && !clock_owner.stage);
        ++permissions;
    }
    reset(0u,0u);vm_uart old_uart=uart;
    EXPECT(io(0x3f8u,0x101u,65u)==6u && !memcmp(&uart,&old_uart,sizeof uart));
    EXPECT(io(0x43u,0x101u,0xb4u)==6u && !clock_owner.stage);
    EXPECT(io(0x43u,0x101u,0xb1u)==6u && !clock_owner.stage);
    reset(0u,0u); EXPECT(time_read()==18u); pl_u64 first=ticket();
    EXPECT(get(40u)==((pl_u64)MACHINE_CLOCK_REQUEST<<32u));
    EXPECT(time_read()==18u && ticket()==first && !clock_owner.now);
    EXPECT(vm_clock_reply(&clock_owner,8u,0u,&state,first,100u)==-1);
    EXPECT(vm_clock_reply(&clock_owner,9u,8u,&state,first,100u)==-1);
    ++state.rip; EXPECT(vm_clock_reply(&clock_owner,9u,0u,&state,first,100u)==-1); --state.rip;
    EXPECT(vm_clock_reply(&clock_owner,9u,0u,&state,first+1u,100u)==-1);
    EXPECT(io(0x61u,1u,0u)==6u); reply(100u);
    EXPECT(!vm_clock_reply(&clock_owner,9u,0u,&state,first,100u));
    EXPECT(vm_clock_reply(&clock_owner,9u,0u,&state,first,101u)==-1);
    EXPECT(!time_read() && get(8u)==100u && !clock_owner.stage);
    EXPECT(!vm_clock_reply(&clock_owner,9u,0u,&state,first,100u));
    EXPECT(time_read()==18u && ticket()>first);
    EXPECT(vm_clock_reply(&clock_owner,9u,0u,&state,ticket(),99u)==-1);
    vm_clock_abort(&clock_owner); EXPECT(vm_clock_reply(&clock_owner,9u,0u,&state,ticket(),101u)==-1);
    vm_clock_close(&clock_owner); EXPECT(time_read()==18u && ticket()>first);
    reply(~0ull); EXPECT(!time_read() && get(8u)==~0ull);
    reset(0u,0u); clock_owner.issued=~0ull; EXPECT(time_read()==6u && !clock_owner.stage);
    clock_owner.issued=0u;
    for (pl_u32 cpl=0u;cpl<4u;++cpl) for (pl_u32 tsd=0u;tsd<2u;++tsd) {
        reset(cpl,0u); state.cr4 |= tsd*4u;
        EXPECT(time_read()==(cpl && tsd ? 107u : 18u));
    }
    reset(0u,0u); put(0u,8u,8u); EXPECT(io(0x61u,1u,0u)==5u && time_read()==5u);
    /* Mode0 load pulse, terminal output, gate pause, reload=65536 and latches.
     * Values are derived at PIT clock edges, never per guest instruction. */
    reset(0u,0u); transfer(0u,0x61u,1u,1u); transfer(0u,0x43u,1u,0xb0u);
    transfer(0u,0x42u,1u,4u); transfer(0u,0x42u,1u,0u);
    transfer(839u,0x61u,0u,0u); EXPECT(get(8u)==1u && pit.channel[2].count==4u);
    transfer(4190u,0x61u,0u,0u); EXPECT(get(8u)==1u);
    transfer(4191u,0x61u,0u,0u); EXPECT(get(8u)==33u);
    transfer(4191u,0x42u,1u,0u); transfer(4191u,0x42u,1u,0u);
    transfer(5030u,0x61u,0u,0u); EXPECT(get(8u)==1u && pit.channel[2].count==65536u);
    transfer(5030u,0x61u,1u,0u); transfer(100000000u,0x42u,0u,0u); EXPECT(!get(8u));
    transfer(100000000u,0x42u,0u,0u); EXPECT(!get(8u));
    transfer(100000000u,0x61u,1u,1u);
    transfer(100000000u,0x43u,1u,0xc8u); /* latch both status and count2 */
    transfer(101000000u,0x42u,0u,0u); EXPECT(get(8u)==0x30u);
    transfer(102000000u,0x42u,0u,0u); EXPECT(!get(8u));
    transfer(103000000u,0x42u,0u,0u); EXPECT(!get(8u));
    reset(0u,0u);
    EXPECT(!io(0xa1u,0x101u,0xffffffffu) && !clock_owner.stage);
    EXPECT(!io(0xa1u,1u,0u) && get(8u)==255u && !clock_owner.stage);
    for (pl_u32 cpl=0u;cpl<4u;++cpl) for (pl_u32 iopl=0u;iopl<4u;++iopl)
    for (pl_u32 width=1u;width<=4u;width*=2u) for (pl_u32 bit=0u;bit<16u;++bit)
    for (pl_u32 index=0u;index<6u;++index) {
        const pl_u32 coordinates[]={0x20u,0x21u,0xa0u,0xa1u,0x4d0u,0x4d1u};
        reset(cpl,iopl); pl_u32 coordinate=coordinates[index];
        put(28672u+104u+(coordinate>>3u),1u<<bit,2u);
        machine_state before=state; vm_pic hidden=pic;
        int denied=cpl>iopl && ((1u<<bit) & (((1u<<width)-1u) << (coordinate&7u)));
        EXPECT(io(coordinate,width|MACHINE_IO_WRITE,255u)==(denied ? 107u : width==1u ? 0u : 6u));
        EXPECT(!memcmp(&state,&before,sizeof state) && !clock_owner.stage);
        if (denied || width!=1u) EXPECT(!memcmp(&pic,&hidden,sizeof pic));
        ++permissions;
    }
    reset(0u,0u); EXPECT(time_read()==18u); vm_pic hidden=pic;
    EXPECT(io(0xa1u,0x101u,255u)==6u && !memcmp(&hidden,&pic,sizeof pic));
    EXPECT(clock_owner.stage==1u); /* unrelated PIC access cannot steal a ticket */
    reset(0u,0u); put(0u,8u,8u); hidden=pic;
    EXPECT(io(0xa1u,0x101u,255u)==5u && !memcmp(&hidden,&pic,sizeof pic));
    reset(0u,0u); state.rflags|=0x100u; hidden=pic;
    EXPECT(io(0xa1u,0x101u,255u)==6u && !memcmp(&hidden,&pic,sizeof pic));
    reset(0u,0u); EXPECT(!io(0x70u,0x101u,0u) && !clock_owner.stage);
    EXPECT(io(0x71u,1u,0u)==6u && !clock_owner.stage); /* no implicit host UTC */
    reset(0u,0u); EXPECT(!vm_rtc_seed(&rtc,0u));
    EXPECT(!io(0x70u,0x101u,0u)); transfer(1000000000u,0x71u,0u,0u);
    EXPECT(get(8u)==1u && !clock_owner.stage);
    EXPECT(!io(0x70u,0x101u,12u)); transfer(1000000000u,0x71u,0u,0u);
    EXPECT(get(8u)==0x50u); transfer(1000000000u,0x71u,0u,0u); EXPECT(!get(8u));
    for (pl_u32 cpl=0u;cpl<4u;++cpl) for (pl_u32 iopl=0u;iopl<4u;++iopl)
    for (pl_u32 width=1u;width<=4u;width*=2u) for (pl_u32 bit=0u;bit<16u;++bit)
    for (pl_u32 coordinate=0x70u;coordinate<=0x71u;++coordinate) {
        reset(cpl,iopl); EXPECT(!vm_rtc_seed(&rtc,0u));
        put(28672u+104u+(coordinate>>3u),1u<<bit,2u);
        machine_state before=state; vm_rtc hidden_rtc=rtc;
        int denied=cpl>iopl && ((1u<<bit) & (((1u<<width)-1u) << (coordinate&7u)));
        EXPECT(io(coordinate,width,0u)==(denied ? 107u : width!=1u ? 6u : coordinate==0x70u ? 0u : 18u));
        EXPECT(!memcmp(&state,&before,sizeof state));
        if (denied || width!=1u || coordinate==0x71u) EXPECT(!memcmp(&rtc,&hidden_rtc,sizeof rtc));
        ++permissions;
    }
    if (!failures) printf("C IO/clock/PIT/PIC: %u permission cases and event/fault/edge checks green (not Linux boot)\n",permissions);
    return failures ? 1 : 0;
}
