/* Resident projection of already-admitted translations, not an x86 MMU. */
#ifndef VM_MEMORY_H
#define VM_MEMORY_H
#include <machine/memory.h>
#include <machine/result.h>

#define VM_MEMORY_PAGE_BYTES 4096u
enum vm_memory_page_kind {
    VM_MEMORY_RAM = 1u,
    VM_MEMORY_FAULT,
    VM_MEMORY_DEFERRED,
};
typedef struct {
    pl_u64 generation;
    pl_u32 port, parts;
    pl_u32 offsets[2], lengths[2];
} vm_memory_reservation;

typedef struct {
    pl_u64 address;
    pl_u32 offset;
    pl_u32 rights;
    pl_u32 kind;
    pl_u32 fault_vector;
    pl_u32 fault_error;
} vm_memory_page;
typedef struct {
    pl_u8 *bytes;
    pl_u64 byte_count;
    const vm_memory_page *pages;
    pl_u32 page_count;
    pl_u32 reserved_bytes;
    pl_u64 generation;
    pl_u32 write_touched; /* Caller-cleared mutation bit, not a counter/epoch. */
    vm_memory_reservation reservation;
} vm_memory;

/* Validate the borrowed, sorted page directory once. RAM mappings cannot
 * overlap the reserved supervisor/state/port arena. Physical aliases between
 * guest pages are allowed. Keep directory, generation, arena and residency
 * immutable until the synchronous transaction returns. Fault rows are valid
 * only for their rights mask and this generation's admitted CPU/MMU context;
 * a cached write fault is not a fault for a read. Missing entries are cache
 * misses, never proof that Linux considers a page absent. This single-owner API
 * is not a shared-worker lease or an atomic MMU permission oracle. */
int vm_memory_open(vm_memory *memory, pl_u8 *bytes, pl_u64 byte_count,
                   pl_u32 reserved_bytes, const vm_memory_page *pages,
                   pl_u32 page_count, pl_u64 generation);
machine_result vm_memory_access(vm_memory *memory, pl_u32 port_offset,
                                pl_u64 address, pl_u32 bytes,
                                pl_u32 access, pl_u64 value);
/* A synchronous single-owner reservation pins at most two physical fragments.
 * It is consumed even by a failed commit; reopen, any other access or abort
 * revokes it. No owner may mutate directory/context/residency while reserved.
 * This is not LOCK/SMP atomicity or an asynchronous worker lease. */
void vm_memory_abort(vm_memory *memory);
machine_result vm_memory_commit(vm_memory *memory, pl_u32 port_offset, pl_u64 value);
#endif
