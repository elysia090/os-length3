/* simple-frame: native x86 selection. */
#include "simple-frame.h"
#include "limits.h"
#include "lea.h"
#include "encoding.h"
#include "expressions.h"
#include "operands.h"
#include "source.h"
#include "state-frame.h"
#include "tree-measure.h"
#include "tree-write.h"

static int equal_compare_frame_shape(const pl_plan *plan,
                                     pl_u32 *changed,
                                     pl_u32 *anchor,
                                     pl_u32 *bits,
                                     pl_u64 *value);

static int common_constant_frame_shape(const pl_plan *plan,
                                       pl_u32 *changed,
                                       pl_u32 *anchor,
                                       pl_u64 *value);

static int constant_sar_zero_frame_shape(const pl_plan *plan,
                                         pl_u32 *changed,
                                         pl_u32 *anchor,
                                         pl_u32 *bits);

static int add_frame_shape(const pl_plan *plan, pl_u32 *node_destination,
                           pl_u32 *bits, pl_u32 *changed);

static int add_frame_sources(const pl_plan *plan, pl_u32 local,
                             pl_u32 node_destination, pl_u32 *sources);

static int next_add_frame_assignment(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 node_destination,
                                     pl_u32 *selected);

static int published_wide_add_shape(const pl_x86_block *block,
                                    published_wide_add *out);

static int insert32_frame_shape(const pl_plan *plan, pl_u32 *destination,
                                pl_u32 *source, pl_u32 *changed);

static int insert_frame_sources(const pl_plan *plan, pl_u32 local,
                                pl_u32 destination, pl_u32 source,
                                pl_u32 *sources);

static int next_insert_frame_assignment(
    const pl_plan *plan, pl_u32 pending,
    pl_u32 destination, pl_u32 source, pl_u32 *selected);

static int emit_insert32_move(pl_u32 destination, pl_u32 source,
                              pl_u8 *output, pl_u32 *written);

int pl_select_measure_frame_value(const pl_x86_frontend *frontend,
                               const pl_x86_block *block,
                               pl_x86_native_selection *selection,
                               pl_u32 local, pl_operand value,
                               pl_u32 output_at, pl_u32 *bytes)
{
    if (!frontend || !block || !selection || !bytes
            || local >= PL_X86_GPR_COUNT)
        return PL_ERROR_X86_SELECT;
    if (value.kind == PL_OPERAND_LOCAL) {
        if (value.value >= PL_X86_GPR_COUNT) return 0;
        *bytes = 3u;
        return 1;
    }
    if (value.kind != PL_OPERAND_CONST) return 0;
    pl_u64 target = 0u;
    pl_u32 source_at = 0u;
    pl_u8 source_bytes = 0u;
    int address = pl_select_source_address_binding(
        frontend, block, local, value.value,
        &target, &source_at, &source_bytes);
    if (address < 0) return address;
    if (!address) {
        *bytes = pl_select_constant_move_bytes(local, value.value);
        return 1;
    }
    if (output_at > U32_MAX_VALUE - 7u) return PL_ERROR_X86_SELECT;
    int status = pl_select_append_fixup(
        selection, PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT, 4u,
        output_at + 3u, output_at + 7u, target);
    if (status) return status;
    selection->fixups[selection->fixup_count - 1u].source_at = source_at;
    selection->fixups[selection->fixup_count - 1u].source_bytes =
        source_bytes;
    *bytes = 7u;
    return 1;
}

