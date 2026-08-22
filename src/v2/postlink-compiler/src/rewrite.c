/* Algebraic rewriting, the pre-passes.
 *
 * _rewrite_physical in qm/stepnormalize.py is six pre-passes followed by one
 * main sweep.  The main sweep already substitutes successively in dependency
 * order, so it converges in a single pass; the iteration the reference shows
 * comes from the pre-passes, and specifically from running
 * reopen_consumed_x86_alu before rebase_overwritten_flags.  The rebase creates
 * the selector-16 projections the reopen looks for, so ordered that way the
 * reopen misses them and finds them only on a later evaluation.
 *
 * The order here is therefore the corrected one, measured to reach the same
 * fixed point on all 299 composed pairs while dropping the third evaluation to
 * none.  See the README.
 *
 * Freestanding: no libc, no allocation.
 */

#include <postlink/sweep.h>

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
 * The Python reference's main sweep is deliberately broad, but its dominant
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
    if (in->argument_count > 0xffffffffu - count)
        return PL_ERROR_ARENA;
    if (pl_remap_open(&remap, count, arena)
            || pl_builder_open(&builder, out, arena, count,
                               in->argument_count + count, in->stack_count,
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
        pl_operand replacement = { PL_OPERAND_CONST, 0u };
        int replace = 0;
        pl_u32 lane = 0u, semantic = 0u;
        int immediate = 0;
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
        if (argument_count == 2u
                && !replace && arithmetic_opcode(
                    opcode, &lane, &semantic, &immediate)) {
            pl_u64 mask = lane_word_mask(lane);
            /* A commutative register form that acquired a constant through
             * substitution has the same canonical immediate spelling. */
            if (semantic != 2u && staged[0].kind == PL_OPERAND_CONST
                    && staged[1].kind != PL_OPERAND_CONST) {
                pl_operand swap = staged[0];
                staged[0] = staged[1];
                staged[1] = swap;
            }
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
                    pl_u32 constants = 0u;
                    for (pl_u32 slot = 0u; slot < 3u; ++slot) {
                        staged[slot] = source_arguments[slot];
                        if (staged[slot].kind == PL_OPERAND_CONST) {
                            staged[slot].value =
                                (staged[slot].value + addend) & mask;
                            ++constants;
                            break;
                        }
                    }
                    if (constants) {
                        opcode = PL_OPCODE_ADD3[lane];
                        argument_count = 3u;
                    }
                }
            }
        }

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
