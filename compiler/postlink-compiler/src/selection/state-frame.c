/* state-frame: native x86 selection. */
#include "state-frame.h"
#include "limits.h"
#include "branch-frame.h"
#include "encoding.h"
#include "expressions.h"
#include "operands.h"
#include "select-rules.h"
#include "simple-frame.h"
#include "source.h"
#include "tree-measure.h"
#include "tree-write.h"

static int next_transient_plain_assignment(const pl_plan *plan,
                                           pl_u32 pending,
                                           pl_u32 *selected);

static int transient_owner_frame_shape(const pl_x86_block *block,
                                       transient_owner_frame *out);

static int zero_flag_node_details(const pl_plan *plan, pl_u32 node_number,
                                  pl_u32 *bits);

static int zero_plain_copy(const pl_plan *plan, pl_u32 local,
                           pl_u32 *source, pl_u32 *bits,
                           int *entry_source);

static pl_u32 zero_copy_publication_bits(
    const pl_x86_native_selection *selection, pl_operand value,
    pl_u32 bits);

static int next_zero_plain_assignment(const pl_plan *plan,
                                      pl_u32 pending,
                                      pl_u32 *selected);

static int bit_projection_value_details(
    const pl_plan *plan, pl_operand value, pl_operand *source,
    pl_u32 *from, pl_u32 *to, pl_u32 *inverse, pl_u32 *bits);

static int zero_flag_frame_shape(const pl_x86_block *block,
                                 zero_flag_frame *out);

static int shift_handoff_frame_shape(const pl_x86_block *block,
                                     shift_handoff_frame *out);

static int shared_owner_frame_shape(const pl_x86_block *block,
                                    shared_owner_frame *out);

static int value_predicate_frame_shape(const pl_x86_block *block,
                                       value_predicate_frame *out);

static int compare_handoff_frame_shape(const pl_x86_block *block,
                                       compare_handoff_frame *out);

int pl_select_next_compare_branch_assignment(const pl_plan *plan, pl_u32 pending,
                                          pl_u32 preferred, pl_u32 *selected)
{
    return pl_select_next_compare_branch_assignment_excluding(plan, pending, preferred, 0u, selected);
}

/* Two pending publications that shift the same unpublished root, where the
 * root reads the entry values of exactly those two destinations:
 *
 *   seed = op(D2, D1)   D1 = seed >> k1   D2 = seed >> k2
 *
 * Neither destination may be published first under the ordinary anti-
 * dependency check (each reads the coordinate the other overwrites), yet the
 * source evaluates the seed once in one coordinate, copies it to the other,
 * and shifts each once.  Detect that pair so the caller can emit it. */
int pl_select_shared_root_shift_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                           shared_root_shift_handoff *out)
{
    if (!plan || !pending || !out) return 0;
    for (pl_u32 first = 0u; first < PL_X86_GPR_COUNT; ++first) {
        if (!(pending & (1u << first))) continue;
        pl_operand first_source, first_amount;
        pl_u32 first_bits = 0u, first_group = 0u;
        if (!pl_select_shift_node_details(plan, plan->locals[first],
                &first_source, &first_amount, &first_bits, &first_group)
                || first_source.kind != PL_OPERAND_NODE
                || !first_source.value
                || first_source.value > plan->node_count)
            continue;
        for (pl_u32 second = first + 1u;
                second < PL_X86_GPR_COUNT; ++second) {
            if (!(pending & (1u << second))) continue;
            pl_operand second_source, second_amount;
            pl_u32 second_bits = 0u, second_group = 0u;
            if (!pl_select_shift_node_details(plan, plan->locals[second],
                    &second_source, &second_amount, &second_bits, &second_group)
                    || second_source.kind != PL_OPERAND_NODE
                    || second_source.value != first_source.value
                    || second_bits != first_bits)
                continue;
            if (pl_select_publication_owner(plan, first_source) < PL_X86_GPR_COUNT)
                continue;
            pl_operand left, right;
            pl_u32 seed_bits = 0u, seed_mode = 0u;
            if (!pl_select_arithmetic_tree_details(plan, first_source, &left, &right,
                    &seed_bits, &seed_mode)
                    || seed_bits != first_bits)
                continue;
            pl_u32 seed_dest = PL_X86_GPR_COUNT;
            if (left.kind == PL_OPERAND_LOCAL && left.value == second
                    && right.kind == PL_OPERAND_LOCAL
                    && right.value == first) {
                seed_dest = second;
            } else if (pl_select_associative_mode(seed_mode)
                    && left.kind == PL_OPERAND_LOCAL && left.value == first
                    && right.kind == PL_OPERAND_LOCAL
                    && right.value == second) {
                seed_dest = first;
            } else {
                continue;
            }
            out->seed = first_source;
            out->seed_bits = seed_bits;
            out->seed_dest = seed_dest;
            out->copy_dest = seed_dest == first ? second : first;
            out->bits = first_bits;
            if (seed_dest == first) {
                out->amount[0] = first_amount;
                out->group[0] = first_group;
                out->amount[1] = second_amount;
                out->group[1] = second_group;
            } else {
                out->amount[0] = second_amount;
                out->group[0] = second_group;
                out->amount[1] = first_amount;
                out->group[1] = first_group;
            }
            return 1;
        }
    }
    return 0;
}

static int next_transient_plain_assignment(const pl_plan *plan,
                                           pl_u32 pending,
                                           pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    pl_u32 needed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL) {
            if (value.value >= PL_X86_GPR_COUNT) return 0;
            needed |= 1u << (pl_u32)value.value;
        } else if (value.kind != PL_OPERAND_CONST) {
            return 0;
        }
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((pending & (1u << local)) && !(needed & (1u << local))) {
            *selected = local;
            return 1;
        }
    return 0;
}

/* A conditional publication may retain a pure intermediate while another
 * architectural result consumes that same value.  The normalized register
 * topology gives the intermediate to the conditional destination first,
 * derives the consumer from that one owner, then performs compare/CMOV last.
 * This is the exact destructive-register realization of the shared SSA DAG:
 * neither recomputing the intermediate nor preserving the source instruction
 * order is part of the accepted future. */
