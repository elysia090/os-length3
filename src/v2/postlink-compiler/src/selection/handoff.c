/* handoff: native x86 selection. */
#include "handoff.h"
#include "limits.h"
#include "encoding.h"
#include "expressions.h"
#include "flags.h"
#include "operands.h"
#include "select-rules.h"
#include "simple-frame.h"
#include "source.h"
#include "tree-measure.h"
#include "tree-write.h"

static pl_operand generation_join_right(
    const generation_join_handoff *handoff);

static int peel_associative_arm(const pl_plan *plan, pl_operand left,
                                pl_operand right, pl_operand target,
                                pl_u32 bits, pl_u32 mode,
                                pl_operand *remainder);

static int shared_root_consumer_of(const pl_plan *plan, pl_u32 local,
                                   pl_u32 final_flag_node,
                                   shared_root_consumer *out);

static int compare_tree_select_frame_shape(
    const pl_x86_block *block, compare_tree_select_frame *out);

static int operand_reads_published_shift(const pl_plan *plan,
                                         pl_operand value, pl_u32 output_local,
                                         const pl_u8 *shift_owner,
                                         pl_u8 *seen, pl_u32 remaining);

static pl_u32 entry_dependencies(const pl_plan *plan, pl_operand value,
                                 pl_u32 *memo, pl_u8 *state);

static pl_operand select_flag_source(const pl_plan *plan,
                                     pl_operand condition);

/* Pending destinations are the only reversible scratch coordinates: their
 * final values have not been published yet.  Entry values needed by another
 * root remain pinned.  Entry values used only by the selected root stay in
 * the pool: its recursive scheduler may borrow them immediately after their
 * last child use instead of extending every entry lifetime to the block cut. */
pl_u32 pl_select_alu_frame_scratch_mask(
    pl_u32 pending, pl_u32 destination,
    const pl_u32 sources[PL_X86_GPR_COUNT])
{
    pl_u32 live_entries = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (local != destination && (pending & (1u << local)))
            live_entries |= sources[local];
    return pending & ~(1u << destination) & ~live_entries;
}

int pl_select_shift_sibling_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    shift_sibling_handoff *out)
{
    if (!plan || !pending || !final_flag_node || !sources
            || !out)
        return 0;
    pl_u32 live_entries = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (pending & (1u << local))
            live_entries |= sources[local];
    for (pl_u32 flag_destination = 0u;
            flag_destination < PL_X86_GPR_COUNT; ++flag_destination) {
        if (!(pending & (1u << flag_destination))) continue;
        pl_operand flag_value = plan->locals[flag_destination];
        if (!pl_select_publication_is_flag_result(
                plan, flag_value, final_flag_node))
            continue;
        pl_operand flag_source, flag_amount;
        pl_u32 flag_bits = 0u, flag_group = 0u;
        if (!pl_select_shift_node_details(
                plan, flag_value, &flag_source, &flag_amount,
                &flag_bits, &flag_group)
                || flag_source.kind != PL_OPERAND_LOCAL
                || flag_source.value >= PL_X86_GPR_COUNT
                || flag_amount.kind != PL_OPERAND_CONST
                || !(flag_amount.value
                    & (flag_bits == 64u ? 63u : 31u)))
            continue;
        for (pl_u32 sibling = 0u; sibling < PL_X86_GPR_COUNT; ++sibling) {
            if (sibling == flag_destination
                    || !(pending & (1u << sibling)))
                continue;
            pl_operand sibling_value = plan->locals[sibling];
            pl_operand sibling_source, sibling_amount;
            pl_u32 sibling_bits = 0u, sibling_group = 0u;
            if (!pl_select_shift_node_details(
                    plan, sibling_value, &sibling_source, &sibling_amount,
                    &sibling_bits, &sibling_group)
                    || sibling_bits != flag_bits
                    || sibling_source.kind != flag_source.kind
                    || sibling_source.value != flag_source.value)
                continue;
            if (sibling == flag_source.value
                    && flag_destination != flag_source.value) {
                pl_u32 pair = (1u << flag_destination)
                            | (1u << sibling);
                if (pending & ~pair) continue;
                out->flag_destination = flag_destination;
                out->sibling_destination = sibling;
                out->scratch = PL_X86_GPR_COUNT;
                out->source = (pl_u32)flag_source.value;
                out->bits = flag_bits;
                out->flag_group = flag_group;
                out->sibling_group = sibling_group;
                out->flag_amount = flag_amount;
                out->sibling_amount = sibling_amount;
                out->flag_value = flag_value;
                out->sibling_value = sibling_value;
                return 1;
            }
            for (pl_u32 scratch = 0u;
                    scratch < PL_X86_GPR_COUNT; ++scratch) {
                if (scratch == flag_destination || scratch == sibling
                        || !(pending & (1u << scratch))
                        || (live_entries & (1u << scratch)))
                    continue;
                pl_operand publication = plan->locals[scratch];
                if ((publication.kind != PL_OPERAND_CONST
                        && (publication.kind != PL_OPERAND_LOCAL
                            || publication.value >= PL_X86_GPR_COUNT))
                        || pl_select_frame_local_publication_clobbers_flags(
                            plan, scratch))
                    continue;
                pl_u32 group = (1u << flag_destination)
                             | (1u << sibling) | (1u << scratch);
                if (pending & ~group) continue;
                out->flag_destination = flag_destination;
                out->sibling_destination = sibling;
                out->scratch = scratch;
                out->source = (pl_u32)flag_source.value;
                out->bits = flag_bits;
                out->flag_group = flag_group;
                out->sibling_group = sibling_group;
                out->flag_amount = flag_amount;
                out->sibling_amount = sibling_amount;
                out->flag_value = flag_value;
                out->sibling_value = sibling_value;
                return 1;
            }
        }
    }
    return 0;
}

/* A 32-bit word operation is the low-word quotient of the same 64-bit
 * AND/ADD/SUB/OR/XOR operation.  When both results and their shared parent
 * survive, keep the parent in the wide destination, publish it once, update
 * that accumulator to the wide child, and obtain the narrow child with one
 * 32-bit move.  No second expression tree is materialized. */
int pl_select_arithmetic_width_handoff_shape(
    const pl_plan *plan, pl_u32 pending,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    const pl_u32 dependencies[PL_X86_GPR_COUNT],
    arithmetic_width_handoff *out)
{
    if (!plan || !pending || !sources || !dependencies || !out)
        return 0;
    for (pl_u32 parent_destination = 0u;
            parent_destination < PL_X86_GPR_COUNT;
            ++parent_destination) {
        pl_u32 parent_bit = 1u << parent_destination;
        if (!(pending & parent_bit)) continue;
        pl_operand parent = plan->locals[parent_destination];
        if (pl_select_publication_owner(plan, parent) != parent_destination)
            continue;
        for (pl_u32 wide = 0u; wide < PL_X86_GPR_COUNT; ++wide) {
            pl_u32 wide_bit = 1u << wide;
            if (wide == parent_destination || !(pending & wide_bit))
                continue;
            pl_operand wide_left, wide_right;
            pl_u32 wide_bits = 0u, wide_mode = 0u;
            if (!pl_select_arithmetic_tree_details(
                    plan, plan->locals[wide], &wide_left, &wide_right,
                    &wide_bits, &wide_mode)
                    || wide_bits != 64u
                    || (wide_mode != 0u && wide_mode != 1u
                        && wide_mode != 3u && wide_mode != 5u
                        && wide_mode != 6u)
                    || wide_left.kind != parent.kind
                    || wide_left.value != parent.value)
                continue;
            pl_u32 parent_sources = 0u;
            if (!pl_select_operand_entry_gpr_sources(
                    plan, parent, plan->node_count + 1u,
                    plan->node_count + 1u, &parent_sources)
                    || !(parent_sources & wide_bit))
                continue;
            pl_operand physical_right = wide_right;
            pl_select_physicalize_published_operand(plan, wide, &physical_right);
            if (physical_right.kind != PL_OPERAND_CONST
                    && (physical_right.kind != PL_OPERAND_LOCAL
                        || physical_right.value >= PL_X86_GPR_COUNT))
                continue;
            if (physical_right.kind == PL_OPERAND_LOCAL
                    && (physical_right.value == parent_destination
                        || physical_right.value == wide))
                continue;
            for (pl_u32 narrow = 0u;
                    narrow < PL_X86_GPR_COUNT; ++narrow) {
                pl_u32 narrow_bit = 1u << narrow;
                if (narrow == parent_destination || narrow == wide
                        || !(pending & narrow_bit))
                    continue;
                pl_operand narrow_left, narrow_right;
                pl_u32 narrow_bits = 0u, narrow_mode = 0u;
                if (!pl_select_arithmetic_tree_details(
                        plan, plan->locals[narrow],
                        &narrow_left, &narrow_right,
                        &narrow_bits, &narrow_mode)
                        || narrow_bits != 32u
                        || narrow_mode != wide_mode
                        || narrow_left.kind != wide_left.kind
                        || narrow_left.value != wide_left.value
                        || narrow_right.kind != wide_right.kind
                        || narrow_right.value != wide_right.value)
                    continue;
                pl_u32 group = parent_bit | wide_bit | narrow_bit;
                if (dependencies[parent_destination] & pending)
                    continue;
                if ((dependencies[wide] & pending & ~group)
                        || (dependencies[narrow] & pending & ~group))
                    continue;
                int clobbers_live_entry = 0;
                for (pl_u32 other = 0u;
                        other < PL_X86_GPR_COUNT; ++other) {
                    pl_u32 other_bit = 1u << other;
                    if (!(pending & other_bit) || (group & other_bit))
                        continue;
                    if (sources[other] & group) {
                        clobbers_live_entry = 1;
                        break;
                    }
                }
                if (clobbers_live_entry) continue;
                out->parent_destination = parent_destination;
                out->wide_destination = wide;
                out->narrow_destination = narrow;
                out->mode = wide_mode;
                out->parent = parent;
                out->right = physical_right;
                return 1;
            }
        }
    }
    return 0;
}

