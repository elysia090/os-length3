/* Prove and emit native LEA address expressions. */
#include "lea.h"
#include "limits.h"
#include "encoding.h"
#include "expressions.h"
#include "flags.h"

int pl_select_append_affine_local(affine_lea *out, pl_u32 local,
                               pl_u32 scale_log2)
{
    if (!out || local >= PL_X86_GPR_COUNT || out->count >= 2u
            || scale_log2 > 3u)
        return 0;
    out->local[out->count] = local;
    out->scale_log2[out->count] = (pl_u8)scale_log2;
    ++out->count;
    return 1;
}

int pl_select_collect_affine_lea_width(const pl_plan *plan, pl_operand value,
                                    pl_u32 bits, pl_u32 remaining,
                                    affine_lea *out)
{
    if (!plan || !out || !remaining) return 0;
    if (value.kind == PL_OPERAND_CONST) {
        out->displacement += value.value;
        return 1;
    }
    if (value.kind == PL_OPERAND_LOCAL) {
        return pl_select_append_affine_local(out, (pl_u32)value.value, 0u);
    }
    /* Physical normalization closes (a + b) + k into one ADD3 node.  Native
     * selection must consume that normal form directly; otherwise the
     * stronger quotient perversely falls back to the original LEA spelling.
     * ADD3 is the associative/commutative word-sum law, so its three leaves
     * are exactly one x86 addressing coordinate when they contain at most two
     * registers and one encodable displacement. */
    if (value.kind == PL_OPERAND_NODE && value.value
            && value.value <= plan->node_count) {
        const pl_node *node = &plan->nodes[value.value - 1u];
        /* A 32-bit LEA result is the low word of the 64-bit address sum, so a
         * 64-bit ADD3 is a valid 32-bit address coordinate as well. */
        if ((node->opcode == PL_OPCODE_ADD3[bits == 64u ? 1u : 0u]
                || (bits == 32u && node->opcode == PL_OPCODE_ADD3[1]))
                && node->argument_count == 3u
                && node->argument_at <= plan->argument_count
                && node->argument_count
                   <= plan->argument_count - node->argument_at) {
            for (pl_u32 argument = 0u; argument < 3u; ++argument)
                if (!pl_select_collect_affine_lea_width(
                        plan, plan->arguments[node->argument_at + argument],
                        bits, remaining - 1u, out))
                    return 0;
            return 1;
        }
        /* A scaled word is an x86 addressing coordinate, not a materialized
         * SHIFT result.  Resolve an already-published normalized subvalue to
         * its physical GPR and retain the scale in the affine form so
         * `(x << k) + c` remains one LEA after SSA substitution. */
        pl_operand source, amount;
        pl_u32 shift_bits = 0u, group = 0u;
        if (pl_select_shift_node_details(
                plan, value, &source, &amount, &shift_bits, &group)
                /* A 32-bit LEA result is the low word of the 64-bit address
                 * sum, so low32(x<<k) and low32(x)<<k are identical.  Keep
                 * the architectural 64-bit index coordinate instead of
                 * materializing SHL64 + ADD32 + MOV32. */
                && (shift_bits == bits
                    || (bits == 32u && shift_bits == 64u))
                && group == 4u
                && amount.kind == PL_OPERAND_CONST
                && amount.value && amount.value <= 3u) {
            pl_u32 local = PL_X86_GPR_COUNT;
            if (source.kind == PL_OPERAND_LOCAL
                    && source.value < PL_X86_GPR_COUNT) {
                local = (pl_u32)source.value;
            } else if (!pl_select_published_operand_local(plan, source, &local)) {
                return 0;
            }
            return pl_select_append_affine_local(
                out, local, (pl_u32)amount.value);
        }
    }
    pl_operand left, right;
    pl_u32 node_bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &left, &right, &node_bits, &mode)
            || mode != 1u
            || (node_bits != bits && !(bits == 32u && node_bits == 64u)))
        return 0;
    return pl_select_collect_affine_lea_width(
               plan, left, bits, remaining - 1u, out)
        && pl_select_collect_affine_lea_width(
               plan, right, bits, remaining - 1u, out);
}

int pl_select_collect_affine_lea(const pl_plan *plan, pl_operand value,
                              pl_u32 remaining, affine_lea *out)
{
    return pl_select_collect_affine_lea_width(plan, value, 64u, remaining, out);
}

/* A normalized x86 word expression retains its architectural width. Try the
 * wide affine spelling first; use a narrow spelling only for an actual
 * 32-bit semantic result. Otherwise a wide address with a narrow index can
 * be truncated merely because its low word also has an affine spelling. */
