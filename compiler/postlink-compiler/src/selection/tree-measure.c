/* tree-measure: native x86 selection. */
#include "tree-measure.h"
#include "limits.h"
#include "lea.h"
#include "encoding.h"
#include "expressions.h"
#include "operands.h"
#include "select-rules.h"
#include "source.h"
#include "tree-write.h"

/* Return only entry-GPR dependencies.  RFLAGS and the other machine locals
 * are observable inputs too, but they cannot be borrowed as x86 scratch
 * registers and therefore do not belong in this ownership mask. */
typedef struct {
    pl_u32 sources;
    pl_u32 depth;
} entry_source_row;

static int entry_source_operand_law(
    const pl_plan *plan, pl_operand value, pl_u32 available_nodes,
    const entry_source_row *row, pl_u32 *sources, pl_u32 *depth);

static void record_tree_rejection(pl_x86_native_selection *selection,
                                  pl_operand value, pl_u32 reason);

static int native_operand_confined_to_mask(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 outer_bits,
                                           pl_u64 mask);

static int emit_one_force_coordinate(pl_u32 destination, pl_u64 constant,
                                     pl_u32 bits, pl_u8 *output,
                                     pl_u32 *written);

static int measure_low32_entry_overlay(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    const low32_entry_overlay *shape, pl_u32 output_at,
    pl_u32 scratch_mask, pl_u32 *bytes, pl_u32 *instructions);

static pl_u32 entry_bit_chain_depth(const pl_plan *plan, pl_operand value, pl_u32 entry);

static int measure_entry_bit_overlay(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions);

int pl_select_measure_alu_seed(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand value,
                            pl_u32 bits, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 *bytes,
                            pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !bytes || !instructions
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    *bytes = 0u;
    *instructions = 0u;
    pl_select_physicalize_transient_operand(selection, &value);
    if (pl_select_emit_test_boolean(&block->plan, value, destination, 0, bytes)) {
        *instructions = 3u;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        if (value.value == destination) return 1;
        if (!pl_select_emit_gpr_move(destination, (pl_u32)value.value, bits,
                           (pl_u8 *)0, bytes))
            return 0;
        *instructions = 1u;
        return 1;
    }
    if (value.kind == PL_OPERAND_CONST) {
        if (bits == 8u || bits == 16u) {
            if (!pl_select_emit_lane_constant_move(destination, value.value, bits, 0, bytes))
                return 0;
            *instructions = 1u;
            return 1;
        }
        pl_u32 source_at = 0u;
        pl_u64 target = 0u;
        int address = pl_select_source_address_definition(
            frontend, block, selection, destination, value.value, bits,
            &target, &source_at);
        if (address < 0) return address;
        if (address) {
            /* Relocation acts on the full address before the lane projection.
             * LEA r32,[RIP+d32] performs that projection without an absolute
             * low-word literal or a second zero-extension instruction. */
            pl_u32 prefix = bits == 64u || destination >= 8u ? 1u : 0u;
            int status = pl_select_append_fixup(
                selection, PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT, 4u,
                output_at + prefix + 2u, output_at + prefix + 6u, target);
            if (status) return status;
            selection->fixups[selection->fixup_count - 1u].source_at =
                source_at;
            selection->fixups[selection->fixup_count - 1u].source_bytes = 4u;
            *bytes = prefix + 6u;
        } else {
            *bytes = pl_select_constant_move_bytes(destination, value.value);
        }
        *instructions = 1u;
        return 1;
    }
    /* Zero extension has the same one-instruction spelling inside an
     * expression as at a frame root. Its high zero fill is not a value to
     * materialize before the consuming arithmetic instruction. */
    pl_u32 extension_source = 0u, extension_bits = 0u;
    if (value.kind == PL_OPERAND_NODE
            && pl_select_zero_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits)) {
        if (!pl_select_emit_zero_extend_move(destination, extension_source, extension_bits,
                                    0, bytes)) return 0;
        *instructions = 1u;
        return 1;
    }
    if (value.kind == PL_OPERAND_NODE
            && pl_select_sign_extend_node(&block->plan, (pl_u32)value.value,
                                 &extension_source, &extension_bits)
            && extension_bits == 32u && bits == 32u) {
        if (!pl_select_emit_sign_extend_move(
                destination, extension_source, extension_bits, 0, bytes))
            return 0;
        *instructions = 1u;
        return 1;
    }
    pl_operand negation_source;
    pl_u32 negation_bits = 0u;
    if (pl_select_negation_node_details(
            &block->plan, value, &negation_source, &negation_bits)
            && negation_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 prefix = 0u, prefix_work = 0u;
        int status = pl_select_measure_alu_seed(
            frontend, block, selection, destination, negation_source,
            bits, output_at, remaining - 1u, &prefix, &prefix_work);
        pl_u32 operation = 0u;
        if (status <= 0
                || !pl_select_emit_neg_register(destination, bits, 0, &operation)
                || prefix > U32_MAX_VALUE - operation
                || prefix_work == U32_MAX_VALUE)
            return status < 0 ? status : 0;
        *bytes = prefix + operation;
        *instructions = prefix_work + 1u;
        return 1;
    }
    pl_operand complement_source;
    pl_u32 complement_bits = 0u;
    if (pl_select_complement_node_details(
            &block->plan, value, &complement_source, &complement_bits)
            && (complement_bits == bits
                || (bits == 32u && complement_bits == 64u))) {
        if (remaining <= 1u) return 0;
        pl_u32 prefix = 0u, prefix_instructions = 0u;
        int status = pl_select_measure_alu_seed(
            frontend, block, selection, destination, complement_source,
            bits, output_at, remaining - 1u,
            &prefix, &prefix_instructions);
        pl_u32 operation = 0u;
        if (status <= 0
                || !pl_select_emit_not_register(
                    destination, bits, (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation
                || prefix_instructions == U32_MAX_VALUE)
            return status < 0 ? status : 0;
        *bytes = prefix + operation;
        *instructions = prefix_instructions + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }
    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (pl_select_shift_node_details(
            &block->plan, value, &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            && shift_bits == bits) {
        if (remaining <= 1u) return 0;
        pl_u32 published = 0u;
        if ((shift_source.kind == PL_OPERAND_NODE
                || shift_source.kind == PL_OPERAND_PROJECTION)
                && pl_select_published_operand_local(
                    &block->plan, shift_source, &published)
                && published != destination) {
            shift_source.kind = PL_OPERAND_LOCAL;
            shift_source.value = published;
        }
        if (shift_amount.kind == PL_OPERAND_LOCAL
                && shift_amount.value == destination
                && !(shift_source.kind == PL_OPERAND_LOCAL
                    && shift_source.value == destination))
            return 0;
        pl_u32 count_mask = bits == 64u ? 63u : 31u;
        pl_u32 shifted_copy_bytes = 0u;
        if (shift_group == 4u
                && shift_source.kind == PL_OPERAND_LOCAL
                && shift_source.value != destination
                && shift_amount.kind == PL_OPERAND_CONST
                && !pl_select_final_flags_are_shift(&block->plan)
                && pl_select_emit_shifted_copy(
                    destination, (pl_u32)shift_source.value, bits,
                    (pl_u32)shift_amount.value & count_mask,
                    (pl_u8 *)0, &shifted_copy_bytes)) {
            *bytes = shifted_copy_bytes;
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        pl_u32 prefix = 0u, prefix_instructions = 0u;
        int status = pl_select_measure_alu_seed(
            frontend, block, selection, destination, shift_source, bits,
            output_at, remaining - 1u, &prefix, &prefix_instructions);
        pl_u32 operation = 0u;
        if (status <= 0
                || !pl_select_emit_shift_instruction(
                    destination, shift_amount, bits, shift_group,
                    (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation
                || prefix_instructions == U32_MAX_VALUE)
            return status < 0 ? status : 0;
        *bytes = prefix + operation;
        *instructions = prefix_instructions + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }
    affine_lea form = { 0 };
    if (pl_select_collect_affine_lea_width(
            &block->plan, value, bits, remaining, &form)
            && pl_select_emit_affine_lea_width(
                destination, form, bits, (pl_u8 *)0, bytes)) {
        *instructions = 1u;
        return 1;
    }
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    /* Decode the semantic pair before requiring a native right operand.
     * Either child may already have one final published owner; resolving it
     * below turns the whole expression into one flag-preserving LEA instead
     * of rebuilding the child and clobbering a later observed RFLAGS value. */
    if (!pl_select_arithmetic_tree_details(
            &block->plan, value, &left, &right, &node_bits, &mode))
        return 0;
    pl_select_physicalize_selected_operand(
        &block->plan, selection, destination, &left);
    pl_select_physicalize_selected_operand(
        &block->plan, selection, destination, &right);
    pl_select_orient_commutative_destination(
        &block->plan, destination, mode, &left, &right);
    if (mode == 1u && pl_select_emit_add_lea(
            destination, left, right, node_bits, 0, bytes)) {
        *instructions = 1u;
        return 1;
    }
    if ((right.kind == PL_OPERAND_LOCAL
                && right.value == destination
                && !(left.kind == PL_OPERAND_LOCAL
                     && left.value == destination)))
        return 0;
    pl_u32 prefix = 0u, prefix_instructions = 0u;
    pl_u32 left_bits = pl_select_operand_expression_bits(
        &block->plan, left, node_bits);
    int status = pl_select_measure_alu_seed(
        frontend, block, selection, destination, left, left_bits, output_at,
        remaining - 1u, &prefix, &prefix_instructions);
    if (status <= 0) return status;
    pl_u32 operation = 0u;
    if (!pl_select_emit_alu_instruction(destination, right, node_bits, mode, 0u,
                              (pl_u8 *)0, &operation)
            || prefix > U32_MAX_VALUE - operation)
        return 0;
    *bytes = prefix + operation;
    *instructions = prefix_instructions + 1u;
    return 1;
}

static int entry_source_operand_law(
    const pl_plan *plan, pl_operand value, pl_u32 available_nodes,
    const entry_source_row *row, pl_u32 *sources, pl_u32 *depth)
{
    if (!plan || !sources || !depth) return 0;
    if (value.kind == PL_OPERAND_CONST) {
        *sources = 0u;
        *depth = 1u;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= plan->local_count) return 0;
        *sources = value.value < PL_X86_GPR_COUNT
                 ? 1u << (pl_u32)value.value : 0u;
        *depth = 1u;
        return 1;
    }
    pl_u32 node = value.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(value.value >> 8u)
                : value.kind == PL_OPERAND_NODE
                ? (pl_u32)value.value : 0u;
    if (!node || node > available_nodes || !row || !row[node - 1u].depth)
        return 0;
    *sources = row[node - 1u].sources;
    *depth = row[node - 1u].depth;
    return 1;
}

int pl_select_operand_entry_gpr_sources(const pl_plan *plan, pl_operand value,
                                     pl_u32 before_node, pl_u32 remaining,
                                     pl_u32 *sources)
{
    if (!plan || !sources || !remaining || !before_node) return 0;
    pl_u32 available = before_node - 1u;
    if (available > plan->node_count) available = plan->node_count;
    entry_source_row row[available ? available : 1u];
    for (pl_u32 node_number = 1u; node_number <= available; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        entry_source_row *current = &row[node_number - 1u];
        *current = (entry_source_row){ 0u, 0u };
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            continue;
        pl_u32 law = 0u;
        pl_u32 depth = 1u;
        int valid = 1;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u, part_depth = 0u;
            if (!entry_source_operand_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_number - 1u, row, &part, &part_depth)) {
                valid = 0;
                break;
            }
            law |= part;
            if (part_depth >= depth) {
                if (part_depth == 0xffffffffu) {
                    valid = 0;
                    break;
                }
                depth = part_depth + 1u;
            }
        }
        if (valid) *current = (entry_source_row){ law, depth };
    }
    pl_u32 law = 0u, depth = 0u;
    if (!entry_source_operand_law(
            plan, value, available, row, &law, &depth)
            || depth > remaining)
        return 0;
    *sources |= law;
    return 1;
}

int pl_select_operand_entry_sources_without(
    const pl_plan *plan, pl_operand value, pl_operand excluded,
    pl_u32 before_node, pl_u32 remaining, int expand_root,
    pl_u32 *sources)
{
    if (!plan || !sources || !remaining) return 0;
    if (value.kind == excluded.kind && value.value == excluded.value)
        return 1;
    if (value.kind == PL_OPERAND_CONST) return 1;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value < PL_X86_GPR_COUNT)
            *sources |= 1u << (pl_u32)value.value;
        return value.value < plan->local_count;
    }
    pl_u32 node_number = value.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(value.value >> 8u)
                       : value.kind == PL_OPERAND_NODE
                       ? (pl_u32)value.value : 0u;
    if (!node_number || node_number >= before_node
            || node_number > plan->node_count)
        return 0;
    if (!expand_root
            && pl_select_publication_owner(plan, value) < PL_X86_GPR_COUNT)
        return 1;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (node->argument_count == 3u
            && pl_select_arithmetic_tree_details(plan, value, &left, &right, &bits, &mode))
        return pl_select_operand_entry_sources_without(plan, left, excluded, node_number,
                   remaining - 1u, 0, sources)
            && pl_select_operand_entry_sources_without(plan, right, excluded, node_number,
                   remaining - 1u, 0, sources);
    for (pl_u32 argument = 0u;
            argument < node->argument_count; ++argument)
        if (!pl_select_operand_entry_sources_without(
                plan, plan->arguments[node->argument_at + argument],
                excluded, node_number, remaining - 1u, 0, sources))
            return 0;
    return 1;
}