static int transient_owner_frame_shape(const pl_x86_block *block,
                                       transient_owner_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 changed = 0u, final_flag_node = 0u;
    if (!pl_select_alu_frame_shape(&block->plan, &changed, &final_flag_node))
        return 0;
    for (pl_u32 owner = 0u; owner < PL_X86_GPR_COUNT; ++owner) {
        if (!(changed & (1u << owner))) continue;
        conditional_select select;
        if (!pl_select_conditional_select_details(
                &block->plan, block->plan.locals[owner], owner, &select)
                || !select.has_compare
                || select.compare_test
                || select.compare_node != final_flag_node
                || (select.current.kind != PL_OPERAND_NODE
                    && select.current.kind != PL_OPERAND_PROJECTION)
                || select.candidate_local >= PL_X86_GPR_COUNT
                || (changed & (1u << select.candidate_local)))
            continue;
        pl_u32 consumer = select.compare_left_local;
        if (consumer >= PL_X86_GPR_COUNT || consumer == owner
                || !(changed & (1u << consumer)))
            continue;
        pl_operand left, right;
        pl_u32 bits = 0u, mode = 0u;
        if (!pl_select_arithmetic_node_details(
                &block->plan, block->plan.locals[consumer],
                &left, &right, &bits, &mode)
                || mode != 1u || bits != select.value_bits
                || left.kind != select.current.kind
                || left.value != select.current.value)
            continue;
        pl_u32 plain = changed & ~(1u << owner) & ~(1u << consumer);
        pl_u32 current_sources = 0u;
        if (!pl_select_operand_gpr_sources(
                &block->plan, select.current,
                block->plan.node_count + 1u,
                block->plan.node_count + 1u, &current_sources)
                || (current_sources & plain))
            continue;
        if (right.kind == PL_OPERAND_LOCAL
                && (right.value >= PL_X86_GPR_COUNT
                    || right.value == owner
                    || (plain & (1u << (pl_u32)right.value))))
            continue;
        if (right.kind != PL_OPERAND_LOCAL
                && right.kind != PL_OPERAND_CONST)
            continue;
        if (select.compare_right.kind == PL_OPERAND_LOCAL
                && (select.compare_right.value >= PL_X86_GPR_COUNT
                    || (select.compare_right.value != consumer
                        && (changed
                            & (1u << (pl_u32)select.compare_right.value)))))
            continue;
        pl_u32 pending = plain;
        while (pending) {
            pl_u32 local = 0u;
            if (!next_transient_plain_assignment(
                    &block->plan, pending, &local))
                break;
            pending &= ~(1u << local);
        }
        if (pending) continue;
        out->owner = owner;
        out->consumer = consumer;
        out->plain = plain;
        out->consumer_bits = bits;
        out->select = select;
        out->consumer_right = right;
        return 1;
    }
    return 0;
}