int pl_select_collect_native_affine_lea(
    const pl_plan *plan, pl_operand value, pl_u32 remaining,
    affine_lea *out, pl_u32 *bits)
{
    if (!out || !bits) return 0;
    *out = (affine_lea){ 0 };
    if (pl_select_collect_affine_lea_width(plan, value, 64u, remaining, out)) {
        *bits = 64u;
        return 1;
    }
    /* A low-word affine spelling is only a valid publication when the
     * semantic value is itself 32-bit. A 64-bit address may contain a
     * zero-extended 32-bit index, but LEA EDI would discard the high half
     * of its 64-bit base (for example a stack pointer). */
    if (pl_select_operand_expression_bits(plan, value, 64u) != 32u) return 0;
    *out = (affine_lea){ 0 };
    if (pl_select_collect_affine_lea_width(plan, value, 32u, remaining, out)) {
        *bits = 32u;
        return 1;
    }
    return 0;
}

int pl_select_emit_affine_lea_width(pl_u32 destination, affine_lea form,
                                 pl_u32 bits, pl_u8 *output,
                                 pl_u32 *written)
{
    if (!written || destination >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u)
            || !form.count || form.count > 2u
            || (bits == 64u && form.displacement > I32_MAX_VALUE
                && form.displacement < 0xffffffff80000000ull))
        return 0;
    pl_u32 scaled = 0u;
    for (pl_u32 at = 0u; at < form.count; ++at)
        if (form.scale_log2[at]) {
            if (form.scale_log2[scaled] && scaled != at) return 0;
            scaled = at;
        }
    int no_base = form.count == 1u && form.scale_log2[0];
    pl_u32 base = no_base ? 5u : form.local[0];
    pl_u32 index = 0u, scale_log2 = 0u;
    if (no_base) {
        index = form.local[0];
        scale_log2 = form.scale_log2[0];
    } else if (form.count == 2u) {
        pl_u32 index_at = form.scale_log2[1] ? 1u
                        : form.scale_log2[0] ? 0u
                        : 1u;
        pl_u32 base_at = index_at ^ 1u;
        base = form.local[base_at];
        index = form.local[index_at];
        scale_log2 = form.scale_log2[index_at];
        if (!scale_log2 && (index & 7u) == 4u) {
            pl_u32 swap = base; base = index; index = swap;
        }
    }
    if ((!no_base && base >= PL_X86_GPR_COUNT)
            || ((no_base || form.count == 2u)
                && (index >= PL_X86_GPR_COUNT || (index & 7u) == 4u)))
        return 0;
    pl_u32 low = (pl_u32)form.displacement;
    pl_u32 displacement_bytes = no_base ? 4u : !low ? 0u
        : (low <= 0x7fu || low >= 0xffffff80u) ? 1u : 4u;
    pl_u32 base_low = base & 7u;
    pl_u32 mod = no_base ? 0u
               : !displacement_bytes && base_low != 5u ? 0u
               : displacement_bytes <= 1u ? 1u : 2u;
    pl_u32 sib = no_base || form.count == 2u || base_low == 4u;
    pl_u32 at = 0u;
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
                              | (destination >= 8u ? 4u : 0u)
                              | ((no_base || form.count == 2u)
                                 && index >= 8u ? 2u : 0u)
                              | (!no_base && base >= 8u ? 1u : 0u));
    if (rex != 0x40u) {
        if (output) output[at] = rex;
        ++at;
    }
    if (output) output[at] = 0x8du;
    ++at;
    if (output)
        output[at] = (pl_u8)((mod << 6u) | ((destination & 7u) << 3u)
                            | (sib ? 4u : base_low));
    ++at;
    if (sib) {
        pl_u32 index_low = no_base || form.count == 2u ? index & 7u : 4u;
        if (output)
            output[at] = (pl_u8)((scale_log2 << 6u)
                               | (index_low << 3u) | base_low);
        ++at;
    }
    if (no_base || mod == 2u) {
        if (output)
            for (pl_u32 byte = 0u; byte < 4u; ++byte)
                output[at + byte] = (pl_u8)(low >> (byte * 8u));
        at += 4u;
    } else if (mod == 1u) {
        if (output) output[at] = (pl_u8)low;
        ++at;
    }
    *written = at;
    return 1;
}

int pl_select_emit_affine_lea(pl_u32 destination, affine_lea form,
                           pl_u8 *output, pl_u32 *written)
{
    return pl_select_emit_affine_lea_width(
        destination, form, 64u, output, written);
}