int pl_select_operand_contains_unpublished_value(
    const pl_plan *plan, pl_operand root, pl_operand value,
    pl_u32 remaining, int expand_root)
{
    if (!plan || !remaining) return 0;
    if (root.kind == value.kind && root.value == value.value) return 1;
    pl_u32 node_number = root.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(root.value >> 8u)
                       : root.kind == PL_OPERAND_NODE
                       ? (pl_u32)root.value : 0u;
    if (!node_number || node_number > plan->node_count) return 0;
    if (!expand_root
            && pl_select_publication_owner(plan, root) < PL_X86_GPR_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (node->argument_count == 3u
            && pl_select_arithmetic_tree_details(plan, root, &left, &right, &bits, &mode))
        return pl_select_operand_contains_unpublished_value(plan, left, value, remaining - 1u, 0)
            || pl_select_operand_contains_unpublished_value(plan, right, value, remaining - 1u, 0);
    for (pl_u32 argument = 0u;
            argument < node->argument_count; ++argument)
        if (pl_select_operand_contains_unpublished_value(
                plan, plan->arguments[node->argument_at + argument],
                value, remaining - 1u, 0))
            return 1;
    return 0;
}

static void record_tree_rejection(pl_x86_native_selection *selection,
                                  pl_operand value, pl_u32 reason)
{
    if (!selection || selection->blocking_opcode != U32_MAX_VALUE) return;
    pl_u32 node = value.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(value.value >> 8u)
                : value.kind == PL_OPERAND_NODE
                ? (pl_u32)value.value : 0u;
    selection->blocking_opcode = (reason << 24u) | (node & 0x00ffffffu);
}

int pl_select_associative_mode(pl_u32 mode)
{
    return mode == 0u || mode == 1u || mode == 5u || mode == 6u;
}

/* Keep the condition as flags instead of materializing its 0/1 value.
 *
 *     x | select(mask, 0, condition)
 *
 * has one physical accumulator and one conditional accumulator.  Building
 * the selected mask first would create a value which is dead immediately
 * after the OR.  The equivalent spelling copies x, ORs the mask into that
 * copy, produces the condition flags last, and conditionally publishes the
 * copy.  This removes the transient boolean for every such SSA topology. */
int pl_select_conditional_or_fold_details(
    const pl_plan *plan, pl_operand left, pl_operand right,
    pl_u32 bits, pl_u32 mode, conditional_or_fold *out)
{
    if (!plan || !out || mode != 5u) return 0;
    for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
        pl_operand base = orientation ? right : left;
        pl_operand selected = orientation ? left : right;
        boolean_select select;
        if (!pl_select_boolean_select_details(plan, selected, &select)
                || select.value_bits != bits)
            continue;
        pl_operand mask;
        pl_u32 inverse = 0u;
        if (select.when_true.kind == PL_OPERAND_CONST
                && select.when_true.value
                && select.when_false.kind == PL_OPERAND_CONST
                && !select.when_false.value) {
            mask = select.when_true;
        } else if (select.when_true.kind == PL_OPERAND_CONST
                && !select.when_true.value
                && select.when_false.kind == PL_OPERAND_CONST
                && select.when_false.value) {
            mask = select.when_false;
            inverse = 1u;
        } else {
            continue;
        }
        condition_value condition;
        if (!pl_select_condition_value_details(plan, select.condition, &condition)
                || !pl_select_flag_operation_details(
                    plan, condition.flags, &out->flag_left,
                    &out->flag_right, &out->flag_bits, &out->flag_mode,
                    &out->preserves_carry))
            continue;
        out->base = base;
        out->mask = mask;
        out->bits = bits;
        out->condition = condition.condition ^ inverse;
        return 1;
    }
    return 0;
}

int pl_select_collect_associative_leaves(const pl_plan *plan,
                                      pl_operand value,
                                      pl_u32 bits, pl_u32 mode,
                                      pl_operand *leaves,
                                      pl_u32 capacity, pl_u32 *count,
                                      pl_u32 remaining)
{
    if (!plan || !leaves || !count || !remaining) return 0;
    pl_operand left, right;
    pl_u32 node_bits = 0u, node_mode = 0u;
    if (pl_select_arithmetic_tree_details(
            plan, value, &left, &right, &node_bits, &node_mode)
            && node_bits == bits && node_mode == mode) {
        return pl_select_collect_associative_leaves(
                   plan, left, bits, mode, leaves, capacity, count,
                   remaining - 1u)
            && pl_select_collect_associative_leaves(
                   plan, right, bits, mode, leaves, capacity, count,
                   remaining - 1u);
    }
    if (*count >= capacity) return 0;
    leaves[(*count)++] = value;
    return 1;
}

/* A commutative reduction rooted at an architectural destination starts from
 * that entry coordinate.  Keeping a source-tree leaf ahead of it forces a
 * transient copy and may add one dependency wave before the first join. */
void pl_select_promote_associative_destination_leaf(
    pl_operand *leaves, pl_u32 count, pl_u32 destination)
{
    if (!leaves || destination >= PL_X86_GPR_COUNT) return;
    for (pl_u32 at = 0u; at < count; ++at) {
        if (leaves[at].kind != PL_OPERAND_LOCAL
                || leaves[at].value != destination)
            continue;
        pl_operand swap = leaves[0];
        leaves[0] = leaves[at];
        leaves[at] = swap;
        return;
    }
}

/* (entry & mask) | constant equals (entry & mask) + constant exactly when
 * their bit supports are disjoint.  This lets a disposable entry owner carry
 * the mask while LEA publishes the final coordinate without another flag
 * producer or scalar materialization. */
int pl_select_masked_entry_affine_details(
    const pl_plan *plan, pl_operand value, pl_u32 destination,
    masked_entry_affine *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST) return 0;
    pl_operand source, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, masked, &source, &mask, &mask_bits, &mask_mode)
            || mask_bits != bits || mask_mode != 0u)
        return 0;
    if (source.kind == PL_OPERAND_CONST) {
        pl_operand swap = source; source = mask; mask = swap;
    }
    if (source.kind != PL_OPERAND_LOCAL
            || source.value >= PL_X86_GPR_COUNT
            || source.value == destination
            || mask.kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 bounded_mask = mask.value & word;
    pl_u64 bounded_constant = constant.value & word;
    if (bounded_mask & bounded_constant) return 0;
    out->destination = destination;
    out->source = (pl_u32)source.value;
    out->mask = bounded_mask;
    out->constant = bounded_constant;
    out->bits = bits;
    return 1;
}

int pl_select_emit_masked_entry_affine(
    const masked_entry_affine *shape, pl_u8 *output,
    pl_u32 *written, pl_u32 *instructions)
{
    if (!shape || !written || !instructions) return 0;
    pl_operand mask = { PL_OPERAND_CONST, shape->mask };
    pl_u32 first = 0u;
    if (!pl_select_emit_alu_instruction(
            shape->source, mask, shape->bits, 0u, 0u,
            output, &first))
        return 0;
    pl_operand source = { PL_OPERAND_LOCAL, shape->source };
    pl_operand constant = { PL_OPERAND_CONST, shape->constant };
    pl_u32 second = 0u;
    if (!pl_select_emit_add_lea(
            shape->destination, source, constant, shape->bits,
            output ? output + first : (pl_u8 *)0, &second)
            || first > U32_MAX_VALUE - second)
        return 0;
    *written = first + second;
    *instructions = 2u;
    return 1;
}

static int native_operand_confined_to_mask(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 outer_bits,
                                           pl_u64 mask)
{
    if (!plan || (outer_bits != 32u && outer_bits != 64u)) return 0;
    pl_u64 word = outer_bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    if (value.kind == PL_OPERAND_CONST)
        return !((value.value & word) & ~mask);
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &left, &right, &bits, &mode)
            || mode != 0u || (bits != outer_bits
                && !(outer_bits == 64u && bits == 32u)))
        return 0;
    pl_operand bound = left.kind == PL_OPERAND_CONST ? left : right;
    if (bound.kind != PL_OPERAND_CONST) return 0;
    pl_u64 support = bound.value
                   & (bits == 64u ? U64_MAX_VALUE : 0xffffffffu);
    return !(support & ~mask);
}

/* Recognize the exact overlay law
 *
 *   ((base | side) & mask) | constant
 *     = ((base & mask) | constant) | side
 *
 * when `side` has no possible one outside mask.  Restricting base to an
 * entry GPR gives native selection a real destructive accumulator without
 * inventing a transient value. */
int pl_select_entry_bit_overlay_details(const pl_plan *plan,
                                     pl_operand value,
                                     entry_bit_overlay *out)
{
    if (!plan || !out) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST) return 0;

    pl_operand joined, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, masked, &joined, &mask, &mask_bits, &mask_mode)
            || mask_bits != bits || mask_mode != 0u)
        return 0;
    if (joined.kind == PL_OPERAND_CONST) {
        pl_operand swap = joined; joined = mask; mask = swap;
    }
    if (mask.kind != PL_OPERAND_CONST) return 0;

    pl_operand first, second;
    pl_u32 join_bits = 0u, join_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, joined, &first, &second, &join_bits, &join_mode)
            || join_bits != bits || join_mode != 5u)
        return 0;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 variable_mask = mask.value & word;
    pl_u32 side = native_operand_confined_to_mask(
                      plan, second, bits, variable_mask)
                ? 1u
                : native_operand_confined_to_mask(
                      plan, first, bits, variable_mask)
                ? 0u : 2u;
    if (side > 1u) return 0;
    pl_operand base = side ? first : second;
    if (base.kind != PL_OPERAND_LOCAL
            || base.value >= PL_X86_GPR_COUNT)
        return 0;
    *out = (entry_bit_overlay){
        base, side ? second : first,
        variable_mask, constant.value & word, bits,
    };
    return 1;
}

static int emit_one_force_coordinate(pl_u32 destination, pl_u64 constant,
                                     pl_u32 bits, pl_u8 *output,
                                     pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u))
        return 0;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    constant &= word;
    if (!constant) {
        *written = 0u;
        return 1;
    }
    pl_operand immediate = { PL_OPERAND_CONST, constant };
    if (pl_select_emit_alu_value_instruction(
            destination, immediate, bits, 5u, 0u, output, written))
        return 1;
    if (constant & (constant - 1u)) return 0;
    pl_u32 bit = 0u;
    while (bit < bits && !(constant & (1ull << bit))) ++bit;
    return bit < bits && pl_select_emit_bit_set_immediate(
        destination, bit, bits, output, written);
}

/* Partition the forced constant across two disposable entry owners:
 *
 *   ((a | b) & m) | c
 *     = ((a | ca) | (b | cb)) & (m | c),  ca | cb = c.
 *
 * If each non-empty partition is one native coordinate and m|c is an
 * immediate AND, four work coordinates attain three waves: both forces,
 * join, final mask. */
