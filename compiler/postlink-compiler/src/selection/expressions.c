/* expressions: native x86 selection. */
#include "expressions.h"
#include "limits.h"
#include "operands.h"
#include "shared-dag.h"

static int bit_summary_details(const pl_plan *plan, pl_operand value,
                                pl_operand *source, pl_operand *passthrough,
                                pl_u32 *bits, pl_u32 *mode);

int pl_select_arithmetic_tree_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *left, pl_operand *right,
                                   pl_u32 *bits, pl_u32 *mode)
{
    if (!plan || !left || !right || !bits || !mode
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->argument_count == 3u
            && (node->opcode == PL_OPCODE_ADD3[0]
                || node->opcode == PL_OPCODE_ADD3[1])) {
        pl_u32 width = node->opcode == PL_OPCODE_ADD3[0] ? 32u : 64u;
        const pl_operand *argument = plan->arguments + node->argument_at;
        /* Substitution may spell (a+b)+shift(a+b,k) as ADD3(a,b,shift).
         * The shift already names the shared sum; recover that edge through
         * its definition, without searching nodes or creating a new tree. */
        for (pl_u32 i = 0u; i < 3u; ++i) {
            pl_operand parent, amount, a, b;
            pl_u32 shift_bits = 0u, group = 0u, parent_bits = 0u, parent_mode = 0u;
            if (!pl_select_shift_node_details(plan, argument[i], &parent, &amount,
                    &shift_bits, &group) || shift_bits != width
                    || parent.kind != PL_OPERAND_NODE || parent.value >= value.value
                    || !pl_select_arithmetic_tree_details(plan, parent, &a, &b,
                        &parent_bits, &parent_mode)
                    || parent_bits != width || parent_mode != 1u) continue;
            pl_operand x = argument[(i + 1u) % 3u], y = argument[(i + 2u) % 3u];
            if ((a.kind == x.kind && a.value == x.value
                    && b.kind == y.kind && b.value == y.value)
                    || (a.kind == y.kind && a.value == y.value
                        && b.kind == x.kind && b.value == x.value)) {
                *left = parent; *right = argument[i]; *bits = width; *mode = 1u;
                return 1;
            }
        }
        /* Two word sums over the same two variables but different constants
         * share their base sum.  Reuse the earlier ADD3 and add the constant
         * delta instead of rebuilding a second three-term tree. */
        for (pl_u32 candidate = 1u; candidate < value.value; ++candidate) {
            const pl_node *earlier = &plan->nodes[candidate - 1u];
            if (earlier->opcode != node->opcode
                    || earlier->argument_count != 3u
                    || earlier->argument_at > plan->argument_count
                    || 3u > plan->argument_count - earlier->argument_at)
                continue;
            const pl_operand *other = plan->arguments + earlier->argument_at;
            int used[3] = { 0, 0, 0 };
            int pairs = 0, constants = 0, valid = 1;
            pl_operand node_constant = { 0 }, base_constant = { 0 };
            for (pl_u32 i = 0u; i < 3u && valid; ++i) {
                int found = 0;
                for (pl_u32 j = 0u; j < 3u; ++j) {
                    if (used[j]) continue;
                    if (argument[i].kind == other[j].kind
                            && argument[i].value == other[j].value) {
                        used[j] = 1;
                        ++pairs;
                        found = 1;
                        break;
                    }
                }
                if (found) continue;
                if (argument[i].kind != PL_OPERAND_CONST
                        || node_constant.kind == PL_OPERAND_CONST) {
                    valid = 0;
                    break;
                }
                pl_u32 unmatched = 3u;
                for (pl_u32 j = 0u; j < 3u; ++j)
                    if (!used[j]) { unmatched = j; break; }
                if (unmatched == 3u
                        || other[unmatched].kind != PL_OPERAND_CONST) {
                    valid = 0;
                    break;
                }
                used[unmatched] = 1;
                node_constant = argument[i];
                base_constant = other[unmatched];
                ++constants;
            }
            if (!valid || pairs != 2u || constants != 1u) continue;
            *left = (pl_operand){ PL_OPERAND_NODE, candidate };
            *right = (pl_operand){ PL_OPERAND_CONST,
                node_constant.value - base_constant.value };
            *bits = width;
            *mode = 1u;
            return 1;
        }
        /* General re-association: an ADD3 whose two operands are already an
         * earlier binary ADD (in either order) shares that sum, so it becomes
         * ADD(remaining, earlier).  The shared-DAG allocator uses the same
         * relation; exposing it here lets the ordinary frames emit it too. */
        pl_u32 pair_node = 0u, pair_bits = 0u;
        pl_operand pair_remaining;
        if (pl_select_shared_dag_add3_pair(plan, (pl_u32)value.value, &pair_node,
                                 &pair_remaining, &pair_bits)) {
            *left = pair_remaining;
            *right = (pl_operand){ PL_OPERAND_NODE, pair_node };
            *bits = pair_bits;
            *mode = 1u;
            return 1;
        }
        return 0;
    }
    if (node->argument_count != 2u) return 0;
    static const pl_u8 x86_mode[5] = { 0u, 1u, 3u, 5u, 6u };
    if (node->opcode == PL_OPCODE_ADD) {
        *left = plan->arguments[node->argument_at];
        *right = plan->arguments[node->argument_at + 1u];
        *bits = 64u;
        *mode = 1u;
        return 1;
    }
    for (pl_u32 lane = 0u; lane < 2u; ++lane)
        for (pl_u32 semantic = 0u; semantic < 5u; ++semantic)
            if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[lane][semantic]
                    || node->opcode
                       == PL_OPCODE_ALU_REGISTER[lane][semantic]) {
                *left = plan->arguments[node->argument_at];
                *right = plan->arguments[node->argument_at + 1u];
                *bits = lane ? 64u : 32u;
                *mode = x86_mode[semantic];
                return 1;
            }
    return 0;
}

