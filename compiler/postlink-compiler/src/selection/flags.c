/* flags: native x86 selection. */
#include "flags.h"
#include "limits.h"
#include "lea.h"
#include "encoding.h"
#include "expressions.h"
#include "operands.h"
#include "select-rules.h"

static int test_boolean_publishes_flags(const pl_plan *plan, pl_operand value, pl_u32 flags);

static int mul_flags_value_publication(const pl_plan *plan,
                                       pl_operand value, pl_u32 flag_node);

static int publication_reads_entry_flags(const pl_plan *plan, pl_operand value);

static int tree_materializes_shift_count_visit(const pl_plan *plan,
                                               pl_operand value,
                                               pl_u8 *seen,
                                               pl_u32 remaining,
                                               int any_variable_count);

static int tree_materializes_shift_count(const pl_plan *plan,
                                         pl_operand value, pl_u32 remaining);

static int tree_uses_variable_shift_count(const pl_plan *plan,
                                          pl_operand value, pl_u32 remaining);

int pl_select_test_boolean_details(const pl_plan *plan, pl_operand value, test_boolean *out)
{
    if (!plan || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode != PL_OPCODE_X86_TEST_CONDITION || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at) return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[2].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[2].value;
    out->bits = (pl_u32)(descriptor & 0xffu);
    out->condition = (pl_u32)(descriptor >> 8u);
    if ((out->bits != 8u && out->bits != 16u && out->bits != 32u && out->bits != 64u)
            || descriptor >> 12u) return 0;
    out->left = argument[0]; out->right = argument[1];
    return 1;
}

static int test_boolean_publishes_flags(const pl_plan *plan, pl_operand value, pl_u32 flags)
{
    test_boolean shape;
    if (!plan || !flags || flags > plan->node_count
            || !pl_select_test_boolean_details(plan, value, &shape)) return 0;
    const pl_node *node = &plan->nodes[flags - 1u];
    if (node->opcode != PL_OPCODE_X86_TEST || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || 4u > plan->argument_count - node->argument_at) return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    return argument[3].kind == PL_OPERAND_CONST && argument[3].value == shape.bits
        && argument[1].kind == shape.left.kind && argument[1].value == shape.left.value
        && argument[2].kind == shape.right.kind && argument[2].value == shape.right.value;
}

/* One IMUL publishes both its low result and its conditions.  The normalized
 * plan keeps the low result and the X86_MUL_FLAGS node separate, so relate
 * them through the shared multiplicands: the flags node names the 64-bit low
 * product, and the value publication is a MULR/LANE32_MULR over the same
 * operands (the narrow constant is the low 32 bits of the wide one). */
static int mul_flags_value_publication(const pl_plan *plan,
                                       pl_operand value, pl_u32 flag_node)
{
    if (!plan || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count
            || !flag_node || flag_node > plan->node_count)
        return 0;
    const pl_node *flags = &plan->nodes[flag_node - 1u];
    const pl_node *result = &plan->nodes[value.value - 1u];
    if (flags->opcode != PL_OPCODE_X86_MUL_FLAGS
            || flags->argument_count != 4u
            || flags->argument_at > plan->argument_count
            || 4u > plan->argument_count - flags->argument_at
            || (result->opcode != PL_OPCODE_MULR
                && result->opcode != PL_OPCODE_LANE32_MULR)
            || result->argument_count != 2u
            || result->argument_at > plan->argument_count
            || 2u > plan->argument_count - result->argument_at)
        return 0;
    const pl_operand *flag_argument = plan->arguments + flags->argument_at;
    if (flag_argument[1].kind != PL_OPERAND_NODE
            || !flag_argument[1].value
            || flag_argument[1].value > plan->node_count)
        return 0;
    const pl_node *low = &plan->nodes[flag_argument[1].value - 1u];
    if (low->opcode != PL_OPCODE_MULR || low->argument_count != 2u
            || low->argument_at > plan->argument_count
            || 2u > plan->argument_count - low->argument_at)
        return 0;
    const pl_operand *wide = plan->arguments + low->argument_at;
    const pl_operand *narrow = plan->arguments + result->argument_at;
    for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
        pl_operand wide_left = wide[orientation];
        pl_operand wide_right = wide[1u - orientation];
        if (wide_left.kind != narrow[0].kind
                || wide_left.value != narrow[0].value)
            continue;
        if (wide_right.kind == PL_OPERAND_CONST
                && narrow[1].kind == PL_OPERAND_CONST
                && (wide_right.value & 0xffffffffull)
                   == (narrow[1].value & 0xffffffffull))
            return 1;
        if (wide_right.kind == narrow[1].kind
                && wide_right.value == narrow[1].value)
            return 1;
    }
    return 0;
}

