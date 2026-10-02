/* branch-frame: native x86 selection. */
#include "branch-frame.h"
#include "limits.h"
#include "lea.h"
#include "encoding.h"
#include "expressions.h"
#include "flags.h"
#include "handoff.h"
#include "operands.h"
#include "select.h"
#include "select-rules.h"
#include "simple-frame.h"
#include "source.h"
#include "state-frame.h"
#include "tree-measure.h"
#include "tree-write.h"

static int shared_sub_frame_shape(const pl_x86_block *block,
                                  shared_sub_frame *out);

static int compare_branch_operand_shape(
    const pl_x86_block *block, compare_branch_operands *out);

static int operand_contains_value(const pl_plan *plan, pl_operand root,
                                  pl_operand value, pl_u32 remaining);

static int subtract_tree_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *left, pl_operand *right,
                                 pl_u32 *bits);

static int subtract_handoff_shape(const pl_plan *plan, pl_u32 changed,
                                  subtract_handoff *out);

static int entry_flag_branch_shape(const pl_x86_block *block,
                                   pl_u32 *changed, pl_u32 *condition,
                                   pl_u32 *extension_dest,
                                   pl_u32 *extension_source,
                                   pl_u32 *extension_bits);

static int mask_flag_branch_shape(const pl_x86_block *block,
                                  mask_flag_branch *out);

static int signed_word_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                     signed_word_handoff *out);

static int emit_signed_word_publications(const signed_word_handoff *shape,
                                         pl_u8 *output, pl_u32 *written);

/* One subtraction publishes its result to both the destructive owner and a
 * second register. Copy the entry owner before producing the right operand,
 * then subtract into each owner independently. The second subtraction must
 * target the original owner so its flags are the architectural publication.
 * This removes the copy-back that a generic register frame inserts between
 * the shared right-hand tree and the two final publications. */
static int shared_sub_frame_shape(const pl_x86_block *block,
                                  shared_sub_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 changed = 0u, final = 0u;
    if (!pl_select_alu_frame_shape(plan, &changed, &final) || !final
            || pl_select_plan_has_memory(plan)) return 0;
    pl_operand source, right;
    pl_u32 bits = 0u, mode = 0u, carry = 0u;
    if (!pl_select_alu_node_semantics(plan, final, &source, &right,
                            &bits, &mode, &carry)
            || bits != 64u || mode != 3u || carry
            || source.kind != PL_OPERAND_LOCAL
            || source.value >= PL_X86_GPR_COUNT
            || right.kind != PL_OPERAND_NODE
            || !right.value || right.value >= final)
        return 0;
    pl_u32 owner = (pl_u32)source.value;
    pl_operand result = {
        PL_OPERAND_PROJECTION, ((pl_u64)final << 8u) | 16u,
    };
    if (plan->locals[owner].kind != result.kind
            || plan->locals[owner].value != result.value)
        return 0;
    pl_u32 right_owner = PL_X86_GPR_COUNT;
    if (!pl_select_published_operand_local(plan, right, &right_owner)
            || right_owner == owner) return 0;
    pl_u32 duplicate = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == owner || local == right_owner) continue;
        if (plan->locals[local].kind == result.kind
                && plan->locals[local].value == result.value) {
            if (duplicate != PL_X86_GPR_COUNT) return 0;
            duplicate = local;
        }
    }
    if (duplicate == PL_X86_GPR_COUNT
            || changed != ((1u << owner) | (1u << duplicate)
                           | (1u << right_owner)))
        return 0;
    pl_u32 sources[PL_X86_GPR_COUNT];
    pl_u32 dependencies[PL_X86_GPR_COUNT];
    if (!pl_select_alu_frame_source_laws(plan, sources, dependencies)
            || (sources[right_owner] & (1u << duplicate)))
        return 0;
    *out = (shared_sub_frame){ owner, duplicate, right_owner, right };
    return 1;
}

int pl_select_measure_direct_shared_sub_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    shared_sub_frame shape;
    if (!shared_sub_frame_shape(block, &shape)) return 0;
    pl_u32 move = 0u, tree = 0u, tree_work = 0u;
    pl_u32 first = 0u, last = 0u;
    pl_operand right = { PL_OPERAND_LOCAL, shape.right_owner };
    if (!pl_select_emit_gpr_move(shape.duplicate, shape.owner, 64u, 0, &move))
        return 0;
    int measured = pl_select_measure_alu_tree(
        frontend, block, selection, shape.right_owner, shape.right,
        64u, move, block->plan.node_count + 1u, 0u,
        &tree, &tree_work);
    if (measured <= 0) return measured;
    if (!pl_select_emit_alu_instruction(shape.duplicate, right, 64u, 3u, 0u,
                              0, &first)
            || !pl_select_emit_alu_instruction(shape.owner, right, 64u, 3u, 0u,
                                      0, &last)
            || move > U32_MAX_VALUE - tree
            || move + tree > U32_MAX_VALUE - first
            || move + tree + first > U32_MAX_VALUE - last
            || tree_work > U32_MAX_VALUE - 3u)
        return 0;
    selection->output_bytes = move + tree + first + last;
    selection->output_instructions = tree_work + 3u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shared_sub_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int compare_branch_operand_shape(
    const pl_x86_block *block, compare_branch_operands *out)
{
    if (!block || !out
            || block->flow != PL_X86_FLOW_CONDITIONAL
            || !block->has_predicate || block->dynamic_target
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 2u
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > block->plan.node_count
            || block->predicate.kind != PL_OPERAND_PROJECTION
            || (block->predicate.value >> 8u) != flags.value
            || (block->predicate.value & 0xffu) > 15u)
        return 0;
    const pl_node *compare = &block->plan.nodes[flags.value - 1u];
    if ((compare->opcode != PL_OPCODE_X86_COMPARE
            && compare->opcode != PL_OPCODE_X86_TEST)
            || compare->argument_count != 4u
            || compare->argument_at > block->plan.argument_count
            || compare->argument_count
               > block->plan.argument_count - compare->argument_at)
        return 0;
    const pl_operand *arguments =
        block->plan.arguments + compare->argument_at;
    if (arguments[3].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = arguments[3].value;
    out->bits = (pl_u32)(descriptor & 0x7fu);
    out->test = compare->opcode == PL_OPCODE_X86_TEST;
    if ((out->bits != 8u && out->bits != 16u
            && out->bits != 32u && out->bits != 64u)
            || (!out->test && ((descriptor >> 8u) & 7u) != 3u)
            || (descriptor >> 11u))
        return 0;
    out->left = PL_X86_GPR_COUNT;
    out->right = arguments[2];
    if (arguments[1].kind == PL_OPERAND_LOCAL
            && arguments[1].value < PL_X86_GPR_COUNT) {
        pl_u32 identity = (pl_u32)arguments[1].value;
        pl_operand publication = block->plan.locals[identity];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == identity)
            out->left = identity;
    }
    if (out->right.kind == PL_OPERAND_LOCAL
            && arguments[2].value < PL_X86_GPR_COUNT) {
        pl_u32 identity = (pl_u32)arguments[2].value;
        pl_operand publication = block->plan.locals[identity];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == identity)
            out->right.value = identity;
        else
            out->right.value = PL_X86_GPR_COUNT;
    } else if (out->right.kind != PL_OPERAND_CONST) {
        out->right.kind = PL_OPERAND_LOCAL;
        out->right.value = PL_X86_GPR_COUNT;
    }
    out->changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand publication = block->plan.locals[local];
        if (!(publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)) {
            if (publication.kind != PL_OPERAND_CONST
                    && publication.kind != PL_OPERAND_NODE
                    && publication.kind != PL_OPERAND_PROJECTION
                    && (publication.kind != PL_OPERAND_LOCAL
                        || publication.value >= PL_X86_GPR_COUNT))
                return 0;
            out->changed |= 1u << local;
        }
        if (out->left == PL_X86_GPR_COUNT
                && publication.kind == arguments[1].kind
                && publication.value == arguments[1].value)
            out->left = local;
        if (out->right.kind == PL_OPERAND_LOCAL
                && out->right.value == PL_X86_GPR_COUNT
                && publication.kind == arguments[2].kind
                && publication.value == arguments[2].value)
            out->right.value = local;
    }
    out->condition = (pl_u32)(block->predicate.value & 0xffu);
    /* A constant already published in a GPR is also an exact operand.
     * Select its shorter encoding here, inside the one comparison grammar;
     * zero in RAX, for example, can beat a sign-extended CMP immediate. */
    if (out->left < PL_X86_GPR_COUNT && out->right.kind == PL_OPERAND_CONST) {
        pl_u32 shortest = U32_MAX_VALUE, encoded = 0u;
        if (out->test
                ? pl_select_emit_test_operand(out->left, out->right, out->bits, 0, &encoded)
                : pl_select_emit_compare_operand(out->left, out->right, out->bits, 0, &encoded))
            shortest = encoded;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand publication = block->plan.locals[local];
            if (publication.kind != arguments[2].kind
                    || publication.value != arguments[2].value) continue;
            pl_operand candidate = { PL_OPERAND_LOCAL, local };
            int emitted = out->test
                ? pl_select_emit_test_operand(out->left, candidate, out->bits, 0, &encoded)
                : pl_select_emit_compare_operand(out->left, candidate, out->bits, 0, &encoded);
            if (emitted && encoded < shortest) {
                out->right = candidate;
                shortest = encoded;
            }
        }
    }
    return out->left < PL_X86_GPR_COUNT
        && (out->right.kind == PL_OPERAND_CONST
            || (out->right.kind == PL_OPERAND_LOCAL
                && out->right.value < PL_X86_GPR_COUNT));
}

