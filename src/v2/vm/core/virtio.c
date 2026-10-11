#include <vm/virtio.h>
#include "memory-internal.h"
#include <stddef.h>
int vm_virtio_open(vm_virtio *d,pl_u64 address,pl_u32 id,pl_u32 queues,pl_u64 features,const pl_u8 *config,pl_u32 bytes)
{
    if(!d||!id||!queues||queues>VM_VIRTIO_QUEUE_COUNT||(address&4095u)||address>=(1ull<<40u)
        ||bytes>sizeof d->config||(bytes&&!config)||!(features&(1ull<<32u)))return -1;
    *d=(vm_virtio){.address=address,.device_id=id,.queue_count=queues,.features=features,.config_bytes=bytes,.epoch=1u};
    for(pl_u32 n=0u;n<bytes;++n)d->config[n]=config[n];
    return 0;
}
int vm_virtio_failed(vm_virtio *d)
{if(!d)return -1;d->status|=VM_VIRTIO_STATUS_NEEDS_RESET;d->interrupt|=2u;return 0;}
static int writable(pl_u32 at)
{
    switch(at){case 0x14:case 0x20:case 0x24:case 0x30:case 0x38:case 0x44:case 0x50:case 0x64:case 0x70:
        case 0x80:case 0x84:case 0x90:case 0x94:case 0xa0:case 0xa4:return 1;default:return 0;}
}
static int ring_extent(pl_u64 address,pl_u32 bytes)
{return address<(1ull<<40u)&&bytes<=(1ull<<40u)-address;}
machine_result vm_virtio_register(vm_virtio *d,pl_u32 at,pl_u32 bytes,pl_u32 access,pl_u32 phase,pl_u64 *value)
{
    if(!d||!d->epoch||!value||phase>2u||(access&3u)<1u||(access&3u)>2u
        ||(phase==1u&&(access&3u)!=1u)||(phase==2u&&(access&3u)!=2u))return MACHINE_RESULT_ENTRY_MAP;
    pl_u32 write=(access&2u)!=0u;
    if(at>=0x100u){pl_u32 n=at-0x100u;
        if(write||(bytes!=1u&&bytes!=2u&&bytes!=4u)||(at&(bytes-1u))||n>d->config_bytes||bytes>d->config_bytes-n)return MACHINE_RESULT_ENTRY_MAP;
        if(phase==1u)*value=vm_memory_load(d->config+n,bytes);
        return 0;
    }
    if(bytes!=4u||(at&3u)||at>0xfcu||(write&&!writable(at)))return MACHINE_RESULT_ENTRY_MAP;
    if(!phase)return 0;
    vm_virtqueue *q=d->queue_selector<d->queue_count?d->queues+d->queue_selector:NULL;
    pl_u32 word=(pl_u32)*value;
    if(!write){word=0u;switch(at){
        case 0:word=0x74726976u;break;case 4:word=2u;break;case 8:word=d->device_id;break;case 12:word=0x4c334f53u;break;
        case 0x10:word=d->device_selector<2u?(pl_u32)(d->features>>(d->device_selector*32u)):0u;break;
        case 0x34:word=q?VM_VIRTIO_QUEUE_SIZE:0u;break;case 0x44:word=q?q->ready:0u;break;
        case 0x60:word=d->interrupt;break;case 0x70:word=d->status;break;case 0xfc:word=d->config_generation;break;
        default:break;}*value=word;return 0;}
    switch(at){
    case 0x14:d->device_selector=word;break;case 0x24:d->driver_selector=word;break;
    case 0x20:if(d->driver_selector<2u&&!(d->status&8u)){pl_u32 shift=d->driver_selector*32u;
        d->driver_features=(d->driver_features&~(0xffffffffull<<shift))|((pl_u64)word<<shift);}break;
    case 0x30:d->queue_selector=word;break;
    case 0x70:
        if(!word){if(d->epoch==~0ull)return MACHINE_RESULT_ENTRY_MAP;vm_virtio fresh=*d;fresh.status=fresh.interrupt=fresh.notified=0u;
            fresh.driver_features=0u;fresh.device_selector=fresh.driver_selector=fresh.queue_selector=0u;++fresh.epoch;
            for(pl_u32 n=0u;n<VM_VIRTIO_QUEUE_COUNT;++n)fresh.queues[n]=(vm_virtqueue){0};
            *d=fresh;break;}
        if((word&d->status)!=d->status||(word&~0xcful))return MACHINE_RESULT_ENTRY_MAP;
        if((word&8u)&&(!(d->driver_features&(1ull<<32u))||(d->driver_features&~d->features)))word&=~8u;
        if((word&4u)&&(word&11u)!=11u)return MACHINE_RESULT_ENTRY_MAP;
        d->status=word;break;
    case 0x64:d->interrupt&=~(word&3u);break;
    case 0x50:if(word<d->queue_count&&d->queues[word].ready){d->notified|=1u<<word;if(d->notifications!=~0ull)++d->notifications;}break;
    case 0x44:
        if(q){if(word>1u)return MACHINE_RESULT_ENTRY_MAP;
            if(word&&(!q->size||q->size>VM_VIRTIO_QUEUE_SIZE||(q->size&(q->size-1u))
                ||(q->descriptor&15u)||(q->available&1u)||(q->used&3u)
                ||!ring_extent(q->descriptor,16u*q->size)||!ring_extent(q->available,4u+2u*q->size)
                ||!ring_extent(q->used,4u+8u*q->size)))return MACHINE_RESULT_ENTRY_MAP;
            if(word&&!q->ready){if(q->epoch==~0ull)return MACHINE_RESULT_ENTRY_MAP;++q->epoch;}
            q->ready=word;if(!word)d->notified&=~(1u<<d->queue_selector);}break;
    default:
        if(q){if(q->ready)return MACHINE_RESULT_ENTRY_MAP;
            if(at==0x38u){if(!word||word>VM_VIRTIO_QUEUE_SIZE||(word&(word-1u)))return MACHINE_RESULT_ENTRY_MAP;q->size=word;}
            else{pl_u64 *field=at<0x90u?&q->descriptor:at<0xa0u?&q->available:&q->used;
                pl_u32 shift=(at&4u)?32u:0u;*field=(*field&~(0xffffffffull<<shift))|((pl_u64)word<<shift);
                q->last_available=q->last_used=0u;}}break;
    }
    return 0;
}
static machine_result read_word(vm_memory *m,pl_u32 port,pl_u64 address,pl_u32 bytes,pl_u64 *out)
{pl_u8 record[8];machine_result r=vm_dma_read(m,port,address,bytes,record);if(!r)*out=vm_memory_load(record,bytes);return r;}
machine_result vm_virtqueue_peek(vm_virtio *d,pl_u32 rank,vm_memory *m,pl_u32 port,pl_u32 writable_buffers,pl_u32 maximum,vm_virtqueue_chain *out)
{
    if(!d||!out||rank>=d->queue_count||writable_buffers>2u||!maximum||maximum>VM_DMA_MAX_BYTES)return MACHINE_RESULT_ENTRY_MAP;
    vm_virtqueue *q=d->queues+rank;
    if((d->status&0xcfu)!=15u||!q->ready)return MACHINE_RESULT_RESOLVE_RIP;
    if(d->polls!=~0ull)++d->polls;
    pl_u64 word;machine_result result=read_word(m,port,q->available,4u,&word);if(result)return result;
    pl_u32 available=(pl_u32)(word>>16u);pl_u32 delta=(pl_u16)(available-q->last_available);
    if(!delta){d->notified&=~(1u<<rank);return MACHINE_RESULT_RESOLVE_RIP;}
    if(delta>q->size)return MACHINE_RESULT_ENTRY_MAP;
    vm_virtqueue_chain chain={.epoch=d->epoch,.queue_epoch=q->epoch,.interrupt=!(word&1u)};
    result=read_word(m,port,q->available+4u+(pl_u64)(q->last_available&(q->size-1u))*2u,2u,&word);if(result)return result;
    chain.head=(pl_u32)word;pl_u32 next=chain.head;
    for(;;){if(next>=q->size||chain.count>=q->size)return MACHINE_RESULT_ENTRY_MAP;
        pl_u8 record[16];result=vm_dma_read(m,port,q->descriptor+(pl_u64)next*16u,16u,record);if(result)return result;
        pl_u64 address=vm_memory_load(record,8u);pl_u32 bytes=(pl_u32)vm_memory_load(record+8u,4u),flags=(pl_u32)vm_memory_load(record+12u,2u);
        if((flags&~3u)||(writable_buffers<2u&&!!(flags&2u)!=writable_buffers)||bytes>maximum-chain.total)return MACHINE_RESULT_ENTRY_MAP;
        chain.buffers[chain.count++]=(vm_virtqueue_buffer){address,bytes,!!(flags&2u)};chain.total+=bytes;
        if(bytes){result=vm_dma_check(m,port,address,bytes,(flags&2u)?2u:1u);if(result)return result;}
        if(!(flags&1u))break;
        next=(pl_u32)vm_memory_load(record+14u,2u);
    }
    chain.used_entry=q->used+4u+(pl_u64)(q->last_used&(q->size-1u))*8u;chain.used_index=q->used+2u;
    result=vm_dma_check(m,port,chain.used_entry,8u,2u);if(result)return result;
    result=vm_dma_check(m,port,chain.used_index,2u,2u);if(result)return result;
    *out=chain;return 0;
}
machine_result vm_virtqueue_finish(vm_virtio *d,pl_u32 rank,vm_memory *m,pl_u32 port,const vm_virtqueue_chain *c,pl_u32 bytes)
{
    if(!d||!c||rank>=d->queue_count||c->epoch!=d->epoch||c->queue_epoch!=d->queues[rank].epoch||!d->queues[rank].ready||bytes>c->total)return MACHINE_RESULT_ENTRY_MAP;
    vm_virtqueue *q=d->queues+rank;
    if(c->used_index!=q->used+2u||c->used_entry!=q->used+4u+(pl_u64)(q->last_used&(q->size-1u))*8u)return MACHINE_RESULT_ENTRY_MAP;
    machine_result r=vm_dma_check(m,port,c->used_entry,8u,2u);if(r)return r;
    r=vm_dma_check(m,port,c->used_index,2u,2u);if(r)return r;
    pl_u64 flags;r=read_word(m,port,q->available,2u,&flags);if(r)return r;
    pl_u8 record[8];vm_memory_store(record,c->head,4u);vm_memory_store(record+4u,bytes,4u);
    r=vm_dma_write(m,port,c->used_entry,8u,record);if(r)return r;
    vm_memory_store(record,(pl_u16)(q->last_used+1u),2u);r=vm_dma_write(m,port,c->used_index,2u,record);if(r)return r;
    ++q->last_used;++q->last_available;if(!(flags&1u))d->interrupt|=1u;return 0;
}
