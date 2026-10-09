#include <vm/mmu.h>
#include "memory-internal.h"
#include <stddef.h>
#include <stdint.h>

#define PHYSICAL_MASK 0x000000fffffff000ull
#define NX (1ull << 63u)
#define PRESENT 1u
#define WRITABLE 2u
#define USER 4u
#define ACCESSED 32u
#define DIRTY 64u
#define LARGE 128u

static machine_result pending(pl_u8 *port, pl_u64 address, pl_u32 bytes, pl_u32 access)
{
    vm_memory_store(port + offsetof(machine_memory_port, request_address), address, 8u);
    vm_memory_store(port + offsetof(machine_memory_port, request_bytes), bytes, 4u);
    vm_memory_store(port + offsetof(machine_memory_port, request_access),
                    access | VM_MMU_PHYSICAL_REQUEST, 4u);
    return machine_result_make(MACHINE_RESULT_BARRIER, 0u);
}

static machine_result exception(pl_u8 *port, pl_u64 address, pl_u32 vector, pl_u32 error)
{
    vm_memory_store(port + offsetof(machine_memory_port, fault_address), address, 8u);
    vm_memory_store(port + offsetof(machine_memory_port, fault_vector), vector, 4u);
    vm_memory_store(port + offsetof(machine_memory_port, fault_error), error, 4u);
    return machine_result_make(MACHINE_RESULT_FAULT, vector);
}

static machine_result resident_word(vm_memory *memory, pl_u8 *port,
                                    pl_u64 address, pl_u32 access, pl_u32 bytes,
                                    pl_u8 **result, pl_u32 *discard,int observe)
{
    const vm_memory_page *page = observe?vm_memory_find_readonly(memory,address):vm_memory_find(memory, address);
    if (!page || (page->kind != VM_MEMORY_RAM && page->kind != VM_MEMORY_ROM)
            || (page->rights & access) != access)
        return pending(port, address, bytes, access);
    *result = memory->bytes + page->offset + (pl_u32)(address & 4095u);
    if (discard) *discard = page->kind == VM_MEMORY_ROM;
    return 0u;
}

static int context_supported(const vm_mmu_context *context)
{
    /* Long mode and 4 KiB/2 MiB paging only; control-register legality must
     * already be enforced at the compiled machine-operation boundary. */
    pl_u64 forbidden = (1ull << 12u) | (1ull << 17u) | (1ull << 20u)
                     | (1ull << 21u) | (1ull << 22u) | (1ull << 24u);
    return context && context->cpl <= 3u
        && (context->cr0 & 0x80000001ull) == 0x80000001ull
        && (context->cr4 & 32u) && !(context->cr4 & forbidden)
        && (context->efer & 0x500u) == 0x500u
        && !(context->cr3 & ~0x000000ffffffffffull)
        && !(context->cr3 & 0xfe7u);
}

