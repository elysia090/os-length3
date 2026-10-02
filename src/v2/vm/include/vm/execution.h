/* Borrowed compiled-coordinate directory for one serialized execution lane. */
#ifndef VM_EXECUTION_H
#define VM_EXECUTION_H
#include <machine/entry.h>
#include <machine/state.h>

#define VM_EXECUTION_MAX_ROWS 4096u
#define VM_EXECUTION_MAX_QUANTUM 65536u
typedef struct {
    pl_u64 entry;
    pl_u32 source_bytes;
    pl_u32 source_instructions;
    pl_u32 slot;
    pl_u32 reserved;
} vm_execution_row;
_Static_assert(sizeof(vm_execution_row) == 24u, "compiled directory row");

typedef struct {
    const vm_execution_row *rows;
    pl_u32 count;
    pl_u32 completed;
    pl_u64 generation;
    pl_u64 retired;
    pl_u64 context[5];
} vm_execution;
typedef machine_result (*vm_execution_fetch)(void *owner, pl_u64 address);
typedef machine_result (*vm_execution_call)(void *owner, pl_u32 slot);

/* Rows are sorted by distinct canonical entry, nonzero slot, and cover at most
 * one executable page, or one <=15-byte instruction crossing two pages. The
 * cold compiler must attest the exact source span, uniform table type, CPU
 * profile and current source bytes after executable MMU admission (including
 * observable A/D updates). This API validates bounds/shape, NOT that
 * attestation, source identity or Wasm function type. Keep rows, table slots,
 * CPU/MMU context and physical residency pinned until run returns. All guest
 * RAM writes (including page-table A/D) and host remaps/code/table changes
 * must revoke admission. Code can alias page tables; do not assume otherwise.
 * No mutable directory or concurrent CPU/device/host writer is admitted.
 * Failed open revokes the previous admission. */
int vm_execution_open(vm_execution *execution, const vm_execution_row *rows,
                       pl_u32 count, pl_u64 generation, const machine_state *state);
void vm_execution_close(vm_execution *execution);
/* Each cut's executable page(s) are checked through the C MMU before calling
 * the already compiled function; no opcode/source decoding occurs here. A
 * same-page span needs one permission/residency check, a crossing instruction
 * checks the first byte of the second page too. Prefix cuts must end BEFORE
 * any crossing instruction, so a later fetch fault cannot suppress retirement.
 * An absent row yields ENTRY_MAP(entry RIP remains in state), never fallback.
 * Budget exhaustion yields RESOLVE_RIP/0 with completed/retired counters.
 * Revoke after a successful writing cut stops before the following cut.
 * Exceptions are pending, not delivered. This is not a complete machine. */
machine_result vm_execution_run(vm_execution *execution, machine_state *state,
                                pl_u64 generation, pl_u32 maximum_cuts,
                                vm_execution_fetch fetch, vm_execution_call call,
                                void *owner);
#endif
