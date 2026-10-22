/* source: native x86 selection. */
#include "source.h"
#include "limits.h"

static int instruction_writes_gpr(const pl_x86_instruction *instruction,
                                  pl_u32 local);

static int source_address_definition_uncached(
    const pl_x86_frontend *frontend,
    const pl_x86_block *block,
    pl_u32 local, pl_u64 value,
    pl_u32 bits, pl_u64 *address,
    pl_u32 *source_at);

/* Detect every explicit or conditional write that invalidates an address
 * owner, including writes hidden from the assembly operand spelling. */
static int instruction_writes_gpr(const pl_x86_instruction *instruction,
                                  pl_u32 local)
{
    if (!instruction || local >= PL_X86_GPR_COUNT) return 0;
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index) {
        const pl_x86_operand *operand = &instruction->operands[index];
        if (operand->kind == PL_X86_OPERAND_REGISTER
                && operand->value.reg.class_id == PL_X86_REGISTER_GPR
                && operand->value.reg.index == local
                && (operand->flags & (PL_X86_OPERAND_WRITE
                                      | PL_X86_OPERAND_CONDITIONAL_WRITE)))
            return 1;
    }
    return 0;
}

/* Address identity is a build binding, not a scalar constant and not source
 * spelling.  Recover the last defining RIP-relative LEA for a surviving GPR
 * value and carry its linked target as a native fixup rank.  Any intervening
 * write kills the binding.  The emitted frame can then move independently of
 * its source bytes without baking the old instruction coordinate into ELF. */
int pl_select_source_address_binding(const pl_x86_frontend *frontend,
                                  const pl_x86_block *block,
                                  pl_u32 local, pl_u64 value,
                                  pl_u64 *target,
                                  pl_u32 *source_at,
                                  pl_u8 *source_bytes)
{
    if (!frontend || !block || !target || !source_at || !source_bytes
            || local >= PL_X86_GPR_COUNT)
        return PL_ERROR_X86_SELECT;
    int found = 0;
    pl_u64 selected = 0u;
    pl_u32 selected_source_at = 0u;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (instruction_writes_gpr(&instruction, local)) {
            found = 0;
            if (instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                    && instruction.visible_operand_count >= 2u
                    && instruction.operands[0].kind
                       == PL_X86_OPERAND_REGISTER
                    && instruction.operands[0].bits == 64u
                    && instruction.operands[0].value.reg.class_id
                       == PL_X86_REGISTER_GPR
                    && instruction.operands[0].value.reg.index == local
                    && instruction.operands[1].kind
                       == PL_X86_OPERAND_MEMORY
                    && instruction.operands[1].value.memory.base.class_id
                       == PL_X86_REGISTER_IP
                    && instruction.displacement_bytes == 4u
                    && instruction.displacement_offset + 4u
                       <= instruction.source_bytes
                    && rip >= block->start
                    && rip - block->start
                       <= U32_MAX_VALUE
                          - instruction.displacement_offset) {
                selected = instruction.fallthrough
                         + (pl_u64)instruction.operands[1]
                                      .value.memory.displacement;
                selected_source_at = (pl_u32)(rip - block->start)
                                   + instruction.displacement_offset;
                found = selected == value;
            }
        }
        rip = instruction.fallthrough;
    }
    if (rip != block->end) return PL_ERROR_X86_SELECT;
    if (found) {
        *target = selected;
        *source_at = selected_source_at;
        *source_bytes = 4u;
    }
    return found;
}

/* Recover an address-valued intermediate even when later arithmetic replaces
 * the destination's final publication.  The relocation field is still the
 * unique authority for that constant; subsequent SSA nodes consume the
 * address value but do not turn it into an untyped integer literal. */
