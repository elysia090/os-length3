/* operands: native x86 selection. */
#include "operands.h"
#include "limits.h"
#include "expressions.h"
#include "state-frame.h"

typedef struct {
    pl_u32 node_sources;
    pl_u32 node_depth;
    pl_u32 projection_sources;
    pl_u32 projection_depth;
} gpr_source_row;

static int gpr_source_operand_law(
    const pl_plan *plan, pl_operand operand, pl_u32 available_nodes,
    const gpr_source_row *row, pl_u32 *sources, pl_u32 *depth);

static int operand_source_law(const pl_plan *plan, pl_operand operand,
                              const pl_u32 *node_law,
                              pl_u32 available_nodes,
                              int substitute_publication,
                              pl_u32 *law);

static int native_argument_uses_publication(
    const pl_plan *plan, const pl_node *node, pl_u32 argument);

static pl_u32 add3_published_pair_dependencies(
    const pl_plan *plan, const pl_node *node, pl_u32 node_number);

int pl_select_alu_node_semantics(const pl_plan *plan, pl_u32 node_number,
                              pl_operand *source, pl_operand *right,
                              pl_u32 *bits, pl_u32 *mode,
                              pl_u32 *preserves_carry)
{
    if (!plan || !node_number || node_number > plan->node_count
            || !source || !right || !bits || !mode
            || !preserves_carry)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_X86_ALU || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value != PL_X86_RFLAGS_LOCAL
            || (arguments[1].kind != PL_OPERAND_CONST
                && (arguments[1].kind != PL_OPERAND_LOCAL
                    || arguments[1].value >= PL_X86_GPR_COUNT)
                && (arguments[1].kind != PL_OPERAND_NODE
                    || !arguments[1].value
                    || arguments[1].value >= node_number))
            || (arguments[2].kind != PL_OPERAND_CONST
                && (arguments[2].kind != PL_OPERAND_LOCAL
                    || arguments[2].value >= PL_X86_GPR_COUNT)
                && (arguments[2].kind != PL_OPERAND_NODE
                    || !arguments[2].value
                    || arguments[2].value >= node_number)
                && (arguments[2].kind != PL_OPERAND_PROJECTION
                    || !(arguments[2].value >> 8u)
                    || (arguments[2].value >> 8u) >= node_number))
            || arguments[3].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = arguments[3].value;
    *bits = (pl_u32)(descriptor & 0x7fu);
    *mode = (pl_u32)((descriptor >> 8u) & 7u);
    *preserves_carry = (pl_u32)((descriptor >> 11u) & 1u);
    if ((*bits != 32u && *bits != 64u) || *mode > 6u
            || descriptor
               != ((pl_u64)*bits | ((pl_u64)*mode << 8u)
                   | ((pl_u64)*preserves_carry << 11u)))
        return 0;
    *source = arguments[1];
    *right = arguments[2];
    return 1;
}

int pl_select_alu_node_details(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *destination, pl_operand *source,
                            pl_operand *right,
                            pl_u32 *bits, pl_u32 *mode,
                            pl_u32 *preserves_carry)
{
    if (!destination || !pl_select_alu_node_semantics(
            plan, node_number, source, right,
            bits, mode, preserves_carry))
        return 0;
    pl_operand result = {
        PL_OPERAND_PROJECTION, ((pl_u64)node_number << 8u) | 16u,
    };
    *destination = pl_select_publication_owner(plan, result);
    return *destination < PL_X86_GPR_COUNT;
}

int pl_select_zero_extend_node(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_LANE64_INSERT
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_CONST || arguments[0].value
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    if (arguments[1].kind == PL_OPERAND_LOCAL
            && arguments[1].value < PL_X86_GPR_COUNT) {
        *source = (pl_u32)arguments[1].value;
    } else if ((arguments[1].kind == PL_OPERAND_NODE
                || arguments[1].kind == PL_OPERAND_PROJECTION)
            && pl_select_published_operand_local(plan, arguments[1], source)) {
        /* The inner node already has one architectural owner.  Reading that
         * owner is the exact physical projection; rebuilding the subtree
         * would add both work and a false dependency wave. */
    } else {
        return 0;
    }
    *bits = (pl_u32)arguments[2].value;
    return 1;
}

/* `insert(0, inner, width)` is a pure lane extension: the result is the low
 * `width` bits of `inner`, zero-extended.  Unlike pl_select_zero_extend_node this
 * returns the inserted operand whatever its kind, so a caller can materialize
 * an inner value that has no publication yet. */
