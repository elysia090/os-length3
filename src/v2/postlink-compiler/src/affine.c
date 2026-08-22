/* The affinity argument.  See include/postlink/affine.h. */

#include <postlink/affine.h>

#define PL_PROJECTION_SELECTOR_BITS 8u
#define PL_PROJECTION_SELECTOR_MASK 0xffu

/* A value as the analysis understands it.  Four terms cover x86 effective
 * addresses (base + index * scale + displacement) with room for one composed
 * affine addend, while keeping the proof freestanding and allocation-free per
 * value.  Exceeding the bound refuses the candidate; it never approximates. */
#define VALUE_TERMS 4u

typedef enum {
    VALUE_CONST = 0,
    VALUE_AFFINE,
    VALUE_OPAQUE,
} value_kind;

typedef struct {
    pl_u32 slot;
    pl_u64 scale;
} value_term;

typedef struct {
    value_kind kind;
    pl_u32 term_count;
    pl_u64 offset;
    value_term term[VALUE_TERMS];
} value;

static value opaque(void)
{
    value result;
    result.kind = VALUE_OPAQUE;
    result.term_count = 0;
    result.offset = 0;
    return result;
}

static value constant_value(pl_u64 amount)
{
    value result;
    result.kind = VALUE_CONST;
    result.term_count = 0;
    result.offset = amount;
    return result;
}

static value slot_value(pl_u32 slot, pl_u64 offset)
{
    value result;
    result.kind = VALUE_AFFINE;
    result.term_count = 1u;
    result.offset = offset;
    result.term[0].slot = slot;
    result.term[0].scale = 1u;
    return result;
}

static int add_term(value *out, pl_u32 slot, pl_u64 scale)
{
    if (!scale) return 1;
    for (pl_u32 index = 0u; index < out->term_count; ++index) {
        if (out->term[index].slot != slot) continue;
        out->term[index].scale += scale;
        if (!out->term[index].scale) {
            out->term_count -= 1u;
            for (pl_u32 move = index; move < out->term_count; ++move)
                out->term[move] = out->term[move + 1u];
        }
        return 1;
    }
    if (out->term_count >= VALUE_TERMS) return 0;
    pl_u32 at = out->term_count++;
    while (at && out->term[at - 1u].slot > slot) {
        out->term[at] = out->term[at - 1u];
        at -= 1u;
    }
    out->term[at].slot = slot;
    out->term[at].scale = scale;
    return 1;
}

static value scaled(value in, pl_u64 scale)
{
    if (in.kind == VALUE_OPAQUE) return in;
    in.offset *= scale;
    for (pl_u32 index = 0u; index < in.term_count; ++index)
        in.term[index].scale *= scale;
    pl_u32 write = 0u;
    for (pl_u32 index = 0u; index < in.term_count; ++index) {
        if (!in.term[index].scale) continue;
        in.term[write++] = in.term[index];
    }
    in.term_count = write;
    in.kind = write ? VALUE_AFFINE : VALUE_CONST;
    return in;
}

/* Only the operations that can keep a value affine are modelled.  Anything
 * else makes the value opaque, which is a refusal rather than an approximation:
 * an unmodelled operation must not be mistaken for an affine one. */
static value combine(pl_u32 opcode, value left, value right)
{
    int add = opcode == PL_OPCODE_ALU_IMMEDIATE[1][1]      /* lane64.ADD  */
           || opcode == PL_OPCODE_ALU_IMMEDIATE[0][1]      /* lane32.ADD  */
           || opcode == PL_OPCODE_ALU_REGISTER[1][1]       /* lane64.ADDR */
           || opcode == PL_OPCODE_ALU_REGISTER[0][1];
    int subtract = opcode == PL_OPCODE_ALU_IMMEDIATE[1][2]
                || opcode == PL_OPCODE_ALU_IMMEDIATE[0][2]
                || opcode == PL_OPCODE_ALU_REGISTER[1][2]
                || opcode == PL_OPCODE_ALU_REGISTER[0][2];
    int shift = opcode == 82u;                 /* lane64.SHL */
    int multiply = opcode == 74u || opcode == 120u;
    if (shift) {
        if (right.kind != VALUE_CONST) return opaque();
        return scaled(left, 1ull << (right.offset & 63u));
    }
    if (multiply) {
        if (right.kind == VALUE_CONST) return scaled(left, right.offset);
        if (left.kind == VALUE_CONST) return scaled(right, left.offset);
        return opaque();
    }
    if (!add && !subtract) return opaque();
    if (left.kind == VALUE_OPAQUE || right.kind == VALUE_OPAQUE)
        return opaque();

    value result = left;
    pl_u64 sign = subtract ? ~0ull : 1ull;
    result.offset += right.offset * sign;
    for (pl_u32 index = 0u; index < right.term_count; ++index) {
        if (!add_term(&result, right.term[index].slot,
                      right.term[index].scale * sign))
            return opaque();
    }
    result.kind = result.term_count ? VALUE_AFFINE : VALUE_CONST;
    return result;
}