static int source_address_definition_uncached(
    const pl_x86_frontend *frontend,
    const pl_x86_block *block,
    pl_u32 local, pl_u64 value,
    pl_u32 bits, pl_u64 *address,
    pl_u32 *source_at)
{
    if (!frontend || !block || !address || !source_at)
        return PL_ERROR_X86_SELECT;
    /* Address materialisation is a 32/64-bit projection.  A narrower probe is
     * simply not an address definition, not a malformed request; returning the
     * "not found" answer keeps the frame productions total instead of aborting
     * the whole selection (e.g. a byte `sbb al,imm8` value tree). */
    if ((bits != 32u && bits != 64u) || local >= PL_X86_GPR_COUNT)
        return 0;
    pl_u64 mask = bits == 32u ? U32_MAX_VALUE : U64_MAX_VALUE;
    int found = 0;
    int generic_found = 0;
    pl_u64 generic_address = 0u;
    pl_u32 generic_source_at = 0u;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                && instruction.visible_operand_count >= 2u
                && instruction.operands[0].kind == PL_X86_OPERAND_REGISTER
                && instruction.operands[0].bits == 64u
                && instruction.operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && instruction.operands[1].kind == PL_X86_OPERAND_MEMORY
                && instruction.operands[1].value.memory.base.class_id
                   == PL_X86_REGISTER_IP
                && instruction.displacement_bytes == 4u
                && instruction.displacement_offset + 4u
                   <= instruction.source_bytes
                && rip >= block->start
                && rip - block->start
                   <= U32_MAX_VALUE - instruction.displacement_offset) {
            pl_u64 target = instruction.fallthrough
                + (pl_u64)instruction.operands[1].value.memory.displacement;
            if ((target & mask) == (value & mask)) {
                pl_u32 at = (pl_u32)(rip - block->start)
                          + instruction.displacement_offset;
                if (instruction.operands[0].value.reg.index == local) {
                    if (found) return 0;
                    *address = target;
                    *source_at = at;
                    found = 1;
                } else {
                    /* The LEA destination may have been renamed by the
                     * normalizer; a unique target still binds the field. */
                    if (generic_found) return 0;
                    generic_address = target;
                    generic_source_at = at;
                    generic_found = 1;
                }
            }
        }
        rip = instruction.fallthrough;
    }
    if (!found && generic_found) {
        *address = generic_address;
        *source_at = generic_source_at;
        found = 1;
    }
    return rip == block->end ? found : PL_ERROR_X86_SELECT;
}

/* Repeated tree probes in one grammar invocation share bounded scratch for
 * one immutable source block. Trial schedules consult the same authority;
 * collisions only cause a re-decode. Enumeration returns no scratch pointer. */
int pl_select_source_address_definition(const pl_x86_frontend *frontend,
                                     const pl_x86_block *block,
                                     pl_x86_native_selection *selection,
                                     pl_u32 local, pl_u64 value,
                                     pl_u32 bits, pl_u64 *address,
                                     pl_u32 *source_at)
{
    if (!frontend || !block || !selection || !address || !source_at)
        return PL_ERROR_X86_SELECT;
    /* Address materialisation is a 32/64-bit projection.  A narrower probe is
     * simply not an address definition, not a malformed request; returning the
     * "not found" answer keeps the frame productions total instead of aborting
     * the whole selection (e.g. a byte `sbb al,imm8` value tree). */
    if ((bits != 32u && bits != 64u) || local >= PL_X86_GPR_COUNT)
        return 0;
    if (!selection->address_memo)
        return source_address_definition_uncached(
            frontend, block, local, value, bits, address, source_at);
    pl_u32 key = ((pl_u32)local * 3266489917u)
               ^ (pl_u32)(value * 668265263u) ^ bits;
    pl_x86_address_memo_entry *memo =
        &selection->address_memo[key & (PL_X86_ADDRESS_MEMO_COUNT - 1u)];
    if (memo->valid && memo->local == local && memo->value == value
            && memo->bits == bits) {
        if (!memo->found) return 0;
        *address = memo->address;
        *source_at = memo->source_at;
        return 1;
    }
    int status = source_address_definition_uncached(
        frontend, block, local, value, bits, address, source_at);
    if (status == 0 || status == 1) {
        memo->valid = 1u;
        memo->local = local;
        memo->value = value;
        memo->bits = bits;
        memo->found = (pl_u8)status;
        if (status == 1) {
            memo->address = *address;
            memo->source_at = *source_at;
        }
    }
    return status;
}