int pl_select_measure_direct_frame(const pl_x86_frontend *frontend,
                                const pl_x86_block *block,
                                pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || (block->flow == PL_X86_FLOW_JUMP
                && ((!block->dynamic_target
                     && block->successor_count != 1u)
                    || (block->dynamic_target
                        && block->successor_count != 0u)))
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    const pl_plan *plan = &block->plan;
    if (plan->node_count || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_u32 changed = 0u;
    pl_u32 base_local = PL_X86_LOCAL_COUNT;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) {
            if ((local != PL_X86_FS_BASE_LOCAL
                        && local != PL_X86_GS_BASE_LOCAL)
                    || base_local != PL_X86_LOCAL_COUNT
                    || value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)
                return 0;
            base_local = local;
            continue;
        }
        if ((value.kind != PL_OPERAND_CONST
                    && value.kind != PL_OPERAND_LOCAL)
                || (value.kind == PL_OPERAND_LOCAL
                    && value.value >= PL_X86_GPR_COUNT))
            return 0;
        changed |= 1u << local;
    }
    /* WRFSBASE/WRGSBASE can fault before the following control transfer.
     * Keep this production separate from GPR assignments so no publication
     * is moved across that precise fault cut. */
    if (base_local != PL_X86_LOCAL_COUNT && changed) return 0;
    pl_u32 bytes = 0u;
    pl_u32 instructions = 0u;
    pl_u32 pending = changed;
    /* `alias[s] = d` records that the entry value of S is now also held by D,
     * so a copy may read D and S may be overwritten.  This breaks a register
     * permutation cycle whose temporary is itself a publication
     * (`mov rax,rdi; mov rdi,rsi; mov rsi,rax`). */
    pl_u32 alias[PL_X86_GPR_COUNT];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        alias[local] = local;
    while (pending) {
        pl_u32 needed = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local))) continue;
            pl_operand value = plan->locals[local];
            if (value.kind == PL_OPERAND_LOCAL
                    && alias[(pl_u32)value.value] == (pl_u32)value.value)
                needed |= 1u << (pl_u32)value.value;
        }
        pl_u32 local = 0u;
        while (local < PL_X86_GPR_COUNT
                && (!(pending & (1u << local))
                    || (needed & (1u << local))))
            ++local;
        if (local == PL_X86_GPR_COUNT) return 0;
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL
                && alias[(pl_u32)value.value] != (pl_u32)value.value)
            value.value = alias[(pl_u32)value.value];
        pl_u32 encoded = 0u;
        int measured = pl_select_measure_frame_value(
            frontend, block, selection, local, value, bytes, &encoded);
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        if (plan->locals[local].kind == PL_OPERAND_LOCAL)
            alias[(pl_u32)plan->locals[local].value] = local;
        pending &= ~(1u << local);
    }
    if (base_local != PL_X86_LOCAL_COUNT) {
        if (bytes > U32_MAX_VALUE - 5u) return PL_ERROR_X86_SELECT;
        bytes += 5u;
        ++instructions;
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    if (!instructions) return 0;
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = 0u;
        pl_u32 target_owner = PL_X86_GPR_COUNT;
        if (block->dynamic_target) {
            if (!pl_select_published_operand_local(
                    plan, block->target, &target_owner)
                    || !pl_select_emit_indirect_jump(
                        target_owner, 0, &branch_bytes))
                return 0;
        } else {
            branch_bytes = block->relax_short_control ? 5u : 2u;
        }
        if (bytes > U32_MAX_VALUE - branch_bytes)
            return PL_ERROR_X86_SELECT;
        if (!block->dynamic_target) {
            int status = pl_select_append_control_fixup(
                frontend, block, selection,
                (pl_u8)(block->relax_short_control ? 4u : 1u),
                bytes + 1u, bytes + branch_bytes, block->successor[0]);
            if (status) return status;
        }
        bytes += branch_bytes;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int equal_compare_frame_shape(const pl_plan *plan,
                                     pl_u32 *changed,
                                     pl_u32 *anchor,
                                     pl_u32 *bits,
                                     pl_u64 *value)
{
    if (!plan || !changed || !anchor || !bits || !value
            || plan->node_count != 1u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->opcode != PL_OPCODE_X86_COMPARE
            || node->argument_count != 4u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[1].kind != PL_OPERAND_CONST
            || argument[2].kind != PL_OPERAND_CONST
            || argument[1].value != argument[2].value
            || argument[3].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[3].value;
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 mode = ((pl_u32)descriptor >> 8u) & 7u;
    if ((width != 32u && width != 64u)
            || mode != 3u || (descriptor >> 11u))
        return 0;
    pl_u32 mask = 0u;
    pl_u32 first = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand publication = plan->locals[local];
        if (local == PL_X86_RFLAGS_LOCAL) {
            if (publication.kind != PL_OPERAND_NODE
                    || publication.value != 1u)
                return 0;
            continue;
        }
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT
                || publication.kind != PL_OPERAND_CONST)
            return 0;
        mask |= 1u << local;
        if (publication.value == argument[1].value
                && first == PL_X86_GPR_COUNT)
            first = local;
    }
    if (!mask || first == PL_X86_GPR_COUNT) return 0;
    *changed = mask;
    *anchor = first;
    *bits = width;
    *value = argument[1].value;
    return 1;
}

static int common_constant_frame_shape(const pl_plan *plan,
                                       pl_u32 *changed,
                                       pl_u32 *anchor,
                                       pl_u64 *value)
{
    if (!plan || !changed || !anchor || !value || plan->node_count
            || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    pl_u32 mask = 0u;
    pl_u32 first = PL_X86_GPR_COUNT;
    pl_u64 common = 0u;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand publication = plan->locals[local];
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT
                || publication.kind != PL_OPERAND_CONST)
            return 0;
        if (first == PL_X86_GPR_COUNT) {
            first = local;
            common = publication.value;
        } else if (publication.value != common) {
            return 0;
        }
        mask |= 1u << local;
    }
    if (first == PL_X86_GPR_COUNT || !(mask & (mask - 1u))) return 0;
    *changed = mask;
    *anchor = first;
    *value = common;
    return 1;
}

/* After complete-future projection, an x-x compare may disappear while its
 * equal address publications remain. Their necessary-and-sufficient native
 * form is one address materialization plus register fanout; independently
 * materializing each equal constant would increase both bytes and work just
 * because the dead flag node was removed. */
int pl_select_measure_direct_common_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 1u)
        return 0;
    pl_u32 changed = 0u, anchor = 0u;
    pl_u64 common = 0u;
    if (!common_constant_frame_shape(
            &block->plan, &changed, &anchor, &common))
        return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_u64 target = 0u;
        pl_u32 source_at = 0u;
        pl_u8 source_bytes = 0u;
        int address = pl_select_source_address_binding(
            frontend, block, local, common,
            &target, &source_at, &source_bytes);
        if (address < 0) return address;
        if (address) {
            anchor = local;
            break;
        }
    }
    pl_operand common_value = { PL_OPERAND_CONST, common };
    pl_u32 bytes = 0u, encoded = 0u;
    int measured = pl_select_measure_frame_value(
        frontend, block, selection, anchor,
        common_value, bytes, &encoded);
    if (measured <= 0) return measured;
    bytes += encoded;
    pl_u32 primary_fixup = selection->fixup_count;
    if (primary_fixup) --primary_fixup;
    int absolute_bound = 0;
    pl_u32 instructions = 1u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        int absolute = !absolute_bound
            ? pl_select_append_absolute_source_fields(
                frontend, block, selection, bytes, common)
            : 0;
        if (absolute < 0) return absolute;
        pl_u32 publication_bytes = absolute ? 10u : 3u;
        if (bytes > U32_MAX_VALUE - publication_bytes)
            return PL_ERROR_X86_SELECT;
        bytes += publication_bytes;
        absolute_bound |= absolute != 0;
        pl_u64 target = 0u;
        pl_u32 source_at = 0u;
        pl_u8 source_bytes = 0u;
        int address = pl_select_source_address_binding(
            frontend, block, local, common,
            &target, &source_at, &source_bytes);
        if (address < 0) return address;
        if (address) {
            if (!selection->fixup_count
                    || selection->fixups[primary_fixup].kind
                       != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                    || selection->fixups[primary_fixup].target != target)
                return 0;
            pl_x86_native_fixup owner = selection->fixups[primary_fixup];
            int status = pl_select_append_fixup(
                selection, owner.kind, owner.bytes,
                owner.at, owner.next_ip_at, owner.target);
            if (status) return status;
            selection->fixups[selection->fixup_count - 1u].source_at =
                source_at;
            selection->fixups[selection->fixup_count - 1u].source_bytes =
                source_bytes;
        }
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
    selection->direct_common_frame = 1u;
    selection->frame_anchor = (pl_u8)anchor;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* An equal compare publishes independent GPR bindings and exact x-x flags.
 * Materialize the compared value once, fan out only equal bindings, emit
 * unrelated constants independently, then compare the owner with itself.
 * Source LEA fields alias their surviving target field, never the topology. */