static machine_result walk(vm_memory *memory, pl_u8 *port,
                            const vm_mmu_context *context, pl_u64 address,
                            pl_u32 access, pl_u64 *physical,int observe)
{
    vm_walk_proof *retained=&memory->walks[(address>>12u)&63u];
    if(!observe&&retained->depth&&retained->depth<=4u&&retained->virtual_page==(address&~4095ull)
        &&retained->access==access&&retained->cpl==context->cpl
        &&retained->control[0]==context->cr0&&retained->control[1]==context->cr3
        &&retained->control[2]==context->cr4&&retained->control[3]==context->efer){
        pl_u32 matched=1u;
        for(pl_u32 n=0u;n<retained->depth;++n){const vm_walk_ancestor *a=retained->ancestors+n;
            if(a->rank>=memory->page_count||(pl_u64)a->offset+8u>memory->byte_count){matched=0u;break;}
            const vm_memory_page *page=memory->pages+a->rank;
            if(page->address!=a->page||page->offset!=(a->offset&~4095u)
                ||(page->kind!=VM_MEMORY_RAM&&page->kind!=VM_MEMORY_ROM)||!(page->rights&MACHINE_MEMORY_READ)
                ||vm_memory_load(memory->bytes+a->offset,8u)!=a->entry){matched=0u;break;}
        }
        if(matched){
#ifdef VM_SOURCE_PROFILE
            ++memory->walk_proof_hits;
#endif
            *physical=retained->physical_page|(address&4095u);return 0u;
        }
    }
#ifdef VM_SOURCE_PROFILE
    if(!observe)++memory->walk_proof_misses;
#endif
    vm_walk_proof fresh={.virtual_page=address&~4095ull,
        .control={context->cr0,context->cr3,context->cr4,context->efer},.cpl=context->cpl,.access=access};
    pl_u32 retainable=1u;
    const pl_u32 shifts[] = { 39u, 30u, 21u, 12u };
    pl_u64 table = context->cr3 & PHYSICAL_MASK;
    pl_u32 writable = WRITABLE, user = USER, nx = 0u;
    pl_u32 write = !!(access & MACHINE_MEMORY_WRITE);
    pl_u32 execute = !!(access & VM_MMU_EXECUTE);
    pl_u32 is_user = context->cpl == 3u;
    pl_u32 error = write * 2u | is_user * 4u
                 | (execute && (context->efer & (1ull << 11u)) ? 16u : 0u);
    for (pl_u32 level = 0u; level < 4u; ++level) {
        pl_u64 at = table + ((address >> shifts[level]) & 511u) * 8u;
        pl_u8 *entry_bytes = NULL;
        pl_u32 discard = 0u;
        machine_result status = resident_word(memory, port, at, MACHINE_MEMORY_READ, 8u, &entry_bytes,&discard,observe);
        if (status) return status;
        pl_u64 entry = vm_memory_load(entry_bytes, 8u);
        if (!(entry & PRESENT)) return exception(port, address, 14u, error);
        pl_u64 reserved = 0x000fff0000000000ull;
        if (!(context->efer & (1ull << 11u))) reserved |= NX;
        if (level < 2u) reserved |= LARGE; /* No exposed 1 GiB capability. */
        pl_u32 leaf = level == 3u || (level == 2u && (entry & LARGE));
        pl_u32 shift = leaf ? shifts[level] : 12u;
        if (leaf && shift == 21u) reserved |= 0x1fe000u;
        if (entry & reserved) return exception(port, address, 14u, error | 9u);
        writable &= (pl_u32)entry & WRITABLE;
        user &= (pl_u32)entry & USER;
        nx |= !!(entry & NX);
        if (leaf && ((is_user && !user) || (execute && nx)
                || (write && !writable && (is_user || (context->cr0 & 0x10000u)))))
            return exception(port, address, 14u, error | 1u);
        pl_u32 set = ACCESSED | (leaf && write ? DIRTY : 0u);
        if (!observe&&(set & ~(pl_u32)entry)) {
            pl_u8 *writable_entry = NULL;
            status = resident_word(memory, port, at, MACHINE_MEMORY_WRITE, 8u, &writable_entry,NULL,0);
            if (status) return status;
            /* Serialized, pinned owner: no competing CPU/device/table writer
             * can occur between this load and store. This is not SMP CAS. */
            if (!discard) {
                vm_memory_before_write(memory,(pl_u32)(writable_entry - memory->bytes),8u);
                vm_memory_store(writable_entry, entry | set, 8u);
                memory->write_touched = 1u;
            }
        }
        const vm_memory_page *owner=observe?vm_memory_find_readonly(memory,at):vm_memory_find(memory,at);
        pl_u64 current_entry=vm_memory_load(entry_bytes,8u);
        /* A ROM walk with missing A/D still performs the write-rights check
         * on every access. It has no successful substitution witness. */
        if(set&~(pl_u32)current_entry)retainable=0u;
        fresh.ancestors[level]=(vm_walk_ancestor){owner->address,current_entry,
            (pl_u32)(owner-memory->pages),(pl_u32)(entry_bytes-memory->bytes)};
        if (leaf) {
            pl_u64 offset_mask = (1ull << shift) - 1u;
            *physical = (entry & PHYSICAL_MASK & ~offset_mask) | (address & offset_mask);
            if(!observe&&retainable){fresh.physical_page=*physical&~4095ull;fresh.depth=level+1u;*retained=fresh;}
            return 0u;
        }
        table = entry & PHYSICAL_MASK;
    }
    return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
}
int vm_mmu_observe_string(vm_memory *memory,const vm_mmu_context *context,pl_u64 address,pl_u8 target[64])
{
    if(!memory||!memory->bytes||!target||!context_supported(context))return -1;
    uintptr_t output=(uintptr_t)target,storage=(uintptr_t)memory->bytes;
    if(output>UINTPTR_MAX-64u||storage>UINTPTR_MAX-memory->byte_count
        ||(output<storage+memory->byte_count&&storage<output+64u))return -1;
    pl_u8 port[sizeof(machine_memory_port)]={0};pl_u32 copied=0u;
    while(copied<64u){pl_u64 current=address+copied,physical;
        if(current<address||(current>>47u!=0u&&current>>47u!=0x1ffffu)
            ||walk(memory,port,context,current,MACHINE_MEMORY_READ,&physical,1))return -1;
        const vm_memory_page *page=vm_memory_find_readonly(memory,physical);
        if(!page||(page->kind!=VM_MEMORY_RAM&&page->kind!=VM_MEMORY_ROM)||!(page->rights&MACHINE_MEMORY_READ)
            ||(pl_u64)page->offset+4096u>memory->byte_count)return -1;
        pl_u32 offset=(pl_u32)(physical&4095u),count=4096u-offset;if(count>64u-copied)count=64u-copied;
        const pl_u8 *source=memory->bytes+page->offset+offset;
        for(pl_u32 n=0u;n<count;++n){pl_u8 byte=source[n];target[copied++]=byte;if(!byte)return (int)copied;}
    }
    return 64;
}