int pl_select_zero_extend_operand(const pl_plan *plan, pl_u32 node_number,
                               pl_operand *inner, pl_u32 *width)
{
    if (!plan || !inner || !width || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if ((node->opcode != PL_OPCODE_LANE64_INSERT
                && node->opcode != PL_OPCODE_LANE32_INSERT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_CONST || arguments[0].value
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    *inner = arguments[1];
    *width = (pl_u32)arguments[2].value;
    return 1;
}

int pl_select_sign_extend_value(const pl_plan *plan, pl_u32 node_number,
                             pl_operand *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    *bits = node->opcode == PL_OPCODE_LANE64_EXTEND8_S ? 8u
          : node->opcode == PL_OPCODE_LANE64_EXTEND16_S ? 16u
          : node->opcode == PL_OPCODE_EXTEND32_S ? 32u : 0u;
    if (!*bits || node->argument_count != 1u
            || node->argument_at >= plan->argument_count)
        return 0;
    *source = plan->arguments[node->argument_at];
    return 1;
}

/* lane{32,64}.and(x, all_ones) is the identity on that lane: the low word is
 * unchanged and the lane's own width already zero-extends.  A 32-bit mask over
 * an arbitrary 64-bit base is only redundant when the publication is emitted
 * at the same 32-bit width (an ordinary 32-bit register move zero-extends);
 * the frame therefore drops the mask only for a lane-width publication whose
 * destination move already performs the narrowing. */
int pl_select_lane_identity_mask_details(const pl_plan *plan, pl_operand value,
                                      pl_operand *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    pl_u64 mask = 0u;
    if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[0][0]) {
        mask = 0xffffffffull;
        *bits = 32u;
    } else if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[1][0]
            || node->opcode == PL_OPCODE_ALU_REGISTER[1][0]) {
        /* A lane64 register AND whose second operand is a full-mask constant
         * is the same lane identity as the immediate spelling. */
        mask = U64_MAX_VALUE;
        *bits = 64u;
    } else {
        return 0;
    }
    if (node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[1].kind != PL_OPERAND_CONST || arguments[1].value != mask)
        return 0;
    /* Keep the rewrite total: only a register-resident base is guaranteed to
     * materialize at the lane width without another production's help. */
    if (arguments[0].kind != PL_OPERAND_LOCAL
            || arguments[0].value >= PL_X86_GPR_COUNT) {
        return 0;
    }
    *source = arguments[0];
    return 1;
}

int pl_select_sign_extend_node(const pl_plan *plan, pl_u32 node_number,
                            pl_u32 *source, pl_u32 *bits)
{
    pl_operand argument;
    if (!source || !pl_select_sign_extend_value(plan, node_number, &argument, bits))
        return 0;
    if (argument.kind != PL_OPERAND_LOCAL
            || argument.value >= PL_X86_GPR_COUNT)
        return 0;
    *source = (pl_u32)argument.value;
    return 1;
}

/* One dense arithmetic frame may publish several mutually independent SSA
 * nodes.  Pure nodes whose x86 flags are dead use the same publication
 * grammar as architectural ALU nodes; requiring an RFLAGS result here would
 * reopen the exact source spelling at every memory/control cut.
 * Their logical inputs are versioned entry locals, so textual x86 order is
 * only a register-allocation constraint.  Every live result must have one
 * architectural GPR projection; the final flag node is recorded separately
 * so dead intermediate flags never impose a false dependency wave. */
/* `cmp X,imm; ...; adc/sbb D,imm` keeps the comparison as the ALU's
 * prior-flags operand instead of the entry RFLAGS local.  The comparison must
 * be emitted first so its carry is live; `pl_select_carry_alu_group_shape` owns that
 * spelling.  This predicate only lets `pl_select_alu_frame_shape` admit the node. */
int pl_select_alu_carry_prior_node(const pl_plan *plan, pl_u32 node_number,
                                pl_u32 *prior)
{
    if (!plan || !node_number || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_X86_ALU || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[0].kind != PL_OPERAND_NODE || !argument[0].value
            || argument[0].value >= node_number)
        return 0;
    const pl_node *compare = &plan->nodes[argument[0].value - 1u];
    if (compare->opcode != PL_OPCODE_X86_COMPARE
            && compare->opcode != PL_OPCODE_X86_TEST)
        return 0;
    int left_ok = argument[1].kind == PL_OPERAND_CONST
        || (argument[1].kind == PL_OPERAND_LOCAL
            && argument[1].value < PL_X86_GPR_COUNT);
    int right_ok = argument[2].kind == PL_OPERAND_CONST
        || (argument[2].kind == PL_OPERAND_LOCAL
            && argument[2].value < PL_X86_GPR_COUNT);
    if (!left_ok || !right_ok) return 0;
    if (argument[3].kind != PL_OPERAND_CONST) return 0;
    pl_u64 descriptor = argument[3].value;
    pl_u32 bits = (pl_u32)(descriptor & 0x7fu);
    pl_u32 mode = (pl_u32)((descriptor >> 8u) & 7u);
    pl_u32 preserves_carry = (pl_u32)((descriptor >> 11u) & 1u);
    if ((bits != 32u && bits != 64u) || preserves_carry
            || (mode != 2u && mode != 4u)
            || descriptor != ((pl_u64)bits | ((pl_u64)mode << 8u)))
        return 0;
    if (prior) *prior = (pl_u32)argument[0].value;
    return 1;
}

int pl_select_alu_frame_shape(const pl_plan *plan, pl_u32 *changed,
                           pl_u32 *final_flag_node)
{
    if (!plan || !changed || !final_flag_node || !plan->node_count
            || plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    *changed = 0u;
    *final_flag_node = 0u;
    pl_u32 alu_nodes = 0u;
    pl_u32 derived_publications = 0u;
    for (pl_u32 node = 1u; node <= plan->node_count; ++node) {
        if (plan->nodes[node - 1u].opcode != PL_OPCODE_X86_ALU)
            continue;
        pl_u32 bits, mode, preserves_carry;
        pl_operand source;
        pl_operand right;
        if (!pl_select_alu_node_semantics(
                plan, node, &source, &right,
                &bits, &mode, &preserves_carry)
                && !pl_select_alu_carry_prior_node(plan, node, 0))
            return 0;
        pl_operand result = {
            PL_OPERAND_PROJECTION, ((pl_u64)node << 8u) | 16u,
        };
        pl_u32 destination = pl_select_publication_owner(plan, result);
        if (destination < PL_X86_GPR_COUNT) {
            if (*changed & (1u << destination)) return 0;
            *changed |= 1u << destination;
        }
        (void)source;
        ++alu_nodes;
    }
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (local == PL_X86_RFLAGS_LOCAL) {
            if (value.kind == PL_OPERAND_LOCAL
                    && value.value == PL_X86_RFLAGS_LOCAL)
                continue;
            if (value.kind != PL_OPERAND_NODE || !value.value
                    || value.value > plan->node_count)
                return 0;
            *final_flag_node = (pl_u32)value.value;
            continue;
        }
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (value.kind == PL_OPERAND_PROJECTION) {
            /* Selector 16 is an ALU value projection; 0..15 are the condition
             * Boolean projections (`setcc` over a compare/test).  Both are
             * publications the frame has to materialize. */
            if (!(value.value >> 8u)
                    || (value.value >> 8u) > plan->node_count
                    || (value.value & 0xffu) > 16u)
                return 0;
            ++derived_publications;
        } else if (value.kind == PL_OPERAND_NODE) {
            if (!value.value || value.value > plan->node_count)
                return 0;
            ++derived_publications;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        *changed |= 1u << local;
    }
    /* A flag-only X86_ALU (its value dead because the coordinate is rewritten
     * by a constant copy) is a legal frame when the flags reach a conditional
     * select: the select's compare path emits the tested operation itself.
     * Requiring a GPR value publication here rejected those blocks. */
    (void)alu_nodes;
    /* Flags are a publication even when no GPR changes. Their entry operands
     * use the same scheduling law as a frame containing value publications. */
    return (*changed && derived_publications) || *final_flag_node;
}

/* Source ownership is a projection of the topologically numbered SSA DAG.
 * Expanding it recursively treats every shared node as a fresh tree once per
 * candidate and is exponential on precisely the large affine/ALU blocks the
 * product compiler must close.  A row is the complete law for one node and
 * its physical ALU-result projection; depth preserves the old recursion
 * budget exactly, with zero denoting an invalid spelling. */
static int gpr_source_operand_law(
    const pl_plan *plan, pl_operand operand, pl_u32 available_nodes,
    const gpr_source_row *row, pl_u32 *sources, pl_u32 *depth)
{
    if (!plan || !sources || !depth) return 0;
    if (operand.kind == PL_OPERAND_CONST) {
        *sources = 0u;
        *depth = 1u;
        return 1;
    }
    if (operand.kind == PL_OPERAND_LOCAL) {
        if (operand.value >= PL_X86_GPR_COUNT) return 0;
        *sources = 1u << (pl_u32)operand.value;
        *depth = 1u;
        return 1;
    }
    pl_u32 node = operand.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(operand.value >> 8u)
                : operand.kind == PL_OPERAND_NODE
                ? (pl_u32)operand.value : 0u;
    if (!node || node > available_nodes || !row) return 0;
    const gpr_source_row *source = &row[node - 1u];
    if (operand.kind == PL_OPERAND_PROJECTION) {
        if ((operand.value & 0xffu) != 16u
                || !source->projection_depth)
            return 0;
        *sources = source->projection_sources;
        *depth = source->projection_depth;
        return 1;
    }
    if (operand.kind != PL_OPERAND_NODE || !source->node_depth) return 0;
    *sources = source->node_sources;
    *depth = source->node_depth;
    return 1;
}

int pl_select_operand_gpr_sources(const pl_plan *plan, pl_operand operand,
                               pl_u32 before_node, pl_u32 remaining,
                               pl_u32 *sources)
{
    if (!plan || !sources || !remaining || !before_node) return 0;
    pl_u32 available = before_node - 1u;
    if (available > plan->node_count) available = plan->node_count;
    pl_u32 target_node = operand.kind == PL_OPERAND_PROJECTION
                       ? (pl_u32)(operand.value >> 8u)
                       : operand.kind == PL_OPERAND_NODE
                       ? (pl_u32)operand.value : 0u;
    if (!target_node) {
        pl_u32 law = 0u, depth = 0u;
        if (!gpr_source_operand_law(
                plan, operand, available, 0, &law, &depth)
                || depth > remaining)
            return 0;
        *sources |= law;
        return 1;
    }
    if (target_node > available) return 0;
    /* Every SSA edge points backward.  A query for an early node needs only
     * its prefix, not one newly materialized law row for the entire block. */
    available = target_node;
    gpr_source_row row[available ? available : 1u];
    for (pl_u32 node_number = 1u; node_number <= available; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        gpr_source_row *current = &row[node_number - 1u];
        *current = (gpr_source_row){ 0u, 0u, 0u, 0u };
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            continue;
        pl_u32 node_sources = 0u;
        pl_u32 node_depth = 1u;
        int node_valid = 1;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u, part_depth = 0u;
            if (!gpr_source_operand_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_number - 1u, row, &part, &part_depth)) {
                node_valid = 0;
                break;
            }
            node_sources |= part;
            if (part_depth >= node_depth) {
                if (part_depth == 0xffffffffu) {
                    node_valid = 0;
                    break;
                }
                node_depth = part_depth + 1u;
            }
        }
        if (node_valid) {
            current->node_sources = node_sources;
            current->node_depth = node_depth;
        }
        if (node->opcode != PL_OPCODE_X86_ALU
                || node->argument_count != 4u)
            continue;
        pl_u32 projection_sources = 0u;
        pl_u32 projection_depth = 1u;
        int projection_valid = 1;
        for (pl_u32 argument = 1u; argument < 3u; ++argument) {
            pl_u32 part = 0u, part_depth = 0u;
            if (!gpr_source_operand_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_number - 1u, row, &part, &part_depth)) {
                projection_valid = 0;
                break;
            }
            projection_sources |= part;
            if (part_depth >= projection_depth) {
                if (part_depth == 0xffffffffu) {
                    projection_valid = 0;
                    break;
                }
                projection_depth = part_depth + 1u;
            }
        }
        if (projection_valid) {
            current->projection_sources = projection_sources;
            current->projection_depth = projection_depth;
        }
    }
    pl_u32 law = 0u, depth = 0u;
    if (!gpr_source_operand_law(
            plan, operand, available, row, &law, &depth)
            || depth > remaining)
        return 0;
    *sources |= law;
    return 1;
}