static value operand_value(const pl_plan *body, const value *of_node,
                           pl_operand operand, pl_u32 before_node);

/* Selector 16 is the ordinary integer result fused into X86_ALU.  Treating it
 * as opaque here would reintroduce the scalar spelling after normalization:
 * the same pointer update was affine before the ALU and remains affine after
 * flags and result have been physically shared. */
static value projection_value(const pl_plan *body, const value *of_node,
                              pl_operand operand, pl_u32 before_node)
{
    pl_u32 source = (pl_u32)(operand.value
                             >> PL_PROJECTION_SELECTOR_BITS);
    pl_u32 selector = (pl_u32)operand.value
                    & PL_PROJECTION_SELECTOR_MASK;
    if (!source || source > body->node_count || source >= before_node)
        return opaque();
    const pl_node *node = &body->nodes[source - 1u];
    if (selector != 16u
            || (node->opcode != PL_OPCODE_X86_ALU
                && node->opcode != PL_OPCODE_X86_AFFINE_ALU))
        return opaque();

    const pl_operand *argument = &body->arguments[node->argument_at];
    pl_u32 descriptor_at = node->opcode == PL_OPCODE_X86_AFFINE_ALU
                         ? 4u : 3u;
    if (node->argument_count != descriptor_at + 1u
            || argument[descriptor_at].kind != PL_OPERAND_CONST)
        return opaque();
    pl_u64 descriptor = argument[descriptor_at].value;
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 mode = (pl_u32)(descriptor >> 8u) & 7u;
    /* A sub-word x86 write includes a truncation.  It is not equal to a
     * 64-bit local translation for an arbitrary entry value, so leave it for
     * the modular recurrence proof rather than silently dropping the mask. */
    if (width != 64u || (mode != 1u && mode != 3u)) return opaque();

    value left = operand_value(body, of_node, argument[1], source);
    pl_u32 right_at = 2u;
    if (node->opcode == PL_OPCODE_X86_AFFINE_ALU) {
        value addend = operand_value(body, of_node, argument[2], source);
        left = combine(PL_OPCODE_ADD, left, addend);
        right_at = 3u;
    }
    value right = operand_value(body, of_node, argument[right_at], source);
    return combine(mode == 1u ? PL_OPCODE_ADD
                              : PL_OPCODE_ALU_IMMEDIATE[1][2],
                   left, right);
}

static value operand_value(const pl_plan *body, const value *of_node,
                           pl_operand operand, pl_u32 before_node)
{
    if (operand.kind == PL_OPERAND_CONST)
        return constant_value(operand.value);
    if (operand.kind == PL_OPERAND_LOCAL
            && operand.value < body->local_count)
        return slot_value((pl_u32)operand.value, 0);
    if (operand.kind == PL_OPERAND_NODE && operand.value
            && operand.value < before_node
            && operand.value <= body->node_count)
        return of_node[operand.value];
    if (operand.kind == PL_OPERAND_PROJECTION)
        return projection_value(body, of_node, operand, before_node);
    return opaque();
}

static int mark_operand(const pl_plan *body, pl_operand operand,
                        pl_u8 *slot_live, pl_u8 *node_live)
{
    if (operand.kind == PL_OPERAND_CONST) return 0;
    if (operand.kind == PL_OPERAND_LOCAL) {
        if (operand.value >= body->local_count) return PL_ERROR_PLAN;
        slot_live[operand.value] = 1u;
        return 0;
    }
    if (operand.kind == PL_OPERAND_NODE) {
        if (!operand.value || operand.value > body->node_count)
            return PL_ERROR_PLAN;
        node_live[operand.value - 1u] = 1u;
        return 0;
    }
    if (operand.kind == PL_OPERAND_PROJECTION) {
        pl_u64 source = operand.value >> PL_PROJECTION_SELECTOR_BITS;
        if (!source || source > body->node_count) return PL_ERROR_PLAN;
        node_live[source - 1u] = 1u;
        return 0;
    }
    return PL_ERROR_PLAN;
}