int pl_select_compare_branch_shape(const pl_x86_block *block, pl_u32 *changed,
                                pl_u32 *left, pl_u32 *right,
                                pl_u32 *bits, pl_u32 *condition,
                                pl_u32 *test)
{
    compare_branch_operands shape;
    if (!changed || !left || !right || !bits || !condition || !test
            || !compare_branch_operand_shape(block, &shape)
            || shape.right.kind != PL_OPERAND_LOCAL) return 0;
    *changed = shape.changed;
    *left = shape.left;
    *right = (pl_u32)shape.right.value;
    *bits = shape.bits;
    *condition = shape.condition;
    *test = shape.test;
    return 1;
}

int pl_select_compare_flag_prefix(const pl_plan *plan, pl_u8 *byte)
{
    if (!plan || !byte || plan->local_count <= PL_X86_RFLAGS_LOCAL)
        return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > plan->node_count)
        return 0;
    const pl_node *compare = &plan->nodes[flags.value - 1u];
    if ((compare->opcode != PL_OPCODE_X86_COMPARE
            && compare->opcode != PL_OPCODE_X86_TEST)
            || compare->argument_count != 4u
            || compare->argument_at > plan->argument_count
            || compare->argument_count
               > plan->argument_count - compare->argument_at)
        return 0;
    pl_operand root = plan->arguments[compare->argument_at];
    *byte = 0u;
    if (root.kind == PL_OPERAND_LOCAL
            && root.value == PL_X86_RFLAGS_LOCAL)
        return 1;
    if (root.kind != PL_OPERAND_NODE || !root.value
            || root.value > plan->node_count)
        return 0;
    const pl_node *prefix = &plan->nodes[root.value - 1u];
    if (prefix->argument_count != 2u
            || prefix->argument_at > plan->argument_count
            || prefix->argument_count
               > plan->argument_count - prefix->argument_at)
        return 0;
    pl_u32 semantic = prefix->opcode == PL_OPCODE_ALU_IMMEDIATE[1][0]
                    ? 0u
                    : prefix->opcode == PL_OPCODE_ALU_IMMEDIATE[1][3]
                    ? 3u : U32_MAX_VALUE;
    if (semantic == U32_MAX_VALUE) return 0;
    const pl_operand *argument =
        plan->arguments + prefix->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != PL_OPERAND_CONST)
        return 0;
    if (semantic == 0u
            && argument[1].value == ~(1ull << 10u)) {
        *byte = 0xfcu;
        return 1;
    }
    if (semantic == 3u && argument[1].value == (1ull << 10u)) {
        *byte = 0xfdu;
        return 1;
    }
    return 0;
}

static int operand_contains_value(const pl_plan *plan, pl_operand root,
                                  pl_operand value, pl_u32 remaining)
{
    if (!plan || !remaining) return 0;
    if (root.kind == value.kind && root.value == value.value) return 1;
    pl_u32 node_number = root.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(root.value >> 8u)
                       : root.kind == PL_OPERAND_NODE
                       ? (pl_u32)root.value : 0u;
    if (!node_number || node_number > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    for (pl_u32 at = 0u; at < node->argument_count; ++at)
        if (operand_contains_value(
                plan, plan->arguments[node->argument_at + at], value,
                remaining - 1u))
            return 1;
    return 0;
}

static int subtract_tree_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *left, pl_operand *right,
                                 pl_u32 *bits)
{
    if (!plan || !left || !right || !bits
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[0][2]
            || node->opcode == PL_OPCODE_ALU_REGISTER[0][2]) {
        *bits = 32u;
    } else if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[1][2]
            || node->opcode == PL_OPCODE_ALU_REGISTER[1][2]) {
        *bits = 64u;
    } else {
        return 0;
    }
    *left = plan->arguments[node->argument_at];
    *right = plan->arguments[node->argument_at + 1u];
    return 1;
}

/* If `owner - rhs` is published both to owner and to another GPR, the other
 * output is the exact lifetime hole needed by x86's destructive form.  Build
 * rhs in that output, apply it once to owner, then copy the result back.  A
 * normalized subvalue of rhs which is itself published is scheduled first;
 * this is the physical cut which turns scaled SSA into one LEA without
 * retaining either a second rhs materialization or the source register
 * allocation. */
static int subtract_handoff_shape(const pl_plan *plan, pl_u32 changed,
                                  subtract_handoff *out)
{
    if (!plan || !out) return 0;
    for (pl_u32 owner = 0u; owner < PL_X86_GPR_COUNT; ++owner) {
        if (!(changed & (1u << owner))) continue;
        pl_operand result = plan->locals[owner];
        pl_operand left, right;
        pl_u32 bits = 0u;
        if (!subtract_tree_details(plan, result, &left, &right, &bits)
                || left.kind != PL_OPERAND_LOCAL
                || left.value != owner)
            continue;
        pl_u32 outputs = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand publication = plan->locals[local];
            if (publication.kind == result.kind
                    && publication.value == result.value)
                outputs |= 1u << local;
        }
        if (!(outputs & (1u << owner))
                || !(outputs & ~(1u << owner)))
            continue;
        pl_u32 plain = changed & ~outputs;
        /* Prefer a changed register whose entry value is the root of rhs and
         * whose final value is published only after the subtraction.  It is
         * a strictly better lifetime hole than an output register whenever
         * rhs can update it in place (for example `RAX &= mask`). */
        pl_u32 scratch = PL_X86_GPR_COUNT;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand entry = { PL_OPERAND_LOCAL, local };
            if (!(plain & (1u << local))
                    || !operand_contains_value(
                        plan, right, entry, plan->node_count + 1u))
                continue;
            pl_u32 final_sources = 0u;
            int found = pl_select_conditional_select_gpr_sources(
                plan, plan->locals[local], local, &final_sources);
            if ((!found && !pl_select_operand_gpr_sources(
                    plan, plan->locals[local], plan->node_count + 1u,
                    plan->node_count + 1u, &final_sources))
                    || (final_sources & (1u << local)))
                continue;
            scratch = local;
            break;
        }
        if (scratch == PL_X86_GPR_COUNT) {
            scratch = 0u;
            while (scratch < PL_X86_GPR_COUNT
                    && (!(outputs & (1u << scratch)) || scratch == owner))
                ++scratch;
        }
        if (scratch == PL_X86_GPR_COUNT) continue;
        int safe = 1;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(plain & (1u << local))) continue;
            pl_u32 sources = 0u;
            int found = pl_select_conditional_select_gpr_sources(
                plan, plan->locals[local], local, &sources);
            if ((!found && !pl_select_operand_gpr_sources(
                    plan, plan->locals[local], plan->node_count + 1u,
                    plan->node_count + 1u, &sources))
                    || (sources & outputs)
                    || (!(outputs & (1u << scratch))
                        && local != scratch
                        && (sources & (1u << scratch)))) {
                safe = 0;
                break;
            }
        }
        if (!safe) continue;
        pl_u32 producers = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(plain & (1u << local)) || local == scratch) continue;
            pl_operand publication = plan->locals[local];
            if ((publication.kind == PL_OPERAND_NODE
                    || publication.kind == PL_OPERAND_PROJECTION)
                    && operand_contains_value(
                        plan, right, publication,
                        plan->node_count + 1u))
                producers |= 1u << local;
        }
        out->owner = owner;
        out->outputs = outputs;
        out->scratch = scratch;
        out->producers = producers;
        out->bits = bits;
        out->right = right;
        return 1;
    }
    return 0;
}