int pl_select_measure_direct_transient_owner_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    transient_owner_frame shape = { 0 };
    if (!transient_owner_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u;
    pl_u32 pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local))
            return 0;
        int measured = pl_select_measure_frame_value(
            frontend, block, selection, local,
            block->plan.locals[local], bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    pl_u32 encoded = 0u, work = 0u;
    int measured = pl_select_measure_alu_seed(
        frontend, block, selection, shape.owner, shape.select.current,
        shape.select.value_bits, bytes, block->plan.node_count + 1u,
        &encoded, &work);
    if (measured <= 0 || bytes > U32_MAX_VALUE - encoded)
        return measured < 0 ? measured : 0;
    bytes += encoded;
    instructions += work;
    pl_operand owner_value = { PL_OPERAND_LOCAL, shape.owner };
    if (!pl_select_emit_add_lea(
            shape.consumer, owner_value, shape.consumer_right,
            shape.consumer_bits, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    if (!pl_select_emit_compare_operand(
            shape.select.compare_left_local, shape.select.compare_right,
            shape.select.compare_bits, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    if (!pl_select_emit_conditional_move(
            shape.owner, shape.select.candidate_local,
            shape.select.value_bits, shape.select.condition, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_transient_owner_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_zero_result_operand(const pl_plan *plan, pl_operand value)
{
    if (!plan) return 0;
    if (value.kind == PL_OPERAND_CONST) return value.value == 0u;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (value.kind == PL_OPERAND_NODE)
        return pl_select_arithmetic_node_details(
                   plan, value, &left, &right, &bits, &mode)
            && mode == 6u && left.kind == right.kind
            && left.value == right.value;
    if (value.kind != PL_OPERAND_PROJECTION
            || (value.value & 0xffu) != 16u)
        return 0;
    pl_u32 node_number = (pl_u32)(value.value >> 8u);
    if (!node_number || node_number > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_X86_ALU
            || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[3].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[3].value;
    bits = (pl_u32)(descriptor & 0x7fu);
    mode = (pl_u32)((descriptor >> 8u) & 7u);
    return (bits == 32u || bits == 64u) && mode == 6u
        && descriptor == (pl_u64)(bits | (mode << 8u))
        && argument[1].kind == argument[2].kind
        && argument[1].value == argument[2].value;
}

/* Return the width of a flag producer whose complete defined flag word is
 * exactly the zero-result logical flag word.  The value topology may already
 * have folded away: flags are an independent architectural publication, not
 * a reason to retain a dead value node. */
static int zero_flag_node_details(const pl_plan *plan, pl_u32 node_number,
                                  pl_u32 *bits)
{
    if (!plan || !bits || !node_number || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    pl_u32 destination = 0u, mode = 0u, preserves_carry = 0u;
    pl_operand left, right;
    if (pl_select_alu_node_details(
            plan, node_number, &destination, &left, &right,
            bits, &mode, &preserves_carry)) {
        if (preserves_carry || mode != 6u
                || left.kind != right.kind || left.value != right.value)
            return 0;
        *bits = 32u;
        return 1;
    }
    if (node->opcode == PL_OPCODE_X86_FLAGS) {
        if (node->argument_count != 5u
                || argument[4].kind != PL_OPERAND_CONST)
            return 0;
        pl_u64 descriptor = argument[4].value;
        pl_u32 width = (pl_u32)(descriptor & 0x7fu);
        pl_u32 flag_mode = (pl_u32)((descriptor >> 8u) & 7u);
        if ((width != 8u && width != 16u
                && width != 32u && width != 64u)
                || flag_mode != 6u || (descriptor >> 11u)
                || argument[1].kind != argument[2].kind
                || argument[1].value != argument[2].value
                || !pl_select_zero_result_operand(plan, argument[3]))
            return 0;
        *bits = 32u;
        return 1;
    }
    if (node->opcode != PL_OPCODE_X86_SHIFT_FLAGS
            || node->argument_count != 5u
            || argument[3].kind != PL_OPERAND_CONST
            || argument[4].kind != PL_OPERAND_CONST
            || !pl_select_zero_result_operand(plan, argument[1])
            || !pl_select_zero_result_operand(plan, argument[2]))
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 width = (pl_u32)(descriptor & 0x7fu);
    pl_u32 group = (pl_u32)((descriptor >> 8u) & 7u);
    if ((width != 32u && width != 64u)
            || (group != 4u && group != 5u && group != 7u)
            || descriptor != (pl_u64)(width | (group << 8u))
            || !(argument[3].value & (width == 64u ? 63u : 31u)))
        return 0;
    *bits = 32u;
    return 1;
}

static int zero_plain_copy(const pl_plan *plan, pl_u32 local,
                           pl_u32 *source, pl_u32 *bits,
                           int *entry_source)
{
    if (!plan || !source || !bits || !entry_source
            || local >= PL_X86_GPR_COUNT)
        return 0;
    pl_operand value = plan->locals[local];
    if (value.kind == PL_OPERAND_LOCAL
            && value.value < PL_X86_GPR_COUNT
            && value.value != local) {
        *source = (pl_u32)value.value;
        *bits = 64u;
        *entry_source = 1;
        return 1;
    }
    if (value.kind == PL_OPERAND_NODE && pl_select_zero_extend_node(
            plan, (pl_u32)value.value, source, bits)) {
        *entry_source = 1;
        return 1;
    }
    pl_u32 owner = pl_select_publication_owner(plan, value);
    if (owner >= PL_X86_GPR_COUNT || owner == local) return 0;
    *source = owner;
    *bits = value.kind == PL_OPERAND_CONST
         && value.value <= 0xffffffffu ? 32u : 64u;
    *entry_source = 0;
    return 1;
}

static pl_u32 zero_copy_publication_bits(
    const pl_x86_native_selection *selection, pl_operand value,
    pl_u32 bits)
{
    if (!selection || value.kind != PL_OPERAND_CONST || bits != 32u)
        return bits;
    /* The numeric link-time target does not bound a PIE address after the
     * load bias.  The canonical RIP fixup marks the publication as an address
     * rather than a scalar literal, so its owner must be copied at 64 bits. */
    for (pl_u32 fixup = 0u; fixup < selection->fixup_count; ++fixup)
        if (selection->fixups[fixup].kind
                == PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                && selection->fixups[fixup].target == value.value)
            return 64u;
    return bits;
}

static int next_zero_plain_assignment(const pl_plan *plan,
                                      pl_u32 pending,
                                      pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    pl_u32 old_sources = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL) {
            if (value.value >= PL_X86_GPR_COUNT) return 0;
            old_sources |= 1u << (pl_u32)value.value;
        } else if (value.kind == PL_OPERAND_NODE) {
            pl_u32 source = 0u, bits = 0u;
            if (!pl_select_zero_extend_node(
                    plan, (pl_u32)value.value, &source, &bits))
                return 0;
            old_sources |= 1u << source;
        } else if (value.kind != PL_OPERAND_CONST) {
            return 0;
        }
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))
                || (old_sources & (1u << local)))
            continue;
        pl_u32 source = 0u, bits = 0u;
        int entry_source = 0;
        if (zero_plain_copy(
                plan, local, &source, &bits, &entry_source)
                && !entry_source && (pending & (1u << source)))
            continue;
        *selected = local;
        return 1;
    }
    return 0;
}

/* The normalized image of `select(1<<q, 0, (x & (1<<p)) != 0)` is
 * `((x >> p) & 1) << q`, spelled as SHL/SHR by |p-q|, AND with the single-bit
 * mask and, for the complemented zero test, XOR with the same mask.  Decode
 * that exact chain so it can be emitted as a bit test plus a conditional move.
 * The arithmetic spelling cannot reach the source span because a destructive
 * shift needs an entry copy first. */
static int bit_projection_value_details(
    const pl_plan *plan, pl_operand value, pl_operand *source,
    pl_u32 *from, pl_u32 *to, pl_u32 *inverse, pl_u32 *bits)
{
    if (!plan || !source || !from || !to || !inverse || !bits)
        return 0;
    pl_operand left, right, inner = value;
    pl_u32 width = 0u, mode = 0u;
    pl_u64 xor_mask = 0u;
    *inverse = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &left, &right, &width, &mode))
        return 0;
    if (mode == 6u) {
        if (right.kind != PL_OPERAND_CONST) return 0;
        xor_mask = right.value;
        inner = left;
        *inverse = 1u;
        if (!pl_select_arithmetic_tree_details(
                plan, inner, &left, &right, &width, &mode))
            return 0;
    }
    if (mode != 0u || right.kind != PL_OPERAND_CONST) return 0;
    pl_u64 word = width == 64u ? ~0ull : 0xffffffffull;
    pl_u64 mask = right.value & word;
    if (!mask || (mask & (mask - 1u))) return 0;
    if (*inverse && (xor_mask & word) != mask) return 0;
    pl_operand shift_source, amount;
    pl_u32 shift_bits = 0u, group = 0u;
    if (!pl_select_shift_node_details(
            plan, left, &shift_source, &amount, &shift_bits, &group)
            || shift_bits != width
            || amount.kind != PL_OPERAND_CONST
            || (group != 4u && group != 5u))
        return 0;
    pl_u32 q = 0u;
    while ((mask >> q) != 1u) ++q;
    pl_u32 k = (pl_u32)amount.value
             & (shift_bits == 64u ? 63u : 31u);
    if (!k) return 0;
    pl_u32 p = 0u;
    if (group == 4u) {
        if (q < k) return 0;
        p = q - k;
    } else {
        p = q + k;
        if (p >= shift_bits) return 0;
    }
    *source = shift_source;
    *from = p;
    *to = q;
    *bits = shift_bits;
    return 1;
}

/* XOR x,x has one observable flags result and the constant value zero.  Once
 * normalized, neither the source register nor the original destination is an
 * owner requirement.  Choose the shortest surviving zero publication as the
 * one flags-producing instruction and make every equal result a rank-only
 * copy.  This removes both old-value preservation and duplicate zero work. */
static int zero_flag_frame_shape(const pl_x86_block *block,
                                 zero_flag_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (!plan->node_count || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand flag_publication = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_publication.kind != PL_OPERAND_NODE
            || !flag_publication.value
            || flag_publication.value > plan->node_count)
        return 0;
    pl_u32 final_flag_node = (pl_u32)flag_publication.value;
    pl_u32 bits = 0u;
    if (!zero_flag_node_details(&block->plan, final_flag_node, &bits))
        return 0;
    pl_u32 zero = 0u, plain = 0u, anchor = PL_X86_GPR_COUNT;
    out->projection = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        pl_u32 plain_source = 0u, plain_bits = 0u;
        int zero_extend_plain = value.kind == PL_OPERAND_NODE
            && pl_select_zero_extend_node(
                plan, (pl_u32)value.value,
                &plain_source, &plain_bits);
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (pl_select_zero_result_operand(&block->plan, value)) {
            zero |= 1u << local;
            if (anchor >= PL_X86_GPR_COUNT
                    || (anchor >= 8u && local < 8u))
                anchor = local;
        } else if (value.kind == PL_OPERAND_CONST
                || (value.kind == PL_OPERAND_LOCAL
                    && value.value < PL_X86_GPR_COUNT)
                || zero_extend_plain) {
            plain |= 1u << local;
        } else {
            pl_operand source;
            pl_u32 from = 0u, to = 0u, inverse = 0u, projection_width = 0u;
            if (out->projection < PL_X86_GPR_COUNT
                    || !bit_projection_value_details(
                        plan, value, &source, &from, &to, &inverse,
                        &projection_width))
                return 0;
            out->projection = local;
            out->projection_source = source;
            out->projection_from = from;
            out->projection_to = to;
            out->projection_inverse = inverse;
            out->projection_bits = projection_width;
        }
    }
    for (pl_u32 local = PL_X86_GPR_COUNT;
            local < plan->local_count; ++local) {
        if (local == PL_X86_RFLAGS_LOCAL) continue;
        pl_operand value = plan->locals[local];
        if (value.kind != PL_OPERAND_LOCAL || value.value != local)
            return 0;
    }
    if (anchor >= PL_X86_GPR_COUNT) return 0;
    pl_u32 pending = plain;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_zero_plain_assignment(&block->plan, pending, &local))
            return 0;
        pending &= ~(1u << local);
    }
    if (out->projection < PL_X86_GPR_COUNT) {
        pl_operand mask_value = {
            PL_OPERAND_CONST, 1ull << out->projection_to };
        pl_operand input_value = {
            PL_OPERAND_CONST, 1ull << out->projection_from };
        if (!pl_select_published_operand_local(
                plan, mask_value, &out->projection_mask_local)
                || !pl_select_published_operand_local(
                    plan, input_value, &out->projection_input_local)
                || !(plain & (1u << out->projection_mask_local))
                || !(plain & (1u << out->projection_input_local))
                || out->projection_mask_local == out->projection
                || out->projection_input_local == out->projection)
            return 0;
        if (out->projection_source.kind == PL_OPERAND_LOCAL
                && out->projection_source.value < PL_X86_GPR_COUNT) {
            out->projection_source_local =
                (pl_u32)out->projection_source.value;
        } else if (!pl_select_published_operand_local(
                       plan, out->projection_source,
                       &out->projection_source_local)) {
            return 0;
        }
        pl_u32 source = out->projection_source_local;
        pl_operand publication = plan->locals[source];
        int identity = publication.kind == PL_OPERAND_LOCAL
                    && publication.value == source;
        if (source == out->projection || (zero & (1u << source))
                || (!identity && !(plain & (1u << source))))
            return 0;
    }
    out->zero = zero;
    out->plain = plain;
    out->anchor = anchor;
    out->flag_bits = bits;
    return 1;
}

