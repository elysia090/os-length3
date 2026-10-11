#include <vm/network.h>
#include "memory-internal.h"
#include <stddef.h>
static int link(vm_network *n,pl_u32 up)
{
    if(n->device.config_generation==~0u)return VM_RESOURCE_ERROR_EXHAUSTED;
    vm_memory_store(n->device.config+6u,up,2u);++n->device.config_generation;n->device.interrupt|=2u;return 0;
}
int vm_network_open(vm_network *n,pl_u64 address,const pl_u8 mac[6])
{
    if(!n||!mac||(mac[0]&1u))return -1;
    *n=(vm_network){0};pl_u8 config[12]={0};for(pl_u32 i=0u;i<6u;++i)config[i]=mac[i];
    vm_memory_store(config+10u,1500u,2u);
    return vm_virtio_open(&n->device,address,1u,2u,(1ull<<32u)|(1ull<<5u)|(1ull<<16u)|(1ull<<3u),config,sizeof config);
}
int vm_network_bind(vm_network *n,const vm_resource_grant *grant)
{
    if(!n||!grant||!n->device.epoch||grant->kind!=VM_RESOURCE_NETWORK||grant->rights!=3u||grant->first
        ||grant->extent!=VM_NETWORK_FRAME_BYTES||grant->maximum_bytes<14u||grant->maximum_bytes>VM_NETWORK_FRAME_BYTES
        ||grant->address.lane||n->device.config_generation==~0u)return VM_RESOURCE_ERROR_INPUT;
    vm_resource_grant input=*grant,output=*grant;input.rights=1u;output.rights=2u;output.address.lane=1u;
    vm_resource_gate rx=n->rx,tx=n->tx;int status=vm_resource_bind(&rx,&input);if(status)return status;
    status=vm_resource_bind(&tx,&output);if(status)return status;
    n->rx=rx;n->tx=tx;n->receive_pending=0u;
    if(n->transmit_pending)n->transmit_pending=3u;
    return link(n,1u);
}
int vm_network_revoke(vm_network *n)
{
    if(!n||!n->rx.initialized||!n->tx.initialized||n->device.config_generation==~0u)return VM_RESOURCE_ERROR_INPUT;
    vm_resource_revoke(&n->rx);vm_resource_revoke(&n->tx);n->receive_pending=0u;
    if(n->transmit_pending)n->transmit_pending=3u;
    return link(n,0u);
}
int vm_network_receive(vm_network *n,const vm_resource_address *address,pl_u64 sequence,const pl_u8 *frame,pl_u32 bytes)
{
    if(!n||!address||!frame||bytes<14u||bytes>VM_NETWORK_FRAME_BYTES||!sequence)return VM_RESOURCE_ERROR_INPUT;
    vm_resource_ticket ticket={*address,sequence};
    if(sequence==n->rx.completed){int status=vm_resource_complete(&n->rx,&ticket,bytes);
        if(status!=VM_RESOURCE_DUPLICATE)return status;
        if(bytes!=n->receive_bytes)return VM_RESOURCE_ERROR_INPUT;
        for(pl_u32 i=0u;i<bytes;++i)if(frame[i]!=n->receive[i])return VM_RESOURCE_ERROR_INPUT;
        return VM_RESOURCE_DUPLICATE;}
    if(n->receive_pending)return VM_RESOURCE_ERROR_BUSY;
    vm_resource_gate gate=n->rx;vm_resource_request request={*address,0u,bytes,1u};
    int status=vm_resource_begin(&gate,&request,&ticket);if(status)return status;
    if(ticket.sequence!=sequence)return VM_RESOURCE_ERROR_STALE;
    status=vm_resource_complete(&gate,&ticket,bytes);if(status)return status;
    for(pl_u32 i=0u;i<bytes;++i)n->receive[i]=frame[i];
    n->receive_bytes=bytes;n->receive_pending=1u;n->rx=gate;return 0;
}
int vm_network_transmitted(vm_network *n,const vm_resource_ticket *ticket)
{
    if(!n||!ticket)return VM_RESOURCE_ERROR_INPUT;
    if(n->transmit_pending==1u&&(n->tx_chain.epoch!=n->device.epoch||n->tx_chain.queue_epoch!=n->device.queues[1].epoch||!n->device.queues[1].ready))return VM_RESOURCE_ERROR_STALE;
    vm_resource_gate gate=n->tx;
    int status=vm_resource_complete(&gate,ticket,ticket->sequence==gate.completed?gate.completed_bytes:n->transmit_bytes);
    if(!status){if(n->transmit_pending!=1u)return VM_RESOURCE_ERROR_STALE;n->tx=gate;n->transmit_pending=2u;}
    return status;
}
static machine_result scatter(vm_memory *m,pl_u32 port,const vm_virtqueue_chain *c,const pl_u8 *bytes,pl_u32 length)
{
    pl_u32 remaining=length,position=0u;
    for(pl_u32 i=0u;i<c->count&&remaining;++i){pl_u32 take=c->buffers[i].bytes;if(take>remaining)take=remaining;
        if(take){machine_result result=vm_dma_check(m,port,c->buffers[i].address,take,2u);if(result)return result;}remaining-=take;}
    if(remaining)return MACHINE_RESULT_ENTRY_MAP;
    for(pl_u32 i=0u;i<c->count&&position<length;++i){pl_u32 take=c->buffers[i].bytes;if(take>length-position)take=length-position;
        if(take){machine_result result=vm_dma_write(m,port,c->buffers[i].address,take,bytes+position);if(result)return result;}position+=take;}
    return 0;
}
machine_result vm_network_poll(vm_network *n,vm_memory *m,pl_u32 port)
{
    if(!n||!n->device.epoch)return 0;
    if(n->transmit_pending){
        if(n->tx_ticket.address.generation!=m->generation)return MACHINE_RESULT_STALE_GENERATION;
        if(n->tx_chain.epoch!=n->device.epoch||n->tx_chain.queue_epoch!=n->device.queues[1].epoch||!n->device.queues[1].ready){vm_resource_cancel(&n->tx,&n->tx_ticket);n->transmit_pending=0u;}
        else if(n->transmit_pending==1u)return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_NETWORK);
        else {machine_result r=vm_virtqueue_finish(&n->device,1u,m,port,&n->tx_chain,0u);if(r)return r;n->transmit_pending=0u;}
    }
    if(!n->rx.live||!n->tx.live)return 0;
    if(n->rx.grant.address.generation!=m->generation||n->tx.grant.address.generation!=m->generation)return MACHINE_RESULT_STALE_GENERATION;
    vm_virtqueue_chain chain;machine_result result;
    if(n->receive_pending&&(n->device.notified&1u)){
        result=vm_virtqueue_peek(&n->device,0u,m,port,1u,VM_DMA_MAX_BYTES,&chain);
        if(result==MACHINE_RESULT_ENTRY_MAP){vm_virtio_failed(&n->device);return 0;}
        if(result!=MACHINE_RESULT_RESOLVE_RIP){if(result)return result;
            pl_u32 length=n->receive_bytes+12u;
            if(chain.total>=length){pl_u8 packet[VM_NETWORK_FRAME_BYTES+12u]={0};
                vm_memory_store(packet+10u,1u,2u);for(pl_u32 i=0u;i<n->receive_bytes;++i)packet[12u+i]=n->receive[i];
                result=scatter(m,port,&chain,packet,length);if(result)return result;
                result=vm_virtqueue_finish(&n->device,0u,m,port,&chain,length);
            }else result=vm_virtqueue_finish(&n->device,0u,m,port,&chain,0u);
            if(result)return result;
            n->receive_pending=0u;
        }
    }
    if(!(n->device.notified&2u))return 0;
    result=vm_virtqueue_peek(&n->device,1u,m,port,0u,VM_NETWORK_FRAME_BYTES+12u,&chain);
    if(result==MACHINE_RESULT_RESOLVE_RIP)return 0;
    if(result==MACHINE_RESULT_ENTRY_MAP){vm_virtio_failed(&n->device);return 0;}
    if(result)return result;
    if(chain.total<26u){vm_virtio_failed(&n->device);return 0;}
    pl_u8 packet[VM_NETWORK_FRAME_BYTES+12u];pl_u32 at=0u;
    for(pl_u32 i=0u;i<chain.count;++i){pl_u32 bytes=chain.buffers[i].bytes;
        if(bytes){result=vm_dma_read(m,port,chain.buffers[i].address,bytes,packet+at);if(result)return result;}at+=bytes;}
    for(pl_u32 i=0u;i<10u;++i)if(packet[i]){vm_virtio_failed(&n->device);return 0;}
    vm_resource_request request={n->tx.grant.address,0u,chain.total-12u,2u};vm_resource_ticket ticket;
    int accepted=vm_resource_begin(&n->tx,&request,&ticket);if(accepted)return MACHINE_RESULT_ENTRY_MAP;
    n->transmit_bytes=chain.total-12u;for(pl_u32 i=0u;i<n->transmit_bytes;++i)n->transmit[i]=packet[12u+i];
    n->tx_ticket=ticket;n->tx_chain=chain;n->transmit_pending=1u;
    return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_NETWORK);
}