/* Materialize a shared internal SSA node exactly once.  One child updates a
 * dying entry coordinate with a binary operation while the other updates the
 * parent's dying coordinate with a shift; the two children then join in the
 * binary root.  The scratch coordinates must have source-free final values,
 * so the root may be published before their ordinary frame assignments. */
int pl_select_shared_diamond_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    const pl_u32 dependencies[PL_X86_GPR_COUNT],
    pl_u32 protected_entries, shared_diamond_handoff *out)
{
    if (!plan || !pending || !sources || !dependencies || !out)
        return 0;
    for (pl_u32 root = 0u; root < PL_X86_GPR_COUNT; ++root) {
        pl_u32 root_bit = 1u << root;
        if (!(pending & root_bit)) continue;
        pl_operand root_value = plan->locals[root];
        if (pl_select_publication_owner(plan, root_value) != root
                || pl_select_publication_is_flag_result(
                    plan, root_value, final_flag_node))
            continue;
        pl_operand root_left, root_right;
        pl_u32 bits = 0u, root_mode = 0u;
        if (!pl_select_arithmetic_tree_details(
                plan, root_value, &root_left, &root_right,
                &bits, &root_mode))
            continue;
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            if (orientation && root_mode == 3u) continue;
            pl_operand side = orientation ? root_right : root_left;
            pl_operand shifted = orientation ? root_left : root_right;
            pl_operand parent, amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            if (!pl_select_shift_node_details(
                    plan, shifted, &parent, &amount,
                    &shift_bits, &shift_group)
                    || shift_bits != bits
                    || (parent.kind != PL_OPERAND_NODE
                        && parent.kind != PL_OPERAND_PROJECTION))
                continue;
            pl_operand side_left, side_right;
            pl_u32 side_bits = 0u, side_mode = 0u;
            if (!pl_select_arithmetic_tree_details(
                    plan, side, &side_left, &side_right,
                    &side_bits, &side_mode)
                    || side_bits != bits)
                continue;
            pl_operand side_entry;
            if (pl_select_equal_operand(side_right, parent)
                    && side_left.kind == PL_OPERAND_LOCAL) {
                side_entry = side_left;
            } else if (side_mode != 3u
                    && pl_select_equal_operand(side_left, parent)
                    && side_right.kind == PL_OPERAND_LOCAL) {
                side_entry = side_right;
            } else {
                continue;
            }
            if (side_entry.value >= PL_X86_GPR_COUNT) continue;
            pl_u32 side_owner = (pl_u32)side_entry.value;
            pl_u32 side_bit = 1u << side_owner;
            if (side_owner == root || !(pending & side_bit)
                    || sources[side_owner])
                continue;
            pl_u32 parent_sources = 0u;
            if (!pl_select_operand_entry_gpr_sources(
                    plan, parent, plan->node_count + 1u,
                    plan->node_count + 1u, &parent_sources))
                continue;
            for (pl_u32 parent_owner = 0u;
                    parent_owner < PL_X86_GPR_COUNT; ++parent_owner) {
                pl_u32 parent_bit = 1u << parent_owner;
                if (parent_owner == root || parent_owner == side_owner
                        || !(pending & parent_bit)
                        || !(parent_sources & parent_bit)
                        || sources[parent_owner]
                        || (protected_entries & (parent_bit | side_bit)))
                    continue;
                pl_u32 scratch = parent_bit | side_bit;
                int old_value_escapes = 0;
                for (pl_u32 other = 0u;
                        other < PL_X86_GPR_COUNT; ++other) {
                    pl_u32 other_bit = 1u << other;
                    if (!(pending & other_bit)
                            || other == root || other == parent_owner
                            || other == side_owner)
                        continue;
                    if (sources[other] & scratch) {
                        old_value_escapes = 1;
                        break;
                    }
                }
                if (old_value_escapes) continue;
                out->root = root;
                out->parent_owner = parent_owner;
                out->side_owner = side_owner;
                out->bits = bits;
                out->side_mode = side_mode;
                out->shift_group = shift_group;
                out->root_mode = root_mode;
                out->parent = parent;
                out->shift_amount = amount;
                return 1;
            }
        }
    }
    return 0;
}

/* A normalized root may join one entry-only subtree with a later published
 * subtree.  Treating the whole root as one atomic assignment either extends
 * every entry lifetime or recomputes the first subtree for each consumer.
 * Seed that subtree into the final destination, expose the coordinate as its
 * transient owner, and overwrite it only after all alias consumers finish. */