int pl_select_publication_is_flag_result(const pl_plan *plan,
                                      pl_operand publication,
                                      pl_u32 flag_node)
{
    if (test_boolean_publishes_flags(plan, publication, flag_node)) return 1;
    if (mul_flags_value_publication(plan, publication, flag_node)) return 1;
    /* An X86_ALU value is published as its projection, but compaction may
     * name the producing node directly at the result coordinate. */
    if (publication.kind == PL_OPERAND_NODE
            && publication.value == flag_node
            && flag_node && flag_node <= plan->node_count) {
        pl_u32 opcode = plan->nodes[flag_node - 1u].opcode;
        if (opcode == PL_OPCODE_X86_ALU
                || opcode == PL_OPCODE_X86_AFFINE_ALU
                || opcode == PL_OPCODE_X86_BIT_SUMMARY)
            return 1;
    }
    pl_operand result, prior;
    if (!pl_select_flag_result_operand(plan, flag_node, &result, &prior)) return 0;
    for (pl_u32 remaining = plan->node_count + 1u; remaining; --remaining) {
        if (publication.kind == result.kind
                && publication.value == result.value)
            return 1;
        /* Measured physical vocabulary: lane32.and = 6, lane64.and = 76.  A
         * low-lane AND of the flag result is the rewriter's value-widening
         * artifact for a partial-width publication (`insert(base, value, w)`
         * folded when the base's masked-out bits are known zero).  The AND has
         * no flag effect in this plan (the block's RFLAGS names the original
         * producer), so only the flag provenance passes through; the emitter
         * still materializes the mask itself, which keeps the rule sound even
         * when the AND is a genuine `and reg, mask`. */
        if (publication.kind == PL_OPERAND_NODE && publication.value
                && publication.value <= plan->node_count) {
            const pl_node *mask = &plan->nodes[publication.value - 1u];
            if ((mask->opcode == 6u || mask->opcode == 76u)
                    && mask->argument_count == 2u
                    && mask->argument_at <= plan->argument_count
                    && 2u <= plan->argument_count - mask->argument_at
                    && plan->arguments[mask->argument_at + 1u].kind
                       == PL_OPERAND_CONST) {
                publication = plan->arguments[mask->argument_at];
                continue;
            }
            /* Physical lane insert (lane64.insert = 198, lane32.insert = 201)
             * writes the low `width` bits of a base from its second operand and
             * has no flag effect, so the block's final flags belong to the
             * inserted value's producer.  Only the flag provenance passes
             * through; the emitter materializes the base separately. */
            if ((mask->opcode == 198u || mask->opcode == 201u)
                    && mask->argument_count == 3u
                    && mask->argument_at <= plan->argument_count
                    && 3u <= plan->argument_count - mask->argument_at) {
                publication = plan->arguments[mask->argument_at + 1u];
                continue;
            }
            /* A sign-extension of the flag result (`or edi,imm; movslq`) also
             * carries the flag provenance: MOVSX/Q preserves flags, so the
             * extension's producer still sets the block's final flags. */
            pl_operand extended;
            pl_u32 extend_bits = 0u;
            if (pl_select_sign_extend_value(plan, (pl_u32)publication.value,
                    &extended, &extend_bits)) {
                publication = extended;
                continue;
            }
        }
        pl_operand source;
        pl_u32 bits = 0u;
        if (!pl_select_complement_node_details(plan, publication, &source, &bits))
            return 0;
        (void)bits;
        publication = source;
    }
    return 0;
}

