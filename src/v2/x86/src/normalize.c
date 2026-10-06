/* Algebraic SSA normalization before the dependency-ordered sweep.
 * Rebase overwritten flags before reopening their consumed ALU values: the
 * rebase exposes the result projections the next pass substitutes. This order
 * reaches the fixed point without retaining an extra intermediate graph.
 * Freestanding: no libc, no allocation. */

#include <x86/ssa-build.h>

#define PL_PROJECTION_SELECTOR_BITS 8u

/* Most arithmetic replaces CF/PF/ZF/SF/OF and copies the rest.  Threading the
 * whole flag word through every preceding instruction invents a serial chain
 * that is not there, so a full overwrite reads the preserved bits from the root
 * of the chain instead.  A condition observing an intermediate result keeps its
 * own producer, which is why only the first argument is rebased. */
static pl_operand flag_chain_root(const pl_plan *plan, pl_operand operand)
{
    /* The walk is bounded by the node count: each step moves strictly earlier
     * in a topologically ordered graph, so no seen-set is needed. */
    pl_u32 steps = 0;
    while (operand.kind == PL_OPERAND_NODE && steps <= plan->node_count) {
        pl_u32 value = (pl_u32)operand.value;
        if (!value || value > plan->node_count) break;
        const pl_node *source = &plan->nodes[value - 1u];
        if (!pl_opcode_produces_flags(source->opcode)
                || !source->argument_count)
            break;
        operand = plan->arguments[source->argument_at];
        steps += 1u;
    }
    return operand;
}

static int fully_overwrites(const pl_plan *plan, const pl_node *node)
{
    if (node->opcode == PL_OPCODE_X86_COMPARE
            || node->opcode == PL_OPCODE_X86_TEST)
        return 1;

    if (node->opcode == PL_OPCODE_X86_SHIFT_FLAGS) {
        if (node->argument_count != 5u) return 0;
        const pl_operand *shift = &plan->arguments[node->argument_at + 3u];
        const pl_operand *word = &plan->arguments[node->argument_at + 4u];
        if (shift->kind != PL_OPERAND_CONST || word->kind != PL_OPERAND_CONST)
            return 0;
        pl_u64 amount = shift->value;
        pl_u64 descriptor = word->value;
        pl_u64 width = descriptor & 0x7full;
        pl_u64 group = (descriptor >> 8u) & 7u;
        return (width == 8u || width == 16u || width == 32u || width == 64u)
            && (amount & (width - 1u)) != 0
            && (group >= 4u && group <= 7u);
    }

    pl_u32 at;
    if (node->opcode == PL_OPCODE_X86_FLAGS) at = 4u;
    else if (node->opcode == PL_OPCODE_X86_ALU) at = 3u;
    else if (node->opcode == PL_OPCODE_X86_AFFINE_ALU) at = 4u;
    else return 0;

    if (node->argument_count <= at) return 0;
    const pl_operand *word = &plan->arguments[node->argument_at + at];
    if (word->kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = word->value;
    pl_u64 group = (descriptor >> 8u) & 7u;
    return group != 2u && group != 4u && !(descriptor & (1ull << 11u));
}

int pl_rebase_overwritten_flags(const pl_plan *in, pl_arena *arena,
                                pl_plan *out)
{
    *out = *in;
    out->arguments = pl_arena_take(
        arena, (in->argument_count ? in->argument_count : 1u)
               * (pl_u32)sizeof *out->arguments);
    out->nodes = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *out->nodes);
    out->stack = pl_arena_take(
        arena, (in->stack_count ? in->stack_count : 1u)
               * (pl_u32)sizeof *out->stack);
    out->locals = pl_arena_take(
        arena, (in->local_count ? in->local_count : 1u)
               * (pl_u32)sizeof *out->locals);
    if (!out->arguments || !out->nodes || !out->stack || !out->locals)
        return PL_ERROR_ARENA;

    for (pl_u32 index = 0; index < in->argument_count; ++index)
        out->arguments[index] = in->arguments[index];
    for (pl_u32 index = 0; index < in->node_count; ++index)
        out->nodes[index] = in->nodes[index];
    for (pl_u32 index = 0; index < in->stack_count; ++index)
        out->stack[index] = in->stack[index];
    for (pl_u32 index = 0; index < in->local_count; ++index)
        out->locals[index] = in->locals[index];
    out->wave_offsets = 0;
    out->wave_values = 0;

    for (pl_u32 index = 0; index < in->node_count; ++index) {
        const pl_node *node = &in->nodes[index];
        if (!node->argument_count || !fully_overwrites(in, node)) continue;
        out->arguments[node->argument_at] = flag_chain_root(
            in, in->arguments[node->argument_at]);
    }
    return 0;
}

/* Local physical closure.
 *
 * The complete rewrite sweep is deliberately broad, but its dominant
 * local cases all have the same shape: resolve an already rebuilt prefix,
 * substitute an exact identity, and let liveness erase the superseded node.
 * Keeping this in the C plan representation avoids a tuple graph or a second
 * instruction vocabulary on the product path. */

static const pl_node *physical_form(const pl_plan *plan, pl_operand operand)
{
    if (operand.kind != PL_OPERAND_NODE || !operand.value
            || operand.value > plan->node_count)
        return 0;
    return &plan->nodes[operand.value - 1u];
}

static const pl_operand *physical_arguments(const pl_plan *plan,
                                            const pl_node *node)
{
    return plan->arguments + node->argument_at;
}

/* Return lane 0/1 and semantic AND/ADD/SUB/OR/XOR = 0..4. */
static int arithmetic_opcode(pl_u32 opcode, pl_u32 *lane,
                             pl_u32 *semantic, int *immediate)
{
    for (pl_u32 width = 0u; width < 2u; ++width)
        for (pl_u32 operation = 0u; operation < 5u; ++operation) {
            if (opcode == PL_OPCODE_ALU_IMMEDIATE[width][operation]) {
                *lane = width;
                *semantic = operation;
                *immediate = 1;
                return 1;
            }
            if (opcode == PL_OPCODE_ALU_REGISTER[width][operation]) {
                *lane = width;
                *semantic = operation;
                *immediate = 0;
                return 1;
            }
        }
    return 0;
}

/* One total alpha order for operands of commutative physical operators.
 * Constants sort last so the canonical pair also selects the immediate
 * opcode.  The order is semantic: swapping a pair cannot change the result,
 * but failing to swap prevents pl_emit_shared from taking the quotient. */
static int commutative_after(pl_operand left, pl_operand right)
{
    int left_constant = left.kind == PL_OPERAND_CONST;
    int right_constant = right.kind == PL_OPERAND_CONST;
    if (left_constant != right_constant) return left_constant;
    if (left.kind != right.kind) return left.kind > right.kind;
    return left.value > right.value;
}

static void canonical_commutative(pl_operand *operand, pl_u32 count)
{
    for (pl_u32 at = 1u; at < count; ++at) {
        pl_u32 rank = at;
        while (rank && commutative_after(
                operand[rank - 1u], operand[rank])) {
            pl_operand swap = operand[rank - 1u];
            operand[rank - 1u] = operand[rank];
            operand[rank] = swap;
            --rank;
        }
    }
}

#define PL_LINEAR_CANCEL_TERMS 8u

typedef struct {
    pl_operand positive[PL_LINEAR_CANCEL_TERMS];
    pl_operand negative[PL_LINEAR_CANCEL_TERMS];
    pl_u32 positive_count;
    pl_u32 negative_count;
    pl_u64 constant;
    int cancelled;
} linear_cancel_form;

static int same_physical_operand(pl_operand left, pl_operand right)
{
    return left.kind == right.kind && left.value == right.value;
}

static int linear_cancel_term(linear_cancel_form *form,
                              pl_operand operand, int sign)
{
    if (!form || (sign != 1 && sign != -1)) return 0;
    if (operand.kind == PL_OPERAND_CONST) {
        form->constant += sign > 0 ? operand.value : 0u - operand.value;
        return 1;
    }
    pl_operand *opposite = sign > 0 ? form->negative : form->positive;
    pl_u32 *opposite_count = sign > 0
                           ? &form->negative_count : &form->positive_count;
    for (pl_u32 index = 0u; index < *opposite_count; ++index) {
        if (!same_physical_operand(opposite[index], operand)) continue;
        opposite[index] = opposite[--*opposite_count];
        form->cancelled = 1;
        return 1;
    }
    pl_operand *same = sign > 0 ? form->positive : form->negative;
    pl_u32 *same_count = sign > 0
                       ? &form->positive_count : &form->negative_count;
    if (*same_count >= PL_LINEAR_CANCEL_TERMS) return 0;
    same[(*same_count)++] = operand;
    return 1;
}

static int collect_linear_cancel(const pl_plan *plan, pl_operand operand,
                                 int sign, pl_u32 remaining,
                                 linear_cancel_form *form)
{
    if (!plan || !remaining || !form) return 0;
    const pl_node *node = physical_form(plan, operand);
    if (!node) return linear_cancel_term(form, operand, sign);
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = physical_arguments(plan, node);
    pl_u32 lane = 0u, semantic = 0u;
    int immediate = 0;
    if (node->argument_count == 2u
            && arithmetic_opcode(
                node->opcode, &lane, &semantic, &immediate)
            && lane == 1u && (semantic == 1u || semantic == 2u)) {
        return collect_linear_cancel(
                   plan, arguments[0], sign, remaining - 1u, form)
            && collect_linear_cancel(
                   plan, arguments[1], semantic == 1u ? sign : -sign,
                   remaining - 1u, form);
    }
    if (node->opcode == PL_OPCODE_ADD3[1]
            && node->argument_count == 3u) {
        for (pl_u32 slot = 0u; slot < 3u; ++slot)
            if (!collect_linear_cancel(
                    plan, arguments[slot], sign, remaining - 1u, form))
                return 0;
        return 1;
    }
    return linear_cancel_term(form, operand, sign);
}

/* Close only a cancellation which reduces the complete expression to one
 * exact 64-bit x86 arithmetic operation (or an identity).  This is the
 * important global case without allocating a parallel expression tree or
 * increasing the builder's linear arena bound. */