int pl_select_generation_join_handoff_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 sources[PL_X86_GPR_COUNT],
    generation_join_handoff *out)
{
    if (!plan || !pending || !final_flag_node || !sources || !out)
        return 0;
    pl_u32 best_score = 0u;
    for (pl_u32 destination = 0u;
            destination < PL_X86_GPR_COUNT; ++destination) {
        pl_u32 destination_bit = 1u << destination;
        if (!(pending & destination_bit)) continue;
        pl_operand value = plan->locals[destination];
        pl_operand left, right;
        pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
        if (value.kind == PL_OPERAND_PROJECTION
                && (value.value & 0xffu) == 16u) {
            pl_u32 node_number = (pl_u32)(value.value >> 8u);
            if (node_number != final_flag_node
                    || !pl_select_alu_node_semantics(
                        plan, node_number, &left, &right,
                        &bits, &mode, &preserves_carry)
                    || preserves_carry)
                continue;
        } else if (value.kind == PL_OPERAND_NODE
                && pl_select_publication_owner(plan, value) == destination) {
            if (!pl_select_arithmetic_tree_details(
                    plan, value, &left, &right, &bits, &mode))
                continue;
        } else {
            continue;
        }
        pl_u32 tail_present = 0u, tail_mode = mode;
        pl_operand tail = { PL_OPERAND_CONST, 0u };
        /* A constant final operation does not consume another entry
         * generation. Expose the inner shared join and leave that exact
         * operation last, so its architectural flags remain the output. */
        if (pl_select_publication_is_flag_result(plan, value, final_flag_node)) {
            pl_operand inner = left, constant = right;
            if (left.kind == PL_OPERAND_CONST && pl_select_associative_mode(mode)) {
                inner = right;
                constant = left;
            }
            pl_operand inner_left, inner_right;
            pl_u32 inner_bits = 0u, inner_mode = 0u;
            if (constant.kind == PL_OPERAND_CONST
                    && pl_select_arithmetic_tree_details(plan, inner,
                        &inner_left, &inner_right, &inner_bits, &inner_mode)
                    && inner_bits == bits) {
                pl_u32 first_owner = PL_X86_GPR_COUNT;
                pl_u32 second_owner = PL_X86_GPR_COUNT;
                if ((pl_select_published_operand_local(plan, inner_right, &first_owner)
                        && first_owner != destination
                        && (pending & (1u << first_owner)))
                        || (pl_select_associative_mode(inner_mode)
                            && pl_select_published_operand_local(plan, inner_left, &second_owner)
                            && second_owner != destination
                            && (pending & (1u << second_owner)))) {
                    tail_present = 1u;
                    tail = constant;
                    left = inner_left;
                    right = inner_right;
                    mode = inner_mode;
                }
            }
        }
        for (pl_u32 orientation = 0u; orientation < 2u; ++orientation) {
            if (orientation && mode == 3u) continue;
            pl_operand seed = orientation ? right : left;
            pl_operand deferred = orientation ? left : right;
            if (seed.kind == PL_OPERAND_CONST) continue;
            /* The constant-deferred form exists to preserve a root which is
             * itself the final flag producer.  Applying it to an unrelated
             * value root can lengthen a separately live CMP/TEST lifetime
             * and is not a valid scheduling improvement. */
            if (deferred.kind == PL_OPERAND_CONST
                    && !pl_select_publication_is_flag_result(
                        plan, value, final_flag_node))
                continue;
            if (deferred.kind == PL_OPERAND_CONST) {
                pl_u32 seed_source = 0u, seed_bits = 0u;
                if (seed.kind != PL_OPERAND_NODE
                        || !pl_select_zero_extend_node(
                            plan, (pl_u32)seed.value,
                            &seed_source, &seed_bits)
                        || seed_bits != bits
                        || seed_source == destination
                        || !(pending & (1u << seed_source)))
                    continue;
            }
            /* An unchanged entry value already lives in its destination
             * coordinate.  Source-law scheduling preserves that lifetime;
             * spending the one transient alias on this no-op seed only hides
             * a nontrivial shared subtree that actually needs an owner. */
            if (seed.kind == PL_OPERAND_LOCAL
                    && seed.value == destination)
                continue;
            pl_u32 owner = PL_X86_GPR_COUNT;
            if (deferred.kind != PL_OPERAND_CONST
                    && (!pl_select_published_operand_local(plan, deferred, &owner)
                        || owner == destination
                        || !(pending & (1u << owner))))
                continue;
            pl_u32 seed_sources = 0u, seed_dependencies = 0u;
            if (!pl_select_operand_frame_source_law(
                    plan, seed, &seed_sources, &seed_dependencies))
                continue;
            pl_u32 preload = seed_dependencies & pending;
            pl_u32 entry_reads = seed_sources;
            for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other)
                if (pending & (1u << other)) entry_reads |= sources[other];
            if (entry_reads & preload) continue;
            int preload_valid = 1;
            for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
                if (!(preload & (1u << other))) continue;
                pl_operand publication = plan->locals[other];
                if (publication.kind != PL_OPERAND_LOCAL
                        && publication.kind != PL_OPERAND_CONST)
                    preload_valid = 0;
            }
            if (!preload_valid) continue;
            if (pl_select_frame_publication_clobbers_flags(plan, seed)) {
                int entry_flags_escape = 0;
                for (pl_u32 other = 0u;
                        other < PL_X86_GPR_COUNT; ++other) {
                    conditional_select select;
                    if ((pending & (1u << other))
                            && pl_select_conditional_select_details(
                                plan, plan->locals[other], other, &select)
                            && !select.has_compare && !select.current_flag_node) {
                        entry_flags_escape = 1;
                        break;
                    }
                }
                if (entry_flags_escape) continue;
            }
            int destination_entry_escapes = 0;
            for (pl_u32 other = 0u;
                    other < PL_X86_GPR_COUNT; ++other) {
                if (other != destination
                        && (pending & (1u << other))
                        && (sources[other] & destination_bit)
                        && !pl_select_operand_contains_unpublished_value(
                            plan, plan->locals[other], seed,
                            plan->node_count + 1u, 1)) {
                    destination_entry_escapes = 1;
                    break;
                }
            }
            if (destination_entry_escapes) continue;
            pl_u32 score = owner < PL_X86_GPR_COUNT
                         && (seed_sources & (1u << owner)) ? 4u : 0u;
            /* A constant join has no deferred producer.  It still requires
             * a transient owner when its seed consumes an entry coordinate
             * which another pending publication overwrites.  Capturing that
             * generation once is the exact anti-dependency cut. */
            if (owner == PL_X86_GPR_COUNT
                    && (seed_sources & (pending & ~destination_bit)))
                score += 4u;
            for (pl_u32 other = 0u;
                    other < PL_X86_GPR_COUNT; ++other) {
                /* Another coordinate that publishes the same final root is
                 * a copy-out, not an independent consumer of the entry
                 * generation hidden inside that root.  Counting it as seed
                 * fanout creates a false alias cycle: the copy-out must wait
                 * for the final join, whereas a real alias consumer runs
                 * before it. */
                if (other != destination
                        && (pending & (1u << other))
                        && pl_select_publication_owner(
                            plan, plan->locals[other]) == destination)
                    continue;
                if (other != destination
                        && (pending & (1u << other))
                        && pl_select_operand_contains_unpublished_value(
                            plan, plan->locals[other], seed,
                            plan->node_count + 1u, 1)) {
                    score += 2u;
                    break;
                }
            }
            if (seed.kind == PL_OPERAND_LOCAL) ++score;
            if (score <= best_score) continue;
            pl_u32 external_sources = 0u;
            for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
                if (!(pending & ~preload & (1u << other))) continue;
                if (!pl_select_operand_entry_sources_without(plan, plan->locals[other],
                        seed, plan->node_count + 1u, plan->node_count + 1u,
                        1, &external_sources)) return 0;
            }
            best_score = score;
            out->destination = destination;
            out->dependency_owner = owner;
            out->bits = bits;
            out->mode = mode;
            out->preserves_carry = preserves_carry;
            out->seed = seed;
            out->deferred = deferred;
            out->preload_mask = preload;
            out->scratch_mask = pending & ~preload & ~destination_bit & ~external_sources;
            out->tail_present = tail_present;
            out->tail_mode = tail_mode;
            out->tail = tail;
        }
    }
    return best_score >= 2u;
}

int pl_select_apply_generation_join_laws(
    const pl_plan *plan, pl_u32 pending,
    const generation_join_handoff *handoff,
    pl_u32 sources[PL_X86_GPR_COUNT],
    pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !handoff || !sources || !dependencies
            || handoff->destination >= PL_X86_GPR_COUNT
            || handoff->dependency_owner > PL_X86_GPR_COUNT)
        return 0;
    pl_u32 alias_bit = 1u << handoff->destination;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == handoff->destination || !(pending & (1u << local)))
            continue;
        /* Equal-result publications consume the completed root.  Rewriting
         * them to the transient seed would publish the old generation. */
        if (pl_select_publication_owner(plan, plan->locals[local])
                == handoff->destination)
            continue;
        if (!pl_select_operand_contains_unpublished_value(
                plan, plan->locals[local], handoff->seed,
                plan->node_count + 1u, 1))
            continue;
        pl_u32 remaining_sources = 0u;
        if (!pl_select_operand_entry_sources_without(
                plan, plan->locals[local], handoff->seed,
                plan->node_count + 1u, plan->node_count + 1u,
                1, &remaining_sources))
            return 0;
        sources[local] = remaining_sources | alias_bit;
    }
    /* The seed now lives in the destination coordinate until the join.  That
     * coordinate is live, so it must stay out of every other publication's
     * scratch pool and must not be overwritten before the join; naming it as
     * its own entry source expresses exactly that anti-dependency (no other
     * pending publication writes it, so no producer edge is created). */
    sources[handoff->destination] = alias_bit;
    dependencies[handoff->destination] =
        handoff->dependency_owner < PL_X86_GPR_COUNT
        ? 1u << handoff->dependency_owner : 0u;
    return 1;
}