int pl_select_measure_direct_equal_compare_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 1u)
        return 0;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    pl_u64 common = 0u;
    if (!equal_compare_frame_shape(
            &block->plan, &changed, &anchor, &bits, &common))
        return 0;
    /* Prefer a surviving linked-address owner for the common value.  This is
     * a binding choice only; the compare topology remains one class. */
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))
                || block->plan.locals[local].value != common)
            continue;
        pl_u64 target = 0u;
        pl_u32 source_at = 0u;
        pl_u8 source_bytes = 0u;
        int address = pl_select_source_address_binding(
            frontend, block, local, common,
            &target, &source_at, &source_bytes);
        if (address < 0) return address;
        if (address) {
            anchor = local;
            break;
        }
    }
    pl_u32 bytes = 0u;
    pl_u32 encoded = 0u;
    pl_operand common_value = { PL_OPERAND_CONST, common };
    int measured = pl_select_measure_frame_value(
        frontend, block, selection, anchor,
        common_value, bytes, &encoded);
    if (measured <= 0) return measured;
    bytes += encoded;
    pl_u32 primary_fixup = selection->fixup_count;
    if (primary_fixup) --primary_fixup;
    pl_u32 publications = 1u;
    int absolute_bound = 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        pl_operand publication = block->plan.locals[local];
        if (publication.value == common) {
            int absolute = !absolute_bound
                ? pl_select_append_absolute_source_fields(
                    frontend, block, selection, bytes, common)
                : 0;
            if (absolute < 0) return absolute;
            pl_u32 publication_bytes = absolute ? 10u : 3u;
            if (bytes > U32_MAX_VALUE - publication_bytes)
                return PL_ERROR_X86_SELECT;
            bytes += publication_bytes;
            absolute_bound |= absolute != 0;
            pl_u64 target = 0u;
            pl_u32 source_at = 0u;
            pl_u8 source_bytes = 0u;
            int address = pl_select_source_address_binding(
                frontend, block, local, common,
                &target, &source_at, &source_bytes);
            if (address < 0) return address;
            if (address) {
                if (!selection->fixup_count
                        || selection->fixups[primary_fixup].kind
                           != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                        || selection->fixups[primary_fixup].target != target)
                    return 0;
                pl_x86_native_fixup owner = selection->fixups[primary_fixup];
                int status = pl_select_append_fixup(
                    selection, owner.kind, owner.bytes,
                    owner.at, owner.next_ip_at, owner.target);
                if (status) return status;
                selection->fixups[selection->fixup_count - 1u].source_at =
                    source_at;
                selection->fixups[selection->fixup_count - 1u].source_bytes =
                    source_bytes;
            }
        } else {
            encoded = 0u;
            int other = pl_select_measure_frame_value(
                frontend, block, selection, local,
                publication, bytes, &encoded);
            if (other <= 0) return other;
            if (bytes > U32_MAX_VALUE - encoded)
                return PL_ERROR_X86_SELECT;
            bytes += encoded;
        }
        ++publications;
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 compare_bytes = 0u;
    if (!pl_select_emit_compare_same(anchor, bits, 0, &compare_bytes)
            || bytes > U32_MAX_VALUE - compare_bytes)
        return 0;
    bytes += compare_bytes;
    pl_u32 instructions = publications + 1u;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (bytes > U32_MAX_VALUE - 5u) return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(
            frontend, block, selection, 4u,
            bytes + 1u, bytes + 5u, block->successor[0]);
        if (status) return status;
        bytes += 5u;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_compare_frame = 1u;
    selection->frame_anchor = (pl_u8)anchor;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int constant_sar_zero_frame_shape(const pl_plan *plan,
                                         pl_u32 *changed,
                                         pl_u32 *anchor,
                                         pl_u32 *bits)
{
    if (!plan || !changed || !anchor || !bits
            || plan->node_count != 1u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->opcode != PL_OPCODE_X86_SHIFT_FLAGS
            || node->argument_count != 5u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *argument = plan->arguments + node->argument_at;
    if (argument[0].kind != PL_OPERAND_LOCAL
            || argument[0].value != PL_X86_RFLAGS_LOCAL
            || argument[1].kind != PL_OPERAND_CONST || argument[1].value
            || argument[2].kind != PL_OPERAND_CONST || argument[2].value
            || argument[3].kind != PL_OPERAND_CONST
            || argument[3].value != 1u
            || argument[4].kind != PL_OPERAND_CONST)
        return 0;
    pl_u64 descriptor = argument[4].value;
    pl_u32 width = (pl_u32)descriptor & 0x7fu;
    pl_u32 group = ((pl_u32)descriptor >> 8u) & 7u;
    if ((width != 32u && width != 64u)
            || group != 7u || descriptor != (pl_u64)(width | (7u << 8u)))
        return 0;
    pl_u32 mask = 0u;
    pl_u32 zero = PL_X86_GPR_COUNT;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand publication = plan->locals[local];
        if (local == PL_X86_RFLAGS_LOCAL) {
            if (publication.kind != PL_OPERAND_NODE
                    || publication.value != 1u)
                return 0;
            continue;
        }
        if (publication.kind == PL_OPERAND_LOCAL
                && publication.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT
                || publication.kind != PL_OPERAND_CONST)
            return 0;
        mask |= 1u << local;
        if (!publication.value && zero == PL_X86_GPR_COUNT) zero = local;
    }
    if (!mask || zero == PL_X86_GPR_COUNT) return 0;
    *changed = mask;
    *anchor = zero;
    *bits = width;
    return 1;
}

