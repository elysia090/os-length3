/* Ordinary Wasm block modules emitted directly from normalized physical SSA.
 *
 * The emitted function ABI is `(i32 machine, i32 context) -> i64`.  Locals
 * 0..15 in an x86 plan name the shared register array and local 16 names
 * RFLAGS.  They are loaded and published directly in pl_vm_x86_state; no STEP
 * page, scalar opcode loop, private frame or host callback exists in the
 * output module.
 *
 * Version one admits integer SSA, scalar memory and contiguous load regions.
 * Memory calls vm.wasm's MMU/page-cache exports directly as Wasm imports and
 * returns a delivery barrier before local publication when a page is cold.
 * A region stays one physical operation and exposes its at-most-eight values
 * through fixed projection slots; it is never reopened as scalar loads at
 * runtime.  Counted repeats retain their byte cursor across delivery barriers
 * rather than replaying scalar stores.  Other region operations and terminal-
 * control primitives remain compile errors until their direct lowering exists;
 * none acquires a runtime fallback.
 */

#ifndef POSTLINK_WASM_H
#define POSTLINK_WASM_H

#include <postlink/entrymap.h>
#include <postlink/executable.h>
#include <postlink/plan.h>
#include <postlink/x86.h>

typedef struct {
    const pl_plan *plan;
    pl_u64 next_rip;
    /* DIRECT, RESOLVE_RIP, BARRIER, FAULT and HALT share one publication ABI.
     * Dynamic RIP is selected below; none of the result kinds invokes a
     * decoder or scalar interpreter. */
    pl_u32 result_kind;       /* enum pl_vm_result_kind */
    pl_u64 result_payload;    /* artifact-local function rank for DIRECT */
    /* A conditional block chooses the primary fields when predicate != 0 and
     * these alternate fields otherwise.  A dynamic block publishes
     * next_rip_operand and returns RESOLVE_RIP.  Both forms remain ordinary
     * direct Wasm; neither invokes a decoder or scalar interpreter. */
    pl_operand next_rip_operand;
    pl_operand branch_predicate;
    pl_u64 alternate_rip;
    pl_u32 alternate_result_kind;
    pl_u64 alternate_result_payload;
    pl_u32 next_rip_relative;
    pl_u32 alternate_rip_relative;
    pl_u32 has_dynamic_rip;
    pl_u32 has_branch_predicate;
    /* Optional precise architectural fault.  The predicate is tested only
     * after earlier memory effects reach their canonical cut and before any
     * local, RIP or counter publication. */
    pl_operand fault_predicate;
    pl_operand machine_value;
    pl_u32 has_fault_predicate;
    pl_u32 fault_vector;
    /* A closed counted recurrence executes the physical plan once but retires
     * the original loop body `iterations * source_instructions` times.  The
     * iterations operand is one scratch publication in plan->locals.  All
     * three fields are zero for an ordinary block. */
    pl_u32 recurrence_local;
    pl_u32 recurrence_bits;
    pl_u64 recurrence_source_instructions;
    /* A typed CPU/MMU transfer performed once at this precise block cut. */
    pl_u32 machine_operation;
    pl_u64 machine_argument;
} pl_wasm_block;

typedef struct {
    const pl_wasm_block *blocks;
    pl_u32 block_count;
    const struct pl_wasm_page_dispatch *dispatchers;
    pl_u32 dispatcher_count;
} pl_wasm_module_spec;

/* A page-specific total dispatcher.  Its hot path checks the generation and
 * performs the physical entry-map's two dependent loads.  Keeping page_rank
 * as an emitted constant avoids a mutable host argument; equal dispatchers
 * may be quotient-shared by the compiler before this boundary. */
typedef struct pl_wasm_page_dispatch {
    pl_u64 virtual_page;
    pl_u32 generation;
    pl_u32 page_rank;
} pl_wasm_page_dispatch;

#define PL_ERROR_WASM             (-28)
#define PL_ERROR_WASM_RANGE       (-29)
#define PL_ERROR_WASM_UNSUPPORTED (-30)
#define PL_ERROR_WASM_ABI         (-31)

/* The output imports shared memory/table, an immutable table base, eight
 * direct-memory functions and two direct divide functions.  An element
 * segment installs all block functions;
 * there is no export-directory walk.  Measure and write use one encoder. */
int pl_wasm_module_measure(const pl_wasm_module_spec *spec, pl_u32 *bytes);
int pl_wasm_module_write(const pl_wasm_module_spec *spec, pl_u8 *target,
                         pl_u32 capacity, pl_u32 *written);

/* Measure one complete function body without repeating module imports and
 * section framing.  Artifact partitioners use this exact encoder to choose
 * bounded module extents. */
int pl_wasm_block_measure(const pl_wasm_block *block, pl_u32 block_index,
                          pl_u32 *bytes);
int pl_wasm_block_write(const pl_wasm_block *block, pl_u32 block_index,
                          pl_u8 *target, pl_u32 capacity, pl_u32 *written);

/* Lift only constants which the emitter consumes as runtime i64 operands.
 * Constants inspected by the grammar (width, shape, selector, etc.) remain
 * embedded and therefore remain part of the function identity.  The emitted
 * body loads its parameter row through the VM-owned executable context. */
int pl_wasm_block_parameterized_measure(
    const pl_wasm_block *block, pl_u32 block_index,
    pl_u32 *bytes, pl_u32 *parameter_count);
int pl_wasm_block_parameterized_write(
    const pl_wasm_block *block, pl_u32 block_index,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written,
    pl_u64 *parameters, pl_u32 parameter_capacity,
    pl_u32 *parameter_count);

int pl_wasm_page_dispatch_measure(const pl_wasm_page_dispatch *dispatch,
                                  pl_u32 *bytes);
int pl_wasm_page_dispatch_write(const pl_wasm_page_dispatch *dispatch,
                                pl_u8 *target, pl_u32 capacity,
                                pl_u32 *written);

/* Bounded compilers may lower and encode one function at a time, then wrap a
 * small batch without retaining every SSA graph.  Each entry is a complete
 * Wasm function body (local declaration vector through final `end`) produced
 * by the two encoders above. */
typedef struct {
    const pl_u8 *bytes;
    pl_u32 length;
} pl_wasm_function_body;

int pl_wasm_body_module_measure(const pl_wasm_function_body *bodies,
                                pl_u32 body_count, pl_u32 *bytes);
int pl_wasm_body_module_write(const pl_wasm_function_body *bodies,
                              pl_u32 body_count, pl_u8 *target,
                              pl_u32 capacity, pl_u32 *written);

/* Measure one node with the same lowering used by the module writer.  This is
 * the compiler's bounded grammar diagnostic: callers can inventory every
 * linked-image node without emitting a module or executing a fallback. */
int pl_wasm_node_measure(const pl_plan *plan, pl_u32 value, pl_u32 *bytes);

#endif /* POSTLINK_WASM_H */