static pl_operand generation_join_right(
    const generation_join_handoff *handoff)
{
    if (handoff && handoff->dependency_owner < PL_X86_GPR_COUNT)
        return (pl_operand){
            PL_OPERAND_LOCAL, handoff->dependency_owner,
        };
    return handoff ? handoff->deferred
                   : (pl_operand){ PL_OPERAND_CONST, 0u };
}

int pl_select_emit_generation_join(const generation_join_handoff *handoff,
                                 pl_u8 *output, pl_u32 *written)
{
    pl_u32 join = 0u, tail = 0u;
    if (!pl_select_emit_alu_instruction(handoff->destination,
            generation_join_right(handoff), handoff->bits, handoff->mode,
            handoff->preserves_carry, output, &join)) return 0;
    if (handoff->tail_present
            && !pl_select_emit_alu_instruction(handoff->destination, handoff->tail,
                handoff->bits, handoff->tail_mode, 0u,
                output ? output + join : 0, &tail)) return 0;
    *written = join + tail;
    return 1;
}

static int peel_associative_arm(const pl_plan *plan, pl_operand left,
                                pl_operand right, pl_operand target,
                                pl_u32 bits, pl_u32 mode,
                                pl_operand *remainder)
{
    if (!plan || !remainder) return 0;
    if (pl_select_equal_operand(left, target)) {
        *remainder = right;
        return 1;
    }
    if (pl_select_equal_operand(right, target)) {
        *remainder = left;
        return 1;
    }
    (void)bits;
    (void)mode;
    return 0;
}

/* One entry word can have two masked futures after the same shift while a
 * third future must consume the unshifted generation.  Compute the latter in
 * its final accumulator, advance the entry coordinate to the shared shifted
 * generation, copy that generation once, then form both publications.  The
 * final two bitwise joins remain last and therefore publish the exact flags.
 *
 * This is the register image of one shared SSA parent.  No transient row or
 * source instruction sequence survives in the optimized ELF. */
int pl_select_shared_parent_frame_shape(const pl_x86_block *block,
                                     pl_u32 changed,
                                     pl_u32 final_flag_node,
                                     shared_parent_frame *out)
{
    if (!block || !out || !changed || !final_flag_node) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 destination = PL_X86_GPR_COUNT;
    pl_operand root_left, root_right;
    pl_u32 bits = 0u, root_mode = 0u, preserves_carry = 0u;
    if (!pl_select_alu_node_details(
            plan, final_flag_node, &destination, &root_left, &root_right,
            &bits, &root_mode, &preserves_carry)
            || destination >= PL_X86_GPR_COUNT || preserves_carry
            || (root_mode != 0u && root_mode != 5u && root_mode != 6u)
            || !pl_select_publication_is_flag_result(
                plan, plan->locals[destination], final_flag_node))
        return 0;

    for (pl_u32 first = 0u; first < PL_X86_GPR_COUNT; ++first) {
        if (first == destination || !(changed & (1u << first))) continue;
        pl_operand first_left, first_right;
        pl_u32 first_bits = 0u, first_mode = 0u;
        if (!pl_select_arithmetic_tree_details(
                plan, plan->locals[first], &first_left, &first_right,
                &first_bits, &first_mode)
                || first_bits != bits || first_right.kind != PL_OPERAND_CONST)
            continue;
        for (pl_u32 second = first + 1u;
                second < PL_X86_GPR_COUNT; ++second) {
            if (second == destination || !(changed & (1u << second)))
                continue;
            pl_operand second_left, second_right;
            pl_u32 second_bits = 0u, second_mode = 0u;
            if (!pl_select_arithmetic_tree_details(
                    plan, plan->locals[second],
                    &second_left, &second_right,
                    &second_bits, &second_mode)
                    || second_bits != bits
                    || second_right.kind != PL_OPERAND_CONST
                    || !pl_select_equal_operand(first_left, second_left))
                continue;

            pl_operand shift_source, shift_amount;
            pl_u32 shift_bits = 0u, shift_group = 0u;
            if (!pl_select_shift_node_details(
                    plan, first_left, &shift_source, &shift_amount,
                    &shift_bits, &shift_group)
                    || shift_bits != bits
                    || shift_source.kind != PL_OPERAND_LOCAL
                    || shift_source.value >= PL_X86_GPR_COUNT
                    || shift_amount.kind != PL_OPERAND_CONST)
                continue;
            pl_u32 mutable_owner = (pl_u32)shift_source.value;
            if (mutable_owner != first && mutable_owner != second)
                continue;
            pl_u32 sibling_owner = mutable_owner == first ? second : first;
            pl_operand mutable_value = plan->locals[mutable_owner];
            pl_operand sibling_value = plan->locals[sibling_owner];
            pl_operand accumulator;
            int peeled = peel_associative_arm(
                plan, root_left, root_right, mutable_value,
                bits, root_mode, &accumulator);
            if (peeled) {
                pl_operand left, right;
                pl_u32 inner_bits = 0u, inner_mode = 0u;
                if (!pl_select_arithmetic_tree_details(
                        plan, accumulator, &left, &right,
                        &inner_bits, &inner_mode)
                        || inner_bits != bits || inner_mode != root_mode
                        || !peel_associative_arm(
                            plan, left, right, sibling_value,
                            bits, root_mode, &accumulator))
                    peeled = 0;
            }
            if (!peeled) {
                if (!peel_associative_arm(
                        plan, root_left, root_right, sibling_value,
                        bits, root_mode, &accumulator))
                    continue;
                pl_operand left, right;
                pl_u32 inner_bits = 0u, inner_mode = 0u;
                if (!pl_select_arithmetic_tree_details(
                        plan, accumulator, &left, &right,
                        &inner_bits, &inner_mode)
                        || inner_bits != bits || inner_mode != root_mode
                        || !peel_associative_arm(
                            plan, left, right, mutable_value,
                            bits, root_mode, &accumulator))
                    continue;
            }

            pl_u32 exact = (1u << destination)
                         | (1u << mutable_owner)
                         | (1u << sibling_owner);
            if ((changed & ((1u << PL_X86_GPR_COUNT) - 1u)) != exact)
                continue;
            *out = (shared_parent_frame){
                destination, mutable_owner, sibling_owner, bits,
                shift_group,
                mutable_owner == first ? first_mode : second_mode,
                sibling_owner == first ? first_mode : second_mode,
                root_mode, accumulator, shift_amount,
                mutable_owner == first ? first_right : second_right,
                sibling_owner == first ? first_right : second_right,
            };
            return 1;
        }
    }
    return 0;
}

int pl_select_measure_shared_parent_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, const shared_parent_frame *shape)
{
    if (!frontend || !block || !selection || !shape) return 0;
    pl_u32 bytes = 0u, work = 0u, part = 0u;
    int measured = pl_select_measure_alu_tree(
        frontend, block, selection, shape->destination,
        shape->accumulator, shape->bits, 0u,
        block->plan.node_count + 1u, 0u, &bytes, &work);
    if (measured <= 0) return measured;
#define MEASURE_SHARED_PARENT(operation_) do {                              \
        part = 0u;                                                          \
        if (!(operation_) || bytes > U32_MAX_VALUE - part                  \
                || work == U32_MAX_VALUE)                                  \
            return 0;                                                       \
        bytes += part;                                                      \
        ++work;                                                             \
    } while (0)
    MEASURE_SHARED_PARENT(pl_select_emit_shift_instruction(
        shape->mutable_owner, shape->parent_shift_amount,
        shape->bits, shape->parent_shift_group, 0, &part));
    MEASURE_SHARED_PARENT(pl_select_emit_gpr_move(
        shape->sibling_owner, shape->mutable_owner,
        shape->bits, 0, &part));
    MEASURE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->mutable_owner, shape->mutable_right,
        shape->bits, shape->mutable_mode, 0u, 0, &part));
    MEASURE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->sibling_owner, shape->sibling_right,
        shape->bits, shape->sibling_mode, 0u, 0, &part));
    pl_operand sibling = { PL_OPERAND_LOCAL, shape->sibling_owner };
    pl_operand mutable = { PL_OPERAND_LOCAL, shape->mutable_owner };
    MEASURE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->destination, sibling, shape->bits,
        shape->root_mode, 0u, 0, &part));
    MEASURE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->destination, mutable, shape->bits,
        shape->root_mode, 0u, 0, &part));