static machine_result preflight(vm_memory *memory, pl_u32 port_offset,
                                 const vm_mmu_context *context, pl_u64 address,
                                 pl_u32 bytes, pl_u32 access, pl_u32 maximum_bytes,
                                 vm_memory_reservation *ready)
{
    vm_memory_abort(memory);
    if (!memory || !memory->bytes || !memory->generation || !context_supported(context)
            || (port_offset & 7u)
            || (pl_u64)port_offset + sizeof(machine_memory_port) > memory->reserved_bytes
            || !bytes || bytes > maximum_bytes || !ready
            || (access & ~(47u|MACHINE_MEMORY_ALIGNED8)) || !(access & 3u)
            || ((access & VM_MMU_ALIGNED16) && bytes != 16u && maximum_bytes==16u)
            || ((access & MACHINE_MEMORY_ALIGNED8) && bytes!=8u)
            || ((access & VM_MMU_EXECUTE) && (access & (MACHINE_MEMORY_WRITE | MACHINE_MEMORY_STACK))))
        return machine_result_make(MACHINE_RESULT_ENTRY_MAP, 0u);
    pl_u8 *port = memory->bytes + port_offset;
    if (vm_memory_load(port, 8u) != memory->generation)
        return machine_result_make(MACHINE_RESULT_STALE_GENERATION, 0u);
    if ((address >> 47u != 0u && address >> 47u != 0x1ffffu)
            || address > ~0ull - (bytes - 1u)
            || ((address + bytes - 1u) >> 47u != 0u && (address + bytes - 1u) >> 47u != 0x1ffffu))
        return exception(port, address, access & MACHINE_MEMORY_STACK ? 12u : 13u, 0u);
    if ((access & VM_MMU_ALIGNED16) && (address & 15u))
        return exception(port,address,13u,0u);
    if ((access & MACHINE_MEMORY_ALIGNED8) && (address & 7u))return exception(port,address,13u,0u);
    *ready = (vm_memory_reservation){ .generation = memory->generation, .port = port_offset };
    pl_u32 consumed = 0u;
    while (consumed < bytes) {
        pl_u64 current = address + consumed, physical = 0u;
        machine_result status = walk(memory, port, context, current, access, &physical,0);
        if (status) return status;
        pl_u32 length = 4096u - (pl_u32)(current & 4095u);
        if (length > bytes - consumed) length = bytes - consumed;
        pl_u8 *fragment = NULL;
        pl_u32 discard = 0u;
        status = resident_word(memory, port, physical, access & 3u, length, &fragment,&discard,0);
        if (status) return status;
        ready->discard |= discard << ready->parts;
        ready->offsets[ready->parts] = (pl_u32)(fragment - memory->bytes);
        ready->lengths[ready->parts++] = length;
        consumed += length;
    }
    return 0u;
}

