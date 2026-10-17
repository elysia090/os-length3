/* shared-dag: native x86 selection. */
#include "shared-dag.h"
#include "limits.h"
#include "encoding.h"
#include "expressions.h"
#include "handoff.h"
#include "operands.h"
#include "select-rules.h"
#include "source.h"
#include "tree-measure.h"
#include "tree-write.h"

#define PL_X86_SHARED_DAG_MAX_NODES 96u
#define PL_X86_SHARED_DAG_MAX_ACTIONS 512u
#define PL_X86_SHARED_DAG_NONE 0xffu
#define PL_X86_SHARED_DAG_NODE_ACTION  0u
#define PL_X86_SHARED_DAG_SPILL_ACTION 1u
#define PL_X86_SHARED_DAG_FINAL_ACTION 2u
#define PL_X86_SHARED_DAG_FLAG_ACTION  3u

typedef struct {
    pl_u32 kind;
    pl_u32 node;
    pl_u32 destination;
    pl_u32 source;
    pl_u32 bits;
    pl_u32 pair_node;
    pl_operand remaining;
} shared_dag_action;

typedef struct {
    pl_u32 count;
    shared_dag_action action[PL_X86_SHARED_DAG_MAX_ACTIONS];
} shared_dag_list;

typedef struct {
    pl_u32 node_count;
    pl_u32 flag_node;
    pl_u32 out_mask;
    pl_u32 final_of_node[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 node_last[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 entry_last[PL_X86_GPR_COUNT];
    pl_u32 operand_count[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 bits[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_u32 pair_node[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    pl_operand operand[PL_X86_SHARED_DAG_MAX_NODES + 1u][4u];
} shared_dag_shape;

typedef struct {
    const shared_dag_shape *shape;
    shared_dag_list best;
    shared_dag_list current;
    pl_u32 best_cost;
    pl_u64 expansions;
    pl_u64 budget;
    pl_u64 leaves;
    pl_u64 finals_ok;
} shared_dag_search;

static int shared_dag_shape_build(const pl_x86_block *block,
                                  shared_dag_shape *shape);

static pl_u32 shared_dag_holder(pl_operand operand,
                                const pl_u32 *entry_home,
                                const pl_u32 *node_home);

static pl_u32 shared_dag_last(pl_operand operand, pl_u32 at,
                              const shared_dag_shape *shape);

static int shared_dag_available(pl_u32 local, pl_u32 at,
                                const shared_dag_shape *shape,
                                const pl_u32 *occ_kind,
                                const pl_u32 *occ_value);

static pl_u32 shared_dag_pick_destination(
    pl_u32 node, pl_u32 at, const shared_dag_shape *shape,
    const pl_u32 *occ_kind, const pl_u32 *occ_value,
    const pl_u32 *entry_home, const pl_u32 *node_home);

static int shared_dag_allocate_greedy(const shared_dag_shape *shape,
                                      shared_dag_list *list, pl_u32 *stage);

static int shared_dag_place_finals(
    const shared_dag_shape *shape,
    pl_u32 occ_kind[PL_X86_GPR_COUNT], pl_u32 occ_value[PL_X86_GPR_COUNT],
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u],
    shared_dag_list *list);

static pl_u32 shared_dag_step_cost(const shared_dag_shape *shape, pl_u32 node,
    pl_u32 destination, const pl_u32 *entry_home, const pl_u32 *node_home);

static int shared_dag_dest_seen(const pl_u32 *out, pl_u32 count, pl_u32 value);

static pl_u32 shared_dag_collect_dests(
    const shared_dag_shape *shape, pl_u32 node,
    const pl_u32 *occ_kind, const pl_u32 *occ_value,
    const pl_u32 *entry_home, const pl_u32 *node_home,
    pl_u32 *out, pl_u32 capacity);

static void shared_dag_apply_node(
    pl_u32 node, pl_u32 destination,
    pl_u32 *occ_kind, pl_u32 *occ_value, pl_u32 *entry_home, pl_u32 *node_home);

static void shared_dag_dfs(shared_dag_search *search,
    pl_u32 *occ_kind, pl_u32 *occ_value,
    pl_u32 *entry_home, pl_u32 *node_home,
    pl_u32 node, pl_u32 cost);

static int shared_dag_allocate(const shared_dag_shape *shape,
                               shared_dag_list *list, pl_u32 *stage);

static void shared_dag_set_aliases(pl_x86_native_selection *selection,
                                   pl_u32 count, const pl_u32 *entry_home,
                                   const pl_u32 *node_home);

static int shared_dag_replay(const pl_x86_block *block,
                             pl_x86_native_selection *selection,
                             const shared_dag_shape *shape,
                             const shared_dag_list *list,
                             const pl_x86_frontend *frontend,
                             pl_u8 *output, pl_u32 *bytes, pl_u32 *work);

/* The pair an ADD3 already has as an earlier binary sum, if any. */
int pl_select_shared_dag_add3_pair(const pl_plan *plan, pl_u32 node_number,
                                pl_u32 *pair_node, pl_operand *remaining,
                                pl_u32 *bits)
{
    if (!plan || !pair_node || !remaining || !bits
            || node_number < 2u || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    pl_u32 lane = node->opcode == PL_OPCODE_ADD3[0] ? 0u
                : node->opcode == PL_OPCODE_ADD3[1] ? 1u : 2u;
    if (lane == 2u || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    pl_u32 width = lane == 0u ? 32u : 64u;
    const pl_operand *argument = plan->arguments + node->argument_at;
    for (pl_u32 candidate = 1u; candidate < node_number; ++candidate) {
        pl_operand left, right;
        pl_u32 candidate_bits = 0u, candidate_mode = 0u;
        /* A 32-bit ADD3 may consume a 64-bit binary sum: the low 32 bits of a
         * 64-bit add are exactly the 32-bit add, so the same shared pair is a
         * valid producer for the narrower node. */
        int narrow_pair = lane == 0u;
        if (!pl_select_arithmetic_tree_details(
                plan, (pl_operand){ PL_OPERAND_NODE, candidate },
                &left, &right, &candidate_bits, &candidate_mode)
                || candidate_mode != 1u
                || (candidate_bits != width
                    && !(narrow_pair && candidate_bits == 64u)))
            continue;
        for (pl_u32 i = 0u; i < 3u; ++i)
            for (pl_u32 j = i + 1u; j < 3u; ++j) {
                int match = (pl_select_equal_operand(argument[i], left)
                             && pl_select_equal_operand(argument[j], right))
                         || (pl_select_equal_operand(argument[i], right)
                             && pl_select_equal_operand(argument[j], left));
                if (!match) continue;
                *pair_node = candidate;
                *remaining = argument[3u - i - j];
                *bits = width;
                return 1;
            }
    }
    return 0;
}

/* The pair an ADD3 has as a value that another local already publishes.  This
 * is the same relation as `pl_select_shared_dag_add3_pair`, but expressed through the
 * local plane so the pair is a register the frame has ordered, not a later
 * node.  `pair_local` must be a local whose publication the caller schedules;
 * the matching dependency is recorded in `pl_select_alu_frame_source_laws`. */
int pl_select_shared_dag_add3_published_pair(
    const pl_plan *plan, pl_u32 node_number, pl_u32 *pair_local,
    pl_operand *remaining, pl_u32 *bits)
{
    if (!plan || !pair_local || !remaining || !bits
            || node_number < 2u || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    pl_u32 lane = node->opcode == PL_OPCODE_ADD3[0] ? 0u
                : node->opcode == PL_OPCODE_ADD3[1] ? 1u : 2u;
    if (lane == 2u || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    pl_u32 width = lane == 0u ? 32u : 64u;
    const pl_operand *argument = plan->arguments + node->argument_at;
    for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
        pl_operand published = plan->locals[other];
        if (published.kind != PL_OPERAND_NODE || !published.value
                || published.value > plan->node_count)
            continue;
        pl_operand left, right;
        pl_u32 other_bits = 0u, other_mode = 0u;
        int narrow_pair = lane == 0u;
        if (!pl_select_arithmetic_tree_details(plan, published, &left, &right,
                                     &other_bits, &other_mode)
                || other_mode != 1u
                || (other_bits != width
                    && !(narrow_pair && other_bits == 64u)))
            continue;
        for (pl_u32 i = 0u; i < 3u; ++i)
            for (pl_u32 j = i + 1u; j < 3u; ++j) {
                int match = (pl_select_equal_operand(argument[i], left)
                             && pl_select_equal_operand(argument[j], right))
                         || (pl_select_equal_operand(argument[i], right)
                             && pl_select_equal_operand(argument[j], left));
                if (!match) continue;
                *pair_local = other;
                *remaining = argument[3u - i - j];
                *bits = width;
                return 1;
            }
    }
    return 0;
}

static int shared_dag_shape_build(const pl_x86_block *block,
                                  shared_dag_shape *shape)
{
    if (!block || !shape) return 0;
    const pl_plan *plan = &block->plan;
    pl_u32 count = plan->node_count;
    if (!count || count > PL_X86_SHARED_DAG_MAX_NODES
            || plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    *shape = (shared_dag_shape){ 0 };
    shape->node_count = count;
    for (pl_u32 node = 0u; node <= count; ++node)
        shape->final_of_node[node] = PL_X86_SHARED_DAG_NONE;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (value.kind != PL_OPERAND_NODE || !value.value || value.value > count)
            return 0;
        if (shape->final_of_node[value.value] != PL_X86_SHARED_DAG_NONE)
            return 0;
        shape->final_of_node[value.value] = local;
        shape->out_mask |= 1u << local;
    }
    for (pl_u32 local = PL_X86_GPR_COUNT; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (local != PL_X86_RFLAGS_LOCAL
                || value.kind != PL_OPERAND_NODE || !value.value
                || value.value > count)
            return 0;
        shape->flag_node = (pl_u32)value.value;
    }
    if (!shape->out_mask) return 0;
    for (pl_u32 node = 1u; node <= count; ++node) {
        shape->pair_node[node] = 0u;
        if (node == shape->flag_node) {
            const pl_node *value = &plan->nodes[node - 1u];
            if (value->argument_at > plan->argument_count
                    || value->argument_count
                       > plan->argument_count - value->argument_at
                    || value->argument_count > 4u)
                return 0;
            shape->operand_count[node] = value->argument_count;
            for (pl_u32 at = 0u; at < value->argument_count; ++at)
                shape->operand[node][at] =
                    plan->arguments[value->argument_at + at];
            continue;
        }
        pl_u32 pair = 0u, pair_bits = 0u;
        pl_operand remaining = { 0 };
        if (pl_select_shared_dag_add3_pair(
                plan, node, &pair, &remaining, &pair_bits)) {
            shape->pair_node[node] = pair;
            shape->operand_count[node] = 2u;
            shape->operand[node][0] = remaining;
            shape->operand[node][1] =
                (pl_operand){ PL_OPERAND_NODE, pair };
            shape->bits[node] = pair_bits;
            continue;
        }
        const pl_node *value = &plan->nodes[node - 1u];
        if (!value->argument_count
                || value->argument_at > plan->argument_count
                || value->argument_count
                   > plan->argument_count - value->argument_at
                || value->argument_count > 4u)
            return 0;
        shape->operand_count[node] = value->argument_count;
        for (pl_u32 at = 0u; at < value->argument_count; ++at)
            shape->operand[node][at] =
                plan->arguments[value->argument_at + at];
        pl_u32 node_bits = pl_select_operand_expression_bits(
            plan, (pl_operand){ PL_OPERAND_NODE, node }, 0u);
        if (!node_bits) return 0;
        shape->bits[node] = node_bits;
    }
    for (pl_u32 node = 1u; node <= count; ++node)
        for (pl_u32 at = 0u; at < shape->operand_count[node]; ++at) {
            pl_operand operand = shape->operand[node][at];
            if (operand.kind == PL_OPERAND_NODE
                    && operand.value && operand.value <= count) {
                if (node > shape->node_last[operand.value])
                    shape->node_last[operand.value] = node;
            } else if (operand.kind == PL_OPERAND_LOCAL
                    && operand.value < PL_X86_GPR_COUNT) {
                if (node > shape->entry_last[operand.value])
                    shape->entry_last[operand.value] = node;
            }
        }
    for (pl_u32 node = 1u; node <= count; ++node)
        if (shape->final_of_node[node] != PL_X86_SHARED_DAG_NONE)
            shape->node_last[node] = 0x7fffffffu;
    return 1;
}

static pl_u32 shared_dag_holder(pl_operand operand,
                                const pl_u32 *entry_home,
                                const pl_u32 *node_home)
{
    if (operand.kind == PL_OPERAND_LOCAL
            && operand.value < PL_X86_GPR_COUNT)
        return entry_home[operand.value];
    if (operand.kind == PL_OPERAND_NODE
            && operand.value <= PL_X86_SHARED_DAG_MAX_NODES)
        return node_home[operand.value];
    return PL_X86_SHARED_DAG_NONE;
}

static pl_u32 shared_dag_last(pl_operand operand, pl_u32 at,
                              const shared_dag_shape *shape)
{
    if (operand.kind == PL_OPERAND_LOCAL
            && operand.value < PL_X86_GPR_COUNT)
        return shape->entry_last[operand.value];
    if (operand.kind == PL_OPERAND_NODE
            && operand.value <= PL_X86_SHARED_DAG_MAX_NODES)
        return shape->node_last[operand.value];
    return at;
}

static int shared_dag_available(pl_u32 local, pl_u32 at,
                                const shared_dag_shape *shape,
                                const pl_u32 *occ_kind,
                                const pl_u32 *occ_value)
{
    if (local >= PL_X86_GPR_COUNT
            || !(shape->out_mask & (1u << local)))
        return 0;
    if (occ_kind[local] == 0u) return 1;
    if (occ_kind[local] == 2u)
        return shape->node_last[occ_value[local]] <= at;
    return shape->entry_last[occ_value[local]] <= at;
}

static pl_u32 shared_dag_pick_destination(
    pl_u32 node, pl_u32 at, const shared_dag_shape *shape,
    const pl_u32 *occ_kind, const pl_u32 *occ_value,
    const pl_u32 *entry_home, const pl_u32 *node_home)
{
    pl_u32 final = shape->final_of_node[node];
    if (final != PL_X86_SHARED_DAG_NONE
            && shared_dag_available(final, at, shape, occ_kind, occ_value))
        return final;
    /* Prefer a destroying in-place operand that is not reserved for a later
     * final publication, then one that is, then a free coordinate. */
    for (pl_u32 pass = 0u; pass < 3u; ++pass)
        for (pl_u32 at_arg = 0u; at_arg < shape->operand_count[node]; ++at_arg) {
            pl_operand operand = shape->operand[node][at_arg];
            pl_u32 holder = shared_dag_holder(operand, entry_home, node_home);
            if (holder >= PL_X86_GPR_COUNT) continue;
            if (shared_dag_last(operand, at, shape) > at) continue;
            if (!shared_dag_available(holder, at, shape, occ_kind, occ_value))
                continue;
            pl_u32 reserved = 0u;
            for (pl_u32 later = at + 1u; later <= shape->node_count; ++later)
                if (shape->final_of_node[later] == holder
                        && node_home[later] == PL_X86_SHARED_DAG_NONE) {
                    reserved = 1u;
                    break;
                }
            if (pass == 0u && reserved) continue;
            if (pass == 1u && !reserved) continue;
            return holder;
        }
    for (pl_u32 pass = 0u; pass < 2u; ++pass)
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!shared_dag_available(local, at, shape, occ_kind, occ_value))
                continue;
            pl_u32 reserved = 0u;
            for (pl_u32 later = at + 1u; later <= shape->node_count; ++later)
                if (shape->final_of_node[later] == local
                        && node_home[later] == PL_X86_SHARED_DAG_NONE) {
                    reserved = 1u;
                    break;
                }
            if (pass == 0u && reserved) continue;
            if (pass == 1u && !reserved) continue;
            return local;
        }
    return PL_X86_SHARED_DAG_NONE;
}

static int shared_dag_allocate_greedy(const shared_dag_shape *shape,
                                      shared_dag_list *list, pl_u32 *stage)
{
    if (stage) *stage = 0u;
    if (!shape || !list) return 0;
    pl_u32 count = shape->node_count;
    pl_u32 occ_kind[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 occ_value[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 entry_home[PL_X86_GPR_COUNT];
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        entry_home[local] = local;
        occ_kind[local] = 1u;
        occ_value[local] = local;
    }
    for (pl_u32 node = 0u; node <= count; ++node)
        node_home[node] = PL_X86_SHARED_DAG_NONE;
    list->count = 0u;
#define SHD_PUSH(action_) do { \
        if (list->count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return 0; \
        list->action[list->count++] = (action_); \
    } while (0)
    for (pl_u32 node = 1u; node <= count; ++node) {
        if (node == shape->flag_node) continue;
        pl_u32 at = node;
        pl_u32 destination = shared_dag_pick_destination(
            node, at, shape, occ_kind, occ_value, entry_home, node_home);
        if (destination == PL_X86_SHARED_DAG_NONE) {
            if (stage) *stage = 0x10u;
            /* Copy the live value with the farthest next use aside, then use
             * its coordinate.  This is the source-level register shuffle. */
            pl_u32 victim = PL_X86_SHARED_DAG_NONE, victim_last = 0u;
            for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
                if (!(shape->out_mask & (1u << local))
                        || occ_kind[local] == 0u)
                    continue;
                pl_u32 last = occ_kind[local] == 2u
                    ? shape->node_last[occ_value[local]]
                    : shape->entry_last[occ_value[local]];
                if (last <= at) continue;
                if (victim == PL_X86_SHARED_DAG_NONE || last > victim_last) {
                    victim = local;
                    victim_last = last;
                }
            }
            pl_u32 spare = PL_X86_SHARED_DAG_NONE;
            for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
                if (local != victim
                        && shared_dag_available(
                            local, at, shape, occ_kind, occ_value)) {
                    spare = local;
                    break;
                }
            if (victim == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x11u;
                return 0;
            }
            if (spare == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x12u;
                return 0;
            }
            shared_dag_action spill = { 0 };
            spill.kind = PL_X86_SHARED_DAG_SPILL_ACTION;
            spill.source = victim;
            spill.destination = spare;
            SHD_PUSH(spill);
            occ_kind[spare] = occ_kind[victim];
            occ_value[spare] = occ_value[victim];
            if (occ_kind[victim] == 2u)
                node_home[occ_value[victim]] = spare;
            else
                entry_home[occ_value[victim]] = spare;
            occ_kind[victim] = 0u;
            destination = shared_dag_pick_destination(
                node, at, shape, occ_kind, occ_value, entry_home, node_home);
            if (destination == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x13u;
                return 0;
            }
        }
        shared_dag_action action = { 0 };
        action.kind = PL_X86_SHARED_DAG_NODE_ACTION;
        action.node = node;
        action.destination = destination;
        action.bits = shape->bits[node];
        action.pair_node = shape->pair_node[node];
        if (action.pair_node)
            action.remaining = shape->operand[node][0];
        SHD_PUSH(action);
        if (occ_kind[destination] == 2u)
            node_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
        else if (occ_kind[destination] == 1u)
            entry_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
        occ_kind[destination] = 2u;
        occ_value[destination] = node;
        node_home[node] = destination;
    }
    pl_u8 placed[PL_X86_SHARED_DAG_MAX_NODES + 1u] = { 0 };
    int progress = 1;
    while (progress) {
        progress = 0;
        for (pl_u32 node = 1u; node <= count; ++node) {
            pl_u32 final = shape->final_of_node[node];
            if (final == PL_X86_SHARED_DAG_NONE || placed[node]) continue;
            pl_u32 home = node_home[node];
            if (home == final) { placed[node] = 1u; progress = 1; continue; }
            if (home == PL_X86_SHARED_DAG_NONE) {
                if (stage) *stage = 0x2100u + node;
                return 0;
            }
            if (!shared_dag_available(
                    final, count + 1u, shape, occ_kind, occ_value))
                continue;
            shared_dag_action move = { 0 };
            move.kind = PL_X86_SHARED_DAG_FINAL_ACTION;
            move.node = node;
            move.destination = final;
            move.source = home;
            move.bits = shape->bits[node];
            SHD_PUSH(move);
            if (occ_kind[home] == 2u)
                node_home[occ_value[home]] = PL_X86_SHARED_DAG_NONE;
            occ_kind[final] = 2u;
            occ_value[final] = node;
            node_home[node] = final;
            if (home != final) occ_kind[home] = 0u;
            placed[node] = 1u;
            progress = 1;
        }
    }
    for (pl_u32 node = 1u; node <= count; ++node)
        if (shape->final_of_node[node] != PL_X86_SHARED_DAG_NONE
                && !placed[node]) {
            if (stage) *stage = 0x2300u + node;
            return 0;
        }
    if (shape->flag_node) {
        shared_dag_action flags = { 0 };
        flags.kind = PL_X86_SHARED_DAG_FLAG_ACTION;
        flags.node = shape->flag_node;
        SHD_PUSH(flags);
    }
#undef SHD_PUSH
    return 1;
}

static int shared_dag_place_finals(
    const shared_dag_shape *shape,
    pl_u32 occ_kind[PL_X86_GPR_COUNT], pl_u32 occ_value[PL_X86_GPR_COUNT],
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u],
    shared_dag_list *list)
{
    pl_u32 count = shape->node_count;
    /* Every generation that is not an observable final is dead at the
     * complete-future cut, so its coordinate is a free temporary for placing
     * the finals.  This is a lifetime fact, not a spill. */
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(shape->out_mask & (1u << local)) || occ_kind[local] == 0u)
            continue;
        if (occ_kind[local] == 2u
                && shape->node_last[occ_value[local]] > count + 1u)
            continue;
        if (occ_kind[local] == 2u)
            node_home[occ_value[local]] = PL_X86_SHARED_DAG_NONE;
        occ_kind[local] = 0u;
    }
    pl_u8 placed[PL_X86_SHARED_DAG_MAX_NODES + 1u] = { 0 };
    int progress = 1;
    while (progress) {
        progress = 0;
        for (pl_u32 node = 1u; node <= count; ++node) {
            pl_u32 final = shape->final_of_node[node];
            if (final == PL_X86_SHARED_DAG_NONE || placed[node]) continue;
            pl_u32 home = node_home[node];
            if (home == final) { placed[node] = 1u; progress = 1; continue; }
            if (home == PL_X86_SHARED_DAG_NONE) return 0;
            if (!shared_dag_available(
                    final, count + 1u, shape, occ_kind, occ_value))
                continue;
            if (list->count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return 0;
            shared_dag_action move = { 0 };
            move.kind = PL_X86_SHARED_DAG_FINAL_ACTION;
            move.node = node;
            move.destination = final;
            move.source = home;
            move.bits = shape->bits[node];
            list->action[list->count++] = move;
            if (occ_kind[home] == 2u)
                node_home[occ_value[home]] = PL_X86_SHARED_DAG_NONE;
            occ_kind[final] = 2u;
            occ_value[final] = node;
            node_home[node] = final;
            if (home != final) occ_kind[home] = 0u;
            placed[node] = 1u;
            progress = 1;
        }
    }
    for (pl_u32 node = 1u; node <= count; ++node)
        if (shape->final_of_node[node] != PL_X86_SHARED_DAG_NONE
                && !placed[node])
            return 0;
    return 1;
}

static pl_u32 shared_dag_step_cost(const shared_dag_shape *shape, pl_u32 node,
    pl_u32 destination, const pl_u32 *entry_home, const pl_u32 *node_home)
{
    if (shape->pair_node[node])
        return destination == shared_dag_holder(
            shape->operand[node][0], entry_home, node_home) ? 1u : 2u;
    for (pl_u32 at = 0u; at < shape->operand_count[node]; ++at) {
        pl_operand operand = shape->operand[node][at];
        if (shared_dag_last(operand, node, shape) > node) continue;
        if (shared_dag_holder(operand, entry_home, node_home) == destination)
            return 1u;
    }
    return 2u;
}

static int shared_dag_dest_seen(const pl_u32 *out, pl_u32 count, pl_u32 value)
{
    for (pl_u32 at = 0u; at < count; ++at)
        if (out[at] == value) return 1;
    return 0;
}

static pl_u32 shared_dag_collect_dests(
    const shared_dag_shape *shape, pl_u32 node,
    const pl_u32 *occ_kind, const pl_u32 *occ_value,
    const pl_u32 *entry_home, const pl_u32 *node_home,
    pl_u32 *out, pl_u32 capacity)
{
    pl_u32 count = 0u;
    pl_u32 final = shape->final_of_node[node];
    if (final != PL_X86_SHARED_DAG_NONE
            && shared_dag_available(final, node, shape, occ_kind, occ_value)
            && count < capacity)
        out[count++] = final;
    for (pl_u32 at = 0u; at < shape->operand_count[node]; ++at) {
        pl_operand operand = shape->operand[node][at];
        if (shared_dag_last(operand, node, shape) > node) continue;
        pl_u32 holder = shared_dag_holder(operand, entry_home, node_home);
        if (holder >= PL_X86_GPR_COUNT
                || shared_dag_dest_seen(out, count, holder)
                || !shared_dag_available(holder, node, shape, occ_kind, occ_value)
                || count >= capacity)
            continue;
        out[count++] = holder;
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (shared_dag_dest_seen(out, count, local)
                || !shared_dag_available(local, node, shape, occ_kind, occ_value)
                || count >= capacity)
            continue;
        out[count++] = local;
    }
    return count;
}

static void shared_dag_apply_node(
    pl_u32 node, pl_u32 destination,
    pl_u32 *occ_kind, pl_u32 *occ_value, pl_u32 *entry_home, pl_u32 *node_home)
{
    if (occ_kind[destination] == 2u)
        node_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
    else if (occ_kind[destination] == 1u)
        entry_home[occ_value[destination]] = PL_X86_SHARED_DAG_NONE;
    occ_kind[destination] = 2u;
    occ_value[destination] = node;
    node_home[node] = destination;
}

static void shared_dag_dfs(shared_dag_search *search,
    pl_u32 *occ_kind, pl_u32 *occ_value,
    pl_u32 *entry_home, pl_u32 *node_home,
    pl_u32 node, pl_u32 cost)
{
    const shared_dag_shape *shape = search->shape;
    pl_u32 count = shape->node_count;
    if (++search->expansions > search->budget) return;
    if (cost + (count - node + 1u) >= search->best_cost) return;
    if (node > count) {
        ++search->leaves;
        pl_u32 final_kind[PL_X86_GPR_COUNT], final_value[PL_X86_GPR_COUNT];
        pl_u32 final_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
        for (pl_u32 at = 0u; at < PL_X86_GPR_COUNT; ++at) {
            final_kind[at] = occ_kind[at];
            final_value[at] = occ_value[at];
        }
        for (pl_u32 at = 0u; at <= count; ++at) final_home[at] = node_home[at];
        shared_dag_list candidate = search->current;
        if (!shared_dag_place_finals(
                shape, final_kind, final_value, final_home, &candidate))
            return;
        ++search->finals_ok;
        pl_u32 total = cost + (candidate.count - search->current.count)
                     + (shape->flag_node ? 1u : 0u);
        if (total >= search->best_cost) return;
        if (shape->flag_node) {
            if (candidate.count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return;
            shared_dag_action flags = { 0 };
            flags.kind = PL_X86_SHARED_DAG_FLAG_ACTION;
            flags.node = shape->flag_node;
            candidate.action[candidate.count++] = flags;
        }
        search->best = candidate;
        search->best_cost = total;
        return;
    }
    if (node == shape->flag_node) {
        shared_dag_dfs(search, occ_kind, occ_value,
            entry_home, node_home, node + 1u, cost);
        return;
    }
    pl_u32 dests[8];
    pl_u32 dest_count = shared_dag_collect_dests(shape, node,
        occ_kind, occ_value, entry_home, node_home, dests, 8u);
    if (!dest_count) {
        pl_u32 victim = PL_X86_SHARED_DAG_NONE, victim_last = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(shape->out_mask & (1u << local)) || occ_kind[local] == 0u)
                continue;
            pl_u32 last = occ_kind[local] == 2u
                ? shape->node_last[occ_value[local]]
                : shape->entry_last[occ_value[local]];
            if (last <= node) continue;
            if (victim == PL_X86_SHARED_DAG_NONE || last > victim_last) {
                victim = local;
                victim_last = last;
            }
        }
        if (victim == PL_X86_SHARED_DAG_NONE) return;
        for (pl_u32 spare = 0u; spare < PL_X86_GPR_COUNT; ++spare) {
            if (spare == victim
                    || !shared_dag_available(
                        spare, node, shape, occ_kind, occ_value))
                continue;
            pl_u32 spare_kind[PL_X86_GPR_COUNT], spare_value[PL_X86_GPR_COUNT];
            pl_u32 spare_entry_home[PL_X86_GPR_COUNT];
            pl_u32 spare_node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
            for (pl_u32 at = 0u; at < PL_X86_GPR_COUNT; ++at) {
                spare_kind[at] = occ_kind[at];
                spare_value[at] = occ_value[at];
                spare_entry_home[at] = entry_home[at];
            }
            for (pl_u32 at = 0u; at <= count; ++at)
                spare_node_home[at] = node_home[at];
            if (search->current.count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return;
            shared_dag_action spill = { 0 };
            spill.kind = PL_X86_SHARED_DAG_SPILL_ACTION;
            spill.source = victim;
            spill.destination = spare;
            search->current.action[search->current.count++] = spill;
            spare_kind[spare] = spare_kind[victim];
            spare_value[spare] = spare_value[victim];
            if (spare_kind[victim] == 2u)
                spare_node_home[spare_value[victim]] = spare;
            else
                spare_entry_home[spare_value[victim]] = spare;
            spare_kind[victim] = 0u;
            shared_dag_dfs(search, spare_kind, spare_value,
                spare_entry_home, spare_node_home, node, cost + 1u);
            --search->current.count;
            return;
        }
        return;
    }
    for (pl_u32 at = 0u; at < dest_count; ++at) {
        pl_u32 destination = dests[at];
        pl_u32 step = shared_dag_step_cost(shape, node, destination,
            entry_home, node_home);
        pl_u32 next_kind[PL_X86_GPR_COUNT], next_value[PL_X86_GPR_COUNT];
        pl_u32 next_entry_home[PL_X86_GPR_COUNT];
        pl_u32 next_node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
        for (pl_u32 copy = 0u; copy < PL_X86_GPR_COUNT; ++copy) {
            next_kind[copy] = occ_kind[copy];
            next_value[copy] = occ_value[copy];
            next_entry_home[copy] = entry_home[copy];
        }
        for (pl_u32 copy = 0u; copy <= count; ++copy)
            next_node_home[copy] = node_home[copy];
        if (search->current.count >= PL_X86_SHARED_DAG_MAX_ACTIONS) return;
        shared_dag_action action = { 0 };
        action.kind = PL_X86_SHARED_DAG_NODE_ACTION;
        action.node = node;
        action.destination = destination;
        action.bits = shape->bits[node];
        action.pair_node = shape->pair_node[node];
        if (action.pair_node)
            action.remaining = shape->operand[node][0];
        search->current.action[search->current.count++] = action;
        shared_dag_apply_node(node, destination,
            next_kind, next_value, next_entry_home, next_node_home);
        shared_dag_dfs(search, next_kind, next_value,
            next_entry_home, next_node_home, node + 1u, cost + step);
        --search->current.count;
    }
}

static int shared_dag_allocate(const shared_dag_shape *shape,
                               shared_dag_list *list, pl_u32 *stage)
{
    if (!shape || !list) return 0;
    if (shared_dag_allocate_greedy(shape, list, stage)) {
        if (stage) *stage = 0u;
        return 1;
    }
    pl_u32 count = shape->node_count;
    pl_u32 occ_kind[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 occ_value[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 entry_home[PL_X86_GPR_COUNT];
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        entry_home[local] = local;
        occ_kind[local] = 1u;
        occ_value[local] = local;
    }
    for (pl_u32 node = 0u; node <= count; ++node)
        node_home[node] = PL_X86_SHARED_DAG_NONE;
    shared_dag_search search;
    search.shape = shape;
    search.best_cost = 0xffffffffu;
    search.current.count = 0u;
    search.expansions = 0u;
    /* This is a last-resort candidate search, not a completeness proof.
     * Exact linked x86 remains available when the bounded search finds no
     * spelling.  A per-block 50-million-state budget multiplied by every
     * ELF in a release turns publication into unbounded practical work. */
    search.budget = 32768u;
    search.leaves = 0u;
    search.finals_ok = 0u;
    shared_dag_dfs(&search, occ_kind, occ_value, entry_home, node_home, 1u, 0u);
    if (search.best_cost == 0xffffffffu) {
        if (stage) *stage = search.expansions > search.budget
            ? 0x41u : 0x40u;
        return 0;
    }
    *list = search.best;
    if (stage) *stage = 0u;
    return 1;
}

static void shared_dag_set_aliases(pl_x86_native_selection *selection,
                                   pl_u32 count, const pl_u32 *entry_home,
                                   const pl_u32 *node_home)
{
    selection->value_alias_count = 0u;
    for (pl_u32 node = 1u; node <= count
            && selection->value_alias_count < PL_X86_VALUE_ALIAS_COUNT;
            ++node) {
        if (node_home[node] == PL_X86_SHARED_DAG_NONE) continue;
        pl_u32 at = selection->value_alias_count++;
        selection->value_alias_kind[at] = PL_OPERAND_NODE;
        selection->value_alias_value[at] = node;
        selection->value_alias_local[at] = (pl_u8)node_home[node];
    }
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT
            && selection->value_alias_count < PL_X86_VALUE_ALIAS_COUNT;
            ++local) {
        if (entry_home[local] == PL_X86_SHARED_DAG_NONE
                || entry_home[local] == local)
            continue;
        pl_u32 at = selection->value_alias_count++;
        selection->value_alias_kind[at] = PL_OPERAND_LOCAL;
        selection->value_alias_value[at] = local;
        selection->value_alias_local[at] = (pl_u8)entry_home[local];
    }
}

static int shared_dag_replay(const pl_x86_block *block,
                             pl_x86_native_selection *selection,
                             const shared_dag_shape *shape,
                             const shared_dag_list *list,
                             const pl_x86_frontend *frontend,
                             pl_u8 *output, pl_u32 *bytes, pl_u32 *work)
{
    pl_u32 count = shape->node_count;
    pl_u32 occ_kind[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 occ_value[PL_X86_GPR_COUNT] = { 0u };
    pl_u32 entry_home[PL_X86_GPR_COUNT];
    pl_u32 node_home[PL_X86_SHARED_DAG_MAX_NODES + 1u];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        entry_home[local] = local;
        occ_kind[local] = 1u;
        occ_value[local] = local;
    }
    for (pl_u32 node = 0u; node <= count; ++node)
        node_home[node] = PL_X86_SHARED_DAG_NONE;
    pl_u32 at = 0u, total_work = 0u;
    for (pl_u32 index = 0u; index < list->count; ++index) {
        const shared_dag_action *action = &list->action[index];
        shared_dag_set_aliases(selection, count, entry_home, node_home);
        pl_u32 written = 0u, pieces = 0u, step_work = 0u;
        if (action->kind == PL_X86_SHARED_DAG_NODE_ACTION) {
            if (action->pair_node) {
                if (action->remaining.kind == PL_OPERAND_CONST)
                    return 0;
                pl_u32 remaining_home = shared_dag_holder(
                    action->remaining, entry_home, node_home);
                pl_u32 pair_home = node_home[action->pair_node];
                if (remaining_home >= PL_X86_GPR_COUNT
                        || pair_home >= PL_X86_GPR_COUNT)
                    return 0;
                pieces = 0u;
                if (action->destination != remaining_home
                        && !pl_select_emit_gpr_move(
                            action->destination, remaining_home,
                            action->bits, output ? output + at : 0, &pieces))
                    return 0;
                pl_u32 add_bytes = 0u;
                if (!pl_select_emit_alu_instruction(
                        action->destination,
                        (pl_operand){ PL_OPERAND_LOCAL, pair_home },
                        action->bits, 1u, 0u,
                        output ? output + at + pieces : 0, &add_bytes))
                    return 0;
                written = pieces + add_bytes;
                step_work = action->destination == remaining_home ? 1u : 2u;
            } else {
                pl_operand value = { PL_OPERAND_NODE, action->node };
                if (frontend) {
                    int measured = pl_select_measure_alu_tree(
                        frontend, block, selection, action->destination,
                        value, action->bits, at, count + 1u, 0u,
                        &written, &step_work);
                    if (measured <= 0) return 0;
                } else {
                    if (!pl_select_write_alu_tree(
                            block, selection, action->destination, value,
                            action->bits, at, count + 1u, 0u,
                            output + at, &written))
                        return 0;
                    step_work = 1u;
                }
            }
            if (occ_kind[action->destination] == 2u)
                node_home[occ_value[action->destination]]
                    = PL_X86_SHARED_DAG_NONE;
            else if (occ_kind[action->destination] == 1u)
                entry_home[occ_value[action->destination]]
                    = PL_X86_SHARED_DAG_NONE;
            occ_kind[action->destination] = 2u;
            occ_value[action->destination] = action->node;
            node_home[action->node] = action->destination;
        } else if (action->kind == PL_X86_SHARED_DAG_SPILL_ACTION) {
            if (!pl_select_emit_gpr_move(
                    action->destination, action->source, 64u,
                    output ? output + at : 0, &written))
                return 0;
            step_work = 1u;
            occ_kind[action->destination] = occ_kind[action->source];
            occ_value[action->destination] = occ_value[action->source];
            if (occ_kind[action->source] == 2u)
                node_home[occ_value[action->source]] = action->destination;
            else
                entry_home[occ_value[action->source]] = action->destination;
            occ_kind[action->source] = 0u;
        } else if (action->kind == PL_X86_SHARED_DAG_FINAL_ACTION) {
            if (!pl_select_emit_gpr_move(
                    action->destination, action->source, action->bits,
                    output ? output + at : 0, &written))
                return 0;
            step_work = 1u;
            if (occ_kind[action->source] == 2u)
                node_home[occ_value[action->source]] = PL_X86_SHARED_DAG_NONE;
            occ_kind[action->destination] = 2u;
            occ_value[action->destination] = action->node;
            node_home[action->node] = action->destination;
            if (action->source != action->destination)
                occ_kind[action->source] = 0u;
        } else {
            standalone_flag_publication publication;
            if (!pl_select_standalone_flag_publication_details(
                    &block->plan, action->node, &publication)
                    || !pl_select_emit_standalone_flag_publication(
                        &publication, output ? output + at : 0, &written))
                return 0;
            step_work = 1u;
        }
        if (written > U32_MAX_VALUE - at
                || step_work > U32_MAX_VALUE - total_work)
            return PL_ERROR_X86_SELECT;
        at += written;
        total_work += step_work;
    }
    *bytes = at;
    *work = total_work;
    return 1;
}

int pl_select_measure_direct_shared_dag_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u;
        if (!pl_select_conditional_alu_body(block, &body, &condition)) return 0;
        int measured = pl_select_measure_direct_shared_dag_frame(
            frontend, &body, selection);
        if (measured <= 0) return measured;
        pl_u32 tail = block->relax_short_control ? 6u : 2u;
        pl_u32 bytes = selection->output_bytes;
        if (bytes > U32_MAX_VALUE - tail
                || selection->output_instructions == U32_MAX_VALUE)
            return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(
            frontend, block, selection,
            (pl_u8)(block->relax_short_control ? 4u : 1u),
            bytes + (block->relax_short_control ? 2u : 1u),
            bytes + tail, block->successor[0]);
        if (status) return status;
        selection->output_bytes = bytes + tail;
        ++selection->output_instructions;
        selection->direct_frame = 1u;
        selection->direct_shared_dag_frame = 1u;
        selection->reason = PL_X86_NATIVE_SELECT_READY;
        return 1;
    }
    if (block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->source_identity)
        return 0;
    shared_dag_shape shape;
    shared_dag_list list;
    if (!shared_dag_shape_build(block, &shape)
            || !shared_dag_allocate(&shape, &list, 0))
        return 0;
    pl_u32 bytes = 0u, work = 0u;
    if (!shared_dag_replay(
            block, selection, &shape, &list, frontend, 0, &bytes, &work)
            || !bytes || !work)
        return 0;
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    selection->output_bytes = bytes;
    selection->output_instructions = work;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shared_dag_frame = 1u;
    selection->direct_nested_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_shared_dag_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shared_dag_frame
            || !output)
        return PL_ERROR_X86_SELECT;
    if (block->flow == PL_X86_FLOW_CONDITIONAL) {
        pl_x86_block body;
        pl_u32 condition = 0u;
        pl_u32 tail = block->relax_short_control ? 6u : 2u;
        if (!pl_select_conditional_alu_body(block, &body, &condition)
                || selection->output_bytes < tail)
            return PL_ERROR_X86_SELECT;
        pl_x86_native_selection body_selection = *selection;
        body_selection.output_bytes -= tail;
        int status = pl_select_write_direct_shared_dag_frame(
            &body, &body_selection, output);
        if (status) return status;
        pl_u32 at = body_selection.output_bytes;
        if (block->relax_short_control) output[at++] = 0x0fu;
        output[at++] = (pl_u8)((block->relax_short_control ? 0x80u : 0x70u)
                               | condition);
        while (at < selection->output_bytes) output[at++] = 0u;
        return 0;
    }
    if (block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->source_identity)
        return PL_ERROR_X86_SELECT;
    shared_dag_shape shape;
    shared_dag_list list;
    if (!shared_dag_shape_build(block, &shape)
            || !shared_dag_allocate(&shape, &list, 0))
        return PL_ERROR_X86_SELECT;
    pl_u32 bytes = 0u, work = 0u;
    pl_x86_native_selection mutable = *selection;
    if (!shared_dag_replay(
            block, &mutable, &shape, &list, 0, output, &bytes, &work)
            || bytes != selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    return 0;
}