int pl_select_single_bit_or_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *source, pl_u32 *bits,
                                 pl_u32 *bit)
{
    if (!source || !bits || !bit) return 0;
    pl_operand left, right;
    pl_u32 mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &left, &right, bits, &mode)
            || mode != 5u)
        return 0;
    pl_u64 mask = 0u;
    if (left.kind == PL_OPERAND_CONST) {
        mask = left.value;
        *source = right;
    } else if (right.kind == PL_OPERAND_CONST) {
        mask = right.value;
        *source = left;
    } else {
        return 0;
    }
    pl_u64 width_mask = *bits == 32u ? 0xffffffffull : U64_MAX_VALUE;
    if (!mask || (mask & ~width_mask) || (mask & (mask - 1u))) return 0;
    pl_u32 rank = 0u;
    while (mask > 1u) {
        mask >>= 1u;
        ++rank;
    }
    *bit = rank;
    return 1;
}

int pl_select_arithmetic_node_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *left, pl_operand *right,
                                   pl_u32 *bits, pl_u32 *mode)
{
    return pl_select_arithmetic_tree_details(
               plan, value, left, right, bits, mode)
        && (right->kind == PL_OPERAND_CONST
            || (right->kind == PL_OPERAND_LOCAL
                && right->value < PL_X86_GPR_COUNT));
}

int pl_select_negation_node_details(const pl_plan *plan, pl_operand value,
                                 pl_operand *source, pl_u32 *bits)
{
    if (!source || !bits) return 0;
    pl_operand left, right;
    pl_u32 mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, value, &left, &right, bits, &mode)
            || mode != 3u || left.kind != PL_OPERAND_CONST
            || left.value)
        return 0;
    *source = right;
    return 1;
}

int pl_select_complement_node_details(const pl_plan *plan, pl_operand value,
                                   pl_operand *source, pl_u32 *bits)
{
    pl_operand right;
    pl_u32 mode = 0u;
    if (!source || !bits
            || !pl_select_arithmetic_node_details(
                plan, value, source, &right, bits, &mode)
            || mode != 6u || right.kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 mask = *bits == 32u ? 0xffffffffu : U64_MAX_VALUE;
    return right.value == mask;
}

pl_u32 pl_select_node_wave_depth(const pl_plan *plan, pl_operand value)
{
    if (!plan) return 0u;
    pl_u32 node = value.kind == PL_OPERAND_PROJECTION
                ? (pl_u32)(value.value >> 8u)
                : value.kind == PL_OPERAND_NODE
                ? (pl_u32)value.value : 0u;
    if (!node || node > plan->node_count) return 0u;
    for (pl_u32 wave = 0u; wave < plan->span; ++wave)
        for (pl_u32 at = plan->wave_offsets[wave];
                at < plan->wave_offsets[wave + 1u]; ++at)
            if (plan->wave_values[at] == node) return wave + 1u;
    return 0u;
}

int pl_select_operand_fits_u32(const pl_plan *plan, pl_operand value,
                            pl_u32 remaining)
{
    if (!plan || !remaining) return 0;
    if (value.kind == PL_OPERAND_CONST) return value.value <= 0xffffffffu;
    if (value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    pl_u32 source = 0u, bits = 0u;
    if (pl_select_zero_extend_node(
            plan, (pl_u32)value.value, &source, &bits))
        return bits <= 32u;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if (node->opcode == PL_OPCODE_LANE32_SELECT) return 1;
    if (node->opcode == PL_OPCODE_LANE64_SELECT && node->argument_count == 3u
            && node->argument_at <= plan->argument_count
            && 3u <= plan->argument_count - node->argument_at)
        return pl_select_operand_fits_u32(plan, plan->arguments[node->argument_at], remaining - 1u)
            && pl_select_operand_fits_u32(plan, plan->arguments[node->argument_at + 1u], remaining - 1u);
    pl_operand left, right;
    pl_u32 mode = 0u;
    return pl_select_arithmetic_tree_details(
               plan, value, &left, &right, &bits, &mode)
        && bits == 32u;
}

int pl_select_narrow_address_select_requires_source(
    const pl_x86_frontend *frontend, const pl_x86_block *block)
{
    if (!frontend || !block || block->plan.node_count > 96u)
        return 0;
    const pl_plan *plan = &block->plan;
    pl_u64 targets[192u];
    pl_u32 count = 0u;
    for (pl_u32 node = 0u; node < plan->node_count; ++node) {
        const pl_node *current = &plan->nodes[node];
        if (current->opcode != PL_OPCODE_LANE64_SELECT
                || current->argument_count != 3u
                || current->argument_at > plan->argument_count
                || current->argument_count
                   > plan->argument_count - current->argument_at)
            continue;
        const pl_operand *arm = plan->arguments + current->argument_at;
        if (!pl_select_operand_fits_u32(plan, arm[0], plan->node_count + 1u)
                || !pl_select_operand_fits_u32(plan, arm[1], plan->node_count + 1u))
            continue;
        for (pl_u32 index = 0u; index < 2u; ++index)
            if (arm[index].kind == PL_OPERAND_CONST)
                targets[count++] = arm[index].value;
    }
    if (!count) return 0;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                && instruction.visible_operand_count >= 2u
                && instruction.operands[0].kind == PL_X86_OPERAND_REGISTER
                && instruction.operands[0].bits == 64u
                && instruction.operands[1].kind == PL_X86_OPERAND_MEMORY
                && instruction.operands[1].value.memory.base.class_id
                   == PL_X86_REGISTER_IP) {
            pl_u64 address = instruction.fallthrough
                + (pl_u64)instruction.operands[1]
                                .value.memory.displacement;
            for (pl_u32 target = 0u; target < count; ++target)
                if (targets[target] == address) return 1;
        }
        rip = instruction.fallthrough;
    }
    return rip == block->end ? 0 : PL_ERROR_X86_SELECT;
}