/* Every removed source relocation field must retain one exact owner in the
 * normalized spelling.  Multiple LEAs of the same linked address are binding
 * aliases, not distinct runtime work: attach all source fields to the one
 * surviving RIP fixup.  If any target has no owner, this candidate is not a
 * closed native representation and source spelling remains the diagnostic. */
int pl_select_alias_source_address_fields(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection)
{
    if (!frontend || !block || !selection) return PL_ERROR_X86_SELECT;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        if (instruction.operation == PL_X86_OPERATION_LOAD_ADDRESS
                && instruction.visible_operand_count >= 2u
                && instruction.operands[1].kind == PL_X86_OPERAND_MEMORY
                && instruction.operands[1].value.memory.base.class_id
                   == PL_X86_REGISTER_IP
                && instruction.displacement_bytes == 4u
                && instruction.displacement_offset + 4u
                   <= instruction.source_bytes
                && rip >= block->start
                && rip - block->start
                   <= U32_MAX_VALUE - instruction.displacement_offset) {
            pl_u32 source_at = (pl_u32)(rip - block->start)
                             + instruction.displacement_offset;
            int owned = 0;
            for (pl_u32 fixup = 0u; fixup < selection->fixup_count; ++fixup)
                if (selection->fixups[fixup].source_bytes == 4u
                        && selection->fixups[fixup].source_at == source_at) {
                    owned = 1;
                    break;
                }
            if (!owned) {
                pl_u64 target = instruction.fallthrough
                    + (pl_u64)instruction.operands[1]
                                      .value.memory.displacement;
                pl_u32 owner = selection->fixup_count;
                for (pl_u32 fixup = 0u;
                        fixup < selection->fixup_count; ++fixup)
                    if (selection->fixups[fixup].kind
                           == PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT
                            && selection->fixups[fixup].target == target) {
                        owner = fixup;
                        break;
                    }
                if (owner == selection->fixup_count) return 0;
                pl_x86_native_fixup canonical = selection->fixups[owner];
                status = pl_select_append_fixup(
                    selection, canonical.kind, canonical.bytes,
                    canonical.at, canonical.next_ip_at, canonical.target);
                if (status) return status;
                selection->fixups[selection->fixup_count - 1u].source_at =
                    source_at;
                selection->fixups[selection->fixup_count - 1u].source_bytes =
                    4u;
            }
        }
        rip = instruction.fallthrough;
    }
    return rip == block->end ? 1 : PL_ERROR_X86_SELECT;
}

/* An absolute construction expression may disappear under constant
 * substitution even though its final address remains live.  All eight-byte
 * source immediate fields can share one canonical MOVABS field; the output
 * fixup carries the final linked target, while source offsets remain separate
 * binding ranks for relocation closure. */
int pl_select_append_absolute_source_fields(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection,
    pl_u32 output_at, pl_u64 target)
{
    if (!frontend || !block || !selection) return PL_ERROR_X86_SELECT;
    if (!block->construction_fields) return 0;
    if (output_at > U32_MAX_VALUE - 10u) return PL_ERROR_X86_SELECT;
    pl_u32 fields = 0u;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        for (pl_u32 immediate = 0u; immediate < 2u; ++immediate) {
            if (instruction.immediate_bytes[immediate] != 8u
                    || instruction.immediate_offset[immediate] + 8u
                       > instruction.source_bytes
                    || rip < block->start
                    || rip - block->start
                       > U32_MAX_VALUE
                          - instruction.immediate_offset[immediate])
                continue;
            status = pl_select_append_fixup(
                selection, PL_X86_NATIVE_FIXUP_ABSOLUTE, 8u,
                output_at + 2u, output_at + 10u, target);
            if (status) return status;
            selection->fixups[selection->fixup_count - 1u].source_at =
                (pl_u32)(rip - block->start)
                + instruction.immediate_offset[immediate];
            selection->fixups[selection->fixup_count - 1u].source_bytes =
                8u;
            ++fields;
        }
        rip = instruction.fallthrough;
    }
    return rip == block->end ? (int)fields : PL_ERROR_X86_SELECT;
}

