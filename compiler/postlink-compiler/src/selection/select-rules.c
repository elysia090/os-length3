/* select-rules: native x86 selection. */
#include "select-rules.h"
#include "limits.h"
#include "encoding.h"
#include "expressions.h"
#include "flags.h"
#include "operands.h"
#include "simple-frame.h"
#include "tree-measure.h"
#include "tree-write.h"

static pl_u32 test_byte_coordinate(const pl_plan *plan, pl_operand *left,
                                   pl_operand right, pl_u32 bits, pl_u32 test);

static int emit_bit_test_register(pl_u32 base, pl_operand offset, pl_u32 bits,
                                  pl_u8 *output, pl_u32 *written);

static int conditional_entry_local(const pl_plan *plan, pl_operand value,
                                    pl_u32 bits, pl_u32 *local);

static int conditional_published_local(const pl_plan *plan, pl_operand value,
    pl_u32 bits, pl_u32 *local);

static void conditional_prefer_published_generation(
    const pl_plan *plan, pl_operand value, pl_u32 bits,
    pl_u32 destination, int *entry, pl_u32 *local);

/* A partial-width ALU instruction may consume the low byte of an entry word
 * after that word has been copied with a 32-bit move, while the entry owner is
 * independently overwritten.  Keeping the normalized value and exact flag
 * producer separate otherwise materializes a 64-bit mask in that owner:
 *
 *   zext32(source); low8-op immediate; source = constant.
 *
 * The first move feeds both the byte operation and the anti-dependency on the
 * source overwrite.  Consequently the byte operation and the overwrite share
 * the second wave. */
int pl_select_narrow_flag_transfer_shape(
    const pl_x86_block *block, narrow_flag_transfer *out)
{
    static const pl_u8 semantic_for_mode[7] = {
        0u, 255u, 255u, 255u, 255u, 3u, 4u,
    };
    if (!block || !out || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    if (!pl_select_alu_frame_shape(plan, &changed, &final_flag_node)) return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count
            || flags.value != final_flag_node)
        return 0;
    const pl_node *flag_node = &plan->nodes[flags.value - 1u];
    if (flag_node->opcode != PL_OPCODE_X86_FLAGS
            || flag_node->argument_count != 5u
            || flag_node->argument_at > plan->argument_count
            || flag_node->argument_count
               > plan->argument_count - flag_node->argument_at)
        return 0;
    const pl_operand *argument =
        plan->arguments + flag_node->argument_at;
    if (argument[1].kind != PL_OPERAND_NODE
            || argument[2].kind != PL_OPERAND_CONST
            || argument[3].kind != PL_OPERAND_NODE
            || !argument[3].value || argument[3].value > plan->node_count
            || argument[4].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 bits = (pl_u32)(descriptor & 0x7fu);
    pl_u32 mode = (pl_u32)((descriptor >> 8u) & 7u);
    if (bits != 8u || mode > 6u || semantic_for_mode[mode] == 255u
            || descriptor != (pl_u64)(bits | (mode << 8u)))
        return 0;
    pl_u32 source = 0u, source_bits = 0u;
    if (!pl_select_zero_extend_node(
            plan, (pl_u32)argument[1].value, &source, &source_bits)
            || source_bits != 32u)
        return 0;

    const pl_node *result = &plan->nodes[argument[3].value - 1u];
    if (result->opcode
            != PL_OPCODE_ALU_IMMEDIATE[0][semantic_for_mode[mode]]
            || result->argument_count != 2u
            || result->argument_at > plan->argument_count
            || result->argument_count
               > plan->argument_count - result->argument_at)
        return 0;
    const pl_operand *result_argument =
        plan->arguments + result->argument_at;
    int exact_base = result_argument[0].kind == argument[1].kind
                  && result_argument[0].value == argument[1].value;
    int physical_base = result_argument[0].kind == PL_OPERAND_LOCAL
                     && result_argument[0].value == source;
    if ((!exact_base && !physical_base)
            || result_argument[1].kind != PL_OPERAND_CONST
            || (pl_u32)result_argument[1].value
               != (pl_u32)argument[2].value)
        return 0;

    pl_u64 low_mask = 0xffu;
    pl_u64 immediate = argument[2].value & low_mask;
    pl_u64 expected = mode == 0u
        ? ((0xffffffffu & ~low_mask) | immediate) : immediate;
    pl_u32 destination = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        if (local == source) {
            if (value.kind != PL_OPERAND_CONST) return 0;
            continue;
        }
        pl_operand left, right;
        pl_u32 value_bits = 0u, value_mode = 0u;
        if (!pl_select_arithmetic_tree_details(
                plan, value, &left, &right,
                &value_bits, &value_mode)) {
            if (value.kind != PL_OPERAND_LOCAL || value.value != local)
                return 0;
            continue;
        }
        if (destination < PL_X86_GPR_COUNT || value_mode != mode
                || (value_bits != 32u && value_bits != 64u))
            return 0;
        if (left.kind == PL_OPERAND_CONST) {
            pl_operand swap = left; left = right; right = swap;
        }
        int base_is_source = left.kind == PL_OPERAND_LOCAL
                          && left.value == source;
        int base_is_extended = left.kind == argument[1].kind
                            && left.value == argument[1].value;
        if (right.kind != PL_OPERAND_CONST || right.value != expected
                || (!base_is_extended
                    && !(base_is_source
                         && (value_bits == 32u || mode == 0u))))
            return 0;
        destination = local;
    }
    if (destination >= PL_X86_GPR_COUNT || destination == source)
        return 0;
    out->destination = destination;
    out->source = source;
    out->mode = mode;
    out->right = (pl_operand){ PL_OPERAND_CONST, immediate };
    out->source_publication = plan->locals[source];
    return 1;
}

