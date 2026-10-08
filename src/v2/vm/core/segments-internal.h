#ifndef VM_SEGMENTS_INTERNAL_H
#define VM_SEGMENTS_INTERNAL_H
#include <vm/segments.h>
machine_result vm_descriptor_read(vm_memory *memory,pl_u32 port,const machine_state *state,
    const machine_segments *segments,pl_u32 selector,pl_u32 external,pl_u64 *address,pl_u64 *value);
machine_result vm_descriptor_accessed(vm_memory *memory,pl_u32 port,const machine_state *state,pl_u64 address,pl_u32 access);
void vm_segments_outer(machine_state *state,machine_segments *segments,pl_u32 cpl);
static inline machine_segment_cache vm_segment_cache_raw(pl_u64 descriptor)
{
    machine_segment_cache cache;
    cache.base = ((descriptor >> 16u) & 0xffffffu) | ((descriptor >> 32u) & 0xff000000u);
    cache.limit = (pl_u32)(descriptor & 65535u) | (pl_u32)((descriptor >> 32u) & 0xf0000u);
    cache.attributes = (pl_u32)((descriptor >> 40u) & 255u)
                     | (pl_u32)((descriptor >> 40u) & 0xf000u);
    if (cache.attributes & 0x8000u) cache.limit = (cache.limit << 12u) | 4095u;
    return cache;
}
static inline machine_segment_cache vm_segment_cache_decode(pl_u64 descriptor)
{
    machine_segment_cache cache=vm_segment_cache_raw(descriptor);
    cache.attributes|=1u; /* Code/data Accessed, not a system type bit. */
    return cache;
}
#endif