int pl_select_next_compare_branch_assignment_excluding(const pl_plan *plan,
                                          pl_u32 pending,
                                          pl_u32 preferred,
                                          pl_u32 deferred,
                                          pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    pl_u32 frame_sources[PL_X86_GPR_COUNT];
    pl_u32 frame_dependencies[PL_X86_GPR_COUNT];
    if (!pl_select_alu_frame_source_laws(
            plan, frame_sources, frame_dependencies))
        return 0;
    for (pl_u32 pass = 0u; pass < 2u; ++pass)
      for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        if (deferred & (1u << local)) continue;
        int is_preferred = !!(preferred & (1u << local));
        if ((!pass && !is_preferred) || (pass && is_preferred)) continue;
        pl_u32 effective_dependencies = frame_dependencies[local];
        pl_operand local_value = plan->locals[local];
        pl_u32 physical_owner = pl_select_publication_owner(plan, local_value);
        if (local_value.kind == PL_OPERAND_CONST && !local_value.value
                && physical_owner < PL_X86_GPR_COUNT
                && physical_owner != local
                && pl_select_frame_local_publication_clobbers_flags(plan, local))
            effective_dependencies &= ~(1u << physical_owner);
        if (effective_dependencies & pending) continue;
        pl_u32 used = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            used |= frame_sources[other];
        }
        pl_u32 dependencies = 0u;
        int conditional = pl_select_conditional_select_publication_dependencies(
            plan, plan->locals[local], local, &dependencies);
        if (!(used & (1u << local))
                && (!conditional
                    || !(dependencies & pending & ~(1u << local)))) {
            *selected = local;
            return 1;
        }
      }
    return 0;
}

static int entry_flag_branch_shape(const pl_x86_block *block,
                                   pl_u32 *changed, pl_u32 *condition,
                                   pl_u32 *extension_dest,
                                   pl_u32 *extension_source,
                                   pl_u32 *extension_bits)
{
    if (!block || !changed || !condition || !extension_dest
            || !extension_source || !extension_bits
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_CONDITIONAL
            || !block->has_predicate || block->dynamic_target
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 2u
            || (block->plan.node_count != 1u
                && block->plan.node_count != 2u)
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->predicate.kind != PL_OPERAND_NODE
            || block->predicate.value != block->plan.node_count)
        return 0;
    const pl_node *predicate =
        &block->plan.nodes[block->plan.node_count - 1u];
    if (predicate->opcode != PL_OPCODE_X86_CONDITION
            || predicate->argument_count != 2u
            || predicate->argument_at > block->plan.argument_count
            || predicate->argument_count
               > block->plan.argument_count - predicate->argument_at)
        return 0;
    const pl_operand *argument =
        block->plan.arguments + predicate->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != PL_OPERAND_CONST
            || argument[1].value > 15u)
        return 0;
    pl_u32 mask = 0u;
    pl_u32 zero_source = 0u, zero_bits = 0u;
    pl_u32 zero_dest = PL_X86_GPR_COUNT;
    if (block->plan.node_count == 2u
            && (!pl_select_zero_extend_node(
                    &block->plan, 1u, &zero_source, &zero_bits)
                || zero_bits != 32u))
        return 0;
    for (pl_u32 local = 0u; local < block->plan.local_count; ++local) {
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (block->plan.node_count == 2u
                && value.kind == PL_OPERAND_NODE && value.value == 1u) {
            if (zero_dest != PL_X86_GPR_COUNT) return 0;
            zero_dest = local;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT))
            return 0;
        mask |= 1u << local;
    }
    if (!mask || (block->plan.node_count == 2u
                   && zero_dest == PL_X86_GPR_COUNT))
        return 0;
    *changed = mask;
    *condition = (pl_u32)argument[1].value;
    *extension_dest = zero_dest;
    *extension_source = zero_source;
    *extension_bits = zero_bits;
    return 1;
}

int pl_select_measure_direct_entry_flag_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    pl_u32 changed = 0u, condition = 0u;
    pl_u32 extension_dest = 0u, extension_source = 0u;
    pl_u32 extension_bits = 0u;
    if (!entry_flag_branch_shape(
            block, &changed, &condition, &extension_dest,
            &extension_source, &extension_bits))
        return 0;
    pl_u32 pending = changed;
    pl_u32 bytes = 0u, instructions = 0u;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!pl_select_next_compare_branch_assignment(
                &block->plan, pending, 0u, &local))
            return 0;
        int measured = local == extension_dest
            ? pl_select_emit_zero_extend_move(
                local, extension_source, extension_bits, 0, &encoded)
            : pl_select_measure_frame_value(
                frontend, block, selection, local,
                block->plan.locals[local], bytes, &encoded);
        if (measured <= 0 || bytes > U32_MAX_VALUE - encoded
                || instructions == U32_MAX_VALUE)
            return measured < 0 ? measured : 0;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (bytes > U32_MAX_VALUE - branch_bytes
            || instructions == U32_MAX_VALUE)
        return PL_ERROR_X86_SELECT;
    int status = pl_select_append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        bytes + (block->relax_short_control ? 2u : 1u),
        bytes + branch_bytes, block->successor[0]);
    if (status) return status;
    selection->output_bytes = bytes + branch_bytes;
    selection->output_instructions = instructions + 1u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_entry_branch_frame = 1u;
    selection->frame_anchor = (pl_u8)condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* The masked value is dead because the next publication overwrites its
 * register. A narrower TEST is equivalent to a 32-bit AND for all defined
 * flags only when the mask excludes the narrower sign bit: ZF and PF see the
 * same result, SF is zero at both widths, and CF/OF are cleared. */
static int mask_flag_branch_shape(const pl_x86_block *block,
                                  mask_flag_branch *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_CONDITIONAL
            || !block->has_predicate || block->dynamic_target
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 2u
            || block->construction_fields || block->plan.node_count != 1u
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->predicate.kind != PL_OPERAND_PROJECTION
            || (block->predicate.value >> 8u) != 1u
            || (block->predicate.value & 0xffu) > 15u)
        return 0;
    pl_operand source, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!pl_select_alu_node_semantics(
            &block->plan, 1u, &source, &right,
            &bits, &mode, &preserves_carry)
            || bits != 32u || mode != 0u || preserves_carry
            || source.kind != PL_OPERAND_LOCAL
            || source.value >= PL_X86_GPR_COUNT
            || right.kind != PL_OPERAND_CONST
            || right.value > 0x7fffu)
        return 0;
    pl_u32 tested = (pl_u32)source.value;
    pl_u32 copy_source = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < block->plan.local_count; ++local) {
        pl_operand value = block->plan.locals[local];
        if (local == tested && value.kind == PL_OPERAND_LOCAL
                && value.value < PL_X86_GPR_COUNT
                && value.value != tested) {
            copy_source = (pl_u32)value.value;
        } else if (local == PL_X86_RFLAGS_LOCAL
                && value.kind == PL_OPERAND_NODE && value.value == 1u) {
            /* The complete defined flags, not only the Jcc bit, survive. */
        } else if (value.kind != PL_OPERAND_LOCAL
                || value.value != local) {
            return 0;
        }
    }
    if (copy_source == PL_X86_GPR_COUNT) return 0;
    *out = (mask_flag_branch){
        tested, copy_source,
        right.value <= 0x7fu ? 8u : 16u,
        (pl_u32)(block->predicate.value & 0xffu), right.value,
    };
    return 1;
}