static int cancelled_linear_binary(pl_builder *builder, const pl_plan *plan,
                                   pl_u32 opcode, const pl_operand *arguments,
                                   pl_u32 argument_count,
                                   pl_operand *replacement)
{
    if (!builder || !plan || !arguments || !replacement) return -1;
    pl_u32 lane = 0u, semantic = 0u;
    int immediate = 0;
    linear_cancel_form form = { { { 0u, 0u } }, { { 0u, 0u } },
                                0u, 0u, 0u, 0 };
    if (argument_count != 2u
            || !arithmetic_opcode(opcode, &lane, &semantic, &immediate)
            || lane != 1u || (semantic != 1u && semantic != 2u)
            || !collect_linear_cancel(
                plan, arguments[0], 1, plan->node_count + 1u, &form)
            || !collect_linear_cancel(
                plan, arguments[1], semantic == 1u ? 1 : -1,
                plan->node_count + 1u, &form)
            || !form.cancelled)
        return 0;

    pl_u32 terms = form.positive_count + form.negative_count
                 + (form.constant != 0u ? 1u : 0u);
    if (terms > 2u || form.negative_count > 1u) return 0;
    if (!terms) {
        *replacement = (pl_operand){ PL_OPERAND_CONST, 0u };
        return 1;
    }
    if (!form.negative_count && form.positive_count == 1u
            && !form.constant) {
        *replacement = form.positive[0];
        return 1;
    }
    if (!form.negative_count && !form.positive_count) {
        *replacement = (pl_operand){ PL_OPERAND_CONST, form.constant };
        return 1;
    }

    pl_operand binary[2];
    pl_u32 result_opcode = PL_OPCODE_ALU_REGISTER[1][1u];
    if (form.negative_count) {
        if (form.positive_count) {
            if (form.constant) return 0;
            binary[0] = form.positive[0];
        } else {
            binary[0] = (pl_operand){ PL_OPERAND_CONST, form.constant };
        }
        binary[1] = form.negative[0];
        result_opcode = PL_OPCODE_ALU_REGISTER[1][2u];
    } else {
        binary[0] = form.positive[0];
        binary[1] = form.positive_count == 2u
                  ? form.positive[1]
                  : (pl_operand){ PL_OPERAND_CONST, form.constant };
        canonical_commutative(binary, 2u);
        if (binary[1].kind == PL_OPERAND_CONST)
            result_opcode = PL_OPCODE_ALU_IMMEDIATE[1][1u];
    }
    pl_u32 node = pl_emit_shared(builder, result_opcode, binary, 2u);
    if (!node) return -1;
    *replacement = (pl_operand){ PL_OPERAND_NODE, node };
    return 1;
}

static pl_u64 lane_word_mask(pl_u32 lane)
{
    return lane ? ~0ull : 0xffffffffull;
}

static int projects_x86_condition(pl_u32 opcode)
{
    return opcode == PL_OPCODE_X86_FLAGS
        || opcode == PL_OPCODE_X86_ALU
        || opcode == PL_OPCODE_X86_AFFINE_ALU
        || opcode == PL_OPCODE_X86_COMPARE
        || opcode == PL_OPCODE_X86_SHIFT_FLAGS
        || opcode == PL_OPCODE_X86_TEST
        || opcode == PL_OPCODE_X86_BIT_FLAGS
        || opcode == PL_OPCODE_X86_ROTATE_CARRY
        || opcode == PL_OPCODE_X86_BIT_SUMMARY
        || opcode == PL_OPCODE_X86_DOUBLE_SHIFT
        || opcode == PL_OPCODE_X86_BZHI;
}

/* x86 condition results are canonical Boolean words, not byte fragments.
 * SETcc happens to write one byte in the source ISA, but after the surrounding
 * zero-extension has been composed the value is exactly 0 or 1 at every wider
 * lane.  Retaining an INSERT around it invents both work and a dependency. */
static int operand_is_boolean(const pl_plan *plan, pl_operand operand)
{
    if (operand.kind == PL_OPERAND_CONST) return operand.value <= 1u;
    if (operand.kind == PL_OPERAND_PROJECTION)
        return (operand.value & ((1u << PL_PROJECTION_SELECTOR_BITS) - 1u))
            < 16u;
    const pl_node *node = physical_form(plan, operand);
    return node && (node->opcode == PL_OPCODE_X86_CONDITION
                 || node->opcode == PL_OPCODE_X86_TEST_CONDITION);
}

/* Compose TEST -> condition -> zero-extended SETcc as one Boolean primitive.
 * Doing this at the outer INSERT is important: a condition used directly as a
 * branch keeps the established native-control form, while this exact scalar
 * value has no separately observable intermediate flags word. */
static int fuse_zero_extended_test_condition(
    pl_builder *builder, const pl_plan *plan, pl_operand condition_value,
    pl_operand *out)
{
    if (!builder || !plan || !out) return -1;
    const pl_node *condition = physical_form(plan, condition_value);
    if (!condition || condition->opcode != PL_OPCODE_X86_CONDITION
            || condition->argument_count != 2u)
        return 0;
    const pl_operand *condition_argument =
        physical_arguments(plan, condition);
    if (condition_argument[0].kind != PL_OPERAND_NODE
            || condition_argument[1].kind != PL_OPERAND_CONST
            || condition_argument[1].value >= 16u)
        return 0;
    const pl_node *test = physical_form(plan, condition_argument[0]);
    if (!test || test->opcode != PL_OPCODE_X86_TEST
            || test->argument_count != 4u)
        return 0;
    const pl_operand *test_argument = physical_arguments(plan, test);
    if (test_argument[3].kind != PL_OPERAND_CONST
            || (test_argument[3].value >> 8u))
        return 0;
    pl_operand arguments[3] = {
        test_argument[1], test_argument[2],
        { PL_OPERAND_CONST,
          test_argument[3].value | (condition_argument[1].value << 8u) },
    };
    pl_u32 value = pl_emit_shared(
        builder, PL_OPCODE_X86_TEST_CONDITION, arguments, 3u);
    if (!value) return -1;
    *out = (pl_operand){ PL_OPERAND_NODE, value };
    return 1;
}

/* Values in the lane32 vocabulary are represented by their canonical
 * zero-extended word.  Keep that region fact in the SSA instead of spelling
 * it again as lane64.INSERT(0, value, low32). */
static int operand_is_u32(const pl_plan *plan, pl_operand operand,
                          pl_u32 remaining)
{
    if (operand.kind == PL_OPERAND_CONST)
        return !(operand.value >> 32u);
    if (!remaining) return 0;
    const pl_node *node = physical_form(plan, operand);
    if (!node) return 0;
    if (node->opcode < PL_LANE_OPCODE_STRIDE
            || node->opcode == PL_OPCODE_LANE32_INSERT
            || node->opcode == PL_OPCODE_SELECT_U32
            || node->opcode == PL_OPCODE_X86_CONDITION
            || node->opcode == PL_OPCODE_X86_TEST_CONDITION
            || pl_opcode_produces_flags(node->opcode))
        return 1;

    if (node->opcode == PL_OPCODE_LANE64_INSERT
            && node->argument_count == 3u) {
        const pl_operand *arguments = physical_arguments(plan, node);
        if (arguments[2].kind != PL_OPERAND_CONST
                || arguments[2].value >> 16u)
            return 0;
        pl_u32 field = (pl_u32)arguments[2].value & 0xffu;
        pl_u32 offset = ((pl_u32)arguments[2].value >> 8u) & 0xffu;
        if (!field || offset > 64u || field > 64u - offset
                || offset + field > 32u)
            return 0;
        if (field == 32u && !offset
                && arguments[0].kind == PL_OPERAND_CONST
                && arguments[0].value == 0u)
            return 1;
        return operand_is_u32(plan, arguments[0], remaining - 1u);
    }

    /* Selection cannot introduce a high bit absent from both arms.  Keeping
     * a lane64 SELECT in the 32-bit region avoids materializing
     * lane64.INSERT(0, select, low32) between consecutive CMOV-derived
     * choices.  The predicate need not be inspected: either complete future
     * is already a canonical u32 word. */
    if (node->opcode == PL_OPCODE_LANE64_SELECT
            && node->argument_count == 3u) {
        const pl_operand *arguments = physical_arguments(plan, node);
        return operand_is_u32(plan, arguments[0], remaining - 1u)
            && operand_is_u32(plan, arguments[1], remaining - 1u);
    }

    pl_u32 lane = 0u, semantic = 0u;
    int immediate = 0;
    if (!arithmetic_opcode(node->opcode, &lane, &semantic, &immediate)
            || lane != 1u || semantic != 0u
            || node->argument_count != 2u)
        return 0;
    const pl_operand *arguments = physical_arguments(plan, node);
    return operand_is_u32(plan, arguments[0], remaining - 1u)
        || operand_is_u32(plan, arguments[1], remaining - 1u);
}

/* Compute the low-word quotient of one already rebuilt value.  Arithmetic
 * modulo 2^32 commutes with AND/ADD/SUB/OR/XOR and multiplication.  A left
 * shift commutes while its 64-bit count is below 32.  This is a physical
 * region projection, not a speculative strength reduction. */
static int project_low32(pl_builder *builder, const pl_plan *plan,
                         pl_operand source, pl_operand *out)
{
    if (operand_is_u32(plan, source, plan->node_count + 1u)) {
        *out = source;
        return 1;
    }
    const pl_node *node = physical_form(plan, source);
    if (!node) return 0;
    const pl_operand *held = physical_arguments(plan, node);
    pl_operand arguments[PL_STAGED_ARGUMENTS];
    if (node->argument_count > PL_STAGED_ARGUMENTS) return 0;
    for (pl_u32 index = 0u; index < node->argument_count; ++index) {
        arguments[index] = held[index];
        if (arguments[index].kind == PL_OPERAND_CONST)
            arguments[index].value &= 0xffffffffu;
    }

    pl_u32 opcode = 0u;
    pl_u32 lane = 0u, semantic = 0u;
    int immediate = 0;
    if (arithmetic_opcode(node->opcode, &lane, &semantic, &immediate)
            && lane == 1u && node->argument_count == 2u) {
        opcode = immediate ? PL_OPCODE_ALU_IMMEDIATE[0][semantic]
                           : PL_OPCODE_ALU_REGISTER[0][semantic];
    } else if (node->opcode == PL_OPCODE_MULR
            && node->argument_count == 2u) {
        opcode = PL_OPCODE_LANE32_MULR;
    } else if (node->opcode == PL_OPCODE_LANE64_SHL
            && node->argument_count == 2u
            && held[1].kind == PL_OPERAND_CONST
            && held[1].value < 32u) {
        opcode = PL_OPCODE_LANE32_SHL;
        arguments[1] = held[1];
    } else if (node->opcode == PL_OPCODE_EXTEND32_S
            && node->argument_count == 1u) {
        opcode = PL_OPCODE_LANE32_WRAP_I64;
    } else {
        return 0;
    }

    pl_u32 value = pl_emit_shared(
        builder, opcode, arguments, node->argument_count);
    if (!value) return -1;
    out->kind = PL_OPERAND_NODE;
    out->value = value;
    return 1;
}