/* `sar 0,1` publishes exactly the same modeled flag word as `cmp z,z` for a
 * zero GPR: CF/PF/ZF/SF/OF are identical and all other architectural bits are
 * preserved.  Constants and addresses remain independent rank bindings, and
 * the already-decided control arm is emitted once. */
int pl_select_measure_direct_constant_shift_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || (block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_JUMP)
            || block->dynamic_target || block->has_predicate
            || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->successor_count != 1u)
        return 0;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    if (!constant_sar_zero_frame_shape(
            &block->plan, &changed, &anchor, &bits))
        return 0;
    pl_u32 bytes = 0u, instructions = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_operand value = block->plan.locals[local];
        pl_u32 encoded = 0u;
        int measured;
        if (!value.value) {
            measured = pl_select_emit_zero_register(local, 0, &encoded);
        } else {
            measured = pl_select_measure_frame_value(
                frontend, block, selection,
                local, value, bytes, &encoded);
        }
        if (measured <= 0) return measured;
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
    }
    int aliases = pl_select_alias_source_address_fields(frontend, block, selection);
    if (aliases <= 0) return aliases;
    pl_u32 compare_bytes = 0u;
    if (!pl_select_emit_compare_same(anchor, bits, 0, &compare_bytes)
            || bytes > U32_MAX_VALUE - compare_bytes)
        return 0;
    bytes += compare_bytes;
    ++instructions;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (bytes > U32_MAX_VALUE - 5u) return PL_ERROR_X86_SELECT;
        int status = pl_select_append_control_fixup(
            frontend, block, selection, 4u,
            bytes + 1u, bytes + 5u, block->successor[0]);
        if (status) return status;
        bytes += 5u;
        ++instructions;
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_shift_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

static int add_frame_shape(const pl_plan *plan, pl_u32 *node_destination,
                           pl_u32 *bits, pl_u32 *changed)
{
    if (!plan || !node_destination || !bits || !changed
            || plan->node_count != 1u || plan->stack_count
            || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->argument_count != 2u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    if (node->opcode == PL_OPCODE_ADD) *bits = 64u;
    else if (node->opcode == PL_OPCODE_ALU_IMMEDIATE[0][1]) *bits = 32u;
    else return 0;
    for (pl_u32 argument = 0u; argument < 2u; ++argument) {
        pl_operand value = plan->arguments[node->argument_at + argument];
        if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT))
            return 0;
    }
    *node_destination = PL_X86_GPR_COUNT;
    *changed = 0u;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (value.kind == PL_OPERAND_NODE) {
            if (value.value != 1u
                    || *node_destination != PL_X86_GPR_COUNT)
                return 0;
            *node_destination = local;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        *changed |= 1u << local;
    }
    return *node_destination < PL_X86_GPR_COUNT;
}

static int add_frame_sources(const pl_plan *plan, pl_u32 local,
                             pl_u32 node_destination, pl_u32 *sources)
{
    if (!plan || !sources || local >= PL_X86_GPR_COUNT) return 0;
    *sources = 0u;
    if (local == node_destination) {
        const pl_node *node = &plan->nodes[0];
        for (pl_u32 argument = 0u; argument < 2u; ++argument) {
            pl_operand value = plan->arguments[
                node->argument_at + argument];
            if (value.kind == PL_OPERAND_LOCAL)
                *sources |= 1u << (pl_u32)value.value;
        }
        return 1;
    }
    pl_operand value = plan->locals[local];
    if (value.kind == PL_OPERAND_LOCAL)
        *sources = 1u << (pl_u32)value.value;
    return 1;
}

static int next_add_frame_assignment(const pl_plan *plan, pl_u32 pending,
                                     pl_u32 node_destination,
                                     pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_u32 used_by_others = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            pl_u32 sources = 0u;
            if (!add_frame_sources(
                    plan, other, node_destination, &sources))
                return 0;
            used_by_others |= sources;
        }
        if (!(used_by_others & (1u << local))) {
            *selected = local;
            return 1;
        }
    }
    return 0;
}

