/* Reopening a consumed ALU result.
 *
 * _reopen_consumed_x86_alu in qm/stepnormalize.py.  X86_ALU and X86_AFFINE_ALU
 * are the one-lane spelling of arithmetic plus flags.  Once separately
 * normalized blocks are composed, an ALU's value result can become an internal
 * input to a larger memory transaction, and while it stays folded the
 * surrounding graph cannot see it.  Reopening restores the ordinary SSA
 * spelling -- the arithmetic as its own node, the flags as their own -- and the
 * main sweep folds back whatever is still genuinely adjacent.
 *
 * This is the one rule that needs a fact about the future: whether some later
 * node consumes the selector-16 projection, and whether anything still reads
 * the flags.  Hence a backward scan before the forward sweep.
 *
 * Freestanding: no libc, no allocation.
 */

#include "internal/sweep.h"

#define PL_PROJECTION_SELECTOR_BITS 8u
#define PL_PROJECTION_SELECTOR_MASK ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u)
#define PL_SELECTOR_VALUE 16u

/* The descriptor argument of an ALU, or -1 when the node is not one. */
static int alu_descriptor_at(pl_u32 opcode)
{
    if (opcode == PL_OPCODE_X86_ALU) return 3;
    if (opcode == PL_OPCODE_X86_AFFINE_ALU) return 4;
    return -1;
}

static int alu_descriptor(const pl_plan *plan, const pl_node *node,
                          pl_u64 *descriptor)
{
    int at = alu_descriptor_at(node->opcode);
    if (at < 0 || node->argument_count != (pl_u32)at + 1u) return 0;
    const pl_operand *word = &plan->arguments[node->argument_at + (pl_u32)at];
    if (word->kind != PL_OPERAND_CONST) return 0;
    *descriptor = word->value;
    return 1;
}

/* laneops.select over the arithmetic names.  The immediate form takes a
 * constant on the right; a constant on the left is swapped into it, except for
 * subtraction, which is not commutative and takes the register form. */
static pl_u32 select_arithmetic(pl_u32 width, unsigned semantic,
                                pl_operand *left, pl_operand *right)
{
    /* Narrow architectural lanes observe only their low bits.  The physical
     * grammar therefore carries 8/16-bit arithmetic in the shared 32-bit
     * lane; X86_FLAGS and the eventual insert/store apply the exact width. */
    pl_u32 lane = width <= 32u ? 0u : 1u;
    if (right->kind == PL_OPERAND_CONST)
        return PL_OPCODE_ALU_IMMEDIATE[lane][semantic];
    if (semantic != 2u && left->kind == PL_OPERAND_CONST) {
        pl_operand swap = *left;
        *left = *right;
        *right = swap;
        return PL_OPCODE_ALU_IMMEDIATE[lane][semantic];
    }
    return PL_OPCODE_ALU_REGISTER[lane][semantic];
}

/* mode -> index into the arithmetic tables: and add sub or xor. */
static int semantic_of(pl_u64 mode, unsigned *semantic)
{
    switch (mode) {
    case 0: *semantic = 0; return 1;   /* and */
    case 1: *semantic = 1; return 1;   /* add */
    case 3: *semantic = 2; return 1;   /* sub */
    case 5: *semantic = 3; return 1;   /* or  */
    case 6: *semantic = 4; return 1;   /* xor */
    default: return 0;
    }
}