/* Close the smallest state that must cross an internal backedge.  Effects and
 * the branch predicate are observations.  Whenever they read an input local,
 * that local's post-body value becomes an observation for the next iteration;
 * iterating this rule is the residual fixed point. */
static int build_cut(const pl_plan *body, pl_u32 predicate_local,
                     pl_u8 *slot_live, pl_u8 *node_live,
                     pl_u32 *slot_count, pl_u32 *node_count)
{
    if (predicate_local >= body->local_count) return PL_ERROR_PLAN;
    for (pl_u32 slot = 0u; slot < body->local_count; ++slot)
        slot_live[slot] = 0u;
    for (pl_u32 index = 0u; index < body->node_count; ++index) {
        node_live[index] = (pl_u8)(
            pl_opcode_is_memory(body->nodes[index].opcode)
            || pl_opcode_traps(body->nodes[index].opcode));
    }

    pl_u32 prior_slots = ~0u;
    pl_u32 prior_nodes = ~0u;
    for (;;) {
        int status = mark_operand(
            body, body->locals[predicate_local], slot_live, node_live);
        if (status) return status;
        for (pl_u32 slot = 0u; slot < body->local_count; ++slot) {
            if (!slot_live[slot]) continue;
            status = mark_operand(
                body, body->locals[slot], slot_live, node_live);
            if (status) return status;
        }
        for (pl_u32 cursor = body->node_count; cursor; --cursor) {
            pl_u32 index = cursor - 1u;
            if (!node_live[index]) continue;
            const pl_node *node = &body->nodes[index];
            for (pl_u32 at = 0u; at < node->argument_count; ++at) {
                status = mark_operand(
                    body, body->arguments[node->argument_at + at],
                    slot_live, node_live);
                if (status) return status;
            }
        }

        pl_u32 slots = 0u, nodes = 0u;
        for (pl_u32 slot = 0u; slot < body->local_count; ++slot)
            slots += slot_live[slot] != 0u;
        for (pl_u32 index = 0u; index < body->node_count; ++index)
            nodes += node_live[index] != 0u;
        if (slots == prior_slots && nodes == prior_nodes) {
            *slot_count = slots;
            *node_count = nodes;
            return 0;
        }
        prior_slots = slots;
        prior_nodes = nodes;
    }
}

