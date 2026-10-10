#ifndef VM_DMA_H
#define VM_DMA_H
#include <vm/memory.h>
#define VM_DMA_MAX_BYTES 8192u
/* Serialized device access to physical RAM, never a guest pointer or virtual
 * MMU translation. Missing physical pages request the ordinary supply owner.
 * Preflight the entire bounded extent before a read output or first store.
 * The owner pins generation/directory/RAM throughout the call; asynchronous
 * replies must revalidate their device ticket and re-preflight before DMA. */
machine_result vm_dma_check(vm_memory *memory,pl_u32 port,pl_u64 address,pl_u32 bytes,pl_u32 access);
machine_result vm_dma_read(vm_memory *memory,pl_u32 port,pl_u64 address,pl_u32 bytes,pl_u8 *target);
machine_result vm_dma_write(vm_memory *memory,pl_u32 port,pl_u64 address,pl_u32 bytes,const pl_u8 *source);
#endif
