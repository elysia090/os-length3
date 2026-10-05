#include <vm/mmu.h>
#include <stdio.h>
#include <string.h>

static _Alignas(8) pl_u8 arena[65536];
static vm_memory memory;
static vm_memory_page pages[6];
static vm_memory_branch branches[5];
static const pl_u32 port=2048u,payload=28672u,leaf=20480u;
static const pl_u64 base=0x400000u;
static pl_u32 failures;
#define EXPECT(x) do { if(!(x)){if(failures<20u)fprintf(stderr,"read-extent: %u\n",(unsigned)__LINE__);++failures;} } while(0)
static void put(pl_u32 at,pl_u64 value)
{ for(pl_u32 i=0u;i<8u;++i)arena[at+i]=(pl_u8)(value>>(i*8u)); }
static vm_mmu_context context(void)
{return (vm_mmu_context){0x80010001ull,0x1000u,32u,0xd00u,0u};}
static void reset(void)
{
    memset(arena,0,sizeof arena);put(port,9u);
    for(pl_u32 i=0u;i<4u;++i){
        pages[i]=(vm_memory_page){(i+1ull)*4096u,(i+2u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
        put(pages[i].offset+(i==2u?16u:0u),(i==3u?0x8000ull:(i+2ull)*4096u)|0x67u);
    }
    pages[4]=(vm_memory_page){0x8000u,payload,1u,VM_MEMORY_RAM,0u,0u};
    pages[5]=(vm_memory_page){0x9000u,payload+4096u,1u,VM_MEMORY_RAM,0u,0u};
    put(leaf+8u,0x9065u);put(leaf,0x8065u);
    for(pl_u32 i=0u;i<8192u;++i)arena[payload+i]=(pl_u8)(i*17u+29u);
    EXPECT(!vm_memory_open(&memory,arena,sizeof arena,4096u,pages,6u,6u,branches,9u));
    memset(arena+port+48u,0xa5,16u);
}
int main(void)
{
    pl_u32 bytes_checked=0u;
    EXPECT(sizeof(machine_memory_extent_port)==64u);
    for(pl_u32 row=0u;row<4096u;++row){
        reset();vm_mmu_context cpu=context();pl_u32 length=1u+(row*251u)%512u;
        EXPECT(!vm_mmu_read_extent(&memory,port,&cpu,base+row,length,MACHINE_MEMORY_READ));
        machine_memory_extent_port view;memcpy(&view,arena+port,sizeof view);
        EXPECT(!memory.reservation.parts && !memory.write_touched);
        EXPECT(view.lengths[0]+view.lengths[1]==length);
        pl_u32 position=row;
        for(pl_u32 part=0u;part<2u;++part)for(pl_u32 byte=0u;byte<view.lengths[part];++byte){
            EXPECT(arena[view.offsets[part]+byte]==(pl_u8)(position*17u+29u));++position;++bytes_checked;
        }
        EXPECT(position==row+length);
        if(!view.lengths[1])EXPECT(view.offsets[1]==0u);
    }
    for(pl_u32 mode=0u;mode<12u;++mode){
        reset();vm_mmu_context cpu=context();pl_u64 address=base+4080u;
        if(mode==0u)put(leaf+8u,0u);
        if(mode==1u)pages[5].kind=VM_MEMORY_DEFERRED;
        if(mode==2u)pages[5].rights=2u;
        if(mode==3u)put(port,8u);
        if(mode==4u)cpu.cr4|=1ull<<12u;
        if(mode==5u)address=0x800000000000ull;
        if(mode==6u)address=~15ull;
        if(mode==7u)++address;
        pl_u32 length=mode==8u?0u:mode==9u?513u:512u;
        pl_u32 access=mode==10u?MACHINE_MEMORY_WRITE:mode==11u?3u:MACHINE_MEMORY_READ|VM_MMU_ALIGNED16;
        EXPECT(vm_mmu_read_extent(&memory,port,&cpu,address,length,access)!=0u);
        EXPECT(!memory.reservation.parts && !memory.write_touched);
        for(pl_u32 byte=48u;byte<64u;++byte)EXPECT(arena[port+byte]==0xa5u);
        for(pl_u32 byte=0u;byte<8192u;++byte)EXPECT(arena[payload+byte]==(pl_u8)(byte*17u+29u));
    }
    reset(); /* No payload copy or retained lease is needed. */
    vm_mmu_context cpu=context();pages[4].kind=VM_MEMORY_ROM;pages[5].kind=VM_MEMORY_ROM;
    EXPECT(!vm_mmu_read_extent(&memory,port,&cpu,base+4080u,512u,MACHINE_MEMORY_READ));
    if(failures)return 1;
    printf("Borrowed read extent: %u directly projected bytes; 4096 offsets and 12 refusal/fault/wait models green\n",bytes_checked);
    return 0;
}