#undef MEASURE_SHARED_PARENT
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        int status = pl_select_append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + 1u, bytes + branch_bytes, block->successor[0]);
        if (status || bytes > U32_MAX_VALUE - branch_bytes) return status;
        bytes += branch_bytes;
        ++work;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_alu_frame = 1u;
    selection->direct_shared_parent_frame = 1u;
    selection->direct_nested_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* Old GPR -> flags and new GPR -> CMOV are distinct edges. When a comparison
 * reads a coordinate later occupied by a selected arm, emit the comparison
 * first, then flag-preserving arm publications, then CMOV. No old GPR copy or
 * Boolean materialization is needed. Both arms must have an acyclic copy
 * order, and every other old-generation reader must already have run. */
int pl_select_select_generation_group_shape(const pl_plan *plan, pl_u32 pending,
    pl_u32 protected_sources, select_generation_group *out)
{
    if (!plan || !out) return 0;
    for (pl_u32 destination = 0u; destination < PL_X86_GPR_COUNT; ++destination) {
        if (!(pending & (1u << destination))) continue;
        conditional_select select;
        standalone_flag_publication compare;
        if (!pl_select_conditional_select_details(plan, plan->locals[destination], destination, &select)
                || !select.has_compare || select.candidate_is_entry
                || select.candidate_local == destination
                || !(pending & (1u << select.candidate_local))
                || !pl_select_standalone_flag_publication_details(plan, select.compare_node, &compare)
                || (compare.owner_dependencies & pending)) continue;
        pl_u32 candidate = select.candidate_local;
        pl_u32 members = (1u << destination) | (1u << candidate);
        if (!(compare.entry_sources & members) || (protected_sources & members)) continue;
        pl_operand current = select.current, value = plan->locals[candidate];
        if ((current.kind != PL_OPERAND_CONST && current.kind != PL_OPERAND_LOCAL)
                || (value.kind != PL_OPERAND_CONST && value.kind != PL_OPERAND_LOCAL)) continue;
        if ((current.kind == PL_OPERAND_LOCAL && current.value >= PL_X86_GPR_COUNT)
                || (value.kind == PL_OPERAND_LOCAL && value.value >= PL_X86_GPR_COUNT)) continue;
        pl_u32 current_sources = current.kind == PL_OPERAND_LOCAL ? 1u << current.value : 0u;
        pl_u32 candidate_sources = value.kind == PL_OPERAND_LOCAL ? 1u << value.value : 0u;
        int first_candidate = !(current_sources & (1u << candidate));
        if (!first_candidate && (candidate_sources & (1u << destination))) continue;
        int blocked = 0;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local)) || (members & (1u << local))) continue;
            pl_operand other = plan->locals[local];
            if (pl_select_equal_operand(other, plan->locals[destination])) continue;
            /* A pending non-leaf may observe entry flags or either old GPR.
             * Let its ordinary scheduler discharge those obligations first. */
            if (other.kind != PL_OPERAND_CONST
                    && (other.kind != PL_OPERAND_LOCAL || (members & (1u << other.value))))
                blocked = 1;
        }
        if (blocked) continue;
        *out = (select_generation_group){ select, compare, destination, members,
            first_candidate ? candidate : destination };
        return 1;
    }
    return 0;
}

/* Measurement and emission replay the same three phases. Fixup ownership
 * stays in the ordinary seed generator, including projected RIP addresses. */
int pl_select_measure_select_generation_group(const pl_x86_frontend *frontend,
    const pl_x86_block *block, pl_x86_native_selection *selection,
    const select_generation_group *shape, pl_u32 output_at, pl_u32 *bytes, pl_u32 *work)
{
    pl_u32 at = 0u, count = 1u, part = 0u;
    if (!pl_select_emit_standalone_flag_publication(&shape->compare, 0, &at)) return 0;
    for (pl_u32 index = 0u; index < 2u; ++index) {
        pl_u32 local = index ? (shape->first == shape->destination
            ? shape->select.candidate_local : shape->destination) : shape->first;
        pl_operand value = local == shape->destination
            ? shape->select.current : block->plan.locals[local];
        pl_u32 instructions = 0u;
        pl_u32 bits = local == shape->destination ? shape->select.value_bits : 64u;
        if (output_at > U32_MAX_VALUE - at) return PL_ERROR_X86_SELECT;
        int status = pl_select_measure_alu_seed(frontend, block, selection, local, value, bits,
            output_at + at, block->plan.node_count + 1u, &part, &instructions);
        if (status <= 0 || at > U32_MAX_VALUE - part || count > U32_MAX_VALUE - instructions)
            return status < 0 ? status : 0;
        at += part; count += instructions;
    }
    if (!pl_select_emit_conditional_move(shape->destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition, 0, &part)
            || at > U32_MAX_VALUE - part || count == U32_MAX_VALUE) return 0;
    *bytes = at + part; *work = count + 1u;
    return 1;
}

int pl_select_write_select_generation_group(const pl_x86_block *block,
    const pl_x86_native_selection *selection, const select_generation_group *shape,
    pl_u32 output_at, pl_u8 *output, pl_u32 *written)
{
    pl_u32 at = 0u, part = 0u;
    if (!pl_select_emit_standalone_flag_publication(&shape->compare, output, &at)) return 0;
    for (pl_u32 index = 0u; index < 2u; ++index) {
        pl_u32 local = index ? (shape->first == shape->destination
            ? shape->select.candidate_local : shape->destination) : shape->first;
        pl_operand value = local == shape->destination
            ? shape->select.current : block->plan.locals[local];
        pl_u32 bits = local == shape->destination ? shape->select.value_bits : 64u;
        if (!pl_select_write_alu_seed(block, selection, local, value, bits, output_at + at,
                block->plan.node_count + 1u, output + at, &part)) return 0;
        at += part;
    }
    if (!pl_select_emit_conditional_move(shape->destination, shape->select.candidate_local,
            shape->select.value_bits, shape->select.condition, output + at, &part)) return 0;
    *written = at + part;
    return 1;
}

/* A branch observing the published flag word adds one control edge, not a
 * different value grammar. Compile the same complete frame, then attach Jcc.
 * The source extent remains intact for address-field relocation. */
int pl_select_conditional_alu_body(const pl_x86_block *block,
                                 pl_x86_block *body, pl_u32 *condition)
{
    if (!block || !body || !condition || block->flow != PL_X86_FLOW_CONDITIONAL
            || !block->has_predicate || block->successor_count != 2u
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->predicate.kind != PL_OPERAND_PROJECTION
            || (block->predicate.value & 0xffu) >= 16u) return 0;
    pl_operand flags = block->plan.locals[PL_X86_RFLAGS_LOCAL];
    if (flags.kind != PL_OPERAND_NODE || !flags.value
            || flags.value > block->plan.node_count
            || (block->predicate.value >> 8u) != flags.value) return 0;
    *condition = (pl_u32)block->predicate.value & 0xffu;
    *body = *block;
    body->flow = PL_X86_FLOW_NEXT;
    body->has_predicate = 0u;
    body->predicate = (pl_operand){ PL_OPERAND_CONST, 0u };
    body->successor_count = 1u;
    body->successor[0] = block->successor[1];
    return 1;
}

/* A CMP/TEST replaces every arithmetic condition flag and preserves DF/IF and
 * the other system lanes.  An intermediate flag word that only perturbs the
 * overwritten arithmetic lanes may therefore be dropped without emitting it.
 * This is exact only when the intermediate's own operation leaves every
 * preserved lane alone, so the walk accepts lane AND/OR/XOR immediates whose
 * mask cannot change a non-arithmetic bit and terminates at entry RFLAGS. */