pl_u32 pl_select_publication_owner(const pl_plan *plan, pl_operand operand)
{
    pl_u32 owner = PL_X86_GPR_COUNT;
    if (!plan) return owner;
    /* A destructive x86 ALU already has a physical accumulator coordinate.
     * If that entry local is also one of the result publications, retaining
     * it as owner avoids seed-copy + copy-back.  Register number is only a
     * tie-breaker when the normalized meaning has no such coordinate. */
    if (operand.kind == PL_OPERAND_PROJECTION
            && (operand.value & 0xffu) == 16u) {
        pl_u32 node_number = (pl_u32)(operand.value >> 8u);
        if (node_number && node_number <= plan->node_count) {
            const pl_node *node = &plan->nodes[node_number - 1u];
            if (node->opcode == PL_OPCODE_X86_ALU
                    && node->argument_count == 4u
                    && node->argument_at <= plan->argument_count
                    && node->argument_count
                       <= plan->argument_count - node->argument_at) {
                pl_operand source = plan->arguments[node->argument_at + 1u];
                if (source.kind == PL_OPERAND_LOCAL
                        && source.value < PL_X86_GPR_COUNT) {
                    pl_u32 candidate = (pl_u32)source.value;
                    pl_operand publication = plan->locals[candidate];
                    if (publication.kind == operand.kind
                            && publication.value == operand.value)
                        return candidate;
                }
            }
        }
    }
    if (operand.kind == PL_OPERAND_NODE && operand.value
            && operand.value <= plan->node_count) {
        const pl_node *node = &plan->nodes[operand.value - 1u];
        if ((node->opcode == PL_OPCODE_LANE32_SELECT
                || node->opcode == PL_OPCODE_LANE64_SELECT)
                && node->argument_count == 3u
                && node->argument_at <= plan->argument_count
                && node->argument_count
                   <= plan->argument_count - node->argument_at) {
            pl_operand current = plan->arguments[node->argument_at + 1u];
            if (current.kind == PL_OPERAND_LOCAL
                    && current.value < PL_X86_GPR_COUNT) {
                pl_u32 candidate = (pl_u32)current.value;
                pl_operand publication = plan->locals[candidate];
                if (publication.kind == operand.kind
                        && publication.value == operand.value)
                    return candidate;
            }
        }
    }
    /* For a normalized arithmetic root, only a top-level operand can be the
     * destructive accumulator.  A transitive source may also be an equal
     * final publication, but choosing it adds save + restore work around the
     * actual root (for example `(RSI xor n6)` published to both RSI and
     * RDX). */
    if (operand.kind == PL_OPERAND_NODE && operand.value
            && operand.value <= plan->node_count) {
        pl_operand left, right;
        pl_u32 bits = 0u, mode = 0u;
        if (pl_select_arithmetic_tree_details(
                plan, operand, &left, &right, &bits, &mode)) {
            pl_operand root[2] = { left, right };
            pl_u32 count = mode == 3u ? 1u : 2u;
            for (pl_u32 root_at = 0u; root_at < count; ++root_at) {
                if (root[root_at].kind != PL_OPERAND_LOCAL
                        || root[root_at].value >= PL_X86_GPR_COUNT)
                    continue;
                pl_u32 candidate = (pl_u32)root[root_at].value;
                pl_operand publication = plan->locals[candidate];
                if (publication.kind == operand.kind
                        && publication.value == operand.value)
                    return candidate;
            }
            (void)bits;
        }
    }
    /* Equal architectural outputs are interchangeable owners.  Prefer one
     * which is also an entry source of the value, so x86 can evaluate the
     * destructive chain in place and fan the result out once.  Falling back
     * to register rank here would create save/copy-back/restore work around
     * the actual accumulator. */
    pl_u32 entry_sources = 0u;
    if (pl_select_operand_gpr_sources(
            plan, operand, plan->node_count + 1u,
            plan->node_count + 1u, &entry_sources)) {
        for (pl_u32 candidate = 0u;
                candidate < PL_X86_GPR_COUNT; ++candidate) {
            if (!(entry_sources & (1u << candidate))) continue;
            pl_operand publication = plan->locals[candidate];
            if (publication.kind == operand.kind
                    && publication.value == operand.value)
                return candidate;
        }
    }
    /* Constant folding must not split the one semantic zero class merely
     * because a live flag producer still exposes its zero result as a node
     * projection.  Prefer that unavoidable destructive producer as owner;
     * every CONST 0 / folded-zero publication is then only a register rank.
     * This is the native image of the normalized future quotient, not a
     * peephole tied to either source spelling. */
    if (pl_select_zero_result_operand(plan, operand)) {
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            pl_operand published = plan->locals[local];
            if (published.kind != PL_OPERAND_PROJECTION
                    || (published.value & 0xffu) != 16u
                    || !pl_select_zero_result_operand(plan, published))
                continue;
            pl_u32 node_number = (pl_u32)(published.value >> 8u);
            if (node_number && node_number <= plan->node_count) {
                const pl_node *node = &plan->nodes[node_number - 1u];
                if (node->opcode == PL_OPCODE_X86_ALU
                        && node->argument_count == 4u
                        && node->argument_at <= plan->argument_count
                        && node->argument_count
                           <= plan->argument_count - node->argument_at) {
                    pl_operand source =
                        plan->arguments[node->argument_at + 1u];
                    if (source.kind == PL_OPERAND_LOCAL
                            && source.value < PL_X86_GPR_COUNT) {
                        pl_u32 candidate = (pl_u32)source.value;
                        pl_operand candidate_value = plan->locals[candidate];
                        if (candidate_value.kind == published.kind
                                && candidate_value.value == published.value)
                            return candidate;
                    }
                }
            }
            return local;
        }
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand published = plan->locals[local];
        if (published.kind == operand.kind
                && published.value == operand.value) {
            owner = local;
            break;
        }
    }
    return owner;
}

