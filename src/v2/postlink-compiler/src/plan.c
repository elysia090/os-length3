/* Plan decoding and raw composition.  See include/postlink/plan.h. */

#include <postlink/plan.h>

void *pl_arena_take(pl_arena *arena, pl_u32 bytes)
{
    pl_u32 at = (arena->used + 7u) & ~7u;      /* eight-byte alignment */
    if (at > arena->size || bytes > arena->size - at) return 0;
    arena->used = at + bytes;
    return arena->base + at;
}

/* Values interleave: a tag group's stayed words sit in the template while its
 * consts and coordinates sit in the parameter row, and both advance in tag
 * order.  One cursor over both keeps the two in step. */
typedef struct {
    const pl_u8 *tmpl;
    const pl_u8 *row;
    pl_u32 word_at;      /* into the template's stayed words */
    pl_u32 row_at;       /* into the parameter row */
} value_cursor;

static pl_operand next_value(value_cursor *cursor, const pl_tag_group *group,
                             pl_u32 index)
{
    pl_operand operand;
    pl_u32 tag = cursor->tmpl[group->tags + index];
    operand.kind = (pl_u8)tag;
    if (tag == PL_OPERAND_CONST) {
        operand.value = pl_read_u64(cursor->row + cursor->row_at);
        cursor->row_at += 8u;
    } else if (tag == PL_OPERAND_STACK || tag == PL_OPERAND_LOCAL) {
        operand.value = pl_read_u16(cursor->row + cursor->row_at);
        cursor->row_at += 2u;
    } else {
        operand.value = pl_read_u64(cursor->tmpl + group->words
                                    + (pl_u64)cursor->word_at * 8u);
        cursor->word_at += 1u;
    }
    return operand;
}

int pl_plan_decode(const pl_u8 *tmpl, const pl_template *parsed,
                   const pl_u8 *row, pl_arena *arena, pl_plan *out)
{
    out->function = parsed->function;
    out->start = parsed->start;
    out->end = parsed->end;
    out->instructions = parsed->instructions;
    out->stack_inputs = parsed->stack_inputs;
    out->span = parsed->span;
    out->node_count = parsed->work;
    out->argument_count = parsed->operands;
    out->stack_count = parsed->stack_count;
    out->local_count = parsed->local_extent;

    out->nodes = pl_arena_take(arena,
                               parsed->work * (pl_u32)sizeof *out->nodes);
    out->arguments = pl_arena_take(
        arena, parsed->operands * (pl_u32)sizeof *out->arguments);
    out->stack = pl_arena_take(
        arena, parsed->stack_count * (pl_u32)sizeof *out->stack);
    out->locals = pl_arena_take(
        arena, parsed->local_extent * (pl_u32)sizeof *out->locals);
    if ((parsed->work && !out->nodes) || (parsed->operands && !out->arguments)
            || (parsed->stack_count && !out->stack)
            || (parsed->local_extent && !out->locals))
        return PL_ERROR_ARENA;

    /* The parameter row is one run across all three groups, so row_at carries
     * over; the stayed words are a separate run per group, so word_at resets
     * with each group. */
    value_cursor cursor = { tmpl, row, 0, 0 };
    for (pl_u32 index = 0; index < parsed->operands; ++index)
        out->arguments[index] = next_value(&cursor, &parsed->operand, index);
    cursor.word_at = 0;

    const pl_u8 *offsets = tmpl + parsed->argument_offsets;
    for (pl_u32 value = 0; value < parsed->work; ++value) {
        pl_u32 begin = pl_read_u32(offsets + (pl_u64)value * 4u);
        pl_u32 end = pl_read_u32(offsets + (pl_u64)(value + 1u) * 4u);
        if (begin > end || end > parsed->operands) return PL_ERROR_PLAN;
        out->nodes[value].opcode = tmpl[parsed->opcodes + value];
        out->nodes[value].argument_at = begin;
        out->nodes[value].argument_count = end - begin;
    }

    for (pl_u32 index = 0; index < parsed->stack_count; ++index)
        out->stack[index] = next_value(&cursor, &parsed->stack, index);
    cursor.word_at = 0;

    /* An unchanged slot publishes itself, so substituting through it is the
     * identity.  Only the changed slots are stored, named by local_indices. */
    for (pl_u32 slot = 0; slot < parsed->local_extent; ++slot) {
        out->locals[slot].kind = PL_OPERAND_LOCAL;
        out->locals[slot].value = slot;
    }
    /* The changed local values and the local_indices tail are two separate
     * runs of the row, so find where the tail begins by walking the values
     * first, then pair the two. */
    value_cursor values = cursor;
    for (pl_u32 index = 0; index < parsed->local_updates; ++index)
        (void)next_value(&values, &parsed->local, index);
    pl_u32 indices_at = values.row_at;

    values = cursor;
    for (pl_u32 index = 0; index < parsed->local_updates; ++index) {
        pl_operand operand = next_value(&values, &parsed->local, index);
        pl_u32 slot = pl_read_u16(row + indices_at + (pl_u64)index * 2u);
        if (slot >= parsed->local_extent) return PL_ERROR_PLAN;
        out->locals[slot] = operand;
    }
    return 0;
}