int pl_select_frame_publication_clobbers_flags(const pl_plan *plan,
                                            pl_operand publication)
{
    if (!plan || publication.kind == PL_OPERAND_PROJECTION) return 1;
    if (publication.kind == PL_OPERAND_CONST
            || publication.kind == PL_OPERAND_LOCAL)
        return 0;
    if (publication.kind != PL_OPERAND_NODE || !publication.value
            || publication.value > plan->node_count)
        return 1;
    pl_operand complement_source;
    pl_u32 complement_bits = 0u;
    if (pl_select_complement_node_details(
            plan, publication, &complement_source, &complement_bits)) {
        (void)complement_bits;
        return pl_select_frame_publication_clobbers_flags(plan, complement_source);
    }
    pl_operand extended;
    pl_u32 extend_bits = 0u;
    if (pl_select_sign_extend_value(plan, (pl_u32)publication.value, &extended, &extend_bits))
        return pl_select_frame_publication_clobbers_flags(plan, extended);
    pl_u32 opcode = plan->nodes[publication.value - 1u].opcode;
    if (opcode == PL_OPCODE_LANE32_INSERT
            || opcode == PL_OPCODE_LANE64_INSERT
            || opcode == PL_OPCODE_LANE32_EXTEND8_S
            || opcode == PL_OPCODE_LANE32_EXTEND16_S
            || opcode == PL_OPCODE_LANE64_EXTEND8_S
            || opcode == PL_OPCODE_LANE64_EXTEND16_S
            || opcode == PL_OPCODE_EXTEND32_S
            || opcode == PL_OPCODE_ADD
            || opcode == PL_OPCODE_ADD3[0]
            || opcode == PL_OPCODE_ADD3[1]
            || opcode == PL_OPCODE_ALU_IMMEDIATE[0][1]
            || opcode == PL_OPCODE_ALU_IMMEDIATE[1][1]
            || opcode == PL_OPCODE_ALU_REGISTER[0][1]
            || opcode == PL_OPCODE_ALU_REGISTER[1][1])
        return 0;
    return 1;
}

int pl_select_publication_tree_clobbers_flags(const pl_plan *plan,
                                           pl_operand value,
                                           pl_u32 destination)
{
    if (!plan || value.kind == PL_OPERAND_PROJECTION) return 1;
    if (value.kind == PL_OPERAND_CONST || value.kind == PL_OPERAND_LOCAL)
        return 0;
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 1;
    /* A node already published in another local is a register read here; its
     * production is a separate publication that the scheduler orders on its
     * own.  Only a node materialized as part of this publication (its owner is
     * the destination, or it has no owner yet) contributes its instruction to
     * this emission. */
    pl_u32 owner = pl_select_publication_owner(plan, value);
    if (owner < PL_X86_GPR_COUNT && owner != destination)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    pl_u32 high8_source = 0u;
    if (pl_select_zero_extend_high8_node(
            plan, (pl_u32)value.value, &high8_source))
        return 0;
    if (node->opcode == PL_OPCODE_LANE32_INSERT
            || node->opcode == PL_OPCODE_LANE64_INSERT
            || node->opcode == PL_OPCODE_LANE32_EXTEND8_S
            || node->opcode == PL_OPCODE_LANE32_EXTEND16_S
            || node->opcode == PL_OPCODE_LANE64_EXTEND8_S
            || node->opcode == PL_OPCODE_LANE64_EXTEND16_S
            || node->opcode == PL_OPCODE_EXTEND32_S) {
        /* The wrapper itself preserves flags, but producing its input may
         * require an ALU instruction.  In particular, an OR nested inside a
         * lane insertion must precede the block's final CMP/Jcc. */
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            return 1;
        for (pl_u32 argument = 0u; argument < node->argument_count;
                ++argument)
            if (pl_select_publication_tree_clobbers_flags(
                    plan, plan->arguments[node->argument_at + argument],
                    destination))
                return 1;
        return 0;
    }
    if (node->opcode != PL_OPCODE_ADD
            && node->opcode != PL_OPCODE_ADD3[0]
            && node->opcode != PL_OPCODE_ADD3[1]
            && node->opcode != PL_OPCODE_ALU_IMMEDIATE[0][1]
            && node->opcode != PL_OPCODE_ALU_IMMEDIATE[1][1]
            && node->opcode != PL_OPCODE_ALU_REGISTER[0][1]
            && node->opcode != PL_OPCODE_ALU_REGISTER[1][1])
        return 1;
    return !pl_select_publication_add_preserves_flags(plan, value, destination);
}

