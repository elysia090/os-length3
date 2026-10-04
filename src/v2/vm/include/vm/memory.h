/* Resident pages and bus mutability; guest translation belongs to the MMU. */
#ifndef VM_MEMORY_H
#define VM_MEMORY_H
#include <machine/memory.h>
#include <machine/result.h>

#define VM_MEMORY_PAGE_BYTES 4096u
enum vm_memory_page_kind {
    VM_MEMORY_RAM = 1u,
    VM_MEMORY_FAULT,
    VM_MEMORY_DEFERRED,
    VM_MEMORY_ROM,
};
typedef struct {
    pl_u64 generation;
    pl_u32 port, parts;
    pl_u32 offsets[2], lengths[2];
    pl_u32 discard; /* Physical ROM fragments; guest paging rights checked first. */
    pl_u32 cursor; /* Ordered sparse stores; occupies the former tail padding. */
} vm_memory_reservation;

#define VM_MEMORY_WRITE_FRONTIER 0x80000000u
#define VM_MEMORY_MAX_WRITE_BYTES 512u

typedef struct {
    pl_u64 address;
    pl_u32 offset;
    pl_u32 rights;
    pl_u32 kind;
    pl_u32 fault_vector;
    pl_u32 fault_error;
} vm_memory_page;
/* One branch per non-first resident page. References name stable row ranks,
 * so appending a page moves neither a descriptor nor guest RAM. */
typedef struct { pl_u64 bit; pl_u32 child[2]; } vm_memory_branch;
/* Optional serialized invalidation hook, invoked before each physical RAM
 * fragment is changed, including paging A/D and reservation commit. Offsets
 * are relative to bytes, not guest virtual addresses. The hook cannot reenter
 * or mutate RAM/context/directory. External host writes must revoke separately.
 * A cancelled reservation never invokes it; an equal-value store still does. */
typedef void (*vm_memory_write_observer)(void *owner, pl_u32 offset, pl_u32 bytes);
typedef struct {
    pl_u8 *bytes;
    pl_u64 byte_count;
    vm_memory_page *pages;
    vm_memory_branch *branches;
    pl_u32 page_count;
    pl_u32 page_capacity, root;
    pl_u32 reserved_bytes;
    pl_u64 next_offset;
    pl_u64 generation;
    pl_u32 write_touched; /* Caller-cleared mutation bit, not a counter/epoch. */
    vm_memory_write_observer before_write;
    void *write_owner;
    vm_memory_reservation reservation;
    const vm_memory_page *recent[256];
} vm_memory;

/* Validate the initial borrowed sorted rows once; all later rows append into
 * the same bit index. Capacity bounds resident pages, not logical guest RAM.
 * branches has capacity - 1 entries (NULL for capacity <= 1). RAM mappings cannot
 * overlap the reserved supervisor/state/port arena. Physical aliases between
 * guest pages are allowed. Keep directory, generation, arena and residency
 * immutable until the synchronous transaction returns. Fault rows are valid
 * only for their rights mask and this generation's admitted CPU/MMU context;
 * a cached write fault is not a fault for a read. Missing entries are cache
 * misses, never proof that Linux considers a page absent. This single-owner API
 * is not a shared-worker lease or an atomic MMU permission oracle. */
int vm_memory_open(vm_memory *memory, pl_u8 *bytes, pl_u64 byte_count,
                   pl_u32 reserved_bytes, vm_memory_page *pages,
                   pl_u32 page_count, pl_u32 capacity,
                   vm_memory_branch *branches, pl_u64 generation);
/* Append only a never-resident page, using the next virgin payload slot.
 * No eviction/dirty recovery is implied. Failure changes no row or index. */
int vm_memory_append(vm_memory *memory, pl_u64 address, pl_u32 offset, pl_u32 rights);
/* ROM uses a virgin payload slot, so it cannot alias any writable RAM extent.
 * Reads/fetches use its bytes; writes/RMW commits succeed without changing
 * payload, dirty state or write observers. Page-table permissions still apply.
 * Initial vm_memory_open rows do not admit ROM: reconstruct it after open;
 * neither a RAM permission miss nor a deferred device is implicitly ROM. */
int vm_memory_append_rom(vm_memory *memory, pl_u64 address, pl_u32 offset);
machine_result vm_memory_access(vm_memory *memory, pl_u32 port_offset,
                                pl_u64 address, pl_u32 bytes,
                                pl_u32 access, pl_u64 value);
/* A synchronous single-owner reservation pins at most two physical fragments.
 * It is consumed even by a failed commit; reopen, any other access or abort
 * revokes it. No owner may mutate directory/context/residency while reserved.
 * This is not LOCK/SMP atomicity or an asynchronous worker lease. */
void vm_memory_abort(vm_memory *memory);
machine_result vm_memory_commit(vm_memory *memory, pl_u32 port_offset, pl_u64 value);
/* Private, disjoint record bytes (1..16), consumed under the same pinned
 * synchronous owner as scalar commit. Not a generated-code import. */
machine_result vm_memory_commit_record(vm_memory *memory, pl_u32 port_offset,
                                       const pl_u8 *value, pl_u32 bytes);
/* Synchronous sparse output into a preflighted bounded extent. No record
 * image or host pointer crosses the boundary. Each word advances an ordered
 * cursor; skipped bytes are untouched. Bad/stale calls consume the frontier,
 * but cannot undo stores already completed. Abort/rebind/close releases it;
 * a host trap must call abort/close before admitting another operation.
 * These are trusted compiled stores, not an asynchronous/SMP transaction. */
machine_result vm_memory_write_word(vm_memory *memory, pl_u32 port_offset,
                                    pl_u32 offset, pl_u32 bytes, pl_u64 value);
machine_result vm_memory_write_end(vm_memory *memory, pl_u32 port_offset);
#endif
