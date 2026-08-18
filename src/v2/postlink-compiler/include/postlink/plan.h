/* A decoded state step, and the substitution that joins two of them.
 *
 * A template plus its parameter row is a plan: nodes with operand arguments, a
 * stack, and a locals frame.  Composition is substitution rather than
 * concatenation -- the second plan's local and stack operands are replaced by
 * whatever the first plan publishes at that coordinate, and no intermediate
 * frame is materialized.  This mirrors compose_plans_raw in
 * qm/stepnormalize.py, and check/compose_parity.py holds the two to one answer.
 *
 * Normalization is a separate stage.  A raw composition is a correct graph but
 * not a canonical one, so it cannot be written into an artifact until
 * normalize_plan's counterpart exists.
 *
 * Freestanding: no libc, no allocation.  The caller supplies an arena.
 */

#ifndef POSTLINK_PLAN_H
#define POSTLINK_PLAN_H

#include <postlink/opcodes.h>
#include <postlink/template.h>

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
} pl_plan;

/* A bump allocator, so the library allocates nothing itself. */
typedef struct {
    pl_u8 *base;
    pl_u32 size;
    pl_u32 used;
} pl_arena;

void *pl_arena_take(pl_arena *arena, pl_u32 bytes);

#define PL_ERROR_PLAN  (-17)
#define PL_ERROR_ARENA (-18)

/* Decode one plan.  Unchanged local slots hold the identity operand for their
 * own slot, which is what makes substitution through them a no-op. */
int pl_plan_decode(const pl_u8 *tmpl, const pl_template *parsed,
                   const pl_u8 *row, pl_arena *arena, pl_plan *out);

/* Arena bytes pl_compose_raw can need for a given pair. */
pl_u32 pl_compose_arena_bytes(const pl_plan *first, const pl_plan *second);

/* Substitute `second` through `first`.  Refuses a pair that crosses a function
 * boundary, or whose second plan reads a stack slot the first never published,
 * which are the two refusals compose_plans_raw makes. */
int pl_compose_raw(const pl_plan *first, const pl_plan *second,
                   pl_arena *arena, pl_plan *out);

#endif /* POSTLINK_PLAN_H */
