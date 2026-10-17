/* Transient typed SSA for exact x86 state transfers. No serialized runtime. */
#ifndef X86_SSA_H
#define X86_SSA_H
#include <support/arena.h>
#include <x86/ssa-opcodes.h>

#define PL_OPERAND_CONST 0u
#define PL_OPERAND_STACK 1u
#define PL_OPERAND_LOCAL 2u
#define PL_OPERAND_NODE 3u
#define PL_OPERAND_PROJECTION 4u
#define PL_OPERAND_KINDS 5u
#define PL_OPERAND_STAYS(tag) ((tag) == PL_OPERAND_NODE || (tag) == PL_OPERAND_PROJECTION)

typedef struct {
    pl_u8 kind;      /* PL_OPERAND_* */
    pl_u64 value;
} pl_operand;

typedef struct {
    pl_u32 opcode;
    pl_u32 argument_at;     /* into the plan's argument run */
    pl_u32 argument_count;
} pl_node;

typedef struct {
    pl_u32 function, start, end, instructions, stack_inputs, span;
    pl_node *nodes;
    pl_u32 node_count;
    pl_operand *arguments;
    pl_u32 argument_count;
    pl_operand *stack;
    pl_u32 stack_count;
    pl_operand *locals;      /* indexed by frame slot, local_extent wide */
    pl_u32 local_count;
    /* span + 1 offsets into a run of node values ordered by dependency depth.
     * Emitters consume these waves without rebuilding the graph. */
    pl_u32 *wave_offsets;
    pl_u32 *wave_values;
} pl_plan;

#define PL_ERROR_PLAN  (-17)
#define PL_ERROR_ARENA (-18)


/* Composition substitutes frame coordinates; normalization removes dead
 * values, shares pure nodes and schedules the live dependency waves. */
pl_u32 pl_compose_arena_bytes(const pl_plan *first, const pl_plan *second);

/* Substitute outputs of first into the inputs of second. Refuse different
 * function identities, unavailable stack inputs and composition across a
 * trapping instruction's precise retirement cut. The arena owns the result. */
int pl_compose_raw(const pl_plan *first, const pl_plan *second,
                   pl_arena *arena, pl_plan *out);

int pl_compact_once(const pl_plan *in, pl_arena *arena, pl_plan *out);

/* live_local has local_count entries. Zero restores that output to identity;
 * memory/trap effects and stack observations remain mandatory roots. */
int pl_compact_projected_once(const pl_plan *in,
                              const pl_u8 *live_local,
                              pl_arena *arena, pl_plan *out);

/* Publication checks that a second dense compaction changes nothing. */
int pl_compact_projected(const pl_plan *in,
                         const pl_u8 *live_local,
                         pl_arena *arena, pl_plan *out);

int pl_rebase_overwritten_flags(const pl_plan *in, pl_arena *arena,
                                pl_plan *out);

/* Exact local substitution in dependency order, before backward liveness. */
int pl_fold_local_physical(const pl_plan *in, pl_arena *arena, pl_plan *out);

int pl_reopen_pre_store_chains(const pl_plan *in, pl_arena *arena,
                               pl_plan *out);

int pl_reopen_load_regions(const pl_plan *in, pl_arena *arena, pl_plan *out);

int pl_reopen_consumed_x86_alu(const pl_plan *in, pl_arena *arena,
                               pl_plan *out);

int pl_reopen_consumed_x86_alu_projected(
    const pl_plan *in, const pl_u8 *live_local,
    pl_arena *arena, pl_plan *out);

int pl_compact(const pl_plan *in, pl_arena *arena, pl_plan *out);
#endif /* X86_SSA_H */