int pl_select_publication_add_preserves_flags(const pl_plan *plan,
                                            pl_operand value,
                                            pl_u32 destination)
{
    if (!plan || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    pl_u32 encoded = 0u;
    if (node->opcode == PL_OPCODE_ADD3[0]
            || node->opcode == PL_OPCODE_ADD3[1]) {
        if (node->argument_at > plan->argument_count
                || node->argument_count
                   > plan->argument_count - node->argument_at)
            return 0;
        /* A shared nested pair can select ADD before affine collection.
         * Admit the one-LEA guarantee only for actual coordinate leaves. */
        for (pl_u32 i = 0u; i < node->argument_count; ++i) {
            pl_operand leaf = plan->arguments[node->argument_at + i];
            if (leaf.kind != PL_OPERAND_LOCAL
                    && leaf.kind != PL_OPERAND_CONST)
                return 0;
        }
        affine_lea form = { 0 };
        pl_u32 bits = node->opcode == PL_OPCODE_ADD3[1] ? 64u : 32u;
        return pl_select_collect_affine_lea_width(
                   plan, value, bits, plan->node_count + 1u, &form)
            && pl_select_emit_affine_lea_width(destination, form, bits, 0, &encoded);
    }
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(plan, value, &left, &right, &bits, &mode)
            || mode != 1u)
        return 0;
    pl_select_physicalize_published_operand(plan, destination, &left);
    pl_select_physicalize_published_operand(plan, destination, &right);
    return pl_select_emit_add_lea(destination, left, right, bits, 0, &encoded);
}

int pl_select_final_flags_are_shift(const pl_plan *plan)
{
    if (!plan || plan->local_count <= PL_X86_RFLAGS_LOCAL) return 0;
    pl_operand flags = plan->locals[PL_X86_RFLAGS_LOCAL];
    pl_u32 node = flags.kind == PL_OPERAND_NODE
                ? (pl_u32)flags.value
                : flags.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(flags.value >> 8u) : 0u;
    return node && node <= plan->node_count
        && plan->nodes[node - 1u].opcode == PL_OPCODE_X86_SHIFT_FLAGS;
}

int pl_select_emit_boolean_zero(pl_u32 destination, int preserve_flags,
                              pl_u8 *output, pl_u32 *written)
{
    if (!preserve_flags) return pl_select_emit_zero_register(destination, output, written);
    if (!written || destination >= PL_X86_GPR_COUNT) return 0;
    pl_u32 at = 0u;
    if (destination >= 8u) {
        if (output) output[at] = 0x41u;
        ++at;
    }
    if (output) output[at] = (pl_u8)(0xb8u + (destination & 7u));
    ++at;
    for (pl_u32 byte = 0u; byte < 4u; ++byte) {
        if (output) output[at] = 0u;
        ++at;
    }
    *written = at;
    return 1;
}

/* TEST and its Boolean observation share one flags production. The zero
 * seed goes before TEST unless it would destroy a comparison input; in that
 * case a flag-preserving MOV follows TEST before SETcc. */
int pl_select_emit_test_boolean(const pl_plan *plan, pl_operand value, pl_u32 destination,
                             pl_u8 *output, pl_u32 *written)
{
    test_boolean shape;
    if (!pl_select_test_boolean_details(plan, value, &shape)) return 0;
    pl_select_physicalize_published_operand(plan, destination, &shape.left);
    pl_select_physicalize_published_operand(plan, destination, &shape.right);
    if (shape.left.kind != PL_OPERAND_LOCAL || shape.left.value >= PL_X86_GPR_COUNT)
        return 0;
    pl_u32 aliases = shape.left.value == destination
        || (shape.right.kind == PL_OPERAND_LOCAL && shape.right.value == destination);
    pl_u32 at = 0u, encoded = 0u;
    if (!aliases) {
        if (!pl_select_emit_zero_register(destination, output, &encoded)) return 0;
        at += encoded;
    }
    if (!pl_select_emit_test_operand((pl_u32)shape.left.value, shape.right, shape.bits,
                            output ? output + at : 0, &encoded)) return 0;
    at += encoded;
    if (aliases) {
        if (!pl_select_emit_boolean_zero(destination, 1, output ? output + at : 0, &encoded)) return 0;
        at += encoded;
    }
    if (!pl_select_emit_set_condition(destination, shape.condition, output ? output + at : 0, &encoded))
        return 0;
    *written = at + encoded;
    return 1;
}