int pl_select_measure_direct_zero_flag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    zero_flag_frame shape = { 0 };
    if (!zero_flag_frame_shape(block, &shape)) return 0;
    pl_u32 bytes = 0u, instructions = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u, source = 0u, bits = 0u;
        int entry_source = 0;
        if (!next_zero_plain_assignment(&block->plan, pending, &local))
            return 0;
        int copy = zero_plain_copy(
            &block->plan, local, &source, &bits, &entry_source);
        if (copy)
            bits = zero_copy_publication_bits(
                selection, block->plan.locals[local], bits);
        int measured = copy
                     ? entry_source && bits < 64u
                       ? pl_select_emit_zero_extend_move(
                           local, source, bits, 0, &encoded)
                       : pl_select_emit_gpr_move(local, source, bits, 0, &encoded)
                     : pl_select_measure_frame_value(
                           frontend, block, selection, local,
                           block->plan.locals[local], bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    if (shape.projection < PL_X86_GPR_COUNT) {
        pl_u32 projection_encoded = 0u;
        if (!pl_select_emit_zero_register(shape.projection, 0, &projection_encoded)
                || bytes > U32_MAX_VALUE - projection_encoded)
            return 0;
        bytes += projection_encoded;
        ++instructions;
        if (!pl_select_emit_test_registers(
                shape.projection_source_local, shape.projection_input_local,
                shape.projection_bits, 0, &projection_encoded)
                || bytes > U32_MAX_VALUE - projection_encoded)
            return 0;
        bytes += projection_encoded;
        ++instructions;
        if (!pl_select_emit_conditional_move(
                shape.projection, shape.projection_mask_local, 64u,
                shape.projection_inverse ? 4u : 5u, 0, &projection_encoded)
                || bytes > U32_MAX_VALUE - projection_encoded)
            return 0;
        bytes += projection_encoded;
        ++instructions;
    }
    pl_u32 encoded = 0u;
    pl_operand self = { PL_OPERAND_LOCAL, shape.anchor };
    if (!pl_select_emit_alu_instruction(
            shape.anchor, self, shape.flag_bits, 6u, 0u, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.anchor || !(shape.zero & (1u << local))) continue;
        if (!pl_select_emit_gpr_move(local, shape.anchor, 32u, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_zero_flag_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.anchor;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* A destructive shift may leave its original register with an unrelated
 * final value while publishing the shift result elsewhere.  Moving the entry
 * value to the final register first introduces an artificial wave.  Instead,
 * execute the shift in its entry coordinate, hand the result to every final
 * rank, then publish the overwrite.  For a nonzero constant count the shift
 * also rebases flags, so this order is both exact and span-minimal. */
static int shift_handoff_frame_shape(const pl_x86_block *block,
                                     shift_handoff_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && block->successor_count != 1u)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (plan->node_count != 2u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand result = { PL_OPERAND_NODE, 1u };
    pl_operand source, amount;
    pl_u32 bits = 0u, group = 0u;
    if (!pl_select_shift_node_details(
            plan, result, &source, &amount, &bits, &group)
            || source.kind != PL_OPERAND_LOCAL
            || source.value >= PL_X86_GPR_COUNT
            || amount.kind != PL_OPERAND_CONST
            || !(amount.value & (bits == 64u ? 63u : 31u))
            || (group != 4u && group != 5u && group != 7u))
        return 0;
    pl_u32 owner = (pl_u32)source.value;
    const pl_node *flags = &plan->nodes[1];
    if (flags->opcode != PL_OPCODE_X86_SHIFT_FLAGS
            || flags->argument_count != 5u
            || flags->argument_at > plan->argument_count
            || flags->argument_count
               > plan->argument_count - flags->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + flags->argument_at;
    pl_u64 descriptor = (pl_u64)bits | ((pl_u64)group << 8u);
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != source.kind
            || argument[1].value != source.value
            || argument[2].kind != result.kind
            || argument[2].value != result.value
            || argument[3].kind != amount.kind
            || argument[3].value != amount.value
            || argument[4].kind != PL_OPERAND_CONST
            || argument[4].value != descriptor)
        return 0;
    pl_operand flag_publication = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flag_publication.kind != PL_OPERAND_NODE
            || flag_publication.value != 2u)
        return 0;

    pl_u32 outputs = 0u, plain = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand publication = plan->locals[local];
        if (local == owner) {
            if (publication.kind != PL_OPERAND_CONST) return 0;
            continue;
        }
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (publication.kind == result.kind
                && publication.value == result.value) {
            outputs |= 1u << local;
        } else if (publication.kind == PL_OPERAND_CONST
                || (publication.kind == PL_OPERAND_LOCAL
                    && publication.value < PL_X86_GPR_COUNT)) {
            plain |= 1u << local;
        } else {
            return 0;
        }
    }
    if (!outputs) return 0;
    for (pl_u32 local = PL_X86_GPR_COUNT;
            local < plan->local_count; ++local) {
        if (local == PL_X86_RFLAGS_LOCAL) continue;
        pl_operand publication = plan->locals[local];
        if (publication.kind != PL_OPERAND_LOCAL
                || publication.value != local)
            return 0;
    }
    pl_u32 pending = plain;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_transient_plain_assignment(plan, pending, &local))
            return 0;
        pending &= ~(1u << local);
    }
    out->owner = owner;
    out->outputs = outputs;
    out->plain = plain;
    out->bits = bits;
    out->group = group;
    out->amount = amount;
    return 1;
}