/* Low 16 bits are entry-register sources; high 16 bits are coordinates whose
 * new value must already have been published.  A coordinate may occur in
 * both halves: that is a real old-generation/new-generation lifetime split,
 * not a bit to cancel.  The plan is topologically
 * numbered, so one forward pass computes the complete source law for every
 * shared node.  This replaces the old recursive DAG expansion, which revisited
 * the same suffix once per root, pending local, and parent path. */

/* The final flag producer's value can be a zero-producing self operation
 * (`xor r,r` / `sub r,r`).  `pl_select_publication_owner` prefers that publication as the
 * owner of constant zero, which makes every zero operand depend on a
 * coordinate the flags-last rule schedules last.  Callers use this to keep a
 * constant zero as an immediate instead. */
int pl_select_zero_self_flag_publication(const pl_plan *plan, pl_u32 owner)
{
    if (!plan || owner >= PL_X86_GPR_COUNT) return 0;
    pl_operand value = plan->locals[owner];
    if (value.kind != PL_OPERAND_PROJECTION || (value.value & 0xffu) != 16u)
        return 0;
    pl_u32 node = (pl_u32)(value.value >> 8u);
    if (!node || node > plan->node_count) return 0;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u, preserves_carry = 0u;
    if (!pl_select_alu_node_semantics(plan, node, &left, &right,
            &bits, &mode, &preserves_carry))
        return 0;
    return !preserves_carry && (mode == 3u || mode == 6u)
        && pl_select_equal_operand(left, right);
}

