#include <vm/network.h>
#include "../core/memory-internal.h"
#include <stdio.h>
#include <string.h>
static _Alignas(8) pl_u8 ram[65536];static vm_memory memory;static vm_memory_page pages[12];static vm_memory_branch branches[11];
static vm_network net;static unsigned failures,effects;
#define EXPECT(x) do{if(!(x)){fprintf(stderr,"network line %u\n",(unsigned)__LINE__);++failures;}}while(0)
static pl_u8 *at(pl_u64 address){return ram+4096u+(pl_u32)address-4096u;}
static void put(pl_u64 address,pl_u64 value,pl_u32 bytes){vm_memory_store(at(address),value,bytes);}
static pl_u64 get(pl_u64 address,pl_u32 bytes){return vm_memory_load(at(address),bytes);}
static void observed(void *owner,pl_u32 offset,pl_u32 bytes){(void)owner;(void)offset;(void)bytes;++effects;}
static void write_reg(pl_u32 offset,pl_u32 value){pl_u64 word=value;EXPECT(!vm_virtio_register(&net.device,offset,4u,2u,0u,&word));EXPECT(!vm_virtio_register(&net.device,offset,4u,2u,2u,&word));}
static void queue(pl_u32 rank,pl_u64 descriptor,pl_u64 available,pl_u64 used)
{write_reg(0x30u,rank);write_reg(0x38u,8u);write_reg(0x80u,(pl_u32)descriptor);write_reg(0x90u,(pl_u32)available);write_reg(0xa0u,(pl_u32)used);write_reg(0x44u,1u);}
int main(void)
{
    vm_memory_store(ram+2048u,9u,8u);
    for(pl_u32 n=0u;n<12u;++n)pages[n]=(vm_memory_page){(n+1ull)*4096u,(n+1u)*4096u,3u,VM_MEMORY_RAM,0u,0u};
    EXPECT(!vm_memory_open(&memory,ram,sizeof ram,4096u,pages,12u,12u,branches,9u));memory.before_write=observed;
    const pl_u8 mac[6]={2u,1u,2u,3u,4u,5u};EXPECT(!vm_network_open(&net,0x3f000000u,mac));
    vm_resource_grant grant={.address={{1u,2u},{3u,4u},5u,9u,1u,0u},.extent=2048u,.maximum_bytes=2048u,.rights=3u,.kind=VM_RESOURCE_NETWORK};
    EXPECT(!vm_network_bind(&net,&grant));
    write_reg(0x70u,1u);write_reg(0x70u,3u);write_reg(0x24u,1u);write_reg(0x20u,1u);write_reg(0x24u,0u);write_reg(0x20u,(pl_u32)net.device.features);
    write_reg(0x70u,11u);write_reg(0x70u,15u);queue(1u,0x1000u,0x2000u,0x3000u);queue(0u,0x5000u,0x6000u,0x7000u);
    pl_u8 frame[1514];for(pl_u32 i=0u;i<sizeof frame;++i)frame[i]=(pl_u8)(i*31u);
    put(0x1000u,0x4000u,8u);put(0x1008u,12u,4u);put(0x100cu,1u,2u);put(0x100eu,1u,2u);
    put(0x1010u,0x400cu,8u);put(0x1018u,sizeof frame,4u);memcpy(at(0x400cu),frame,sizeof frame);
    put(0x2002u,1u,2u);put(0x2004u,0u,2u);
    write_reg(0x50u,1u);
    EXPECT(vm_network_poll(&net,&memory,2048u)==42u);EXPECT(!get(0x3002u,2u)&&!effects);
    EXPECT(net.transmit_bytes==sizeof frame&&!memcmp(frame,net.transmit,sizeof frame));vm_resource_ticket ticket=net.tx_ticket;
    EXPECT(!vm_network_transmitted(&net,&ticket));EXPECT(vm_network_transmitted(&net,&ticket)==VM_RESOURCE_DUPLICATE);
    EXPECT(!vm_network_poll(&net,&memory,2048u));EXPECT(get(0x3002u,2u)==1u&&effects==2u);
    put(0x5000u,0x8ff8u,8u);put(0x5008u,2048u,4u);put(0x500cu,2u,2u);put(0x6002u,1u,2u);put(0x6004u,0u,2u);
    write_reg(0x50u,0u);
    EXPECT(!vm_network_receive(&net,&grant.address,1u,frame,sizeof frame));
    EXPECT(vm_network_receive(&net,&grant.address,1u,frame,sizeof frame)==VM_RESOURCE_DUPLICATE);
    EXPECT(!vm_network_poll(&net,&memory,2048u));EXPECT(get(0x7002u,2u)==1u&&get(0x7008u,4u)==sizeof frame+12u);
    EXPECT(!memcmp(at(0x9004u),frame,sizeof frame));EXPECT(get(0x8ff8u,8u)==0u&&get(0x9002u,2u)==1u);
    EXPECT(vm_network_receive(&net,&grant.address,1u,frame,sizeof frame)==VM_RESOURCE_DUPLICATE);
    pl_u8 altered[1514];memcpy(altered,frame,sizeof frame);altered[7]^=1u;
    EXPECT(vm_network_receive(&net,&grant.address,1u,altered,sizeof altered)==VM_RESOURCE_ERROR_INPUT);
    put(0x2002u,2u,2u);put(0x2006u,0u,2u);write_reg(0x50u,1u);EXPECT(vm_network_poll(&net,&memory,2048u)==42u);ticket=net.tx_ticket;
    ++grant.address.revision;EXPECT(!vm_network_bind(&net,&grant));EXPECT(vm_network_transmitted(&net,&ticket)==VM_RESOURCE_ERROR_STALE);
    EXPECT(!vm_network_poll(&net,&memory,2048u));EXPECT(get(0x3002u,2u)==2u);
    vm_resource_address old=grant.address;--old.revision;EXPECT(vm_network_receive(&net,&old,2u,frame,sizeof frame)==VM_RESOURCE_ERROR_STALE);
    EXPECT(!vm_network_revoke(&net));EXPECT(vm_network_receive(&net,&grant.address,2u,frame,sizeof frame)==VM_RESOURCE_ERROR_DENIED);
    if(failures)return 1;
    puts("C virtio-net: actual split-ring TX/RX, fragmented physical DMA, commit order, full frame, duplicate/stale/regrant/revoke; not Linux/gateway proof");return 0;
}