static pl_u64 evaluate_arithmetic(pl_u32 semantic, pl_u64 left,
                                  pl_u64 right, pl_u64 mask)
{
    pl_u64 value;
    switch (semantic) {
    case 0u: value = left & right; break;
    case 1u: value = left + right; break;
    case 2u: value = left - right; break;
    case 3u: value = left | right; break;
    default: value = left ^ right; break;
    }
    return value & mask;
}

/* Return lane width and SHL/SHR/SAR = 0/1/2.  Immediate and register-count
 * spellings have identical value semantics after x86 count normalization, so
 * constant substitution must not leave either spelling materialized. */
static int shift_opcode(pl_u32 opcode, pl_u32 *bits, pl_u32 *semantic)
{
    const pl_u32 spelling[2][3][2] = {
        {
            { PL_OPCODE_LANE32_SHL, PL_OPCODE_LANE32_SHLR },
            { PL_OPCODE_LANE32_SHR, PL_OPCODE_LANE32_SHRR },
            { PL_OPCODE_LANE32_SAR, PL_OPCODE_LANE32_SARR },
        },
        {
            { PL_OPCODE_LANE64_SHL, PL_OPCODE_LANE64_SHLR },
            { PL_OPCODE_LANE64_SHR, PL_OPCODE_LANE64_SHRR },
            { PL_OPCODE_LANE64_SAR, PL_OPCODE_LANE64_SARR },
        },
    };
    for (pl_u32 lane = 0u; lane < 2u; ++lane)
        for (pl_u32 operation = 0u; operation < 3u; ++operation)
            for (pl_u32 form = 0u; form < 2u; ++form)
                if (opcode == spelling[lane][operation][form]) {
                    *bits = lane ? 64u : 32u;
                    *semantic = operation;
                    return 1;
                }
    return 0;
}

/* A 32-bit consumer observes exactly the low word.  The full-width spelling
 * INSERT(0, value, low32) exists only to describe x86's zero-extension at a
 * 64-bit publication boundary; retaining it below another 32-bit primitive
 * materializes the same projection twice. */
static pl_operand low32_input(const pl_plan *plan, pl_operand operand)
{
    const pl_node *node = physical_form(plan, operand);
    if (!node || node->opcode != PL_OPCODE_LANE64_INSERT
            || node->argument_count != 3u)
        return operand;
    const pl_operand *arguments = physical_arguments(plan, node);
    if (arguments[0].kind == PL_OPERAND_CONST && !arguments[0].value
            && arguments[2].kind == PL_OPERAND_CONST
            && arguments[2].value == 32u)
        return arguments[1];
    return operand;
}

/* Compose opposite logical shifts before instruction selection.  For one
 * W-bit word,
 *
 *   (x >> r) << l = shift(x, l-r) & (word << l)
 *   (x << l) >> r = shift(x, l-r) & (word >> r).
 *
 * The signed difference chooses SHL or SHR.  This exposes the shared shifted
 * parent used by sibling masks, instead of preserving two source-shaped shift
 * chains with the same complete future. */
static int compose_opposite_logical_shifts(
    pl_builder *builder, const pl_plan *plan, pl_u32 opcode,
    const pl_operand *argument, pl_u32 argument_count,
    pl_operand *replacement)
{
    if (!builder || !plan || !argument || !replacement
            || argument_count != 2u
            || argument[1].kind != PL_OPERAND_CONST)
        return 0;
    pl_u32 bits = 0u, outer = 0u;
    if (!shift_opcode(opcode, &bits, &outer)
            || (outer != 0u && outer != 1u))
        return 0;
    const pl_node *inner_node = physical_form(plan, argument[0]);
    if (!inner_node || inner_node->argument_count != 2u) return 0;
    const pl_operand *inner_argument = physical_arguments(plan, inner_node);
    pl_u32 inner_bits = 0u, inner = 0u;
    if (!shift_opcode(inner_node->opcode, &inner_bits, &inner)
            || inner_bits != bits || inner == outer
            || (inner != 0u && inner != 1u)
            || inner_argument[1].kind != PL_OPERAND_CONST)
        return 0;

    pl_u32 first = (pl_u32)(inner_argument[1].value & (bits - 1u));
    pl_u32 second = (pl_u32)(argument[1].value & (bits - 1u));
    pl_u32 left = inner == 0u ? first : second;
    pl_u32 right = inner == 1u ? first : second;
    pl_u32 difference = left > right ? left - right : right - left;
    pl_u64 word = bits == 64u ? ~0ull : 0xffffffffull;
    pl_u64 mask = inner == 1u ? word << left : word >> right;
    mask &= word;

    pl_u32 node_checkpoint = builder->plan->node_count;
    pl_u32 argument_checkpoint = builder->plan->argument_count;
    pl_operand value = inner_argument[0];
    if (difference) {
        pl_u32 shift = left > right
                     ? (bits == 64u
                        ? PL_OPCODE_LANE64_SHL : PL_OPCODE_LANE32_SHL)
                     : (bits == 64u
                        ? PL_OPCODE_LANE64_SHR : PL_OPCODE_LANE32_SHR);
        pl_operand shifted[2] = {
            value, { PL_OPERAND_CONST, difference },
        };
        pl_u32 node = pl_emit_shared(builder, shift, shifted, 2u);
        if (!node) {
            builder->plan->node_count = node_checkpoint;
            builder->plan->argument_count = argument_checkpoint;
            return -1;
        }
        value = (pl_operand){ PL_OPERAND_NODE, node };
    }
    if (mask != word) {
        pl_operand masked[2] = {
            value, { PL_OPERAND_CONST, mask },
        };
        pl_u32 node = pl_emit_shared(
            builder, PL_OPCODE_ALU_IMMEDIATE[bits == 64u][0u], masked, 2u);
        if (!node) {
            builder->plan->node_count = node_checkpoint;
            builder->plan->argument_count = argument_checkpoint;
            return -1;
        }
        value = (pl_operand){ PL_OPERAND_NODE, node };
    }
    /* Replacing two shifts by two newly materialized operations only changes
     * spelling.  Admit the form when it removes work or when the shifted
     * parent was already present and the quotient becomes shared. */
    if (builder->plan->node_count > node_checkpoint + 1u) {
        builder->plan->node_count = node_checkpoint;
        builder->plan->argument_count = argument_checkpoint;
        return 0;
    }
    *replacement = value;
    return 1;
}

static pl_u64 evaluate_shift(pl_u32 bits, pl_u32 semantic,
                             pl_u64 value, pl_u64 amount)
{
    pl_u64 mask = bits == 64u ? ~0ull : 0xffffffffull;
    value &= mask;
    amount &= bits - 1u;
    if (!amount) return value;
    if (semantic == 0u) return (value << amount) & mask;
    pl_u64 result = value >> amount;
    if (semantic == 2u && (value & (1ull << (bits - 1u))))
        result |= mask ^ (mask >> amount);
    return result & mask;
}

/* Logical right shift observes source bits [count-1, width): the result uses
 * [count,width), and CF uses count-1.  An AND which changes only lower bits is
 * therefore absent from both the shifted value and the exact x86 flags. */
static int logical_shr_source_before_mask(const pl_plan *plan,
                                          pl_operand source,
                                          pl_u32 bits, pl_u64 amount,
                                          pl_operand *unmasked)
{
    if (!plan || !unmasked || (bits != 32u && bits != 64u)) return 0;
    amount &= bits - 1u;
    if (!amount) return 0;
    const pl_node *mask = physical_form(plan, source);
    if (!mask || mask->argument_count != 2u) return 0;
    pl_u32 lane = 0u, semantic = 0u;
    int immediate = 0;
    if (!arithmetic_opcode(
            mask->opcode, &lane, &semantic, &immediate)
            || semantic != 0u || lane != (bits == 64u)
            || !immediate)
        return 0;
    const pl_operand *argument = physical_arguments(plan, mask);
    if (argument[1].kind != PL_OPERAND_CONST) return 0;
    pl_u64 word = lane_word_mask(lane);
    pl_u64 below = amount == 1u ? 0u : (1ull << (amount - 1u)) - 1u;
    pl_u64 observed = word & ~below;
    if ((argument[1].value & observed) != observed) return 0;
    *unmasked = argument[0];
    return 1;
}

static int same_operand(pl_operand left, pl_operand right)
{
    return left.kind == right.kind && left.value == right.value;
}

/* A bit overlay is the exact per-bit normal form
 *
 *     (base & variable_mask) | constant.
 *
 * Each output bit is therefore either zero, the equally positioned bit of one
 * base word, or one.  AND, OR and field insertion preserve this form whenever
 * their live variable coordinates name the same base.  A shift is admitted
 * only when every variable coordinate is shifted out; moving a live base bit
 * would require a different coordinate map and is deliberately not guessed.
 *
 * This closes ordinary byte/word assembly without retaining an expression
 * tree.  The cache is compiler workspace only, indexed by rebuilt node and
 * observation width, so every node is inspected at most twice and the sweep
 * remains linear in the physical graph. */
typedef struct {
    pl_operand base;
    pl_u64 variable_mask;
    pl_u64 constant;
    pl_u32 operations;
    pl_u8 has_base;
} bit_overlay;

typedef struct {
    bit_overlay *form;
    pl_u8 *state;
    pl_u32 nodes;
} bit_overlay_cache;