/* Scheduling variant of pl_select_frame_local_publication_clobbers_flags: it answers
 * whether emitting this local now can change the flags the terminal reads. */
int pl_select_frame_local_emission_clobbers_flags(const pl_plan *plan,
                                               pl_u32 local)
{
    if (!plan || local >= PL_X86_GPR_COUNT) return 1;
    pl_operand publication = plan->locals[local];
    pl_u32 owner = pl_select_publication_owner(plan, publication);
    if (owner < PL_X86_GPR_COUNT && owner != local) {
        if (publication.kind == PL_OPERAND_CONST && !publication.value) {
            pl_u32 move_bytes = 0u, zero_bytes = 0u;
            if (pl_select_emit_gpr_move(
                    local, owner, 32u, (pl_u8 *)0, &move_bytes)
                    && pl_select_emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes)
                    && zero_bytes < move_bytes)
                return 1;
        }
        return 0;
    }
    return pl_select_publication_tree_clobbers_flags(plan, publication, local);
}

/* Equal zero values share one semantic owner, but the shortest native
 * spelling is coordinate-dependent.  A low-register self-XOR can be shorter
 * than a MOV from a high owner and therefore really does clobber flags; feed
 * that physical choice back into scheduling so the final flag producer stays
 * last. */
int pl_select_frame_local_publication_clobbers_flags(
    const pl_plan *plan, pl_u32 local)
{
    if (!plan || local >= PL_X86_GPR_COUNT) return 1;
    pl_operand publication = plan->locals[local];
    pl_u32 owner = pl_select_publication_owner(plan, publication);
    if (owner < PL_X86_GPR_COUNT && owner != local) {
        if (publication.kind == PL_OPERAND_CONST && !publication.value) {
            pl_u32 move_bytes = 0u, zero_bytes = 0u;
            if (pl_select_emit_gpr_move(
                    local, owner, 32u, (pl_u8 *)0, &move_bytes)
                    && pl_select_emit_zero_register(
                        local, (pl_u8 *)0, &zero_bytes)
                    && zero_bytes < move_bytes)
                return 1;
        }
        return 0;
    }
    return pl_select_frame_publication_clobbers_flags(plan, publication);
}

/* Entry flags are an input generation. A SETcc preserves them, but every
 * instruction that overwrites them must follow the reader, including a
 * materialized operand tree before the block's final flag producer. */
static int publication_reads_entry_flags(const pl_plan *plan, pl_operand value)
{
    if (!plan || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode == PL_OPCODE_X86_CONDITION
            && node->argument_count == 2u
            && node->argument_at <= plan->argument_count
            && 2u <= plan->argument_count - node->argument_at) {
        pl_operand flags = plan->arguments[node->argument_at];
        return flags.kind == PL_OPERAND_LOCAL
            && flags.value == PL_X86_RFLAGS_LOCAL;
    }
    if ((node->opcode == PL_OPCODE_LANE64_INSERT
                || node->opcode == PL_OPCODE_LANE32_INSERT)
            && node->argument_count == 3u
            && node->argument_at <= plan->argument_count
            && 3u <= plan->argument_count - node->argument_at)
        return publication_reads_entry_flags(
            plan, plan->arguments[node->argument_at + 1u]);
    return 0;
}