/* A RIP-relative LEA produces a load-biased address, not its linked numeric
 * offset.  Arithmetic or another LEA consuming that address cannot replace
 * it with a linked absolute constant: the load bias would disappear.  A
 * full-width register move may carry the address to a later instruction, but
 * every other consumer keeps the exact relocatable source spelling until a
 * normalized candidate can carry that provenance through the result. */
int pl_select_derived_rip_address_requires_source(
    const pl_x86_frontend *frontend, const pl_x86_block *block)
{
    if (!frontend || !block) return 0;
    pl_u32 address_registers = 0u;
    pl_u64 address_targets[PL_X86_GPR_COUNT] = { 0 };
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        int same_address_compare = 0;
        if (instruction.operation == PL_X86_OPERATION_COMPARE
                && instruction.visible_operand_count >= 2u) {
            const pl_x86_operand *left = &instruction.operands[0];
            const pl_x86_operand *right = &instruction.operands[1];
            same_address_compare = left->kind == PL_X86_OPERAND_REGISTER
                && right->kind == PL_X86_OPERAND_REGISTER
                && left->bits == 64u && right->bits == 64u
                && left->value.reg.class_id == PL_X86_REGISTER_GPR
                && right->value.reg.class_id == PL_X86_REGISTER_GPR
                && left->value.reg.index < PL_X86_GPR_COUNT
                && right->value.reg.index < PL_X86_GPR_COUNT
                && (address_registers
                    & (1u << left->value.reg.index))
                && (address_registers
                    & (1u << right->value.reg.index))
                && address_targets[left->value.reg.index]
                   == address_targets[right->value.reg.index];
        }
        for (pl_u32 operand = 0u;
                operand < instruction.visible_operand_count; ++operand) {
            const pl_x86_operand *value = &instruction.operands[operand];
            if (!(value->flags & (PL_X86_OPERAND_READ
                                | PL_X86_OPERAND_CONDITIONAL_READ)))
                continue;
            if (value->kind == PL_X86_OPERAND_REGISTER
                    && value->value.reg.class_id == PL_X86_REGISTER_GPR
                    && value->value.reg.index < PL_X86_GPR_COUNT
                    && (address_registers
                        & (1u << value->value.reg.index))) {
                if (!same_address_compare
                        && (instruction.operation != PL_X86_OPERATION_MOVE
                        || operand != 1u
                        || instruction.visible_operand_count < 2u
                        || instruction.operands[0].kind
                           != PL_X86_OPERAND_REGISTER
                        || instruction.operands[0].bits != 64u
                        || value->bits != 64u))
                    return 1;
            }
            if (value->kind == PL_X86_OPERAND_MEMORY) {
                pl_x86_register base = value->value.memory.base;
                pl_x86_register index_register = value->value.memory.index;
                if ((base.class_id == PL_X86_REGISTER_GPR
                            && base.index < PL_X86_GPR_COUNT
                            && (address_registers & (1u << base.index)))
                        || (index_register.class_id == PL_X86_REGISTER_GPR
                            && index_register.index < PL_X86_GPR_COUNT
                            && (address_registers
                                & (1u << index_register.index))))
                    return 1;
            }
        }
        pl_u32 target = PL_X86_GPR_COUNT;
        if (instruction.visible_operand_count >= 1u
                && instruction.operands[0].kind == PL_X86_OPERAND_REGISTER
                && instruction.operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && instruction.operands[0].value.reg.index < PL_X86_GPR_COUNT
                && instruction.operands[0].bits == 64u
                && (instruction.operands[0].flags & PL_X86_OPERAND_WRITE))
            target = instruction.operands[0].value.reg.index;
        pl_u32 next_address = 0u;
        pl_u64 next_address_target = 0u;
        if (target < PL_X86_GPR_COUNT
                && instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                && instruction.visible_operand_count >= 2u
                && instruction.operands[1].kind == PL_X86_OPERAND_MEMORY) {
            pl_x86_register base = instruction.operands[1].value.memory.base;
            if (base.class_id == PL_X86_REGISTER_IP) {
                next_address = 1u;
                next_address_target = instruction.fallthrough
                    + (pl_u64)instruction.operands[1]
                                    .value.memory.displacement;
            } else if (base.class_id == PL_X86_REGISTER_GPR
                    && base.index < PL_X86_GPR_COUNT
                    && (address_registers & (1u << base.index)))
                return 1;
        } else if (target < PL_X86_GPR_COUNT
                && instruction.operation == PL_X86_OPERATION_MOVE
                && instruction.visible_operand_count >= 2u
                && instruction.operands[1].kind == PL_X86_OPERAND_REGISTER
                && instruction.operands[1].bits == 64u
                && instruction.operands[1].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && instruction.operands[1].value.reg.index < PL_X86_GPR_COUNT
                && (address_registers
                    & (1u << instruction.operands[1].value.reg.index))) {
            next_address = 1u;
            next_address_target = address_targets[
                instruction.operands[1].value.reg.index];
        }
        if (target < PL_X86_GPR_COUNT) {
            address_registers &= ~(1u << target);
            address_registers |= next_address << target;
            address_targets[target] = next_address_target;
        }
        rip = instruction.fallthrough;
    }
    return rip == block->end ? 0 : PL_ERROR_X86_SELECT;
}