int pl_select_measure_direct_add_frame(const pl_x86_frontend *frontend,
                                    const pl_x86_block *block,
                                    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 node_destination, bits, changed;
    if (!add_frame_shape(
            &block->plan, &node_destination, &bits, &changed))
        return 0;
    pl_u32 pending = changed;
    pl_u32 bytes = 0u;
    pl_u32 instructions = 0u;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_add_frame_assignment(
                &block->plan, pending, node_destination, &local))
            return 0;
        pl_u32 encoded = 0u;
        if (local == node_destination) {
            const pl_node *node = &block->plan.nodes[0];
            if (!pl_select_emit_add_lea(
                    local,
                    block->plan.arguments[node->argument_at],
                    block->plan.arguments[node->argument_at + 1u],
                    bits, (pl_u8 *)0, &encoded))
                return 0;
        } else {
            pl_operand value = block->plan.locals[local];
            int measured = pl_select_measure_frame_value(
                frontend, block, selection, local, value, bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded) return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_add_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* A wide constant cannot be an x86 LEA displacement. If the same constant
 * is also an architectural GPR publication, that register is the one exact
 * address operand: publish it once, then use it directly in the LEA. */
static int published_wide_add_shape(const pl_x86_block *block,
                                    published_wide_add *out)
{
    if (!block || !out || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->construction_fields || block->plan.node_count != 1u
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_plan *plan = &block->plan;
    published_wide_add shape = { PL_X86_GPR_COUNT,
                                 PL_X86_GPR_COUNT,
                                 PL_X86_GPR_COUNT, 0u };
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (value.kind == PL_OPERAND_CONST
                && shape.constant_local == PL_X86_GPR_COUNT) {
            shape.constant_local = local;
            shape.constant = value.value;
        } else if (value.kind == PL_OPERAND_NODE && value.value == 1u
                && shape.destination == PL_X86_GPR_COUNT) {
            shape.destination = local;
        } else {
            return 0;
        }
    }
    if (shape.constant_local == PL_X86_GPR_COUNT
            || shape.destination == PL_X86_GPR_COUNT
            || (shape.constant <= I32_MAX_VALUE
                || shape.constant >= 0xffffffff80000000ull))
        return 0;
    pl_operand left, right;
    pl_u32 bits = 0u, mode = 0u;
    if (!pl_select_arithmetic_tree_details(
            plan, (pl_operand){ PL_OPERAND_NODE, 1u },
            &left, &right, &bits, &mode)
            || bits != 64u || mode != 1u)
        return 0;
    pl_operand values[2] = { left, right };
    for (pl_u32 at = 0u; at < 2u; ++at) {
        if (values[at].kind != PL_OPERAND_CONST
                || values[at].value != shape.constant
                || values[at ^ 1u].kind != PL_OPERAND_LOCAL
                || values[at ^ 1u].value >= PL_X86_GPR_COUNT
                || values[at ^ 1u].value == shape.constant_local)
            continue;
        shape.source = (pl_u32)values[at ^ 1u].value;
        *out = shape;
        return 1;
    }
    return 0;
}

int pl_select_measure_direct_affine_frame(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return 0;
    published_wide_add wide;
    if (published_wide_add_shape(block, &wide)) {
        pl_u32 constant_bytes = 0u, lea_bytes = 0u;
        pl_operand constant = { PL_OPERAND_CONST, wide.constant };
        affine_lea form = { 0 };
        if (pl_select_measure_frame_value(frontend, block, selection,
                wide.constant_local, constant, 0u, &constant_bytes) <= 0
                || !pl_select_append_affine_local(&form, wide.source, 0u)
                || !pl_select_append_affine_local(&form, wide.constant_local, 0u)
                || !pl_select_emit_affine_lea_width(
                    wide.destination, form, 64u, 0, &lea_bytes)
                || constant_bytes > U32_MAX_VALUE - lea_bytes)
            return 0;
        selection->output_bytes = constant_bytes + lea_bytes;
        selection->output_instructions = 2u;
        selection->supported = 1u;
        selection->direct_frame = 1u;
        selection->direct_affine_frame = 1u;
        selection->reason = PL_X86_NATIVE_SELECT_READY;
        return 1;
    }
    if (!block->plan.node_count
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE
            || block->plan.stack_count
            || block->plan.local_count != PL_X86_LOCAL_COUNT
            || block->plan.locals[PL_X86_RFLAGS_LOCAL].kind
               != PL_OPERAND_LOCAL
            || block->plan.locals[PL_X86_RFLAGS_LOCAL].value
               != PL_X86_RFLAGS_LOCAL)
        return 0;
    pl_u32 changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!pl_select_alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local)
                return 0;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u;
            if (!pl_select_collect_native_affine_lea(
                    &block->plan, value, block->plan.node_count + 1u,
                    &form, &bits)
                    && !pl_select_zero_extend_node(
                        &block->plan, (pl_u32)value.value, &source, &bits)
                    && !pl_select_sign_extend_node(
                        &block->plan, (pl_u32)value.value, &source, &bits))
                return 0;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        changed |= 1u << local;
    }
    if (!changed) return 0;
    pl_u32 pending = changed, bytes = 0u, instructions = 0u, span = 0u;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u, work = 1u;
        if (!pl_select_next_compare_branch_assignment(
                &block->plan, pending, 0u, &local))
            return 0;
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_PROJECTION) {
            pl_u32 destination, node_bits, mode, preserves_carry;
            pl_operand source, right_operand;
            if (!pl_select_alu_node_details(
                    &block->plan, (pl_u32)(value.value >> 8u),
                    &destination, &source, &right_operand,
                    &node_bits, &mode, &preserves_carry)
                    || destination != local)
                return 0;
            pl_u32 prefix_work = 0u, operation = 0u;
            int measured = pl_select_measure_alu_seed(
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
            pl_u32 source = 0u, bits = 0u;
            if (pl_select_collect_native_affine_lea(
                    &block->plan, value, block->plan.node_count + 1u,
                    &form, &bits)) {
                if (!pl_select_emit_affine_lea_width(
                        local, form, bits, 0, &encoded))
                    return 0;
            } else if (!pl_select_zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)
                    || !pl_select_emit_zero_extend_move(
                        local, source, bits, 0, &encoded)) {
                if (!pl_select_sign_extend_node(
                        &block->plan, (pl_u32)value.value, &source, &bits)
                        || !pl_select_emit_sign_extend_move(
                            local, source, bits, 0, &encoded))
                    return 0;
            }
        } else {
            int measured = pl_select_measure_frame_value(
                frontend, block, selection, local, value, bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded
                || instructions > U32_MAX_VALUE - work)
            return PL_ERROR_X86_SELECT;
        bytes += encoded;
        instructions += work;
        if (work > span) span = work;
        pending &= ~(1u << local);
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_affine_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

/* A 32-bit GPR publication is a full 64-bit architectural write because x86
 * clears the upper half.  The physical spelling is therefore exactly one
 * lane insertion into zero, and its shortest native spelling is MOV r32,r32.
 * Keeping this as a direct rule avoids retaining a decoder spelling merely to
 * express the already-normalized publication. */
static int insert32_frame_shape(const pl_plan *plan, pl_u32 *destination,
                                pl_u32 *source, pl_u32 *changed)
{
    if (!plan || !destination || !source || !changed
            || plan->node_count != 1u
            || plan->stack_count || plan->local_count != PL_X86_LOCAL_COUNT)
        return 0;
    const pl_node *node = &plan->nodes[0];
    if (node->opcode != PL_OPCODE_LANE64_INSERT
            || node->argument_count != 3u
            || node->argument_at > plan->argument_count
            || node->argument_count
               > plan->argument_count - node->argument_at)
        return 0;
    const pl_operand *arguments = plan->arguments + node->argument_at;
    if (arguments[0].kind != PL_OPERAND_CONST || arguments[0].value
            || arguments[1].kind != PL_OPERAND_LOCAL
            || arguments[1].value >= PL_X86_GPR_COUNT
            || arguments[2].kind != PL_OPERAND_CONST
            || arguments[2].value != 32u)
        return 0;
    *destination = PL_X86_GPR_COUNT;
    *changed = 0u;
    for (pl_u32 local = 0u; local < plan->local_count; ++local) {
        pl_operand value = plan->locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local)
            continue;
        if (local >= PL_X86_GPR_COUNT) return 0;
        if (value.kind == PL_OPERAND_NODE) {
            if (value.value != 1u
                    || *destination != PL_X86_GPR_COUNT)
                return 0;
            *destination = local;
        } else if (value.kind != PL_OPERAND_CONST
                && (value.kind != PL_OPERAND_LOCAL
                    || value.value >= PL_X86_GPR_COUNT)) {
            return 0;
        }
        *changed |= 1u << local;
    }
    if (*destination >= PL_X86_GPR_COUNT) return 0;
    *source = (pl_u32)arguments[1].value;
    return 1;
}