int pl_select_source_terminal(const pl_x86_instruction *instruction)
{
    return instruction->flow != PL_X86_FLOW_NEXT
        || !!(instruction->flags & (PL_X86_INSTRUCTION_MAY_TRAP
                                    | PL_X86_INSTRUCTION_PRECISE_CUT
                                    | PL_X86_INSTRUCTION_BARRIER));
}

int pl_select_final_instruction(const pl_x86_frontend *frontend,
                             const pl_x86_block *block,
                             pl_x86_instruction *out)
{
    if (!frontend || !block || !out || !block->instruction_count)
        return PL_ERROR_X86_SELECT;
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        int status = pl_x86_frontend_decode(frontend, rip, out);
        if (status) return status;
        rip = out->fallthrough;
    }
    return 0;
}

int pl_select_append_fixup(pl_x86_native_selection *selection, pl_u8 kind,
                        pl_u8 bytes, pl_u32 at, pl_u32 next_ip_at,
                        pl_u64 target)
{
    if (!bytes || at > next_ip_at
            || selection->fixup_count >= PL_X86_NATIVE_MAX_FIXUPS)
        return PL_ERROR_X86_SELECT;
    pl_x86_native_fixup *fixup =
        &selection->fixups[selection->fixup_count++];
    *fixup = (pl_x86_native_fixup){
        at, next_ip_at, target, 0u, kind, bytes, 0u, { 0u }
    };
    return 0;
}

/* A normalized control field and its linked construction expression are one
 * address binding.  Output width may change during rel8 relaxation, but the
 * source coordinate remains the unique relocation owner. */