pl_u32 pl_select_publication_copy_bits(const pl_plan *plan,
                                    const pl_x86_native_selection *selection,
                                    pl_operand value, pl_u32 output_at)
{
    /* A linked address below 4 GiB is not a runtime 32-bit range proof.
     * Once its owner has been emitted as a RIP-relative definition, aliases
     * must copy the full rebased pointer. The same bounded fixup record is
     * available in measurement and emission; no address table is published. */
    if (value.kind == PL_OPERAND_CONST)
        for (pl_u32 i = 0u; i < selection->fixup_count; ++i) {
            const pl_x86_native_fixup *fixup = &selection->fixups[i];
            if (fixup->kind == PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                    && fixup->target == value.value
                    && fixup->next_ip_at <= output_at)
                return 64u;
        }
    return pl_select_operand_fits_u32(plan, value, plan->node_count + 1u) ? 32u : 64u;
}

int pl_select_shift_node_details(const pl_plan *plan, pl_operand value,
                              pl_operand *source, pl_operand *amount,
                              pl_u32 *bits, pl_u32 *group)
{
    if (!plan || !source || !amount || !bits || !group
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    static const struct {
        pl_u32 opcode;
        pl_u8 bits;
        pl_u8 group;
    } spelling[] = {
        { PL_OPCODE_LANE32_ROTL, 32u, 0u },
        { PL_OPCODE_LANE64_ROTL, 64u, 0u },
        { PL_OPCODE_LANE32_ROTR, 32u, 1u },
        { PL_OPCODE_LANE64_ROTR, 64u, 1u },
        { PL_OPCODE_LANE32_SHL,  32u, 4u },
        { PL_OPCODE_LANE64_SHL,  64u, 4u },
        { PL_OPCODE_LANE32_SHLR, 32u, 4u },
        { PL_OPCODE_LANE64_SHLR, 64u, 4u },
        { PL_OPCODE_LANE32_SHR,  32u, 5u },
        { PL_OPCODE_LANE64_SHR,  64u, 5u },
        { PL_OPCODE_LANE32_SHRR, 32u, 5u },
        { PL_OPCODE_LANE64_SHRR, 64u, 5u },
        { PL_OPCODE_LANE32_SAR,  32u, 7u },
        { PL_OPCODE_LANE64_SAR,  64u, 7u },
        { PL_OPCODE_LANE32_SARR, 32u, 7u },
        { PL_OPCODE_LANE64_SARR, 64u, 7u },
    };
    pl_u32 form = 0u;
    for (; form < sizeof spelling / sizeof spelling[0]; ++form)
        if (node->opcode == spelling[form].opcode) break;
    if (form == sizeof spelling / sizeof spelling[0]
            || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    *source = plan->arguments[node->argument_at];
    *amount = plan->arguments[node->argument_at + 1u];
    *bits = spelling[form].bits;
    *group = spelling[form].group;
    if (amount->kind == PL_OPERAND_CONST) return 1;
    if (amount->kind == PL_OPERAND_LOCAL && amount->value == 1u) return 1;
    if (amount->kind != PL_OPERAND_NODE || !amount->value
            || amount->value > plan->node_count)
        return 0;

    /* x86 masks a register shift count in hardware.  The semantic graph
     * makes that bound explicit; selecting D3 /group must consume it instead
     * of materializing a redundant AND before every variable shift. */
    const pl_node *bound = &plan->nodes[amount->value - 1u];
    if (bound->opcode != PL_OPCODE_ALU_IMMEDIATE[1][0]
            || bound->argument_count != 2u
            || bound->argument_at > plan->argument_count
            || bound->argument_count
               > plan->argument_count - bound->argument_at)
        return 0;
    pl_operand first = plan->arguments[bound->argument_at];
    pl_operand second = plan->arguments[bound->argument_at + 1u];
    pl_u64 mask = *bits == 64u ? 63u : 31u;
    if (first.kind == PL_OPERAND_CONST && first.value == mask) {
        pl_operand swap = first;
        first = second;
        second = swap;
    }
    if (second.kind != PL_OPERAND_CONST || second.value != mask)
        return 0;
    /* x86 already masks a register count to 5/6 bits, so the explicit AND is
     * redundant.  CL can carry the count whenever the unwrapped chain is the
     * value published at RCX (the producer edge is already recorded by the
     * source law) or a bare entry RCX. */
    if (first.kind == PL_OPERAND_LOCAL && first.value == 1u) {
        *amount = first;
        return 1;
    }
    if (pl_select_publication_owner(plan, first) == 1u) {
        *amount = (pl_operand){ PL_OPERAND_LOCAL, 1u };
        return 1;
    }
    return 0;
}

int pl_select_lane32_shift_inner_needs_truncation(const pl_plan *plan,
                                               pl_operand inner)
{
    if (!plan || inner.kind != PL_OPERAND_NODE || !inner.value
            || inner.value > plan->node_count)
        return 0;
    switch (plan->nodes[inner.value - 1u].opcode) {
    case PL_OPCODE_LANE64_ROTL:
    case PL_OPCODE_LANE64_ROTR:
    case PL_OPCODE_LANE64_SHL:
    case PL_OPCODE_LANE64_SHLR:
    case PL_OPCODE_LANE64_SHR:
    case PL_OPCODE_LANE64_SHRR:
    case PL_OPCODE_LANE64_SAR:
    case PL_OPCODE_LANE64_SARR:
        return 1;
    default:
        return 0;
    }
}

/* `lane{32,64}.insert(base, value, width)` with a node/projection base and
 * width < 64 is a partial-width write into an independently computed value:
 * materialize `base` into the destination, then apply `value` at `width`.
 * Base zero (zero-extension) has its own seed production. */
int pl_select_node_base_lane_insert(const pl_plan *plan, pl_operand value,
                                 pl_operand *base, pl_operand *inner,
                                 pl_u32 *width)
{
    if (!plan || !base || !inner || !width
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    if ((node->opcode != PL_OPCODE_LANE64_INSERT
                && node->opcode != PL_OPCODE_LANE32_INSERT)
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || 3u > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if ((arguments[0].kind != PL_OPERAND_NODE
                && arguments[0].kind != PL_OPERAND_PROJECTION)
            || arguments[2].kind != PL_OPERAND_CONST
            || (arguments[2].value != 8u && arguments[2].value != 16u
                && arguments[2].value != 32u))
        return 0;
    *base = arguments[0];
    *inner = arguments[1];
    *width = (pl_u32)arguments[2].value;
    return 1;
}

/* A variable shift count the plan spells as `and(chain, hw_mask)` is exactly
 * what x86's register shift already does in hardware (CL mod 32/64), so the
 * mask is redundant even when `chain` is not a bare entry local.  This peels it
 * off and leaves the chain to be emitted into CL. */
int pl_select_masked_shift_count_details(const pl_plan *plan, pl_operand value,
                                      pl_operand *source, pl_operand *count,
                                      pl_u32 *bits, pl_u32 *group)
{
    if (!plan || !source || !count || !bits || !group
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    static const struct {
        pl_u32 opcode;
        pl_u8 bits;
        pl_u8 group;
    } spelling[] = {
        { PL_OPCODE_LANE32_ROTL, 32u, 0u },
        { PL_OPCODE_LANE64_ROTL, 64u, 0u },
        { PL_OPCODE_LANE32_ROTR, 32u, 1u },
        { PL_OPCODE_LANE64_ROTR, 64u, 1u },
        { PL_OPCODE_LANE32_SHL,  32u, 4u },
        { PL_OPCODE_LANE64_SHL,  64u, 4u },
        { PL_OPCODE_LANE32_SHLR, 32u, 4u },
        { PL_OPCODE_LANE64_SHLR, 64u, 4u },
        { PL_OPCODE_LANE32_SHR,  32u, 5u },
        { PL_OPCODE_LANE64_SHR,  64u, 5u },
        { PL_OPCODE_LANE32_SHRR, 32u, 5u },
        { PL_OPCODE_LANE64_SHRR, 64u, 5u },
        { PL_OPCODE_LANE32_SAR,  32u, 7u },
        { PL_OPCODE_LANE64_SAR,  64u, 7u },
        { PL_OPCODE_LANE32_SARR, 32u, 7u },
        { PL_OPCODE_LANE64_SARR, 64u, 7u },
    };
    pl_u32 form = 0u;
    for (; form < sizeof spelling / sizeof spelling[0]; ++form)
        if (node->opcode == spelling[form].opcode) break;
    if (form == sizeof spelling / sizeof spelling[0]
            || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    pl_operand amount = plan->arguments[node->argument_at + 1u];
    if (amount.kind != PL_OPERAND_NODE || !amount.value
            || amount.value > plan->node_count)
        return 0;
    const pl_node *bound = &plan->nodes[amount.value - 1u];
    if ((bound->opcode != 6u && bound->opcode != 76u)
            || bound->argument_count != 2u
            || bound->argument_at > plan->argument_count
            || 2u > plan->argument_count - bound->argument_at)
        return 0;
    pl_operand first = plan->arguments[bound->argument_at];
    pl_operand second = plan->arguments[bound->argument_at + 1u];
    pl_u64 mask = spelling[form].bits == 64u ? 63u : 31u;
    if (first.kind == PL_OPERAND_CONST && first.value == mask) {
        pl_operand swap = first;
        first = second;
        second = swap;
    }
    if (second.kind != PL_OPERAND_CONST || second.value != mask)
        return 0;
    if (first.kind == PL_OPERAND_CONST) return 0;
    *source = plan->arguments[node->argument_at];
    *count = first;
    *bits = spelling[form].bits;
    *group = spelling[form].group;
    return 1;
}

static int bit_summary_details(const pl_plan *plan, pl_operand value,
                                pl_operand *source, pl_operand *passthrough,
                                pl_u32 *bits, pl_u32 *mode)
{
    if (value.kind != PL_OPERAND_PROJECTION || (value.value & 0xffu) != 16u)
        return 0;
    pl_u32 number = (pl_u32)(value.value >> 8u);
    if (!number || number > plan->node_count) return 0;
    const pl_node *node = &plan->nodes[number - 1u];
    if (node->opcode != PL_OPCODE_X86_BIT_SUMMARY
            || (node->argument_count != 3u && node->argument_count != 4u)
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at) return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[2].kind != PL_OPERAND_CONST) return 0;
    *bits = (pl_u32)(argument[2].value & 0xffu);
    *mode = (pl_u32)(argument[2].value >> 8u);
    if ((*bits != 32u && *bits != 64u) || *mode > 4u
            || argument[2].value != (*bits | ((pl_u64)*mode << 8u))
            || node->argument_count != (*mode < 2u ? 4u : 3u)) return 0;
    *source = argument[1];
    if (*mode < 2u) *passthrough = argument[3];
    return 1;
}

int pl_select_emit_bit_summary(pl_u32 destination, pl_u32 source, pl_u32 bits,
                             pl_u32 mode, pl_u8 *output, pl_u32 *written)
{
    if (destination >= PL_X86_GPR_COUNT || source >= PL_X86_GPR_COUNT
            || (bits != 32u && bits != 64u) || mode > 4u) return 0;
    pl_u32 at = 0u;
    if (mode >= 2u) { if (output) output[at] = 0xf3u; ++at; }
    pl_u8 rex = (pl_u8)(0x40u | (bits == 64u ? 8u : 0u)
        | (destination >= 8u ? 4u : 0u) | (source >= 8u ? 1u : 0u));
    if (rex != 0x40u) { if (output) output[at] = rex; ++at; }
    if (output) {
        output[at] = 0x0fu;
        output[at + 1u] = mode == 4u ? 0xb8u
                       : (mode == 1u || mode == 2u) ? 0xbcu : 0xbdu;
        output[at + 2u] = (pl_u8)(0xc0u | ((destination & 7u) << 3u) | (source & 7u));
    }
    *written = at + 3u;
    return 1;
}

int pl_select_zero_extend_high8_node(const pl_plan *plan, pl_u32 node_number,
                                  pl_u32 *source)
{
    if (!plan || !source || !node_number
            || node_number > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[node_number - 1u];
    if (node->opcode != PL_OPCODE_LANE64_INSERT
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[0].kind != PL_OPERAND_CONST || argument[0].value
            || argument[2].kind != PL_OPERAND_CONST
            || argument[2].value != 8u)
        return 0;
    pl_operand shift_source, shift_amount;
    pl_u32 shift_bits = 0u, shift_group = 0u;
    if (!pl_select_shift_node_details(
            plan, argument[1], &shift_source, &shift_amount,
            &shift_bits, &shift_group)
            || shift_bits != 64u || shift_group != 5u
            || shift_source.kind != PL_OPERAND_LOCAL
            || shift_source.value >= 4u
            || shift_amount.kind != PL_OPERAND_CONST
            || shift_amount.value != 8u)
        return 0;
    *source = (pl_u32)shift_source.value;
    return 1;
}

/* Modular arithmetic and bitwise operations can compute the consumer's low
 * bits directly, but a narrow producer must wrap before zero extension into
 * a wider consumer. Shifts and rotates cannot truncate early: high bits and the count mask
 * depend on the producer's width before the consumer truncates its input. */
pl_u32 pl_select_alu_input_expression_bits(const pl_plan *plan,
                                        pl_operand value,
                                        pl_u32 consumer_bits)
{
    pl_operand source, amount;
    pl_u32 bits = 0u, group = 0u;
    if (pl_select_shift_node_details(plan, value, &source, &amount, &bits, &group)) return bits;
    if (pl_select_arithmetic_tree_details(plan, value, &source, &amount, &bits, &group)
            && bits < consumer_bits) return bits;
    return consumer_bits;
}

pl_u32 pl_select_operand_expression_bits(const pl_plan *plan,
                                      pl_operand value,
                                      pl_u32 fallback)
{
    if (value.kind == PL_OPERAND_NODE && value.value && value.value <= plan->node_count) {
        pl_u32 opcode = plan->nodes[value.value - 1u].opcode;
        if (opcode == PL_OPCODE_X86_TEST_CONDITION || opcode == PL_OPCODE_X86_CONDITION
                || opcode == PL_OPCODE_LANE64_EXTEND8_S
                || opcode == PL_OPCODE_LANE64_EXTEND16_S || opcode == PL_OPCODE_EXTEND32_S)
            return 64u;
        if (opcode == PL_OPCODE_ADD3[0] || opcode == PL_OPCODE_LANE32_MULR) return 32u;
        if (opcode == PL_OPCODE_ADD3[1] || opcode == PL_OPCODE_MULR) return 64u;
        if (opcode == PL_OPCODE_LANE32_BSWAP) return 32u;
        if (opcode == PL_OPCODE_LANE64_BSWAP) return 64u;
    }
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (pl_select_arithmetic_tree_details(
            plan, value, &left, &right, &bits, &mode)) {
        (void)left;
        (void)right;
        (void)mode;
        return bits;
    }
    pl_operand source, amount;
    pl_u32 group = 0u;
    if (pl_select_shift_node_details(
            plan, value, &source, &amount, &bits, &group)) {
        (void)source;
        (void)amount;
        (void)group;
        return bits;
    }
    if (value.kind == PL_OPERAND_PROJECTION
            && (value.value & 0xffu) == 16u) {
        pl_operand alu_source, alu_right;
        pl_u32 alu_mode = 0u, preserves_carry = 0u;
        if (pl_select_alu_node_semantics(
                plan, (pl_u32)(value.value >> 8u),
                &alu_source, &alu_right, &bits,
                &alu_mode, &preserves_carry)) {
            (void)alu_source;
            (void)alu_right;
            (void)alu_mode;
            (void)preserves_carry;
            return bits;
        }
    }
    return fallback;
}

int pl_select_published_operand_local(const pl_plan *plan, pl_operand value,
                                   pl_u32 *local)
{
    if (!plan || !local) return 0;
    /* When an entry local remains unchanged it is the canonical physical
     * owner of that value.  A lower-numbered copy is semantically equal but
     * would add a false copy -> consumer edge (for example MOV rdi,rax;
     * TEST rdi,rdi).  Prefer the identity coordinate before scanning other
     * publications so register naming preserves the minimum SSA span. */
    if (value.kind == PL_OPERAND_LOCAL
            && value.value < PL_X86_GPR_COUNT) {
        pl_u32 identity = (pl_u32)value.value;
        pl_operand publication = plan->locals[identity];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == identity) {
            *local = identity;
            return 1;
        }
    }
    /* Dependency construction and instruction emission must name the same
     * physical owner.  pl_select_publication_owner includes the destructive in-place
     * preference; bypassing it here could let a consumer read an equal but
     * not-yet-published register even though the canonical producer is ready. */
    pl_u32 canonical = pl_select_publication_owner(plan, value);
    if (canonical < PL_X86_GPR_COUNT) {
        *local = canonical;
        return 1;
    }
    for (pl_u32 candidate = 0u;
            candidate < PL_X86_GPR_COUNT; ++candidate) {
        pl_operand publication = plan->locals[candidate];
        if (publication.kind == value.kind
                && publication.value == value.value) {
            *local = candidate;
            return 1;
        }
    }
    return 0;
}

/* Convert a semantic value to the GPR which owns its final publication.
 * Entry locals need this distinction when their architectural coordinate is
 * overwritten and an exact saved copy survives elsewhere.  The SSA operand
 * remains semantic; only the native schedule receives the physical owner.
 * pl_select_alu_frame_source_laws records the matching publication dependency, so an
 * emitted consumer can never run before that owner has been established. */
void pl_select_physicalize_published_operand(const pl_plan *plan,
                                          pl_u32 destination,
                                          pl_operand *value)
{
    if (!plan || !value) return;
    if (value->kind == PL_OPERAND_LOCAL
            && value->value == destination)
        return;
    pl_u32 owner = PL_X86_GPR_COUNT;
    if (pl_select_published_operand_local(plan, *value, &owner)
            && owner != destination
            && !(value->kind == PL_OPERAND_LOCAL
                 && value->value == owner)
            /* Keep a constant zero an immediate rather than reading the
             * zero-class flag producer's coordinate (matching
             * operand_source_law). */
            && !(value->kind == PL_OPERAND_CONST
                 && pl_select_zero_self_flag_publication(plan, owner))) {
        value->kind = PL_OPERAND_LOCAL;
        value->value = owner;
    }
}

int pl_select_physicalize_transient_operand(
    const pl_x86_native_selection *selection, pl_operand *value)
{
    if (!value) return 0;
    if (selection) {
        for (pl_u32 alias = 0u; alias < selection->value_alias_count; ++alias)
            if (selection->value_alias_kind[alias] == value->kind
                    && selection->value_alias_value[alias] == value->value
                    && selection->value_alias_local[alias] < PL_X86_GPR_COUNT) {
                value->kind = PL_OPERAND_LOCAL;
                value->value = selection->value_alias_local[alias];
                return 1;
            }
    }
    if (selection && selection->frame_alias_present
            && value->kind == selection->frame_alias_kind
            && value->value == selection->frame_alias_value
            && selection->frame_alias_local < PL_X86_GPR_COUNT) {
        value->kind = PL_OPERAND_LOCAL;
        value->value = selection->frame_alias_local;
        return 1;
    }
    return 0;
}

void pl_select_physicalize_selected_operand(
    const pl_plan *plan, const pl_x86_native_selection *selection,
    pl_u32 destination, pl_operand *value)
{
    if (!value || pl_select_physicalize_transient_operand(selection, value)) return;
    pl_select_physicalize_published_operand(plan, destination, value);
}

/* A scan's source and zero-input destination are separate operands. Loading
 * the pass-through must not overwrite its still-live source. Both measurement
 * and emission use this shape, including the full-width seed for BSF/BSR. */
int pl_select_bit_summary_frame(const pl_plan *plan,
                              const pl_x86_native_selection *selection,
                              pl_operand value, pl_u32 destination,
                              pl_operand *seed, pl_u32 *seed_bits,
                              pl_u32 *source_local, pl_u32 *bits, pl_u32 *mode)
{
    pl_operand source, passthrough = { 0 };
    if (!bit_summary_details(plan, value, &source, &passthrough, bits, mode))
        return 0;
    pl_select_physicalize_selected_operand(plan, selection, destination, &source);
    *source_local = destination;
    *seed_bits = *bits;
    if (*mode < 2u) {
        pl_select_physicalize_selected_operand(plan, selection, destination, &passthrough);
        *seed = passthrough;
        *seed_bits = 64u;
        if (source.kind == passthrough.kind && source.value == passthrough.value)
            return 1;
        if (source.kind != PL_OPERAND_LOCAL
                || source.value >= PL_X86_GPR_COUNT
                || source.value == destination)
            return 0;
        *source_local = (pl_u32)source.value;
        return 1;
    }
    if (source.kind == PL_OPERAND_LOCAL && source.value < PL_X86_GPR_COUNT) {
        *source_local = (pl_u32)source.value;
        seed->kind = PL_OPERAND_LOCAL;
        seed->value = destination;
    } else {
        *seed = source;
    }
    return 1;
}

/* Record that a computed SSA node now lives in one GPR.  A frame that
 * materializes a shared subtree (a conditional arm, a preloaded tree) into a
 * destination must resolve later references to that same node through the
 * destination instead of rebuilding it from an entry local the materializing
 * publication may already have overwritten. */
void pl_select_push_frame_value_alias(pl_x86_native_selection *selection,
                                   pl_u8 kind, pl_u64 value, pl_u8 local)
{
    if (!selection || local >= PL_X86_GPR_COUNT
            || selection->value_alias_count >= PL_X86_VALUE_ALIAS_COUNT)
        return;
    pl_u32 at = selection->value_alias_count++;
    selection->value_alias_kind[at] = kind;
    selection->value_alias_value[at] = value;
    selection->value_alias_local[at] = local;
}

/* ADD/AND/OR/XOR have no semantic left/right order.  Prefer the arm whose
 * entry generation already occupies the destructive destination, including a
 * nested shift or arithmetic subtree.  Restricting this to a literal local
 * forces a scratch tree and two moves after quotient substitution exposes a
 * deeper destination-owned arm. */
void pl_select_orient_commutative_destination(
    const pl_plan *plan, pl_u32 destination,
    pl_u32 mode, pl_operand *left, pl_operand *right)
{
    if (!plan || !left || !right || mode == 3u
            || destination >= PL_X86_GPR_COUNT)
        return;
    pl_u32 left_sources = 0u, right_sources = 0u;
    if (!pl_select_operand_gpr_sources(
            plan, *left, plan->node_count + 1u,
            plan->node_count + 1u, &left_sources)
            || !pl_select_operand_gpr_sources(
                plan, *right, plan->node_count + 1u,
                plan->node_count + 1u, &right_sources))
        return;
    pl_u32 destination_bit = 1u << destination;
    if ((right_sources & destination_bit)
            && !(left_sources & destination_bit)) {
        pl_operand swap = *left;
        *left = *right;
        *right = swap;
    }
}

int pl_select_sign_high_node_details(const pl_plan *plan, pl_operand value,
                                  pl_u32 *source, pl_u32 *bits)
{
    if (!plan || !source || !bits || value.kind != PL_OPERAND_NODE
            || !value.value || value.value > plan->node_count)
        return 0;
    const pl_node *outer = &plan->nodes[value.value - 1u];
    pl_operand shifted = value;
    *bits = 64u;
    if (outer->opcode == PL_OPCODE_LANE64_INSERT
            && outer->argument_count == 3u
            && outer->argument_at <= plan->argument_count
            && outer->argument_count
               <= plan->argument_count - outer->argument_at) {
        const pl_operand *argument = plan->arguments + outer->argument_at;
        if (argument[0].kind != PL_OPERAND_CONST || argument[0].value
                || argument[2].kind != PL_OPERAND_CONST
                || argument[2].value != 32u)
            return 0;
        shifted = argument[1];
        *bits = 32u;
    }
    if (shifted.kind != PL_OPERAND_NODE || !shifted.value
            || shifted.value > plan->node_count)
        return 0;
    const pl_node *shift = &plan->nodes[shifted.value - 1u];
    if ((shift->opcode != PL_OPCODE_LANE64_SAR
            && shift->opcode != PL_OPCODE_LANE64_SARR)
            || shift->argument_count != 2u
            || shift->argument_at > plan->argument_count
            || shift->argument_count
               > plan->argument_count - shift->argument_at)
        return 0;
    const pl_operand *shift_argument =
        plan->arguments + shift->argument_at;
    if (shift_argument[1].kind != PL_OPERAND_CONST
            || shift_argument[1].value != (*bits == 64u ? 63u : 31u))
        return 0;
    pl_operand low = shift_argument[0];
    if (*bits == 32u) {
        if (low.kind != PL_OPERAND_NODE || !low.value
                || low.value > plan->node_count)
            return 0;
        const pl_node *extend = &plan->nodes[low.value - 1u];
        if (extend->opcode != PL_OPCODE_EXTEND32_S
                || extend->argument_count != 1u
                || extend->argument_at >= plan->argument_count)
            return 0;
        low = plan->arguments[extend->argument_at];
    }
    pl_u32 local = PL_X86_GPR_COUNT;
    if (low.kind == PL_OPERAND_LOCAL && low.value < PL_X86_GPR_COUNT)
        local = (pl_u32)low.value;
    else if (!pl_select_published_operand_local(plan, low, &local))
        return 0;
    if (local != 0u) return 0;
    *source = local;
    return 1;
}

int pl_select_scaled_lea_node_details(const pl_plan *plan, pl_operand value,
                                   pl_u32 *source, pl_u32 *bits,
                                   pl_u32 *scale_log2)
{
    if (!plan || !source || !bits || !scale_log2
            || value.kind != PL_OPERAND_NODE || !value.value
            || value.value > plan->node_count)
        return 0;
    const pl_node *node = &plan->nodes[value.value - 1u];
    *bits = node->opcode == PL_OPCODE_LANE32_SHL ? 32u
          : node->opcode == PL_OPCODE_LANE64_SHL ? 64u : 0u;
    if (!*bits || node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value >= PL_X86_GPR_COUNT
            || argument[1].kind != PL_OPERAND_CONST
            || !argument[1].value || argument[1].value > 3u)
        return 0;
    *source = (pl_u32)argument[0].value;
    *scale_log2 = (pl_u32)argument[1].value;
    return 1;
}