static int operand_source_law(const pl_plan *plan, pl_operand operand,
                              const pl_u32 *node_law,
                              pl_u32 available_nodes,
                              int substitute_publication,
                              pl_u32 *law)
{
    if (!plan || !law) return 0;
    if (operand.kind == PL_OPERAND_CONST) {
        if (substitute_publication) {
            pl_u32 owner = pl_select_publication_owner(plan, operand);
            if (owner < PL_X86_GPR_COUNT
                    && !pl_select_zero_self_flag_publication(plan, owner)) {
                pl_u32 bit = 1u << owner;
                *law = bit << 16u;
                return 1;
            }
        }
        *law = 0u;
        return 1;
    }
    if (operand.kind == PL_OPERAND_LOCAL) {
        if (substitute_publication && operand.value < PL_X86_GPR_COUNT) {
            pl_u32 entry = (pl_u32)operand.value;
            pl_u32 owner = pl_select_publication_owner(plan, operand);
            if (owner < PL_X86_GPR_COUNT && owner != entry) {
                pl_u32 bit = 1u << owner;
                /* A publication can be used as a shorter spelling, but the
                 * emitter may still read the entry register.  Preserve that
                 * old generation until every consumer has run; otherwise an
                 * in-place affine update can precede its former readers. */
                *law = (1u << entry) | (bit << 16u);
                return 1;
            }
        }
        *law = operand.value < PL_X86_GPR_COUNT
             ? 1u << (pl_u32)operand.value : 0u;
        return 1;
    }
    pl_u32 node = operand.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(operand.value >> 8u)
                : operand.kind == PL_OPERAND_NODE
                ? (pl_u32)operand.value : 0u;
    if (!node || node > available_nodes || !node_law) return 0;
    if (substitute_publication) {
        pl_u32 owner = pl_select_publication_owner(plan, operand);
        if (owner < PL_X86_GPR_COUNT) {
            pl_u32 bit = 1u << owner;
            *law = bit << 16u;
            return 1;
        }
        /* An X86_FLAGS node's flags are set by the single instruction that
         * publishes its result.  A consumer of those flags therefore depends
         * on the result's publication owner; it must not inherit the entry
         * registers that the producing instruction itself reads (notably an
         * in-place compare whose entry is the coordinate it overwrites). */
        const pl_node *flags = &plan->nodes[node - 1u];
        if (flags->opcode == PL_OPCODE_X86_FLAGS
                && flags->argument_count == 5u
                && flags->argument_at <= plan->argument_count
                && 5u <= plan->argument_count - flags->argument_at) {
            pl_operand result = plan->arguments[flags->argument_at + 3u];
            pl_u32 result_owner = pl_select_publication_owner(plan, result);
            if (result_owner < PL_X86_GPR_COUNT) {
                *law = (1u << result_owner) << 16u;
                return 1;
            }
        }
    }
    *law = node_law[node - 1u];
    return 1;
}