int pl_select_append_control_fixup(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_x86_native_selection *selection, pl_u8 bytes,
    pl_u32 at, pl_u32 next_ip_at, pl_u64 target)
{
    pl_x86_instruction terminal;
    int status = pl_select_final_instruction(frontend, block, &terminal);
    if (status) return status;
    pl_u8 source_bytes = terminal.immediate_bytes[0];
    if (!(terminal.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            || terminal.target != target
            || (source_bytes != 1u && source_bytes != 4u)
            || terminal.immediate_offset[0] > terminal.source_bytes
            || source_bytes
               > terminal.source_bytes - terminal.immediate_offset[0]
            || block->end < block->start
            || block->end - block->start < terminal.source_bytes
            || block->end - block->start - terminal.source_bytes
               > U32_MAX_VALUE - terminal.immediate_offset[0])
        return PL_ERROR_X86_SELECT;
    pl_u32 source_at = (pl_u32)(block->end - block->start
                       - terminal.source_bytes)
                     + terminal.immediate_offset[0];
    status = pl_select_append_fixup(
        selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE,
        bytes, at, next_ip_at, target);
    if (status) return status;
    pl_x86_native_fixup *fixup =
        &selection->fixups[selection->fixup_count - 1u];
    fixup->source_at = source_at;
    fixup->source_bytes = source_bytes;
    return 0;
}

int pl_select_direct_control(const pl_x86_instruction *instruction,
                          pl_u32 output_at, int relax_short_control,
                          pl_x86_native_selection *selection)
{
    if (!(instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)) return 0;
    pl_u32 bytes = instruction->source_bytes;
    pl_u32 field = instruction->immediate_offset[0];
    pl_u8 field_bytes = instruction->immediate_bytes[0];
    if ((instruction->flow == PL_X86_FLOW_JUMP
                && instruction->operation == PL_X86_OPERATION_BRANCH)
            || (instruction->flow == PL_X86_FLOW_CALL
                && instruction->operation == PL_X86_OPERATION_CALL)) {
    } else if (instruction->flow == PL_X86_FLOW_CONDITIONAL
            && ((instruction->operation == PL_X86_OPERATION_BRANCH
                 && instruction->condition <= 15u)
                || instruction->operation == PL_X86_OPERATION_LOOP
                || instruction->operation
                   == PL_X86_OPERATION_COUNT_ZERO_BRANCH)) {
    } else {
        return 0;
    }
    if ((field_bytes != 1u && field_bytes != 4u)
            || field > bytes || field_bytes > bytes - field)
        return 0;
    /* A source rel8 is valid only for the linked layout.  Independent block
     * ownership can insert other admitted entries between two nearby source
     * coordinates, so retaining that width would make emission depend on a
     * lucky placement.  Non-identity cells use a total canonical spelling:
     * JMP/Jcc become their rel32 forms; LOOP/JCXZ keep their exact instruction
     * and branch to one of two adjacent rel32 exits.  Source-identity extents
     * retain their fixed bytes and are laid out by their affine cell rule. */
    if (field_bytes == 1u && relax_short_control) {
        if (!field || field + 1u != bytes) return 0;
        pl_u32 prefix = field - 1u;
        if (instruction->flow == PL_X86_FLOW_JUMP
                && instruction->operation == PL_X86_OPERATION_BRANCH) {
            if (output_at > U32_MAX_VALUE - prefix - 5u)
                return PL_ERROR_X86_SELECT;
            int status = pl_select_append_fixup(
                selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                output_at + prefix + 1u, output_at + prefix + 5u,
                instruction->target);
            if (status) return status;
            selection->output_bytes = output_at + prefix + 5u;
        } else if (instruction->flow == PL_X86_FLOW_CONDITIONAL
                && instruction->operation == PL_X86_OPERATION_BRANCH
                && instruction->condition <= 15u) {
            if (output_at > U32_MAX_VALUE - prefix - 6u)
                return PL_ERROR_X86_SELECT;
            int status = pl_select_append_fixup(
                selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                output_at + prefix + 2u, output_at + prefix + 6u,
                instruction->target);
            if (status) return status;
            selection->output_bytes = output_at + prefix + 6u;
        } else if (instruction->flow == PL_X86_FLOW_CONDITIONAL
                && (instruction->operation == PL_X86_OPERATION_LOOP
                    || instruction->operation
                       == PL_X86_OPERATION_COUNT_ZERO_BRANCH)) {
            if (output_at > U32_MAX_VALUE - bytes - 10u)
                return PL_ERROR_X86_SELECT;
            int status = pl_select_append_fixup(
                selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                output_at + bytes + 1u, output_at + bytes + 5u,
                instruction->fallthrough);
            if (!status)
                status = pl_select_append_fixup(
                    selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, 4u,
                    output_at + bytes + 6u, output_at + bytes + 10u,
                    instruction->target);
            if (status) return status;
            selection->output_bytes = output_at + bytes + 10u;
        } else {
            return 0;
        }
        selection->copied_source = 1u;
        return 1;
    }
    int status = pl_select_append_fixup(
        selection, PL_X86_NATIVE_FIXUP_PC_RELATIVE, field_bytes,
        output_at + field, output_at + bytes, instruction->target);
    if (status) return status;
    selection->output_bytes = output_at + bytes;
    selection->copied_source = 1u;
    return 1;
}

int pl_select_inspect_copied_instruction(
    const pl_x86_instruction *instruction, pl_u32 output_at,
    pl_x86_native_selection *selection)
{
    for (pl_u32 index = 0u; index < instruction->operand_count; ++index) {
        const pl_x86_operand *operand = &instruction->operands[index];
        if (operand->flags & PL_X86_OPERAND_RELATIVE) {
            selection->reason = PL_X86_NATIVE_SELECT_CONTROL;
            return 0;
        }
        if (operand->kind != PL_X86_OPERAND_MEMORY
                || operand->value.memory.base.class_id
                   != PL_X86_REGISTER_IP)
            continue;
        if (instruction->displacement_bytes != 4u
                || instruction->displacement_offset + 4u
                   > instruction->source_bytes) {
            selection->reason = PL_X86_NATIVE_SELECT_POSITION;
            return 0;
        }
        pl_u64 target = instruction->fallthrough
                      + (pl_u64)operand->value.memory.displacement;
        int status = pl_select_append_fixup(
            selection, PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT, 4u,
            output_at + instruction->displacement_offset,
            output_at + instruction->source_bytes, target);
        if (status) return status;
    }
    return 1;
}

int pl_select_measure_source_run(const pl_x86_frontend *frontend,
                               pl_u64 start, pl_u32 instructions,
                               pl_u32 omitted_prefix_bytes,
                               int relax_short_control,
                               pl_x86_native_selection *selection)
{
    pl_u64 rip = start;
    pl_u32 output_at = 0u;
    pl_u64 copied_from = start + omitted_prefix_bytes;
    for (pl_u32 index = 0u; index < instructions; ++index) {
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        int final = index + 1u == instructions;
        if (final && pl_select_source_terminal(&instruction)
                && (instruction.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)) {
            int selected = pl_select_direct_control(
                &instruction, output_at, relax_short_control, selection);
            if (selected < 0) return selected;
            if (!selected) {
                selection->reason = PL_X86_NATIVE_SELECT_CONTROL;
                return 0;
            }
            selection->copied_source |= output_at != 0u;
            ++selection->output_instructions;
            return 1;
        }
        if (rip >= copied_from) {
            int relocatable = pl_select_inspect_copied_instruction(
                &instruction, output_at, selection);
            if (relocatable < 0) return relocatable;
            if (!relocatable) return 0;
            if (output_at > U32_MAX_VALUE - instruction.source_bytes)
                return PL_ERROR_X86_SELECT;
            output_at += instruction.source_bytes;
            selection->copied_source = 1u;
            ++selection->output_instructions;
        }
        rip = instruction.fallthrough;
    }
    selection->output_bytes = output_at;
    return 1;
}

int pl_select_write_source_run(const pl_x86_frontend *frontend,
                            const pl_x86_block *block,
                            const pl_x86_native_selection *selection,
                            pl_u8 *output)
{
    pl_u64 rip = block->start;
    pl_u32 output_at = 0u;
    pl_x86_instruction terminal;
    int status = pl_select_final_instruction(frontend, block, &terminal);
    if (status) return status;
    pl_u64 copied_from = block->start + selection->omitted_prefix_bytes;

    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_x86_instruction instruction;
        status = pl_x86_frontend_decode(frontend, rip, &instruction);
        if (status) return status;
        int final = index + 1u == block->instruction_count;
        int retained = selection->direct_live_frame
                     ? !!(selection->projected_instruction_mask
                           & (1ull << index))
                     : rip >= copied_from;
        if (retained) {
            if (final && pl_select_source_terminal(&instruction)
                    && (instruction.flags
                        & PL_X86_INSTRUCTION_DIRECT_TARGET)) {
                pl_u32 instruction_at = output_at;
                int widened = instruction.immediate_bytes[0] == 1u
                    && selection->output_bytes
                       > output_at + instruction.source_bytes;
                if (widened && instruction.flow == PL_X86_FLOW_JUMP
                        && instruction.operation
                           == PL_X86_OPERATION_BRANCH) {
                    pl_u32 prefix = instruction.immediate_offset[0] - 1u;
                    for (pl_u32 byte = 0u; byte < prefix; ++byte)
                        output[output_at++] = instruction.source[byte];
                    output[output_at++] = 0xe9u;
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                } else if (widened
                        && instruction.flow == PL_X86_FLOW_CONDITIONAL
                        && instruction.operation
                           == PL_X86_OPERATION_BRANCH
                        && instruction.condition <= 15u) {
                    pl_u32 prefix = instruction.immediate_offset[0] - 1u;
                    for (pl_u32 byte = 0u; byte < prefix; ++byte)
                        output[output_at++] = instruction.source[byte];
                    output[output_at++] = 0x0fu;
                    output[output_at++] =
                        (pl_u8)(0x80u + instruction.condition);
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                } else if (widened
                        && instruction.flow == PL_X86_FLOW_CONDITIONAL
                        && (instruction.operation == PL_X86_OPERATION_LOOP
                            || instruction.operation
                               == PL_X86_OPERATION_COUNT_ZERO_BRANCH)) {
                    for (pl_u32 byte = 0u;
                            byte < instruction.source_bytes; ++byte)
                        output[output_at++] = instruction.source[byte];
                    output[instruction_at + instruction.immediate_offset[0]] =
                        5u;
                    output[output_at++] = 0xe9u;
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                    output[output_at++] = 0xe9u;
                    for (pl_u32 byte = 0u; byte < 4u; ++byte)
                        output[output_at++] = 0u;
                } else {
                    for (pl_u32 byte = 0u;
                            byte < instruction.source_bytes; ++byte)
                        output[output_at++] = instruction.source[byte];
                }
                for (pl_u32 fixup = 0u;
                        fixup < selection->fixup_count; ++fixup) {
                    const pl_x86_native_fixup *field =
                        &selection->fixups[fixup];
                    if (field->kind != PL_X86_NATIVE_FIXUP_PC_RELATIVE
                            || field->at < instruction_at
                            || field->at + field->bytes > output_at)
                        continue;
                    for (pl_u32 byte = 0u; byte < field->bytes; ++byte)
                        output[field->at + byte] = 0u;
                }
            } else {
                for (pl_u32 byte = 0u; byte < instruction.source_bytes;
                        ++byte)
                    output[output_at++] = instruction.source[byte];
            }
        }
        rip = instruction.fallthrough;
    }
    return output_at == selection->output_bytes
         ? 0 : PL_ERROR_X86_SELECT;
}

