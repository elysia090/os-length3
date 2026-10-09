/* Borrowed compiled-coordinate directory for one serialized execution lane. */
#ifndef VM_EXECUTION_H
#define VM_EXECUTION_H
#include <machine/entry.h>
#include <machine/state.h>
#include <machine/segments.h>
#include <machine/activity.h>
#include <machine/memory.h>

#define VM_EXECUTION_MAX_ROWS 4096u
#define VM_EXECUTION_MAX_QUANTUM 65536u
typedef struct {
    pl_u64 entry;
    pl_u32 source_bytes;
    pl_u32 source_instructions;
    pl_u32 slot;
    pl_u32 operand_binding;
} vm_execution_row;
_Static_assert(sizeof(vm_execution_row) == 24u, "compiled directory row");
/* The last word is a latched scalar value, not another source descriptor. */
/* An optional serialized row owner admits the current RIP through executable
 * MMU/source identity before lending one immutable row. Zero + NULL is a
 * bounded cold miss, not permission to interpret/reconstruct an instruction.
 * It must report precise fetch faults and observe writes before mutation. */
typedef machine_result (*vm_execution_select)(void *owner, pl_u64 rip,
    const vm_execution_row **row);

typedef struct {
    const vm_execution_row *rows;
    pl_u32 count;
    pl_u32 completed;
    pl_u64 generation;
    pl_u64 retired;
    pl_u64 context[5];
    machine_segments *segments; /* Optional only for register-only fixtures. */
    machine_activity *activity; /* Machine-owned; directory close never resets it. */
    vm_execution_row continuation; /* One latched instruction, not a CPU frame. */
    pl_u64 continuation_generation;
    pl_u16 continuation_flags; /* Six sparse pre-instruction arithmetic bits. */
    pl_u8 continuation_interruptible; /* Only a completed quantum frontier. */
    pl_u8 in_call;
    pl_u32 source_bound; /* Last trusted row's maximum retirement, during call. */
    pl_u32 source_bytes;
    pl_u64 call_generation;
    pl_u64 frontier[2]; /* Opaque minimal compiled-transfer residual. */
    vm_execution_select select;
} vm_execution;
typedef machine_result (*vm_execution_fetch)(void *owner, pl_u64 address);
typedef machine_result (*vm_execution_call)(void *owner, pl_u32 slot, pl_u64 entry,
    pl_u32 operand_binding);

/* Rows are sorted by distinct canonical entry, nonzero slot, and cover at most
 * one executable page, or one <=15-byte instruction crossing two pages. The
 * cold compiler must attest the exact source span, uniform table type, CPU
 * profile and current source bytes after executable MMU admission (including
 * observable A/D updates). This API validates bounds/shape, NOT that
 * attestation, source identity or Wasm function type. Keep rows, table slots,
 * CPU/MMU context and physical residency pinned until run returns. Explicit
 * directories revoke admission after every guest RAM write (including A/D).
 * An owned source may retain only a proved-disjoint physical effect, with
 * current MMU/physical re-admission at EVERY successor; code/page-table aliases
 * cannot be assumed disjoint. Host remaps/code/table changes revoke admission.
 * No mutable directory or concurrent CPU/device/host writer is admitted.
 * Failed open revokes the previous admission. */
/* A compiled function publishes its actual committed source prefix through
 * state.retired. A fault/yield after that prefix keeps its next precise RIP.
 * The counter delta must fit the attested row; partial RIP stays inside it.
 * A single suspended instruction retires nothing until final completion. */
int vm_execution_open(vm_execution *execution, const vm_execution_row *rows,
                       pl_u32 count, pl_u64 generation, const machine_state *state);
void vm_execution_close(vm_execution *execution);
/* A committed control event discards an incomplete instruction but preserves
 * completed-prefix accounting. This is not a guest decoder or a rollback. */
void vm_execution_cancel(vm_execution *execution);
machine_result vm_execution_checkpoint(vm_execution *execution,machine_memory_checkpoint_port *port,
    pl_u32 operation,pl_u64 cursor,pl_u64 frontier);
/* Each cut's executable page(s) are checked through the C MMU before calling
 * the already compiled function; no opcode/source decoding occurs here. A
 * same-page span needs one permission/residency check, a crossing instruction
 * checks the first byte of the second page too. Prefix cuts must end BEFORE
 * any crossing instruction, so a later fetch fault cannot suppress retirement.
 * An absent explicit-directory row yields ENTRY_MAP, never fallback. A
 * source-owned cold miss returns RESOLVE_RIP with the exact completed prefix;
 * the trusted compiler may admit it later. No row/page directory is copied.
 * Budget exhaustion yields RESOLVE_RIP/0 with completed/retired counters.
 * Revocation after a successful writing cut stops before the following cut.
 * A proved-disjoint owned effect may continue only through fresh selection.
 * Exceptions are pending, not delivered. This is not a complete machine. */
/* A single-instruction RESOURCE/QUANTUM barrier pins its original table slot
 * and source identity. Resume does not refetch/redecode self-modified bytes.
 * Its completed element frontier is already in architectural state; only the
 * six original arithmetic bits survive for precise fault rollback. A quantum
 * frontier can be cancelled by an accepted interrupt; resource/I/O waits
 * remain pinned. Pin the slot/context and serialize CPU/host writers
 * across the wait. Ordinary code admission stays revoked after payload writes;
 * only this in-flight instruction may continue. Completion/fault releases the
 * latch. Host reopen/close or a changed CPU/MMU context cancels it. This does
 * not deliver interrupts or prove async source/module authenticity. */
/* The call receives the selected row's entry and operand binding by value, including on resume.
 * A shared compiled topology cannot choose or replace this binding. */
/* With an active MOV SS shadow the next row must contain exactly one source
 * instruction. ENTRY_MAP requests that narrower compile admission; it never
 * retires a larger slice or decodes an instruction. A successful retirement
 * consumes the old shadow, including consecutive MOV SS. Pending faults and
 * host misses preserve it until actual exception delivery/continuation. */
/* HALT/0 retires exactly one instruction and preserves its fallthrough RIP.
 * The separate activity owner blocks subsequent fetch/select/call until an
 * accepted machine event wakes it. A directory rebind is not such an event. */
machine_result vm_execution_run(vm_execution *execution, machine_state *state,
                                pl_u64 generation, pl_u32 maximum_cuts,
                                vm_execution_fetch fetch, vm_execution_call call,
                                void *owner);
#endif