/* Widths, condition codes and operation descriptors are instruction literals,
 * not runtime values. Value operands, including ALU immediates, may instead
 * be emitted from a published GPR when that is the shorter physical spelling;
 * the publication then has to precede its consumer. */
static int native_argument_uses_publication(
    const pl_plan *plan, const pl_node *node, pl_u32 argument)
{
    (void)plan;
    pl_u32 descriptor;
    switch (node->opcode) {
    case PL_OPCODE_LANE32_INSERT:
    case PL_OPCODE_LANE64_INSERT:
        /* The zero fill in a zero extension is not read from a GPR. */
        if (!argument) {
            pl_operand base = plan->arguments[node->argument_at];
            if (base.kind == PL_OPERAND_CONST && !base.value) return 0;
        }
        descriptor = 2u; break;
    case PL_OPCODE_X86_CONDITION: descriptor = 1u; break;
    case PL_OPCODE_X86_TEST_CONDITION:
    case PL_OPCODE_MUL_HIGH:
    case PL_OPCODE_BIT_ADDRESS: descriptor = 2u; break;
    case PL_OPCODE_X86_ALU:
    case PL_OPCODE_X86_COMPARE:
    case PL_OPCODE_X86_TEST:
    case PL_OPCODE_X86_BIT_FLAGS:
    case PL_OPCODE_X86_MUL_FLAGS: descriptor = 3u; break;
    case PL_OPCODE_X86_FLAGS:
    case PL_OPCODE_X86_AFFINE_ALU:
    case PL_OPCODE_X86_SHIFT_FLAGS:
    case PL_OPCODE_X86_DOUBLE_SHIFT: descriptor = 4u; break;
    default: return 1;
    }
    return argument != descriptor;
}