static int insert_frame_sources(const pl_plan *plan, pl_u32 local,
                                pl_u32 destination, pl_u32 source,
                                pl_u32 *sources)
{
    if (!plan || !sources || local >= PL_X86_GPR_COUNT) return 0;
    *sources = 0u;
    if (local == destination) {
        *sources = 1u << source;
        return 1;
    }
    pl_operand value = plan->locals[local];
    if (value.kind == PL_OPERAND_LOCAL)
        *sources = 1u << (pl_u32)value.value;
    return 1;
}

static int next_insert_frame_assignment(
    const pl_plan *plan, pl_u32 pending,
    pl_u32 destination, pl_u32 source, pl_u32 *selected)
{
    if (!plan || !pending || !selected) return 0;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(pending & (1u << local))) continue;
        pl_u32 used = 0u;
        for (pl_u32 other = 0u; other < PL_X86_GPR_COUNT; ++other) {
            if (other == local || !(pending & (1u << other))) continue;
            pl_u32 sources = 0u;
            if (!insert_frame_sources(
                    plan, other, destination, source, &sources))
                return 0;
            used |= sources;
        }
        if (!(used & (1u << local))) {
            *selected = local;
            return 1;
        }
    }
    return 0;
}

static int emit_insert32_move(pl_u32 destination, pl_u32 source,
                              pl_u8 *output, pl_u32 *written)
{
    return pl_select_emit_gpr_move(destination, source, 32u, output, written);
}

int pl_select_measure_direct_insert_frame(const pl_x86_frontend *frontend,
                                       const pl_x86_block *block,
                                       pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection
            || block->kind != PL_X86_BLOCK_DIRECT
            || block->flow != PL_X86_FLOW_NEXT || block->dynamic_target
            || block->has_predicate || block->has_fault_predicate
            || block->machine_operation != PL_X86_MACHINE_NONE)
        return 0;
    pl_u32 destination, source, changed;
    if (!insert32_frame_shape(
            &block->plan, &destination, &source, &changed))
        return 0;
    pl_u32 pending = changed, bytes = 0u, instructions = 0u;
    while (pending) {
        pl_u32 local = 0u, encoded = 0u;
        if (!next_insert_frame_assignment(
                &block->plan, pending,
                destination, source, &local))
            return 0;
        if (local == destination) {
            if (!emit_insert32_move(
                    destination, source, (pl_u8 *)0, &encoded))
                return 0;
        } else {
            int measured = pl_select_measure_frame_value(
                frontend, block, selection, local,
                block->plan.locals[local], bytes, &encoded);
            if (measured <= 0) return measured;
        }
        if (bytes > U32_MAX_VALUE - encoded)
            return PL_ERROR_X86_SELECT;
        bytes += encoded;
        ++instructions;
        pending &= ~(1u << local);
    }
    selection->output_bytes = bytes;
    selection->output_instructions = instructions;
    selection->supported = 1u;
    selection->direct_frame = 1u;
    selection->direct_insert_frame = 1u;
    selection->reason = PL_X86_NATIVE_SELECT_READY;
    return 1;
}

