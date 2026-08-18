/* The affinity argument.  See include/postlink/affine.h. */

#include <postlink/affine.h>

#define PL_PROJECTION_SELECTOR_BITS 8u

/* A value as the analysis understands it: a constant, or `slot * 1 + offset`
 * for one local slot, or nothing it can describe. */
typedef enum {
    VALUE_CONST = 0,
    VALUE_SLOT,      /* base slot plus a constant offset */
    VALUE_OPAQUE,
} value_kind;

typedef struct {
    value_kind kind;
    pl_u32 slot;
    pl_i64 offset;
} value;

static value opaque(void)
{
    value result;
    result.kind = VALUE_OPAQUE;
    result.slot = 0;
    result.offset = 0;
    return result;
}

static value constant_value(pl_i64 amount)
{
    value result;
    result.kind = VALUE_CONST;
    result.slot = 0;
    result.offset = amount;
    return result;
}

static value slot_value(pl_u32 slot, pl_i64 offset)
{
    value result;
    result.kind = VALUE_SLOT;
    result.slot = slot;
    result.offset = offset;
    return result;
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
    if (!add && !subtract) return opaque();
    if (left.kind == VALUE_OPAQUE || right.kind == VALUE_OPAQUE)
        return opaque();

    if (add) {
        if (left.kind == VALUE_CONST && right.kind == VALUE_CONST)
            return constant_value(left.offset + right.offset);
        if (left.kind == VALUE_SLOT && right.kind == VALUE_CONST)
            return slot_value(left.slot, left.offset + right.offset);
        if (left.kind == VALUE_CONST && right.kind == VALUE_SLOT)
            return slot_value(right.slot, left.offset + right.offset);
        return opaque();          /* slot + slot is not affine in one slot */
    }
    if (left.kind == VALUE_CONST && right.kind == VALUE_CONST)
        return constant_value(left.offset - right.offset);
    if (left.kind == VALUE_SLOT && right.kind == VALUE_CONST)
        return slot_value(left.slot, left.offset - right.offset);
    if (left.kind == VALUE_SLOT && right.kind == VALUE_SLOT
            && left.slot == right.slot)
        return constant_value(left.offset - right.offset);
    return opaque();
}

int pl_affine_analyse(const pl_plan *body, pl_arena *arena, pl_affine *out)
{
    value *of_node = pl_arena_take(
        arena, (body->node_count + 1u) * (pl_u32)sizeof *of_node);
    out->slots = pl_arena_take(
        arena, (body->local_count ? body->local_count : 1u)
               * (pl_u32)sizeof *out->slots);
    if (!of_node || !out->slots) return PL_ERROR_ARENA;

    out->verdict = PL_AFFINE_OK;
    out->induction = 0;
    out->step = 0;
    out->opaque_slot = 0;
    out->slot_count = body->local_count;
    out->memory_nodes = 0;
    out->affine_addresses = 0;

    /* Every local starts as itself: slot + 0. */
    of_node[0] = opaque();
    for (pl_u32 index = 0; index < body->node_count; ++index) {
        const pl_node *node = &body->nodes[index];
        value arguments[2];
        pl_u32 taken = 0;
        for (pl_u32 slot = 0; slot < node->argument_count && taken < 2u;
             ++slot) {
            pl_operand operand = body->arguments[node->argument_at + slot];
            if (operand.kind == PL_OPERAND_CONST)
                arguments[taken++] = constant_value((pl_i64)operand.value);
            else if (operand.kind == PL_OPERAND_LOCAL)
                arguments[taken++] = slot_value((pl_u32)operand.value, 0);
            else if (operand.kind == PL_OPERAND_NODE
                     && operand.value && operand.value <= body->node_count)
                arguments[taken++] = of_node[operand.value];
            else
                arguments[taken++] = opaque();
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
        value settled;
        if (after.kind == PL_OPERAND_LOCAL)
            settled = slot_value((pl_u32)after.value, 0);
        else if (after.kind == PL_OPERAND_CONST)
            settled = constant_value((pl_i64)after.value);
        else if (after.kind == PL_OPERAND_NODE
                 && after.value && after.value <= body->node_count)
            settled = of_node[after.value];
        else
            settled = opaque();

        if (settled.kind == VALUE_SLOT && settled.slot == slot) {
            if (!settled.offset) {
                out->slots[slot].kind = PL_AFFINE_FIXED;
                out->slots[slot].step = 0;
            } else {
                out->slots[slot].kind = PL_AFFINE_STEP;
                out->slots[slot].step = settled.offset;
                advancing += 1u;
                out->induction = slot;
                out->step = settled.offset;
            }
            continue;
        }
        out->slots[slot].kind = PL_AFFINE_OPAQUE;
        out->slots[slot].step = 0;
        if (out->verdict == PL_AFFINE_OK) {
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