int pl_select_split_entry_overlay_details(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       split_entry_overlay *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST || !constant.value) return 0;
    pl_operand joined, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, masked, &joined, &mask, &mask_bits, &mask_mode)
            || mask_bits != bits || mask_mode != 0u)
        return 0;
    if (joined.kind == PL_OPERAND_CONST) {
        pl_operand swap = joined; joined = mask; mask = swap;
    }
    if (mask.kind != PL_OPERAND_CONST) return 0;
    pl_operand first, second;
    pl_u32 join_bits = 0u, join_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, joined, &first, &second, &join_bits, &join_mode)
            || join_bits != bits || join_mode != 5u
            || first.kind != PL_OPERAND_LOCAL
            || second.kind != PL_OPERAND_LOCAL
            || first.value >= PL_X86_GPR_COUNT
            || second.value >= PL_X86_GPR_COUNT
            || first.value == second.value)
        return 0;
    pl_u32 base = first.value == destination ? (pl_u32)first.value
                : second.value == destination ? (pl_u32)second.value
                : PL_X86_GPR_COUNT;
    if (base >= PL_X86_GPR_COUNT) return 0;
    pl_u32 side = base == first.value
                ? (pl_u32)second.value : (pl_u32)first.value;
    pl_u64 word = bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 forced = constant.value & word;
    pl_u64 final_mask = ((mask.value & word) | forced) & word;
    pl_operand final_immediate = { PL_OPERAND_CONST, final_mask };
    pl_u32 final_bytes = 0u;
    if (final_mask != word
            && !pl_select_emit_alu_instruction(
                destination, final_immediate, bits, 0u, 0u,
                (pl_u8 *)0, &final_bytes))
        return 0;

    pl_u32 best_bytes = U32_MAX_VALUE;
    pl_u64 best_side = 0u;
    for (pl_u32 choice = 0u; choice <= bits + 1u; ++choice) {
        pl_u64 side_constant = choice == 0u ? 0u
                             : choice == bits + 1u ? forced
                             : forced & (1ull << (choice - 1u));
        if (choice > 0u && choice <= bits && !side_constant) continue;
        pl_u64 base_constant = forced & ~side_constant;
        pl_u32 base_bytes = 0u, side_bytes = 0u;
        if (!emit_one_force_coordinate(
                base, base_constant, bits, (pl_u8 *)0, &base_bytes)
                || !emit_one_force_coordinate(
                    side, side_constant, bits, (pl_u8 *)0, &side_bytes)
                || base_bytes > U32_MAX_VALUE - side_bytes)
            continue;
        pl_u32 candidate_bytes = base_bytes + side_bytes;
        if (candidate_bytes < best_bytes) {
            best_bytes = candidate_bytes;
            best_side = side_constant;
        }
    }
    if (best_bytes == U32_MAX_VALUE) return 0;
    *out = (split_entry_overlay){
        base, side, bits, forced & ~best_side, best_side, final_mask,
    };
    return 1;
}

int pl_select_emit_split_entry_overlay(const split_entry_overlay *shape,
                                    pl_u8 *output, pl_u32 *written,
                                    pl_u32 *instructions)
{
    if (!shape || !written || !instructions) return 0;
    pl_u32 at = 0u, part = 0u, work = 0u;
    if (!emit_one_force_coordinate(
            shape->base, shape->base_constant, shape->bits,
            output, &part))
        return 0;
    at += part;
    work += shape->base_constant != 0u;
    if (!emit_one_force_coordinate(
            shape->side, shape->side_constant, shape->bits,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    work += shape->side_constant != 0u;
    pl_operand side = { PL_OPERAND_LOCAL, shape->side };
    if (!pl_select_emit_alu_instruction(
            shape->base, side, shape->bits, 5u, 0u,
            output ? output + at : (pl_u8 *)0, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    at += part;
    ++work;
    pl_u64 word = shape->bits == 64u ? U64_MAX_VALUE : 0xffffffffu;
    if (shape->final_mask != word) {
        pl_operand mask = { PL_OPERAND_CONST, shape->final_mask };
        if (!pl_select_emit_alu_instruction(
                shape->base, mask, shape->bits, 0u, 0u,
                output ? output + at : (pl_u8 *)0, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
        ++work;
    }
    *written = at;
    *instructions = work;
    return 1;
}

/* A 32-bit join is already zero-extended before a later 64-bit overlay.
 * Consequently only the low word of the outer mask is observable:
 *
 *   (zext32(a|b) & m64) | c64
 *     = (zext32(a|b) & low32(m64)) | c64.
 */
int pl_select_low32_entry_overlay_details(const pl_plan *plan,
                                       pl_operand value,
                                       pl_u32 destination,
                                       low32_entry_overlay *out)
{
    if (!plan || !out || destination >= PL_X86_GPR_COUNT) return 0;
    pl_operand masked, constant;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &masked, &constant, &bits, &mode)
            || bits != 64u || mode != 5u)
        return 0;
    if (masked.kind == PL_OPERAND_CONST) {
        pl_operand swap = masked; masked = constant; constant = swap;
    }
    if (constant.kind != PL_OPERAND_CONST || !constant.value) return 0;
    pl_operand joined, mask;
    pl_u32 mask_bits = 0u, mask_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, masked, &joined, &mask, &mask_bits, &mask_mode)
            || mask_bits != 64u || mask_mode != 0u)
        return 0;
    if (joined.kind == PL_OPERAND_CONST) {
        pl_operand swap = joined; joined = mask; mask = swap;
    }
    if (mask.kind != PL_OPERAND_CONST) return 0;
    pl_operand first, second;
    pl_u32 join_bits = 0u, join_mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, joined, &first, &second, &join_bits, &join_mode)
            || join_bits != 32u || join_mode != 5u
            || first.kind != PL_OPERAND_LOCAL
            || second.kind != PL_OPERAND_LOCAL
            || first.value >= PL_X86_GPR_COUNT
            || second.value >= PL_X86_GPR_COUNT
            || first.value == second.value)
        return 0;
    pl_u32 base = first.value == destination ? (pl_u32)first.value
                : second.value == destination ? (pl_u32)second.value
                : PL_X86_GPR_COUNT;
    if (base >= PL_X86_GPR_COUNT) return 0;
    *out = (low32_entry_overlay){
        base,
        base == first.value ? (pl_u32)second.value : (pl_u32)first.value,
        mask.value & 0xffffffffu,
        constant.value,
    };
    return 1;
}

