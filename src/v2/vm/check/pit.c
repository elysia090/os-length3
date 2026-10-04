#include <vm/pit.h>
#include <stdio.h>
#include <string.h>
#include <inttypes.h>
static vm_pit pit;
static vm_pic pic;
static unsigned failures, comparisons;
_Static_assert(sizeof(vm_pit_channel)==40u,"channel frontier is bounded, not a tick history");
_Static_assert(sizeof(vm_pit)==128u,"mode 2 must not grow the previous PIT owner");
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"pit: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static pl_u64 ns_at(pl_u64 tick)
{ return (tick * 1000000000u + VM_PIT_FREQUENCY - 1u) / VM_PIT_FREQUENCY; }
static void write_at(pl_u64 tick, pl_u32 port, pl_u32 byte)
{ EXPECT(!vm_pit_transfer(&pit,ns_at(tick),&pic,port,1u,&byte)); }
static pl_u32 read_at(pl_u64 tick, pl_u32 port)
{ pl_u32 byte=0u; EXPECT(!vm_pit_transfer(&pit,ns_at(tick),&pic,port,0u,&byte)); return byte; }
static pl_u32 snapshot(pl_u64 tick, pl_u32 channel, pl_u32 *status)
{
    write_at(tick,0x43u,0xc0u|(2u<<channel));
    *status=read_at(tick,0x40u+channel);
    pl_u32 low=read_at(tick,0x40u+channel), high=read_at(tick,0x40u+channel);
    return low|(high<<8u);
}
static void reset(void) { vm_pit_reset(&pit); vm_pic_reset(&pic); }
static void program(pl_u32 channel, pl_u32 mode, pl_u32 divisor)
{
    write_at(0u,0x43u,(channel<<6u)|0x30u|(mode<<1u));
    write_at(0u,0x40u+channel,divisor&255u); write_at(0u,0x40u+channel,divisor>>8u);
}
static void clear_irq(void)
{ pic.chip[0].request=0u; pic.chip[0].service=0u; }
int main(int argc, char **argv)
{
    reset();
    if (argc==2 && !strcmp(argv[1],"--trace")) {
        char kind; uint64_t ns; unsigned port,byte;
        while (scanf(" %c %" SCNu64 " %u",&kind,&ns,&port)==3) {
            byte=0u; if(kind=='W' && scanf(" %u",&byte)!=1) return 2;
            if(vm_pit_transfer(&pit,ns,&pic,port,(pl_u32)(kind=='W'),&byte))return 2;
            if(kind=='R')printf("%u\n",byte);
        }
        return 0;
    }
    for(pl_u32 mode=2u;mode<=6u;mode+=4u)for(pl_u32 channel=0u;channel<3u;++channel)
    for(pl_u32 n=2u;n<=257u;++n){
        reset();if(channel==2u)write_at(0u,0x61u,1u);program(channel,mode,n);
        pl_u32 status=0u;EXPECT(!snapshot(0u,channel,&status));
        EXPECT(status==(0xf0u|(mode<<1u))); /* CR not yet in CE. */
        clear_irq();
        pl_u32 reference=n;
        for(pl_u64 tick=1u;tick<=n*3u+2u;++tick){
            if(tick>1u)reference=reference==1u ? n : reference-1u;
            EXPECT(snapshot(tick,channel,&status)==(reference&65535u));
            EXPECT(status==((reference==1u ? 0u : 128u)|0x30u|(mode<<1u)));
            EXPECT((pic.chip[0].request&1u)==(pl_u32)(channel==0u && tick>1u && reference==n));
            if(channel==2u)EXPECT((read_at(tick,0x61u)&32u)==(reference==1u ? 0u : 32u));
            clear_irq();++comparisons;
        }
    }
    /* A new CR is loaded only at the next cycle boundary, not next access.
     * A partial two-byte write does not stop an active mode-2 CE. */
    reset();program(0u,2u,5u);pl_u32 status=0u;
    EXPECT(snapshot(2u,0u,&status)==4u);write_at(2u,0x40u,3u);
    EXPECT(snapshot(3u,0u,&status)==3u && status==0xb4u);
    write_at(3u,0x40u,0u);EXPECT(snapshot(4u,0u,&status)==2u && status==0xf4u);
    EXPECT(snapshot(5u,0u,&status)==1u && status==0x74u);
    EXPECT(snapshot(6u,0u,&status)==3u && status==0xb4u);
    EXPECT(snapshot(8u,0u,&status)==1u && status==0x34u);
    /* Gate low forces OUT high without destroying CE; rising gate reloads
     * the latest CR on the next pulse, even during a pending replacement. */
    reset();write_at(0u,0x61u,1u);program(2u,2u,4u);
    EXPECT(snapshot(4u,2u,&status)==1u);write_at(4u,0x61u,0u);
    EXPECT(read_at(4u,0x61u)==32u);EXPECT(snapshot(100u,2u,&status)==1u);
    write_at(100u,0x42u,7u);write_at(100u,0x42u,0u);
    EXPECT(snapshot(101u,2u,&status)==1u && status==0xf4u);
    write_at(101u,0x61u,1u);EXPECT(snapshot(101u,2u,&status)==1u && status==0xf4u);
    EXPECT(snapshot(102u,2u,&status)==7u && status==0xb4u);
    EXPECT(snapshot(108u,2u,&status)==1u && status==0x34u);
    /* Latches are independent of current CE, byte interleaving and each
     * other. Repeated unread latch requests do not replace the first. */
    reset();program(0u,2u,0x1234u);write_at(3u,0x43u,0u);
    pl_u32 low=read_at(4u,0x40u);write_at(5u,0x43u,0u);
    write_at(6u,0x43u,0xe2u);EXPECT(read_at(7u,0x40u)==0xb4u);
    EXPECT((low|(read_at(8u,0x40u)<<8u))==0x1232u);
    write_at(9u,0x43u,0u);EXPECT(read_at(10u,0x40u)==0x2cu);
    write_at(10u,0x40u,0u);EXPECT(read_at(11u,0x40u)==0x12u);
    write_at(11u,0x40u,0u);EXPECT(snapshot(12u,0u,&status)==0x1229u && status==0xf4u);
    /* Zero encodes 65536; arbitrarily large clock steps do not enumerate
     * periods. PIC IRR is one coalesced edge, not an accumulated IRQ queue. */
    reset();program(0u,2u,0u);EXPECT(snapshot(1u,0u,&status)==0u && status==0xb4u);
    EXPECT(snapshot(65536u,0u,&status)==1u && status==0x34u);clear_irq();
    EXPECT(snapshot(65537u,0u,&status)==0u && (pic.chip[0].request&1u));clear_irq();
    EXPECT(!vm_pit_advance(&pit,~0ull,&pic));EXPECT(pic.chip[0].request&1u);
    vm_pit saved=pit;clear_irq();EXPECT(!vm_pit_advance(&pit,~0ull,&pic));
    EXPECT(!memcmp(&pit,&saved,sizeof pit) && !(pic.chip[0].request&1u));
    vm_pic saved_pic=pic;EXPECT(vm_pit_advance(&pit,0u,&pic)==-1);
    EXPECT(!memcmp(&pit,&saved,sizeof pit) && !memcmp(&pic,&saved_pic,sizeof pic));
    /* An unchanged physical level after PIC initialization is not a new
     * edge. A complete unseen period still carries its real rising edge. */
    reset();program(0u,2u,4u);EXPECT(!vm_pit_advance(&pit,ns_at(1u),&pic));
    vm_pic_reset(&pic);EXPECT(!vm_pit_advance(&pit,ns_at(2u),&pic));
    EXPECT(!pic.chip[0].request);EXPECT(!vm_pit_advance(&pit,ns_at(9u),&pic));
    EXPECT(pic.chip[0].request&1u);
    /* Batched time must produce exactly the same residual CE/latch/PIC as
     * per-pulse advancement, including a deferred new divisor and level
     * versus edge interrupt mode. This reference enumerates only in tests. */
    unsigned batch_comparisons=0u;
    for(pl_u32 n=2u;n<=65u;++n)for(pl_u32 phase=0u;phase<n;++phase)
    for(pl_u32 level=0u;level<2u;++level){
        reset();pic.chip[0].level_triggered=(pl_u8)level;program(0u,2u,n);
        pl_u64 at=1u+phase;EXPECT(!vm_pit_advance(&pit,ns_at(at),&pic));
        write_at(at,0x40u,2u+phase%15u);write_at(at,0x40u,0u);clear_irq();
        vm_pit origin=pit;vm_pic pic_origin=pic;
        const pl_u32 steps[]={0u,1u,n-phase-1u,n-phase,n*3u,1000u};
        for(pl_u32 k=0u;k<sizeof steps/sizeof steps[0];++k){
            pit=origin;pic=pic_origin;EXPECT(!vm_pit_advance(&pit,ns_at(at+steps[k]),&pic));
            vm_pit batch=pit;vm_pic batch_pic=pic;pit=origin;pic=pic_origin;
            for(pl_u32 j=1u;j<=steps[k];++j)EXPECT(!vm_pit_advance(&pit,ns_at(at+j),&pic));
            EXPECT(!memcmp(&pit,&batch,sizeof pit)&&!memcmp(&pic,&batch_pic,sizeof pic));++batch_comparisons;
        }
    }
    /* BCD/other modes, illegal divisor and backwards clock must not alter
     * any device or fabricate successful I/O. Latch low bits are ignored. */
    for(pl_u32 byte=0u;byte<256u;++byte){
        pl_u32 channel=byte>>6u, rw=(byte>>4u)&3u,mode=(byte>>1u)&7u;
        pl_u32 wanted=channel==3u ? !(byte&1u) : !rw || (!(byte&1u)&&(mode==0u||mode==2u||mode==6u));
        EXPECT(vm_pit_accepts(0x43u,1u,byte)==(int)wanted);
    }
    reset();program(0u,2u,4u);write_at(2u,0x40u,1u);saved=pit;saved_pic=pic;
    pl_u32 byte=0u;EXPECT(vm_pit_transfer(&pit,ns_at(3u),&pic,0x40u,1u,&byte)==-1);
    EXPECT(!memcmp(&pit,&saved,sizeof pit)&&!memcmp(&pic,&saved_pic,sizeof pic));
    EXPECT(vm_pit_transfer(&pit,ns_at(3u),&pic,0x43u,0u,&byte)==-1);
    EXPECT(!memcmp(&pit,&saved,sizeof pit));
    EXPECT(!vm_pit_accepts(0x40u,2u,0u)&&!vm_pit_accepts(0x40u,1u,256u));
    EXPECT(vm_pit_transfer(NULL,ns_at(3u),&pic,0x40u,1u,&byte)==-1);
    EXPECT(vm_pit_transfer(&pit,ns_at(3u),&pic,0x40u,1u,NULL)==-1);
    /* Mode-0 terminal rising edge routes through exactly the same PIC. */
    reset();program(0u,0u,3u);clear_irq();
    EXPECT(!vm_pit_advance(&pit,ns_at(3u),&pic)&&!pic.chip[0].request);
    EXPECT(!vm_pit_advance(&pit,ns_at(4u),&pic)&&(pic.chip[0].request&1u));
    clear_irq();EXPECT(!vm_pit_advance(&pit,ns_at(100u),&pic)&&!pic.chip[0].request);
    if(failures)return 1;
    printf("C PIT: %u pulse/reference, %u batch/residual comparisons; mode0/2, gate/reload/latch, bounded IRQ0 and rejection checks green (not Linux boot)\n",comparisons,batch_comparisons);
    return 0;
}
