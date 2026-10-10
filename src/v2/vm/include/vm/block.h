#ifndef VM_BLOCK_H
#define VM_BLOCK_H
#include <vm/virtio.h>
#include <vm/resource.h>
#define VM_BLOCK_BYTES 4096u
typedef struct {
    vm_virtio device;vm_resource_gate gate;vm_resource_ticket ticket;
    vm_virtqueue_chain chain;
    pl_u8 payload[VM_BLOCK_BYTES];
    pl_u64 offset,status_address;
    pl_u32 operation,bytes,stage,error,completed_operation,completed_bytes,completed_error;
} vm_block;
int vm_block_open(vm_block *block,pl_u64 address,pl_u64 capacity_bytes);
int vm_block_bind(vm_block *block,const vm_resource_grant *grant);
int vm_block_complete(vm_block *block,const vm_resource_ticket *ticket,const pl_u8 *bytes,pl_u32 count,pl_u32 error);
machine_result vm_block_poll(vm_block *block,vm_memory *memory,pl_u32 port);
#endif