int pl_select_write_direct_frame(const pl_x86_block *block,
                              const pl_x86_native_selection *selection,
                              pl_u8 *output)
{
    if (!block || !selection || !selection->direct_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u;
    pl_u32 pending = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        if (value.kind != PL_OPERAND_LOCAL || value.value != local)
            pending |= 1u << local;
    }
    pl_u32 alias[PL_X86_GPR_COUNT];
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
        alias[local] = local;
    while (pending) {
        pl_u32 needed = 0u;
        for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
            if (!(pending & (1u << local))) continue;
            pl_operand value = block->plan.locals[local];
            if (value.kind == PL_OPERAND_LOCAL) {
                if (value.value >= PL_X86_GPR_COUNT)
                    return PL_ERROR_X86_SELECT;
                if (alias[(pl_u32)value.value] == (pl_u32)value.value)
                    needed |= 1u << (pl_u32)value.value;
            }
        }
        pl_u32 local = 0u;
        while (local < PL_X86_GPR_COUNT
                && (!(pending & (1u << local))
                    || (needed & (1u << local))))
            ++local;
        if (local == PL_X86_GPR_COUNT) return PL_ERROR_X86_SELECT;
        pl_operand value = block->plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL
                && alias[(pl_u32)value.value] != (pl_u32)value.value)
            value.value = alias[(pl_u32)value.value];
        pl_u32 encoded = 0u;
        if (!pl_select_write_frame_value(
                selection, at, local, value, output + at, &encoded))
            return PL_ERROR_X86_SELECT;
        at += encoded;
        if (block->plan.locals[local].kind == PL_OPERAND_LOCAL)
            alias[(pl_u32)block->plan.locals[local].value] = local;
        pending &= ~(1u << local);
    }
    for (pl_u32 base = PL_X86_FS_BASE_LOCAL;
            base <= PL_X86_GS_BASE_LOCAL; ++base) {
        pl_operand value = block->plan.locals[base];
        if (value.kind == PL_OPERAND_LOCAL && value.value == base)
            continue;
        if (value.kind != PL_OPERAND_LOCAL
                || value.value >= PL_X86_GPR_COUNT
                || at > selection->output_bytes
                || selection->output_bytes - at < 5u)
            return PL_ERROR_X86_SELECT;
        pl_u32 source = (pl_u32)value.value;
        output[at++] = 0xf3u;
        output[at++] = (pl_u8)(0x48u | (source >= 8u ? 1u : 0u));
        output[at++] = 0x0fu;
        output[at++] = 0xaeu;
        output[at++] = (pl_u8)(0xd0u
            | (base == PL_X86_GS_BASE_LOCAL ? 8u : 0u)
            | (source & 7u));
    }
    if (block->flow == PL_X86_FLOW_JUMP) {
        pl_u32 branch_bytes = 0u;
        pl_u32 target_owner = PL_X86_GPR_COUNT;
        if (block->dynamic_target) {
            if (!pl_select_published_operand_local(
                    &block->plan, block->target, &target_owner)
                    || !pl_select_emit_indirect_jump(
                        target_owner, 0, &branch_bytes))
                return PL_ERROR_X86_SELECT;
        } else {
            branch_bytes = block->relax_short_control ? 5u : 2u;
        }
        if (at > selection->output_bytes
                || selection->output_bytes - at != branch_bytes)
            return PL_ERROR_X86_SELECT;
        if (block->dynamic_target) {
            if (!pl_select_emit_indirect_jump(
                    target_owner, output + at, &branch_bytes))
                return PL_ERROR_X86_SELECT;
            at += branch_bytes;
        } else {
            output[at++] = block->relax_short_control ? 0xe9u : 0xebu;
            for (pl_u32 byte = 1u; byte < branch_bytes; ++byte)
                output[at++] = 0u;
        }
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_add_frame(const pl_x86_block *block,
                                  const pl_x86_native_selection *selection,
                                  pl_u8 *output)
{
    if (!block || !selection || !selection->direct_add_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 node_destination, bits, changed;
    if (!add_frame_shape(
            &block->plan, &node_destination, &bits, &changed))
        return PL_ERROR_X86_SELECT;
    pl_u32 pending = changed;
    pl_u32 at = 0u;
    while (pending) {
        pl_u32 local = 0u;
        if (!next_add_frame_assignment(
                &block->plan, pending, node_destination, &local))
            return PL_ERROR_X86_SELECT;
        if (local == node_destination) {
            const pl_node *node = &block->plan.nodes[0];
            pl_u32 encoded = 0u;
            if (!pl_select_emit_add_lea(
                    local,
                    block->plan.arguments[node->argument_at],
                    block->plan.arguments[node->argument_at + 1u],
                    bits, output + at, &encoded))
                return PL_ERROR_X86_SELECT;
            at += encoded;
        } else {
            pl_operand value = block->plan.locals[local];
            pl_u32 encoded = 0u;
            if (!pl_select_write_frame_value(
                    selection, at, local, value, output + at, &encoded))
                return PL_ERROR_X86_SELECT;
            at += encoded;
        }
        pending &= ~(1u << local);
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_shared_parent_frame(
    const pl_x86_block *block, const pl_x86_native_selection *selection,
    const shared_parent_frame *shape, pl_u8 *output)
{
    if (!block || !selection || !shape || !output) return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, part = 0u;
    if (!pl_select_write_alu_tree(
            block, selection, shape->destination, shape->accumulator,
            shape->bits, at, block->plan.node_count + 1u, 0u,
            output + at, &part))
        return PL_ERROR_X86_SELECT;
    at += part;
#define WRITE_SHARED_PARENT(operation_) do {                               \
        part = 0u;                                                          \
        if (!(operation_) || at > U32_MAX_VALUE - part)                    \
            return PL_ERROR_X86_SELECT;                                    \
        at += part;                                                         \
    } while (0)
    WRITE_SHARED_PARENT(pl_select_emit_shift_instruction(
        shape->mutable_owner, shape->parent_shift_amount,
        shape->bits, shape->parent_shift_group, output + at, &part));
    WRITE_SHARED_PARENT(pl_select_emit_gpr_move(
        shape->sibling_owner, shape->mutable_owner,
        shape->bits, output + at, &part));
    WRITE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->mutable_owner, shape->mutable_right,
        shape->bits, shape->mutable_mode, 0u, output + at, &part));
    WRITE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->sibling_owner, shape->sibling_right,
        shape->bits, shape->sibling_mode, 0u, output + at, &part));
    pl_operand sibling = { PL_OPERAND_LOCAL, shape->sibling_owner };
    pl_operand mutable = { PL_OPERAND_LOCAL, shape->mutable_owner };
    WRITE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->destination, sibling, shape->bits,
        shape->root_mode, 0u, output + at, &part));
    WRITE_SHARED_PARENT(pl_select_emit_alu_instruction(
        shape->destination, mutable, shape->bits,
        shape->root_mode, 0u, output + at, &part));
#undef WRITE_SHARED_PARENT
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