int pl_select_measure_direct_mask_flag_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    mask_flag_branch shape;
    if (!mask_flag_branch_shape(block, &shape)) return 0;
    pl_u32 test_bytes = 0u, move_bytes = 0u;
    pl_operand mask = { PL_OPERAND_CONST, shape.mask };
    if (!pl_select_emit_test_operand(
            shape.tested, mask, shape.test_bits, 0, &test_bytes)
            || !pl_select_emit_gpr_move(
                shape.tested, shape.copy_source, 64u, 0, &move_bytes)
            || test_bytes > U32_MAX_VALUE - move_bytes)
        return 0;
    pl_u32 prefix = test_bytes + move_bytes;
    pl_u32 branch_bytes = block->relax_short_control ? 6u : 2u;
    if (prefix > U32_MAX_VALUE - branch_bytes)
        return PL_ERROR_X86_SELECT;
    int status = pl_select_append_control_fixup(
        frontend, block, selection,
        (pl_u8)(block->relax_short_control ? 4u : 1u),
        prefix + (block->relax_short_control ? 2u : 1u),
        prefix + branch_bytes, block->successor[0]);
    if (status) return status;
    selection->output_bytes = prefix + branch_bytes;
    selection->output_instructions = 3u;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_mask_flag_branch_frame = 1u;
    selection->frame_anchor = (pl_u8)shape.condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* `flag_result_group` is declared with the other frame-shape prototypes
 * above; the compare/test Boolean observation group lives here. */

/* One arithmetic instruction publishes both its word and its conditions.
 * Keep those observations adjacent while allocating their actual GPRs.
 * Other pending readers of an overwritten entry must run before the group;
 * pending consumers of its new outputs keep their producer dependencies. */
int pl_select_flag_result_group_shape(const pl_plan *plan, pl_u32 pending,
                                   flag_result_group *out, pl_u32 *deferred)
{
    *deferred = 0u;
    pl_u32 sources[PL_X86_GPR_COUNT], dependencies[PL_X86_GPR_COUNT];
    if (!pl_select_alu_frame_source_laws(plan, sources, dependencies)) return 0;
    for (pl_u32 node = 1u; node <= plan->node_count; ++node) {
        pl_operand result = { PL_OPERAND_PROJECTION, ((pl_u64)node << 8u) | 16u };
        pl_u32 owner = pl_select_publication_owner(plan, result), booleans = 0u;
        if (owner >= PL_X86_GPR_COUNT || !(pending & (1u << owner))) continue;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand value = plan->locals[local];
            if ((pending & (1u << local)) && value.kind == PL_OPERAND_PROJECTION
                    && (value.value >> 8u) == node && (value.value & 0xffu) < 16u)
                booleans |= 1u << local;
        }
        if (!booleans) continue;
        flag_result_group shape = { .owner = owner, .booleans = booleans,
                                    .node = node };
        pl_u32 preserves = 0u;
        if (!pl_select_alu_node_semantics(plan, node, &shape.left, &shape.right,
                &shape.bits, &shape.mode, &preserves) || preserves
                || shape.mode == 2u || shape.mode == 4u) continue;
        shape.members = booleans | (1u << owner);
        *deferred |= shape.members;
        if (dependencies[owner] & pending & ~shape.members) continue;
        pl_u32 blocked = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
            if ((pending & (1u << local)) && !(shape.members & (1u << local))
                    && (sources[local] & shape.members)) blocked = 1u;
        if (blocked) continue;
        shape.zero_before = booleans & ~(sources[owner] | dependencies[owner]);
        *out = shape;
        return 1;
    }
    return 0;
}

/* A CMP/TEST publishes no GPR value, but its condition projections are Boolean
 * observations the frame still has to materialize.  The comparison is emitted
 * once as the flag producer, then SETcc per observation.  Only the case where
 * this comparison is the block's final flag producer is handled here, so the
 * group's comparison and the final flag publication are the same instruction. */
int pl_select_compare_boolean_group_shape(const pl_plan *plan, pl_u32 pending,
                                       pl_u32 final_flag_node,
                                       flag_result_group *out)
{
    if (!plan || !out || !pending || !final_flag_node
            || final_flag_node > plan->node_count)
        return 0;
    const pl_node *flag = &plan->nodes[final_flag_node - 1u];
    if (flag->opcode != PL_OPCODE_X86_COMPARE
            && flag->opcode != PL_OPCODE_X86_TEST)
        return 0;
    pl_u32 booleans = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if ((pending & (1u << local)) && value.kind == PL_OPERAND_PROJECTION
                && (value.value >> 8u) == final_flag_node
                && (value.value & 0xffu) < 16u)
            booleans |= 1u << local;
    }
    if (!booleans) return 0;
    pl_u32 sources[PL_X86_GPR_COUNT], dependencies[PL_X86_GPR_COUNT];
    if (!pl_select_alu_frame_source_laws(plan, sources, dependencies)) return 0;
    pl_operand flags = { PL_OPERAND_NODE, final_flag_node };
    pl_u32 preserves_carry = 0u;
    if (!pl_select_flag_operation_details(plan, flags, &out->left, &out->right,
            &out->bits, &out->mode, &preserves_carry)
            || preserves_carry)
        return 0;
    out->owner = PL_X86_GPR_COUNT;
    out->booleans = booleans;
    out->members = booleans;
    out->node = final_flag_node;
    out->test = flag->opcode == PL_OPCODE_X86_TEST ? 1u : 0u;
    pl_u32 reads = 0u, frontier = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(booleans & (1u << local))) continue;
        reads |= sources[local] | dependencies[local];
        frontier |= dependencies[local];
    }
    if (frontier & pending & ~booleans) return 0;
    out->zero_before = booleans & ~reads;
    return 1;
}

int pl_select_compare_tree_flag_shape(const pl_plan *plan, pl_u32 changed,
                                   pl_u32 final_flag_node,
                                   compare_tree_flag *out)
{
    if (!plan || !out || !final_flag_node
            || final_flag_node > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[final_flag_node - 1u];
    if (node->opcode != PL_OPCODE_X86_COMPARE
            && node->opcode != PL_OPCODE_X86_TEST)
        return 0;
    pl_operand flags = { PL_OPERAND_NODE, final_flag_node };
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!pl_select_flag_operation_details(plan, flags, &left, &right,
            &bits, &mode, &preserves_carry) || preserves_carry
            /* An 8-bit compare can observe a high-byte register, which
             * test_byte_coordinate rewrites; that path stays with the
             * standalone shape. */
            || bits == 8u)
        return 0;
    pl_operand physical_left = left, physical_right = right;
    pl_select_physicalize_published_operand(plan, PL_X86_GPR_COUNT, &physical_left);
    pl_select_physicalize_published_operand(plan, PL_X86_GPR_COUNT, &physical_right);
    if (physical_left.kind == PL_OPERAND_LOCAL
            && physical_left.value < PL_X86_GPR_COUNT)
        return 0;  /* pl_select_standalone_flag_publication_details owns this shape */
    if (physical_left.kind != PL_OPERAND_NODE
            && physical_left.kind != PL_OPERAND_PROJECTION)
        return 0;
    if (physical_right.kind != PL_OPERAND_CONST
            && !(physical_right.kind == PL_OPERAND_LOCAL
                && physical_right.value < PL_X86_GPR_COUNT))
        return 0;
    pl_u32 sources = 0u, deps = 0u;
    if (!pl_select_operand_gpr_sources(plan, physical_left, final_flag_node,
            plan->node_count + 1u, &sources)
            || !pl_select_operand_published_dependencies(plan, physical_left,
                final_flag_node, plan->node_count + 1u, &deps))
        return 0;
    pl_u32 clobberers = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((changed & (1u << local))
                && pl_select_frame_local_emission_clobbers_flags(plan, local))
            clobberers |= 1u << local;
    /* Either the tree can run before any pending publication (nothing to wait
     * for and no flag clobber pending), or no pending register is one of its
     * entry sources, so waiting for the other producers cannot destroy it. */
    int immediate = !clobberers && !(deps & changed);
    if (!immediate && (sources & changed)) return 0;
    out->tree = physical_left;
    out->tree_bits = bits;
    out->right = physical_right;
    out->bits = bits;
    out->test = node->opcode == PL_OPCODE_X86_TEST ? 1u : 0u;
    out->entry_sources = sources;
    out->owner_dependencies = deps;
    return 1;
}