static int analyse(const pl_plan *body, pl_u32 predicate_local, int cut_only,
                   pl_arena *arena, pl_affine *out)
{
    value *of_node = pl_arena_take(
        arena, (body->node_count + 1u) * (pl_u32)sizeof *of_node);
    out->slots = pl_arena_take(
        arena, (body->local_count ? body->local_count : 1u)
               * (pl_u32)sizeof *out->slots);
    out->cut_slots = pl_arena_take(
        arena, body->local_count ? body->local_count : 1u);
    out->cut_nodes = pl_arena_take(
        arena, body->node_count ? body->node_count : 1u);
    if (!of_node || !out->slots || !out->cut_slots || !out->cut_nodes)
        return PL_ERROR_ARENA;

    out->verdict = PL_AFFINE_OK;
    out->induction = 0;
    out->step = 0;
    out->opaque_slot = 0;
    out->slot_count = body->local_count;
    out->memory_nodes = 0;
    out->affine_addresses = 0;
    out->cut_slot_count = 0u;
    out->cut_node_count = 0u;

    if (cut_only) {
        int status = build_cut(
            body, predicate_local, out->cut_slots, out->cut_nodes,
            &out->cut_slot_count, &out->cut_node_count);
        if (status) return status;
    } else {
        for (pl_u32 slot = 0u; slot < body->local_count; ++slot)
            out->cut_slots[slot] = 1u;
        for (pl_u32 index = 0u; index < body->node_count; ++index)
            out->cut_nodes[index] = 1u;
        out->cut_slot_count = body->local_count;
        out->cut_node_count = body->node_count;
    }

    /* Every local starts as itself: slot + 0. */
    of_node[0] = opaque();
    for (pl_u32 index = 0; index < body->node_count; ++index) {
        const pl_node *node = &body->nodes[index];
        value arguments[2];
        pl_u32 taken = 0;
        for (pl_u32 slot = 0; slot < node->argument_count && taken < 2u;
             ++slot) {
            pl_operand operand = body->arguments[node->argument_at + slot];
            arguments[taken++] = operand_value(
                body, of_node, operand, index + 1u);
        }
        of_node[index + 1u] =
            (node->argument_count == 2u && taken == 2u)
            ? combine(node->opcode, arguments[0], arguments[1])
            : opaque();

        /* An address the body touches has to be affine in the counter too, or
         * the collapsed transaction would name the wrong bytes. */
        if (pl_opcode_is_memory(node->opcode)) {
            out->memory_nodes += 1u;
            if (node->argument_count && taken
                    && arguments[0].kind != VALUE_OPAQUE)
                out->affine_addresses += 1u;
        }
    }

    /* Now read each local's value after the body. */
    pl_u32 advancing = 0;
    for (pl_u32 slot = 0; slot < body->local_count; ++slot) {
        pl_operand after = body->locals[slot];
        value settled = operand_value(
            body, of_node, after, body->node_count + 1u);

        if (settled.kind == VALUE_AFFINE && settled.term_count == 1u
                && settled.term[0].slot == slot
                && settled.term[0].scale == 1u) {
            if (!settled.offset) {
                out->slots[slot].kind = PL_AFFINE_FIXED;
                out->slots[slot].step = 0;
            } else {
                out->slots[slot].kind = PL_AFFINE_STEP;
                out->slots[slot].step = (pl_i64)settled.offset;
                if (out->cut_slots[slot]) {
                    advancing += 1u;
                    out->induction = slot;
                    out->step = (pl_i64)settled.offset;
                }
            }
            continue;
        }
        out->slots[slot].kind = PL_AFFINE_OPAQUE;
        out->slots[slot].step = 0;
        /* The terminal flags word is a finite-query residual, not an integer
         * induction lane.  Its selected condition is consumed at the
         * backedge and the final ordinary iteration materializes the complete
         * architectural word.  A non-affine flags value therefore does not
         * invalidate an otherwise affine coordinate transaction; any carry
         * dependency that changes a coordinate still makes that coordinate's
         * own output opaque and is refused there. */
        int terminal_predicate = cut_only && slot == predicate_local;
        if (out->cut_slots[slot] && !terminal_predicate
                && out->verdict == PL_AFFINE_OK) {
            out->verdict = PL_AFFINE_OPAQUE_SLOT;
            out->opaque_slot = slot;
        }
    }

    if (out->verdict != PL_AFFINE_OK) return 0;
    if (!advancing) {
        out->verdict = PL_AFFINE_NO_INDUCTION;
        return 0;
    }
    if (advancing > 1u) {
        out->verdict = PL_AFFINE_MANY_INDUCTIONS;
        return 0;
    }
    if (out->memory_nodes != out->affine_addresses) {
        out->verdict = PL_AFFINE_OPAQUE_ADDRESS;
        return 0;
    }
    return 0;
}

int pl_affine_analyse(const pl_plan *body, pl_arena *arena, pl_affine *out)
{
    return analyse(body, 0u, 0, arena, out);
}

int pl_affine_analyse_cut(const pl_plan *body, pl_u32 predicate_local,
                          pl_arena *arena, pl_affine *out)
{
    return analyse(body, predicate_local, 1, arena, out);
}

const char *pl_affine_reason(pl_affine_verdict verdict)
{
    switch (verdict) {
    case PL_AFFINE_OK:              return "affine in one induction variable";
    case PL_AFFINE_NO_INDUCTION:    return "no slot advances";
    case PL_AFFINE_MANY_INDUCTIONS: return "more than one slot advances";
    case PL_AFFINE_OPAQUE_SLOT:     return "a slot changes some other way";
    case PL_AFFINE_OPAQUE_ADDRESS:  return "an address is not affine";
    case PL_AFFINE_UNSUPPORTED:     return "the body carries something unmodelled";
    default:                        return "unknown";
    }
}
