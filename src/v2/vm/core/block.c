#include <vm/block.h>
#include "memory-internal.h"
#include <stddef.h>
int vm_block_open(vm_block *b,pl_u64 address,pl_u64 capacity)
{
    if(!b||!capacity||capacity&511u)return -1;
    *b=(vm_block){0};pl_u8 cfg[24]={0};vm_memory_store(cfg,capacity/512u,8u);
    vm_memory_store(cfg+8u,VM_BLOCK_BYTES,4u);vm_memory_store(cfg+12u,1u,4u);vm_memory_store(cfg+20u,512u,4u);
    return vm_virtio_open(&b->device,address,2u,1u,(1ull<<32u)|(1ull<<1u)|(1ull<<2u)|(1ull<<6u)|(1ull<<9u),cfg,sizeof cfg);
}
int vm_block_bind(vm_block *b,const vm_resource_grant *g)
{
    if(!b||!g||!b->device.epoch||g->kind!=VM_RESOURCE_OBJECT||g->rights!=3u||g->first
        ||g->maximum_bytes!=VM_BLOCK_BYTES||g->extent!=vm_memory_load(b->device.config,8u)*512u)return VM_RESOURCE_ERROR_INPUT;
    int result=vm_resource_bind(&b->gate,g);if(!result&&b->stage){b->stage=2u;b->error=1u;}return result;
}
int vm_block_complete(vm_block *b,const vm_resource_ticket *ticket,const pl_u8 *bytes,pl_u32 count,pl_u32 error)
{
    if(!b||!ticket||error>1u)return VM_RESOURCE_ERROR_INPUT;
    if(ticket->sequence==b->gate.completed){
        int duplicate=vm_resource_complete(&b->gate,ticket,b->gate.completed_bytes);
        if(duplicate!=VM_RESOURCE_DUPLICATE)return duplicate;
        if(error!=b->completed_error||count!=(b->completed_operation==0u&&!error?b->completed_bytes:0u)
            ||(count&&!bytes))return VM_RESOURCE_ERROR_INPUT;
        /* The transport has already been admitted; never write an old reply
         * over a newer request's payload or repeat guest DMA. */
        return VM_RESOURCE_DUPLICATE;
    }
    if(b->stage&&(b->chain.epoch!=b->device.epoch||b->chain.queue_epoch!=b->device.queues[0].epoch||!b->device.queues[0].ready))return VM_RESOURCE_ERROR_STALE;
    if(!b->stage
        ||(b->operation==0u&&!error&&(count!=b->bytes||!bytes))
        ||(b->operation!=0u&&count)||(error&&count))return VM_RESOURCE_ERROR_INPUT;
    vm_resource_gate gate=b->gate;
    int result=vm_resource_complete(&gate,ticket,error?0u:b->operation==4u?1u:b->bytes);
    if(result==VM_RESOURCE_DUPLICATE){
        if(error!=b->error)return VM_RESOURCE_ERROR_INPUT;
        if(bytes)for(pl_u32 i=0u;i<count;++i)if(bytes[i]!=b->payload[i])return VM_RESOURCE_ERROR_INPUT;
        return result;
    }
    if(result)return result;
    if(b->stage!=1u)return VM_RESOURCE_ERROR_STALE;
    if(b->operation==0u&&!error)for(pl_u32 i=0u;i<count;++i)b->payload[i]=bytes[i];
    b->gate=gate;b->error=error;b->stage=2u;
    b->completed_operation=b->operation;b->completed_bytes=b->bytes;b->completed_error=error;return 0;
}
static machine_result read_stream(vm_memory *m,pl_u32 port,const vm_virtqueue_chain *c,pl_u32 first,pl_u32 bytes,pl_u8 *target)
{
    pl_u32 skip=first,done=0u;
    for(pl_u32 i=0u;i<c->count&&done<bytes;++i){const vm_virtqueue_buffer *b=c->buffers+i;
        if(b->writable)break;
        if(skip>=b->bytes){skip-=b->bytes;continue;}
        pl_u32 n=b->bytes-skip;if(n>bytes-done)n=bytes-done;
        if(n){machine_result r=vm_dma_read(m,port,b->address+skip,n,target+done);if(r)return r;}
        done+=n;skip=0u;
    }
    return done==bytes?0u:MACHINE_RESULT_ENTRY_MAP;
}
static machine_result write_stream(vm_memory *m,pl_u32 port,const vm_virtqueue_chain *c,const pl_u8 *source,pl_u32 bytes)
{
    pl_u32 remaining=bytes;
    for(pl_u32 i=0u;i<c->count&&remaining;++i){const vm_virtqueue_buffer *b=c->buffers+i;if(!b->writable)continue;
        pl_u32 n=b->bytes;if(n>remaining)n=remaining;if(n){machine_result r=vm_dma_check(m,port,b->address,n,2u);if(r)return r;}remaining-=n;}
    if(remaining)return MACHINE_RESULT_ENTRY_MAP;
    pl_u32 done=0u;for(pl_u32 i=0u;i<c->count&&done<bytes;++i){const vm_virtqueue_buffer *b=c->buffers+i;if(!b->writable)continue;
        pl_u32 n=b->bytes;if(n>bytes-done)n=bytes-done;if(n){machine_result r=vm_dma_write(m,port,b->address,n,source+done);if(r)return r;}done+=n;}
    return 0;
}
machine_result vm_block_poll(vm_block *b,vm_memory *m,pl_u32 port)
{
    if(!b||!b->device.epoch)return 0;
    if(b->stage&&(b->chain.epoch!=b->device.epoch||b->chain.queue_epoch!=b->device.queues[0].epoch||!b->device.queues[0].ready)){
        vm_resource_cancel(&b->gate,&b->ticket);b->stage=0u;}
    if(b->stage==1u)return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_BLOCK);
    if(b->stage==2u){
        machine_result r=vm_dma_check(m,port,b->status_address,1u,2u);if(r)return r;
        r=vm_dma_check(m,port,b->chain.used_entry,8u,2u);if(r)return r;r=vm_dma_check(m,port,b->chain.used_index,2u,2u);if(r)return r;
        pl_u32 written=1u;
        if(!b->error&&(b->operation==0u||b->operation==8u)){r=write_stream(m,port,&b->chain,b->payload,b->bytes);if(r)return r;written+=b->bytes;}
        pl_u8 status=(pl_u8)b->error;r=vm_dma_write(m,port,b->status_address,1u,&status);if(r)return r;
        r=vm_virtqueue_finish(&b->device,0u,m,port,&b->chain,written);if(r)return r;b->stage=0u;return 0;
    }
    /* Used.flags stays zero and EVENT_IDX is not negotiated: the standard
     * driver must kick new work. No kick and no in-flight request proves
     * that reading the unchanged avail ring cannot produce a new effect. */
    if(!b->gate.live||!(b->device.notified&1u))return 0;
    if(b->gate.grant.address.generation!=m->generation)return MACHINE_RESULT_STALE_GENERATION;
    vm_virtqueue_chain chain;machine_result r=vm_virtqueue_peek(&b->device,0u,m,port,2u,VM_DMA_MAX_BYTES,&chain);
    if(r==MACHINE_RESULT_RESOLVE_RIP)return 0;
    if(r==MACHINE_RESULT_ENTRY_MAP){vm_virtio_failed(&b->device);return 0;}
    if(r)return r;
    pl_u32 readable=0u,writable=0u,write_phase=0u;pl_u64 status_address=0u;
    for(pl_u32 i=0u;i<chain.count;++i){const vm_virtqueue_buffer *p=chain.buffers+i;
        if(p->writable){write_phase=1u;writable+=p->bytes;if(p->bytes)status_address=p->address+p->bytes-1u;}
        else{if(write_phase){vm_virtio_failed(&b->device);return 0;}readable+=p->bytes;}}
    if(readable<16u||!writable){vm_virtio_failed(&b->device);return 0;}
    pl_u8 header[16];r=read_stream(m,port,&chain,0u,16u,header);if(r)return r;
    pl_u32 op=(pl_u32)vm_memory_load(header,4u),bytes=0u,error=0u;pl_u64 sector=vm_memory_load(header+8u,8u),offset=0u;
    if(op==0u){bytes=writable-1u;if(readable!=16u||!bytes||bytes>VM_BLOCK_BYTES||bytes&511u)error=1u;}
    else if(op==1u){bytes=readable-16u;if(writable!=1u||!bytes||bytes>VM_BLOCK_BYTES||bytes&511u)error=1u;}
    else if(op==4u){if(readable!=16u||writable!=1u)error=1u;}
    else if(op==8u){bytes=20u;if(readable!=16u||writable<21u)error=1u;}
    else error=2u;
    pl_u64 capacity=vm_memory_load(b->device.config,8u)*512u;
    if((op==0u||op==1u)&&!error){if(sector>~0ull/512u||sector*512u>capacity||bytes>capacity-sector*512u)error=1u;else offset=sector*512u;}
    b->chain=chain;b->status_address=status_address;b->operation=op;b->bytes=bytes;b->offset=offset;b->error=error;
    if(error){b->stage=2u;return vm_block_poll(b,m,port);}
    if(op==8u){const pl_u8 id[20]={'o','s','-','l','e','n','g','t','h','3','-','w','o','r','k','s','p','a','c','e'};
        for(pl_u32 i=0u;i<20u;++i)b->payload[i]=id[i];
        b->stage=2u;return vm_block_poll(b,m,port);}
    if(op==1u){r=read_stream(m,port,&chain,16u,bytes,b->payload);if(r)return r;}
    vm_resource_request request={b->gate.grant.address,offset,op==4u?1u:bytes,op==0u?1u:2u};
    int accepted=vm_resource_begin(&b->gate,&request,&b->ticket);if(accepted)return MACHINE_RESULT_ENTRY_MAP;
    b->stage=1u;return machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_BLOCK);
}