int pl_select_write_direct_affine_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_affine_frame || !output)
        return PL_ERROR_X86_SELECT;
    published_wide_add wide;
    if (published_wide_add_shape(block, &wide)) {
        pl_u32 constant_bytes = 0u, lea_bytes = 0u;
        pl_operand constant = { PL_OPERAND_CONST, wide.constant };
        affine_lea form = { 0 };
        if (!pl_select_write_frame_value(
                selection, 0u, wide.constant_local, constant,
                output, &constant_bytes)
                || constant_bytes > selection->output_bytes
                || !pl_select_append_affine_local(&form, wide.source, 0u)
                || !pl_select_append_affine_local(&form, wide.constant_local, 0u)
                || !pl_select_emit_affine_lea_width(
                    wide.destination, form, 64u,
                    output + constant_bytes, &lea_bytes)
                || lea_bytes != selection->output_bytes - constant_bytes)
            return PL_ERROR_X86_SELECT;
        return 0;
    }
    pl_u32 changed = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        pl_operand value = block->plan.locals[local];
        if (!(value.kind == PL_OPERAND_LOCAL && value.value == local))
            changed |= 1u << local;
    }
    pl_u32 pending = changed, at = 0u;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!pl_select_next_compare_branch_assignment(
                &block->plan, pending, 0u, &local))
            return PL_ERROR_X86_SELECT;
        pl_operand value = block->plan.locals[local];
        int emitted;
        if (value.kind == PL_OPERAND_PROJECTION) {
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
                        local, right_operand, node_bits, mode,
                        preserves_carry, output + at, &written))
                return PL_ERROR_X86_SELECT;
            emitted = 1;
        } else if (value.kind == PL_OPERAND_NODE) {
            affine_lea form = { 0 };
            pl_u32 source = 0u, bits = 0u;
            emitted = pl_select_collect_native_affine_lea(
                &block->plan, value, block->plan.node_count + 1u,
                &form, &bits)
                ? pl_select_emit_affine_lea_width(
                    local, form, bits, output + at, &written)
                : pl_select_zero_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits)
                  && pl_select_emit_zero_extend_move(
                    local, source, bits, output + at, &written);
            if (!emitted && pl_select_sign_extend_node(
                    &block->plan, (pl_u32)value.value, &source, &bits))
                emitted = pl_select_emit_sign_extend_move(
                    local, source, bits, output + at, &written);
        } else {
            emitted = pl_select_write_frame_value(
                selection, at, local, value, output + at, &written);
        }
        if (!emitted || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_common_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_common_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, anchor = 0u;
    pl_u64 common = 0u;
    if (!common_constant_frame_shape(
            &block->plan, &changed, &anchor, &common))
        return PL_ERROR_X86_SELECT;
    anchor = selection->frame_anchor;
    if (anchor >= PL_X86_GPR_COUNT
            || !(changed & (1u << anchor))
            || block->plan.locals[anchor].kind != PL_OPERAND_CONST
            || block->plan.locals[anchor].value != common)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, encoded = 0u;
    pl_operand value = { PL_OPERAND_CONST, common };
    if (!pl_select_write_frame_value(
            selection, at, anchor, value, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    value.kind = PL_OPERAND_LOCAL;
    value.value = anchor;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        pl_operand emitted = !pl_select_absolute_fixup_at(selection, at, common)
                           ? value : block->plan.locals[local];
        encoded = 0u;
        if (!pl_select_write_frame_value(
                selection, at, local, emitted, output + at, &encoded))
            return PL_ERROR_X86_SELECT;
        at += encoded;
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

int pl_select_write_direct_equal_compare_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_compare_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    pl_u64 common = 0u;
    if (!equal_compare_frame_shape(
            &block->plan, &changed, &anchor, &bits, &common))
        return PL_ERROR_X86_SELECT;
    anchor = selection->frame_anchor;
    if (anchor >= PL_X86_GPR_COUNT
            || !(changed & (1u << anchor))
            || block->plan.locals[anchor].kind != PL_OPERAND_CONST
            || block->plan.locals[anchor].value != common)
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u, encoded = 0u;
    pl_operand value = { PL_OPERAND_CONST, common };
    if (!pl_select_write_frame_value(
            selection, at, anchor, value, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    value.kind = PL_OPERAND_LOCAL;
    value.value = anchor;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (local == anchor || !(changed & (1u << local))) continue;
        pl_operand publication = block->plan.locals[local];
        pl_operand emitted = publication.value == common
                           && !pl_select_absolute_fixup_at(selection, at, common)
                           ? value : publication;
        encoded = 0u;
        if (!pl_select_write_frame_value(
                selection, at, local, emitted, output + at, &encoded))
            return PL_ERROR_X86_SELECT;
        at += encoded;
    }
    if (!pl_select_emit_compare_same(anchor, bits, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 5u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0xe9u;
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_constant_shift_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_shift_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 changed = 0u, anchor = 0u, bits = 0u;
    if (!constant_sar_zero_frame_shape(
            &block->plan, &changed, &anchor, &bits))
        return PL_ERROR_X86_SELECT;
    pl_u32 at = 0u;
    for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local) {
        if (!(changed & (1u << local))) continue;
        pl_operand value = block->plan.locals[local];
        pl_u32 encoded = 0u;
        int emitted = !value.value
                    ? pl_select_emit_zero_register(local, output + at, &encoded)
                    : pl_select_write_frame_value(
                        selection, at, local, value,
                        output + at, &encoded);
        if (!emitted) return PL_ERROR_X86_SELECT;
        at += encoded;
    }
    pl_u32 encoded = 0u;
    if (!pl_select_emit_compare_same(anchor, bits, output + at, &encoded))
        return PL_ERROR_X86_SELECT;
    at += encoded;
    if (block->flow == PL_X86_FLOW_JUMP) {
        if (at > selection->output_bytes
                || selection->output_bytes - at != 5u)
            return PL_ERROR_X86_SELECT;
        output[at++] = 0xe9u;
        for (pl_u32 byte = 0u; byte < 4u; ++byte) output[at++] = 0u;
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}

int pl_select_write_direct_insert_frame(
    const pl_x86_block *block,
    const pl_x86_native_selection *selection, pl_u8 *output)
{
    if (!block || !selection || !selection->direct_insert_frame || !output)
        return PL_ERROR_X86_SELECT;
    pl_u32 destination, source, changed;
    if (!insert32_frame_shape(
            &block->plan, &destination, &source, &changed))
        return PL_ERROR_X86_SELECT;
    pl_u32 pending = changed, at = 0u;
    while (pending) {
        pl_u32 local = 0u, written = 0u;
        if (!next_insert_frame_assignment(
                &block->plan, pending,
                destination, source, &local))
            return PL_ERROR_X86_SELECT;
        int emitted = local == destination
            ? emit_insert32_move(
                destination, source, output + at, &written)
            : pl_select_write_frame_value(
                selection, at, local, block->plan.locals[local],
                output + at, &written);
        if (!emitted || at > selection->output_bytes
                || written > selection->output_bytes - at)
            return PL_ERROR_X86_SELECT;
        at += written;
        pending &= ~(1u << local);
    }
    return at == selection->output_bytes ? 0 : PL_ERROR_X86_SELECT;
}