pl_u32 pl_select_pending_entry_flag_readers(const pl_plan *plan, pl_u32 pending)
{
    pl_u32 readers = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if ((pending & (1u << local))
                && publication_reads_entry_flags(plan, plan->locals[local]))
            readers |= 1u << local;
    return readers;
}

/* x86 variable shifts consume CL.  A tree whose count is held elsewhere
 * materializes that count in RCX; this is a physical write even when RCX is
 * not among the block's live output publications. */
static int tree_materializes_shift_count_visit(const pl_plan *plan,
                                               pl_operand value,
                                               pl_u8 *seen,
                                               pl_u32 remaining,
                                               int any_variable_count)
{
    if (!plan || !remaining) return 0;
    pl_u32 node_number = value.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(value.value >> 8u)
                       : value.kind == PL_OPERAND_NODE
                       ? (pl_u32)value.value : 0u;
    if (!node_number || node_number > plan->node_count) return 0;
    if (seen[node_number]) return 0;
    seen[node_number] = 1u;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    int shift = node->opcode == PL_OPCODE_LANE32_ROTL
             || node->opcode == PL_OPCODE_LANE64_ROTL
             || node->opcode == PL_OPCODE_LANE32_ROTR
             || node->opcode == PL_OPCODE_LANE64_ROTR
             || node->opcode == PL_OPCODE_LANE32_SHL
             || node->opcode == PL_OPCODE_LANE64_SHL
             || node->opcode == PL_OPCODE_LANE32_SHLR
             || node->opcode == PL_OPCODE_LANE64_SHLR
             || node->opcode == PL_OPCODE_LANE32_SHR
             || node->opcode == PL_OPCODE_LANE64_SHR
             || node->opcode == PL_OPCODE_LANE32_SHRR
             || node->opcode == PL_OPCODE_LANE64_SHRR
             || node->opcode == PL_OPCODE_LANE32_SAR
             || node->opcode == PL_OPCODE_LANE64_SAR
             || node->opcode == PL_OPCODE_LANE32_SARR
             || node->opcode == PL_OPCODE_LANE64_SARR;
    if (shift && node->argument_count == 2u) {
        pl_operand amount = plan->arguments[node->argument_at + 1u];
        if (any_variable_count && amount.kind != PL_OPERAND_CONST)
            return 1;
        if (amount.kind != PL_OPERAND_CONST
                && !(amount.kind == PL_OPERAND_LOCAL && amount.value == 1u)) {
            pl_operand source, normalized;
            pl_u32 bits = 0u, group = 0u;
            if (!pl_select_shift_node_details(
                    plan, value, &source, &normalized, &bits, &group)
                    || normalized.kind != PL_OPERAND_LOCAL
                    || normalized.value != 1u)
                return 1;
        }
    }
    for (pl_u32 index = 0u; index < node->argument_count; ++index)
        if (tree_materializes_shift_count_visit(
                plan, plan->arguments[node->argument_at + index], seen,
                remaining - 1u, any_variable_count))
            return 1;
    return 0;
}

static int tree_materializes_shift_count(const pl_plan *plan,
                                         pl_operand value, pl_u32 remaining)
{
    /* Direct ALU frames admit at most 96 nodes.  Visiting each DAG node once
     * makes the physical-hazard check linear even for shared expressions. */
    if (!plan || plan->node_count > 96u) return 0;
    pl_u8 seen[97] = { 0 };
    return tree_materializes_shift_count_visit(
        plan, value, seen, remaining, 0);
}

static int tree_uses_variable_shift_count(const pl_plan *plan,
                                          pl_operand value, pl_u32 remaining)
{
    if (!plan || plan->node_count > 96u) return 0;
    pl_u8 seen[97] = { 0 };
    return tree_materializes_shift_count_visit(
        plan, value, seen, remaining, 1);
}