static void normalize_bit_overlay(bit_overlay *form, pl_u64 word)
{
    form->constant &= word;
    form->variable_mask &= word & ~form->constant;
    if (!form->variable_mask) form->has_base = 0u;
}

static bit_overlay bit_overlay_atom(pl_operand operand, pl_u64 word)
{
    bit_overlay form = { operand, word, 0u, 0u, 1u };
    if (operand.kind == PL_OPERAND_CONST) {
        form.constant = operand.value & word;
        form.variable_mask = 0u;
        form.has_base = 0u;
    }
    return form;
}

static int compatible_overlay_base(const bit_overlay *left,
                                   const bit_overlay *right)
{
    return !left->has_base || !right->has_base
        || same_operand(left->base, right->base);
}

static pl_operand overlay_base(const bit_overlay *left,
                               const bit_overlay *right)
{
    return left->has_base ? left->base : right->base;
}

static int bit_overlay_value(const pl_plan *plan, pl_operand operand,
                             pl_u32 bits, pl_u32 remaining,
                             bit_overlay_cache *cache, bit_overlay *out);

static int bit_overlay_operation(const pl_plan *plan, pl_u32 opcode,
                                 const pl_operand *argument,
                                 pl_u32 argument_count, pl_u32 bits,
                                 pl_u32 remaining,
                                 bit_overlay_cache *cache, bit_overlay *out)
{
    if (!plan || !argument || !out || !remaining
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u64 word = bits == 64u ? ~0ull : 0xffffffffull;
    pl_u32 lane = 0u, semantic = 0u;
    int immediate = 0;

    if (argument_count == 2u
            && arithmetic_opcode(opcode, &lane, &semantic, &immediate)
            && (semantic == 0u || semantic == 3u)) {
        pl_u32 operation_bits = lane ? 64u : 32u;
        bit_overlay left, right;
        if (!bit_overlay_value(plan, argument[0], operation_bits,
                               remaining - 1u, cache, &left)
                || !bit_overlay_value(plan, argument[1], operation_bits,
                                      remaining - 1u, cache, &right)
                || !compatible_overlay_base(&left, &right))
            return 0;
        out->base = overlay_base(&left, &right);
        out->has_base = left.has_base || right.has_base;
        out->operations = left.operations + right.operations + 1u;
        if (semantic == 3u) {
            out->constant = left.constant | right.constant;
            out->variable_mask = left.variable_mask | right.variable_mask;
        } else {
            /* Per bit, each operand is one of {0, base, 1}. */
            out->constant = left.constant & right.constant;
            out->variable_mask =
                  (left.variable_mask & right.variable_mask)
                | (left.variable_mask & right.constant)
                | (left.constant & right.variable_mask);
        }
        normalize_bit_overlay(out, lane_word_mask(lane));
    } else {
        pl_u32 shift_bits = 0u, shift_semantic = 0u;
        if (argument_count == 2u
                && argument[1].kind == PL_OPERAND_CONST
                && shift_opcode(opcode, &shift_bits, &shift_semantic)) {
            bit_overlay source;
            if (!bit_overlay_value(plan, argument[0], shift_bits,
                                   remaining - 1u, cache, &source))
                return 0;
            pl_u64 amount = argument[1].value & (shift_bits - 1u);
            if (source.has_base && amount) {
                pl_u64 moved = shift_semantic == 0u
                    ? source.variable_mask << amount
                    : shift_semantic == 1u
                    ? source.variable_mask >> amount
                    : source.variable_mask;
                moved &= shift_bits == 64u ? ~0ull : 0xffffffffull;
                if (moved) return 0;
            } else if (source.has_base && shift_semantic == 2u && amount) {
                return 0;
            }
            *out = source;
            out->operations += 1u;
            out->constant = evaluate_shift(
                shift_bits, shift_semantic, source.constant, amount);
            if (amount) {
                out->variable_mask = 0u;
                out->has_base = 0u;
            }
            normalize_bit_overlay(
                out, shift_bits == 64u ? ~0ull : 0xffffffffull);
        } else if (argument_count == 3u
                && (opcode == PL_OPCODE_LANE32_INSERT
                    || opcode == PL_OPCODE_LANE64_INSERT)
                && argument[2].kind == PL_OPERAND_CONST) {
            pl_u32 insert_bits = opcode == PL_OPCODE_LANE32_INSERT
                               ? 32u : 64u;
            pl_u64 descriptor = argument[2].value;
            pl_u32 field = (pl_u32)descriptor & 0xffu;
            pl_u32 offset = ((pl_u32)descriptor >> 8u) & 0xffu;
            if ((descriptor >> 16u) || !field || offset > insert_bits
                    || field > insert_bits - offset)
                return 0;
            bit_overlay base, inserted;
            if (!bit_overlay_value(plan, argument[0], insert_bits,
                                   remaining - 1u, cache, &base)
                    || !bit_overlay_value(plan, argument[1], insert_bits,
                                          remaining - 1u, cache, &inserted))
                return 0;
            pl_u64 low = field == 64u ? ~0ull : (1ull << field) - 1u;
            pl_u64 placed = low << offset;
            pl_u64 base_variable = base.variable_mask & ~placed;
            pl_u64 inserted_variable = inserted.variable_mask & low;
            /* Inserting a live bit at a different coordinate is not a same-
             * base overlay.  Constant inserted fields remain admissible. */
            if (offset && inserted_variable) return 0;
            if (base_variable && inserted_variable
                    && (!base.has_base || !inserted.has_base
                        || !same_operand(base.base, inserted.base)))
                return 0;
            out->base = base_variable ? base.base : inserted.base;
            out->has_base = base_variable || inserted_variable;
            out->variable_mask = base_variable
                               | (inserted_variable << offset);
            out->constant = (base.constant & ~placed)
                          | ((inserted.constant & low) << offset);
            out->operations = base.operations + inserted.operations + 1u;
            normalize_bit_overlay(
                out, insert_bits == 64u ? ~0ull : 0xffffffffull);
        } else {
            return 0;
        }
    }

    /* A 32-bit primitive is already zero-extended when observed as 64-bit;
     * a narrow consumer sees only its low word. */
    normalize_bit_overlay(out, word);
    return 1;
}

static int bit_overlay_value(const pl_plan *plan, pl_operand operand,
                             pl_u32 bits, pl_u32 remaining,
                             bit_overlay_cache *cache, bit_overlay *out)
{
    pl_u64 word = bits == 64u ? ~0ull : 0xffffffffull;
    if (operand.kind == PL_OPERAND_CONST) {
        *out = bit_overlay_atom(operand, word);
        return 1;
    }
    if (operand.kind != PL_OPERAND_NODE || !operand.value
            || operand.value > plan->node_count || !cache
            || operand.value > cache->nodes || !remaining) {
        *out = bit_overlay_atom(operand, word);
        return 1;
    }

    pl_u32 node_value = (pl_u32)operand.value;
    pl_u32 key = node_value * 2u + (bits == 64u);
    if (cache->state[key] == 2u) {
        *out = cache->form[key];
        return 1;
    }
    if (cache->state[key] == 1u) {
        *out = bit_overlay_atom(operand, word);
        return 1;
    }
    cache->state[key] = 1u;
    const pl_node *node = physical_form(plan, operand);
    const pl_operand *arguments = physical_arguments(plan, node);
    bit_overlay form;
    if (!bit_overlay_operation(plan, node->opcode, arguments,
                               node->argument_count, bits, remaining - 1u,
                               cache, &form))
        form = bit_overlay_atom(operand, word);
    cache->form[key] = form;
    cache->state[key] = 2u;
    *out = form;
    return 1;
}

static int canonical_bit_overlay(pl_builder *builder, const pl_plan *plan,
                                 pl_u32 opcode, const pl_operand *argument,
                                 pl_u32 argument_count,
                                 bit_overlay_cache *cache,
                                 pl_operand *replacement)
{
    if (!builder || !plan || !argument || !cache || !replacement) return -1;
    pl_u32 bits = 0u, semantic = 0u, lane = 0u;
    int immediate = 0;
    if (arithmetic_opcode(opcode, &lane, &semantic, &immediate)
            && (semantic == 0u || semantic == 3u))
        bits = lane ? 64u : 32u;
    else if (!shift_opcode(opcode, &bits, &semantic)
            && opcode != PL_OPCODE_LANE32_INSERT
            && opcode != PL_OPCODE_LANE64_INSERT)
        return 0;
    else if (!bits)
        bits = opcode == PL_OPCODE_LANE32_INSERT ? 32u : 64u;

    bit_overlay form;
    if (!bit_overlay_operation(plan, opcode, argument, argument_count, bits,
                               plan->node_count + 1u, cache, &form))
        return 0;
    pl_u64 word = bits == 64u ? ~0ull : 0xffffffffull;
    normalize_bit_overlay(&form, word);
    /* A full 32-bit mask is not an identity on an arbitrary 64-bit base.
     * An emitted 32-bit OR already zero-extends; without one, retain the
     * narrowing operation unless the base's upper word is proven zero. */
    int needs_mask = form.variable_mask != word
        || (bits == 32u && form.has_base && !form.constant
            && !operand_is_u32(plan, form.base, plan->node_count + 1u));
    pl_u32 cost = !form.has_base ? 0u
                : (needs_mask ? 1u : 0u)
                  + (form.constant != 0u ? 1u : 0u);
    if (form.operations <= cost) return 0;
    if (!form.has_base) {
        *replacement = (pl_operand){ PL_OPERAND_CONST, form.constant };
        return 1;
    }

    *replacement = form.base;
    if (needs_mask) {
        pl_operand operands[2] = {
            *replacement, { PL_OPERAND_CONST, form.variable_mask },
        };
        pl_u32 value = pl_emit_shared(
            builder, PL_OPCODE_ALU_IMMEDIATE[bits == 64u][0u], operands, 2u);
        if (!value) return -1;
        *replacement = (pl_operand){ PL_OPERAND_NODE, value };
    }
    if (form.constant) {
        pl_operand operands[2] = {
            *replacement, { PL_OPERAND_CONST, form.constant },
        };
        pl_u32 value = pl_emit_shared(
            builder, PL_OPCODE_ALU_IMMEDIATE[bits == 64u][3u], operands, 2u);
        if (!value) return -1;
        *replacement = (pl_operand){ PL_OPERAND_NODE, value };
    }
    return 1;
}

/* Recognize the two ordinary x86 spellings of `base | constant`: a full-lane
 * OR, and a sub-register OR followed by insertion back into the full GPR.
 * The latter is what ORB/ORW on AH/AL/etc. becomes. */
/* An identity or bitwise AND cannot produce a nonzero value from zero.
 * When one select arm is zero, the guard either leaves the other arm
 * unchanged or makes the entire result zero:
 *
 *   select(0, x & mask, x == 0) = x & mask.
 *
 * The TEST remains in the plan when its flags are published.  Only the
 * redundant value selection disappears.  Require the test to observe at
 * least the width of the AND so upper bits cannot hide a nonzero result. */
static int collapse_zero_guarded_value(const pl_plan *plan,
    const pl_operand argument[3], pl_u32 bits, pl_operand *out)
{
    pl_operand flags = argument[2];
    pl_u32 code = 0u;
    if (flags.kind == PL_OPERAND_PROJECTION) {
        code = (pl_u32)(flags.value & 255u);
        flags = (pl_operand){ PL_OPERAND_NODE, flags.value >> 8u };
    } else {
        const pl_node *condition = physical_form(plan, flags);
        if (!condition || condition->opcode != PL_OPCODE_X86_CONDITION
                || condition->argument_count != 2u) return 0;
        const pl_operand *condition_argument = physical_arguments(plan, condition);
        if (condition_argument[1].kind != PL_OPERAND_CONST) return 0;
        code = (pl_u32)condition_argument[1].value;
        flags = condition_argument[0];
    }
    if (code != 4u && code != 5u) return 0;
    pl_u32 zero_arm = argument[0].kind == PL_OPERAND_CONST
        && !(argument[0].value & lane_word_mask(bits == 64u)) ? 0u : 1u;
    if (argument[zero_arm].kind != PL_OPERAND_CONST
            || (argument[zero_arm].value & lane_word_mask(bits == 64u))) return 0;
    const pl_node *test = physical_form(plan, flags);
    if (!test || test->opcode != PL_OPCODE_X86_TEST
            || test->argument_count != 4u) return 0;
    const pl_operand *tested = physical_arguments(plan, test);
    if (tested[3].kind != PL_OPERAND_CONST
            || (tested[3].value != 32u && tested[3].value != 64u)
            || !same_operand(tested[1], tested[2])) return 0;
    pl_operand masked = argument[1u - zero_arm];
    if (same_operand(masked, tested[1]) && tested[3].value >= bits) {
        *out = zero_arm == (code == 4u ? 0u : 1u)
            ? masked : argument[zero_arm];
        return 1;
    }
    const pl_node *and_node = physical_form(plan, masked);
    if (!and_node || and_node->argument_count != 2u) return 0;
    pl_u32 and_bits = 0u;
    if (and_node->opcode == PL_OPCODE_ALU_IMMEDIATE[0][0]
            || and_node->opcode == PL_OPCODE_ALU_REGISTER[0][0])
        and_bits = 32u;
    else if (and_node->opcode == PL_OPCODE_ALU_IMMEDIATE[1][0]
            || and_node->opcode == PL_OPCODE_ALU_REGISTER[1][0])
        and_bits = 64u;
    if (!and_bits || tested[3].value < and_bits)
        return 0;
    const pl_operand *and_arguments = physical_arguments(plan, and_node);
    if (!same_operand(and_arguments[0], tested[1])
            && !same_operand(and_arguments[1], tested[1])) return 0;
    *out = zero_arm == (code == 4u ? 0u : 1u)
        ? masked : argument[zero_arm];
    return 1;
}

/* Selecting one output bit under a one-bit zero test is a bit coordinate
 * projection, not a Boolean value followed by CMOV:
 *   select(2^q, 0, (x & 2^p) != 0) = ((x >> p) & 1) << q.
 * Keep the original flag node for any other observer. Only the value's
 * future is substituted; zero-test polarity becomes XOR with the same bit. */
static int selected_bit_projection(pl_builder *builder, const pl_plan *plan,
    const pl_operand argument[3], pl_u32 bits, pl_operand *out)
{
    if (argument[0].kind != PL_OPERAND_CONST || argument[1].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 word = bits == 64u ? ~0ull : 0xffffffffull;
    pl_u64 yes = argument[0].value & word, no = argument[1].value & word;
    pl_u64 mask = yes | no;
    if ((yes && no) || !mask || (mask & (mask - 1u))) return 0;
    pl_operand flag = argument[2];
    pl_u32 code = 0u;
    if (flag.kind == PL_OPERAND_PROJECTION) {
        code = (pl_u32)(flag.value & 255u);
        flag = (pl_operand){ PL_OPERAND_NODE, flag.value >> 8u };
    } else {
        const pl_node *condition = physical_form(plan, flag);
        if (!condition || condition->opcode != PL_OPCODE_X86_CONDITION
                || condition->argument_count != 2u) return 0;
        const pl_operand *condition_argument = physical_arguments(plan, condition);
        if (condition_argument[1].kind != PL_OPERAND_CONST
                || condition_argument[1].value > 15u) return 0;
        code = (pl_u32)condition_argument[1].value;
        flag = condition_argument[0];
    }
    if (code != 4u && code != 5u) return 0;
    const pl_node *test = physical_form(plan, flag);
    if (!test || (test->opcode != PL_OPCODE_X86_TEST && test->opcode != PL_OPCODE_X86_ALU)
            || test->argument_count != 4u) return 0;
    const pl_operand *tested = physical_arguments(plan, test);
    if (tested[3].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = tested[3].value;
    pl_u32 width = (pl_u32)descriptor;
    if (descriptor != width
            || (width != 8u && width != 16u && width != 32u && width != 64u)) return 0;
    pl_operand source = tested[1], test_mask = tested[2];
    if (test_mask.kind != PL_OPERAND_CONST) {
        source = tested[2]; test_mask = tested[1];
    }
    if (test_mask.kind != PL_OPERAND_CONST) return 0;
    pl_u64 input_bit = test_mask.value & (~0ull >> (64u - width));
    if (!input_bit || (input_bit & (input_bit - 1u))) return 0;
    pl_u32 p = 0u, q = 0u;
    while ((input_bit >> p) != 1u) ++p;
    while ((mask >> q) != 1u) ++q;
    pl_operand value = source;
    if (p != q) {
        pl_operand shifted[2] = { value, { PL_OPERAND_CONST, p > q ? p - q : q - p } };
        pl_u32 node = pl_emit_shared(builder,
            p > q ? PL_OPCODE_LANE64_SHR : PL_OPCODE_LANE64_SHL, shifted, 2u);
        if (!node) return -1;
        value = (pl_operand){ PL_OPERAND_NODE, node };
    }
    pl_operand masked[2] = { value, { PL_OPERAND_CONST, mask } };
    pl_u32 node = pl_emit_shared(builder, PL_OPCODE_ALU_IMMEDIATE[bits == 64u][0u], masked, 2u);
    if (!node) return -1;
    value = (pl_operand){ PL_OPERAND_NODE, node };
    if ((code == 4u) != (no != 0u)) {
        masked[0] = value;
        node = pl_emit_shared(builder, PL_OPCODE_ALU_IMMEDIATE[bits == 64u][4u], masked, 2u);
        if (!node) return -1;
        value = (pl_operand){ PL_OPERAND_NODE, node };
    }
    *out = value;
    return 1;
}

static int conditional_or_mask(const pl_plan *plan, pl_operand candidate,
                               pl_operand base, pl_u32 *lane, pl_u64 *mask)
{
    const pl_node *node = physical_form(plan, candidate);
    if (!node) return 0;
    pl_u32 arithmetic_lane = 0u, semantic = 0u;
    int immediate = 0;
    const pl_operand *arguments = physical_arguments(plan, node);
    if (node->argument_count == 2u
            && arithmetic_opcode(
                node->opcode, &arithmetic_lane, &semantic, &immediate)
            && semantic == 3u && immediate
            && arguments[1].kind == PL_OPERAND_CONST
            && same_operand(arguments[0], base)) {
        *lane = arithmetic_lane;
        *mask = arguments[1].value & lane_word_mask(arithmetic_lane);
        return 1;
    }

    if ((node->opcode != PL_OPCODE_LANE32_INSERT
            && node->opcode != PL_OPCODE_LANE64_INSERT)
            || node->argument_count != 3u
            || !same_operand(arguments[0], base)
            || arguments[2].kind != PL_OPERAND_CONST)
        return 0;
    pl_u32 bits = node->opcode == PL_OPCODE_LANE32_INSERT ? 32u : 64u;
    pl_u64 descriptor = arguments[2].value;
    pl_u32 field = (pl_u32)descriptor & 0xffu;
    pl_u32 offset = ((pl_u32)descriptor >> 8u) & 0xffu;
    if ((descriptor >> 16u) || !field || offset > bits
            || field > bits - offset)
        return 0;

    const pl_node *masked = physical_form(plan, arguments[1]);
    if (!masked || masked->argument_count != 2u) return 0;
    const pl_operand *masked_arguments = physical_arguments(plan, masked);
    if (!arithmetic_opcode(
            masked->opcode, &arithmetic_lane, &semantic, &immediate)
            || semantic != 3u || !immediate
            || masked_arguments[1].kind != PL_OPERAND_CONST)
        return 0;

    if (!offset) {
        if (!same_operand(masked_arguments[0], base)) return 0;
    } else {
        const pl_node *shift = physical_form(plan, masked_arguments[0]);
        if (!shift || shift->argument_count != 2u
                || (shift->opcode != PL_OPCODE_LANE32_SHR
                    && shift->opcode != PL_OPCODE_LANE64_SHR))
            return 0;
        const pl_operand *shift_arguments = physical_arguments(plan, shift);
        if (!same_operand(shift_arguments[0], base)
                || shift_arguments[1].kind != PL_OPERAND_CONST
                || shift_arguments[1].value != offset)
            return 0;
    }

    pl_u64 field_mask = field == 64u
                      ? ~0ull : (1ull << field) - 1u;
    *lane = operand_is_u32(plan, base, plan->node_count + 1u)
          ? 0u : bits == 64u;
    *mask = (masked_arguments[1].value & field_mask) << offset;
    return 1;
}

/* An ordinary scalar access, as emit_memory_lane consumes it. */
static int ordinary_memory_opcode(pl_u32 opcode, int *store, pl_u32 *width,
                                  pl_u32 *fixed)
{
    if (opcode >= PL_OPCODE_MEMORY_STORE
            && opcode <= PL_OPCODE_MEMORY_STORE32) {
        *store = 1;
        *width = opcode == PL_OPCODE_MEMORY_STORE ? 8u
               : opcode == PL_OPCODE_MEMORY_STORE8 ? 1u
               : opcode == PL_OPCODE_MEMORY_STORE16 ? 2u : 4u;
        *fixed = 4u;
        return 1;
    }
    for (pl_u32 lane = 0u; lane < 2u; ++lane)
        for (pl_u32 bytes = 1u; bytes <= 8u; bytes *= 2u)
            for (pl_u32 sign = 0u; sign < 2u; ++sign)
                if (PL_OPCODE_REGION_LOAD[lane][bytes][sign] == opcode) {
                    *store = 0;
                    *width = bytes;
                    *fixed = 3u;
                    return 1;
                }
    return 0;
}

/* Move a single affine address constant into an access's offset. */
static void fold_memory_address(const pl_plan *rebuilt, pl_operand *argument,
                                pl_u32 count, int store, pl_u32 width)
{
    pl_u32 offset_at = store ? 2u : 1u;
    pl_u32 shape_at = offset_at + 1u;
    if (count <= shape_at || argument[offset_at].kind != PL_OPERAND_CONST
            || argument[shape_at].kind != PL_OPERAND_CONST)
        return;
    pl_u64 shape = argument[shape_at].value;
    if ((shape & ~(pl_u64)PL_MEMORY_SHAPE_MASK)
            || (shape & 0xffu) != width)
        return;

    /* A narrow store itself proves that only these low bits are observable;
     * retaining the same mask as a separate SSA lane is materialization, not
     * safety.  This is independent of the address spelling. */
    if (store) {
        const pl_node *masked = physical_form(rebuilt, argument[1]);
        if (masked && masked->opcode == PL_OPCODE_ALU_IMMEDIATE[1][0]
                && masked->argument_count == 2u) {
            const pl_operand *mask_arguments = physical_arguments(
                rebuilt, masked);
            pl_u64 mask = width == 8u ? ~0ull
                        : (1ull << (width * 8u)) - 1u;
            if (mask_arguments[1].kind == PL_OPERAND_CONST
                    && mask_arguments[1].value == mask)
                argument[1] = mask_arguments[0];
        }
    }

    if ((shape >> PL_MEMORY_SHAPE_SCALE_SHIFT)
            & PL_MEMORY_SHAPE_SCALE_MASK)
        return;

    const pl_node *address = physical_form(rebuilt, argument[0]);
    if (!address) return;
    pl_u32 lane = 0u, semantic = 0u;
    int immediate = 0;
    int add = arithmetic_opcode(
        address->opcode, &lane, &semantic, &immediate)
        && lane == 1u && semantic == 1u;
    int add3 = address->opcode == PL_OPCODE_ADD3[1];
    if ((!add && !add3) || (add && address->argument_count != 2u)
            || (add3 && address->argument_count != 3u))
        return;

    const pl_operand *parts = physical_arguments(rebuilt, address);
    pl_operand coordinate = { PL_OPERAND_CONST, 0u };
    pl_u64 displacement = 0u;
    pl_u32 coordinates = 0u;
    for (pl_u32 index = 0u; index < address->argument_count; ++index) {
        if (parts[index].kind == PL_OPERAND_CONST) {
            displacement += parts[index].value;
        } else {
            coordinate = parts[index];
            ++coordinates;
        }
    }
    if (coordinates != 1u) return;
    argument[0] = coordinate;
    argument[offset_at].value += displacement;
}

static void copy_plan_coordinates(const pl_plan *in, pl_plan *out)
{
    out->function = in->function;
    out->start = in->start;
    out->end = in->end;
    out->instructions = in->instructions;
    out->stack_inputs = in->stack_inputs;
    out->span = in->span;
}

int pl_fold_local_physical(const pl_plan *in, pl_arena *arena, pl_plan *out)
{
    if (!in || !arena || !out) return PL_ERROR_PLAN;
    pl_u32 count = in->node_count;
    pl_u8 *projected = pl_arena_take(arena, count + 1u);
    pl_u8 *consumed = pl_arena_take(arena, count + 1u);
    if (!projected || !consumed) return PL_ERROR_ARENA;
    for (pl_u32 index = 0u; index <= count; ++index)
        projected[index] = consumed[index] = 0u;

#define REMEMBER_PROJECTION(operand_) do {                                  \
        pl_operand remembered_ = (operand_);                                \
        if (remembered_.kind == PL_OPERAND_PROJECTION) {                    \
            pl_u64 source_ = remembered_.value >> PL_PROJECTION_SELECTOR_BITS; \
            if (source_ && source_ <= count) projected[source_] = 1u;       \
        }                                                                   \
    } while (0)
    for (pl_u32 index = 0u; index < in->argument_count; ++index)
        REMEMBER_PROJECTION(in->arguments[index]);
    for (pl_u32 index = 0u; index < in->stack_count; ++index)
        REMEMBER_PROJECTION(in->stack[index]);
    for (pl_u32 index = 0u; index < in->local_count; ++index)
        REMEMBER_PROJECTION(in->locals[index]);
#undef REMEMBER_PROJECTION
    for (pl_u32 index = 0u; index < in->argument_count; ++index) {
        pl_operand operand = in->arguments[index];
        if (operand.kind == PL_OPERAND_NODE && operand.value
                && operand.value <= count)
            consumed[operand.value] = 1u;
    }

    pl_remap remap;
    pl_builder builder;
    if (count > 0x3ffffffeu
            || in->argument_count > 0xffffffffu - count * 3u)
        return PL_ERROR_ARENA;
    pl_u32 overlay_nodes = count * 2u;
    pl_u32 overlay_entries = (overlay_nodes + 1u) * 2u;
    bit_overlay *overlay_form = pl_arena_take(
        arena, overlay_entries * (pl_u32)sizeof *overlay_form);
    pl_u8 *overlay_state = pl_arena_take(arena, overlay_entries);
    if (!overlay_form || !overlay_state) return PL_ERROR_ARENA;
    for (pl_u32 index = 0u; index < overlay_entries; ++index)
        overlay_state[index] = 0u;
    bit_overlay_cache overlay_cache = {
        overlay_form, overlay_state, overlay_nodes,
    };
    if (pl_remap_open(&remap, count, arena)
            || pl_builder_open(&builder, out, arena, count * 2u,
                               in->argument_count + count * 3u,
                               in->stack_count,
                               in->local_count))
        return PL_ERROR_ARENA;

    pl_operand staged[PL_STAGED_ARGUMENTS];
    for (pl_u32 index = 0u; index < count; ++index) {
        const pl_node *node = &in->nodes[index];
        if (node->argument_count > PL_STAGED_ARGUMENTS) return PL_ERROR_PLAN;
        for (pl_u32 slot = 0u; slot < node->argument_count; ++slot)
            staged[slot] = pl_resolve(
                &remap, in->arguments[node->argument_at + slot]);

        pl_u32 opcode = node->opcode;
        pl_u32 argument_count = node->argument_count;
        /* Sign-extended and unsigned literals with the same low word are
         * one operand class at a narrow comparison boundary. Preserve
         * the descriptor and prior flags, but erase the unobserved high bits
         * before instruction selection and sharing see those operands. */
        if ((opcode == PL_OPCODE_X86_TEST || opcode == PL_OPCODE_X86_COMPARE)
                && argument_count == 4u) {
            pl_operand descriptor = staged[argument_count - 1u];
            pl_u32 bits = (pl_u32)(descriptor.value & 0x7fu);
            if (descriptor.kind == PL_OPERAND_CONST
                    && (bits == 8u || bits == 16u || bits == 32u)) {
                pl_u64 word = (1ull << bits) - 1u;
                for (pl_u32 slot = 1u; slot <= 2u; ++slot)
                    if (staged[slot].kind == PL_OPERAND_CONST) staged[slot].value &= word;
            }
        }
        pl_operand replacement = { PL_OPERAND_CONST, 0u };
        int replace = 0;
        pl_u32 lane = 0u, semantic = 0u;
        int immediate = 0;
        pl_u32 input_bits = 0u, input_shift = 0u;
        pl_u32 input_lane = 0u, input_semantic = 0u;
        int input_immediate = 0;
        if (argument_count == 2u
                && arithmetic_opcode(
                    opcode, &input_lane, &input_semantic, &input_immediate)
                && input_lane == 0u) {
            staged[0] = low32_input(out, staged[0]);
            staged[1] = low32_input(out, staged[1]);
        } else if (argument_count == 2u
                && ((shift_opcode(opcode, &input_bits, &input_shift)
                     && input_bits == 32u)
                    || opcode == PL_OPCODE_LANE32_ROTL
                    || opcode == PL_OPCODE_LANE32_ROTR)) {
            staged[0] = low32_input(out, staged[0]);
        }
        if ((opcode == PL_OPCODE_LANE32_INSERT
                || opcode == PL_OPCODE_LANE64_INSERT)
                && argument_count == 3u
                && staged[2].kind == PL_OPERAND_CONST) {
            pl_u32 bits = opcode == PL_OPCODE_LANE32_INSERT ? 32u : 64u;
            pl_u64 descriptor = staged[2].value;
            pl_u32 field = (pl_u32)descriptor & 0xffu;
            pl_u32 offset = ((pl_u32)descriptor >> 8u) & 0xffu;
            if (!(descriptor >> 16u) && field && offset <= bits
                    && field <= bits - offset) {
                if (field == bits && !offset && !projected[index + 1u]) {
                    replacement = staged[1];
                    replace = 1;
                } else if (!offset && field
                        && staged[0].kind == PL_OPERAND_CONST
                        && staged[0].value == 0u
                        && operand_is_boolean(out, staged[1])
                        && !projected[index + 1u]) {
                    replacement = staged[1];
                    int fused = fuse_zero_extended_test_condition(
                        &builder, out, staged[1], &replacement);
                    if (fused < 0) return PL_ERROR_ARENA;
                    replace = 1;
                } else if (bits == 64u && field == 32u && !offset
                        && staged[0].kind == PL_OPERAND_CONST
                        && staged[0].value == 0u
                        && !projected[index + 1u]) {
                    int projected_low = project_low32(
                        &builder, out, staged[1], &replacement);
                    if (projected_low < 0) return PL_ERROR_ARENA;
                    replace = projected_low;
                } else {
                    const pl_node *base = physical_form(out, staged[0]);
                    if (base && base->opcode == opcode
                            && base->argument_count == 3u) {
                        const pl_operand *base_arguments =
                            physical_arguments(out, base);
                        if (base_arguments[2].kind == PL_OPERAND_CONST
                                && base_arguments[2].value == descriptor)
                            staged[0] = base_arguments[0];
                    }
                    /* A 64-bit insert whose complete publication is known to
                     * be in the low word is exactly the 32-bit primitive. */
                    base = physical_form(out, staged[0]);
                    if (bits == 64u && offset + field <= 32u && base
                            && base->opcode
                               == PL_OPCODE_ALU_IMMEDIATE[1][0]
                            && base->argument_count == 2u) {
                        const pl_operand *base_arguments =
                            physical_arguments(out, base);
                        if (base_arguments[1].kind == PL_OPERAND_CONST
                                && base_arguments[1].value == 0xffffffffu) {
                            staged[0] = base_arguments[0];
                            opcode = PL_OPCODE_LANE32_INSERT;
                        }
                    }
                }
            }
        }
        if (opcode == PL_OPCODE_X86_CONDITION && argument_count == 2u
                && !replace && !consumed[index + 1u]
                && !projected[index + 1u]
                && staged[0].kind == PL_OPERAND_NODE
                && staged[1].kind == PL_OPERAND_CONST
                && staged[1].value < 16u) {
            const pl_node *flags = physical_form(out, staged[0]);
            if (flags && projects_x86_condition(flags->opcode)) {
                replacement.kind = PL_OPERAND_PROJECTION;
                replacement.value = (staged[0].value
                                     << PL_PROJECTION_SELECTOR_BITS)
                                  | staged[1].value;
                replace = 1;
            }
        }

        pl_u32 shift_bits = 0u, shift_semantic = 0u;
        if (!replace && argument_count == 2u
                && staged[1].kind == PL_OPERAND_CONST
                && shift_opcode(opcode, &shift_bits, &shift_semantic)) {
            if (shift_semantic == 1u) {
                pl_operand unmasked;
                if (logical_shr_source_before_mask(
                        out, staged[0], shift_bits,
                        staged[1].value, &unmasked))
                    staged[0] = unmasked;
            }
            if (staged[0].kind == PL_OPERAND_CONST
                    && !projected[index + 1u]) {
                replacement.kind = PL_OPERAND_CONST;
                replacement.value = evaluate_shift(
                    shift_bits, shift_semantic,
                    staged[0].value, staged[1].value);
                replace = 1;
            }
        }
        if (!replace && !projected[index + 1u]) {
            int composed = compose_opposite_logical_shifts(
                &builder, out, opcode, staged, argument_count,
                &replacement);
            if (composed < 0) return PL_ERROR_ARENA;
            replace = composed;
        }
        if (!replace && !projected[index + 1u]) {
            int overlaid = canonical_bit_overlay(
                &builder, out, opcode, staged, argument_count,
                &overlay_cache, &replacement);
            if (overlaid < 0) return PL_ERROR_ARENA;
            replace = overlaid;
        }
        if (!replace && opcode == PL_OPCODE_X86_SHIFT_FLAGS
                && argument_count == 5u
                && staged[3].kind == PL_OPERAND_CONST
                && staged[4].kind == PL_OPERAND_CONST) {
            pl_u64 descriptor = staged[4].value;
            pl_u32 bits = (pl_u32)(descriptor & 0x7fu);
            pl_u32 group = (pl_u32)((descriptor >> 8u) & 7u);
            pl_operand unmasked;
            if ((bits == 32u || bits == 64u) && group == 5u
                    && descriptor == (pl_u64)(bits | (group << 8u))
                    && logical_shr_source_before_mask(
                        out, staged[1], bits,
                        staged[3].value, &unmasked))
                staged[1] = unmasked;
        }

        if (!replace && argument_count == 3u && !projected[index + 1u]
                && (opcode == PL_OPCODE_LANE32_SELECT || opcode == PL_OPCODE_LANE64_SELECT)) {
            pl_u32 bits = opcode == PL_OPCODE_LANE32_SELECT ? 32u : 64u;
            replace = collapse_zero_guarded_value(out, staged, bits, &replacement);
            if (!replace) {
                int projected_bit = selected_bit_projection(
                    &builder, out, staged, bits, &replacement);
                if (projected_bit < 0) return PL_ERROR_ARENA;
                replace = projected_bit;
            }
        }

        /* A CMOV-style conditional mask must not serialize every later mask
         * behind the accumulated value.  In the Boolean OR monoid,
         *
         *   select(x | m, x, p) = x | select(m, 0, p).
         *
         * The selected masks now depend only on their own predicates and can
         * occupy the same wave.  Compaction erases the superseded x|m node;
         * this pass retains no side table or alternate execution spelling. */
        if (!replace && argument_count == 3u
                && (opcode == PL_OPCODE_LANE32_SELECT
                    || opcode == PL_OPCODE_LANE64_SELECT)
                && staged[0].kind == PL_OPERAND_NODE) {
            pl_u32 masked_lane = 0u;
            pl_u64 mask = 0u;
            if (conditional_or_mask(
                    out, staged[0], staged[1], &masked_lane, &mask)) {
                pl_operand selected_arguments[3] = {
                    { PL_OPERAND_CONST, mask },
                    { PL_OPERAND_CONST, 0u },
                    staged[2],
                };
                pl_operand selected;
                int projected_bit = selected_bit_projection(&builder, out, selected_arguments,
                    opcode == PL_OPCODE_LANE32_SELECT ? 32u : 64u, &selected);
                if (projected_bit < 0) return PL_ERROR_ARENA;
                if (!projected_bit) {
                    pl_u32 value = pl_emit_shared(&builder, opcode, selected_arguments, 3u);
                    if (!value) return PL_ERROR_ARENA;
                    selected = (pl_operand){ PL_OPERAND_NODE, value };
                }
                opcode = PL_OPCODE_ALU_REGISTER[masked_lane][3u];
                staged[0] = staged[1];
                staged[1] = selected;
                argument_count = 2u;
            }
        }
        if (argument_count == 2u
                && !replace && arithmetic_opcode(
                    opcode, &lane, &semantic, &immediate)) {
            pl_u64 mask = lane_word_mask(lane);
            /* A commutative register form that acquired a constant through
             * substitution has the same canonical immediate spelling. */
            if (semantic != 2u)
                canonical_commutative(staged, 2u);
            if (semantic != 2u && staged[1].kind == PL_OPERAND_CONST) {
                opcode = PL_OPCODE_ALU_IMMEDIATE[lane][semantic];
                immediate = 1;
            }

            /* Subtraction by a constant and addition of its modular negative
             * are one affine coordinate. */
            if (semantic == 2u && staged[1].kind == PL_OPERAND_CONST) {
                staged[1].value = (0u - staged[1].value) & mask;
                semantic = 1u;
                opcode = PL_OPCODE_ALU_IMMEDIATE[lane][semantic];
                immediate = 1;
            }

            if (staged[0].kind == PL_OPERAND_CONST
                    && staged[1].kind == PL_OPERAND_CONST
                    && !projected[index + 1u]) {
                replacement.kind = PL_OPERAND_CONST;
                replacement.value = evaluate_arithmetic(
                    semantic, staged[0].value, staged[1].value, mask);
                replace = 1;
            } else if (!projected[index + 1u]
                    && (semantic == 2u || semantic == 4u)
                    && staged[0].kind == staged[1].kind
                    && staged[0].value == staged[1].value) {
                /* SUB(x,x) and XOR(x,x) have no residual input state.  This
                 * substitution is especially important when an x86 flag
                 * producer separately retains the original operands: the
                 * pure result becomes zero while the flag authority remains
                 * explicit, so every downstream affine/constant chain can
                 * fold without materializing x again. */
                replacement.kind = PL_OPERAND_CONST;
                replacement.value = 0u;
                replace = 1;
            } else if (lane == 1u && staged[1].kind == PL_OPERAND_CONST
                    && !projected[index + 1u]
                    && (((semantic == 1u || semantic == 3u || semantic == 4u)
                         && staged[1].value == 0u)
                        || (semantic == 0u && staged[1].value == mask))) {
                replacement = staged[0];
                replace = 1;
            }

            /* Close affine/logical constant chains.  The inner node is left
             * in the append-only prefix; compaction removes it when this was
             * its last observer. */
            if (!replace && immediate
                    && staged[1].kind == PL_OPERAND_CONST) {
                const pl_node *source = physical_form(out, staged[0]);
                pl_u32 source_lane = 0u, source_semantic = 0u;
                int source_immediate = 0;
                if (source && source->argument_count == 2u
                        && arithmetic_opcode(source->opcode, &source_lane,
                                             &source_semantic,
                                             &source_immediate)
                        && source_lane == lane && source_semantic == semantic
                        && source_immediate) {
                    const pl_operand *source_arguments =
                        physical_arguments(out, source);
                    if (source_arguments[1].kind == PL_OPERAND_CONST) {
                        pl_u64 combined = semantic == 0u
                            ? source_arguments[1].value & staged[1].value
                            : semantic == 3u
                            ? source_arguments[1].value | staged[1].value
                            : semantic == 4u
                            ? source_arguments[1].value ^ staged[1].value
                            : source_arguments[1].value + staged[1].value;
                        staged[0] = source_arguments[0];
                        staged[1].value = combined & mask;
                    }
                } else if (semantic == 1u && source
                        && source->opcode == PL_OPCODE_ALU_REGISTER[lane][1]
                        && source->argument_count == 2u) {
                    const pl_operand *source_arguments =
                        physical_arguments(out, source);
                    staged[2] = staged[1];
                    staged[0] = source_arguments[0];
                    staged[1] = source_arguments[1];
                    opcode = PL_OPCODE_ADD3[lane];
                    argument_count = 3u;
                } else if (semantic == 1u && source
                        && source->opcode == PL_OPCODE_ADD3[lane]
                        && source->argument_count == 3u) {
                    const pl_operand *source_arguments =
                        physical_arguments(out, source);
                    pl_u64 addend = staged[1].value;
                    pl_u32 constant_slot = 3u;
                    for (pl_u32 slot = 0u; slot < 3u; ++slot)
                        if (source_arguments[slot].kind == PL_OPERAND_CONST) {
                            constant_slot = slot;
                            break;
                        }
                    /* Only an ADD3 that already names a constant can absorb
                     * this addend.  Without one there is no third input to
                     * fold into, and rewriting the operands anyway would
                     * replace `ADD3(a,b,c) + k` with a two-input node over
                     * (a,b), dropping both c and k. */
                    if (constant_slot < 3u) {
                        for (pl_u32 slot = 0u; slot < 3u; ++slot)
                            staged[slot] = source_arguments[slot];
                        staged[constant_slot].value =
                            (staged[constant_slot].value + addend) & mask;
                        opcode = PL_OPCODE_ADD3[lane];
                        argument_count = 3u;
                    }
                }
            }

            /* Associativity must be closed from either side, not only when
             * the outer spelling happened to be an immediate add.  After
             * substitution, LEA base+index+disp commonly appears as
             *
             *     a + (b + k).
             *
             * Its unique physical value is ADD3(a,b,k).  Leaving the nested
             * pair costs an extra node/wave and prevents the native selector
             * from emitting the one-instruction LEA which attains the proved
             * minimum. */
            if (!replace && argument_count == 2u
                    && semantic == 1u && !immediate) {
                for (pl_u32 inner = 0u; inner < 2u; ++inner) {
                    const pl_node *source =
                        physical_form(out, staged[inner]);
                    pl_u32 source_lane = 0u, source_semantic = 0u;
                    int source_immediate = 0;
                    if (!source || source->argument_count != 2u
                            || !arithmetic_opcode(
                                source->opcode, &source_lane,
                                &source_semantic, &source_immediate)
                            || source_lane != lane
                            || source_semantic != semantic)
                        continue;
                    const pl_operand *source_arguments =
                        physical_arguments(out, source);
                    staged[2] = staged[inner ^ 1u];
                    staged[0] = source_arguments[0];
                    staged[1] = source_arguments[1];
                    opcode = PL_OPCODE_ADD3[lane];
                    argument_count = 3u;
                    break;
                }
            }

            /* Work backward through the already rebuilt prefix.  This turns
             * (x + y - z) - x into y - z before register allocation, so the
             * same source lane is not computed twice merely to recover a
             * value that substitution has already exposed. */
            if (!replace && !projected[index + 1u]) {
                int cancelled = cancelled_linear_binary(
                    &builder, out, opcode, staged, argument_count,
                    &replacement);
                if (cancelled < 0) return PL_ERROR_ARENA;
                replace = cancelled;
            }

            /* Chain substitution can create an identity after the earlier
             * identity check has already run, notably
             *
             *     (x - k) + k -> (x + -k) + k -> x + 0 -> x.
             *
             * Close it in the same sweep so liveness never has to retain a
             * zero-work node merely to reach another rewrite iteration. */
            if (!replace && argument_count == 2u && lane == 1u
                    && staged[1].kind == PL_OPERAND_CONST
                    && (((semantic == 1u || semantic == 3u
                          || semantic == 4u) && !staged[1].value)
                        || (semantic == 0u
                            && staged[1].value == mask))) {
                replacement = staged[0];
                replace = 1;
            }
        }

        if (!replace && argument_count == 3u
                && (opcode == PL_OPCODE_ADD3[0]
                    || opcode == PL_OPCODE_ADD3[1])) {
            canonical_commutative(staged, 3u);
            /* The carry expansion can directly create ADD3(a,CF,0).
             * Its identity leaf must disappear in the shared normal form,
             * before a backend needs to recognize the surviving binary sum. */
            if (!projected[index + 1u])
                for (pl_u32 slot = 0u; slot < 3u; ++slot)
                    if (staged[slot].kind == PL_OPERAND_CONST && !staged[slot].value) {
                        pl_u32 add_lane = opcode == PL_OPCODE_ADD3[1];
                        for (pl_u32 next = slot + 1u; next < 3u; ++next)
                            staged[next - 1u] = staged[next];
                        opcode = staged[1].kind == PL_OPERAND_CONST
                            ? PL_OPCODE_ALU_IMMEDIATE[add_lane][1]
                            : PL_OPCODE_ALU_REGISTER[add_lane][1];
                        argument_count = 2u;
                        break;
                    }
        }
        if (!replace && argument_count == 2u
                && (opcode == PL_OPCODE_MULR
                    || opcode == PL_OPCODE_LANE32_MULR))
            canonical_commutative(staged, 2u);

        int store = 0;
        pl_u32 width = 0u, fixed = 0u;
        if (!replace && ordinary_memory_opcode(
                opcode, &store, &width, &fixed)
                && argument_count >= fixed)
            fold_memory_address(
                out, staged, argument_count, store, width);

        if (replace) {
            remap.of[index + 1u] = replacement;
            continue;
        }
        pl_u32 value = pl_emit_shared(
            &builder, opcode, staged, argument_count);
        if (!value) return PL_ERROR_ARENA;
        remap.of[index + 1u].kind = PL_OPERAND_NODE;
        remap.of[index + 1u].value = value;
    }

    for (pl_u32 index = 0u; index < in->stack_count; ++index)
        out->stack[index] = pl_resolve(&remap, in->stack[index]);
    for (pl_u32 index = 0u; index < in->local_count; ++index)
        out->locals[index] = pl_resolve(&remap, in->locals[index]);
    copy_plan_coordinates(in, out);
    return 0;
}


/* Restore pointer flow while a larger memory transaction is being composed.
 *
 * A chain of pre_stores against one base decrements a cumulative offset.  Once
 * blocks are composed, a later store in the chain can take the earlier store as
 * its base and carry only the difference, which is what puts the pointer flow
 * back into the graph instead of leaving each store to recompute it.
 *
 * Shape A: arguments are rewritten in place and node values are preserved.
 */
int pl_reopen_pre_store_chains(const pl_plan *in, pl_arena *arena,
                               pl_plan *out)
{
    *out = *in;
    out->arguments = pl_arena_take(
        arena, (in->argument_count ? in->argument_count : 1u)
               * (pl_u32)sizeof *out->arguments);
    if (!out->arguments) return PL_ERROR_ARENA;
    for (pl_u32 index = 0; index < in->argument_count; ++index)
        out->arguments[index] = in->arguments[index];

    /* One entry per distinct (base, shape); the chain is short, so a linear
     * scan costs less than an index. */
    pl_u32 *group_node = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_node);
    pl_u64 *group_cumulative = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_cumulative);
    pl_operand *group_base = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_base);
    pl_u64 *group_shape = pl_arena_take(
        arena, (in->node_count ? in->node_count : 1u)
               * (pl_u32)sizeof *group_shape);
    if (!group_node || !group_cumulative || !group_base || !group_shape)
        return PL_ERROR_ARENA;
    pl_u32 groups = 0;

    for (pl_u32 index = 0; index < in->node_count; ++index) {
        const pl_node *node = &in->nodes[index];
        if (node->opcode != PL_OPCODE_MEMORY_PRE_STORE
                || node->argument_count != 4u)
            continue;
        const pl_operand *argument = &in->arguments[node->argument_at];
        pl_operand base = argument[0];
        pl_operand decrement = argument[2];
        pl_operand shape = argument[3];
        if (decrement.kind != PL_OPERAND_CONST
                || shape.kind != PL_OPERAND_CONST)
            continue;

        /* decode_memory_shape, which rejects unknown flags rather than
         * masking them away. */
        if (shape.value & ~(pl_u64)PL_MEMORY_SHAPE_MASK) continue;
        pl_u64 width = shape.value & 0xffu;
        pl_u64 scale = (shape.value >> PL_MEMORY_SHAPE_SCALE_SHIFT)
                     & PL_MEMORY_SHAPE_SCALE_MASK;
        int virtual64 = (shape.value & PL_MEMORY_SHAPE_VIRTUAL64) != 0;
        pl_u64 cumulative = decrement.value;

        pl_u32 found = groups;
        for (pl_u32 slot = 0; slot < groups; ++slot)
            if (group_base[slot].kind == base.kind
                    && group_base[slot].value == base.value
                    && group_shape[slot] == shape.value) {
                found = slot;
                break;
            }
        if (found < groups && virtual64 && !scale
                && cumulative > group_cumulative[found]
                && width <= cumulative - group_cumulative[found]) {
            out->arguments[node->argument_at].kind = PL_OPERAND_NODE;
            out->arguments[node->argument_at].value = group_node[found];
            out->arguments[node->argument_at + 2u].kind = PL_OPERAND_CONST;
            out->arguments[node->argument_at + 2u].value =
                cumulative - group_cumulative[found];
        }
        if (found == groups) {
            if (groups >= in->node_count) return PL_ERROR_PLAN;
            group_base[groups] = base;
            group_shape[groups] = shape.value;
            groups += 1u;
        }
        group_node[found] = index + 1u;
        group_cumulative[found] = cumulative;
    }
    return 0;
}

/* TODO: the remaining pre-passes and the main sweep.
 *
 * Measured over 299 composed pairs of the shipped artifact, by how often each
 * changes the graph:
 *
 *     rebase_overwritten_flags     63   implemented above
 *     reopen_consumed_x86_alu      15   149 lines
 *     reopen_load_regions           6    69 lines
 *     reopen_pre_store_chains       3    33 lines
 *     forward_memory_versions       0   190 lines
 *     rewrite_relative_exchange     0   277 lines
 *     the main sweep               27   ~800 lines
 *
 * The two that never fire are left unwritten rather than guessed at.  A parity
 * that ever sees them matter will disagree, which is the intended signal: they
 * are absent, not assumed unnecessary.
 */