static pl_u32 add3_published_pair_dependencies(
    const pl_plan *plan, const pl_node *node, pl_u32 node_number)
{
    if (!plan || !node || (node->opcode != PL_OPCODE_ADD3[0]
                && node->opcode != PL_OPCODE_ADD3[1])
            || node->argument_count != 3u)
        return 0u;
    const pl_operand *argument = plan->arguments + node->argument_at;
    pl_u32 dependencies = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand published = plan->locals[local];
        if (published.kind != PL_OPERAND_NODE || !published.value
                || published.value >= node_number)
            continue;
        pl_operand left, right;
        pl_u32 bits = 0u, mode = 0u;
        if (!pl_select_arithmetic_tree_details(plan, published, &left, &right,
                                     &bits, &mode)
                || mode != 1u)
            continue;
        for (pl_u32 i = 0u; i < 3u; ++i)
            for (pl_u32 j = i + 1u; j < 3u; ++j)
                if ((pl_select_equal_operand(argument[i], left)
                            && pl_select_equal_operand(argument[j], right))
                        || (pl_select_equal_operand(argument[i], right)
                            && pl_select_equal_operand(argument[j], left))) {
                    pl_u32 owner = pl_select_publication_owner(plan, published);
                    if (owner < PL_X86_GPR_COUNT)
                        dependencies |= 1u << owner;
                }
    }
    return dependencies;
}

int pl_select_alu_frame_source_laws(const pl_plan *plan,
                                 pl_u32 sources[PL_X86_GPR_COUNT],
                                 pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !sources || !dependencies) return 0;
    pl_u32 node_law[plan->node_count ? plan->node_count : 1u];
    for (pl_u32 node_number = 1u;
            node_number <= plan->node_count; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            return 0;
        pl_u32 law = 0u;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u;
            if (!operand_source_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_law, node_number - 1u,
                    native_argument_uses_publication(plan, node, argument), &part))
                return 0;
            law |= part;
        }
        /* An ADD3 may reuse an earlier published two-term sum.  Record the
         * generation edge on the node so later ALU roots inherit it. */
        law |= add3_published_pair_dependencies(plan, node, node_number)
            << 16u;
        node_law[node_number - 1u] = law;
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        pl_u32 owner = pl_select_publication_owner(plan, value);
        pl_u32 law = 0u;
        if (owner < PL_X86_GPR_COUNT && owner != local) {
            pl_u32 bit = 1u << owner;
            law = bit << 16u;
        } else if (!operand_source_law(
                       plan, value, node_law, plan->node_count,
                       0, &law)) {
            return 0;
        }
        sources[local] = law & 0xffffu;
        dependencies[local] = law >> 16u;
    }
    return 1;
}

int pl_select_operand_frame_source_law(const pl_plan *plan,
                                    pl_operand operand,
                                    pl_u32 *sources,
                                    pl_u32 *dependencies)
{
    if (!plan || !sources || !dependencies) return 0;
    pl_u32 node_law[plan->node_count ? plan->node_count : 1u];
    for (pl_u32 node_number = 1u;
            node_number <= plan->node_count; ++node_number) {
        const pl_node *node = &plan->nodes[node_number - 1u];
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            return 0;
        pl_u32 law = 0u;
        for (pl_u32 argument = 0u;
                argument < node->argument_count; ++argument) {
            pl_u32 part = 0u;
            if (!operand_source_law(
                    plan, plan->arguments[node->argument_at + argument],
                    node_law, node_number - 1u,
                    native_argument_uses_publication(plan, node, argument), &part))
                return 0;
            law |= part;
        }
        law |= add3_published_pair_dependencies(plan, node, node_number)
            << 16u;
        node_law[node_number - 1u] = law;
    }
    pl_u32 law = 0u;
    if (!operand_source_law(
            plan, operand, node_law, plan->node_count, 1, &law))
        return 0;
    *sources = law & 0xffffu;
    *dependencies = law >> 16u;
    return 1;
}