int pl_select_carry_alu_group_shape(const pl_plan *plan, pl_u32 pending,
                                 pl_u32 final_flag_node, carry_alu_group *out)
{
    if (!plan || !out || !pending || !final_flag_node) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_operand value = plan->locals[local];
        if (value.kind != PL_OPERAND_PROJECTION
                || (value.value & 0xffu) != 16u)
            continue;
        pl_u32 node = (pl_u32)(value.value >> 8u);
        if (node != final_flag_node) continue;
        pl_u32 prior = 0u;
        if (!pl_select_alu_carry_prior_node(plan, node, &prior)) continue;
        const pl_node *alu = &plan->nodes[node - 1u];
        const pl_operand *argument = plan->arguments + alu->argument_at;
        /* No other pending publication may still observe the comparison's
         * flags; otherwise the comparison is not the unique producer. */
        pl_u32 shared = 0u;
        for (pl_u32 index = 0u; index < PL_X86_GPR_COUNT; ++index) {
            if (index == local || !(pending & (1u << index))) continue;
            pl_operand publication = plan->locals[index];
            if (publication.kind == PL_OPERAND_PROJECTION
                    && (publication.value >> 8u) == prior
                    && (publication.value & 0xffu) < 16u) {
                shared = 1u;
                break;
            }
        }
        if (shared) continue;
        pl_operand flags = { PL_OPERAND_NODE, prior };
        pl_operand cleft, cright;
        pl_u32 cbits = 0u, cmode = 0u, ccarry = 0u;
        if (!pl_select_flag_operation_details(plan, flags, &cleft, &cright,
                &cbits, &cmode, &ccarry) || ccarry)
            continue;
        pl_select_physicalize_published_operand(plan, PL_X86_GPR_COUNT, &cleft);
        pl_select_physicalize_published_operand(plan, PL_X86_GPR_COUNT, &cright);
        if (cleft.kind != PL_OPERAND_LOCAL
                || cleft.value >= PL_X86_GPR_COUNT)
            continue;
        if (cright.kind != PL_OPERAND_CONST
                && !(cright.kind == PL_OPERAND_LOCAL
                    && cright.value < PL_X86_GPR_COUNT))
            continue;
        pl_u32 reads = 1u << (pl_u32)cleft.value;
        if (cright.kind == PL_OPERAND_LOCAL)
            reads |= 1u << (pl_u32)cright.value;
        if (argument[1].kind == PL_OPERAND_LOCAL)
            reads |= 1u << (pl_u32)argument[1].value;
        if (argument[2].kind == PL_OPERAND_LOCAL)
            reads |= 1u << (pl_u32)argument[2].value;
        if (reads & pending & ~(1u << local)) continue;
        pl_u64 descriptor = argument[3].value;
        out->destination = local;
        out->left = argument[1];
        out->right = argument[2];
        out->bits = (pl_u32)(descriptor & 0x7fu);
        out->mode = (pl_u32)((descriptor >> 8u) & 7u);
        out->compare_left = cleft;
        out->compare_right = cright;
        out->compare_bits = cbits;
        out->compare_test =
            plan->nodes[prior - 1u].opcode == PL_OPCODE_X86_TEST ? 1u : 0u;
        return 1;
    }
    return 0;
}

int pl_select_emit_group_booleans(const pl_plan *plan, const flag_result_group *shape,
                               int before, pl_u8 *output, pl_u32 *written, pl_u32 *work)
{
    pl_u32 at = 0u, count = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_u32 bit = 1u << local, part = 0u;
        if (!(shape->booleans & bit)) continue;
        if (before ? !!(shape->zero_before & bit) : !(shape->zero_before & bit)) {
            if (!pl_select_emit_boolean_zero(local, !before, output ? output + at : 0, &part)) return 0;
            at += part;
            ++count;
        }
        if (!before) {
            if (!pl_select_emit_set_condition(local, (pl_u32)(plan->locals[local].value & 0xffu),
                    output ? output + at : 0, &part)) return 0;
            at += part;
            ++count;
        }
    }
    *written = at; *work = count;
    return 1;
}

/* Two publications observe one word: zext32(q) and sext32(q). When q uses
 * the wide destination's entry value, it can own q destructively, publish
 * the narrow alias, then sign-extend in place. This removes both a rebuild
 * of q and the entry copy's extra wave; q's expression grammar is unchanged. */
static int signed_word_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                     signed_word_handoff *out)
{
    pl_u32 entries[PL_X86_GPR_COUNT], dependencies[PL_X86_GPR_COUNT];
    if (!pl_select_alu_frame_source_laws(plan, entries, dependencies)) return 0;
    for (pl_u32 wide = 0u; wide < PL_X86_GPR_COUNT; ++wide) {
        if (!(pending & (1u << wide))) continue;
        pl_operand value = plan->locals[wide], word;
        pl_u32 bits = 0u;
        if (value.kind != PL_OPERAND_NODE
                || !pl_select_sign_extend_value(plan, (pl_u32)value.value, &word, &bits)
                || bits != 32u || word.kind != PL_OPERAND_NODE
                || pl_select_operand_expression_bits(plan, word, 0u) != 32u) continue;
        pl_u32 narrow = pl_select_publication_owner(plan, word);
        if (narrow >= PL_X86_GPR_COUNT || narrow == wide
                || !(pending & (1u << narrow))) continue;
        pl_u32 sources = 0u;
        if (!pl_select_operand_entry_gpr_sources(plan, word, plan->node_count + 1u,
                plan->node_count + 1u, &sources)
                || !(sources & (1u << wide)) || (sources & (1u << narrow))) continue;
        pl_u32 pair = (1u << wide) | (1u << narrow), blocked = 0u;
        if (dependencies[narrow] & pending & ~pair) continue;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local)) || (pair & (1u << local))) continue;
            if (!pl_select_operand_entry_gpr_sources(plan, plan->locals[local], plan->node_count + 1u,
                    plan->node_count + 1u, &sources) || (sources & pair)) {
                blocked = 1u;
                break;
            }
        }
        if (blocked) continue;
        *out = (signed_word_handoff){ narrow, wide, word };
        return 1;
    }
    return 0;
}

static int emit_signed_word_publications(const signed_word_handoff *shape,
                                         pl_u8 *output, pl_u32 *written)
{
    pl_u32 copy = 0u, extension = 0u;
    if (!pl_select_emit_gpr_move(shape->narrow, shape->wide, 32u, output, &copy)
            || !pl_select_emit_sign_extend_move(shape->wide, shape->wide, 32u,
                output ? output + copy : 0, &extension)) return 0;
    *written = copy + extension;
    return 1;
}