machine_result vm_mmu_access(vm_memory *memory, pl_u32 port_offset,
                             const vm_mmu_context *context, pl_u64 address,
                             pl_u32 bytes, pl_u32 access, pl_u64 value)
{
    vm_memory_abort(memory);
    if ((bytes != 1u && bytes != 2u && bytes != 4u && bytes != 8u)
            || ((access & 3u) != MACHINE_MEMORY_READ && (access & 3u) != MACHINE_MEMORY_WRITE))
        return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result status = preflight(memory, port_offset, context, address, bytes, access,16u,&ready);
    if (status) return status;
    pl_u32 consumed = 0u;
    if (access & MACHINE_MEMORY_WRITE) {
        for (pl_u32 i = 0u; i < ready.parts; ++i) {
            if (!(ready.discard & (1u << i))) {
                vm_memory_before_write(memory,ready.offsets[i],ready.lengths[i]);
                vm_memory_store(memory->bytes + ready.offsets[i], value >> (consumed * 8u), ready.lengths[i]);
                memory->write_touched = 1u;
            }
            consumed += ready.lengths[i];
        }
    } else {
        value = 0u;
        for (pl_u32 i = 0u; i < ready.parts; ++i) {
            value |= vm_memory_load(memory->bytes + ready.offsets[i], ready.lengths[i]) << (consumed * 8u);
            consumed += ready.lengths[i];
        }
        vm_memory_store(memory->bytes + port_offset + offsetof(machine_memory_port, value), value, 8u);
    }
    return 0u;
}

machine_result vm_mmu_reserve(vm_memory *memory, pl_u32 port_offset,
                              const vm_mmu_context *context, pl_u64 address,
                              pl_u32 bytes, pl_u32 access)
{
    vm_memory_abort(memory);
    if ((bytes != 1u && bytes != 2u && bytes != 4u && bytes != 8u)
            || (access & ~7u) || (access & 3u) != 3u) return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result status = preflight(memory, port_offset, context, address, bytes, access,16u,&ready);
    if (status) return status;
    pl_u64 value = 0u;
    pl_u32 consumed = 0u;
    for (pl_u32 i = 0u; i < ready.parts; ++i) {
        value |= vm_memory_load(memory->bytes + ready.offsets[i], ready.lengths[i]) << (consumed * 8u);
        consumed += ready.lengths[i];
    }
    vm_memory_store(memory->bytes + port_offset + offsetof(machine_memory_port, value), value, 8u);
    memory->reservation = ready;
    return 0u;
}

machine_result vm_mmu_reserve_record(vm_memory *memory, pl_u32 port_offset,
                                     const vm_mmu_context *context, pl_u64 address,
                                     pl_u32 bytes, pl_u8 *target)
{ return vm_mmu_reserve_record_access(memory,port_offset,context,address,bytes,3u,target); }

machine_result vm_mmu_reserve_record_access(vm_memory *memory, pl_u32 port_offset,
                                            const vm_mmu_context *context, pl_u64 address,
                                            pl_u32 bytes, pl_u32 access, pl_u8 *target)
{
    vm_memory_abort(memory);
    if (!target || (access & ~39u) || (access & 3u)!=3u) return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result status=preflight(memory,port_offset,context,address,bytes,access,16u,&ready);
    if (status) return status;
    pl_u32 consumed=0u;
    for (pl_u32 i=0u;i<ready.parts;++i)
        for (pl_u32 j=0u;j<ready.lengths[i];++j)
            target[consumed++]=memory->bytes[ready.offsets[i]+j];
    memory->reservation=ready;
    return 0u;
}

/* Private, bounded architectural records (e.g. the ten-byte GDTR operand).
 * No payload is copied until every fragment has passed the same MMU checks. */
machine_result vm_mmu_read_record(vm_memory *memory, pl_u32 port_offset,
                                  const vm_mmu_context *context, pl_u64 address,
                                  pl_u32 bytes, pl_u32 access, pl_u8 *target)
{
    vm_memory_abort(memory);
    if (!target || (access & ~39u) || (access & 3u) != MACHINE_MEMORY_READ)
        return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result status = preflight(memory, port_offset, context, address, bytes, access,16u,&ready);
    if (status) return status;
    pl_u32 consumed = 0u;
    for (pl_u32 i = 0u; i < ready.parts; ++i)
        for (pl_u32 j = 0u; j < ready.lengths[i]; ++j)
            target[consumed++] = memory->bytes[ready.offsets[i] + j];
    return 0u;
}