int pl_select_flag_result_operand(const pl_plan *plan, pl_u32 node_number,
                               pl_operand *result, pl_operand *prior)
{
    if (!plan || !result || !prior || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (!node->argument_count || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    *prior = argument[0];
    if (node->opcode == PL_OPCODE_X86_SHIFT_FLAGS) {
        if (node->argument_count != 5u) return 0;
        *result = argument[2];
        return 1;
    }
    if (node->opcode == PL_OPCODE_X86_FLAGS) {
        if (node->argument_count != 5u) return 0;
        *result = argument[3];
        return 1;
    }
    if (node->opcode == PL_OPCODE_X86_ALU
            || node->opcode == PL_OPCODE_X86_AFFINE_ALU
            || node->opcode == PL_OPCODE_X86_BIT_SUMMARY) {
        result->kind = PL_OPERAND_PROJECTION;
        result->value = ((pl_u64)node_number << 8u) | 16u;
        return 1;
    }
    return 0;
}

/* Value SSA alone intentionally drops dead intermediate flags.  A surviving
 * variable-shift chain is different: count==0 makes each producer retain its
 * prior flags, so the chain order is observable even when its value results
 * are otherwise independent.  Project that residual flag order onto the
 * physical result owners before register scheduling. */
void pl_select_add_flag_chain_dependencies(
    const pl_plan *plan, pl_u32 final_flag_node,
    pl_u32 dependencies[PL_X86_GPR_COUNT])
{
    if (!plan || !dependencies) return;
    pl_u32 later_owner = PL_X86_GPR_COUNT;
    pl_u32 node_number = final_flag_node;
    for (pl_u32 step = 0u; node_number && step < plan->node_count; ++step) {
        pl_operand result, prior;
        if (!pl_select_flag_result_operand(plan, node_number, &result, &prior)) break;
        pl_u32 owner = pl_select_publication_owner(plan, result);
        if (later_owner < PL_X86_GPR_COUNT
                && owner < PL_X86_GPR_COUNT && owner != later_owner)
            dependencies[later_owner] |= 1u << owner;
        if (owner < PL_X86_GPR_COUNT) later_owner = owner;
        if (prior.kind != PL_OPERAND_NODE || !prior.value
                || prior.value >= node_number
                || prior.value > plan->node_count)
            break;
        node_number = (pl_u32)prior.value;
    }
    /* A conditional select that tests the final flag word skips its own
     * compare when that word has a value publication, so it must be ordered
     * after the publication that produces those flags.  SSA alone carries no
     * such edge: the tested flag node is reached through the condition and the
     * value publication is a separate projection. */
    if (final_flag_node) {
        pl_operand flag_result = { 0 }, flag_prior = { 0 };
        if (pl_select_flag_result_operand(
                plan, final_flag_node, &flag_result, &flag_prior)) {
            pl_u32 flag_owner = pl_select_publication_owner(plan, flag_result);
            if (flag_owner < PL_X86_GPR_COUNT) {
                for (pl_u32 local = 0u;
                        local < PL_X86_GPR_COUNT; ++local) {
                    if (local == flag_owner) continue;
                    pl_operand value = plan->locals[local];
                    if (value.kind != PL_OPERAND_NODE || !value.value
                            || value.value > plan->node_count)
                        continue;
                    const pl_node *select = &plan->nodes[value.value - 1u];
                    if ((select->opcode != PL_OPCODE_LANE32_SELECT
                                && select->opcode != PL_OPCODE_LANE64_SELECT)
                            || select->argument_count != 3u
                            || select->argument_at > plan->argument_count
                            || select->argument_count
                               > plan->argument_count - select->argument_at)
                        continue;
                    pl_operand condition = plan->arguments[
                        select->argument_at + 2u];
                    if (condition.kind != PL_OPERAND_NODE
                            || !condition.value
                            || condition.value > plan->node_count)
                        continue;
                    const pl_node *condition_node =
                        &plan->nodes[condition.value - 1u];
                    if (condition_node->opcode != PL_OPCODE_X86_CONDITION
                            || condition_node->argument_count != 2u
                            || condition_node->argument_at
                               > plan->argument_count
                            || condition_node->argument_count
                               > plan->argument_count
                                 - condition_node->argument_at)
                        continue;
                    pl_operand tested = plan->arguments[
                        condition_node->argument_at];
                    if (tested.kind == PL_OPERAND_NODE
                            && tested.value == final_flag_node)
                        dependencies[local] |= 1u << flag_owner;
                }
            }
        }
    }
}

int pl_select_equal_operand(pl_operand left, pl_operand right)
{
    return left.kind == right.kind && left.value == right.value;
}
