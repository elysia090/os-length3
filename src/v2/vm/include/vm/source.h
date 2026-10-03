#ifndef VM_SOURCE_H
#define VM_SOURCE_H
#include <vm/execution.h>
#include <vm/mmu.h>

#define VM_SOURCE_ROWS 64u
#define VM_SOURCE_WATCH_BUCKETS 256u
typedef struct {
    vm_execution_row row;
    pl_u32 offset, limit;
} vm_source_row;
typedef struct {
    vm_source_row rows[VM_SOURCE_ROWS];
    pl_u64 watch[VM_SOURCE_WATCH_BUCKETS];
    pl_u64 lookup[VM_SOURCE_WATCH_BUCKETS];
    pl_u64 generation, valid;
    vm_code_page pending_page;
    pl_u64 pending_entry;
    pl_u32 pending_limit, pending_rank, pending;
    pl_u32 first_slot, next_rank;
} vm_sources;

/* One serialized compiler/engine owner. Page views must come from executable
 * C-MMU admission on EVERY lookup; permission checks are never cached. The
 * exact source extent is pinned without copying bytes. All physical guest
 * writes (including A/D and descriptor writes) call vm_sources_write BEFORE
 * mutating payload. External host mutation/remap/table changes require reset.
 * No concurrent writer, eviction/remap, compiler replacement or untrusted
 * host-supplied compilation attestation is admitted by this API. */
void vm_sources_open(vm_sources *sources, pl_u64 generation, pl_u32 first_slot);
/* 0: reusable row, 1: pinned miss requiring the same compiler, -1: refusal.
 * Miss reserves its table slot and invalidates its previous row. It is not
 * an ISA fallback. Output remains untouched on refusal. */
int vm_sources_probe(vm_sources *sources, const vm_code_page *page,
    pl_u64 entry, pl_u32 limit, vm_execution_row *row);
/* The trusted compiler reports its exact successfully emitted source span.
 * Source is one page here; crossing instructions need separate admission.
 * Publish only after installing that compiled function in the reserved slot.
 * A pending source mutation cancels publication even if bytes changed back. */
int vm_sources_publish(vm_sources *sources, pl_u32 bytes, pl_u32 instructions,
    vm_execution_row *row);
void vm_sources_write(void *sources, pl_u32 offset, pl_u32 bytes);
#endif