int pl_select_next_alu_frame_assignment(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 final_flag_node,
                                     const pl_u32 *sources,
                                     const pl_u32 *dependencies,
                                     pl_u32 protected_entries,
                                     pl_u32 *selected)
{
    if (!plan || !pending || !sources || !dependencies || !selected)
        return 0;
    const pl_u32 entry_flag_readers = pl_select_pending_entry_flag_readers(plan, pending);
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        if (protected_entries & (1u << local)) continue;
        pl_operand published = plan->locals[local];
        if ((entry_flag_readers & ~(1u << local))
                && pl_select_frame_local_emission_clobbers_flags(plan, local))
            continue;
        /* The final flags producer must be textually last.  Other dense
         * publications may consume an earlier flags version (CMOV/SETcc)
         * even when they are not themselves ALU projections. */
        if ((pl_select_publication_is_flag_result(plan, published, final_flag_node)
                || pl_select_publication_emits_selected_flag(plan, published, local, final_flag_node))
                && pl_select_publication_owner(plan, published) == local) {
            pl_u32 blockers = pending & ~(1u << local);
            for (pl_u32 fanout = 0u;
                    fanout < PL_X86_GPR_COUNT; ++fanout)
                if ((blockers & (1u << fanout))
                        && pl_select_publication_owner(
                            plan, plan->locals[fanout]) == local
                        && !pl_select_frame_local_emission_clobbers_flags(
                            plan, fanout))
                    blockers &= ~(1u << fanout);
            for (pl_u32 blocker = 0u;
                    blocker < PL_X86_GPR_COUNT; ++blocker)
                if ((blockers & (1u << blocker))
                        && !pl_select_frame_local_emission_clobbers_flags(
                            plan, blocker)
                        /* A SETcc of the entry flags is flag-preserving yet
                         * still reads them, so it must stay a blocker: the
                         * final producer would destroy its input. */
                        && !publication_reads_entry_flags(
                            plan, plan->locals[blocker]))
                    blockers &= ~(1u << blocker);
            if (blockers) continue;
        }
        pl_u32 effective_dependencies = dependencies[local];
        pl_u32 physical_owner = pl_select_publication_owner(plan, published);
        if (published.kind == PL_OPERAND_CONST && !published.value
                && physical_owner < PL_X86_GPR_COUNT
                && physical_owner != local
                && pl_select_frame_local_publication_clobbers_flags(plan, local))
            effective_dependencies &= ~(1u << physical_owner);
        if (protected_entries & effective_dependencies) {
            pl_u32 semantic_sources = 0u;
            if (!pl_select_operand_gpr_sources(
                    plan, published, plan->node_count + 1u,
                    plan->node_count + 1u, &semantic_sources))
                continue;
            effective_dependencies &=
                ~(protected_entries & semantic_sources);
        }
        if (effective_dependencies & pending) continue;
        /* A variable shift consumes CL and may also stage a different count
         * there.  Keep RCX's final publication after every pending shift;
         * semantic source laws alone do not describe that temporary physical
         * write.  If a producer edge requires the opposite order, this
         * direct frame is unsafe and the exact source candidate remains. */
        if (local == 1u) {
            int shift_pending = 0;
            for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other)
                if (other != local && (pending & (1u << other))
                        && pl_select_publication_owner(
                            plan, plan->locals[other]) == other
                        && tree_uses_variable_shift_count(
                            plan, plan->locals[other],
                            plan->node_count + 1u)) {
                    shift_pending = 1;
                    break;
                }
            if (shift_pending) continue;
        }
        pl_u32 used_by_others = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            /* A dependency source is the new value published by another
             * pending local, not that register's entry value.  It imposes a
             * producer-before-consumer edge, never an anti-dependency. */
            used_by_others |= sources[other];
        }
        if (local != 1u
                && tree_materializes_shift_count(
                    plan, published, plan->node_count + 1u)
                && (used_by_others & (1u << 1u)))
            continue;
        if (!(used_by_others & (1u << local))) {
            *selected = local;
            return 1;
        }
    }
    return 0;
}