static int measure_low32_entry_overlay(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    const low32_entry_overlay *shape, pl_u32 output_at,
    pl_u32 scratch_mask, pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !shape || !bytes
            || !instructions
            || !(scratch_mask & (1u << shape->side)))
        return 0;
    pl_operand side = { PL_OPERAND_LOCAL, shape->side };
    pl_u32 at = 0u, part = 0u, work = 0u;
    if (!pl_select_emit_alu_instruction(
            shape->base, side, 32u, 5u, 0u,
            (pl_u8 *)0, &part))
        return 0;
    at += part;
    ++work;
    if (shape->low_mask != 0xffffffffu) {
        pl_operand mask = { PL_OPERAND_CONST, shape->low_mask };
        if (!pl_select_emit_alu_instruction(
                shape->base, mask, 32u, 0u, 0u,
                (pl_u8 *)0, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
        ++work;
    }
    pl_operand constant = { PL_OPERAND_CONST, shape->constant };
    if (pl_select_emit_alu_value_instruction(
            shape->base, constant, 64u, 5u, 0u,
            (pl_u8 *)0, &part)) {
        if (at > U32_MAX_VALUE - part) return 0;
        *bytes = at + part;
        *instructions = work + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }
    if (at > U32_MAX_VALUE - output_at) return 0;
    pl_u32 constant_bytes = 0u, constant_work = 0u;
    int status = pl_select_measure_alu_seed(
        frontend, block, selection, shape->side, constant, 64u,
        output_at + at, block->plan.node_count + 1u,
        &constant_bytes, &constant_work);
    pl_u32 join = 0u;
    if (status <= 0
            || !pl_select_emit_alu_instruction(
                shape->base, side, 64u, 5u, 0u,
                (pl_u8 *)0, &join)
            || at > U32_MAX_VALUE - constant_bytes
            || at + constant_bytes > U32_MAX_VALUE - join
            || work > U32_MAX_VALUE - constant_work
            || work + constant_work == U32_MAX_VALUE)
        return status < 0 ? status : 0;
    *bytes = at + constant_bytes + join;
    *instructions = work + constant_work + 1u;
    selection->direct_nested_frame = 1u;
    return 1;
}

int pl_select_write_low32_entry_overlay(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection,
    const low32_entry_overlay *shape, pl_u32 output_at,
    pl_u32 scratch_mask, pl_u8 *output, pl_u32 *written)
{
    if (!block || !selection || !shape || !output || !written
            || !(scratch_mask & (1u << shape->side)))
        return 0;
    pl_operand side = { PL_OPERAND_LOCAL, shape->side };
    pl_u32 at = 0u, part = 0u;
    if (!pl_select_emit_alu_instruction(
            shape->base, side, 32u, 5u, 0u, output, &part))
        return 0;
    at += part;
    if (shape->low_mask != 0xffffffffu) {
        pl_operand mask = { PL_OPERAND_CONST, shape->low_mask };
        if (!pl_select_emit_alu_instruction(
                shape->base, mask, 32u, 0u, 0u,
                output + at, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
    }
    pl_operand constant = { PL_OPERAND_CONST, shape->constant };
    if (pl_select_emit_alu_value_instruction(
            shape->base, constant, 64u, 5u, 0u,
            output + at, &part)) {
        if (at > U32_MAX_VALUE - part) return 0;
        *written = at + part;
        return 1;
    }
    if (at > U32_MAX_VALUE - output_at
            || !pl_select_write_alu_seed(
                block, selection, shape->side, constant, 64u,
                output_at + at, block->plan.node_count + 1u,
                output + at, &part))
        return 0;
    at += part;
    if (!pl_select_emit_alu_instruction(
            shape->base, side, 64u, 5u, 0u,
            output + at, &part)
            || at > U32_MAX_VALUE - part)
        return 0;
    *written = at + part;
    return 1;
}

/* Emit the shortest bounded x86 realization of `(x & mask) | constant`
 * used before a final OR join.  OR-immediate is preferred; otherwise at most
 * two high constant bits become BTS coordinates and the low positive imm32
 * remains one OR.  AND uses mask|constant because forced bits need not be
 * cleared first. */
int pl_select_emit_entry_bit_overlay(pl_u32 destination,
                                  const entry_bit_overlay *shape,
                                  pl_u8 *output, pl_u32 *written,
                                  pl_u32 *instructions)
{
    if (!shape || !written || !instructions
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u64 word = shape->bits == 64u
                ? U64_MAX_VALUE : 0xffffffffu;
    pl_u64 constant = shape->constant & word;
    pl_u32 at = 0u, part = 0u, work = 0u;
    if (constant) {
        pl_operand immediate = { PL_OPERAND_CONST, constant };
        if (pl_select_emit_alu_value_instruction(
                destination, immediate, shape->bits, 5u, 0u,
                output, &part)) {
            at += part;
            ++work;
        } else {
            pl_u64 low = constant & I32_MAX_VALUE;
            pl_u64 high = constant & ~((pl_u64)I32_MAX_VALUE);
            pl_u32 high_count = 0u;
            for (pl_u32 bit = 0u; bit < shape->bits; ++bit)
                high_count += (pl_u32)((high >> bit) & 1u);
            if (!high_count || high_count > 2u) return 0;
            for (pl_u32 bit = 0u; bit < shape->bits; ++bit) {
                if (!(high & (1ull << bit))) continue;
                if (!pl_select_emit_bit_set_immediate(
                        destination, bit, shape->bits,
                        output ? output + at : (pl_u8 *)0, &part)
                        || at > U32_MAX_VALUE - part)
                    return 0;
                at += part;
                ++work;
            }
            if (low) {
                immediate.value = low;
                if (!pl_select_emit_alu_value_instruction(
                        destination, immediate, shape->bits, 5u, 0u,
                        output ? output + at : (pl_u8 *)0, &part)
                        || at > U32_MAX_VALUE - part)
                    return 0;
                at += part;
                ++work;
            }
        }
    }
    pl_u64 expanded = (shape->variable_mask | constant) & word;
    if (expanded != word) {
        pl_operand immediate = { PL_OPERAND_CONST, expanded };
        if (!pl_select_emit_alu_instruction(
                destination, immediate, shape->bits, 0u, 0u,
                output ? output + at : (pl_u8 *)0, &part)
                || at > U32_MAX_VALUE - part)
            return 0;
        at += part;
        ++work;
    }
    *written = at;
    *instructions = work;
    return work != 0u;
}

/* Signed and unsigned multiplication have the same low word modulo 2^w.
 * This production only consumes that pure word; live multiply flags/high
 * words retain their distinct architectural producers. */
int pl_select_multiply_word_operands(
    const pl_plan *plan, const pl_x86_native_selection *selection,
    pl_operand value, pl_u32 destination, pl_operand *left,
    pl_operand *right, pl_u32 *bits)
{
    if (!plan || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    *bits = node->opcode == PL_OPCODE_MULR ? 64u
          : node->opcode == PL_OPCODE_LANE32_MULR ? 32u : 0u;
    if (!*bits || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || 2u > plan->argument_count - node->argument_at) return 0;
    *left = plan->arguments[node->argument_at];
    *right = plan->arguments[node->argument_at + 1u];
    if (left->kind == PL_OPERAND_CONST && right->kind != PL_OPERAND_CONST) {
        pl_operand swap = *left; *left = *right; *right = swap;
    }
    pl_u32 immediate_bytes = 0u;
    if (right->kind == PL_OPERAND_CONST
            && pl_select_emit_imul_operand(destination, destination, *right, *bits, 0, &immediate_bytes)) {
        pl_select_physicalize_selected_operand(plan, selection, destination, left);
        return 1;
    }
    pl_select_physicalize_selected_operand(plan, selection, destination, left);
    pl_select_physicalize_selected_operand(plan, selection, destination, right);
    if ((right->kind == PL_OPERAND_LOCAL && right->value == destination)
            || (right->kind != PL_OPERAND_LOCAL && left->kind == PL_OPERAND_LOCAL)) {
        pl_operand swap = *left; *left = *right; *right = swap;
    }
    return right->kind == PL_OPERAND_LOCAL && right->value < PL_X86_GPR_COUNT;
}

int pl_select_multiply_immediate_source(const pl_plan *plan, pl_operand left,
                                      pl_operand right, pl_u32 bits, pl_u32 *source)
{
    if (right.kind != PL_OPERAND_CONST) return 0;
    if (left.kind == PL_OPERAND_LOCAL && left.value < PL_X86_GPR_COUNT) {
        *source = (pl_u32)left.value;
        return 1;
    }
    pl_u32 width = 0u;
    return left.kind == PL_OPERAND_NODE
        && pl_select_zero_extend_node(plan, (pl_u32)left.value, source, &width)
        && width >= bits;
}

static pl_u32 entry_bit_chain_depth(const pl_plan *plan, pl_operand value, pl_u32 entry)
{
    pl_u32 depth = 0u;
    for (pl_u32 remaining = plan->node_count + 1u; remaining; --remaining) {
        if (value.kind == PL_OPERAND_LOCAL) return value.value == entry ? depth : 0u;
        pl_operand source, right;
        pl_u32 bits = 0u, mode = 0u, bytes = 0u;
        if (pl_select_arithmetic_tree_details(plan, value, &source, &right, &bits, &mode)
                && (mode == 0u || mode == 5u || mode == 6u)
                && right.kind == PL_OPERAND_CONST
                && pl_select_emit_alu_instruction(entry, right, bits, mode, 0u, 0, &bytes)) {
            value = source;
        } else if (pl_select_shift_node_details(plan, value, &source, &right, &bits, &mode)
                && right.kind == PL_OPERAND_CONST && (right.value & (bits - 1u))
                && pl_select_emit_shift_instruction(entry, right, bits, mode, 0, &bytes)) {
            value = source;
        } else return 0u;
        ++depth;
    }
    return 0u;
}

/* Both bit chains start at the same entry coordinate. A clone adds one
 * publication wave to exactly one arm: min(max(a+1,b),max(a,b+1)) clones
 * the shorter arm. Keep the longer chain on the original owner, with no
 * extra work. Measurement and emission use the same bounded chain walk. */
pl_u32 pl_select_entry_bit_chain_orientation(const pl_plan *plan, pl_operand left,
                                           pl_operand right, pl_u32 destination,
                                           pl_u32 mode)
{
    if (mode != 0u && mode != 5u && mode != 6u) return 0u;
    pl_u32 a = entry_bit_chain_depth(plan, left, destination);
    pl_u32 b = entry_bit_chain_depth(plan, right, destination);
    return a && b && a < b;
}

/* A diamond q OP shift(q,k) has one producer, not two expression trees.
 * After producing q, its entry operands are dead inside this expression.
 * The caller's scratch mask must separately prove their external lifetime. */
int pl_select_shared_shift_join(const pl_plan *plan, pl_operand value, pl_u32 bits,
                             pl_operand *seed, pl_operand *amount,
                             pl_u32 *group, pl_u32 *mode)
{
    pl_operand left, right;
    pl_u32 width = 0u;
    if (!pl_select_arithmetic_tree_details(plan, value, &left, &right, &width, mode)
            || width != bits) return 0;
    for (pl_u32 reverse = 0u; reverse < 2u; ++reverse) {
        if (reverse && !pl_select_associative_mode(*mode)) continue;
        pl_operand parent = reverse ? right : left;
        pl_operand shifted = reverse ? left : right;
        if (pl_select_shift_node_details(plan, shifted, seed, amount, &width, group)
                && width == bits && amount->kind == PL_OPERAND_CONST
                && seed->kind == parent.kind && seed->value == parent.value)
            return 1;
    }
    return 0;
}

int pl_select_emit_shared_shift_join(pl_u32 destination, pl_u32 scratch,
                                  pl_operand amount, pl_u32 bits,
                                  pl_u32 group, pl_u32 mode,
                                  pl_u8 *output, pl_u32 *written)
{
    pl_u32 copy = 0u, shift = 0u, join = 0u;
    pl_operand temporary = { PL_OPERAND_LOCAL, scratch };
    if (!pl_select_emit_gpr_move(scratch, destination, bits, output, &copy)
            || !pl_select_emit_shift_instruction(scratch, amount, bits, group,
                output ? output + copy : 0, &shift)
            || !pl_select_emit_alu_instruction(destination, temporary, bits, mode, 0u,
                output ? output + copy + shift : 0, &join)) return 0;
    *written = copy + shift + join;
    return 1;
}

int pl_select_measure_alu_tree(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand value,
                            pl_u32 bits, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 scratch_mask,
                            pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !bytes || !instructions
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    /* This grammar recursively explores alternative spellings of a shared
     * SSA DAG. Bound exploration, not executable semantics: when it runs out,
     * the exact source-x86 candidate and the separate shared-DAG grammar
     * remain available. No compiler invocation can spend exponential work
     * rediscovering the same common subexpression. */
    if (selection->tree_visits >= 4096u) return 0;
    ++selection->tree_visits;
    pl_u32 fixup_checkpoint = selection->fixup_count;
    /* Mirror the write path: a 32-bit sign extension of a register is one
     * `movslq`, decided before the transient-alias resolution in the seed. */
    if (value.kind == PL_OPERAND_NODE) {
        pl_u32 extension_source = 0u, extension_bits = 0u;
        if (pl_select_sign_extend_node(&block->plan, (pl_u32)value.value,
                              &extension_source, &extension_bits)
                && extension_bits == 32u
                && pl_select_emit_sign_extend_move(
                    destination, extension_source, extension_bits,
                    (pl_u8 *)0, bytes)) {
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        pl_operand extension_argument = { 0 };
        pl_u32 extension_owner = PL_X86_GPR_COUNT;
        if (pl_select_sign_extend_value(&block->plan, (pl_u32)value.value,
                              &extension_argument, &extension_bits)
                && extension_bits == 32u
                && extension_argument.kind == PL_OPERAND_NODE
                && pl_select_published_operand_local(
                    &block->plan, extension_argument, &extension_owner)
                && pl_select_emit_sign_extend_move(
                    destination, extension_owner, extension_bits,
                    (pl_u8 *)0, bytes)) {
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
    }
    masked_entry_affine entry_affine;
    if (pl_select_masked_entry_affine_details(
            &block->plan, value, destination, &entry_affine)
            && (scratch_mask & (1u << entry_affine.source))
            && pl_select_emit_masked_entry_affine(
                &entry_affine, (pl_u8 *)0, bytes, instructions)) {
        selection->direct_nested_frame = 1u;
        return 1;
    }
    int seeded = pl_select_measure_alu_seed(
        frontend, block, selection, destination, value, bits, output_at,
        remaining, bytes, instructions);
    if (seeded) return seeded;
    selection->fixup_count = fixup_checkpoint;
    if (remaining <= 1u) {
        record_tree_rejection(selection, value, 1u);
        return 0;
    }

    pl_operand insert_base, insert_inner;
    pl_u32 insert_width = 0u;
    if (pl_select_node_base_lane_insert(&block->plan, value, &insert_base,
                              &insert_inner, &insert_width)) {
        pl_u32 base_bytes = 0u, base_work = 0u;
        int status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, insert_base, bits,
            output_at, remaining - 1u, scratch_mask, &base_bytes, &base_work);
        pl_u8 alias_present = selection->frame_alias_present;
        pl_u64 alias_value = selection->frame_alias_value;
        pl_u8 alias_kind = selection->frame_alias_kind;
        pl_u8 alias_local = selection->frame_alias_local;
        if (status > 0) {
            selection->frame_alias_value = insert_base.value;
            selection->frame_alias_kind = insert_base.kind;
            selection->frame_alias_local = (pl_u8)destination;
            selection->frame_alias_present = 1u;
            pl_u32 inner_bytes = 0u, inner_work = 0u;
            status = pl_select_measure_alu_tree(
                frontend, block, selection, destination, insert_inner,
                insert_width, output_at + base_bytes, remaining - 1u,
                scratch_mask, &inner_bytes, &inner_work);
            if (status > 0 && base_bytes <= U32_MAX_VALUE - inner_bytes
                    && base_work <= U32_MAX_VALUE - inner_work) {
                *bytes = base_bytes + inner_bytes;
                *instructions = base_work + inner_work;
                selection->direct_nested_frame = 1u;
                return 1;
            }
        }
        selection->frame_alias_present = alias_present;
        selection->frame_alias_value = alias_value;
        selection->frame_alias_kind = alias_kind;
        selection->frame_alias_local = alias_local;
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }

    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_BSWAP
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_BSWAP)) {
        pl_u32 byte_swap_bits = block->plan.nodes[value.value - 1u].opcode
                              == PL_OPCODE_LANE32_BSWAP ? 32u : 64u;
        pl_operand byte_swap_source = block->plan.arguments[
            block->plan.nodes[value.value - 1u].argument_at];
        pl_u32 prefix = 0u, prefix_work = 0u, operation = 0u;
        int status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, byte_swap_source,
            byte_swap_bits, output_at, remaining - 1u, scratch_mask,
            &prefix, &prefix_work);
        if (status > 0
                && pl_select_emit_bswap_register(
                    destination, byte_swap_bits, (pl_u8 *)0, &operation)
                && prefix <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = prefix_work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }

    pl_operand tree_shift_source, tree_shift_amount;
    pl_u32 tree_shift_bits = 0u, tree_shift_group = 0u;
    if (pl_select_shift_node_details(&block->plan, value, &tree_shift_source,
            &tree_shift_amount, &tree_shift_bits, &tree_shift_group)) {
        pl_u32 shift_prefix = 0u, shift_prefix_work = 0u, shift_operation = 0u;
        int shift_status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, tree_shift_source,
            tree_shift_bits, output_at, remaining - 1u, scratch_mask,
            &shift_prefix, &shift_prefix_work);
        if (shift_status > 0
                && pl_select_emit_shift_instruction(
                    destination, tree_shift_amount, tree_shift_bits,
                    tree_shift_group, (pl_u8 *)0, &shift_operation)
                && shift_prefix <= U32_MAX_VALUE - shift_operation
                && shift_prefix_work != U32_MAX_VALUE) {
            *bytes = shift_prefix + shift_operation;
            *instructions = shift_prefix_work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        return shift_status < 0 ? shift_status : 0;
    }

    /* Nested conditional select over an incoming condition.  The plan's
     * physical rewriter leaves the false arm exactly in the destructive
     * destination (`SELECT(a, dst_entry, cc)`), so the one-instruction
     * spelling is `cmovcc dst,a`; `a` is materialised first and must be a
     * flag-preserving constant or an already-live register. */
    boolean_select tree_boolean;
    condition_value tree_condition;
    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= block->plan.node_count
            && (block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE32_SELECT
                || block->plan.nodes[value.value - 1u].opcode
                    == PL_OPCODE_LANE64_SELECT)
            && pl_select_boolean_select_details(&block->plan, value, &tree_boolean)
            && pl_select_condition_value_details(
                &block->plan, tree_boolean.condition, &tree_condition)
            && tree_condition.flags.kind == PL_OPERAND_LOCAL
            && tree_condition.flags.value == PL_X86_RFLAGS_LOCAL) {
        pl_u32 false_local = 0u;
        int false_is_destination =
            (tree_boolean.when_false.kind == PL_OPERAND_LOCAL
                && tree_boolean.when_false.value == destination)
            || ((tree_boolean.when_false.kind == PL_OPERAND_NODE
                    || tree_boolean.when_false.kind == PL_OPERAND_PROJECTION)
                && pl_select_published_operand_local(
                    &block->plan, tree_boolean.when_false, &false_local)
                && false_local == destination);
        if (false_is_destination) {
            pl_u32 candidate_local = PL_X86_GPR_COUNT;
            pl_u32 candidate_bytes = 0u, candidate_work = 0u;
            int status = 1;
            if (tree_boolean.when_true.kind == PL_OPERAND_CONST) {
                for (pl_u32 scratch = 0u;
                        scratch < PL_X86_GPR_COUNT; ++scratch)
                    if (scratch != destination
                            && (scratch_mask & (1u << scratch))) {
                        candidate_local = scratch;
                        break;
                    }
                status = candidate_local < PL_X86_GPR_COUNT
                    ? pl_select_measure_alu_tree(
                        frontend, block, selection, candidate_local,
                        tree_boolean.when_true, tree_boolean.value_bits,
                        output_at, remaining - 1u,
                        scratch_mask & ~(1u << candidate_local),
                        &candidate_bytes, &candidate_work)
                    : 0;
            } else {
                /* Only a constant true arm is materialised here.  A register
                 * arm is left to the publication-level select handoff so the
                 * entry-select-overlay canonical schedule is preserved. */
                status = 0;
            }
            pl_u32 move_bytes = 0u;
            if (status > 0
                    && pl_select_emit_conditional_move(
                        destination, candidate_local,
                        tree_boolean.value_bits, tree_condition.condition,
                        (pl_u8 *)0, &move_bytes)
                    && candidate_bytes <= U32_MAX_VALUE - move_bytes
                    && candidate_work != U32_MAX_VALUE) {
                *bytes = candidate_bytes + move_bytes;
                *instructions = candidate_work + 1u;
                selection->direct_nested_frame = 1u;
                return 1;
            }
            selection->fixup_count = fixup_checkpoint;
            return status < 0 ? status : 0;
        }
    }

    condition_value flag_condition;
    if (pl_select_condition_value_details(&block->plan, value, &flag_condition)
            && flag_condition.flags.kind == PL_OPERAND_NODE) {
        pl_operand compare_left, compare_right;
        pl_u32 compare_bits = 0u, compare_mode = 0u, compare_carry = 0u;
        if (pl_select_flag_operation_details(
                &block->plan, flag_condition.flags, &compare_left,
                &compare_right, &compare_bits, &compare_mode, &compare_carry)
                && !compare_carry
                && (compare_mode == 0u || compare_mode == 3u)) {
            pl_select_physicalize_published_operand(
                &block->plan, destination, &compare_left);
            pl_select_physicalize_published_operand(
                &block->plan, destination, &compare_right);
            if (compare_left.kind == PL_OPERAND_LOCAL
                    && compare_left.value < PL_X86_GPR_COUNT) {
                pl_operand physical_right = compare_right;
                pl_u32 operand_bytes = 0u, operand_work = 0u;
                if (physical_right.kind == PL_OPERAND_CONST) {
                    /* Materialise through the fixup-producing seed path.  The
                     * source LEA writes one register, and pl_select_source_address_definition
                     * only binds the field when the destination matches it, so
                     * prefer the CONDITION destination and fall back to a
                     * scratch.  An address constant then becomes a RIP-relative
                     * LEA that pl_select_alias_source_address_fields can attach. */
                    pl_u32 operand_local = destination;
                    if (operand_local == (pl_u32)compare_left.value) {
                        operand_local = PL_X86_GPR_COUNT;
                        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT;
                                ++scratch)
                            if (scratch != destination
                                    && scratch != (pl_u32)compare_left.value
                                    && (scratch_mask & (1u << scratch))) {
                                operand_local = scratch;
                                break;
                            }
                    }
                    if (operand_local >= PL_X86_GPR_COUNT) {
                        selection->fixup_count = fixup_checkpoint;
                        return 0;
                    }
                    int operand_status = pl_select_measure_alu_tree(
                        frontend, block, selection, operand_local,
                        compare_right, compare_bits, output_at,
                        remaining - 1u,
                        operand_local == destination
                            ? scratch_mask
                            : scratch_mask & ~(1u << operand_local),
                        &operand_bytes, &operand_work);
                    if (operand_status <= 0) {
                        selection->fixup_count = fixup_checkpoint;
                        return operand_status < 0 ? operand_status : 0;
                    }
                    physical_right = (pl_operand){ PL_OPERAND_LOCAL,
                                                   operand_local };
                } else if (!(physical_right.kind == PL_OPERAND_LOCAL
                        && physical_right.value < PL_X86_GPR_COUNT)) {
                    selection->fixup_count = fixup_checkpoint;
                    return 0;
                }
                /* SETcc only writes the low byte.  The normalized condition
                 * is a full-width Boolean, so its upper bits must be cleared
                 * even when a preceding source XOR disappeared from the DAG.
                 * If the destination supplies a compare operand, clear it
                 * afterwards with a flag-preserving MOV instead. */
                int zero_after_compare = destination == compare_left.value
                    || (physical_right.kind == PL_OPERAND_LOCAL
                        && destination == physical_right.value);
                pl_u32 compare_bytes = 0u, zero_bytes = 0u, set_bytes = 0u;
                if (pl_select_emit_flag_coordinate(
                        (pl_u32)compare_left.value, physical_right,
                        compare_bits, compare_mode == 0u, 0u,
                        (pl_u8 *)0, &compare_bytes)
                        && pl_select_emit_boolean_zero(destination, zero_after_compare,
                            (pl_u8 *)0, &zero_bytes)
                        && pl_select_emit_set_condition(
                            destination, flag_condition.condition,
                            (pl_u8 *)0, &set_bytes)
                        && operand_bytes <= U32_MAX_VALUE - compare_bytes
                        && operand_bytes + compare_bytes
                           <= U32_MAX_VALUE - zero_bytes
                        && operand_bytes + compare_bytes + zero_bytes
                           <= U32_MAX_VALUE - set_bytes
                        && operand_work <= U32_MAX_VALUE - 3u) {
                    *bytes = operand_bytes + compare_bytes + zero_bytes
                           + set_bytes;
                    *instructions = operand_work + 3u;
                    return 1;
                }
            }
        }
    }

    pl_operand shared_seed, shared_amount;
    pl_u32 shared_group = 0u, shared_mode = 0u;
    if (pl_select_shared_shift_join(&block->plan, value, bits, &shared_seed,
                          &shared_amount, &shared_group, &shared_mode)) {
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            if (scratch == destination || !(scratch_mask & (1u << scratch)))
                continue;
            pl_u32 prefix = 0u, work = 0u, tail = 0u;
            int status = pl_select_measure_alu_tree(frontend, block, selection,
                destination, shared_seed, bits, output_at, remaining - 1u,
                scratch_mask, &prefix, &work);
            if (status > 0 && pl_select_emit_shared_shift_join(destination, scratch,
                    shared_amount, bits, shared_group, shared_mode, 0, &tail)
                    && prefix <= U32_MAX_VALUE - tail
                    && work <= U32_MAX_VALUE - 3u) {
                *bytes = prefix + tail;
                *instructions = work + 3u;
                selection->direct_nested_frame = 1u;
                return 1;
            }
            selection->fixup_count = fixup_checkpoint;
            if (status < 0) return status;
        }
    }

    carry_adjustment adjustment;
    if (pl_select_carry_adjustment_details(&block->plan, value, destination, bits, &adjustment)
            && pl_select_emit_carry_adjustment(&adjustment, destination, 0, bytes, instructions)) {
        selection->direct_nested_frame = 1u;
        return 1;
    }
    pl_operand signed_source;
    pl_u32 signed_bits = 0u;
    if (bits == 64u && value.kind == PL_OPERAND_NODE
            && pl_select_sign_extend_value(&block->plan, (pl_u32)value.value,
                                 &signed_source, &signed_bits)) {
        /* Widen the normalized value, not only an entry register. The low
         * subtree is evaluated once in its destination before MOVSX/CDQE. */
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        int measured = pl_select_measure_alu_tree(
            frontend, block, selection, destination, signed_source, 32u,
            output_at, remaining - 1u, scratch_mask, &prefix, &work);
        if (measured <= 0 || !pl_select_emit_sign_extend_move(
                destination, destination, signed_bits, (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation || work == U32_MAX_VALUE)
            return measured < 0 ? measured : 0;
        *bytes = prefix + operation;
        *instructions = work + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }

    pl_operand multiply_left, multiply_right;
    pl_u32 multiply_bits = 0u;
    if (pl_select_multiply_word_operands(&block->plan, selection, value, destination,
                              &multiply_left, &multiply_right, &multiply_bits)) {
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        pl_u32 direct_source = 0u;
        if (pl_select_multiply_immediate_source(&block->plan, multiply_left, multiply_right,
                multiply_bits, &direct_source)
                && pl_select_emit_imul_operand(destination, direct_source, multiply_right,
                    multiply_bits, 0, bytes)) {
            *instructions = 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        if (multiply_right.kind == PL_OPERAND_LOCAL && multiply_right.value == destination
                && !(multiply_left.kind == PL_OPERAND_LOCAL
                     && multiply_left.value == destination)) return 0;
        int measured = pl_select_measure_alu_tree(
            frontend, block, selection, destination, multiply_left,
            pl_select_alu_input_expression_bits(&block->plan, multiply_left, multiply_bits),
            output_at, remaining - 1u, scratch_mask, &prefix, &work);
        if (measured <= 0 || !pl_select_emit_imul_operand(
                destination, destination, multiply_right, multiply_bits,
                (pl_u8 *)0, &operation)
                || prefix > U32_MAX_VALUE - operation || work == U32_MAX_VALUE)
            return measured < 0 ? measured : 0;
        *bytes = prefix + operation;
        *instructions = work + 1u;
        selection->direct_nested_frame = 1u;
        return 1;
    }

    quotient_boundary_select boundary;
    if (pl_select_quotient_boundary_select_details(
            &block->plan, value, destination, &boundary))
        return pl_select_measure_quotient_boundary_select(
            frontend, block, selection, destination, &boundary,
            output_at, remaining, scratch_mask, bytes, instructions);

    conditional_select select;
    if (pl_select_conditional_select_details(
            &block->plan, value, destination, &select)
            && (select.has_compare || select.current_flag_node
                || (!output_at
                    && select.current.kind == PL_OPERAND_LOCAL
                    && select.current.value == destination))
            && select.candidate_local != destination
            && pl_select_conditional_compare_survives_current(
                &select, destination)) {
        pl_u32 at = 0u;
        pl_u32 seed_bytes = 0u, seed_work = 0u;
        int status = select.current_flag_node
            ? pl_select_measure_selected_flag_value(frontend, block, selection, destination, &select,
                output_at, remaining - 1u, scratch_mask, &seed_bytes, &seed_work)
            : pl_select_measure_alu_tree(
            frontend, block, selection, destination, select.current,
            select.value_bits, output_at, remaining - 1u, scratch_mask,
            &seed_bytes, &seed_work);
        at += seed_bytes;
        pl_u32 candidate_local = select.candidate_local;
        pl_u32 cand_bytes = 0u, cand_work = 0u;
        if (status > 0 && select.candidate_immediate) {
            candidate_local = PL_X86_GPR_COUNT;
            for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch)
                if (scratch != destination
                        && (scratch_mask & (1u << scratch))) {
                    candidate_local = scratch;
                    break;
                }
            if (candidate_local >= PL_X86_GPR_COUNT) return 0;
            status = pl_select_measure_alu_tree(
                frontend, block, selection, candidate_local,
                select.candidate_value, select.value_bits, output_at + at,
                remaining - 1u, scratch_mask & ~(1u << candidate_local),
                &cand_bytes, &cand_work);
            at += cand_bytes;
        }
        pl_u32 compare_bytes = 0u, move_bytes = 0u;
        int compared = status <= 0 ? 0 : !select.has_compare ? 1
            : pl_select_emit_select_compare(&select, 0, &compare_bytes);
        if (status > 0 && compared
                && pl_select_emit_conditional_move(
                    destination, candidate_local,
                    select.value_bits, select.condition,
                    (pl_u8 *)0, &move_bytes)
                && at <= U32_MAX_VALUE - compare_bytes
                && at + compare_bytes <= U32_MAX_VALUE - move_bytes
                && seed_work <= U32_MAX_VALUE - cand_work
                && seed_work + cand_work <= U32_MAX_VALUE - 1u
                                            - select.has_compare) {
            *bytes = at + compare_bytes + move_bytes;
            *instructions = seed_work + cand_work + 1u + select.has_compare;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    condition_value condition_value_shape;
    if (pl_select_condition_value_details(
            &block->plan, value, &condition_value_shape)) {
        pl_u32 flag_bytes = 0u, flag_work = 0u;
        int status = 1;
        if (!(condition_value_shape.flags.kind == PL_OPERAND_LOCAL
                && condition_value_shape.flags.value
                   == PL_X86_RFLAGS_LOCAL)) {
            pl_operand left, right;
            pl_u32 flag_bits = 0u, flag_mode = 0u, preserves_carry = 0u;
            if (!pl_select_flag_operation_details(
                    &block->plan, condition_value_shape.flags,
                    &left, &right, &flag_bits, &flag_mode,
                    &preserves_carry)) {
                status = 0;
            } else {
                status = pl_select_measure_alu_pair(
                    frontend, block, selection, destination, left, right,
                    flag_bits, flag_mode, preserves_carry, output_at,
                    remaining - 1u, scratch_mask,
                    &flag_bytes, &flag_work);
            }
        }
        pl_operand zero = { PL_OPERAND_CONST, 0u };
        pl_u32 zero_bytes = 0u, zero_work = 0u;
        if (status > 0 && flag_bytes <= U32_MAX_VALUE - output_at)
            status = pl_select_measure_alu_tree(
                frontend, block, selection, destination, zero, bits,
                output_at + flag_bytes, remaining - 1u, scratch_mask,
                &zero_bytes, &zero_work);
        pl_u32 set_bytes = 0u;
        if (status > 0
                && pl_select_emit_set_condition(
                    destination, condition_value_shape.condition,
                    (pl_u8 *)0, &set_bytes)
                && flag_bytes <= U32_MAX_VALUE - zero_bytes
                && flag_bytes + zero_bytes <= U32_MAX_VALUE - set_bytes
                && flag_work <= U32_MAX_VALUE - zero_work
                && flag_work + zero_work != U32_MAX_VALUE) {
            *bytes = flag_bytes + zero_bytes + set_bytes;
            *instructions = flag_work + zero_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    boolean_select boolean;
    if (pl_select_boolean_select_details(&block->plan, value, &boolean)) {
        for (pl_u32 inverse = 0u; inverse < 2u; ++inverse) {
            pl_operand current = inverse
                               ? boolean.when_true : boolean.when_false;
            pl_operand candidate = inverse
                                 ? boolean.when_false : boolean.when_true;
            pl_u32 condition_code = inverse ? 4u : 5u;
            if (current.kind == PL_OPERAND_LOCAL
                    && current.value == destination)
                continue;
            pl_u32 candidate_first = 0u;
            pl_u32 candidate_limit = PL_X86_GPR_COUNT;
            int materialize_candidate = candidate.kind == PL_OPERAND_CONST;
            if (candidate.kind == PL_OPERAND_LOCAL) {
                if (candidate.value == destination) continue;
                candidate_first = (pl_u32)candidate.value;
                candidate_limit = candidate_first + 1u;
            }
            for (pl_u32 candidate_local = candidate_first;
                    candidate_local < candidate_limit; ++candidate_local) {
                pl_u32 candidate_bit = 1u << candidate_local;
                if (materialize_candidate
                        && !(scratch_mask & candidate_bit))
                    continue;
                selection->fixup_count = fixup_checkpoint;
                pl_u32 condition_bytes = 0u, condition_work = 0u;
                pl_u32 condition_overhead = 0u;
                int status = 1;
                condition_value direct_condition;
                if (pl_select_condition_value_details(
                        &block->plan, boolean.condition,
                        &direct_condition)) {
                    condition_code = direct_condition.condition ^ inverse;
                    if (!(direct_condition.flags.kind == PL_OPERAND_LOCAL
                            && direct_condition.flags.value
                               == PL_X86_RFLAGS_LOCAL)) {
                        pl_operand flag_left, flag_right;
                        pl_u32 flag_bits = 0u, flag_mode = 0u;
                        pl_u32 preserves_carry = 0u;
                        if (!pl_select_flag_operation_details(
                                &block->plan, direct_condition.flags,
                                &flag_left, &flag_right, &flag_bits,
                                &flag_mode, &preserves_carry)) {
                            status = 0;
                        } else {
                            status = pl_select_measure_alu_pair(
                                frontend, block, selection, destination,
                                flag_left, flag_right, flag_bits, flag_mode,
                                preserves_carry, output_at,
                                remaining - 1u, scratch_mask,
                                &condition_bytes, &condition_work);
                        }
                    }
                } else {
                    pl_u32 condition_bits = pl_select_operand_expression_bits(
                        &block->plan, boolean.condition, 64u);
                    status = pl_select_measure_alu_tree(
                        frontend, block, selection, destination,
                        boolean.condition, condition_bits, output_at,
                        remaining - 1u, scratch_mask,
                        &condition_bytes, &condition_work);
                    pl_u32 test_bytes = 0u;
                    if (status > 0
                            && pl_select_emit_test_registers(
                                destination, destination, condition_bits,
                                (pl_u8 *)0, &test_bytes)
                            && condition_bytes
                               <= U32_MAX_VALUE - test_bytes) {
                        condition_bytes += test_bytes;
                        condition_overhead = 1u;
                    } else if (status > 0) {
                        status = 0;
                    }
                }
                if (status <= 0) {
                    selection->fixup_count = fixup_checkpoint;
                    if (status < 0) return status;
                    continue;
                }
                pl_u32 at = condition_bytes;
                if (at > U32_MAX_VALUE - output_at) {
                    selection->fixup_count = fixup_checkpoint;
                    continue;
                }
                pl_u32 current_bytes = 0u, current_work = 0u;
                status = pl_select_measure_alu_tree(
                    frontend, block, selection, destination, current,
                    boolean.value_bits, output_at + at,
                    remaining - 1u, scratch_mask & ~candidate_bit,
                    &current_bytes, &current_work);
                if (status <= 0 || at > U32_MAX_VALUE - current_bytes) {
                    selection->fixup_count = fixup_checkpoint;
                    if (status < 0) return status;
                    continue;
                }
                at += current_bytes;
                pl_u32 candidate_bytes = 0u, candidate_work = 0u;
                if (materialize_candidate) {
                    status = pl_select_measure_alu_tree(
                        frontend, block, selection, candidate_local,
                        candidate, boolean.value_bits, output_at + at,
                        remaining - 1u, scratch_mask & ~candidate_bit,
                        &candidate_bytes, &candidate_work);
                    if (status <= 0 || at > U32_MAX_VALUE - candidate_bytes) {
                        selection->fixup_count = fixup_checkpoint;
                        if (status < 0) return status;
                        continue;
                    }
                    at += candidate_bytes;
                }
                pl_u32 move_bytes = 0u;
                if (!pl_select_emit_conditional_move(
                        destination, candidate_local, boolean.value_bits,
                        condition_code, (pl_u8 *)0, &move_bytes)
                        || at > U32_MAX_VALUE - move_bytes
                        || condition_work > U32_MAX_VALUE - current_work
                        || condition_work + current_work
                           > U32_MAX_VALUE - candidate_work
                        || condition_work + current_work + candidate_work
                           > U32_MAX_VALUE - (1u + condition_overhead)) {
                    selection->fixup_count = fixup_checkpoint;
                    continue;
                }
                *bytes = at + move_bytes;
                *instructions = condition_work + current_work
                              + candidate_work + 1u + condition_overhead;
                selection->direct_nested_frame = 1u;
                return 1;
            }
        }
        selection->fixup_count = fixup_checkpoint;
    }

    pl_operand original_left, original_right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            &block->plan, value, &original_left, &original_right,
            &node_bits, &mode)
            || node_bits != bits) {
        record_tree_rejection(selection, value, 2u);
        return 0;
    }

    low32_entry_overlay low32_overlay;
    if (pl_select_low32_entry_overlay_details(
            &block->plan, value, destination, &low32_overlay)) {
        int measured = measure_low32_entry_overlay(
            frontend, block, selection, &low32_overlay, output_at,
            scratch_mask, bytes, instructions);
        if (measured) return measured;
        selection->fixup_count = fixup_checkpoint;
    }

    split_entry_overlay split_overlay;
    if (pl_select_split_entry_overlay_details(
            &block->plan, value, destination, &split_overlay)
            && (scratch_mask & (1u << split_overlay.side))) {
        if (pl_select_emit_split_entry_overlay(
                &split_overlay, (pl_u8 *)0, bytes, instructions)) {
            selection->direct_nested_frame = 1u;
            return 1;
        }
    }

    entry_bit_overlay overlay;
    if (pl_select_entry_bit_overlay_details(&block->plan, value, &overlay))
        return measure_entry_bit_overlay(
            frontend, block, selection, destination, &overlay,
            output_at, remaining, scratch_mask, bytes, instructions);

    conditional_or_fold fold;
    pl_u32 condition_sources = 0u;
    if (pl_select_conditional_or_fold_details(
            &block->plan, original_left, original_right,
            bits, mode, &fold)
            && pl_select_operand_entry_gpr_sources(
                &block->plan, fold.flag_left,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && pl_select_operand_entry_gpr_sources(
                &block->plan, fold.flag_right,
                block->plan.node_count + 1u, remaining,
                &condition_sources)
            && !(condition_sources & (1u << destination))) {
        for (pl_u32 candidate = 0u;
                candidate < PL_X86_GPR_COUNT; ++candidate) {
            pl_u32 candidate_bit = 1u << candidate;
            if (!(scratch_mask & candidate_bit)
                    || (condition_sources & candidate_bit))
                continue;
            for (pl_u32 flag_destination = 0u;
                    flag_destination < PL_X86_GPR_COUNT;
                    ++flag_destination) {
                pl_u32 flag_bit = 1u << flag_destination;
                if (flag_destination == candidate
                        || !(scratch_mask & flag_bit))
                    continue;
                selection->fixup_count = fixup_checkpoint;
                pl_u32 base_bytes = 0u, base_work = 0u;
                int status = pl_select_measure_alu_tree(
                    frontend, block, selection, destination, fold.base,
                    bits, output_at, remaining - 1u,
                    scratch_mask & ~condition_sources,
                    &base_bytes, &base_work);
                pl_u32 copy_bytes = 0u, mask_bytes = 0u;
                if (status <= 0
                        || !pl_select_emit_gpr_move(
                            candidate, destination, bits,
                            (pl_u8 *)0, &copy_bytes)
                        || !pl_select_emit_alu_value_instruction(
                            candidate, fold.mask, bits, 5u, 0u,
                            (pl_u8 *)0, &mask_bytes)
                        || base_bytes > U32_MAX_VALUE - copy_bytes
                        || base_bytes + copy_bytes
                           > U32_MAX_VALUE - mask_bytes) {
                    selection->fixup_count = fixup_checkpoint;
                    if (status < 0) return status;
                    continue;
                }
                pl_u32 prefix = base_bytes + copy_bytes + mask_bytes;
                if (prefix > U32_MAX_VALUE - output_at) {
                    selection->fixup_count = fixup_checkpoint;
                    continue;
                }
                pl_u32 flag_bytes = 0u, flag_work = 0u;
                status = pl_select_measure_alu_pair(
                    frontend, block, selection, flag_destination,
                    fold.flag_left, fold.flag_right, fold.flag_bits,
                    fold.flag_mode, fold.preserves_carry,
                    output_at + prefix, remaining - 1u,
                    scratch_mask & ~candidate_bit & ~flag_bit,
                    &flag_bytes, &flag_work);
                pl_u32 move_bytes = 0u;
                if (status > 0
                        && pl_select_emit_conditional_move(
                            destination, candidate, bits, fold.condition,
                            (pl_u8 *)0, &move_bytes)
                        && prefix <= U32_MAX_VALUE - flag_bytes
                        && prefix + flag_bytes
                           <= U32_MAX_VALUE - move_bytes
                        && base_work <= U32_MAX_VALUE - flag_work
                        && base_work + flag_work
                           <= U32_MAX_VALUE - 3u) {
                    *bytes = prefix + flag_bytes + move_bytes;
                    *instructions = base_work + flag_work + 3u;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }
        }
        selection->fixup_count = fixup_checkpoint;
    }

    if (pl_select_associative_mode(mode)
            && (original_left.kind == PL_OPERAND_CONST
                || (original_left.kind == PL_OPERAND_LOCAL
                    && original_left.value < PL_X86_GPR_COUNT
                    && original_left.value != destination))
            && original_right.kind != PL_OPERAND_CONST
            && original_right.kind != PL_OPERAND_LOCAL) {
        pl_u32 prefix_bytes = 0u, prefix_work = 0u;
        pl_u32 right_bits = pl_select_operand_expression_bits(
            &block->plan, original_right, bits);
        int status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, original_right,
            right_bits, output_at, remaining - 1u, scratch_mask,
            &prefix_bytes, &prefix_work);
        pl_u32 operation = 0u;
        if (status > 0
                && pl_select_emit_alu_value_instruction(
                    destination, original_left, bits, mode, 0u,
                    (pl_u8 *)0, &operation)
                && prefix_bytes <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix_bytes + operation;
            *instructions = prefix_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    /* A shared subvalue which already owns a final GPR is a register operand,
     * not a reason to allocate a second transient copy.  Resolve both sides:
     * resolving only the right operand still recursively rebuilt a published
     * left subtree for every consumer. */
    pl_operand physical_left = original_left;
    pl_operand physical_right = original_right;
    pl_select_physicalize_published_operand(
        &block->plan, destination, &physical_left);

    /* A native right operand is already materialized.  Keep its entry
     * coordinate pinned while recursively producing the left tree, then
     * consume it directly.  Materializing that operand into a scratch first
     * adds one unit of work and can lengthen the dependency chain; it is
     * necessary only when the right expression has no exact native spelling.
     * This rule is especially important after an earlier publication makes a
     * destination such as RBX available as the left tree's transient owner. */
    if (physical_right.kind == PL_OPERAND_CONST
            || (physical_right.kind == PL_OPERAND_LOCAL
                && physical_right.value < PL_X86_GPR_COUNT
                && physical_right.value != destination)) {
        pl_u32 pinned = physical_right.kind == PL_OPERAND_LOCAL
                      ? 1u << (pl_u32)physical_right.value : 0u;
        pl_u32 prefix_bytes = 0u, prefix_work = 0u;
        int status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, physical_left,
            bits, output_at, remaining - 1u, scratch_mask & ~pinned,
            &prefix_bytes, &prefix_work);
        pl_u32 operation = 0u;
        if (status > 0
                && pl_select_emit_alu_value_instruction(
                    destination, physical_right, bits, mode, 0u,
                    (pl_u8 *)0, &operation)
                && prefix_bytes <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix_bytes + operation;
            *instructions = prefix_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    pl_u32 owner = PL_X86_GPR_COUNT;
    if (pl_select_published_operand_local(
                &block->plan, physical_right, &owner)
            && owner != destination) {
        physical_right.kind = PL_OPERAND_LOCAL;
        physical_right.value = owner;
        pl_u32 prefix_bytes = 0u, prefix_work = 0u;
        int status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, physical_left,
            bits, output_at, remaining - 1u, scratch_mask,
            &prefix_bytes, &prefix_work);
        pl_u32 operation = 0u;
        if (status > 0
                && pl_select_emit_alu_instruction(
                    destination, physical_right, bits, mode, 0u,
                    (pl_u8 *)0, &operation)
                && prefix_bytes <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix_bytes + operation;
            *instructions = prefix_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }

    /* Do not flatten two independent arithmetic subtrees onto one serial
     * accumulator.  When the side subtree can start on one of its own entry
     * owners, both arms retain their dependency depth and require no extra
     * copy; a single final associative join then realizes the original DAG.
     * This is the physical parallel form of a balanced reduction, not an
     * instruction-order heuristic. */
    if (pl_select_associative_mode(mode) && scratch_mask
            && (original_left.kind == PL_OPERAND_NODE
                || original_left.kind == PL_OPERAND_PROJECTION)
            && (original_right.kind == PL_OPERAND_NODE
                || original_right.kind == PL_OPERAND_PROJECTION)) {
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            pl_operand trunk = orientation
                             ? original_right : original_left;
            pl_operand side = orientation
                            ? original_left : original_right;
            pl_u32 trunk_sources = 0u, side_sources = 0u;
            if (!pl_select_operand_entry_gpr_sources(
                    &block->plan, trunk,
                    block->plan.node_count + 1u, remaining,
                    &trunk_sources)
                    || !pl_select_operand_entry_gpr_sources(
                        &block->plan, side,
                        block->plan.node_count + 1u, remaining,
                        &side_sources)
                    || (side_sources & (1u << destination)))
                continue;
            pl_u32 preferred = scratch_mask & side_sources;
            for (pl_u32 scratch = 0u;
                    scratch < PL_X86_GPR_COUNT; ++scratch) {
                pl_u32 scratch_bit = 1u << scratch;
                if (!(preferred & scratch_bit)) continue;
                selection->fixup_count = fixup_checkpoint;
                pl_u32 trunk_bytes = 0u, trunk_work = 0u;
                int status = pl_select_measure_alu_tree(
                    frontend, block, selection, destination, trunk, bits,
                    output_at, remaining - 1u,
                    scratch_mask & ~side_sources,
                    &trunk_bytes, &trunk_work);
                pl_u32 side_bytes = 0u, side_work = 0u;
                if (status > 0
                        && trunk_bytes <= U32_MAX_VALUE - output_at)
                    status = pl_select_measure_alu_tree(
                        frontend, block, selection, scratch, side, bits,
                        output_at + trunk_bytes, remaining - 1u,
                        scratch_mask & ~scratch_bit,
                        &side_bytes, &side_work);
                pl_operand side_value = {
                    PL_OPERAND_LOCAL, scratch,
                };
                pl_u32 operation = 0u;
                if (status > 0
                        && pl_select_emit_alu_instruction(
                            destination, side_value, bits, mode, 0u,
                            (pl_u8 *)0, &operation)
                        && trunk_bytes <= U32_MAX_VALUE - side_bytes
                        && trunk_bytes + side_bytes
                           <= U32_MAX_VALUE - operation
                        && trunk_work <= U32_MAX_VALUE - side_work
                        && trunk_work + side_work != U32_MAX_VALUE) {
                    *bytes = trunk_bytes + side_bytes + operation;
                    *instructions = trunk_work + side_work + 1u;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }
        }
    }

    if (pl_select_associative_mode(mode) && scratch_mask) {
        pl_u32 capacity = block->plan.node_count + 1u;
        pl_operand leaves[capacity];
        pl_u32 leaf_count = 0u;
        if (pl_select_collect_associative_leaves(
                &block->plan, value, bits, mode, leaves, capacity,
                &leaf_count, block->plan.node_count + 1u)
                && leaf_count > 2u) {
            pl_select_promote_associative_destination_leaf(
                leaves, leaf_count, destination);
            pl_u32 leaf_sources[leaf_count];
            pl_u32 suffix_sources[leaf_count + 1u];
            suffix_sources[leaf_count] = 0u;
            int sources_valid = 1;
            for (pl_u32 at = leaf_count; at-- > 0u;) {
                leaf_sources[at] = 0u;
                if (!pl_select_operand_entry_gpr_sources(
                        &block->plan, leaves[at],
                        block->plan.node_count + 1u,
                        remaining, &leaf_sources[at])) {
                    sources_valid = 0;
                    break;
                }
                suffix_sources[at] = suffix_sources[at + 1u]
                                   | leaf_sources[at];
            }
            if (sources_valid
                    && !(suffix_sources[1u] & (1u << destination))) {
                selection->fixup_count = fixup_checkpoint;
                pl_u32 total_bytes = 0u, total_work = 0u;
                pl_u32 leaf_bits = pl_select_operand_expression_bits(
                    &block->plan, leaves[0], bits);
                int status = pl_select_measure_alu_tree(
                    frontend, block, selection, destination, leaves[0],
                    leaf_bits, output_at, remaining - 1u,
                    scratch_mask & ~suffix_sources[1u],
                    &total_bytes, &total_work);
                for (pl_u32 at = 1u; status > 0 && at < leaf_count; ++at) {
                    pl_u32 available = scratch_mask
                                     & ~suffix_sources[at + 1u];
                    pl_u32 scratch = 0u;
                    pl_u32 final_owner = available & leaf_sources[at];
                    pl_u32 preferred = final_owner ? final_owner : available;
                    while (scratch < PL_X86_GPR_COUNT
                            && !(preferred & (1u << scratch)))
                        ++scratch;
                    if (scratch == PL_X86_GPR_COUNT
                            || total_bytes > U32_MAX_VALUE - output_at) {
                        status = 0;
                        break;
                    }
                    pl_u32 scratch_bit = 1u << scratch;
                    pl_u32 part_bytes = 0u, part_work = 0u;
                    leaf_bits = pl_select_operand_expression_bits(
                        &block->plan, leaves[at], bits);
                    status = pl_select_measure_alu_tree(
                        frontend, block, selection, scratch, leaves[at],
                        leaf_bits, output_at + total_bytes,
                        remaining - 1u,
                        available & ~scratch_bit,
                        &part_bytes, &part_work);
                    pl_operand scratch_value = {
                        PL_OPERAND_LOCAL, scratch,
                    };
                    pl_u32 operation = 0u;
                    if (status <= 0
                            || !pl_select_emit_alu_instruction(
                                destination, scratch_value, bits, mode, 0u,
                                (pl_u8 *)0, &operation)
                            || total_bytes > U32_MAX_VALUE - part_bytes
                            || total_bytes + part_bytes
                               > U32_MAX_VALUE - operation
                            || total_work > U32_MAX_VALUE - part_work
                            || total_work + part_work == U32_MAX_VALUE) {
                        status = status < 0 ? status : 0;
                        break;
                    }
                    total_bytes += part_bytes + operation;
                    total_work += part_work + 1u;
                }
                if (status > 0) {
                    *bytes = total_bytes;
                    *instructions = total_work;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }
        }
    }

    pl_u32 orientations = mode == 3u ? 1u : 2u;
    pl_u32 first_orientation = pl_select_entry_bit_chain_orientation(
        &block->plan, original_left, original_right, destination, mode);
    for (pl_u32 attempt = 0u; attempt < orientations; ++attempt) {
        pl_u32 orientation = attempt ^ first_orientation;
        pl_operand left = orientation ? original_right : original_left;
        pl_operand right = orientation ? original_left : original_right;
        pl_u32 left_sources = 0u;
        pl_u32 right_sources = 0u;
        if (!pl_select_operand_entry_gpr_sources(
                &block->plan, left, block->plan.node_count + 1u,
                remaining, &left_sources)
                || !pl_select_operand_entry_gpr_sources(
                    &block->plan, right,
                    block->plan.node_count + 1u,
                    remaining, &right_sources))
            continue;
        for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
            pl_u32 scratch_bit = 1u << scratch;
            if (!(scratch_mask & scratch_bit)) continue;

            /* Right first: its owner may consume its own entry value, but
             * the later left subtree must not need that old value. */
            if (!(left_sources & scratch_bit)) {
                selection->fixup_count = fixup_checkpoint;
                pl_u32 right_bytes = 0u, right_work = 0u;
                int status = pl_select_measure_alu_tree(
                    frontend, block, selection, scratch, right, bits,
                    output_at, remaining - 1u,
                    scratch_mask & ~scratch_bit,
                    &right_bytes, &right_work);
                pl_u32 left_bytes = 0u, left_work = 0u;
                if (status > 0 && right_bytes <= U32_MAX_VALUE - output_at)
                    status = pl_select_measure_alu_tree(
                        frontend, block, selection, destination, left, bits,
                        output_at + right_bytes, remaining - 1u,
                        scratch_mask & ~scratch_bit,
                        &left_bytes, &left_work);
                pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
                pl_u32 operation = 0u;
                if (status > 0
                        && pl_select_emit_alu_instruction(
                            destination, scratch_value, bits, mode, 0u,
                            (pl_u8 *)0, &operation)
                        && right_bytes <= U32_MAX_VALUE - left_bytes
                        && right_bytes + left_bytes
                           <= U32_MAX_VALUE - operation
                        && right_work <= U32_MAX_VALUE - left_work
                        && right_work + left_work != U32_MAX_VALUE) {
                    *bytes = right_bytes + left_bytes + operation;
                    *instructions = right_work + left_work + 1u;
                    selection->direct_nested_frame = 1u;
                    return 1;
                }
                selection->fixup_count = fixup_checkpoint;
                if (status < 0) return status;
            }

            /* Left first: destination's entry value must not be needed by
             * the right subtree.  Registers still live in the right subtree
             * cannot be borrowed while producing left; once left completes,
             * its last-use-only entries become available to right. */
            if (right_sources & (1u << destination)) continue;
            selection->fixup_count = fixup_checkpoint;
            pl_u32 left_bytes = 0u, left_work = 0u;
            int status = pl_select_measure_alu_tree(
                frontend, block, selection, destination, left, bits,
                output_at, remaining - 1u,
                scratch_mask & ~right_sources,
                &left_bytes, &left_work);
            pl_u32 right_bytes = 0u, right_work = 0u;
            if (status > 0 && left_bytes <= U32_MAX_VALUE - output_at)
                status = pl_select_measure_alu_tree(
                    frontend, block, selection, scratch, right, bits,
                    output_at + left_bytes, remaining - 1u,
                    scratch_mask & ~scratch_bit,
                    &right_bytes, &right_work);
            pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
            pl_u32 operation = 0u;
            if (status > 0
                    && pl_select_emit_alu_instruction(
                        destination, scratch_value, bits, mode, 0u,
                        (pl_u8 *)0, &operation)
                    && left_bytes <= U32_MAX_VALUE - right_bytes
                    && left_bytes + right_bytes <= U32_MAX_VALUE - operation
                    && left_work <= U32_MAX_VALUE - right_work
                    && left_work + right_work != U32_MAX_VALUE) {
                *bytes = left_bytes + right_bytes + operation;
                *instructions = left_work + right_work + 1u;
                selection->direct_nested_frame = 1u;
                return 1;
            }
            selection->fixup_count = fixup_checkpoint;
            if (status < 0) return status;
        }
    }
    /* A published left subtree may be the right register of a commutative
     * instruction. Finish the entry-dependent right subtree in place before
     * the join; copying the published left over it would destroy that entry. */
    pl_select_physicalize_selected_operand(&block->plan, selection, destination, &physical_left);
    if (pl_select_associative_mode(mode) && physical_left.kind == PL_OPERAND_LOCAL
            && physical_left.value != destination) {
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        int measured = pl_select_measure_alu_tree(
            frontend, block, selection, destination, original_right, bits,
            output_at, remaining - 1u, scratch_mask & ~(1u << physical_left.value),
            &prefix, &work);
        if (measured > 0 && pl_select_emit_alu_instruction(
                destination, physical_left, bits, mode, 0u, 0, &operation)
                && prefix <= U32_MAX_VALUE - operation && work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (measured < 0) return measured;
    }
    record_tree_rejection(selection, value, 3u);
    return 0;
}

static int measure_entry_bit_overlay(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u32 destination,
    const entry_bit_overlay *shape, pl_u32 output_at,
    pl_u32 remaining, pl_u32 scratch_mask,
    pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !shape || !bytes
            || !instructions || !remaining
            || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 side_sources = 0u;
    if (!pl_select_operand_entry_gpr_sources(
            &block->plan, shape->side,
            block->plan.node_count + 1u, remaining, &side_sources)
            || (side_sources & (1u << destination)))
        return 0;
    pl_u32 fixup_checkpoint = selection->fixup_count;
    pl_u32 base_bytes = 0u, base_work = 0u;
    int status = pl_select_measure_alu_seed(
        frontend, block, selection, destination, shape->base,
        shape->bits, output_at, remaining - 1u,
        &base_bytes, &base_work);
    pl_u32 overlay_bytes = 0u, overlay_work = 0u;
    if (status <= 0
            || !pl_select_emit_entry_bit_overlay(
                destination, shape, (pl_u8 *)0,
                &overlay_bytes, &overlay_work)
            || base_bytes > U32_MAX_VALUE - overlay_bytes) {
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }
    pl_u32 prefix = base_bytes + overlay_bytes;
    if (prefix > U32_MAX_VALUE - output_at) {
        selection->fixup_count = fixup_checkpoint;
        return 0;
    }
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (!(scratch_mask & scratch_bit) || scratch == destination)
            continue;
        selection->fixup_count = fixup_checkpoint;
        pl_u32 side_bytes = 0u, side_work = 0u;
        status = pl_select_measure_alu_tree(
            frontend, block, selection, scratch, shape->side,
            shape->bits, output_at + prefix, remaining - 1u,
            scratch_mask & ~scratch_bit, &side_bytes, &side_work);
        pl_operand side = { PL_OPERAND_LOCAL, scratch };
        pl_u32 join_bytes = 0u;
        if (status > 0
                && pl_select_emit_alu_instruction(
                    destination, side, shape->bits, 5u, 0u,
                    (pl_u8 *)0, &join_bytes)
                && prefix <= U32_MAX_VALUE - side_bytes
                && prefix + side_bytes <= U32_MAX_VALUE - join_bytes
                && base_work <= U32_MAX_VALUE - overlay_work
                && base_work + overlay_work <= U32_MAX_VALUE - side_work
                && base_work + overlay_work + side_work != U32_MAX_VALUE) {
            *bytes = prefix + side_bytes + join_bytes;
            *instructions = base_work + overlay_work + side_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        if (status < 0) return status;
    }
    selection->fixup_count = fixup_checkpoint;
    return 0;
}

int pl_select_measure_alu_pair(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            pl_x86_native_selection *selection,
                            pl_u32 destination, pl_operand left,
                            pl_operand right, pl_u32 bits, pl_u32 mode,
                            pl_u32 preserves_carry, pl_u32 output_at,
                            pl_u32 remaining, pl_u32 scratch_mask,
                            pl_u32 *bytes, pl_u32 *instructions)
{
    if (!frontend || !block || !selection || !bytes || !instructions
            || !remaining || destination >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 fixup_checkpoint = selection->fixup_count;
    /* XOR(x,x) and SUB(x,x) have a constant result and fixed architectural
     * flags.  The input coordinate is therefore outside their complete
     * future.  Select the exact self operation at the destination before
     * publication-owner substitution can manufacture a copy dependency. */
    if (!preserves_carry && (mode == 3u || mode == 6u)
            && left.kind == right.kind && left.value == right.value) {
        pl_u32 operation = 0u;
        pl_operand self = { PL_OPERAND_LOCAL, destination };
        if (!pl_select_emit_alu_instruction(
                destination, self, bits, mode, 0u,
                (pl_u8 *)0, &operation))
            return 0;
        *bytes = operation;
        *instructions = 1u;
        return 1;
    }
    if (!preserves_carry && mode == 3u
            && left.kind == PL_OPERAND_CONST && !left.value) {
        pl_u32 prefix = 0u, work = 0u, operation = 0u;
        int status = pl_select_measure_alu_tree(frontend, block, selection, destination,
            right, bits, output_at, remaining - 1u, scratch_mask, &prefix, &work);
        if (status > 0 && pl_select_emit_neg_register(destination, bits, 0, &operation)
                && prefix <= U32_MAX_VALUE - operation && work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        return status < 0 ? status : 0;
    }
    pl_u32 owner = PL_X86_GPR_COUNT;
    pl_select_physicalize_published_operand(&block->plan, destination, &left);
    if (pl_select_published_operand_local(&block->plan, right, &owner)
            && owner != destination) {
        right.kind = PL_OPERAND_LOCAL;
        right.value = owner;
    }
    /* A consumer's width truncates its inputs only after their expressions
     * have been evaluated.  In particular, truncating before a wide right
     * shift changes both the selected bits and the shift-count mask. */
    pl_u32 left_bits = pl_select_alu_input_expression_bits(&block->plan, left, bits);
    pl_u32 right_bits = pl_select_alu_input_expression_bits(&block->plan, right, bits);
    if (right.kind == PL_OPERAND_CONST
            || (right.kind == PL_OPERAND_LOCAL
                && right.value < PL_X86_GPR_COUNT)) {
        pl_u32 prefix = 0u, prefix_work = 0u, operation = 0u;
        int status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, left, left_bits,
            output_at, remaining - 1u, scratch_mask,
            &prefix, &prefix_work);
        /* A left prefix publishes the accumulator. A right LOCAL still
         * names its ENTRY generation, even if its register number is equal.
         * Capture that generation through the existing scratch schedule;
         * never silently turn x-y into x-x after destructive publication. */
        if (status > 0
                && !(prefix_work && right.kind == PL_OPERAND_LOCAL
                     && right.value == destination)
                && pl_select_emit_alu_instruction(
                    destination, right, bits, mode, preserves_carry,
                    (pl_u8 *)0, &operation)
                && prefix <= U32_MAX_VALUE - operation
                && prefix_work != U32_MAX_VALUE) {
            *bytes = prefix + operation;
            *instructions = prefix_work + 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0 || (right.kind != PL_OPERAND_CONST
                && !(right.kind == PL_OPERAND_LOCAL && right.value == destination)))
            return status < 0 ? status : 0;
        /* A constant that the immediate form cannot encode (`add r64,
         * imm64-only`) falls through so the scratch path materializes it into a
         * register first. */
    }

    pl_u32 left_sources = 0u;
    if (!pl_select_operand_entry_gpr_sources(
            &block->plan, left, block->plan.node_count + 1u,
            remaining, &left_sources))
        return 0;
    for (pl_u32 scratch = 0u; scratch < PL_X86_GPR_COUNT; ++scratch) {
        pl_u32 scratch_bit = 1u << scratch;
        if (scratch == destination || !(scratch_mask & scratch_bit) || (left_sources & scratch_bit))
            continue;
        selection->fixup_count = fixup_checkpoint;
        pl_u32 right_bytes = 0u, right_work = 0u;
        int status = pl_select_measure_alu_tree(
            frontend, block, selection, scratch, right, right_bits, output_at,
            remaining - 1u, scratch_mask & ~scratch_bit,
            &right_bytes, &right_work);
        if (status <= 0) {
            selection->fixup_count = fixup_checkpoint;
            if (status < 0) return status;
            continue;
        }
        if (right_bytes > U32_MAX_VALUE - output_at) {
            selection->fixup_count = fixup_checkpoint;
            continue;
        }
        pl_u32 left_bytes = 0u, left_work = 0u;
        status = pl_select_measure_alu_tree(
            frontend, block, selection, destination, left, left_bits,
            output_at + right_bytes, remaining - 1u,
            scratch_mask & ~scratch_bit, &left_bytes, &left_work);
        pl_operand scratch_value = { PL_OPERAND_LOCAL, scratch };
        pl_u32 operation = 0u;
        if (status > 0
                && pl_select_emit_alu_instruction(
                    destination, scratch_value, bits, mode,
                    preserves_carry, (pl_u8 *)0, &operation)
                && right_bytes <= U32_MAX_VALUE - left_bytes
                && right_bytes + left_bytes <= U32_MAX_VALUE - operation
                && right_work <= U32_MAX_VALUE - left_work
                && right_work + left_work != U32_MAX_VALUE) {
            *bytes = right_bytes + left_bytes + operation;
            *instructions = right_work + left_work + 1u;
            selection->direct_nested_frame = 1u;
            return 1;
        }
        selection->fixup_count = fixup_checkpoint;
        if (status < 0) return status;
    }
    return 0;
}