int pl_select_flags_root_only_arithmetic(const pl_plan *plan, pl_u32 node_number)
{
    if (!plan) return 0;
    const pl_u64 arithmetic = (1ull << 0u) | (1ull << 2u) | (1ull << 4u)
                            | (1ull << 6u) | (1ull << 7u) | (1ull << 11u);
    for (pl_u32 step = 0u;
            node_number && node_number <= plan->node_count
                && step <= plan->node_count;
            ++step) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        if (node->argument_count != 2u
                || node->argument_at > plan->argument_count
                || 2u > plan->argument_count - node->argument_at)
            return 0;
        pl_u32 lane = 2u, semantic = 5u;
        for (pl_u32 candidate = 0u; candidate < 2u; ++candidate)
            for (pl_u32 meaning = 0u; meaning < 5u; ++meaning)
                if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[candidate][meaning]) {
                    lane = candidate;
                    semantic = meaning;
                }
        if (lane == 2u) return 0;
        const pl_operand *argument = plan->arguments + node->argument_at;
        if (argument[1].kind != PL_OPERAND_CONST) return 0;
        const pl_u64 word = lane == 1u ? ~0ull : 0xffffffffull;
        pl_u64 mask = argument[1].value & word;
        pl_u64 harmed = 0u;
        if (semantic == 0u)
            harmed = (~mask) & ~arithmetic & word;
        else if (semantic == 3u || semantic == 4u)
            harmed = mask & ~arithmetic & word;
        else
            return 0;
        if (harmed) return 0;
        pl_operand left = argument[0];
        if (left.kind == PL_OPERAND_LOCAL && left.value == PL_X86_RFLAGS_LOCAL)
            return 1;
        if (left.kind != PL_OPERAND_NODE || !left.value
                || left.value >= node_number)
            return 0;
        node_number = (pl_u32)left.value;
    }
    return 0;
}

int pl_select_flag_value_preload_shape(
    const pl_plan *plan, pl_u32 pending, pl_u32 final_flag_node,
    const pl_u32 frame_sources[PL_X86_GPR_COUNT],
    const pl_u32 frame_dependencies[PL_X86_GPR_COUNT],
    flag_value_preload *out)
{
    if (!plan || !out || !final_flag_node) return 0;
    pl_operand result, prior, left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!pl_select_flag_result_operand(plan, final_flag_node, &result, &prior)
            || !pl_select_flag_operation_details(
                plan, (pl_operand){ PL_OPERAND_NODE, final_flag_node },
                &left, &right, &bits, &mode, &preserves_carry))
        return 0;
    pl_u32 destination = pl_select_publication_owner(plan, result);
    pl_operand tree = left, other = right;
    if (tree.kind == PL_OPERAND_LOCAL && other.kind == PL_OPERAND_CONST) {
        /* The flag operation combines an entry register with an immediate and
         * another pending publication overwrites that register: preload it with
         * a copy before the clobber, then apply the immediate last. */
    } else if (tree.kind == PL_OPERAND_LOCAL
            || tree.kind == PL_OPERAND_CONST) {
        pl_operand swap = tree;
        tree = other;
        other = swap;
    }
    if ((tree.kind != PL_OPERAND_NODE && tree.kind != PL_OPERAND_PROJECTION
                && tree.kind != PL_OPERAND_LOCAL)
            || destination >= PL_X86_GPR_COUNT
            || !(pending & (1u << destination))
            || (frame_dependencies[destination] & pending))
        return 0;
    pl_u32 others_read = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        if (local != destination && (pending & (1u << local)))
            others_read |= frame_sources[local];
    if (others_read & (1u << destination)) return 0;
    if (other.kind == PL_OPERAND_LOCAL
            && pl_select_frame_local_publication_clobbers_flags(
                plan, (pl_u32)other.value))
        return 0;
    pl_u32 tree_sources = 0u;
    if (!pl_select_operand_entry_gpr_sources(plan, tree, plan->node_count + 1u,
            plan->node_count + 1u, &tree_sources)
            || !(tree_sources & pending))
        return 0;
    if (tree_sources & (other.kind == PL_OPERAND_LOCAL
            ? (1u << (pl_u32)other.value) : 0u))
        return 0;
    pl_u32 tree_bits = pl_select_operand_expression_bits(plan, tree, 64u);
    if (!tree_bits) return 0;
    /* Preloading is an emission, not a flag-free scheduling annotation.
     * Leave a clobbering tree to the regular scheduler until every entry-
     * flag reader is published. The same shape governs measure and write. */
    if (pl_select_pending_entry_flag_readers(plan, pending)
            && pl_select_publication_tree_clobbers_flags(plan, tree, destination))
        return 0;
    pl_u32 scratch = pl_select_alu_frame_scratch_mask(pending, destination, frame_sources);
    if (other.kind == PL_OPERAND_LOCAL)
        scratch &= ~(1u << (pl_u32)other.value);
    *out = (flag_value_preload){
        destination, tree, tree_bits, scratch,
        other.kind == PL_OPERAND_LOCAL ? (1u << (pl_u32)other.value) : 0u,
    };
    return 1;
}

/* Classify a pending publication as a unary consumer of an unpublished node:
 * a lane shift, or an architectural ALU pair over a constant whose flags may
 * be the final observable ones. */
static int shared_root_consumer_of(const pl_plan *plan, pl_u32 local,
                                   pl_u32 final_flag_node,
                                   shared_root_consumer *out)
{
    if (!plan || !out || local >= PL_X86_GPR_COUNT) return 0;
    pl_operand value = plan->locals[local];
    pl_operand source, amount;
    pl_u32 bits = 0u, group = 0u;
    if (pl_select_shift_node_details(plan, value, &source, &amount, &bits, &group)
            && source.kind == PL_OPERAND_NODE && source.value
            && source.value <= plan->node_count) {
        *out = (shared_root_consumer){ local, 0, source, bits,
                                       amount, group, { 0 }, 0u, 0u, 0 };
        return 1;
    }
    if (value.kind == PL_OPERAND_PROJECTION && (value.value & 0xffu) == 16u) {
        pl_u32 node_number = (pl_u32)(value.value >> 8u);
        pl_operand left, right;
        pl_u32 alu_bits = 0u, mode = 0u, preserves_carry = 0u;
        if (!node_number || node_number > plan->node_count
                || !pl_select_alu_node_semantics(plan, node_number, &left, &right,
                       &alu_bits, &mode, &preserves_carry))
            return 0;
        if (left.kind == PL_OPERAND_CONST && pl_select_associative_mode(mode)) {
            pl_operand swap = left; left = right; right = swap;
        }
        if (left.kind != PL_OPERAND_NODE || !left.value
                || left.value > plan->node_count
                || right.kind != PL_OPERAND_CONST)
            return 0;
        *out = (shared_root_consumer){ local, 1, left, alu_bits,
                                       { 0 }, 0u, right, mode, preserves_carry,
                                       node_number == final_flag_node };
        return 1;
    }
    return 0;
}

/* Two pending publications that apply a unary operation to the same
 * unpublished root whose operand tree reads the entry values of both
 * destinations:
 *
 *   D1 = op1(seed)   D2 = op2(seed)   seed reads entry D1 and entry D2
 *
 * The ordinary scheduler deadlocks (each destination overwrites a coordinate
 * the root reads), yet the source evaluates the root once, copies it, and
 * applies each operation.  The flag-producing consumer, when present, is
 * applied last. */
int pl_select_shared_root_unary_handoff_shape(const pl_plan *plan, pl_u32 pending,
                                           pl_u32 final_flag_node,
                                           shared_root_unary_handoff *out)
{
    if (!plan || !pending || !out) return 0;
    for (pl_u32 a = 0u; a < PL_X86_GPR_COUNT; ++a) {
        if (!(pending & (1u << a))) continue;
        shared_root_consumer first;
        if (!shared_root_consumer_of(plan, a, final_flag_node, &first))
            continue;
        for (pl_u32 b = a + 1u; b < PL_X86_GPR_COUNT; ++b) {
            if (!(pending & (1u << b))) continue;
            shared_root_consumer second;
            if (!shared_root_consumer_of(plan, b, final_flag_node, &second))
                continue;
            if (first.seed.kind != second.seed.kind
                    || first.seed.value != second.seed.value
                    || first.bits != second.bits)
                continue;
            if (pl_select_publication_owner(plan, first.seed) < PL_X86_GPR_COUNT)
                continue;
            pl_u32 seed_sources = 0u;
            if (!pl_select_operand_gpr_sources(plan, first.seed, plan->node_count + 1u,
                    plan->node_count + 1u, &seed_sources)
                    || !(seed_sources & (1u << a))
                    || !(seed_sources & (1u << b)))
                continue;
            if (first.is_flag && second.is_flag) continue;
            pl_u32 seed_dest = a, copy_dest = b;
            if (first.is_flag) { seed_dest = b; copy_dest = a; }
            out->seed = first.seed;
            out->seed_bits = first.bits;
            out->seed_dest = seed_dest;
            out->copy_dest = copy_dest;
            out->bits = first.bits;
            out->dest_consumer = seed_dest == a ? first : second;
            out->copy_consumer = seed_dest == a ? second : first;
            return 1;
        }
    }
    return 0;
}

