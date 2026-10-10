#ifndef VM_MEMORY_INTERNAL_H
#define VM_MEMORY_INTERNAL_H
#include <vm/memory.h>

const vm_memory_page *vm_memory_find(vm_memory *memory, pl_u64 address);
const vm_memory_page *vm_memory_find_readonly(const vm_memory *memory,pl_u64 address);
machine_result vm_memory_device_check(vm_memory *memory,pl_u64 address,pl_u32 bytes,pl_u32 access);
machine_result vm_memory_device_word(vm_memory *memory,pl_u32 port,pl_u64 address,pl_u32 bytes,pl_u32 access,pl_u64 value);
void vm_memory_walk_publish(vm_memory *memory,pl_u32 rank,const vm_walk_proof *proof);
void vm_memory_walk_write(vm_memory *memory,pl_u32 offset,pl_u32 bytes);
static inline pl_u32 vm_memory_walk_rank(pl_u64 address)
{
    pl_u64 page=address>>12u;
    /* Preserve low-page locality without mapping every64-page stride onto
     * one slot. This only selects a candidate; the complete witness matches. */
    return (pl_u32)(page^(page>>6u)^(page>>12u)^(page>>18u))&63u;
}
static inline void vm_memory_before_write(vm_memory *memory, pl_u32 offset, pl_u32 bytes)
{
    vm_memory_walk_write(memory,offset,bytes);
    if (memory->before_write) memory->before_write(memory->write_owner,offset,bytes);
}
static inline pl_u64 vm_memory_load(const pl_u8 *bytes, pl_u32 count)
{
#if defined(__GNUC__) && defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    /* Fixed-width memcpy is an unaligned, alias-safe exact extent. It lets
     * the compiler retain one physical word instead of eight byte lanes. */
    if(count==8u){pl_u64 word;__builtin_memcpy(&word,bytes,8u);return word;}
    if(count==4u){pl_u32 word;__builtin_memcpy(&word,bytes,4u);return word;}
    if(count==2u){pl_u16 word;__builtin_memcpy(&word,bytes,2u);return word;}
#endif
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < count; ++i) value |= (pl_u64)bytes[i] << (i * 8u);
    return value;
}
static inline void vm_memory_store(pl_u8 *bytes, pl_u64 value, pl_u32 count)
{
#if defined(__GNUC__) && defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    if(count==8u){__builtin_memcpy(bytes,&value,8u);return;}
    if(count==4u){pl_u32 word=(pl_u32)value;__builtin_memcpy(bytes,&word,4u);return;}
    if(count==2u){pl_u16 word=(pl_u16)value;__builtin_memcpy(bytes,&word,2u);return;}
#endif
    for (pl_u32 i = 0u; i < count; ++i) bytes[i] = (pl_u8)(value >> (i * 8u));
}

#endif