int pl_select_measure_direct_compare_branch(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT)
        return 0;
    compare_branch_operands shape;
    pl_u32 changed, left, bits, condition, test;
    pl_u8 flag_prefix = 0u;
    if (!compare_branch_operand_shape(block, &shape)
            || !pl_select_compare_flag_prefix(&block->plan, &flag_prefix))
        return 0;
    selection->direct_branch_frame = 1u;
    selection->blocking_work = 0xf100u;
    changed = shape.changed;
    left = shape.left;
    bits = shape.bits;
    condition = shape.condition;
    test = shape.test;
    const pl_u32 compare_reads = (1u << left)
        | (shape.right.kind == PL_OPERAND_LOCAL ? 1u << shape.right.value : 0u);
    subtract_handoff handoff = { 0 };
    int has_handoff = subtract_handoff_shape(
        &block->plan, changed, &handoff);
    pl_u32 stage_pending[2] = { changed, 0u };
    pl_u32 stage_count = 1u;
    if (has_handoff) {
        stage_pending[0] = handoff.producers;
        stage_pending[1] = changed
                         & ~handoff.outputs & ~handoff.producers;
        stage_count = 2u;
    }
    pl_u32 bytes = 0u, instructions = 0u, span = 0u;
    for (pl_u32 stage = 0u; stage < stage_count; ++stage) {
      pl_u32 pending = stage_pending[stage];
      while (pending) {
        select_generation_group select_group;
        if (!has_handoff && pl_select_select_generation_group_shape(&block->plan, pending, 0u, &select_group)) {
            pl_u32 part = 0u, work = 0u;
            int measured = pl_select_measure_select_generation_group(frontend, block, selection,
                &select_group, bytes, &part, &work);
            if (measured <= 0 || bytes > U32_MAX_VALUE - part
                    || instructions > U32_MAX_VALUE - work) return measured < 0 ? measured : 0;
            bytes += part; instructions += work;
            pending &= ~select_group.members;
            continue;
        }
        flag_result_group group;
        pl_u32 deferred = 0u;
        if (!has_handoff && pl_select_flag_result_group_shape(&block->plan, pending, &group, &deferred)) {
            pl_u32 pre = 0u, pre_work = 0u, operation = 0u, work = 0u, post = 0u, post_work = 0u;
            if (!pl_select_emit_group_booleans(&block->plan, &group, 1, 0, &pre, &pre_work)
                    || bytes > U32_MAX_VALUE - pre) return 0;
            int measured = pl_select_measure_alu_pair(frontend, block, selection, group.owner,
                group.left, group.right, group.bits, group.mode, 0u, bytes + pre,
                block->plan.node_count + 1u, 0u, &operation, &work);
            if (measured <= 0 || !pl_select_emit_group_booleans(&block->plan, &group, 0, 0, &post, &post_work)
                    || operation > U32_MAX_VALUE - pre || post > U32_MAX_VALUE - pre - operation
                    || bytes > U32_MAX_VALUE - pre - operation - post
                    || work > U32_MAX_VALUE - pre_work - post_work
                    || instructions > U32_MAX_VALUE - pre_work - work - post_work)
                return measured < 0 ? measured : 0;
            bytes += pre + operation + post;
            instructions += pre_work + work + post_work;
            pending &= ~group.members;
            continue;
        }
        signed_word_handoff word;
        if (!has_handoff && signed_word_handoff_shape(&block->plan, pending, &word)) {
            pl_u32 prefix = 0u, work = 0u, publication = 0u;
            int measured = pl_select_measure_alu_tree(frontend, block, selection,
                word.wide, word.word, 32u, bytes, block->plan.node_count + 1u,
                0u, &prefix, &work);
            if (measured <= 0 || !emit_signed_word_publications(&word, 0, &publication)
                    || prefix > U32_MAX_VALUE - publication
                    || bytes > U32_MAX_VALUE - prefix - publication
                    || work > U32_MAX_VALUE - 2u
                    || instructions > U32_MAX_VALUE - work - 2u)
                return measured < 0 ? measured : 0;
            bytes += prefix + publication;
            instructions += work + 2u;
            pending &= ~((1u << word.narrow) | (1u << word.wide));
            continue;
        }
        shared_root_shift_handoff root_shift;
        if (!has_handoff
                && pl_select_shared_root_shift_handoff_shape(
                    &block->plan, pending, &root_shift)) {
            pl_u32 seed_bytes = 0u, seed_work = 0u, move_bytes = 0u;
            pl_u32 shift0 = 0u, shift1 = 0u;
            int measured = pl_select_measure_alu_tree(
                frontend, block, selection, root_shift.seed_dest,
                root_shift.seed, root_shift.seed_bits, bytes,
                block->plan.node_count + 1u, 0u, &seed_bytes, &seed_work);
            if (measured <= 0
                    || !pl_select_emit_gpr_move(root_shift.copy_dest,
                        root_shift.seed_dest, root_shift.bits, 0, &move_bytes)
                    || !pl_select_emit_shift_instruction(
                        root_shift.seed_dest, root_shift.amount[0],
                        root_shift.bits, root_shift.group[0], 0, &shift0)
                    || !pl_select_emit_shift_instruction(
                        root_shift.copy_dest, root_shift.amount[1],
                        root_shift.bits, root_shift.group[1], 0, &shift1)
                    || seed_bytes > U32_MAX_VALUE - move_bytes
                    || seed_bytes + move_bytes > U32_MAX_VALUE - shift0
                    || seed_bytes + move_bytes + shift0
                       > U32_MAX_VALUE - shift1
                    || seed_work > U32_MAX_VALUE - 3u)
                return measured < 0 ? measured : 0;
            bytes += seed_bytes + move_bytes + shift0 + shift1;
            instructions += seed_work + 3u;
            pending &= ~((1u << root_shift.seed_dest)
                       | (1u << root_shift.copy_dest));
            continue;
        }
        pl_u32 local = 0u, encoded = 0u, work = 1u;
        if (!pl_select_next_compare_branch_assignment_excluding(
                &block->plan, pending,
                compare_reads, deferred, &local)) {
            selection->blocking_work = 0x700u;
            selection->blocking_opcode = pending;
            return 0;
        }
        pl_operand value = block->plan.locals[local];
        int measured;
        pl_u32 owner = pl_select_publication_owner(&block->plan, value);
        if (value.kind == PL_OPERAND_NODE && owner < PL_X86_GPR_COUNT && owner != local) {
            /* The scheduler has already published the exact shared root.
             * Its other outputs read that owner rather than rebuilding it. */
            pl_u32 value_bits = pl_select_operand_fits_u32(
                &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
            measured = pl_select_emit_gpr_move(local, owner, value_bits, 0, &encoded);
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!pl_select_alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local)
                return 0;
            pl_u32 prefix_work = 0u, operation = 0u;
            measured = pl_select_measure_alu_seed(
                frontend, block, selection, local, source, node_bits, bytes,
                block->plan.node_count + 1u, &encoded, &prefix_work);
            if (measured <= 0
                    || !pl_select_emit_alu_instruction(
                        local, right_operand, node_bits, mode,
                        preserves_carry, 0, &operation)
                    || encoded > U32_MAX_VALUE - operation)
                return measured < 0 ? measured : 0;
            encoded += operation;
            work = prefix_work + 1u;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, extend_bits = 0u;
            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            conditional_select select;
            if (pl_select_conditional_select_details(
                    &block->plan, value, local, &select)) {
                if (select.candidate_local == local) return 0;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                measured = select.current_flag_node
                    ? pl_select_measure_selected_flag_value(frontend, block, selection, local, &select,
                        bytes, block->plan.node_count + 1u, 0u, &seed_bytes, &seed_work)
                    : pl_select_measure_alu_seed(
                    frontend, block, selection, local, current,
                    select.value_bits, bytes,
                    block->plan.node_count + 1u,
                    &seed_bytes, &seed_work);
                pl_u32 compare_bytes = 0u, move_bytes = 0u;
                int compared = !select.has_compare
                    || pl_select_emit_select_compare(&select, 0, &compare_bytes);
                if (measured <= 0 || !compared
                        || !pl_select_emit_conditional_move(
                            local, select.candidate_local,
                            select.value_bits, select.condition,
                            0, &move_bytes)
                        || seed_bytes > U32_MAX_VALUE - compare_bytes
                        || seed_bytes + compare_bytes
                           > U32_MAX_VALUE - move_bytes)
                    return measured < 0 ? measured : 0;
                encoded = seed_bytes + compare_bytes + move_bytes;
                work = seed_work + 1u + select.has_compare;
            } else if (pl_select_collect_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form)) {
                measured = pl_select_emit_affine_lea(local, form, 0, &encoded);
                work = 1u;
            } else if (pl_select_zero_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                measured = pl_select_emit_zero_extend_move(
                    local, source, extend_bits, 0, &encoded);
                work = 1u;
            } else if (pl_select_sign_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                measured = pl_select_emit_sign_extend_move(
                    local, source, extend_bits, 0, &encoded);
                work = 1u;
            } else if (pl_select_shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &shift_bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                pl_u32 seed_bytes = 0u, seed_work = 0u;
                measured = pl_select_measure_alu_seed(
                    frontend, block, selection, local, shift_source,
                    shift_bits, bytes, block->plan.node_count + 1u,
                    &seed_bytes, &seed_work);
                pl_u32 shift_bytes = 0u;
                if (measured <= 0
                        || !pl_select_emit_shift_instruction(
                            local, shift_amount, shift_bits, shift_group,
                            0, &shift_bytes)
                        || seed_bytes > U32_MAX_VALUE - shift_bytes)
                    return measured < 0 ? measured : 0;
                encoded = seed_bytes + shift_bytes;
                work = seed_work + 1u;
            } else {
                pl_u32 node_bits = pl_select_operand_fits_u32(
                    &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
                measured = pl_select_measure_alu_tree(
                    frontend, block, selection, local, value, node_bits,
                    bytes, block->plan.node_count + 1u, 0u, &encoded, &work);
            }
        } else {
            measured = value.kind == PL_OPERAND_CONST && !value.value
                    && pl_select_zero_internal_compare_consumers(
                        &block->plan, local, pending)
                ? pl_select_emit_zero_register(local, 0, &encoded)
                : pl_select_measure_frame_value(
                    frontend, block, selection, local, value,
                    bytes, &encoded);
        }
        if (measured <= 0 || bytes > U32_MAX_VALUE - encoded
                || instructions > U32_MAX_VALUE - work) {
            selection->blocking_work = 0x800u | local;
            return measured < 0 ? measured : 0;
        }
        bytes += encoded;
        instructions += work;
        if (work > span) span = work;
        pending &= ~(1u << local);
      }
      if (has_handoff && !stage) {
        pl_u32 encoded = 0u, work = 0u;
        int measured = pl_select_measure_alu_seed(
            frontend, block, selection, handoff.scratch, handoff.right,
            handoff.bits, bytes, block->plan.node_count + 1u,
            &encoded, &work);
        pl_operand scratch = { PL_OPERAND_LOCAL, handoff.scratch };
        pl_u32 operation = 0u;
        if (measured <= 0
                || !pl_select_emit_alu_instruction(
                    handoff.owner, scratch, handoff.bits, 3u, 0u,
                    0, &operation)
                || encoded > U32_MAX_VALUE - operation
                || bytes > U32_MAX_VALUE - encoded - operation
                || instructions > U32_MAX_VALUE - work - 1u)
            return measured < 0 ? measured : 0;
        bytes += encoded + operation;
        instructions += work + 1u;
        if (work + 1u > span) span = work + 1u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (local == handoff.owner
                    || !(handoff.outputs & (1u << local)))
                continue;
            if (!pl_select_emit_gpr_move(
                    local, handoff.owner, handoff.bits, 0, &encoded)
                    || bytes > U32_MAX_VALUE - encoded
                    || instructions == U32_MAX_VALUE)
                return 0;
            bytes += encoded;
            ++instructions;
        }
      }
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (flag_prefix) {
        if (bytes == U32_MAX_VALUE || instructions == U32_MAX_VALUE)
            return PL_ERROR_X86_SELECT;
        ++bytes;
        ++instructions;
        if (!span) span = 1u;
    }
    pl_u32 encoded = 0u;
    int flags_emitted = test
        ? pl_select_emit_test_operand(left, shape.right, bits, 0, &encoded)
        : pl_select_emit_compare_operand(left, shape.right, bits, 0, &encoded);
    if (!flags_emitted
            || bytes > U32_MAX_VALUE - encoded)
        return 0;
    bytes += encoded;
    ++instructions;
    ++span;
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
    ++span;
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_branch_frame = 1u;
    selection->frame_anchor = (pl_u8)condition;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_shared_sub_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    shared_sub_frame shape;
    if (!selection || !selection->direct_shared_sub_frame || !output
            || !shared_sub_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, written = 0u;
    pl_operand right = { PL_OPERAND_LOCAL, shape.right_owner };
    if (!pl_select_emit_gpr_move(shape.duplicate, shape.owner, 64u,
                        output, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!pl_select_write_alu_tree(block, selection, shape.right_owner, shape.right,
                         64u, at, block->plan.node_count + 1u, 0u,
                         output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!pl_select_emit_alu_instruction(shape.duplicate, right, 64u, 3u, 0u,
                              output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (!pl_select_emit_alu_instruction(shape.owner, right, 64u, 3u, 0u,
                              output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_entry_flag_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_entry_branch_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, condition = 0u;
    pl_u32 extension_dest = 0u, extension_source = 0u;
    pl_u32 extension_bits = 0u;
    if (!entry_flag_branch_shape(
            block, &changed, &condition, &extension_dest,
            &extension_source, &extension_bits)
            || condition != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;
    pl_u32 pending = changed;
    pl_u32 at = 0u;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!pl_select_next_compare_branch_assignment(
                &block->plan, pending, 0u, &local))
            return PL_ERROR_X86_SELECT;
        int emitted = local == extension_dest
            ? pl_select_emit_zero_extend_move(
                local, extension_source, extension_bits,
                output + at, &written)
            : pl_select_write_frame_value(
                selection, at, local, block->plan.locals[local],
                output + at, &written);
        if (!emitted
                || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    if (block->relax_short_control) {
        if (selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_mask_flag_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_mask_flag_branch_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    mask_flag_branch shape;
    if (!mask_flag_branch_shape(block, &shape)
            || shape.condition != selection->frame_anchor)
        return PL_ERROR_X86_SELECT;
    pl_operand mask = { PL_OPERAND_CONST, shape.mask };
    pl_u32 at = 0u, written = 0u;
    if (!pl_select_emit_test_operand(
            shape.tested, mask, shape.test_bits, output, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_emit_gpr_move(
                shape.tested, shape.copy_source, 64u,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes) return PL_ERROR_X86_SELECT;
    if (block->relax_short_control) {
        if (selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + shape.condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + shape.condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_compare_branch(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_branch_frame || !output)
        return PL_ERROR_X86_SELECT;
    compare_branch_operands shape;
    pl_u32 changed, left, bits, condition, test;
    pl_u8 flag_prefix = 0u;
    if (!compare_branch_operand_shape(block, &shape)
            || shape.condition != selection->frame_anchor
            || !pl_select_compare_flag_prefix(&block->plan, &flag_prefix))
        return PL_ERROR_X86_SELECT;
    changed = shape.changed;
    left = shape.left;
    bits = shape.bits;
    condition = shape.condition;
    test = shape.test;
    const pl_u32 compare_reads = (1u << left)
        | (shape.right.kind == PL_OPERAND_LOCAL ? 1u << shape.right.value : 0u);
    subtract_handoff handoff = { 0 };
    int has_handoff = subtract_handoff_shape(
        &block->plan, changed, &handoff);
    pl_u32 stage_pending[2] = { changed, 0u };
    pl_u32 stage_count = 1u;
    if (has_handoff) {
        stage_pending[0] = handoff.producers;
        stage_pending[1] = changed
                         & ~handoff.outputs & ~handoff.producers;
        stage_count = 2u;
    }
    pl_u32 at = 0u;
    for (pl_u32 stage = 0u; stage < stage_count; ++stage) {
      pl_u32 pending = stage_pending[stage];
      while (pending) {
        select_generation_group select_group;
        if (!has_handoff && pl_select_select_generation_group_shape(&block->plan, pending, 0u, &select_group)) {
            pl_u32 part = 0u;
            if (!pl_select_write_select_generation_group(block, selection, &select_group,
                    at, output + at, &part) || at > selection->output_bytes
                    || part > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += part;
            pending &= ~select_group.members;
            continue;
        }
        flag_result_group group;
        pl_u32 deferred = 0u;
        if (!has_handoff && pl_select_flag_result_group_shape(&block->plan, pending, &group, &deferred)) {
            pl_u32 pre = 0u, operation = 0u, post = 0u, work = 0u;
            if (!pl_select_emit_group_booleans(&block->plan, &group, 1, output + at, &pre, &work)
                    || at > selection->output_bytes || pre > selection->output_bytes - at)
                return PL_ERROR_X86_SELECT;
            at += pre;
            if (!pl_select_write_alu_pair(block, selection, group.owner, group.left, group.right,
                    group.bits, group.mode, 0u, at, block->plan.node_count + 1u,
                    0u, output + at, &operation)
                    || operation > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += operation;
            if (!pl_select_emit_group_booleans(&block->plan, &group, 0, output + at, &post, &work)
                    || post > selection->output_bytes - at) return PL_ERROR_X86_SELECT;
            at += post;
            pending &= ~group.members;
            continue;
        }
        signed_word_handoff word;
        if (!has_handoff && signed_word_handoff_shape(&block->plan, pending, &word)) {
            pl_u32 prefix = 0u, publication = 0u;
            if (!pl_select_write_alu_tree(block, selection, word.wide, word.word, 32u,
                    at, block->plan.node_count + 1u, 0u, output + at, &prefix)
                    || at > selection->output_bytes || prefix > selection->output_bytes - at
                    || !emit_signed_word_publications(&word, output + at + prefix, &publication)
                    || publication > selection->output_bytes - at - prefix)
                return PL_ERROR_X86_SELECT;
            at += prefix + publication;
            pending &= ~((1u << word.narrow) | (1u << word.wide));
            continue;
        }
        shared_root_shift_handoff root_shift;
        if (!has_handoff
                && pl_select_shared_root_shift_handoff_shape(
                    &block->plan, pending, &root_shift)) {
            pl_u32 seed_bytes = 0u, move_bytes = 0u, shift0 = 0u, shift1 = 0u;
            if (!pl_select_write_alu_tree(block, selection, root_shift.seed_dest,
                    root_shift.seed, root_shift.seed_bits, at,
                    block->plan.node_count + 1u, 0u,
                    output + at, &seed_bytes)
                    || at > selection->output_bytes
                    || seed_bytes > selection->output_bytes - at
                    || !pl_select_emit_gpr_move(root_shift.copy_dest,
                        root_shift.seed_dest, root_shift.bits,
                        output + at + seed_bytes, &move_bytes)
                    || move_bytes > selection->output_bytes - at - seed_bytes
                    || !pl_select_emit_shift_instruction(
                        root_shift.seed_dest, root_shift.amount[0],
                        root_shift.bits, root_shift.group[0],
                        output + at + seed_bytes + move_bytes, &shift0)
                    || shift0 > selection->output_bytes - at - seed_bytes
                                - move_bytes
                    || !pl_select_emit_shift_instruction(
                        root_shift.copy_dest, root_shift.amount[1],
                        root_shift.bits, root_shift.group[1],
                        output + at + seed_bytes + move_bytes + shift0,
                        &shift1)
                    || shift1 > selection->output_bytes - at - seed_bytes
                                - move_bytes - shift0)
                return PL_ERROR_X86_SELECT;
            at += seed_bytes + move_bytes + shift0 + shift1;
            pending &= ~((1u << root_shift.seed_dest)
                       | (1u << root_shift.copy_dest));
            continue;
        }
        pl_u32 local = 0u, written = 0u;
        if (!pl_select_next_compare_branch_assignment_excluding(
                &block->plan, pending,
                compare_reads, deferred, &local))
            return PL_ERROR_X86_SELECT;
        pl_operand value = block->plan.locals[local];
        int emitted;
        pl_u32 owner = pl_select_publication_owner(&block->plan, value);
        if (value.kind == PL_OPERAND_NODE && owner < PL_X86_GPR_COUNT && owner != local) {
            pl_u32 value_bits = pl_select_operand_fits_u32(
                &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
            emitted = pl_select_emit_gpr_move(local, owner, value_bits, output + at, &written);
        } else if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!pl_select_alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local
                    || !pl_select_write_alu_seed(
                        block, selection, local, source, node_bits, at,
                        block->plan.node_count + 1u,
                        output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
            if (at > selection->output_bytes
                    || !pl_select_emit_alu_instruction(
                    local, right_operand, node_bits, mode, preserves_carry,
                    output + at, &written))
                return PL_ERROR_X86_SELECT;
            emitted = 1;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, extend_bits = 0u;
            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            conditional_select select;
            if (pl_select_conditional_select_details(
                    &block->plan, value, local, &select)) {
                if (select.candidate_local == local)
                    return PL_ERROR_X86_SELECT;
                pl_operand current = select.current;
                pl_u32 current_local = 0u;
                if ((current.kind == PL_OPERAND_NODE
                        || current.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, current, &current_local)) {
                    current.kind = PL_OPERAND_LOCAL;
                    current.value = current_local;
                }
                if (!(select.current_flag_node
                        ? pl_select_write_selected_flag_value(block, selection, local, &select,
                            at, block->plan.node_count + 1u, 0u, output + at, &written)
                        : pl_select_write_alu_seed(
                        block, selection, local, current,
                        select.value_bits, at,
                        block->plan.node_count + 1u,
                        output + at, &written)))
                    return PL_ERROR_X86_SELECT;
                at += written;
                if (select.has_compare) {
                    int compared = pl_select_emit_select_compare(&select, output + at, &written);
                    if (!compared) return PL_ERROR_X86_SELECT;
                    at += written;
                }
                if (!pl_select_emit_conditional_move(
                        local, select.candidate_local,
                        select.value_bits, select.condition,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                emitted = 1;
            } else if (pl_select_collect_affine_lea(
                    &block->plan, value,
                    block->plan.node_count + 1u, &form)) {
                emitted = pl_select_emit_affine_lea(
                    local, form, output + at, &written);
            } else if (pl_select_zero_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                emitted = pl_select_emit_zero_extend_move(
                    local, source, extend_bits, output + at, &written);
            } else if (pl_select_sign_extend_node(
                    &block->plan, (pl_u32)value.value,
                    &source, &extend_bits)) {
                emitted = pl_select_emit_sign_extend_move(
                    local, source, extend_bits, output + at, &written);
            } else if (pl_select_shift_node_details(
                    &block->plan, value, &shift_source, &shift_amount,
                    &shift_bits, &shift_group)) {
                pl_u32 shift_owner = 0u;
                if ((shift_source.kind == PL_OPERAND_NODE
                        || shift_source.kind == PL_OPERAND_PROJECTION)
                        && pl_select_published_operand_local(
                            &block->plan, shift_source, &shift_owner)) {
                    shift_source.kind = PL_OPERAND_LOCAL;
                    shift_source.value = shift_owner;
                }
                if (!pl_select_write_alu_seed(
                        block, selection, local, shift_source, shift_bits,
                        at, block->plan.node_count + 1u,
                        output + at, &written))
                    return PL_ERROR_X86_SELECT;
                at += written;
                emitted = pl_select_emit_shift_instruction(
                    local, shift_amount, shift_bits, shift_group,
                    output + at, &written);
            } else {
                pl_u32 node_bits = pl_select_operand_fits_u32(
                    &block->plan, value, block->plan.node_count + 1u) ? 32u : 64u;
                emitted = pl_select_write_alu_tree(
                    block, selection, local, value, node_bits, at,
                    block->plan.node_count + 1u, 0u, output + at, &written);
            }
        } else {
            emitted = value.kind == PL_OPERAND_CONST && !value.value
                    && pl_select_zero_internal_compare_consumers(
                        &block->plan, local, pending)
                ? pl_select_emit_zero_register(local, output + at, &written)
                : pl_select_write_frame_value(
                    selection, at, local, value, output + at, &written);
        }
        if (!emitted || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
      }
      if (has_handoff && !stage) {
        pl_u32 written = 0u;
        if (!pl_select_write_alu_seed(
                block, selection, handoff.scratch, handoff.right,
                handoff.bits, at, block->plan.node_count + 1u,
                output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        pl_operand scratch = { PL_OPERAND_LOCAL, handoff.scratch };
        if (at > selection->output_bytes
                || !pl_select_emit_alu_instruction(
                    handoff.owner, scratch, handoff.bits, 3u, 0u,
                    output + at, &written))
            return PL_ERROR_X86_SELECT;
        at += written;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (local == handoff.owner
                    || !(handoff.outputs & (1u << local)))
                continue;
            if (at > selection->output_bytes
                    || !pl_select_emit_gpr_move(
                        local, handoff.owner, handoff.bits,
                        output + at, &written))
                return PL_ERROR_X86_SELECT;
            at += written;
        }
      }
    }
    if (flag_prefix) {
        if (at >= selection->output_bytes) return PL_ERROR_X86_SELECT;
        output[at++] = flag_prefix;
    }
    pl_u32 written = 0u;
    int flags_emitted = test
        ? pl_select_emit_test_operand(left, shape.right, bits, output + at, &written)
        : pl_select_emit_compare_operand(left, shape.right, bits, output + at, &written);
    if (!flags_emitted)
        return PL_ERROR_X86_SELECT;
    at += written;
    if (block->relax_short_control) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 6u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0x0fu;
        output[at++] = (pl_u8)(0x80u + condition);
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    } else {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 2u)
            return PL_ERROR_X86_SELECT;
        output[at++] = (pl_u8)(0x70u + condition);
        output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}