static int reopen_consumed_x86_alu(const pl_plan *in,
                                   const pl_u8 *live_local,
                                   pl_arena *arena, pl_plan *out)
{
    pl_u32 count = in->node_count;
    pl_u8 *consumed = pl_arena_take(arena, count ? count : 1u);
    pl_u8 *live_flags = pl_arena_take(arena, count ? count : 1u);
    pl_u8 *output_value = pl_arena_take(arena, count ? count : 1u);
    if (!consumed || !live_flags || !output_value) return PL_ERROR_ARENA;
    for (pl_u32 index = 0; index < count; ++index)
        consumed[index] = live_flags[index] = output_value[index] = 0;

    /* The backward scan.  An output naming the node keeps its flags alive; a
     * selector-16 projection consumes its value, any other selector keeps the
     * flags. */
    for (pl_u32 index = 0; index < in->stack_count + in->local_count; ++index) {
        if (index >= in->stack_count && live_local
                && !live_local[index - in->stack_count])
            continue;
        pl_operand operand = index < in->stack_count
                           ? in->stack[index]
                           : in->locals[index - in->stack_count];
        if (operand.kind == PL_OPERAND_NODE) {
            if (operand.value && operand.value <= count)
                live_flags[operand.value - 1u] = 1;
        } else if (operand.kind == PL_OPERAND_PROJECTION) {
            pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
            pl_u64 selector = operand.value & PL_PROJECTION_SELECTOR_MASK;
            if (source && source <= count) {
                if (selector == PL_SELECTOR_VALUE)
                    output_value[source - 1u] = 1;
                else
                    live_flags[source - 1u] = 1;
            }
        }
    }
    for (pl_u32 index = 0; index < count; ++index) {
        const pl_node *node = &in->nodes[index];
        pl_u64 descriptor = 0;
        int is_alu = alu_descriptor(in, node, &descriptor);
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot) {
            pl_operand operand = in->arguments[node->argument_at + slot];
            if (operand.kind == PL_OPERAND_NODE) {
                /* A non-carry ALU preserves only the flag bits every preceding
                 * ALU preserves, so its prior-flags edge is peeled to the
                 * common root instead of pinning an intermediate producer. */
                pl_u64 group = (descriptor >> 8u) & 7u;
                int peeled = slot == 0u && is_alu
                           && (group == 1u || group == 3u)
                           && !(descriptor & (1ull << 11u));
                if (!peeled && operand.value && operand.value <= count)
                    live_flags[operand.value - 1u] = 1;
                continue;
            }
            if (operand.kind != PL_OPERAND_PROJECTION) continue;
            pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
            pl_u64 selector = operand.value & PL_PROJECTION_SELECTOR_MASK;
            if (!source || source > count) continue;
            if (selector == PL_SELECTOR_VALUE) consumed[source - 1u] = 1;
            else live_flags[source - 1u] = 1;
        }
    }

    /* A final value projection does not need reopening while the same folded
     * ALU flag word is live. Once complete-future projection removes those
     * flags, the value becomes an ordinary SSA consumer and can compose with
     * adjacent affine nodes. Internal consumers always requested reopening
     * directly in the node-argument scan above. */
    for (pl_u32 index = 0u; index < count; ++index)
        if (output_value[index] && !live_flags[index]) consumed[index] = 1u;

    int any = 0;
    for (pl_u32 index = 0; index < count; ++index)
        if (consumed[index]) { any = 1; break; }
    if (!any) {
        *out = *in;
        return 0;
    }

    /* Each reopened ALU becomes at most five nodes: an affine left, a carry
     * condition, a difference, the result, and the flags. */
    pl_u32 node_cap = count * 5u + 1u;
    pl_u32 argument_cap = in->argument_count * 5u + node_cap * 5u;
    pl_remap remap;
    pl_builder builder;
    pl_operand *results = pl_arena_take(
        arena, (count + 1u) * (pl_u32)sizeof *results);
    pl_operand *flag_roots = pl_arena_take(
        arena, (count + 1u) * (pl_u32)sizeof *flag_roots);
    pl_u8 *has_result = pl_arena_take(arena, count + 1u);
    pl_u8 *has_root = pl_arena_take(arena, count + 1u);
    if (!results || !flag_roots || !has_result || !has_root)
        return PL_ERROR_ARENA;
    for (pl_u32 index = 0; index <= count; ++index)
        has_result[index] = has_root[index] = 0;
    if (pl_remap_open(&remap, count, arena)
            || pl_builder_open(&builder, out, arena, node_cap, argument_cap,
                               in->stack_count, in->local_count))
        return PL_ERROR_ARENA;

    pl_operand staged[PL_STAGED_ARGUMENTS];
    for (pl_u32 index = 0; index < count; ++index) {
        const pl_node *node = &in->nodes[index];
        if (node->argument_count > PL_STAGED_ARGUMENTS) return PL_ERROR_PLAN;
        for (pl_u32 slot = 0; slot < node->argument_count; ++slot) {
            pl_operand operand = in->arguments[node->argument_at + slot];
            /* A reopened ALU publishes its value as an ordinary node, so a
             * selector-16 projection of it resolves to that node. */
            if (operand.kind == PL_OPERAND_PROJECTION) {
                pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
                pl_u64 selector = operand.value & PL_PROJECTION_SELECTOR_MASK;
                if (selector == PL_SELECTOR_VALUE && source && source <= count
                        && has_result[source]) {
                    staged[slot] = results[source];
                    continue;
                }
            }
            staged[slot] = pl_resolve(&remap, operand);
        }

        pl_u64 descriptor = 0;
        pl_u64 width = 0, mode = 0;
        unsigned semantic = 0;
        int reopen = consumed[index] && alu_descriptor(in, node, &descriptor);
        if (reopen) {
            width = descriptor & 0x7full;
            mode = (descriptor >> 8u) & 7u;
            reopen = (width == 8u || width == 16u || width == 32u
                      || width == 64u) && mode <= 6u;
        }
        if (!reopen) {
            pl_u32 value = pl_emit(&builder, node->opcode, staged,
                                   node->argument_count);
            if (!value) return PL_ERROR_ARENA;
            remap.of[index + 1u].kind = PL_OPERAND_NODE;
            remap.of[index + 1u].value = value;
            continue;
        }

        pl_operand prior = staged[0];
        pl_operand original = in->arguments[node->argument_at];
        /* ADD/SUB/logic replace the arithmetic flags, so only their
         * architecturally preserved bits need the root of the prior chain.
         * ADC/SBB are different: CF is an arithmetic input.  Peeling their
         * first edge to the root changes the value (NEG; SBB was the first
         * real-kernel witness), not merely the representation of RFLAGS. */
        if (mode != 2u && mode != 4u
                && !(descriptor & (1ull << 11u))
                && original.kind == PL_OPERAND_NODE
                && original.value <= count && has_root[original.value])
            prior = flag_roots[original.value];

        pl_operand inputs[2];
        pl_operand descriptor_operand;
        if (node->opcode == PL_OPCODE_X86_AFFINE_ALU) {
            pl_operand left = staged[1];
            pl_operand right = staged[2];
            pl_u32 opcode = select_arithmetic((pl_u32)width, 1u, &left,
                                              &right);
            pl_operand pair[2] = { left, right };
            pl_u32 value = pl_emit(&builder, opcode, pair, 2u);
            if (!value) return PL_ERROR_ARENA;
            inputs[0].kind = PL_OPERAND_NODE;
            inputs[0].value = value;
            inputs[1] = staged[3];
            descriptor_operand = staged[4];
        } else {
            inputs[0] = staged[1];
            inputs[1] = staged[2];
            descriptor_operand = staged[3];
        }

        pl_operand result;
        if (mode == 2u || mode == 4u) {
            pl_operand carry_arguments[2];
            carry_arguments[0] = prior;
            carry_arguments[1].kind = PL_OPERAND_CONST;
            carry_arguments[1].value = 2;
            pl_u32 carry = pl_emit(&builder, PL_OPCODE_X86_CONDITION,
                                   carry_arguments, 2u);
            if (!carry) return PL_ERROR_ARENA;
            pl_operand carry_operand;
            carry_operand.kind = PL_OPERAND_NODE;
            carry_operand.value = carry;

            if (mode == 2u) {
                pl_operand three[3] = { inputs[0], inputs[1], carry_operand };
                pl_u32 value = pl_emit(
                    &builder, PL_OPCODE_ADD3[width <= 32u ? 0u : 1u],
                    three, 3u);
                if (!value) return PL_ERROR_ARENA;
                result.kind = PL_OPERAND_NODE;
                result.value = value;
            } else {
                pl_operand left = inputs[0];
                pl_operand right = inputs[1];
                pl_u32 opcode = select_arithmetic((pl_u32)width, 2u, &left,
                                                  &right);
                pl_operand pair[2] = { left, right };
                pl_u32 difference = pl_emit(&builder, opcode, pair, 2u);
                if (!difference) return PL_ERROR_ARENA;
                pl_operand held;
                held.kind = PL_OPERAND_NODE;
                held.value = difference;
                pl_operand borrow_left = held;
                pl_operand borrow_right = carry_operand;
                opcode = select_arithmetic((pl_u32)width, 2u, &borrow_left,
                                           &borrow_right);
                pl_operand borrow[2] = { borrow_left, borrow_right };
                pl_u32 value = pl_emit(&builder, opcode, borrow, 2u);
                if (!value) return PL_ERROR_ARENA;
                result.kind = PL_OPERAND_NODE;
                result.value = value;
            }
        } else {
            if (!semantic_of(mode, &semantic)) return PL_ERROR_PLAN;
            pl_operand left = inputs[0];
            pl_operand right = inputs[1];
            pl_u32 opcode = select_arithmetic((pl_u32)width, semantic, &left,
                                              &right);
            pl_operand pair[2] = { left, right };
            pl_u32 value = pl_emit(&builder, opcode, pair, 2u);
            if (!value) return PL_ERROR_ARENA;
            result.kind = PL_OPERAND_NODE;
            result.value = value;
        }

        if (live_flags[index]) {
            pl_operand flag_arguments[5];
            flag_arguments[0] = prior;
            flag_arguments[1] = inputs[0];
            flag_arguments[2] = inputs[1];
            flag_arguments[3] = result;
            flag_arguments[4] = descriptor_operand;
            pl_u32 flags = pl_emit(&builder, PL_OPCODE_X86_FLAGS,
                                   flag_arguments, 5u);
            if (!flags) return PL_ERROR_ARENA;
            remap.of[index + 1u].kind = PL_OPERAND_NODE;
            remap.of[index + 1u].value = flags;
        } else {
            remap.of[index + 1u] = prior;
        }
        results[index + 1u] = result;
        has_result[index + 1u] = 1;
        flag_roots[index + 1u] = prior;
        has_root[index + 1u] = 1;
    }

    for (pl_u32 index = 0; index < in->stack_count + in->local_count; ++index) {
        pl_operand operand = index < in->stack_count
                           ? in->stack[index]
                           : in->locals[index - in->stack_count];
        pl_operand mapped;
        if (operand.kind == PL_OPERAND_PROJECTION) {
            pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
            pl_u64 selector = operand.value & PL_PROJECTION_SELECTOR_MASK;
            if (selector == PL_SELECTOR_VALUE && source && source <= count
                    && has_result[source])
                mapped = results[source];
            else
                mapped = pl_resolve(&remap, operand);
        } else {
            mapped = pl_resolve(&remap, operand);
        }
        if (index < in->stack_count) out->stack[index] = mapped;
        else out->locals[index - in->stack_count] = mapped;
    }

    out->function = in->function;
    out->start = in->start;
    out->end = in->end;
    out->instructions = in->instructions;
    out->stack_inputs = in->stack_inputs;
    out->span = in->span;
    return 0;
}

int pl_reopen_consumed_x86_alu(const pl_plan *in, pl_arena *arena,
                               pl_plan *out)
{
    return reopen_consumed_x86_alu(in, 0, arena, out);
}

int pl_reopen_consumed_x86_alu_projected(
    const pl_plan *in, const pl_u8 *live_local,
    pl_arena *arena, pl_plan *out)
{
    if (!in || !live_local || !arena || !out) return PL_ERROR_PLAN;
    pl_plan projected = *in;
    projected.locals = pl_arena_take(
        arena, (in->local_count ? in->local_count : 1u)
               * (pl_u32)sizeof *projected.locals);
    if (!projected.locals) return PL_ERROR_ARENA;
    for (pl_u32 local = 0u; local < in->local_count; ++local) {
        if (live_local[local]) projected.locals[local] = in->locals[local];
        else {
            projected.locals[local].kind = PL_OPERAND_LOCAL;
            projected.locals[local].value = local;
        }
    }
    return reopen_consumed_x86_alu(
        &projected, live_local, arena, out);
}