int pl_select_measure_narrow_flag_transfer(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    const narrow_flag_transfer *shape)
{
    if (!frontend || !block || !selection || !shape) return 0;
    pl_u32 bytes = 0u, part = 0u;
    if (!pl_select_emit_zero_extend_move(
            shape->destination, shape->source, 32u,
            (pl_u8 *)0, &part))
        return 0;
    bytes += part;
    if (!pl_select_emit_low8_alu_flags(
            shape->destination, shape->right, shape->mode,
            (pl_u8 *)0, &part)
            || bytes > U32_MAX_VALUE - part)
        return 0;
    bytes += part;
    int measured = pl_select_measure_frame_value(
        frontend, block, selection, shape->source,
        shape->source_publication, bytes, &part);
    if (measured <= 0 || bytes > U32_MAX_VALUE - part)
        return measured < 0 ? measured : 0;
    selection->output_bytes = bytes + part;
    selection->output_instructions = 3u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_nested_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_independent_flag_overwrite_shape(
    const pl_plan *plan, independent_flag_overwrite *out)
{
    static const pl_u8 semantic_for_mode[7] = {
        0u, 1u, 255u, 2u, 255u, 3u, 4u,
    };
    if (!plan || !out || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count)
        return 0;
    const pl_node *flag_node = &plan->nodes[flags.value - 1u];
    if (flag_node->opcode != PL_OPCODE_X86_FLAGS
            || flag_node->argument_count != 5u
            || flag_node->argument_at > plan->argument_count
            || flag_node->argument_count
               > plan->argument_count - flag_node->argument_at)
        return 0;
    const pl_operand *argument =
        plan->arguments + flag_node->argument_at;
    if (argument[1].kind != PL_OPERAND_LOCAL
            || argument[1].value >= PL_X86_GPR_COUNT
            || argument[2].kind != PL_OPERAND_CONST
            || argument[3].kind != PL_OPERAND_NODE
            || !argument[3].value || argument[3].value > plan->node_count
            || argument[4].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 bits = (pl_u32)(descriptor & 0x7fu);
    pl_u32 mode = (pl_u32)((descriptor >> 8u) & 7u);
    if (bits != 8u || mode > 6u || semantic_for_mode[mode] == 255u
            || descriptor != (pl_u64)(bits | (mode << 8u)))
        return 0;
    const pl_node *result = &plan->nodes[argument[3].value - 1u];
    if (result->opcode
            != PL_OPCODE_ALU_IMMEDIATE[0][semantic_for_mode[mode]]
            || result->argument_count != 2u
            || result->argument_at > plan->argument_count
            || result->argument_count
               > plan->argument_count - result->argument_at)
        return 0;
    const pl_operand *result_argument =
        plan->arguments + result->argument_at;
    if (result_argument[0].kind != argument[1].kind
            || result_argument[0].value != argument[1].value
            || result_argument[1].kind != PL_OPERAND_CONST
            || (pl_u8)result_argument[1].value != (pl_u8)argument[2].value)
        return 0;
    pl_u32 destination = (pl_u32)argument[1].value;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (local == destination) {
            if (value.kind == PL_OPERAND_LOCAL && value.value == local)
                return 0;
        } else if (value.kind != PL_OPERAND_LOCAL || value.value != local) {
            return 0;
        }
    }
    if (!pl_select_scaled_lea_node_details(
            plan, plan->locals[destination], &out->value_source,
            &out->value_bits, &out->scale_log2)
            || out->value_source == destination)
        return 0;
    out->destination = destination;
    out->mode = mode;
    out->right = argument[2];
    out->right.value &= 0xffu;
    return 1;
}

int pl_select_condition_value_details(const pl_plan *plan, pl_operand value,
                                   condition_value *out)
{
    if (!plan || !out || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode != PL_OPCODE_X86_CONDITION
            || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[1].kind != PL_OPERAND_CONST || argument[1].value > 15u)
        return 0;
    out->flags = argument[0];
    out->condition = (pl_u32)argument[1].value;
    return 1;
}

int pl_select_flag_operation_details(const pl_plan *plan, pl_operand flags,
                                  pl_operand *left, pl_operand *right,
                                  pl_u32 *bits, pl_u32 *mode,
                                  pl_u32 *preserves_carry)
{
    if (!plan || !left || !right || !bits || !mode || !preserves_carry
            || flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[flags.value - 1u];
    if ((node->opcode != PL_OPCODE_X86_TEST
            && node->opcode != PL_OPCODE_X86_COMPARE
            && node->opcode != PL_OPCODE_X86_ALU
            && node->opcode != PL_OPCODE_X86_FLAGS)
            || node->argument_count
               != (node->opcode == PL_OPCODE_X86_FLAGS ? 5u : 4u)
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    pl_u32 descriptor_at = node->opcode == PL_OPCODE_X86_FLAGS ? 4u : 3u;
    if (argument[descriptor_at].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[descriptor_at].value;
    *bits = (pl_u32)(descriptor & 0x7fu);
    *mode = (pl_u32)((descriptor >> 8u) & 7u);
    *preserves_carry = (pl_u32)((descriptor >> 11u) & 1u);
    if ((*bits != 8u && *bits != 16u
            && *bits != 32u && *bits != 64u)
            || descriptor != ((pl_u64)*bits | ((pl_u64)*mode << 8u)
                | ((pl_u64)*preserves_carry << 11u))
            || (node->opcode == PL_OPCODE_X86_TEST && *mode != 0u)
            || (node->opcode == PL_OPCODE_X86_COMPARE && *mode != 3u)
            || (node->opcode != PL_OPCODE_X86_ALU && *preserves_carry))
        return 0;
    *left = argument[1];
    *right = argument[2];
    return 1;
}

/* X86_FLAGS keeps the exact pre-normalization operands beside the normalized
 * result.  When that result is also a GPR publication, its one destructive
 * ALU instruction is the unique physical producer of both publications.
 * Re-emitting the value as LEA would preserve the numeric result but silently
 * drop RFLAGS; emitting a separate flag instruction would add avoidable work.
 */
int pl_select_flag_value_operation_details(
    const pl_plan *plan, pl_u32 flag_node, pl_operand value,
    pl_operand *left, pl_operand *right, pl_u32 *bits,
    pl_u32 *mode, pl_u32 *preserves_carry)
{
    if (!plan || !flag_node || flag_node > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[flag_node - 1u];
    if (node->opcode != PL_OPCODE_X86_FLAGS
            || node->argument_count != 5u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[3].kind != value.kind
            || argument[3].value != value.value)
        return 0;
    pl_operand flags = { PL_OPERAND_NODE, flag_node };
    return pl_select_flag_operation_details(
        plan, flags, left, right, bits, mode, preserves_carry);
}

/* An in-place lane insert `insert(base, value, width)` whose inserted value is
 * the final flag result is a partial-width publication of that result: the
 * emitted byte/word ALU writes only the low lane and reads the base tree.
 * Rewriting the publication to the inserted value lets the ordinary flag
 * branch emit it (base included), while `pl_select_publication_is_flag_result` already
 * carries the flag provenance.  Returns `value` unchanged otherwise. */
pl_operand pl_select_publication_for_emission(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 flag_node)
{
    if (!plan || !flag_node || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count)
        return value;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != 198u && node->opcode != 201u)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return value;
    pl_operand inserted = plan->arguments[node->argument_at + 1u];
    pl_operand base = plan->arguments[node->argument_at];
    pl_operand width_operand = plan->arguments[node->argument_at + 2u];
    if (width_operand.kind != PL_OPERAND_CONST)
        return value;
    /* A zero-based insert narrower than its destination lane is a real
     * truncation even when the inserted value also produces the final flags.
     * In particular insert64(0, SAR64(x, 3), 32) must publish the zeroed
     * upper half before a later 64-bit multiply reads it. */
    if (base.kind == PL_OPERAND_CONST && !base.value
            && ((node->opcode == PL_OPCODE_LANE64_INSERT
                    && width_operand.value <= 32u)
                || (node->opcode == PL_OPCODE_LANE32_INSERT
                    && width_operand.value < 32u)))
        return value;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (pl_select_flag_value_operation_details(
            plan, flag_node, inserted, &left, &right, &bits, &mode,
            &preserves_carry))
        return inserted;
    return value;
}

/* A byte/word ALU changes only the destination's low lane. If its SSA
 * publication preserves another entry register's upper bits, copy that
 * full base first. The narrow operation can then consume the copied lane.
 * A self-XOR has no low-lane dependency, but still has this upper-bit one.
 * Decline shapes whose right entry operand the base copy would overwrite. */
int pl_select_prepare_partial_flag_publication(
    const pl_plan *plan, pl_operand publication, pl_u32 destination,
    pl_u32 bits, pl_operand *left, pl_operand *right,
    pl_u8 *output, pl_u32 *bytes, pl_u32 *work)
{
    *bytes = 0u;
    *work = 0u;
    if (publication.kind != PL_OPERAND_NODE || !publication.value
            || publication.value > plan->node_count)
        return 1;
    const pl_node *node = &plan->nodes[publication.value - 1u];
    if (node->opcode != PL_OPCODE_LANE64_INSERT
            && node->opcode != PL_OPCODE_LANE32_INSERT)
        return 1;
    if (node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    pl_operand base = argument[0];
    if ((bits != 8u && bits != 16u)
            || argument[2].kind != PL_OPERAND_CONST
            || argument[2].value != bits
            || base.kind != PL_OPERAND_LOCAL
            || base.value >= PL_X86_GPR_COUNT
            || left->kind != base.kind || left->value != base.value)
        return 0;
    if (base.value == destination) return 1;
    if (right->kind == PL_OPERAND_LOCAL && right->value == destination)
        return 0;
    pl_u32 base_bits = node->opcode == PL_OPCODE_LANE64_INSERT ? 64u : 32u;
    if (!pl_select_emit_gpr_move(destination, (pl_u32)base.value, base_bits,
            output, bytes))
        return 0;
    if (right->kind == base.kind && right->value == base.value)
        right->value = destination;
    left->value = destination;
    *work = 1u;
    return 1;
}

/* A `lane{32,64}.insert(base, value, width)` whose base is the published local
 * itself is an in-place low-lane write: it preserves the base's upper bits and
 * replaces the low `width` bits from `value`.  The inserted node carries a
 * full-width lane op, so the emitter must apply it at the insert's width, not
 * the node's own expression width. */
int pl_select_in_place_lane_insert(const pl_plan *plan, pl_operand value,
                                pl_u32 local, pl_operand *inner,
                                pl_u32 *width)
{
    if (!plan || !inner || !width || local >= PL_X86_GPR_COUNT
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != 198u && node->opcode != 201u)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value != local
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    /* Measured physical vocabulary: lane {and,or,xor,add} are 6,7,8,9 and
     * their lane64 forms 76,77,78,79.  Only a lane ALU op can be applied at an
     * arbitrary width; any other inserted node needs its own production, and
     * falling through keeps selection total instead of aborting it. */
    if (arguments[1].kind != PL_OPERAND_NODE || !arguments[1].value
            || arguments[1].value > plan->node_count)
        return 0;
    pl_u32 opcode = plan->nodes[arguments[1].value - 1u].opcode;
    if (opcode != 6u && opcode != 7u && opcode != 8u && opcode != 9u
            && opcode != 76u && opcode != 77u && opcode != 78u
            && opcode != 79u)
        return 0;
    *inner = arguments[1];
    *width = (pl_u32)arguments[2].value;
    return 1;
}

/* `insert(local, condition, 8)` with base == destination is a SETcc into the
 * low byte; the base's upper bits survive, which is exactly the insert
 * semantics.  Emitting it keeps the condition's flag read before the block's
 * later flag producer (see publication_reads_entry_flags). */
int pl_select_in_place_condition_insert(const pl_plan *plan, pl_operand value,
                                     pl_u32 local, pl_u32 *condition)
{
    if (!plan || !condition || local >= PL_X86_GPR_COUNT
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != PL_OPCODE_LANE64_INSERT
                && node->opcode != PL_OPCODE_LANE32_INSERT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value != local
            || arguments[2].kind != PL_OPERAND_CONST
            || arguments[2].value != 8u)
        return 0;
    condition_value detail;
    if (!pl_select_condition_value_details(plan, arguments[1], &detail)
            /* Only an entry-flags condition can be materialized here: its
             * producer is outside the block, so the SETcc can be ordered before
             * every in-block flag writer.  An in-block producer needs its own
             * scheduling edge, which publication_reads_entry_flags does not
             * provide. */
            || detail.flags.kind != PL_OPERAND_LOCAL
            || detail.flags.value != PL_X86_RFLAGS_LOCAL)
        return 0;
    *condition = detail.condition;
    return 1;
}

/* `insert(base, constant, 8|16)` replaces the low lane of `base` with a
 * constant.  With base == destination it is one lane-width constant move
 * (`xor al,al`); otherwise the caller first materializes the base into the
 * destination.  A 32-bit insert would also have to preserve the base's upper
 * word, which a 32-bit move does not, so it stays out of this production. */
int pl_select_lane_constant_insert(const pl_plan *plan, pl_operand value,
                                pl_u32 local, pl_operand *base,
                                pl_u64 *constant, pl_u32 *width)
{
    if (!plan || !base || !constant || !width || local >= PL_X86_GPR_COUNT
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != PL_OPCODE_LANE64_INSERT
                && node->opcode != PL_OPCODE_LANE32_INSERT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if ((arguments[0].kind != PL_OPERAND_LOCAL
                && arguments[0].kind != PL_OPERAND_NODE
                && arguments[0].kind != PL_OPERAND_PROJECTION)
            || (arguments[0].kind == PL_OPERAND_LOCAL
                && arguments[0].value >= PL_X86_GPR_COUNT)
            || arguments[1].kind != PL_OPERAND_CONST
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u))
        return 0;
    *base = arguments[0];
    *constant = arguments[1].value;
    *width = (pl_u32)arguments[2].value;
    return 1;
}

/* TEST observes one byte and its own byte-sized SF/PF/ZF. Replacing it with
 * a wider shifted mask would change parity. Keep the observation width and
 * substitute the byte's physical coordinate instead of computing a shift. */
static pl_u32 test_byte_coordinate(const pl_plan *plan, pl_operand *left,
                                   pl_operand right, pl_u32 bits, pl_u32 test)
{
    pl_operand source, amount;
    pl_u32 width = 0u, group = 0u;
    if (!test || bits != 8u || right.kind != PL_OPERAND_CONST || right.value > 255u
            || !pl_select_shift_node_details(plan, *left, &source, &amount, &width, &group)
            || (width != 32u && width != 64u) || group != 5u
            || amount.kind != PL_OPERAND_CONST || amount.value != 8u) return 0u;
    *left = source;
    return 8u;
}

int pl_select_emit_flag_coordinate(pl_u32 left, pl_operand right, pl_u32 bits,
                                 pl_u32 test, pl_u32 offset,
                                 pl_u8 *output, pl_u32 *written)
{
    if (offset) return offset == 8u && bits == 8u && test
        && pl_select_emit_high8_test(left, right, output, written);
    return test ? pl_select_emit_test_operand(left, right, bits, output, written)
                : pl_select_emit_compare_operand(left, right, bits, output, written);
}

/* TEST and CMP can be the sole final RFLAGS publication without publishing a
 * GPR result.  Keep that instruction explicit: all earlier flag-clobbering
 * work must finish first, while its entry operands must remain live until it
 * is emitted.  Exact saved owners may replace those entry coordinates. */
int pl_select_standalone_flag_publication_details(
    const pl_plan *plan, pl_u32 node_number,
    standalone_flag_publication *out)
{
    if (!plan || !out || !node_number || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode == PL_OPCODE_X86_BIT_FLAGS) {
        if (node->argument_count != 4u
                || node->argument_at > plan->argument_count
                || 4u > plan->argument_count - node->argument_at)
            return 0;
        const pl_operand *argument = plan->arguments + node->argument_at;
        if (argument[3].kind != PL_OPERAND_CONST
                || (argument[3].value != 32u && argument[3].value != 64u))
            return 0;
        /* BIT_FLAGS is (prior, base, offset, width).  The two register
         * operands are not interchangeable: BT writes CF from base[offset]. */
        const pl_u32 base_at = 1u, offset_at = 2u;
        pl_operand base = argument[base_at];
        pl_operand offset = argument[offset_at];
        pl_select_physicalize_published_operand(plan, PL_X86_GPR_COUNT, &base);
        pl_select_physicalize_published_operand(plan, PL_X86_GPR_COUNT, &offset);
        if (base.kind != PL_OPERAND_LOCAL || base.value >= PL_X86_GPR_COUNT
                || (offset.kind != PL_OPERAND_LOCAL
                    && offset.kind != PL_OPERAND_CONST))
            return 0;
        out->bit_test = 1u;
        out->test = 0u;
        out->offset = 0u;
        out->bits = (pl_u32)argument[3].value;
        out->left = (pl_u32)base.value;
        out->right = offset;
        out->entry_sources = 0u;
        out->owner_dependencies = 0u;
        if (argument[base_at].kind == PL_OPERAND_LOCAL
                && argument[base_at].value == base.value)
            out->entry_sources |= 1u << out->left;
        else
            out->owner_dependencies |= 1u << out->left;
        if (offset.kind == PL_OPERAND_LOCAL) {
            if (argument[offset_at].kind == PL_OPERAND_LOCAL
                    && argument[offset_at].value == offset.value)
                out->entry_sources |= 1u << (pl_u32)offset.value;
            else
                out->owner_dependencies |= 1u << (pl_u32)offset.value;
        }
        return 1;
    }
    if (node->opcode != PL_OPCODE_X86_TEST
            && node->opcode != PL_OPCODE_X86_COMPARE)
        return 0;
    out->bit_test = 0u;
    pl_operand flags = { PL_OPERAND_NODE, node_number };
    pl_operand left, right;
    pl_u32 mode = 0u, preserves_carry = 0u;
    if (!pl_select_flag_operation_details(
            plan, flags, &left, &right, &out->bits,
            &mode, &preserves_carry))
        return 0;
    out->test = (pl_u32)(node->opcode == PL_OPCODE_X86_TEST);
    out->offset = test_byte_coordinate(plan, &left, right, out->bits, out->test);
    pl_operand *input[2] = { &left, &right };
    for (pl_u32 i = 0u; i < 2u; ++i) {
        pl_operand value = *input[i];
        pl_u32 source = 0u, width = 0u;
        if (value.kind == PL_OPERAND_NODE
                && pl_select_zero_extend_node(plan, (pl_u32)value.value, &source, &width)
                && width >= out->bits) {
            const pl_node *extend = &plan->nodes[value.value - 1u];
            pl_operand original = plan->arguments[extend->argument_at + 1u];
            if (original.kind == PL_OPERAND_LOCAL) *input[i] = original;
        }
    }
    pl_operand physical_left = left;
    pl_operand physical_right = right;
    pl_select_physicalize_published_operand(
        plan, PL_X86_GPR_COUNT, &physical_left);
    pl_select_physicalize_published_operand(
        plan, PL_X86_GPR_COUNT, &physical_right);
    if (out->offset && (physical_left.kind != PL_OPERAND_LOCAL || physical_left.value >= 4u)) {
        /* A shared value may have a preferred owner without a high-byte
         * encoding, yet also be published in RAX..RBX. Read that exact alias
         * after its copy-out instead of rebuilding the shifted byte. */
        for (pl_u32 local = 0u; local < 4u; ++local)
            if (plan->locals[local].kind == left.kind && plan->locals[local].value == left.value) {
                physical_left = (pl_operand){ PL_OPERAND_LOCAL, local };
                break;
            }
    }
    if (physical_left.kind != PL_OPERAND_LOCAL
            || physical_left.value >= PL_X86_GPR_COUNT
            || (physical_right.kind != PL_OPERAND_CONST
                && (physical_right.kind != PL_OPERAND_LOCAL
                    || physical_right.value >= PL_X86_GPR_COUNT)))
        return 0;
    out->left = (pl_u32)physical_left.value;
    if (out->offset && out->left >= 4u) return 0;
    out->right = physical_right;
    out->entry_sources = 0u;
    out->owner_dependencies = 0u;
    /* The final instruction reads physical operands, not every entry value
     * inside their SSA definitions.  A direct architectural local must stay
     * live until TEST/CMP; a node/projection (or a saved copy of an entry)
     * instead creates a producer edge from its final published owner. */
    if (left.kind == PL_OPERAND_LOCAL
            && left.value == physical_left.value)
        out->entry_sources |= 1u << out->left;
    else
        out->owner_dependencies |= 1u << out->left;
    if (physical_right.kind == PL_OPERAND_LOCAL) {
        pl_u32 right_local = (pl_u32)physical_right.value;
        if (right.kind == PL_OPERAND_LOCAL
                && right.value == physical_right.value)
            out->entry_sources |= 1u << right_local;
        else
            out->owner_dependencies |= 1u << right_local;
    }
    (void)mode;
    (void)preserves_carry;
    return 1;
}

/* CMP/TEST can be the final flag producer while one operand is an expression
 * no register publishes (`and eax,mask; cmp eax,imm; mov eax,0`, where the AND
 * is read only by the compare and the later MOV overwrites EAX).  The compare
 * has no GPR result to own that tree, so the frame materializes it into a
 * scratch and then emits the comparison.  LOCAL operands are the entry
 * generation (they must be read before any pending publication overwrites
 * them); NODE/PROJECTION operands name a published owner the tree must wait
 * for. */
int pl_select_operand_published_dependencies(const pl_plan *plan, pl_operand operand,
                                          pl_u32 before_node, pl_u32 remaining,
                                          pl_u32 *deps)
{
    if (!plan || !deps || !remaining) return 0;
    if (operand.kind == PL_OPERAND_CONST
            || operand.kind == PL_OPERAND_LOCAL)
        return 1;
    if (operand.kind != PL_OPERAND_NODE
            && operand.kind != PL_OPERAND_PROJECTION)
        return 0;
    pl_u32 node = operand.kind == PL_OPERAND_NODE
                ? (pl_u32)operand.value : (pl_u32)(operand.value >> 8u);
    if (!node || node > plan->node_count) return 0;
    pl_u32 owner = pl_select_publication_owner(plan, operand);
    if (owner < PL_X86_GPR_COUNT) {
        *deps |= 1u << owner;
        return 1;
    }
    if (node > before_node) return 0;
    const pl_node *value = &plan->nodes[node - 1u];
    if (value->argument_at > plan->argument_count
            || value->argument_count > plan->argument_count - value->argument_at)
        return 0;
    for (pl_u32 argument = 0u; argument < value->argument_count; ++argument)
        if (!pl_select_operand_published_dependencies(plan,
                plan->arguments[value->argument_at + argument], node,
                remaining - 1u, deps))
            return 0;
    return 1;
}

/* BT tests one bit of the base named by a register offset (`0F A3 /r`) or an
 * imm8 offset (`0F BA /4 ib`).  The flag producer has no GPR result, so this
 * is a standalone final-flag publication like TEST/CMP. */
static int emit_bit_test_register(pl_u32 base, pl_operand offset, pl_u32 bits,
                                  pl_u8 *output, pl_u32 *written)
{
    if (!written || base >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    if (offset.kind == PL_OPERAND_LOCAL) {
        if (offset.value >= PL_X86_GPR_COUNT) return 0;
        pl_u32 at = 0u;
        pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
            | ((pl_u32)offset.value >= 8u ? 4u : 0u)
            | (base >= 8u ? 1u : 0u));
        if (rex != 0x40u) {
            if (output) output[at] = rex;
            ++at;
        }
        if (output) output[at] = 0x0fu;
        ++at;
        if (output) output[at] = 0xa3u;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u
                | (((pl_u32)offset.value & 7u) << 3u) | (base & 7u));
        ++at;
        *written = at;
        return 1;
    }
    if (offset.kind == PL_OPERAND_CONST && offset.value <= 0xffu) {
        pl_u32 at = 0u;
        pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
            | (base >= 8u ? 1u : 0u));
        if (rex != 0x40u) {
            if (output) output[at] = rex;
            ++at;
        }
        if (output) output[at] = 0x0fu;
        ++at;
        if (output) output[at] = 0xbau;
        ++at;
        if (output)
            output[at] = (pl_u8)(0xc0u | (4u << 3u) | (base & 7u));
        ++at;
        if (output) output[at] = (pl_u8)offset.value;
        ++at;
        *written = at;
        return 1;
    }
    return 0;
}

int pl_select_emit_standalone_flag_publication(
    const standalone_flag_publication *publication,
    pl_u8 *output, pl_u32 *written)
{
    if (!publication) return 0;
    if (publication->bit_test)
        return emit_bit_test_register(
            publication->left, publication->right,
            publication->bits, output, written);
    return pl_select_emit_flag_coordinate(publication->left, publication->right,
        publication->bits, publication->test, publication->offset, output, written);
}

int pl_select_carry_adjustment_details(const pl_plan *plan, pl_operand value,
                                     pl_u32 destination, pl_u32 bits, carry_adjustment *out)
{
    if (value.kind == PL_OPERAND_NODE && value.value && value.value <= plan->node_count) {
        const pl_node *select = &plan->nodes[value.value - 1u];
        if ((select->opcode == PL_OPCODE_LANE32_SELECT
                || select->opcode == PL_OPCODE_LANE64_SELECT)
                && select->argument_count == 3u && select->argument_at <= plan->argument_count
                && 3u <= plan->argument_count - select->argument_at) {
            const pl_operand *argument = plan->arguments + select->argument_at;
            condition_value condition;
            if (pl_select_condition_value_details(plan, argument[2], &condition)
                    && (condition.condition == 4u || condition.condition == 5u)
                    && condition.flags.kind == PL_OPERAND_NODE
                    && pl_select_standalone_flag_publication_details(plan,
                        (pl_u32)condition.flags.value, &out->compare)
                    && out->compare.test && out->compare.bits == bits
                    && out->compare.right.kind == PL_OPERAND_LOCAL
                    && out->compare.right.value == out->compare.left) {
                pl_operand unit = argument[condition.condition == 4u ? 0u : 1u];
                pl_operand current = argument[condition.condition == 4u ? 1u : 0u];
                pl_u32 source = PL_X86_GPR_COUNT, width = 0u;
                if (current.kind == PL_OPERAND_LOCAL && current.value < PL_X86_GPR_COUNT)
                    source = (pl_u32)current.value;
                else if (current.kind == PL_OPERAND_NODE
                        && pl_select_zero_extend_node(plan, (pl_u32)current.value, &source, &width)
                        && width != bits) source = PL_X86_GPR_COUNT;
                if (unit.kind == PL_OPERAND_CONST && unit.value == 1u
                        && source < PL_X86_GPR_COUNT) {
                    pl_operand physical = { PL_OPERAND_LOCAL, source };
                    pl_select_physicalize_published_operand(plan, destination, &physical);
                    if (physical.kind == PL_OPERAND_LOCAL
                            && physical.value == out->compare.left) {
                        /* max_unsigned(x,1) = x + [x < 1]. The condition
                         * remains in CF; no constant-arm register is needed. */
                        out->compare.test = 0u;
                        out->compare.right = (pl_operand){ PL_OPERAND_CONST, 1u };
                        out->source = (pl_u32)physical.value;
                        out->bits = bits; out->mode = 2u; out->zero_mask = 0u;
                        out->immediate = (pl_operand){ PL_OPERAND_CONST, 0u };
                        return 1;
                    }
                }
            }
        }
    }
    pl_operand current, predicate;
    pl_u32 mode = 0u;
    pl_u64 offset = 0u;
    pl_operand complement, negated;
    pl_u32 complement_bits = 0u, negated_bits = 0u;
    int complemented_mask = pl_select_complement_node_details(plan, value, &complement, &complement_bits)
        && pl_select_negation_node_details(plan, complement, &negated, &negated_bits)
        && complement_bits == negated_bits;
    if (complemented_mask) value = complement;
    if (!pl_select_arithmetic_tree_details(plan, value, &current, &predicate, &out->bits, &mode)) {
        if (value.kind != PL_OPERAND_NODE || !value.value || value.value > plan->node_count)
            return 0;
        const pl_node *sum = &plan->nodes[value.value - 1u];
        if ((sum->opcode != PL_OPCODE_ADD3[0] && sum->opcode != PL_OPCODE_ADD3[1])
                || sum->argument_count != 3u || sum->argument_at > plan->argument_count
                || 3u > plan->argument_count - sum->argument_at) return 0;
        const pl_operand *argument = plan->arguments + sum->argument_at;
        pl_u32 constant = 0u;
        while (constant < 3u && argument[constant].kind != PL_OPERAND_CONST) ++constant;
        if (constant == 3u) return 0;
        offset = argument[constant].value;
        current = argument[(constant + 1u) % 3u];
        predicate = argument[(constant + 2u) % 3u];
        out->bits = sum->opcode == PL_OPCODE_ADD3[0] ? 32u : 64u;
        mode = 1u;
    }
    if (mode != 1u && mode != 3u) return 0;
    condition_value condition;
    if (!pl_select_condition_value_details(plan, predicate, &condition)) {
        if (mode != 1u || !pl_select_condition_value_details(plan, current, &condition)) return 0;
        current = predicate;
    }
    if (complemented_mask) {
        if (current.kind != PL_OPERAND_CONST || current.value || offset || mode != 3u)
            return 0;
        /* ~(0-p) = 0-(1-p) for a Boolean p. */
        condition.condition ^= 1u;
    }
    if ((condition.condition != 2u && condition.condition != 3u)
            || condition.flags.kind != PL_OPERAND_NODE
            || !pl_select_standalone_flag_publication_details(
                plan, (pl_u32)condition.flags.value, &out->compare)
            || out->compare.test) return 0;
    pl_operand base, addend;
    pl_u32 current_bits = 0u, current_mode = 0u;
    if (pl_select_arithmetic_tree_details(plan, current, &base, &addend, &current_bits, &current_mode)
            && current_bits == out->bits && (current_mode == 1u || current_mode == 3u)
            && addend.kind == PL_OPERAND_CONST) {
        offset += current_mode == 1u ? addend.value : 0ull - addend.value;
        current = base;
    }
    pl_select_physicalize_published_operand(plan, destination, &current);
    out->zero_mask = current.kind == PL_OPERAND_CONST && !current.value
        && !offset && mode == 3u;
    if (!out->zero_mask
            && (current.kind != PL_OPERAND_LOCAL || current.value >= PL_X86_GPR_COUNT))
        return 0;
    out->source = out->zero_mask ? destination : (pl_u32)current.value;
    /* a+k + CF = ADC(a,k); a+k - CF = SBB(a,-k).
     * Substituting !CF = 1-CF changes the sign and adds +/-1 to k.
     * Keep the Boolean in the carry flag instead of materializing SETcc. */
    out->mode = (mode == 1u) == (condition.condition == 2u) ? 2u : 4u;
    if (condition.condition == 3u) offset += mode == 1u ? 1u : U64_MAX_VALUE;
    out->immediate.kind = PL_OPERAND_CONST;
    out->immediate.value = out->mode == 2u ? offset : 0ull - offset;
    /* Only the arithmetic word is truncated. The condition still observes
     * the original comparison width, so low32(a +/- CF) commutes with this
     * projection even when CF came from a 64-bit comparison. */
    if (bits != out->bits && !(bits == 32u && out->bits == 64u)) return 0;
    out->bits = bits;
    if (out->bits == 32u) out->immediate.value &= U32_MAX_VALUE;
    return 1;
}

int pl_select_emit_carry_adjustment(const carry_adjustment *shape, pl_u32 destination,
                                 pl_u8 *output, pl_u32 *written, pl_u32 *work)
{
    pl_u32 at = 0u, encoded = 0u;
    if (!pl_select_emit_standalone_flag_publication(&shape->compare, output, &at)) return 0;
    *work = 1u;
    if (shape->zero_mask) {
        /* 0-CF = SBB(r,r), independently of r's old bits. Complementing
         * that word gives 0-!CF; no scalar Boolean or zero seed is needed. */
        pl_operand self = { PL_OPERAND_LOCAL, destination };
        if (!pl_select_emit_alu_instruction(destination, self, shape->bits, 4u, 0u,
                                  output ? output + at : 0, &encoded)) return 0;
        at += encoded;
        ++*work;
        if (shape->mode == 2u) {
            if (!pl_select_emit_not_register(destination, shape->bits,
                                   output ? output + at : 0, &encoded)) return 0;
            at += encoded;
            ++*work;
        }
        *written = at;
        return 1;
    }
    /* CMP precedes the seed so even a comparison reading the old destination
     * is valid. MOV preserves CF; it can share the comparison's dependency wave. */
    if (destination != shape->source) {
        if (!pl_select_emit_gpr_move(destination, shape->source, shape->bits,
                           output ? output + at : 0, &encoded)) return 0;
        at += encoded;
        ++*work;
    }
    if (!pl_select_emit_alu_instruction(destination, shape->immediate, shape->bits,
                              shape->mode, 0u, output ? output + at : 0, &encoded))
        return 0;
    *written = at + encoded;
    ++*work;
    return 1;
}

int pl_select_boolean_select_details(const pl_plan *plan, pl_operand value,
                                  boolean_select *out)
{
    if (!plan || !out || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != PL_OPCODE_LANE32_SELECT
            && node->opcode != PL_OPCODE_LANE64_SELECT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if ((argument[0].kind != PL_OPERAND_CONST
            && (argument[0].kind != PL_OPERAND_LOCAL
                || argument[0].value >= PL_X86_GPR_COUNT))
            || (argument[1].kind != PL_OPERAND_CONST
                && (argument[1].kind != PL_OPERAND_LOCAL
                    || argument[1].value >= PL_X86_GPR_COUNT)))
        return 0;
    out->when_true = argument[0];
    out->when_false = argument[1];
    out->condition = argument[2];
    out->value_bits = node->opcode == PL_OPCODE_LANE32_SELECT ? 32u : 64u;
    return 1;
}

/* A 32-bit CMOV reads the low word directly and zeroes the destination high
 * word even when the condition is false. Its source's explicit zero extension
 * therefore needs neither an instruction nor a published temporary. */
static int conditional_entry_local(const pl_plan *plan, pl_operand value,
                                    pl_u32 bits, pl_u32 *local)
{
    if (value.kind == PL_OPERAND_NODE && bits == 32u) {
        pl_u32 source = 0u, width = 0u;
        if (pl_select_zero_extend_node(plan, (pl_u32)value.value, &source, &width)
                && width == 32u) {
            const pl_node *node = &plan->nodes[value.value - 1u];
            value = plan->arguments[node->argument_at + 1u];
        }
    }
    if (value.kind != PL_OPERAND_LOCAL || value.value >= PL_X86_GPR_COUNT)
        return 0;
    *local = (pl_u32)value.value;
    return 1;
}

static int conditional_published_local(const pl_plan *plan, pl_operand value,
    pl_u32 bits, pl_u32 *local)
{
    if (pl_select_published_operand_local(plan, value, local)) return 1;
    /* CMOV r32 reads the candidate's low word without changing that register.
     * A full-width constant publication can own this projected arm too. */
    if (bits != 32u || value.kind != PL_OPERAND_CONST) return 0;
    for (pl_u32 candidate = 0u; candidate < PL_X86_GPR_COUNT; ++candidate)
        if (plan->locals[candidate].kind == PL_OPERAND_CONST
                && (pl_u32)plan->locals[candidate].value == (pl_u32)value.value) {
            *local = candidate;
            return 1;
        }
    return 0;
}

static void conditional_prefer_published_generation(
    const pl_plan *plan, pl_operand value, pl_u32 bits,
    pl_u32 destination, int *entry, pl_u32 *local)
{
    if (!*entry || *local == destination) return;
    pl_operand final = plan->locals[*local];
    if (final.kind == PL_OPERAND_LOCAL && final.value == *local) return;
    pl_u32 owner = 0u;
    if (conditional_published_local(plan, value, bits, &owner)
            && owner != *local && owner != destination) {
        /* The entry coordinate is overwritten before the select when an
         * independent old-generation reader must run first.  Bind CMOV to
         * the already published alias, not that reused entry coordinate. */
        *local = owner;
        *entry = 0;
    }
}

int pl_select_conditional_select_details_inner(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       int allow_seed,
                                       conditional_select *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    out->compare_left_seed = 0u;
    out->compare_right_seed = 0u;
    out->compare_left_value = (pl_operand){ 0 };
    out->compare_right_value = (pl_operand){ 0 };
    const pl_node *select = &plan->nodes[value.value - 1u];
    if ((select->opcode != PL_OPCODE_LANE32_SELECT
            && select->opcode != PL_OPCODE_LANE64_SELECT)
            || select->argument_count != 3u
            || select->argument_at > plan->argument_count
            || select->argument_count
               > plan->argument_count - select->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + select->argument_at;
    if (argument[2].kind != PL_OPERAND_NODE || !argument[2].value
            || argument[2].value > plan->node_count)
        return 0;
    const pl_node *condition = &plan->nodes[argument[2].value - 1u];
    if (condition->opcode != PL_OPCODE_X86_CONDITION
            || condition->argument_count != 2u
            || condition->argument_at > plan->argument_count
            || condition->argument_count
               > plan->argument_count - condition->argument_at)
        return 0;
    const pl_operand *condition_argument =
        plan->arguments + condition->argument_at;
    if (condition_argument[1].kind != PL_OPERAND_CONST
            || condition_argument[1].value > 15u)
        return 0;
    pl_u32 candidate_local = 0u;
    pl_u32 candidate_immediate = 0u;
    pl_u32 inverted = 0u;
    pl_operand candidate_arm = argument[0];
    out->value_bits = select->opcode == PL_OPCODE_LANE32_SELECT
                   || (pl_select_operand_fits_u32(
                           plan, argument[0], plan->node_count + 1u)
                       && pl_select_operand_fits_u32(
                           plan, argument[1], plan->node_count + 1u))
                    ? 32u : 64u;
    int first_entry = conditional_entry_local(
        plan, argument[0], out->value_bits, &candidate_local);
    conditional_prefer_published_generation(
        plan, argument[0], out->value_bits, destination,
        &first_entry, &candidate_local);
    int first_physical = first_entry;
    if (!first_physical) first_physical = conditional_published_local(
        plan, argument[0], out->value_bits, &candidate_local);
    pl_u32 second_local = 0u;
    int second_entry = conditional_entry_local(
        plan, argument[1], out->value_bits, &second_local);
    conditional_prefer_published_generation(
        plan, argument[1], out->value_bits, destination,
        &second_entry, &second_local);
    int second_physical = second_entry;
    if (!second_physical)
        second_physical = conditional_published_local(
            plan, argument[1], out->value_bits, &second_local);
    int first_is_entry_destination = first_entry && candidate_local == destination;
    int second_is_entry_source = second_entry && second_local != destination;
    if (first_is_entry_destination && second_is_entry_source) {
        /* SELECT(dst,src,cc) already has its true arm in the destructive
         * destination.  Selecting the false arm with the complementary
         * condition is one CMOV and preserves both entry values until that
         * instruction: `cmov(!cc) dst,src`. */
        out->current = argument[0];
        candidate_arm = argument[1];
        candidate_local = second_local;
        inverted = 1u;
    } else if (first_physical) {
        out->current = argument[1];
    } else if (second_physical) {
        /* SELECT(a,b,cc) is `current=b; cmovcc current,a`.  When only b has
         * a physical owner, place a in the destination and select b with the
         * exact complementary x86 condition.  Adjacent condition codes are
         * complements by ISA definition, hence cc^1 for all 16 encodings. */
        out->current = argument[0];
        candidate_arm = argument[1];
        candidate_local = second_local;
        inverted = 1u;
    } else {
        /* Neither arm names a physical owner (for example two address
         * constants): the destructive `current` is materialised into the
         * destination and the other arm into a scratch the frame chooses. */
        out->current = argument[1];
        out->candidate_value = argument[0];
        candidate_immediate = 1u;
        candidate_local = PL_X86_GPR_COUNT;
    }
    out->candidate_local = candidate_local;
    out->candidate_immediate = candidate_immediate;
    out->candidate_is_entry = (pl_u32)(inverted ? second_entry : first_entry);
    pl_u32 current_entry = 0u;
    int current_is_entry = conditional_entry_local(
        plan, out->current, out->value_bits, &current_entry);
    if (current_is_entry)
        out->current = (pl_operand){ PL_OPERAND_LOCAL, current_entry };
    out->candidate_owner = PL_X86_GPR_COUNT;
    /* A constant candidate cannot borrow a later self-zeroing publication:
     * the register still holds its entry value (possibly clobbered by the
     * preceding call), and the XOR producing zero must remain the final flag
     * producer.  The same immediate path also resolves a cycle when a
     * constant publication overwrites the current arm's entry register. */
    int condition_is_entry_flags =
        condition_argument[0].kind == PL_OPERAND_LOCAL
        && condition_argument[0].value == PL_X86_RFLAGS_LOCAL;
    if (!candidate_immediate && candidate_local < PL_X86_GPR_COUNT
            && candidate_arm.kind == PL_OPERAND_CONST
            && ((condition_is_entry_flags
                    && current_is_entry
                    && current_entry == candidate_local)
                || (!candidate_arm.value && pl_select_zero_self_flag_publication(
                    plan, candidate_local)))) {
        out->candidate_value = candidate_arm;
        out->candidate_owner = candidate_local;
        candidate_immediate = 1u;
        candidate_local = PL_X86_GPR_COUNT;
        out->candidate_local = candidate_local;
        out->candidate_immediate = candidate_immediate;
        out->candidate_is_entry = 0u;
    }
    out->condition = (pl_u32)condition_argument[1].value ^ inverted;
    out->has_compare = 0u;
    out->current_flag_node = 0u;
    out->compare_test = 0u;
    out->compare_offset = 0u;
    out->compare_node = 0u;
    out->compare_left_is_current = 0u;
    out->compare_right_is_current = 0u;
    out->compare_left_local = 0u;
    out->compare_right = (pl_operand){ PL_OPERAND_CONST, 0u };
    out->compare_bits = 0u;
    if (condition_argument[0].kind == PL_OPERAND_LOCAL
            && condition_argument[0].value == PL_X86_RFLAGS_LOCAL)
        return 1;
    if (condition_argument[0].kind != PL_OPERAND_NODE
            || !condition_argument[0].value
            || condition_argument[0].value > plan->node_count)
        return 0;
    pl_operand flag_left, flag_right;
    pl_u32 flag_bits = 0u, flag_mode = 0u, carry = 0u;
    if (pl_select_flag_value_operation_details(plan, (pl_u32)condition_argument[0].value,
            out->current, &flag_left, &flag_right, &flag_bits, &flag_mode, &carry)
            && !carry && flag_bits == out->value_bits) {
        /* The current arm is the exact result that also produces the tested
         * flags. Its destructive ALU instruction serves both observations;
         * CMOV preserves those flags without a second CMP/TEST. */
        out->current_flag_node = (pl_u32)condition_argument[0].value;
        out->compare_node = out->current_flag_node;
        return 1;
    }
    const pl_node *compare =
        &plan->nodes[condition_argument[0].value - 1u];
    pl_u32 compare_descriptor_at =
        compare->opcode == PL_OPCODE_X86_FLAGS ? 4u : 3u;
    pl_u32 compare_argument_count =
        compare->opcode == PL_OPCODE_X86_FLAGS ? 5u : 4u;
    if ((compare->opcode != PL_OPCODE_X86_COMPARE
            && compare->opcode != PL_OPCODE_X86_TEST
            && compare->opcode != PL_OPCODE_X86_ALU
            && compare->opcode != PL_OPCODE_X86_FLAGS)
            || compare->argument_count != compare_argument_count
            || compare->argument_at > plan->argument_count
            || compare->argument_count
               > plan->argument_count - compare->argument_at)
        return 0;
    const pl_operand *compare_argument =
        plan->arguments + compare->argument_at;
    if (compare_argument[compare_descriptor_at].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = compare_argument[compare_descriptor_at].value;
    pl_u32 compare_bits = (pl_u32)(descriptor & 0x7fu);
    int compare_test = compare->opcode == PL_OPCODE_X86_TEST
                    || ((compare->opcode == PL_OPCODE_X86_ALU
                            || compare->opcode == PL_OPCODE_X86_FLAGS)
                        && ((descriptor >> 8u) & 7u) == 0u);
    int compare_subtract = compare->opcode == PL_OPCODE_X86_COMPARE
                        || ((compare->opcode == PL_OPCODE_X86_ALU
                                || compare->opcode == PL_OPCODE_X86_FLAGS)
                            && ((descriptor >> 8u) & 7u) == 3u);
    if ((compare_bits != 8u && compare_bits != 16u
            && compare_bits != 32u && compare_bits != 64u)
            || (!compare_test && !compare_subtract)
            || (descriptor >> 11u))
        return 0;
    pl_operand compare_input = compare_argument[1];
    out->compare_offset = test_byte_coordinate(plan, &compare_input,
        compare_argument[2], compare_bits, (pl_u32)compare_test);
    pl_u32 compare_left = 0u;
    if (compare_input.kind == out->current.kind
            && compare_input.value == out->current.value) {
        out->compare_left_is_current = 1u;
        pl_u32 current_local = out->current.kind == PL_OPERAND_LOCAL
                             && out->current.value < PL_X86_GPR_COUNT
                             ? (pl_u32)out->current.value
                             : PL_X86_GPR_COUNT;
        compare_left = current_local < PL_X86_GPR_COUNT
                    && plan->locals[current_local].kind == PL_OPERAND_LOCAL
                    && plan->locals[current_local].value == current_local
                     ? current_local : destination;
    } else if (compare_input.kind == PL_OPERAND_LOCAL
            && compare_input.value < PL_X86_GPR_COUNT) {
        compare_left = (pl_u32)compare_input.value;
    } else if (!pl_select_published_operand_local(
                   plan, compare_input, &compare_left)) {
        if (allow_seed
                && (compare_input.kind == PL_OPERAND_NODE
                    || compare_input.kind == PL_OPERAND_PROJECTION)
                && pl_select_operand_expression_bits(plan, compare_input, 0u)) {
            out->compare_left_value = compare_input;
            out->compare_left_seed = 1u;
            compare_left = PL_X86_GPR_COUNT;
        } else {
            return 0;
        }
    }
    if (out->compare_offset && compare_left >= 4u) return 0;
    pl_operand compare_right = compare_argument[2];
    if (compare_right.kind == out->current.kind
            && compare_right.value == out->current.value) {
        out->compare_right_is_current = 1u;
        pl_u32 current_local = out->current.kind == PL_OPERAND_LOCAL
                             && out->current.value < PL_X86_GPR_COUNT
                             ? (pl_u32)out->current.value
                             : PL_X86_GPR_COUNT;
        compare_right.kind = PL_OPERAND_LOCAL;
        compare_right.value = current_local < PL_X86_GPR_COUNT
                    && plan->locals[current_local].kind == PL_OPERAND_LOCAL
                    && plan->locals[current_local].value == current_local
                     ? current_local : destination;
    } else if (compare_right.kind != PL_OPERAND_CONST) {
        pl_u32 right_local = 0u;
        if (compare_right.kind == PL_OPERAND_LOCAL
                && compare_right.value < PL_X86_GPR_COUNT) {
            right_local = (pl_u32)compare_right.value;
        } else if (!pl_select_published_operand_local(
                       plan, compare_right, &right_local)) {
            if (allow_seed
                    && (compare_right.kind == PL_OPERAND_NODE
                        || compare_right.kind == PL_OPERAND_PROJECTION)
                    && pl_select_operand_expression_bits(plan, compare_right, 0u)) {
                out->compare_right_value = compare_right;
                out->compare_right_seed = 1u;
                right_local = PL_X86_GPR_COUNT;
            } else {
                return 0;
            }
        }
        compare_right.kind = PL_OPERAND_LOCAL;
        compare_right.value = right_local;
    }
    out->compare_left_local = compare_left;
    out->compare_right = compare_right;
    out->compare_bits = compare_bits;
    out->has_compare = 1u;
    out->compare_test = (pl_u32)compare_test;
    out->compare_node = (pl_u32)condition_argument[0].value;
    return 1;
}

int pl_select_conditional_select_details(const pl_plan *plan, pl_operand value,
                                       pl_u32 destination,
                                       conditional_select *out)
{
    return pl_select_conditional_select_details_inner(
        plan, value, destination, 0, out);
}

/* A still-pending publication that consumes `pair_node` as its destructive
 * `current` arm.  When an ADD3 trades on a shared pair, building that pair in
 * the consumer's coordinate lets one materialization serve both publications
 * instead of rebuilding the pair twice. */
pl_u32 pl_select_alu_add3_pair_consumer(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 pair_node, pl_u32 skip)
{
    if (!plan || !pair_node) return PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == skip || !(pending & (1u << local))) continue;
        conditional_select select;
        if (pl_select_conditional_select_details_inner(
                plan, plan->locals[local], local, 1, &select)
                && select.current.kind == PL_OPERAND_NODE
                && select.current.value == pair_node)
            return local;
    }
    return PL_X86_GPR_COUNT;
}

int pl_select_emit_select_compare(const conditional_select *select,
                                pl_u8 *output, pl_u32 *written)
{
    return pl_select_emit_flag_coordinate(select->compare_left_local, select->compare_right,
        select->compare_bits, select->compare_test, select->compare_offset, output, written);
}

int pl_select_measure_selected_flag_value(const pl_x86_frontend *frontend,
    const pl_x86_block *block, pl_x86_native_selection *selection, pl_u32 destination,
    const conditional_select *shape, pl_u32 output_at, pl_u32 remaining,
    pl_u32 scratch_mask, pl_u32 *bytes, pl_u32 *work)
{
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, carry = 0u;
    if (!pl_select_flag_value_operation_details(&block->plan, shape->current_flag_node,
            shape->current, &left, &right, &bits, &mode, &carry)) return 0;
    return pl_select_measure_alu_pair(frontend, block, selection, destination, left, right,
        bits, mode, carry, output_at, remaining, scratch_mask, bytes, work);
}

int pl_select_write_selected_flag_value(const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u32 destination,
    const conditional_select *shape, pl_u32 output_at, pl_u32 remaining,
    pl_u32 scratch_mask, pl_u8 *output, pl_u32 *written)
{
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, carry = 0u;
    if (!pl_select_flag_value_operation_details(&block->plan, shape->current_flag_node,
            shape->current, &left, &right, &bits, &mode, &carry)) return 0;
    return pl_select_write_alu_pair(block, selection, destination, left, right,
        bits, mode, carry, output_at, remaining, scratch_mask, output, written);
}

/* Project an unsigned threshold through a right-shift quotient when the one
 * partially covered boundary class is observationally indistinguishable.
 *
 *   select(k, (x >> s) + d, x <= t)
 *
 * depends on x only through q=x>>s exactly when the false arm at q=t>>s is
 * also k.  Under that necessary and sufficient boundary condition the test
 * becomes q<=t>>s.  The suffix add is then a flag-preserving LEA, so compare
 * and value construction share a wave instead of retaining x or rebuilding
 * q. */
int pl_select_quotient_boundary_select_details(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    quotient_boundary_select *out)
{
    if (!plan || !out) return 0;
    conditional_select select;
    if (!pl_select_conditional_select_details(plan, value, destination, &select)
            || !select.has_compare || select.compare_test
            || select.condition != 6u
            || select.compare_left_is_current
            || select.compare_left_local != destination
            || select.compare_right.kind != PL_OPERAND_CONST
            || select.candidate_local >= PL_X86_GPR_COUNT)
        return 0;
    pl_operand candidate = plan->locals[select.candidate_local];
    if (candidate.kind != PL_OPERAND_CONST) return 0;

    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, select.current, &left, &right, &bits, &mode)
            || mode != 1u || bits != select.value_bits
            || bits != select.compare_bits)
        return 0;
    pl_operand quotient = left;
    pl_operand offset = right;
    if (quotient.kind == PL_OPERAND_CONST) {
        quotient = right;
        offset = left;
    }
    if (offset.kind != PL_OPERAND_CONST) return 0;

    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (!pl_select_shift_node_details(
            plan, quotient, &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            || shift_bits != bits || shift_group != 5u
            || shift_source.kind != PL_OPERAND_LOCAL
            || shift_source.value != select.compare_left_local
            || shift_amount.kind != PL_OPERAND_CONST)
        return 0;
    pl_u32 count_mask = bits == 64u ? 63u : 31u;
    pl_u32 count = (pl_u32)shift_amount.value & count_mask;
    if (!count) return 0;
    pl_u64 mask = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 threshold = select.compare_right.value & mask;
    pl_u64 projected_threshold = threshold >> count;
    pl_u64 boundary_value =
        (projected_threshold + (offset.value & mask)) & mask;
    if (boundary_value != (candidate.value & mask)) return 0;

    out->select = select;
    out->quotient = quotient;
    out->offset = offset;
    out->projected_compare_right = (pl_operand){
        PL_OPERAND_CONST, projected_threshold,
    };
    return 1;
}

int pl_select_conditional_compare_survives_current(
    const conditional_select *select, pl_u32 destination)
{
    if (!select || !select->has_compare) return 1;
    if (select->compare_left_local == destination
            && !select->compare_left_is_current)
        return 0;
    return !(select->compare_right.kind == PL_OPERAND_LOCAL
          && select->compare_right.value == destination
          && !select->compare_right_is_current);
}

int pl_select_publication_emits_selected_flag(const pl_plan *plan,
    pl_operand value, pl_u32 destination, pl_u32 flag_node)
{
    if (!plan || !flag_node) return 0;
    /* MOVSX/CDQE and NOT preserve the comparison produced inside a selected
     * value. Their enclosing publication owns that same flag result; no
     * second standalone CMP is needed, and the scheduler must keep it last. */
    for (pl_u32 remaining = plan->node_count + 1u; remaining; --remaining) {
        conditional_select select;
        if (pl_select_conditional_select_details(plan, value, destination, &select))
            return (select.has_compare || select.current_flag_node)
                && select.compare_node == flag_node;
        pl_operand source;
        pl_u32 bits = 0u;
        if (value.kind == PL_OPERAND_NODE
                && pl_select_sign_extend_value(plan, (pl_u32)value.value, &source, &bits))
            value = source;
        else if (pl_select_complement_node_details(plan, value, &source, &bits))
            value = source;
        else return 0;
    }
    return 0;
}

int pl_select_publication_emits_flag_node(const pl_plan *plan,
                                       pl_u32 changed,
                                       pl_u32 flag_node)
{
    if (!plan || !flag_node) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        if (pl_select_publication_emits_selected_flag(plan, plan->locals[local], local, flag_node))
            return 1;
    }
    return 0;
}

/* Unlike pl_select_publication_emits_flag_node(), this asks whether the native
 * instruction which publishes a GPR value is itself the final flag producer.
 * A CMOV may consume a standalone CMP node with no such value publication. */
int pl_select_flag_node_has_value_publication(const pl_plan *plan,
                                           pl_u32 changed,
                                           pl_u32 flag_node)
{
    if (!plan || !flag_node) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((changed & (1u << local))
                && pl_select_publication_is_flag_result(
                    plan, plan->locals[local], flag_node))
            return 1;
    return 0;
}

/* Two publications consume the same entry register: CMOV replaces that
 * register under entry RFLAGS, while a second register receives the entry
 * word with one forced bit.  Capture the shared entry generation first, then
 * run CMOV and the forced-bit suffix in the same wave.  A final TEST of the
 * selected word's high byte is emitted directly as AH/CH/DH/BH, so neither a
 * shifted scalar nor an invented flag producer survives. */
int pl_select_entry_select_bit_test_frame_shape(
    const pl_x86_block *block, pl_u32 changed, pl_u32 final_flag_node,
    entry_select_bit_test_frame *out)
{
    if (!block || !out || block->flow != PL_X86_FLOW_NEXT
            || block->successor_count != 1u || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || !final_flag_node
            || final_flag_node > block->plan.node_count)
        return 0;
    const pl_plan *plan = &block->plan;
    const pl_node *test = &plan->nodes[final_flag_node - 1u];
    if (test->opcode != PL_OPCODE_X86_TEST
            || test->argument_count != 4u
            || test->argument_at > plan->argument_count
            || test->argument_count
               > plan->argument_count - test->argument_at)
        return 0;
    const pl_operand *test_argument =
        plan->arguments + test->argument_at;
    if (test_argument[1].kind != PL_OPERAND_NODE
            || test_argument[2].kind != PL_OPERAND_CONST
            || test_argument[2].value > 0xffu
            || test_argument[3].kind != PL_OPERAND_CONST
            || test_argument[3].value != 8u)
        return 0;
    pl_operand shifted_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (!pl_select_shift_node_details(
            plan, test_argument[1], &shifted_source, &shift_amount,
            &shift_bits, &shift_group)
            || shift_bits != 64u || shift_group != 5u
            || shift_amount.kind != PL_OPERAND_CONST
            || shift_amount.value != 8u)
        return 0;

    for (pl_u32 destination = 0u; destination < 4u; ++destination) {
        if (!(changed & (1u << destination))) continue;
        conditional_select select;
        if (!pl_select_conditional_select_details(
                plan, plan->locals[destination], destination, &select)
                || select.has_compare || select.current_flag_node
                || select.current.kind != PL_OPERAND_LOCAL
                || select.current.value != destination
                || shifted_source.kind != plan->locals[destination].kind
                || shifted_source.value != plan->locals[destination].value)
            continue;
        for (pl_u32 side = 0u; side < PL_X86_GPR_COUNT; ++side) {
            if (side == destination || !(changed & (1u << side)))
                continue;
            pl_operand side_source;
            pl_u32 side_bits = 0u, side_bit = 0u;
            if (!pl_select_single_bit_or_details(
                    plan, plan->locals[side], &side_source,
                    &side_bits, &side_bit)
                    || side_source.kind != PL_OPERAND_LOCAL
                    || side_source.value != destination
                    || (side_bits != 32u && side_bits != 64u)
                    || side_bit >= side_bits)
                continue;
            pl_u32 exact = (1u << destination) | (1u << side);
            if ((changed & ((1u << PL_X86_GPR_COUNT) - 1u)) != exact)
                continue;
            *out = (entry_select_bit_test_frame){
                select, destination, side, side_bits, side_bit,
                test_argument[2],
            };
            return 1;
        }
    }
    return 0;
}

int pl_select_emit_entry_select_bit_test_frame(
    const entry_select_bit_test_frame *shape,
    pl_u8 *output, pl_u32 *written)
{
    if (!shape || !written) return 0;
    pl_u32 at = 0u, part = 0u;
    if (!pl_select_emit_gpr_move(
            shape->side_destination, shape->destination,
            shape->side_bits, output, &part))
        return 0;
    at += part;
    if (!pl_select_emit_conditional_move(
            shape->destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    pl_operand bit = {
        PL_OPERAND_CONST, 1ull << shape->side_bit,
    };
    if (!pl_select_emit_alu_instruction(
            shape->side_destination, bit, shape->side_bits, 5u, 0u,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    if (!pl_select_emit_high8_test(
            shape->destination, shape->test_right,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    *written = at + part;
    return 1;
}

/* A conditional publication owns two independent dependency domains.  The
 * selected value depends on ordinary entry GPRs; its condition is either the
 * entry flag word or a compare/test which is rematerialized immediately
 * before CMOV.  Walking the generic node arguments confuses the latter with a
 * GPR dependency because RFLAGS is deliberately outside the GPR population.
 * Project the exact destructive-register realization instead.  This helper
 * returns entry-GPR sources only; final publication owners are a separate
 * topological relation below.  Mixing the two reverses the required order for
 * `constant owner -> CMOV consumer`. */
int pl_select_conditional_select_gpr_sources(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    pl_u32 *sources)
{
    conditional_select select;
    if (!plan || !sources
            || !pl_select_conditional_select_details(
                plan, value, destination, &select))
        return 0;
    if (!pl_select_operand_gpr_sources(
            plan, select.current, plan->node_count + 1u,
            plan->node_count + 1u, sources))
        return 0;
    if (select.candidate_is_entry)
        *sources |= 1u << select.candidate_local;
    return 1;
}

int pl_select_conditional_select_publication_dependencies(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    pl_u32 *dependencies)
{
    conditional_select select;
    if (!plan || !dependencies
            || !pl_select_conditional_select_details(
                plan, value, destination, &select))
        return 0;
    /* Entry operands must be consumed before their coordinate is replaced;
     * published operands must be produced before this consumer. These are
     * opposite edges even when both generations use the same register. */
    *dependencies = select.candidate_is_entry
                  ? 0u : 1u << select.candidate_local;
    if (select.has_compare
            && select.compare_left_local != destination)
        *dependencies |= 1u << select.compare_left_local;
    if (select.has_compare
            && select.compare_right.kind == PL_OPERAND_LOCAL
            && select.compare_right.value != destination)
        *dependencies |= 1u << (pl_u32)select.compare_right.value;
    return 1;
}

/* A select whose constant candidate is bound to a publication that overwrites
 * the entry register its current arm reads takes the immediate candidate path
 * (see pl_select_conditional_select_details_inner): the frame materialises the constant
 * itself and evaluates the current arm first.  The generic node law still names
 * that constant's publication as a dependency, which would deadlock the
 * scheduler against the entry read, so drop the spurious edge. */
int pl_select_apply_select_candidate_laws(
    const pl_plan *plan, pl_u32 changed,
    pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !dependencies) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        conditional_select select;
        if (!pl_select_conditional_select_details_inner(
                plan, plan->locals[local], local, 1, &select))
            continue;
        if (select.candidate_owner < PL_X86_GPR_COUNT)
            dependencies[local] &= ~(1u << select.candidate_owner);
    }
    return 1;
}

/* When the compare observed by CMOV is also the block's final architectural
 * flag producer, its value publication and flag publication are one native
 * instruction.  Replace old-entry compare sources with that producer edge;
 * the final-flag scheduler already keeps every other flag clobber before it.
 * CMOV can then consume the live flags without rematerializing TEST/CMP. */
int pl_select_apply_shared_flag_producer_laws(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    pl_u32 sources[PL_X86_GPR_COUNT],
    pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !sources || !dependencies) return 0;
    if (!final_flag_node
            || !pl_select_flag_node_has_value_publication(
                plan, changed, final_flag_node))
        return 1;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        conditional_select select;
        if (!pl_select_conditional_select_details(
                plan, plan->locals[local], local, &select)
                || !select.has_compare
                || select.compare_node != final_flag_node)
            continue;
        pl_u32 value_sources = 0u, owner_dependencies = 0u;
        if (!pl_select_conditional_select_gpr_sources(
                plan, plan->locals[local], local, &value_sources)
                || !pl_select_conditional_select_publication_dependencies(
                    plan, plan->locals[local], local,
                    &owner_dependencies))
            return 0;
        sources[local] = value_sources;
        dependencies[local] |= owner_dependencies;
    }
    return 1;
}

int pl_x86_select_alu_schedule_diagnostic(
    const pl_x86_block *block, pl_x86_alu_schedule_diagnostic *out)
{
    if (!block || !out) return PL_ERROR_X86_SELECT;
    *out = (pl_x86_alu_schedule_diagnostic){ 0 };
    if (!pl_select_alu_frame_shape(
            &block->plan, &out->changed, &out->final_flag_node)
            || !pl_select_alu_frame_source_laws(
                &block->plan, out->sources, out->dependencies))
        return PL_ERROR_X86_SELECT;
    pl_select_add_flag_chain_dependencies(
        &block->plan, out->final_flag_node, out->dependencies);
    if (!pl_select_apply_shared_flag_producer_laws(
            &block->plan, out->changed, out->final_flag_node,
            out->sources, out->dependencies))
        return PL_ERROR_X86_SELECT;
    if (!pl_select_apply_select_candidate_laws(
            &block->plan, out->changed, out->dependencies))
        return PL_ERROR_X86_SELECT;
    pl_operand result, prior;
    out->final_flag_owner = pl_select_flag_result_operand(
            &block->plan, out->final_flag_node, &result, &prior)
        ? pl_select_publication_owner(&block->plan, result)
        : PL_X86_GPR_COUNT;
    (void)prior;
    standalone_flag_publication standalone;
    if (!pl_select_publication_emits_flag_node(
            &block->plan, out->changed, out->final_flag_node)
            && !pl_select_flag_node_has_value_publication(
                &block->plan, out->changed, out->final_flag_node)
            && pl_select_standalone_flag_publication_details(
                &block->plan, out->final_flag_node, &standalone))
        out->standalone_flag_dependencies = standalone.entry_sources;
    return 0;
}

/* A conditional result and its final flag-producing value form one physical
 * cut, but CMOV needs that producer textually after both value arms.  Split
 * the normalized select into
 *
 *   current arm || candidate arm; final value+flags; CMOV
 *
 * when neither arm destroys an entry coordinate needed by the other or by
 * the flag producer.  This is a topology law: it applies to any exact ALU
 * producer and any independently materializable select arms, not to one
 * source instruction spelling. */
int pl_select_shared_flag_select_handoff_shape(
    const pl_plan *plan, pl_u32 changed, pl_u32 final_flag_node,
    shared_flag_select_handoff *out)
{
    if (!plan || !final_flag_node || !out) return 0;
    for (pl_u32 destination = 0u;
            destination < PL_X86_GPR_COUNT; ++destination) {
        if (!(changed & (1u << destination))) continue;
        conditional_select select;
        if (!pl_select_conditional_select_details(
                plan, plan->locals[destination], destination, &select)
                || !select.has_compare
                || select.compare_node != final_flag_node
                || select.candidate_local >= PL_X86_GPR_COUNT
                || select.candidate_local == destination
                || !(changed & (1u << select.candidate_local)))
            continue;
        pl_u32 flag_owner = PL_X86_GPR_COUNT;
        pl_operand flag_left = { 0 }, flag_right = { 0 };
        pl_u32 flag_bits = 0u, flag_mode = 0u, preserves_carry = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(changed & (1u << local)) || local == destination
                    || local == select.candidate_local
                    || !pl_select_publication_is_flag_result(
                        plan, plan->locals[local], final_flag_node))
                continue;
            pl_u32 operation_destination = PL_X86_GPR_COUNT;
            int operation = pl_select_alu_node_details(
                plan, final_flag_node, &operation_destination,
                &flag_left, &flag_right, &flag_bits,
                &flag_mode, &preserves_carry);
            if ((!operation || operation_destination != local)
                    && !pl_select_flag_value_operation_details(
                        plan, final_flag_node, plan->locals[local],
                        &flag_left, &flag_right, &flag_bits,
                        &flag_mode, &preserves_carry))
                continue;
            if (preserves_carry)
                continue;
            flag_owner = local;
            break;
        }
        if (flag_owner >= PL_X86_GPR_COUNT) continue;

        pl_u32 candidate_sources = 0u, current_sources = 0u;
        pl_u32 flag_sources = 0u;
        if (!pl_select_operand_gpr_sources(
                plan, plan->locals[select.candidate_local],
                plan->node_count + 1u, plan->node_count + 1u,
                &candidate_sources)
                || !pl_select_operand_gpr_sources(
                    plan, select.current,
                    plan->node_count + 1u, plan->node_count + 1u,
                    &current_sources)
                || !pl_select_operand_gpr_sources(
                    plan, flag_left,
                    plan->node_count + 1u, plan->node_count + 1u,
                    &flag_sources)
                || !pl_select_operand_gpr_sources(
                    plan, flag_right,
                    plan->node_count + 1u, plan->node_count + 1u,
                    &flag_sources))
            continue;
        const pl_u32 destination_bit = 1u << destination;
        const pl_u32 candidate_bit = 1u << select.candidate_local;
        if (flag_sources & (destination_bit | candidate_bit)) continue;
        const int candidate_first = !(current_sources & candidate_bit);
        const int current_first = !(candidate_sources & destination_bit);
        if (!candidate_first && !current_first) continue;

        out->destination = destination;
        out->candidate = select.candidate_local;
        out->flag_owner = flag_owner;
        out->bits = select.value_bits;
        out->flag_bits = flag_bits;
        out->flag_mode = flag_mode;
        out->candidate_first = candidate_first
            && (!current_first || (candidate_sources & destination_bit));
        out->select = select;
        out->flag_left = flag_left;
        out->flag_right = flag_right;
        return 1;
    }
    return 0;
}

/* XOR-zero is the shortest exact constant publication when every remaining
 * consumer redefines flags with its own CMP/TEST before observing them.  The
 * pending-set condition makes this a lifetime proof, not a generic
 * assumption that flags are dead. */
int pl_select_zero_internal_compare_consumers(const pl_plan *plan,
                                           pl_u32 zero_local,
                                           pl_u32 pending)
{
    if (!plan || zero_local >= PL_X86_GPR_COUNT
            || !(pending & (1u << zero_local)))
        return 0;
    pl_u32 consumers = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == zero_local || !(pending & (1u << local))) continue;
        conditional_select select;
        if (!pl_select_conditional_select_details(
                plan, plan->locals[local], local, &select)
                || !select.has_compare
                || select.candidate_local != zero_local)
            return 0;
        consumers |= 1u << local;
    }
    return consumers != 0u;
}
