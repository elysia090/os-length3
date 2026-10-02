#ifndef VM_MEMORY_INTERNAL_H
#define VM_MEMORY_INTERNAL_H
#include <vm/memory.h>

const vm_memory_page *vm_memory_find(vm_memory *memory, pl_u64 address);
static inline pl_u64 vm_memory_load(const pl_u8 *bytes, pl_u32 count)
{
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < count; ++i) value |= (pl_u64)bytes[i] << (i * 8u);
    return value;
}
static inline void vm_memory_store(pl_u8 *bytes, pl_u64 value, pl_u32 count)
{ for (pl_u32 i = 0u; i < count; ++i) bytes[i] = (pl_u8)(value >> (i * 8u)); }

#endif
