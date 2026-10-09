#ifndef VM_SOURCE_H
#define VM_SOURCE_H
#include <vm/execution.h>
#include <vm/mmu.h>

#define VM_SOURCE_ROWS 64u
#define VM_SOURCE_WATCH_BUCKETS 256u
typedef struct {
    vm_execution_row row;
    pl_u32 offset, limit, next_offset;
} vm_source_row;
typedef struct {
    vm_source_row rows[VM_SOURCE_ROWS];
    pl_u64 watch[VM_SOURCE_WATCH_BUCKETS];
    pl_u64 lookup[VM_SOURCE_WATCH_BUCKETS];
    pl_u64 generation, valid;
    vm_code_page pending_page;
    vm_code_page pending_next;
    pl_u64 pending_entry;
    pl_u32 pending_limit, pending_rank, pending, pending_pages;
    pl_u32 first_slot, demand_limit;
    pl_u8 previous[VM_SOURCE_ROWS], next[VM_SOURCE_ROWS];
    pl_u8 oldest, newest;
} vm_sources;

/* Pure admissibility predicate, shared with read-only profile classification.
 * It neither authorizes a mapping nor refreshes/cancels a source owner. */
static inline int vm_source_budget_fits(const vm_source_row *row, pl_u32 limit)
{
    return row->row.source_instructions <= limit
        && (row->limit == limit || row->row.source_instructions < row->limit);
}

/* One serialized compiler/engine owner. Page views must come from executable
 * C-MMU admission on EVERY lookup; permission checks are never cached. The
 * exact source extent is pinned without copying bytes. All physical guest
 * writes (including A/D and descriptor writes) call vm_sources_write BEFORE
 * mutating payload. External host mutation/remap/table changes require reset.
 * No concurrent writer, eviction/remap, compiler replacement or untrusted
 * host-supplied compilation attestation is admitted by this API. */
/* The fixed rank list contains only valid rows. A successful admitted demand
 * moves one row to its tail; replacement uses a free rank or the oldest row.
 * Refresh, unlink and victim selection are bounded O(1), without epochs,
 * copied source payload, growing history, a sort or a quota increase. */
/* An admitted demand budget is not executable identity. A nonsaturated owned
 * row (instructions < its admitted limit) may reuse its exact fixed transfer
 * under another limit that admits its actual instruction count. We retain an
 * exact budget match for saturated rows conservatively: a larger request may
 * seek a longer pure prefix. This is not proof the compiler formed a maximal
 * slice; its reported fixed extent remains the executable authority.
 * demand_limit belongs to the newest validated demand, not a cached body;
 * invalidating that newest row clears the demand certificate. */
void vm_sources_open(vm_sources *sources, pl_u64 generation, pl_u32 first_slot);
/* 0: reusable row, 1: pinned miss, 2: cached crossing requiring tail admission,
 * -1: refusal. Only a demand from the same trusted compiler extends a miss.
 * Miss reserves its table slot and invalidates its previous row. It is not
 * an ISA fallback. Output remains untouched on refusal. */
int vm_sources_probe(vm_sources *sources, const vm_code_page *page,
    pl_u64 entry, pl_u32 limit, vm_execution_row *row);
/* Hit-only warm admission: 0 lends an owned row after complete physical
 * validation and refreshes its demand, 1 is an unchanged cold miss, 2 lends
 * only a crossing candidate whose tail still requires C-MMU admission.
 * Recheck with next after that admission; a remapped tail returns 1, not
 * authority to execute. -1 refuses. Miss/refusal never evicts, reserves,
 * cancels a pending compile, copies a row or changes output. The borrower
 * serializes writes and cannot retain a pointer beyond the current cut. */
int vm_sources_reuse(vm_sources *sources, const vm_code_page *page,
    const vm_code_page *next, pl_u64 entry, pl_u32 limit,
    const vm_execution_row **row);
/* The trusted compiler reports its exact successfully emitted source span
 * and scalar operand binding, including zero. Neither is decoded here.
 * A crossing FIRST instruction has at most 15 bytes and two physical owners.
 * Publish only after installing that compiled function in the reserved slot.
 * A pending source mutation cancels publication even if bytes changed back. */
int vm_sources_publish(vm_sources *sources, pl_u32 bytes, pl_u32 instructions,
    pl_u32 operand_binding, vm_execution_row *row);
/* A trusted decoder FETCH or C-validated source-module TAIL descriptor may
 * demand the tail. Neither permits the host to guess an instruction extent.
 * Extend a pinned miss or validate the cached tail from executable C-MMU
 * admission. 0: complete hit, 1: pinned two-page miss, -1: refusal. */
int vm_sources_extend(vm_sources *sources, const vm_code_page *next,
    vm_execution_row *row);
void vm_sources_write(void *sources, pl_u32 offset, pl_u32 bytes);
/* Direct physical-slot revisions for construction reuse outside the hot
 * cohort. They confer no fetch, permission or execution authority. A source
 * must still be pinned by current C-MMU admission before reading its stamp.
 * Every physical write invalidates its slot, including A/D and equal stores.
 * Zero permanently retires an exhausted 32-bit revision until owner close;
 * it never wraps to an old cache key. The caller owns the bounded word arena. */
typedef struct {pl_u32 *words,count;pl_u64 generation;} vm_source_versions;
int vm_source_versions_open(vm_source_versions *versions,pl_u32 *words,pl_u32 count,pl_u64 generation);
void vm_source_versions_write(vm_source_versions *versions,pl_u32 offset,pl_u32 bytes);
int vm_sources_stamp(const vm_sources *sources,const vm_source_versions *versions,pl_u32 owners[2],pl_u32 revisions[2]);
#endif
