#include <vm/block.h>
#include "../core/memory-internal.h"
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 ram[65536];static vm_memory m;static vm_memory_page pages[12];static vm_memory_branch branches[11];
static vm_block block;static unsigned failures,effects;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"block line %u\n",(unsigned)__LINE__);++failures;}}while(0)
static void put(pl_u64 at,pl_u64 value,pl_u32 bytes){vm_memory_store(ram+at,value,bytes);}
static pl_u64 get(pl_u64 at,pl_u32 bytes){return vm_memory_load(ram+at,bytes);}
static void observer(void *owner,pl_u32 offset,pl_u32 bytes){(void)owner;(void)offset;(void)bytes;++effects;}
static void reg(pl_u32 at,pl_u32 word){pl_u64 value=word;EXPECT(!vm_virtio_register(&block.device,at,4u,2u,2u,&value));}
static void request(pl_u32 op,pl_u64 sector,pl_u32 count,pl_u32 index)
{
    put(0x4000,op,4u);put(0x4008,sector,8u);
    put(0x1000,0x4000,8u);put(0x1008,16,4u);put(0x100c,1,2u);put(0x100e,1,2u);
    put(0x1010,0x5ff8,8u);put(0x1018,count,4u);put(0x101c,op==0?3:1,2u);put(0x101e,2,2u);
    put(0x1020,0x7000,8u);put(0x1028,1,4u);put(0x102c,2,2u);
    put(0x2002,index,2u);put(0x2004+(index-1u)*2u,0,2u);put(0x7000,0xa5,1u);
    reg(0x50,0);
}
int main(void)
{
    put(2048,9,8u);for(pl_u32 n=0;n<12u;++n)pages[n]=(vm_memory_page){(n+1ull)*4096u,(n+1u)*4096u,3u,VM_MEMORY_RAM,0,0};
    EXPECT(!vm_memory_open(&m,ram,sizeof ram,4096,pages,12,12,branches,9));m.before_write=observer;
    EXPECT(!vm_block_open(&block,0x3f001000,1048576));
    vm_resource_grant grant={.address={{1,2},{3,4},6,9,1,0},.extent=1048576,.maximum_bytes=4096,.rights=3,.kind=VM_RESOURCE_OBJECT};
    EXPECT(!vm_block_bind(&block,&grant));reg(0x70,1);reg(0x70,3);reg(0x24,1);reg(0x20,1);reg(0x24,0);reg(0x20,(pl_u32)block.device.features);reg(0x70,11);reg(0x70,15);
    reg(0x38,8);reg(0x80,0x1000);reg(0x90,0x2000);reg(0xa0,0x3000);reg(0x44,1);
    pl_u8 content[512];for(pl_u32 i=0;i<512;++i)content[i]=(pl_u8)(i*31u);
    memcpy(ram+0x5ff8,content,sizeof content);request(1,7,512,1);
    EXPECT(vm_block_poll(&block,&m,2048)==50);EXPECT(block.offset==3584&&block.bytes==512&&!memcmp(block.payload,content,512)&&!effects);
    vm_resource_ticket old=block.ticket;EXPECT(!vm_block_complete(&block,&old,NULL,0,0));EXPECT(vm_block_complete(&block,&old,NULL,0,0)==VM_RESOURCE_DUPLICATE);
    EXPECT(!vm_block_poll(&block,&m,2048));EXPECT(get(0x3002,2)==1&&get(0x7000,1)==0);
    EXPECT(!vm_block_poll(&block,&m,2048));pl_u64 polls=block.device.polls;
    for(pl_u32 n=0u;n<100000u;++n)EXPECT(!vm_block_poll(&block,&m,2048));
    EXPECT(block.device.polls==polls&&!block.device.notified);
    EXPECT(vm_block_complete(&block,&old,NULL,0,0)==VM_RESOURCE_DUPLICATE);
    memset(ram+0x5ff8,0xa5,512);request(0,7,512,2);EXPECT(vm_block_poll(&block,&m,2048)==50);
    EXPECT(vm_block_complete(&block,&old,NULL,0,0)==VM_RESOURCE_DUPLICATE);
    EXPECT(!vm_block_complete(&block,&block.ticket,content,512,0));EXPECT(!vm_block_poll(&block,&m,2048));EXPECT(!memcmp(ram+0x5ff8,content,512));EXPECT(get(0x300c+4,4)==513);
    request(4,0,0,3);EXPECT(vm_block_poll(&block,&m,2048)==50);EXPECT(block.operation==4);
    EXPECT(!vm_block_complete(&block,&block.ticket,NULL,0,0));EXPECT(!vm_block_poll(&block,&m,2048));
    request(0,2048,512,4);EXPECT(!vm_block_poll(&block,&m,2048));EXPECT(get(0x7000,1)==1&&get(0x3002,2)==4);
    request(0,0,512,5);EXPECT(vm_block_poll(&block,&m,2048)==50);old=block.ticket;++grant.address.revision;
    EXPECT(!vm_block_bind(&block,&grant));EXPECT(vm_block_complete(&block,&old,content,512,0)==VM_RESOURCE_ERROR_STALE);
    EXPECT(!vm_block_poll(&block,&m,2048));EXPECT(get(0x7000,1)==1);
    request(0,0,512,6);EXPECT(vm_block_poll(&block,&m,2048)==50);old=block.ticket;
    reg(0x44,0);reg(0x44,1);
    EXPECT(vm_block_complete(&block,&old,content,512,0)==VM_RESOURCE_ERROR_STALE);
    block.device.notified=0;EXPECT(!vm_block_poll(&block,&m,2048));EXPECT(get(0x7000,1)==0xa5);
    pl_u64 value=0u;EXPECT(vm_virtio_register(&block.device,0u,4u,1u,2u,&value)==MACHINE_RESULT_ENTRY_MAP);
    reg(0x44,0);reg(0x84,0xffffffffu);reg(0x80,0xfffffff0u);value=1u;
    EXPECT(vm_virtio_register(&block.device,0x44u,4u,2u,2u,&value)==MACHINE_RESULT_ENTRY_MAP);
    if(failures)return 1;
    puts("C virtio-block: READ/WRITE/FLUSH, physical cross-page DMA, exact used/status publication, extent/refusal/regrant; persistence transport separate");return 0;
}