int pl_select_measure_direct_shift_handoff_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    shift_handoff_frame shape = { 0 };
    if (!shift_handoff_frame_shape(block, &shape)) return 0;
    pl_u32 bytes = 0u, instructions = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local))
            return 0;
        int measured = pl_select_measure_frame_value(
            frontend, block, selection, local,
            block->plan.locals[local], bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    pl_u32 encoded = 0u;
    if (!pl_select_emit_shift_instruction(
            shape.owner, shape.amount, shape.bits, shape.group,
            0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (!pl_select_emit_gpr_move(local, shape.owner, shape.bits, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    int measured = pl_select_measure_frame_value(
        frontend, block, selection, shape.owner,
        block->plan.locals[shape.owner], bytes, &encoded);
    if (measured <= 0 || bytes > U32_MAX_VALUE - encoded)
        return measured < 0 ? measured : 0;
    bytes += encoded;
    ++instructions;
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shift_handoff_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.owner;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* A published intermediate need not be computed in its final register.
 * When a second publication consumes it and its leaf is that consumer's
 * entry register, let the consumer own the destructive chain first.  The
 * intermediate and the suffix then fan out in one wave instead of either
 * recomputing the prefix or serializing both publications. */
static int shared_owner_frame_shape(const pl_x86_block *block,
                                    shared_owner_frame *out)
{
    if (!block || !out) return 0;
    pl_u32 changed = 0u;
    pl_u32 final_flag_node = 0u;
    out->has_branch = (pl_u32)pl_select_compare_branch_shape(
        block, &changed, &out->compare_left, &out->compare_right,
        &out->compare_bits, &out->condition, &out->test);
    pl_u8 flag_prefix = 0u;
    if (out->has_branch
            && (!pl_select_compare_flag_prefix(&block->plan, &flag_prefix)
                || flag_prefix))
        return 0;
    if (!out->has_branch) {
        if (block->kind != PL_X86_BLOCK_DIRECT
                || block->flow != PL_X86_FLOW_NEXT
                || block->dynamic_target || block->has_predicate
                || block->has_fault_predicate
                || block->machine_operation != PL_X86_MACHINE_NONE
                || !pl_select_alu_frame_shape(
                    &block->plan, &changed, &final_flag_node))
            return 0;
    }
    for (pl_u32 owner = 0u; owner < PL_X86_GPR_COUNT; ++owner) {
        if (!(changed & (1u << owner))) continue;
        pl_operand owner_value = block->plan.locals[owner];
        pl_operand owner_left;
        pl_u32 owner_node = owner_value.kind == PL_OPERAND_PROJECTION
                          ? (pl_u32)(owner_value.value >> 8u) : 0u;
        if (owner_node) {
            pl_u32 destination = 0u;
            if (!pl_select_alu_node_details(
                    &block->plan, owner_node, &destination, &owner_left,
                    &out->owner_right, &out->owner_bits,
                    &out->owner_mode, &out->owner_preserves_carry)
                    || destination != owner
                    || (!out->has_branch && final_flag_node
                        && owner_node != final_flag_node))
                continue;
        } else {
            out->owner_preserves_carry = 0u;
            if (!pl_select_arithmetic_node_details(
                    &block->plan, owner_value, &owner_left,
                    &out->owner_right, &out->owner_bits,
                    &out->owner_mode))
                continue;
        }
        if (owner_left.kind != PL_OPERAND_NODE) continue;
        for (pl_u32 shared = 0u; shared < PL_X86_GPR_COUNT; ++shared) {
            if (shared == owner || !(changed & (1u << shared))) continue;
            pl_operand shared_value = block->plan.locals[shared];
            if (shared_value.kind != owner_left.kind
                    || shared_value.value != owner_left.value)
                continue;
            if (changed != ((1u << owner) | (1u << shared)))
                continue;
            /* The suffix is evaluated after the shared register is
             * published and after the owner entry value is destroyed.  It
             * therefore may not name either entry coordinate directly. */
            if (out->owner_right.kind == PL_OPERAND_LOCAL
                    && (out->owner_right.value == owner
                        || out->owner_right.value == shared))
                continue;
            out->owner = owner;
            out->shared = shared;
            out->shared_bits = out->owner_bits;
            out->shared_value = shared_value;
            return 1;
        }
    }
    return 0;
}

int pl_select_measure_direct_shared_owner_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    shared_owner_frame shape = { 0 };
    if (!shared_owner_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u;
    pl_u32 encoded = 0u, work = 0u;
    int measured = pl_select_measure_alu_seed(
        frontend, block, selection, shape.owner, shape.shared_value,
        shape.shared_bits, bytes, block->plan.node_count + 1u,
        &encoded, &work);
    if (measured <= 0) return measured;
    bytes += encoded;
    instructions += work;
    if (!pl_select_emit_gpr_move(
            shape.shared, shape.owner, shape.shared_bits, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    if (!pl_select_emit_alu_instruction(
            shape.owner, shape.owner_right, shape.owner_bits,
            shape.owner_mode, shape.owner_preserves_carry, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;

    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (shape.has_branch) {
        int flags_emitted = shape.test
            ? pl_select_emit_test_registers(
                shape.compare_left, shape.compare_right,
                shape.compare_bits, 0, &encoded)
            : pl_select_emit_compare_registers(
                shape.compare_left, shape.compare_right,
                shape.compare_bits, 0, &encoded);
        if (!flags_emitted || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
        pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + (block->relax_short_control ? 2u : 1u),
            bytes + branch_bytes, block->successor[0]);
        if (status) return status;
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shared_owner_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* AND/OR/XOR define exactly the flags observed by TEST(result, result): SF,
 * ZF and PF come from the same result, CF and OF are zero, and AF is
 * undefined in both cases.  Once normalization has substituted the logical
 * result into the TEST, keeping a second flag producer is therefore not an
 * exact-future requirement.  Compute the shared value once, publish every
 * equal register result with flag-preserving MOVs, and consume the original
 * logical flags directly at the conditional cut. */
static int value_predicate_frame_shape(const pl_x86_block *block,
                                       value_predicate_frame *out)
{
    if (!block || !out) return 0;
    pl_u32 changed = 0u, compare_left = 0u, compare_right = 0u;
    pl_u32 compare_bits = 0u, condition = 0u, test = 0u;
    pl_u8 flag_prefix = 0u;
    if (!pl_select_compare_branch_shape(
            block, &changed, &compare_left, &compare_right,
            &compare_bits, &condition, &test)
            || !test
            || !pl_select_compare_flag_prefix(&block->plan, &flag_prefix)
            || flag_prefix)
        return 0;

    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    const pl_node *predicate = &block->plan.nodes[flags.value - 1u];
    const pl_operand *argument =
        block->plan.arguments + predicate->argument_at;
    pl_operand value = argument[1];
    if (value.kind != argument[2].kind || value.value != argument[2].value)
        return 0;

    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (value.kind == PL_OPERAND_NODE) {
        if (!pl_select_arithmetic_node_details(
                &block->plan, value, &left, &right, &bits, &mode))
            return 0;
    } else if (value.kind == PL_OPERAND_PROJECTION
            && (value.value & 0xffu) == 16u) {
        pl_u32 destination = 0u;
        if (!pl_select_alu_node_details(
                &block->plan, (pl_u32)(value.value >> 8u),
                &destination, &left, &right, &bits, &mode,
                &preserves_carry))
            return 0;
    } else {
        return 0;
    }
    if (preserves_carry || (mode != 0u && mode != 5u && mode != 6u))
        return 0;
    /* A 32-bit logical result is zero-extended when published to a 64-bit
     * GPR.  Its 64-bit TEST flags equal the producer's 32-bit flags only when
     * bit 31 is proved zero: ZF/PF are then unchanged and SF is zero at both
     * widths.  An AND with either constant mask clearing that bit is the exact
     * general certificate; do not infer it merely from this block's branch
     * condition because RFLAGS itself remains an architectural publication. */
    int same_flags = bits == compare_bits;
    if (!same_flags && bits == 32u && compare_bits == 64u && mode == 0u)
        same_flags = (left.kind == PL_OPERAND_CONST
                         && !(left.value & 0x80000000u))
                  || (right.kind == PL_OPERAND_CONST
                         && !(right.value & 0x80000000u));
    if (!same_flags) return 0;

    pl_u32 outputs = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand publication = block->plan.locals[local];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (publication.kind != value.kind || publication.value != value.value)
            return 0;
        outputs |= 1u << local;
    }
    for (pl_u32 local = PL_X86_GPR_COUNT;
            local < block->plan.local_count; ++local) {
        if (local == PL_X86_RFLAGS_LOCAL) continue;
        pl_operand publication = block->plan.locals[local];
        if (publication.kind != PL_OPERAND_LOCAL
                || publication.value != local)
            return 0;
    }
    pl_u32 owner = pl_select_publication_owner(&block->plan, value);
    if (!outputs || outputs != changed || owner >= PL_X86_GPR_COUNT
            || !(outputs & (1u << owner))
            || (right.kind == PL_OPERAND_LOCAL && right.value == owner
                && !(left.kind == PL_OPERAND_LOCAL && left.value == owner)))
        return 0;

    out->owner = owner;
    out->outputs = outputs;
    out->bits = bits;
    out->mode = mode;
    out->preserves_carry = preserves_carry;
    out->condition = condition;
    out->value = value;
    out->left = left;
    out->right = right;
    return 1;
}

int pl_select_measure_direct_value_predicate_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    value_predicate_frame shape = { 0 };
    if (!value_predicate_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u, encoded = 0u, work = 0u;
    int measured = pl_select_measure_alu_seed(
        frontend, block, selection, shape.owner, shape.left, shape.bits,
        bytes, block->plan.node_count + 1u, &encoded, &work);
    if (measured <= 0) return measured;
    bytes += encoded;
    instructions += work;
    if (!pl_select_emit_alu_instruction(
            shape.owner, shape.right, shape.bits, shape.mode,
            shape.preserves_carry, 0, &encoded)
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.owner || !(shape.outputs & (1u << local)))
            continue;
        if (!pl_select_emit_gpr_move(local, shape.owner, shape.bits, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
    int status = pl_select_append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        bytes + (block->relax_short_control ? 2u : 1u),
        bytes + branch_bytes, block->successor[0]);
    if (status) return status;
    bytes += branch_bytes;
    ++instructions;

    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_value_predicate_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* A destructive ALU result can be published away from its entry register
 * while that entry register receives an independent final value.  Seeding the
 * final register first serializes the ALU behind an unnecessary MOV.  Execute
 * in the entry owner, hand the result to every equal publication with MOV,
 * then overwrite the owner from the independent SSA branch.  The final
 * CMP/TEST joins those parallel branches at their real dependency cut. */
static int compare_handoff_frame_shape(const pl_x86_block *block,
                                       compare_handoff_frame *out)
{
    if (!block || !out) return 0;
    pl_u32 changed = 0u, compare_left = 0u, compare_right = 0u;
    pl_u32 bits = 0u, condition = 0u, test = 0u;
    pl_u8 flag_prefix = 0u;
    if (!pl_select_compare_branch_shape(
            block, &changed, &compare_left, &compare_right,
            &bits, &condition, &test)
            || !pl_select_compare_flag_prefix(&block->plan, &flag_prefix)
            || flag_prefix)
        return 0;

    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    const pl_node *compare = &block->plan.nodes[flags.value - 1u];
    const pl_operand *argument = block->plan.arguments + compare->argument_at;
    for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
        pl_operand transient = argument[1u + orientation];
        pl_operand replacement = argument[2u - orientation];
        pl_operand left, right;
        pl_u32 transient_bits = 0u, mode = 0u;
        if (!pl_select_arithmetic_node_details(
                &block->plan, transient, &left, &right,
                &transient_bits, &mode)
                || transient_bits != bits
                || left.kind != PL_OPERAND_LOCAL
                || left.value >= PL_X86_GPR_COUNT)
            continue;
        pl_u32 owner = (pl_u32)left.value;
        pl_operand owner_publication = block->plan.locals[owner];
        if (owner_publication.kind != replacement.kind
                || owner_publication.value != replacement.value)
            continue;
        if (bits == 32u
                && !pl_select_operand_fits_u32(
                    &block->plan, replacement,
                    block->plan.node_count + 1u))
            continue;

        pl_u32 outputs = 0u;
        int valid = 1;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand publication = block->plan.locals[local];
            if (local == owner) continue;
            if (publication.kind == PL_OPERAND_LOCAL
                    && publication.value == local)
                continue;
            if (publication.kind == transient.kind
                    && publication.value == transient.value) {
                outputs |= 1u << local;
            } else {
                valid = 0;
                break;
            }
        }
        if (!valid || !outputs
                || changed != (outputs | (1u << owner)))
            continue;
        for (pl_u32 local = PL_X86_GPR_COUNT;
                valid && local < block->plan.local_count; ++local) {
            if (local == PL_X86_RFLAGS_LOCAL) continue;
            pl_operand publication = block->plan.locals[local];
            if (publication.kind != PL_OPERAND_LOCAL
                    || publication.value != local)
                valid = 0;
        }
        pl_u32 replacement_sources = 0u;
        if (!valid || !pl_select_operand_gpr_sources(
                &block->plan, replacement,
                block->plan.node_count + 1u,
                block->plan.node_count + 1u, &replacement_sources)
                || (replacement_sources & (outputs | (1u << owner))))
            continue;

        out->owner = owner;
        out->outputs = outputs;
        out->bits = bits;
        out->mode = mode;
        out->condition = condition;
        out->compare_left = compare_left;
        out->compare_right = compare_right;
        out->test = test;
        out->transient = transient;
        out->replacement = replacement;
        out->right = right;
        return 1;
    }
    return 0;
}

int pl_select_measure_direct_compare_handoff_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    compare_handoff_frame shape = { 0 };
    if (!compare_handoff_frame_shape(block, &shape)) return 0;

    pl_u32 bytes = 0u, instructions = 0u, encoded = 0u;
    if (!pl_select_emit_alu_instruction(
            shape.owner, shape.right, shape.bits, shape.mode, 0u,
            0, &encoded))
        return 0;
    bytes += encoded;
    ++instructions;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (!pl_select_emit_gpr_move(local, shape.owner, shape.bits, 0, &encoded)
                || bytes > U32_MAX_VALUE - encoded)
            return 0;
        bytes += encoded;
        ++instructions;
    }
    pl_u32 work = 0u;
    int measured = pl_select_measure_alu_seed(
        frontend, block, selection, shape.owner, shape.replacement,
        shape.bits, bytes, block->plan.node_count + 1u,
        &encoded, &work);
    if (measured <= 0 || bytes > U32_MAX_VALUE - encoded
            || instructions > U32_MAX_VALUE - work)
        return measured < 0 ? measured : 0;
    bytes += encoded;
    instructions += work;
    int flags_emitted = shape.test
        ? pl_select_emit_test_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, 0, &encoded)
        : pl_select_emit_compare_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, 0, &encoded);
    if (!flags_emitted || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
    int status = pl_select_append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        bytes + (block->relax_short_control ? 2u : 1u),
        bytes + branch_bytes, block->successor[0]);
    if (status) return status;
    bytes += branch_bytes;
    ++instructions;

    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_compare_handoff_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_transient_owner_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection
            || !selection->direct_transient_owner_frame || !output)
        return PL_ERROR_X86_SELECT;
    transient_owner_frame shape = { 0 };
    if (!transient_owner_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u;
    pl_u32 pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local)
                || !pl_select_write_frame_value(
                    selection, at, local, block->plan.locals[local],
                    output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    pl_u32 written = 0u;
    if (!pl_select_write_alu_seed(
            block, selection, shape.owner, shape.select.current,
            shape.select.value_bits, at,
            block->plan.node_count + 1u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    pl_operand owner_value = { PL_OPERAND_LOCAL, shape.owner };
    if (!pl_select_emit_add_lea(
            shape.consumer, owner_value, shape.consumer_right,
            shape.consumer_bits, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!pl_select_emit_compare_operand(
            shape.select.compare_left_local, shape.select.compare_right,
            shape.select.compare_bits, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!pl_select_emit_conditional_move(
            shape.owner, shape.select.candidate_local,
            shape.select.value_bits, shape.select.condition,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_zero_flag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_zero_flag_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    zero_flag_frame shape = { 0 };
    if (!zero_flag_frame_shape(block, &shape)
            || shape.anchor != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, written = 0u, source = 0u, bits = 0u;
        int entry_source = 0;
        if (!next_zero_plain_assignment(&block->plan, pending, &local))
            return PL_ERROR_X86_SELECT;
        int copy = zero_plain_copy(
            &block->plan, local, &source, &bits, &entry_source);
        if (copy)
            bits = zero_copy_publication_bits(
                selection, block->plan.locals[local], bits);
        int emitted = copy
                    ? entry_source && bits < 64u
                      ? pl_select_emit_zero_extend_move(
                          local, source, bits, output + at, &written)
                      : pl_select_emit_gpr_move(
                          local, source, bits, output + at, &written)
                    : pl_select_write_frame_value(
                          selection, at, local, block->plan.locals[local],
                          output + at, &written);
        if (!emitted) return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    if (shape.projection < PL_X86_GPR_COUNT) {
        pl_u32 projection_written = 0u;
        if (!pl_select_emit_zero_register(
                shape.projection, output + at, &projection_written))
            return PL_ERROR_X86_SELECT;
        at += projection_written;
        if (!pl_select_emit_test_registers(
                shape.projection_source_local, shape.projection_input_local,
                shape.projection_bits, output + at, &projection_written))
            return PL_ERROR_X86_SELECT;
        at += projection_written;
        if (!pl_select_emit_conditional_move(
                shape.projection, shape.projection_mask_local, 64u,
                shape.projection_inverse ? 4u : 5u,
                output + at, &projection_written))
            return PL_ERROR_X86_SELECT;
        at += projection_written;
    }
    pl_u32 written = 0u;
    pl_operand self = { PL_OPERAND_LOCAL, shape.anchor };
    if (!pl_select_emit_alu_instruction(
            shape.anchor, self, shape.flag_bits, 6u, 0u,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.anchor || !(shape.zero & (1u << local))) continue;
        if (!pl_select_emit_gpr_move(
                local, shape.anchor, 32u, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_shift_handoff_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shift_handoff_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    shift_handoff_frame shape = { 0 };
    if (!shift_handoff_frame_shape(block, &shape)
            || shape.owner != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, pending = shape.plain;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_transient_plain_assignment(
                &block->plan, pending, &local)
                || !pl_select_write_frame_value(
                    selection, at, local, block->plan.locals[local],
                    output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    pl_u32 written = 0u;
    if (!pl_select_emit_shift_instruction(
            shape.owner, shape.amount, shape.bits, shape.group,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (!pl_select_emit_gpr_move(
                local, shape.owner, shape.bits,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (!pl_select_write_frame_value(
            selection, at, shape.owner,
            block->plan.locals[shape.owner], output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
            output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_shared_owner_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shared_owner_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    shared_owner_frame shape = { 0 };
    if (!shared_owner_frame_shape(block, &shape)
            || (shape.has_branch
                && shape.condition != selection->frame_anchor))
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u, written = 0u;
    if (!pl_select_write_alu_seed(
            block, selection, shape.owner, shape.shared_value,
            shape.shared_bits, at, block->plan.node_count + 1u,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_emit_gpr_move(
                shape.shared, shape.owner, shape.shared_bits,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_emit_alu_instruction(
                shape.owner, shape.owner_right, shape.owner_bits,
                shape.owner_mode, shape.owner_preserves_carry,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!shape.has_branch)
        return at == selection->output_bytes
             ? 0 : PL_ERROR_X86_SELECT;
    int flags_emitted = shape.test
        ? pl_select_emit_test_registers(
            shape.compare_left, shape.compare_right,
            shape.compare_bits, output + at, &written)
        : pl_select_emit_compare_registers(
            shape.compare_left, shape.compare_right,
            shape.compare_bits, output + at, &written);
    if (!flags_emitted) return PL_ERROR_X86_SELECT;
    at += written;
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + shape.condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + shape.condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_value_predicate_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_value_predicate_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    value_predicate_frame shape = { 0 };
    if (!value_predicate_frame_shape(block, &shape)
            || shape.condition != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u, written = 0u;
    if (!pl_select_write_alu_seed(
            block, selection, shape.owner, shape.left, shape.bits, at,
            block->plan.node_count + 1u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_emit_alu_instruction(
                shape.owner, shape.right, shape.bits, shape.mode,
                shape.preserves_carry, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == shape.owner || !(shape.outputs & (1u << local)))
            continue;
        if (at > selection->output_bytes
                || !pl_select_emit_gpr_move(
                    local, shape.owner, shape.bits, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + shape.condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + shape.condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_compare_handoff_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_compare_handoff_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    compare_handoff_frame shape = { 0 };
    if (!compare_handoff_frame_shape(block, &shape)
            || shape.condition != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;

    pl_u32 at = 0u, written = 0u;
    if (!pl_select_emit_alu_instruction(
            shape.owner, shape.right, shape.bits, shape.mode, 0u,
            output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape.outputs & (1u << local))) continue;
        if (at > selection->output_bytes
                || !pl_select_emit_gpr_move(
                    local, shape.owner, shape.bits, output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
    }
    if (at > selection->output_bytes
            || !pl_select_write_alu_seed(
                block, selection, shape.owner, shape.replacement,
                shape.bits, at, block->plan.node_count + 1u,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    int flags_emitted = shape.test
        ? pl_select_emit_test_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, output + at, &written)
        : pl_select_emit_compare_registers(
            shape.compare_left, shape.compare_right,
            shape.bits, output + at, &written);
    if (!flags_emitted) return PL_ERROR_X86_SELECT;
    at += written;
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + shape.condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + shape.condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}
