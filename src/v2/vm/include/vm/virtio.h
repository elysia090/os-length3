#ifndef VM_VIRTIO_H
#define VM_VIRTIO_H
#include <vm/dma.h>
#define VM_VIRTIO_QUEUE_SIZE 256u
#define VM_VIRTIO_QUEUE_COUNT 2u
#define VM_VIRTIO_STATUS_DRIVER_OK 4u
#define VM_VIRTIO_STATUS_FEATURES_OK 8u
#define VM_VIRTIO_STATUS_NEEDS_RESET 64u
typedef struct {
    pl_u64 descriptor,available,used,epoch;
    pl_u32 size,ready;
    pl_u16 last_available,last_used;
} vm_virtqueue;
typedef struct {
    pl_u64 address,features,driver_features,epoch;
    pl_u32 device_id,queue_count,device_selector,driver_selector,queue_selector;
    pl_u32 status,interrupt,config_generation,config_bytes,notified;
    pl_u64 notifications,polls;
    pl_u8 config[32];vm_virtqueue queues[VM_VIRTIO_QUEUE_COUNT];
} vm_virtio;
typedef struct {pl_u64 address;pl_u32 bytes,writable;} vm_virtqueue_buffer;
typedef struct {
    vm_virtqueue_buffer buffers[VM_VIRTIO_QUEUE_SIZE];
    pl_u32 count,total,head,interrupt;
    pl_u64 epoch,queue_epoch,used_entry,used_index;
} vm_virtqueue_chain;
int vm_virtio_open(vm_virtio *device,pl_u64 address,pl_u32 id,pl_u32 queues,pl_u64 features,const pl_u8 *config,pl_u32 config_bytes);
machine_result vm_virtio_register(vm_virtio *device,pl_u32 offset,pl_u32 bytes,pl_u32 access,pl_u32 phase,pl_u64 *value);
/* Read one split-ring chain; no queue advance or guest payload effect.
 * Indirect/event-index/packed rings are not advertised. Loop, extent, flags
 * and index checks precede transfer. All used destinations are preflighted. */
machine_result vm_virtqueue_peek(vm_virtio *device,pl_u32 queue,vm_memory *memory,pl_u32 port,pl_u32 writable,pl_u32 maximum_bytes,vm_virtqueue_chain *chain);
machine_result vm_virtqueue_finish(vm_virtio *device,pl_u32 queue,vm_memory *memory,pl_u32 port,const vm_virtqueue_chain *chain,pl_u32 bytes);
int vm_virtio_failed(vm_virtio *device);
#endif