machine_result vm_mmu_read_pair(vm_memory *memory, pl_u32 port_offset,
                                const vm_mmu_context *context, pl_u64 address,
                                pl_u32 bytes, pl_u32 access)
{
    vm_memory_abort(memory);
    if (!memory || !memory->bytes || !bytes || bytes>16u || (access & ~39u)
            || (access & 3u)!=MACHINE_MEMORY_READ
            || (pl_u64)port_offset+sizeof(machine_memory_pair_port)>memory->reserved_bytes)
        return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result result=preflight(memory,port_offset,context,address,bytes,access,16u,&ready);
    if (result) return result;
    /* Substitute the exact 1..16-byte extent into the two final words. There
     * is no sixteen-byte intermediate record or second translation. Each
     * fragment ends at its physical page; each word ends at bit 63. */
    const pl_u8 *first=memory->bytes+ready.offsets[0];
    pl_u32 n=ready.lengths[0];pl_u64 low,high;
    if(bytes<=8u){
        low=vm_memory_load(first,n);high=0u;
        if(n<bytes)low|=vm_memory_load(memory->bytes+ready.offsets[1],bytes-n)<<(n*8u);
    }else if (n>=8u) {
        low=vm_memory_load(first,8u);high=vm_memory_load(first+8u,n-8u);
        if (n<bytes) high|=vm_memory_load(memory->bytes+ready.offsets[1],bytes-n)<<((n-8u)*8u);
    } else {
        const pl_u8 *second=memory->bytes+ready.offsets[1];
        low=vm_memory_load(first,n)|(vm_memory_load(second,8u-n)<<(n*8u));
        high=vm_memory_load(second+8u-n,bytes-8u);
    }
    vm_memory_store(memory->bytes+port_offset+offsetof(machine_memory_port,value),low,8u);
    vm_memory_store(memory->bytes+port_offset+offsetof(machine_memory_pair_port,high),high,8u);
    return 0u;
}

machine_result vm_mmu_read_extent(vm_memory *memory, pl_u32 port_offset,
                                  const vm_mmu_context *context, pl_u64 address,
                                  pl_u32 bytes, pl_u32 access)
{
    vm_memory_abort(memory);
    if (!memory || !memory->bytes || (access & ~39u)
            || (access & 3u)!=MACHINE_MEMORY_READ
            || (pl_u64)port_offset+sizeof(machine_memory_extent_port)>memory->reserved_bytes)
        return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result result=preflight(memory,port_offset,context,address,bytes,access,512u,&ready);
    if (result) return result;
    for (pl_u32 i=0u;i<2u;++i) {
        vm_memory_store(memory->bytes+port_offset+offsetof(machine_memory_extent_port,offsets)+i*4u,
            i<ready.parts ? ready.offsets[i] : 0u,4u);
        vm_memory_store(memory->bytes+port_offset+offsetof(machine_memory_extent_port,lengths)+i*4u,
            i<ready.parts ? ready.lengths[i] : 0u,4u);
    }
    return 0u;
}

machine_result vm_mmu_code_page(vm_memory *memory, pl_u32 port_offset,
                                const vm_mmu_context *context, pl_u64 address,
                                vm_code_page *target)
{
    vm_memory_abort(memory);
    if (!target) return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result status = preflight(memory,port_offset,context,address,1u,
                                      (pl_u32)MACHINE_MEMORY_READ | (pl_u32)VM_MMU_EXECUTE,16u,&ready);
    if (status) return status;
    /* Translation and residency have 4 KiB minimum granularity, including
     * a 2 MiB leaf. The byte's page offset is preserved by the page walk. */
    *target = (vm_code_page){address & ~4095ull,memory->generation,
                            ready.offsets[0] - (pl_u32)(address & 4095u),4096u};
    return 0u;
}

machine_result vm_mmu_write_begin(vm_memory *memory, pl_u32 port_offset,
                                  const vm_mmu_context *context, pl_u64 address,
                                  pl_u32 bytes, pl_u32 access)
{
    vm_memory_abort(memory);
    if ((access & ~39u) || (access & 3u)!=MACHINE_MEMORY_WRITE)
        return MACHINE_RESULT_ENTRY_MAP;
    vm_memory_reservation ready;
    machine_result status=preflight(memory,port_offset,context,address,bytes,access,
                                    VM_MEMORY_MAX_WRITE_BYTES,&ready);
    if (status) return status;
    ready.discard|=VM_MEMORY_WRITE_FRONTIER;
    memory->reservation=ready;
    return 0u;
}