int pl_x86_select_bind_fixup(pl_u8 *output, pl_u32 output_bytes,
                            const pl_x86_native_selection *selection,
                            pl_u32 fixup_index, pl_u64 output_address,
                            pl_u64 target_address)
{
    if (!output || !selection
            || selection->fixup_count > PL_X86_NATIVE_MAX_FIXUPS
            || fixup_index >= selection->fixup_count)
        return PL_ERROR_X86_SELECT;
    const pl_x86_native_fixup *fixup = &selection->fixups[fixup_index];
    if ((fixup->bytes != 1u && fixup->bytes != 4u
                && fixup->bytes != 8u)
            || fixup->at > output_bytes
            || output_bytes - fixup->at < fixup->bytes
            || fixup->next_ip_at > output_bytes)
        return PL_ERROR_X86_SELECT;
    if (fixup->kind == PL_X86_NATIVE_FIXUP_ABSOLUTE) {
        if (fixup->bytes != 8u) return PL_ERROR_X86_SELECT;
        for (pl_u32 byte = 0u; byte < 8u; ++byte)
            output[fixup->at + byte] =
                (pl_u8)(target_address >> (byte * 8u));
        return 0;
    }
    if ((fixup->kind != PL_X86_NATIVE_FIXUP_PC_RELATIVE
            && fixup->kind != PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT)
            || fixup->bytes == 8u
            || output_address > U64_MAX_VALUE - fixup->next_ip_at)
        return PL_ERROR_X86_SELECT;
    pl_u64 next = output_address + fixup->next_ip_at;
    pl_i64 displacement;
    if (target_address >= next) {
        pl_u64 delta = target_address - next;
        pl_u64 maximum = fixup->bytes == 1u ? 0x7fu : I32_MAX_VALUE;
        if (delta > maximum) return PL_ERROR_X86_SELECT;
        displacement = (pl_i64)delta;
    } else {
        pl_u64 delta = next - target_address;
        pl_u64 maximum = fixup->bytes == 1u
                       ? 0x80u : (pl_u64)I32_MAX_VALUE + 1u;
        if (delta > maximum)
            return PL_ERROR_X86_SELECT;
        displacement = -(pl_i64)delta;
    }
    pl_u32 encoded = (pl_u32)(pl_i32)displacement;
    for (pl_u32 byte = 0u; byte < fixup->bytes; ++byte)
        output[fixup->at + byte] = (pl_u8)(encoded >> (byte * 8u));
    return 0;
}
