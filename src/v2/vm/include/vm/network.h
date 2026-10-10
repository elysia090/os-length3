#ifndef VM_NETWORK_H
#define VM_NETWORK_H
#include <vm/virtio.h>
#include <vm/resource.h>
#define VM_NETWORK_FRAME_BYTES 2048u
typedef struct {
    vm_virtio device;vm_resource_gate rx,tx;
    vm_resource_ticket tx_ticket;
    vm_virtqueue_chain tx_chain;
    pl_u8 receive[VM_NETWORK_FRAME_BYTES],transmit[VM_NETWORK_FRAME_BYTES];
    pl_u32 receive_bytes,receive_pending,transmit_bytes,transmit_pending;
} vm_network;
int vm_network_open(vm_network *network,pl_u64 address,const pl_u8 mac[6]);
int vm_network_bind(vm_network *network,const vm_resource_grant *grant);
int vm_network_revoke(vm_network *network);
int vm_network_receive(vm_network *network,const vm_resource_address *binding,pl_u64 sequence,const pl_u8 *frame,pl_u32 bytes);
int vm_network_transmitted(vm_network *network,const vm_resource_ticket *ticket);
machine_result vm_network_poll(vm_network *network,vm_memory *memory,pl_u32 port);
#endif