int pl_select_emit_shared_root_consumer(const shared_root_consumer *consumer,
                                     pl_u8 *output, pl_u32 *written)
{
    if (!consumer || !written) return 0;
    if (consumer->is_alu)
        return pl_select_emit_alu_instruction(consumer->local, consumer->right,
            consumer->bits, consumer->mode, consumer->preserves_carry,
            output, written);
    return pl_select_emit_shift_instruction(consumer->local, consumer->amount,
        consumer->bits, consumer->group, output, written);
}

/* The comparison consumes an entry generation that a constant publication
 * replaces; CMOV consumes the published candidate generation. Emit the tree
 * and comparison before either constant publication. MOV and CMOV preserve
 * the final comparison flags, so this order keeps both generations exact. */
static int compare_tree_select_frame_shape(
    const pl_x86_block *block, compare_tree_select_frame *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && (block->dynamic_target || block->successor_count != 1u))
            || block->construction_fields || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 changed = 0u, final_flag_node = 0u;
    if (!pl_select_alu_frame_shape(plan, &changed, &final_flag_node)
            || !final_flag_node || final_flag_node > plan->node_count)
        return 0;
    const pl_node *flag = &plan->nodes[final_flag_node - 1u];
    if (flag->opcode != PL_OPCODE_X86_COMPARE
            && flag->opcode != PL_OPCODE_X86_TEST)
        return 0;
    for (pl_u32 destination = 0u;
            destination < PL_X86_GPR_COUNT; ++destination) {
        if (!(changed & (1u << destination))) continue;
        conditional_select select;
        if (!pl_select_conditional_select_details_inner(
                plan, plan->locals[destination], destination, 1, &select)
                || !select.has_compare
                || select.compare_node != final_flag_node
                || !select.compare_left_seed || select.compare_right_seed
                || select.compare_offset
                || select.current.kind != PL_OPERAND_CONST
                || select.candidate_is_entry || select.candidate_immediate
                || select.candidate_local >= PL_X86_GPR_COUNT
                || select.candidate_local == destination
                || plan->locals[select.candidate_local].kind
                   != PL_OPERAND_CONST
                || changed != ((1u << destination)
                    | (1u << select.candidate_local))
                || select.compare_right.kind != PL_OPERAND_CONST
                || (select.compare_bits != 32u
                    && select.compare_bits != 64u)
                || (select.value_bits != 32u
                    && select.value_bits != 64u))
            continue;
        pl_u32 sources = 0u;
        if (!pl_select_operand_gpr_sources(
                plan, select.compare_left_value,
                plan->node_count + 1u, plan->node_count + 1u, &sources)
                || !(sources & changed)
                || ((sources & changed) != (1u << destination)
                    && (sources & changed)
                       != (1u << select.candidate_local)))
            continue;
        pl_u32 owner = (sources & (1u << destination))
                     ? destination : select.candidate_local;
        *out = (compare_tree_select_frame){
            destination, select.candidate_local, owner, select.value_bits,
            select.compare_bits, select.condition, select.compare_test,
            select.current, select.compare_left_value,
            select.compare_right,
        };
        return 1;
    }
    return 0;
}

int pl_select_measure_direct_compare_tree_select_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    compare_tree_select_frame shape;
    if (!compare_tree_select_frame_shape(block, &shape)) return 0;
    pl_u32 bytes = 0u, instructions = 0u, part = 0u, work = 0u;
    int measured = pl_select_measure_alu_tree(
        frontend, block, selection, shape.compare_owner, shape.tree,
        shape.compare_bits, bytes, block->plan.node_count + 1u,
        0u, &part, &work);
    if (measured <= 0 || bytes > U32_MAX_VALUE - part
            || instructions > U32_MAX_VALUE - work)
        return measured < 0 ? measured : 0;
    bytes += part;
    instructions += work;
    if (!pl_select_emit_flag_coordinate(
            shape.compare_owner, shape.right, shape.compare_bits,
            shape.test, 0u, (pl_u8 *)0, &part)
            || bytes > U32_MAX_VALUE - part)
        return 0;
    bytes += part;
    ++instructions;
    measured = pl_select_measure_frame_value(
        frontend, block, selection, shape.destination, shape.current,
        bytes, &part);
    if (measured <= 0 || bytes > U32_MAX_VALUE - part)
        return measured < 0 ? measured : 0;
    bytes += part;
    ++instructions;
    measured = pl_select_measure_frame_value(
        frontend, block, selection, shape.candidate,
        block->plan.locals[shape.candidate], bytes, &part);
    if (measured <= 0 || bytes > U32_MAX_VALUE - part)
        return measured < 0 ? measured : 0;
    bytes += part;
    ++instructions;
    if (!pl_select_emit_conditional_move(
            shape.destination, shape.candidate, shape.value_bits,
            shape.condition, (pl_u8 *)0, &part)
            || bytes > U32_MAX_VALUE - part)
        return 0;
    bytes += part;
    ++instructions;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (bytes > U32_MAX_VALUE - branch_bytes) return PL_ERROR_X86_SELECT;
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
    selection->direct_compare_tree_select_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int operand_reads_published_shift(const pl_plan *plan,
                                         pl_operand value, pl_u32 output_local,
                                         const pl_u8 *shift_owner,
                                         pl_u8 *seen, pl_u32 remaining)
{
    if (!remaining) return 1;
    pl_u32 number = value.kind == PL_OPERAND_NODE
                  ? (pl_u32)value.value
                  : value.kind == PL_OPERAND_PROJECTION
                  ? (pl_u32)(value.value >> 8u) : 0u;
    if (!number) return 0;
    if (number > plan->node_count) return 1;
    if (shift_owner[number] < PL_X86_GPR_COUNT
            && shift_owner[number] != output_local)
        return 1;
    if (seen[number]) return 0;
    seen[number] = 1u;
    const pl_node *node = &plan->nodes[number - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count > plan->argument_count - node->argument_at)
        return 1;
    for (pl_u32 argument = 0u; argument < node->argument_count; ++argument)
        if (operand_reads_published_shift(
                plan, plan->arguments[node->argument_at + argument],
                output_local, shift_owner, seen, remaining - 1u))
            return 1;
    return 0;
}

int pl_select_published_shift_generation_conflict(const pl_plan *plan)
{
    if (!plan || plan->node_count > 96u) return 0;
    pl_u8 shift_owner[97];
    for (pl_u32 number = 0u; number <= plan->node_count; ++number)
        shift_owner[number] = PL_X86_GPR_COUNT;
    int has_shift = 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand published = plan->locals[local];
        pl_operand source, amount;
        pl_u32 bits = 0u, group = 0u;
        if (published.kind != PL_OPERAND_NODE || !published.value
                || published.value > plan->node_count
                || !pl_select_shift_node_details(
                    plan, published, &source, &amount, &bits, &group)
                || group != 4u || amount.kind != PL_OPERAND_CONST
                || !amount.value || amount.value > 3u
                || source.kind != PL_OPERAND_LOCAL
                || source.value != local)
            continue;
        shift_owner[published.value] = (pl_u8)local;
        has_shift = 1;
    }
    if (!has_shift) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand published = plan->locals[local];
        if (published.kind == PL_OPERAND_LOCAL && published.value == local)
            continue;
        pl_u8 seen[97] = { 0 };
        if (operand_reads_published_shift(
                plan, published, local, shift_owner, seen,
                plan->node_count + 1u))
            return 1;
    }
    return 0;
}

