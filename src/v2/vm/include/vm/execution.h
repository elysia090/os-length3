/* Borrowed compiled-coordinate directory for one serialized execution lane. */
#ifndef VM_EXECUTION_H
#define VM_EXECUTION_H
#include <machine/entry.h>
#include <machine/state.h>
#include <machine/segments.h>

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
    machine_segments *segments; /* Optional only for register-only fixtures. */
    vm_execution_row continuation; /* One latched instruction, not a CPU frame. */
    pl_u64 continuation_generation;
} vm_execution;
typedef machine_result (*vm_execution_fetch)(void *owner, pl_u64 address);
typedef machine_result (*vm_execution_call)(void *owner, pl_u32 slot, pl_u64 entry);

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
/* A single-instruction RESOURCE/QUANTUM barrier pins its original table slot
 * and source identity. Resume does not refetch/redecode self-modified bytes.
 * Its completed element frontier is already in architectural state; no state
 * copy is stored here. Pin the slot/context and serialize CPU/host writers
 * across the wait. Ordinary code admission stays revoked after payload writes;
 * only this in-flight instruction may continue. Completion/fault releases the
 * latch. Host reopen/close or a changed CPU/MMU context cancels it. This does
 * not deliver interrupts or prove async source/module authenticity. */
/* The call receives the selected row's entry by value, including on resume.
 * A shared compiled topology cannot choose or replace this binding. */
/* With an active MOV SS shadow the next row must contain exactly one source
 * instruction. ENTRY_MAP requests that narrower compile admission; it never
 * retires a larger slice or decodes an instruction. A successful retirement
 * consumes the old shadow, including consecutive MOV SS. Pending faults and
 * host misses preserve it until actual exception delivery/continuation. */
machine_result vm_execution_run(vm_execution *execution, machine_state *state,
                                pl_u64 generation, pl_u32 maximum_cuts,
                                vm_execution_fetch fetch, vm_execution_call call,
                                void *owner);
#endif