int pl_select_shift_count_requires_published_rcx(const pl_plan *plan)
{
    if (!plan) return 0;
    for (pl_u32 number = 1u; number <= plan->node_count; ++number) {
        pl_operand shift = { PL_OPERAND_NODE, number };
        pl_operand source, amount;
        pl_u32 bits = 0u, group = 0u;
        if (!pl_select_shift_node_details(
                plan, shift, &source, &amount, &bits, &group)
                || amount.kind != PL_OPERAND_LOCAL || amount.value != 1u)
            continue;
        const pl_node *node = &plan->nodes[number - 1u];
        pl_operand raw = plan->arguments[node->argument_at + 1u];
        if (raw.kind != PL_OPERAND_NODE || !raw.value
                || raw.value > plan->node_count)
            continue;
        const pl_node *bound = &plan->nodes[raw.value - 1u];
        const pl_operand *argument = plan->arguments + bound->argument_at;
        pl_operand count = argument[0].kind == PL_OPERAND_CONST
                         ? argument[1] : argument[0];
        if (count.kind != PL_OPERAND_LOCAL
                && pl_select_publication_owner(plan, count) == 1u)
            return 1;
    }
    return 0;
}

static pl_u32 entry_dependencies(const pl_plan *plan, pl_operand value,
                                 pl_u32 *memo, pl_u8 *state)
{
    if (value.kind == PL_OPERAND_LOCAL)
        return value.value < PL_X86_GPR_COUNT
             ? 1u << value.value : 0u;
    if (value.kind != PL_OPERAND_NODE
            && value.kind != PL_OPERAND_PROJECTION)
        return 0u;
    pl_u64 number = value.kind == PL_OPERAND_NODE
                  ? value.value : value.value >> 8u;
    if (!number || number > plan->node_count) return U32_MAX_VALUE;
    pl_u32 index = (pl_u32)number - 1u;
    if (state[index] == 2u) return memo[index];
    if (state[index] == 1u) return U32_MAX_VALUE;
    const pl_node *node = &plan->nodes[index];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return U32_MAX_VALUE;
    state[index] = 1u;
    pl_u32 dependencies = 0u;
    for (pl_u32 argument = 0u;
            argument < node->argument_count; ++argument)
        dependencies |= entry_dependencies(
            plan, plan->arguments[node->argument_at + argument],
            memo, state);
    state[index] = 2u;
    memo[index] = dependencies;
    return dependencies;
}

int pl_select_shared_alu_result_overwrites_entry(const pl_plan *plan,
                                              pl_u32 final_flag_node)
{
    if (!plan || !final_flag_node || final_flag_node > plan->node_count
            || plan->node_count > 96u) return 0;
    const pl_node *node = &plan->nodes[final_flag_node - 1u];
    if (node->opcode != PL_OPCODE_X86_ALU
            && node->opcode != PL_OPCODE_X86_FLAGS) return 0;
    pl_u32 owners = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_PROJECTION
                && value.value >> 8u == final_flag_node
                && (value.value & 0xffu) == 16u)
            owners |= 1u << local;
    }
    if (!(owners & (owners - 1u))) return 0;
    if (node->argument_count < 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    pl_u32 memo[96] = { 0 };
    pl_u8 state[96] = { 0 };
    pl_u32 left = entry_dependencies(
        plan, plan->arguments[node->argument_at + 1u], memo, state);
    pl_u32 right = entry_dependencies(
        plan, plan->arguments[node->argument_at + 2u], memo, state);
    /* The left tree is emitted first. If its inputs are from a different
     * entry generation, publishing that tree into a result owner would
     * destroy the right tree's still-live entry value. */
    return !!(right & owners) && !!(left & ~right);
}

int pl_select_independent_entry_flags_subtract_conflict(const pl_plan *plan,
                                                     pl_u32 final_flag_node)
{
    if (!plan || !final_flag_node || final_flag_node > plan->node_count
            || plan->node_count > 96u) return 0;
    const pl_node *flags = &plan->nodes[final_flag_node - 1u];
    if (flags->opcode != PL_OPCODE_X86_TEST) return 0;
    if (flags->argument_count < 3u
            || flags->argument_at > plan->argument_count
            || flags->argument_count
               > plan->argument_count - flags->argument_at) return 0;
    pl_u32 memo[96] = { 0 };
    pl_u8 state[96] = { 0 };
    pl_u32 flag_inputs = 0u;
    for (pl_u32 argument = 1u; argument < 3u; ++argument)
        flag_inputs |= entry_dependencies(plan,
            plan->arguments[flags->argument_at + argument], memo, state);
    flag_inputs &= (1u << PL_X86_GPR_COUNT) - 1u;
    if (!flag_inputs) return 0;
    int shared_value = 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind != PL_OPERAND_NODE
                && value.kind != PL_OPERAND_PROJECTION) continue;
        if (flag_inputs & entry_dependencies(plan, value, memo, state))
            shared_value = 1;
    }
    if (!shared_value) return 0;
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        const pl_node *node = &plan->nodes[index];
        int subtraction = node->opcode == PL_OPCODE_ALU_REGISTER[0][2]
                       || node->opcode == PL_OPCODE_ALU_REGISTER[1][2];
        if (!subtraction || !node->argument_count
                || node->argument_at >= plan->argument_count) continue;
        if (flag_inputs & entry_dependencies(plan,
                plan->arguments[node->argument_at], memo, state))
            return 1;
    }
    return 0;
}

static pl_operand select_flag_source(const pl_plan *plan,
                                     pl_operand condition)
{
    if (condition.kind == PL_OPERAND_PROJECTION) {
        pl_u64 node = condition.value >> 8u;
        if (node && node <= plan->node_count)
            return (pl_operand){ PL_OPERAND_NODE, node };
    }
    if (condition.kind == PL_OPERAND_NODE && condition.value
            && condition.value <= plan->node_count) {
        const pl_node *node = &plan->nodes[condition.value - 1u];
        if (node->opcode == PL_OPCODE_X86_CONDITION
                && node->argument_count == 2u
                && node->argument_at <= plan->argument_count
                && node->argument_count
                   <= plan->argument_count - node->argument_at)
            return plan->arguments[node->argument_at];
    }
    return condition;
}

int pl_select_mixed_entry_and_produced_select_flags(const pl_plan *plan)
{
    int entry_select = 0;
    int produced_select = 0;
    for (pl_u32 index = 0u; index < plan->node_count; ++index) {
        const pl_node *node = &plan->nodes[index];
        if ((node->opcode != PL_OPCODE_LANE32_SELECT
                    && node->opcode != PL_OPCODE_LANE64_SELECT)
                || node->argument_count != 3u
                || node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            continue;
        pl_operand condition = plan->arguments[node->argument_at + 2u];
        if (condition.kind == PL_OPERAND_CONST) continue;
        pl_operand source = select_flag_source(plan, condition);
        if (source.kind == PL_OPERAND_LOCAL
                && source.value == PL_X86_RFLAGS_LOCAL)
            entry_select = 1;
        else
            produced_select = 1;
        if (entry_select && produced_select) return 1;
    }
    return 0;
}

int pl_select_write_direct_compare_tree_select_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    pl_u8 *output)
{
    if (!block || !selection || !output
            || !selection->direct_compare_tree_select_frame)
        return PL_ERROR_X86_SELECT;
    compare_tree_select_frame shape;
    if (!compare_tree_select_frame_shape(block, &shape))
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, written = 0u;
    if (!pl_select_write_alu_tree(
                block, selection, shape.compare_owner, shape.tree,
                shape.compare_bits, at, block->plan.node_count + 1u,
                0u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_emit_flag_coordinate(
                shape.compare_owner, shape.right, shape.compare_bits,
                shape.test, 0u, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_write_frame_value(
                selection, at, shape.destination, shape.current,
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_write_frame_value(
                selection, at, shape.candidate,
                block->plan.locals[shape.candidate],
                output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (at > selection->output_bytes
            || !pl_select_emit_conditional_move(
                shape.destination, shape.candidate, shape.value_bits,
                shape.condition, output + at, &written))
        return PL_ERROR_X86_SELECT;
    at += written;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = block->relax_short_control ? 5u : 2u;
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
        while (at < selection->output_bytes) output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}
