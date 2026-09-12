#include "internal/table.h"

#include <support/checked.h>

#define R_X86_64_PC32 2u

static int add_signed(pl_u64 base, pl_u64 addend_bits,
                      pl_u64 correction, pl_u64 *out)
{
    pl_i64 addend = (pl_i64)addend_bits;
    pl_u64 value;
    if (addend >= 0) {
        if (!pl_checked_add_u64(base, (pl_u64)addend, &value)) return 0;
    } else {
        pl_u64 magnitude = 0u - (pl_u64)addend;
        if (base < magnitude) return 0;
        value = base - magnitude;
    }
    return pl_checked_add_u64(value, correction, out);
}

static int same_register(pl_x86_register left, pl_x86_register right)
{
    return left.class_id == right.class_id && left.index == right.index;
}

static int callee_saved_base(pl_x86_register value)
{
    if (value.class_id != PL_X86_REGISTER_GPR || value.bits != 64u)
        return 0;
    return value.index == 3u || value.index == 5u
        || (value.index >= 12u && value.index <= 15u);
}

static int same_operand(const pl_x86_operand *left,
                        const pl_x86_operand *right)
{
    if (left->kind != right->kind || left->bits != right->bits
            || left->flags != right->flags)
        return 0;
    if (left->kind == PL_X86_OPERAND_REGISTER)
        return same_register(left->value.reg, right->value.reg)
            && left->value.reg.bits == right->value.reg.bits
            && left->value.reg.flags == right->value.reg.flags;
    if (left->kind == PL_X86_OPERAND_MEMORY)
        return same_register(
                    left->value.memory.segment,
                    right->value.memory.segment)
            && same_register(left->value.memory.base,
                             right->value.memory.base)
            && same_register(left->value.memory.index,
                             right->value.memory.index)
            && left->value.memory.displacement
               == right->value.memory.displacement
            && left->value.memory.scale == right->value.memory.scale
            && left->value.memory.has_displacement
               == right->value.memory.has_displacement;
    if (left->kind == PL_X86_OPERAND_IMMEDIATE)
        return left->value.immediate == right->value.immediate;
    if (left->kind == PL_X86_OPERAND_POINTER)
        return left->value.pointer.segment == right->value.pointer.segment
            && left->value.pointer.offset == right->value.pointer.offset;
    return 1;
}

static int same_instruction_meaning(const pl_x86_instruction *left,
                                    const pl_x86_instruction *right)
{
    if (left->operation != right->operation
            || left->flow != right->flow
            || left->family != right->family
            || left->condition != right->condition
            || left->machine_operation != right->machine_operation
            || left->machine_argument != right->machine_argument
            || left->operand_width != right->operand_width
            || left->address_width != right->address_width
            || left->visible_operand_count != right->visible_operand_count)
        return 0;
    for (pl_u32 index = 0u; index < left->visible_operand_count; ++index)
        if (!same_operand(&left->operands[index], &right->operands[index]))
            return 0;
    return 1;
}

static int prefix_byte(pl_u8 byte)
{
    return (byte >= 0x40u && byte <= 0x4fu)
        || byte == 0xf0u || byte == 0xf2u || byte == 0xf3u
        || byte == 0x2eu || byte == 0x36u || byte == 0x3eu
        || byte == 0x26u || byte == 0x64u || byte == 0x65u
        || byte == 0x66u || byte == 0x67u;
}

static int prefix_sequence(const pl_u8 *bytes, pl_u64 count)
{
    pl_u64 at = 0u;
    while (at < count && prefix_byte(bytes[at])) ++at;
    if (at == count) return 1;
    pl_u64 remaining = count - at;
    return (remaining == 4u && bytes[at] == 0x62u)
        || (remaining == 3u
            && (bytes[at] == 0xc4u || bytes[at] == 0x8fu))
        || (remaining == 2u && bytes[at] == 0xc5u);
}

static int prefix_extension(const pl_x86_instruction *candidate,
                            const pl_x86_instruction *selected)
{
    if (candidate->rip >= selected->rip) return 0;
    pl_u64 bytes = selected->rip - candidate->rip;
    if (bytes > candidate->source_bytes) return 0;
    /* A VEX/EVEX/XOP prefix changes the decoded operation and an instruction
     * may carry an immediate after the relocated displacement, so neither
     * equal meaning nor equal fallthrough identifies its full boundary. */
    if ((bytes == 4u && candidate->source[0] == 0x62u)
            || (bytes == 3u
                && (candidate->source[0] == 0xc4u
                    || candidate->source[0] == 0x8fu))
            || (bytes == 2u && candidate->source[0] == 0xc5u))
        return 1;
    if (candidate->fallthrough != selected->fallthrough) return 0;
    return prefix_sequence(candidate->source, bytes);
}

static int data_symbol(const pl_elf_image *elf,
                       const pl_elf_symbol *symbol,
                       pl_elf_section *section)
{
    if (!symbol->section_index || symbol->section_index >= elf->section_count)
        return 0;
    if (pl_elf_section_read(elf, symbol->section_index, section)) return -1;
    return (section->flags & PL_ELF_SECTION_ALLOC)
        && !pl_elf_section_is_executable(section)
        && symbol->value >= section->address
        && symbol->value - section->address < section->memory_bytes;
}

static int code_symbol(const pl_elf_image *elf,
                       const pl_elf_symbol *symbol,
                       pl_elf_section *section)
{
    if (!symbol->section_index || symbol->section_index >= elf->section_count)
        return 0;
    if (pl_elf_section_read(elf, symbol->section_index, section)) return -1;
    return pl_elf_section_is_executable(section)
        && symbol->value >= section->address
        && symbol->value - section->address < section->memory_bytes;
}

static int relocated_instruction(const pl_x86_frontend *frontend,
                                 pl_u64 field,
                                 pl_u32 field_kind,
                                 pl_x86_instruction *instruction)
{
    int found = 0;
    for (pl_u32 back = 0u; back < PL_X86_MAX_INSTRUCTION_BYTES; ++back) {
        if (field < back) break;
        pl_x86_instruction decoded;
        if (pl_x86_frontend_decode(frontend, field - back, &decoded))
            continue;
        int matches = 0;
        if (field_kind == PL_X86_RELOCATION_DISPLACEMENT
                && decoded.displacement_bytes
                && decoded.rip <= 0xffffffffffffffffull
                                  - decoded.displacement_offset
                && decoded.rip + decoded.displacement_offset == field) {
            matches = 1;
        }
        for (pl_u32 immediate = 0u;
                (field_kind == PL_X86_RELOCATION_IMMEDIATE
                 || field_kind == PL_X86_RELOCATION_DIRECT_CONTROL)
                    && immediate < 2u; ++immediate)
            if (decoded.immediate_bytes[immediate]
                    && decoded.rip <= 0xffffffffffffffffull
                                      - decoded.immediate_offset[immediate]
                    && decoded.rip + decoded.immediate_offset[immediate]
                       == field
                    && (field_kind != PL_X86_RELOCATION_DIRECT_CONTROL
                        || ((decoded.flow == PL_X86_FLOW_CALL
                             || decoded.flow == PL_X86_FLOW_JUMP
                             || decoded.flow == PL_X86_FLOW_CONDITIONAL)
                            && (decoded.flags
                                & PL_X86_INSTRUCTION_DIRECT_TARGET)))) {
                matches = 1;
            }
        if (!matches) continue;
        if (!found) {
            *instruction = decoded;
            found = 1;
            continue;
        }
        if (!prefix_extension(&decoded, instruction)) break;
        if (same_instruction_meaning(&decoded, instruction)) break;
        *instruction = decoded;
    }
    return found;
}

int pl_x86_relocation_instruction(
    const pl_x86_image *image, pl_u64 field, pl_u32 field_kind,
    pl_x86_instruction *instruction)
{
    pl_x86_frontend frontend;
    return image && instruction
        && (field_kind == PL_X86_RELOCATION_DISPLACEMENT
            || field_kind == PL_X86_RELOCATION_IMMEDIATE
            || field_kind == PL_X86_RELOCATION_DIRECT_CONTROL)
        && !pl_x86_frontend_open(image, &frontend)
        && relocated_instruction(
            &frontend, field, field_kind, instruction);
}

static int compare_reaches_branch(const pl_x86_frontend *frontend,
                                  const pl_x86_instruction *compare,
                                  const pl_x86_instruction *branch)
{
    if (compare->fallthrough > branch->rip) return 0;
    const pl_x86_operand *bound = &compare->operands[0];
    for (pl_u64 at = compare->fallthrough; at < branch->rip;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at
                || instruction.fallthrough > branch->rip
                || instruction.flow != PL_X86_FLOW_NEXT)
            return 0;
        if (bound->kind == PL_X86_OPERAND_MEMORY
                && (instruction.flags & PL_X86_INSTRUCTION_WRITES_MEMORY))
            return 0;
        for (pl_u32 operand = 0u;
                operand < instruction.operand_count; ++operand) {
            const pl_x86_operand *written = &instruction.operands[operand];
            if (written->kind != PL_X86_OPERAND_REGISTER
                    || !(written->flags
                         & (PL_X86_OPERAND_WRITE
                            | PL_X86_OPERAND_CONDITIONAL_WRITE)))
                continue;
            /* The branch consumes the comparison flags, while its finite
             * coordinate must still denote the same register value. */
            if (written->value.reg.class_id == PL_X86_REGISTER_FLAGS)
                return 0;
            if (bound->kind == PL_X86_OPERAND_REGISTER
                    && same_register(
                        written->value.reg, bound->value.reg))
                return 0;
        }
        at = instruction.fallthrough;
    }
    return 1;
}

static int writes_gpr(const pl_x86_instruction *instruction,
                       pl_x86_register reg)
{
    for (pl_u32 operand = 0u;
            operand < instruction->operand_count; ++operand)
        if (instruction->operands[operand].kind
                == PL_X86_OPERAND_REGISTER
                && (instruction->operands[operand].flags
                    & (PL_X86_OPERAND_WRITE
                       | PL_X86_OPERAND_CONDITIONAL_WRITE))
                && same_register(
                    instruction->operands[operand].value.reg, reg))
            return 1;
    return 0;
}

static int same_memory_address(const pl_x86_operand *left,
                               const pl_x86_operand *right)
{
    return left->kind == PL_X86_OPERAND_MEMORY
        && right->kind == PL_X86_OPERAND_MEMORY
        && same_register(left->value.memory.segment,
                         right->value.memory.segment)
        && same_register(left->value.memory.base,
                         right->value.memory.base)
        && same_register(left->value.memory.index,
                         right->value.memory.index)
        && left->value.memory.displacement
           == right->value.memory.displacement
        && left->value.memory.scale == right->value.memory.scale
        && left->value.memory.has_displacement
           == right->value.memory.has_displacement;
}

static int rip_memory_range(const pl_x86_instruction *instruction,
                            const pl_x86_operand *operand,
                            pl_u64 *address, pl_u64 *bytes)
{
    if (!instruction || !operand || !address || !bytes
            || operand->kind != PL_X86_OPERAND_MEMORY
            || !operand->bits || operand->bits % 8u
            || (operand->value.memory.segment.class_id
                   != PL_X86_REGISTER_NONE
                && (operand->value.memory.segment.class_id
                       != PL_X86_REGISTER_SEGMENT
                    || operand->value.memory.segment.index >= 4u))
            || operand->value.memory.base.class_id != PL_X86_REGISTER_IP
            || operand->value.memory.index.class_id
               != PL_X86_REGISTER_NONE
            || !operand->value.memory.has_displacement)
        return 0;
    if (!add_signed(
            instruction->fallthrough,
            (pl_u64)operand->value.memory.displacement, 0u, address))
        return 0;
    *bytes = operand->bits / 8u;
    return *bytes != 0u;
}

static int same_memory_value_at(
    const pl_x86_instruction *left_instruction,
    const pl_x86_operand *left,
    const pl_x86_instruction *right_instruction,
    const pl_x86_operand *right)
{
    if (!left || !right || left->bits != right->bits) return 0;
    pl_u64 left_address = 0u;
    pl_u64 left_bytes = 0u;
    pl_u64 right_address = 0u;
    pl_u64 right_bytes = 0u;
    if (rip_memory_range(
            left_instruction, left, &left_address, &left_bytes)
            && rip_memory_range(
                right_instruction, right, &right_address, &right_bytes))
        return left_address == right_address && left_bytes == right_bytes;
    return same_memory_address(left, right);
}

static int rip_memory_write_is_disjoint(
    const pl_x86_instruction *bound_instruction,
    const pl_x86_operand *bound,
    const pl_x86_instruction *instruction)
{
    pl_u64 bound_address = 0u;
    pl_u64 bound_bytes = 0u;
    if (!rip_memory_range(
            bound_instruction, bound, &bound_address, &bound_bytes))
        return 0;
    if (!(instruction->flags & PL_X86_INSTRUCTION_WRITES_MEMORY)) return 1;
    int found = 0;
    for (pl_u32 operand = 0u;
            operand < instruction->operand_count; ++operand) {
        const pl_x86_operand *written = &instruction->operands[operand];
        if (written->kind != PL_X86_OPERAND_MEMORY
                || !(written->flags
                     & (PL_X86_OPERAND_WRITE
                        | PL_X86_OPERAND_CONDITIONAL_WRITE)))
            continue;
        found = 1;
        pl_u64 written_address = 0u;
        pl_u64 written_bytes = 0u;
        if (!rip_memory_range(
                instruction, written, &written_address, &written_bytes))
            return 0;
        if (written_address <= bound_address) {
            if (bound_address - written_address < written_bytes) return 0;
        } else if (written_address - bound_address < bound_bytes) {
            return 0;
        }
    }
    return found;
}

static int memory_ranges_disjoint(const pl_x86_operand *left,
                                  const pl_x86_operand *right)
{
    if (left->kind != PL_X86_OPERAND_MEMORY
            || right->kind != PL_X86_OPERAND_MEMORY
            || !left->bits || !right->bits
            || left->bits % 8u || right->bits % 8u
            || !same_register(left->value.memory.segment,
                              right->value.memory.segment)
            || !same_register(left->value.memory.base,
                              right->value.memory.base)
            || !same_register(left->value.memory.index,
                              right->value.memory.index)
            || left->value.memory.scale != right->value.memory.scale
            || !left->value.memory.has_displacement
            || !right->value.memory.has_displacement)
        return 0;
    pl_i64 left_at = left->value.memory.displacement;
    pl_i64 right_at = right->value.memory.displacement;
    pl_u64 left_bytes = left->bits / 8u;
    pl_u64 right_bytes = right->bits / 8u;
    if (left_at <= right_at)
        return (pl_u64)(right_at - left_at) >= left_bytes;
    return (pl_u64)(left_at - right_at) >= right_bytes;
}

static int writes_address_register(const pl_x86_instruction *instruction,
                                   const pl_x86_operand *memory)
{
    if (!instruction || !memory || memory->kind != PL_X86_OPERAND_MEMORY)
        return 1;
    pl_x86_register base = memory->value.memory.base;
    pl_x86_register index = memory->value.memory.index;
    return (base.class_id == PL_X86_REGISTER_GPR
            && writes_gpr(instruction, base))
        || (index.class_id == PL_X86_REGISTER_GPR
            && writes_gpr(instruction, index));
}

static int memory_write_is_disjoint(
    const pl_x86_instruction *instruction,
    const pl_x86_operand *left, const pl_x86_operand *right)
{
    if (!(instruction->flags & PL_X86_INSTRUCTION_WRITES_MEMORY))
        return 1;
    int found = 0;
    for (pl_u32 operand = 0u;
            operand < instruction->operand_count; ++operand) {
        const pl_x86_operand *written = &instruction->operands[operand];
        if (written->kind != PL_X86_OPERAND_MEMORY
                || !(written->flags
                     & (PL_X86_OPERAND_WRITE
                        | PL_X86_OPERAND_CONDITIONAL_WRITE)))
            continue;
        found = 1;
        if (!memory_ranges_disjoint(written, left)
                || !memory_ranges_disjoint(written, right))
            return 0;
    }
    return found;
}

/* Prove a compiler spill/reload by substituting the bounded byte/word
 * through its local register generation.  This is a finite SSA fact, not a
 * stack-slot heuristic: the bounded store, zero extension, exact second
 * store and absence of an aliasing write are all required. */
static int spilled_bound_alias(const pl_x86_frontend *frontend,
                               pl_u64 function_start,
                               const pl_x86_instruction *compare,
                               const pl_x86_operand *bound,
                               const pl_x86_operand *candidate)
{
    enum { HISTORY = 32u };
    pl_x86_instruction history[HISTORY];
    pl_u32 count = 0u;
    if (!frontend || !compare || !bound || !candidate
            || bound->kind != PL_X86_OPERAND_MEMORY
            || candidate->kind != PL_X86_OPERAND_MEMORY
            || !bound->bits || bound->bits > 64u
            || function_start >= compare->rip)
        return 0;
    for (pl_u64 at = function_start; at < compare->rip;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at
                || instruction.fallthrough > compare->rip)
            return 0;
        if (count == HISTORY) {
            for (pl_u32 index = 1u; index < HISTORY; ++index)
                history[index - 1u] = history[index];
            --count;
        }
        history[count++] = instruction;
        at = instruction.fallthrough;
    }

    pl_u32 seed = count;
    for (pl_u32 reverse = count; reverse > 0u; --reverse) {
        const pl_x86_instruction *instruction = &history[reverse - 1u];
        if (instruction->operation != PL_X86_OPERATION_MOVE
                || instruction->visible_operand_count < 2u
                || instruction->operands[0].kind
                   != PL_X86_OPERAND_MEMORY
                || instruction->operands[1].kind
                   != PL_X86_OPERAND_REGISTER
                || instruction->operands[0].bits != bound->bits
                || !same_memory_address(&instruction->operands[0], bound))
            continue;
        seed = reverse - 1u;
        break;
    }
    if (seed == count) return 0;
    const pl_x86_operand *seed_source = &history[seed].operands[1];
    if (seed_source->value.reg.class_id != PL_X86_REGISTER_GPR
            || seed_source->value.reg.index >= 32u
            || seed_source->bits != bound->bits)
        return 0;
    pl_u32 low = 1u << seed_source->value.reg.index;
    pl_u32 exact = 0u;
    int candidate_defined = 0;

    for (pl_u32 at = seed + 1u; at < count; ++at) {
        const pl_x86_instruction *instruction = &history[at];
        if (writes_address_register(instruction, bound)
                || writes_address_register(instruction, candidate))
            return 0;

        int candidate_store = instruction->operation
                == PL_X86_OPERATION_MOVE
            && instruction->visible_operand_count >= 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_MEMORY
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[0].bits == candidate->bits
            && same_memory_address(&instruction->operands[0], candidate);
        if (candidate_store) {
            pl_x86_register source = instruction->operands[1].value.reg;
            candidate_defined = source.class_id == PL_X86_REGISTER_GPR
                && source.index < 32u
                && (exact & (1u << source.index));
            if (!candidate_defined) return 0;
        } else if (!memory_write_is_disjoint(
                       instruction, bound, candidate)) {
            return 0;
        }

        pl_u32 next_low = 0u;
        pl_u32 next_exact = 0u;
        pl_x86_register destination = { 0u, 0u, 0u, 0u };
        int copied = (instruction->operation == PL_X86_OPERATION_MOVE
                    || instruction->operation
                       == PL_X86_OPERATION_MOVE_ZERO_EXTEND)
            && instruction->visible_operand_count >= 2u
            && instruction->operands[0].kind
               == PL_X86_OPERAND_REGISTER
            && instruction->operands[1].kind
               == PL_X86_OPERAND_REGISTER;
        if (copied) {
            destination = instruction->operands[0].value.reg;
            pl_x86_register source = instruction->operands[1].value.reg;
            if (destination.class_id == PL_X86_REGISTER_GPR
                    && destination.index < 32u
                    && source.class_id == PL_X86_REGISTER_GPR
                    && source.index < 32u) {
                pl_u32 source_bit = 1u << source.index;
                if ((low & source_bit)
                        && instruction->operands[1].bits >= bound->bits)
                    next_low = 1u << destination.index;
                if ((exact & source_bit)
                        && instruction->operands[0].bits >= bound->bits)
                    next_exact = 1u << destination.index;
                if (instruction->operation
                        == PL_X86_OPERATION_MOVE_ZERO_EXTEND
                        && (low & source_bit)
                        && instruction->operands[1].bits == bound->bits)
                    next_exact = 1u << destination.index;
            }
        }
        for (pl_u32 operand = 0u;
                operand < instruction->operand_count; ++operand) {
            const pl_x86_operand *written = &instruction->operands[operand];
            if (written->kind != PL_X86_OPERAND_REGISTER
                    || !(written->flags
                         & (PL_X86_OPERAND_WRITE
                            | PL_X86_OPERAND_CONDITIONAL_WRITE))
                    || written->value.reg.class_id
                       != PL_X86_REGISTER_GPR
                    || written->value.reg.index >= 32u)
                continue;
            pl_u32 bit = 1u << written->value.reg.index;
            low &= ~bit;
            exact &= ~bit;
        }
        low |= next_low;
        exact |= next_exact;
    }
    return candidate_defined;
}

static int projected_upper_bound(const pl_x86_frontend *frontend,
                                 pl_u64 function_start,
                                 const pl_x86_instruction *compare,
                                 pl_x86_register target,
                                 pl_x86_register bound,
                                 pl_u64 maximum,
                                 pl_u64 *projected)
{
    enum { HISTORY = 8u };
    pl_x86_instruction history[HISTORY];
    pl_u32 count = 0u;
    if (target.class_id != PL_X86_REGISTER_GPR
            || bound.class_id != PL_X86_REGISTER_GPR
            || function_start >= compare->rip)
        return 0;
    for (pl_u64 at = function_start; at < compare->rip;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at
                || instruction.fallthrough > compare->rip)
            return 0;
        if (count == HISTORY) {
            for (pl_u32 index = 1u; index < HISTORY; ++index)
                history[index - 1u] = history[index];
            --count;
        }
        history[count++] = instruction;
        at = instruction.fallthrough;
    }
    pl_x86_register tracked = target;
    pl_u32 shift = 0u;
    for (pl_u32 reverse = count; reverse > 0u; --reverse) {
        const pl_x86_instruction *instruction = &history[reverse - 1u];
        if (!writes_gpr(instruction, tracked)) continue;
        if (instruction->operation == PL_X86_OPERATION_SHIFT
                && (instruction->condition == 5u
                    || instruction->condition == 7u)
                && instruction->visible_operand_count >= 2u
                && instruction->operands[0].kind
                   == PL_X86_OPERAND_REGISTER
                && instruction->operands[1].kind
                   == PL_X86_OPERAND_IMMEDIATE
                && same_register(
                    instruction->operands[0].value.reg, tracked)) {
            if (instruction->condition == 7u) {
                pl_u32 bits = instruction->operands[0].bits;
                /* Arithmetic and logical right shift are the same function
                 * on the proved non-negative half of the lane. */
                if (!bits || bits > 64u
                        || maximum >= (1ull << (bits - 1u)))
                    return 0;
            }
            pl_u64 amount = instruction->operands[1].value.immediate;
            if (amount >= 64u || shift > 63u - (pl_u32)amount)
                return 0;
            shift += (pl_u32)amount;
            continue;
        }
        if ((instruction->operation == PL_X86_OPERATION_MOVE
                    || instruction->operation
                       == PL_X86_OPERATION_MOVE_ZERO_EXTEND)
                && instruction->visible_operand_count >= 2u
                && instruction->operands[0].kind
                   == PL_X86_OPERAND_REGISTER
                && instruction->operands[1].kind
                   == PL_X86_OPERAND_REGISTER
                && same_register(
                    instruction->operands[0].value.reg, tracked)) {
            pl_x86_register source = instruction->operands[1].value.reg;
            if (same_register(source, bound)) {
                /* The copied source must still be the value constrained by
                 * CMP; otherwise the backward expression names an older
                 * generation of the register. */
                for (pl_u32 later = reverse; later < count; ++later)
                    if (writes_gpr(&history[later], bound)) return 0;
                *projected = maximum >> shift;
                return 1;
            }
            tracked = source;
            continue;
        }
        return 0;
    }
    return 0;
}

static int bound_path_rows(const pl_x86_frontend *frontend,
                           pl_u64 function_start,
                           const pl_x86_instruction *branch,
                           const pl_x86_instruction *compare,
                           pl_u64 dispatch_start,
                           pl_x86_register index_register,
                           const pl_x86_operand *bound,
                           pl_u64 maximum, pl_u32 *rows)
{
    pl_u64 at = branch->fallthrough;
    if (branch->condition == 6u) {
        if (!(branch->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
                || branch->target < branch->fallthrough
                || branch->target > dispatch_start)
            return 0;
        at = branch->target;
    } else if (branch->condition != 7u) {
        return 0;
    }
    int gap_ok = 1;
    pl_u32 aliases = 0u;
    pl_u64 bound_address = 0u;
    pl_u64 bound_bytes = 0u;
    int bound_is_rip = rip_memory_range(
        compare, bound, &bound_address, &bound_bytes);
    (void)bound_address;
    (void)bound_bytes;
    if (bound->kind == PL_X86_OPERAND_REGISTER
            && bound->value.reg.class_id == PL_X86_REGISTER_GPR
            && bound->value.reg.index < 32u)
        aliases |= 1u << bound->value.reg.index;
    for (pl_u32 move_bytes = 1u;
            move_bytes <= PL_X86_MAX_INSTRUCTION_BYTES;
            ++move_bytes) {
        if (compare->rip < move_bytes) break;
        pl_x86_instruction move;
        if (pl_x86_frontend_decode(
                frontend, compare->rip - move_bytes, &move)
                || move.fallthrough != compare->rip
                || (move.operation != PL_X86_OPERATION_MOVE
                    && move.operation
                       != PL_X86_OPERATION_MOVE_ZERO_EXTEND)
                || move.visible_operand_count < 2u
                || move.operands[0].kind
                   != PL_X86_OPERAND_REGISTER)
            continue;
        const pl_x86_operand *source = &move.operands[1];
        int carries_bound =
            (bound->kind == PL_X86_OPERAND_MEMORY
             && source->kind == PL_X86_OPERAND_MEMORY
             && same_memory_value_at(
                 compare, bound, &move, source))
            || (bound->kind == PL_X86_OPERAND_REGISTER
                && source->kind == PL_X86_OPERAND_REGISTER
                && same_register(
                    bound->value.reg, source->value.reg));
        pl_x86_register destination = move.operands[0].value.reg;
        if (carries_bound
                && destination.class_id == PL_X86_REGISTER_GPR
                && destination.index < 32u)
            aliases |= 1u << destination.index;
    }
    while (at < dispatch_start) {
        pl_x86_instruction move;
        if (pl_x86_frontend_decode(frontend, at, &move)
                || move.fallthrough <= at
                || move.fallthrough > dispatch_start
                || (move.flow != PL_X86_FLOW_NEXT
                    && move.flow != PL_X86_FLOW_CONDITIONAL)) {
            gap_ok = 0;
            break;
        }
        /* A memory comparison constrains a value, not an address spelling.
         * Until that value has been loaded into a tracked register, a call or
         * any write not proved disjoint from the exact RIP-relative cell is
         * an alias barrier. */
        if (bound_is_rip && !aliases
                && !rip_memory_write_is_disjoint(
                    compare, bound, &move)) {
            gap_ok = 0;
            break;
        }
        if (move.flow == PL_X86_FLOW_CONDITIONAL
                && !(move.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)) {
            gap_ok = 0;
            break;
        }
        pl_x86_register carried = { 0u, 0u, 0u, 0u };
        int carries_bound = 0;
        if ((move.operation == PL_X86_OPERATION_MOVE
                    || move.operation
                       == PL_X86_OPERATION_MOVE_ZERO_EXTEND
                    || move.operation
                       == PL_X86_OPERATION_LOAD_ADDRESS)
                && move.visible_operand_count >= 2u
                && move.operands[0].kind
                   == PL_X86_OPERAND_REGISTER) {
            carried = move.operands[0].value.reg;
            const pl_x86_operand *source = &move.operands[1];
            carries_bound =
                (bound->kind == PL_X86_OPERAND_MEMORY
                 && source->kind == PL_X86_OPERAND_MEMORY
                 && (same_memory_value_at(
                         compare, bound, &move, source)
                     || spilled_bound_alias(
                         frontend, function_start, compare,
                         bound, source)))
                || (source->kind == PL_X86_OPERAND_REGISTER
                    && source->value.reg.class_id
                       == PL_X86_REGISTER_GPR
                    && source->value.reg.index < 32u
                    && (aliases & (1u << source->value.reg.index)));
        }
        for (pl_u32 operand = 0u;
                operand < move.operand_count; ++operand) {
            if (move.operands[operand].kind != PL_X86_OPERAND_REGISTER
                    || !(move.operands[operand].flags
                         & (PL_X86_OPERAND_WRITE
                            | PL_X86_OPERAND_CONDITIONAL_WRITE)))
                continue;
            pl_x86_register destination =
                move.operands[operand].value.reg;
            if (destination.class_id != PL_X86_REGISTER_GPR
                    || destination.index >= 32u)
                continue;
            aliases &= ~(1u << destination.index);
            if (carries_bound && same_register(destination, carried))
                aliases |= 1u << destination.index;
        }
        at = move.fallthrough;
    }
    int same_bound = index_register.class_id == PL_X86_REGISTER_GPR
        && index_register.index < 32u
        && (aliases & (1u << index_register.index));
    if (!gap_ok || at != dispatch_start || !same_bound
            || maximum >= 0xffffffffu)
        return 0;
    *rows = (pl_u32)maximum + 1u;
    return *rows != 0u;
}

static void bounded_branch_rows(const pl_x86_frontend *frontend,
                                pl_u64 function_start,
                                const pl_x86_instruction *branch,
                                pl_u64 dispatch_start,
                                pl_x86_register index_register,
                                int *found, pl_u32 *result)
{
    for (pl_u32 compare_bytes = 1u;
            compare_bytes <= 3u * PL_X86_MAX_INSTRUCTION_BYTES;
            ++compare_bytes) {
        if (branch->rip < compare_bytes) break;
        pl_x86_instruction compare;
        if (pl_x86_frontend_decode(
                frontend, branch->rip - compare_bytes, &compare)
                || compare.fallthrough > branch->rip
                || compare.operation != PL_X86_OPERATION_COMPARE
                || compare.visible_operand_count < 2u
                || compare.operands[1].kind
                   != PL_X86_OPERAND_IMMEDIATE)
            continue;
        if (!compare_reaches_branch(frontend, &compare, branch)) continue;
        const pl_x86_operand *bound = &compare.operands[0];
        pl_u64 maximum = compare.operands[1].value.immediate;
        if (!bound->bits || bound->bits > 64u) continue;
        if (bound->bits < 64u)
            maximum &= (1ull << bound->bits) - 1u;
        if (maximum >= 0xffffffffu) continue;
        pl_u32 candidate = 0u;
        pl_u64 projected = 0u;
        pl_x86_operand projected_bound = *bound;
        int have_projection = bound->kind == PL_X86_OPERAND_REGISTER
            && projected_upper_bound(
                frontend, function_start, &compare, index_register,
                bound->value.reg, maximum, &projected);
        if (have_projection) {
            projected_bound.value.reg = index_register;
            projected_bound.bits = index_register.bits;
            if (bound_path_rows(
                    frontend, function_start, branch, &compare,
                    dispatch_start,
                    index_register, &projected_bound,
                    projected, &candidate)
                    && (!*found || candidate < *result))
                *result = candidate;
        }
        candidate = 0u;
        if (bound_path_rows(
                frontend, function_start, branch, &compare,
                dispatch_start,
                index_register, bound, maximum, &candidate)
                && (!*found || candidate < *result))
            *result = candidate;
        *found = *result != 0u;
    }
}

static int bounded_table_rows(const pl_x86_frontend *frontend,
                              pl_u64 function_start,
                              pl_u64 dispatch_start,
                              pl_x86_register index_register,
                              pl_u32 *rows)
{
    int found = 0;
    pl_u32 result = 0u;
    for (pl_u32 gap_bytes = 0u;
            gap_bytes <= 2u * PL_X86_MAX_INSTRUCTION_BYTES;
            ++gap_bytes) {
        if (dispatch_start < gap_bytes) break;
        pl_u64 branch_end = dispatch_start - gap_bytes;
        for (pl_u32 branch_bytes = 1u;
                branch_bytes <= PL_X86_MAX_INSTRUCTION_BYTES;
                ++branch_bytes) {
            if (branch_end < branch_bytes) break;
            pl_x86_instruction branch;
            if (pl_x86_frontend_decode(
                    frontend, branch_end - branch_bytes, &branch)
                    || branch.fallthrough != branch_end
                    || branch.flow != PL_X86_FLOW_CONDITIONAL)
                continue;
            bounded_branch_rows(
                frontend, function_start, &branch,
                dispatch_start, index_register,
                &found, &result);
        }
    }
    /* A compiler may outline the accepted arm far from its compare.  Walk
     * the function's actual instruction boundaries and recover such direct
     * edges.  This is not a distance heuristic: CMP/JBE proves the finite
     * domain on exactly the edge whose target reaches the consumer. */
    for (pl_u64 at = function_start;
            at < dispatch_start && at <= 0xffffffffffffffffull - 1u;) {
        pl_x86_instruction branch;
        if (pl_x86_frontend_decode(frontend, at, &branch)
                || branch.fallthrough <= at)
            break;
        if (branch.flow == PL_X86_FLOW_CONDITIONAL
                && (branch.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
                && branch.target <= dispatch_start)
            bounded_branch_rows(
                frontend, function_start, &branch,
                dispatch_start, index_register,
                &found, &result);
        at = branch.fallthrough;
    }
    *rows = result;
    return found;
}

static int masked_table_rows(const pl_x86_frontend *frontend,
                             pl_u64 dispatch_start,
                             pl_x86_register index_register,
                             pl_u32 *rows)
{
    for (pl_u32 instruction_bytes = 1u;
            instruction_bytes <= PL_X86_MAX_INSTRUCTION_BYTES;
            ++instruction_bytes) {
        if (dispatch_start < instruction_bytes) break;
        pl_x86_instruction mask;
        if (pl_x86_frontend_decode(
                frontend, dispatch_start - instruction_bytes, &mask)
                || mask.fallthrough != dispatch_start
                || mask.operation != PL_X86_OPERATION_AND
                || mask.visible_operand_count < 2u
                || mask.operands[0].kind != PL_X86_OPERAND_REGISTER
                || mask.operands[1].kind != PL_X86_OPERAND_IMMEDIATE
                || !same_register(
                    mask.operands[0].value.reg, index_register))
            continue;
        pl_u32 bits = mask.operands[0].bits;
        if (!bits || bits > 64u) continue;
        pl_u64 maximum = mask.operands[1].value.immediate;
        if (bits < 64u) maximum &= (1ull << bits) - 1u;
        if (maximum >= 0xffffffffu) continue;
        pl_u32 candidate = (pl_u32)maximum + 1u;
        if (candidate && !(candidate & (candidate - 1u))) {
            *rows = candidate;
            return 1;
        }
    }
    return 0;
}

/* A compiler-generated dispatcher may carry its finite state through a
 * private frame slot and join many remote CFG arms before the table load.
 * Prove that persistent cut backwards from the consumer.  Only reaching
 * definitions of the index and one exact frame slot survive; unrelated
 * register history and loop work are never materialized. */
typedef struct {
    pl_u32 coordinate;
    pl_u8 value;
    pl_u8 bits;
    pl_u16 reserved;
} dispatch_slice_item;

enum {
    DISPATCH_SLICE_SLOT = 16u,
    DISPATCH_SLICE_VALUES = 65u,
};

typedef struct {
    dispatch_slice_item item;
    pl_u32 constant;
    pl_u8 is_constant;
    pl_u8 reserved[3];
} dispatch_relation_value;

typedef struct {
    pl_u32 coordinate;
    dispatch_relation_value left;
    dispatch_relation_value right;
} dispatch_relation_state;

static int frame_slot_operand(const pl_x86_operand *operand)
{
    return operand && operand->kind == PL_X86_OPERAND_MEMORY
        && operand->bits && !(operand->bits & 7u)
        && operand->value.memory.base.class_id == PL_X86_REGISTER_GPR
        && operand->value.memory.base.index == 5u
        && operand->value.memory.index.class_id == PL_X86_REGISTER_NONE
        && operand->value.memory.has_displacement;
}

static int frame_slot_overlap(const pl_x86_operand *left,
                              const pl_x86_operand *right)
{
    if (!frame_slot_operand(left) || !frame_slot_operand(right)) return 0;
    pl_i64 left_at = left->value.memory.displacement;
    pl_i64 right_at = right->value.memory.displacement;
    pl_u64 left_bytes = left->bits / 8u;
    pl_u64 right_bytes = right->bits / 8u;
    if (left_at <= right_at)
        return (pl_u64)(right_at - left_at) < left_bytes;
    return (pl_u64)(left_at - right_at) < right_bytes;
}

static int exact_frame_slot(const pl_x86_operand *left,
                            const pl_x86_operand *right)
{
    return frame_slot_operand(left) && frame_slot_operand(right)
        && left->bits == right->bits
        && left->value.memory.displacement
           == right->value.memory.displacement;
}

static pl_u8 width_code(pl_u32 bits)
{
    return bits == 8u ? 0u
         : bits == 16u ? 1u
         : bits == 32u ? 2u
         : bits == 64u ? 3u : 0xffu;
}

static pl_u32 width_mask_u32(pl_u8 bits)
{
    return bits == 0u ? 0xffu
         : bits == 1u ? 0xffffu : 0xffffffffu;
}

static int immediate_u32(const pl_x86_operand *operand,
                         pl_u8 bits, pl_u32 *out)
{
    if (!operand || !out || operand->kind != PL_X86_OPERAND_IMMEDIATE
            || bits > 3u)
        return 0;
    pl_u64 value = operand->value.immediate;
    if (bits < 3u) value &= width_mask_u32(bits);
    if (value > 0xffffffffu) return 0;
    *out = (pl_u32)value;
    return 1;
}

static int dispatch_index_slot(const pl_x86_frontend *frontend,
                               pl_u64 function_start,
                               pl_u64 dispatch_start,
                               pl_x86_register index_register,
                               pl_x86_operand *slot,
                               pl_u64 *reload)
{
    enum { HISTORY = 16u };
    pl_x86_instruction history[HISTORY];
    pl_u32 count = 0u;
    if (!frontend || !slot || !reload || function_start >= dispatch_start
            || index_register.class_id != PL_X86_REGISTER_GPR)
        return 0;
    for (pl_u64 at = function_start; at < dispatch_start;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at
                || instruction.fallthrough > dispatch_start)
            return 0;
        if (count == HISTORY) {
            for (pl_u32 index = 1u; index < HISTORY; ++index)
                history[index - 1u] = history[index];
            --count;
        }
        history[count++] = instruction;
        at = instruction.fallthrough;
    }
    for (pl_u32 reverse = count; reverse > 0u; --reverse) {
        const pl_x86_instruction *instruction = &history[reverse - 1u];
        if (!writes_gpr(instruction, index_register)) continue;
        if ((instruction->operation != PL_X86_OPERATION_MOVE
                    && instruction->operation
                       != PL_X86_OPERATION_MOVE_ZERO_EXTEND)
                || instruction->visible_operand_count < 2u
                || instruction->operands[0].kind
                   != PL_X86_OPERAND_REGISTER
                || !same_register(
                    instruction->operands[0].value.reg, index_register)
                || instruction->operands[0].bits < 32u
                || !frame_slot_operand(&instruction->operands[1])
                || instruction->operands[1].bits > 32u)
            return 0;
        *slot = instruction->operands[1];
        *reload = instruction->rip;
        return 1;
    }
    return 0;
}

static int call_preserves_gpr(pl_u8 index)
{
    return index == 3u || index == 4u || index == 5u
        || (index >= 12u && index <= 15u);
}

static pl_u32 dispatch_successors(const pl_x86_instruction *instruction,
                                  pl_u64 values[2])
{
    pl_u32 count = 0u;
    if (instruction->flow == PL_X86_FLOW_NEXT
            || instruction->flow == PL_X86_FLOW_CALL
            || instruction->flow == PL_X86_FLOW_CONDITIONAL)
        values[count++] = instruction->fallthrough;
    if ((instruction->flow == PL_X86_FLOW_JUMP
                || instruction->flow == PL_X86_FLOW_CONDITIONAL)
            && (instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET))
        values[count++] = instruction->target;
    return count;
}

static int dispatch_branch_bound(
    const pl_x86_frontend *frontend,
    const pl_x86_instruction *branch,
    pl_x86_operand *bound, pl_u32 *maximum, int *target_arm)
{
    if (!frontend || !branch || !bound || !maximum || !target_arm
            || branch->flow != PL_X86_FLOW_CONDITIONAL
            || !(branch->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            || (branch->condition != 6u && branch->condition != 7u))
        return 0;
    pl_x86_instruction selected = { 0 };
    int found = 0;
    for (pl_u32 compare_bytes = 1u;
            compare_bytes <= 3u * PL_X86_MAX_INSTRUCTION_BYTES;
            ++compare_bytes) {
        if (branch->rip < compare_bytes) break;
        pl_x86_instruction compare;
        if (pl_x86_frontend_decode(
                frontend, branch->rip - compare_bytes, &compare)
                || compare.fallthrough > branch->rip
                || compare.operation != PL_X86_OPERATION_COMPARE
                || compare.visible_operand_count < 2u
                || compare.operands[1].kind
                   != PL_X86_OPERAND_IMMEDIATE
                || !compare_reaches_branch(frontend, &compare, branch))
            continue;
        /* A REX prefix changes AH..DH into SPL..DIL.  Starting one byte
         * inside that instruction is still a valid x86 decode, so retain
         * the longest prefix-complete spelling of the same comparison. */
        if (found && !prefix_extension(&compare, &selected)) continue;
        selected = compare;
        found = 1;
    }
    if (!found || !selected.operands[0].bits
            || selected.operands[0].bits > 64u)
        return 0;
    pl_u64 value = selected.operands[1].value.immediate;
    if (selected.operands[0].bits < 64u)
        value &= (1ull << selected.operands[0].bits) - 1u;
    if (value > 0xffffffffu) return 0;
    *bound = selected.operands[0];
    *maximum = (pl_u32)value;
    *target_arm = branch->condition == 6u;
    return 1;
}

static int slice_bound_matches(const dispatch_slice_item *item,
                               const pl_x86_operand *bound,
                               const pl_x86_operand *slot)
{
    if (item->value == DISPATCH_SLICE_SLOT)
        return exact_frame_slot(bound, slot)
            && width_code(bound->bits) >= item->bits;
    return bound->kind == PL_X86_OPERAND_REGISTER
        && bound->value.reg.class_id == PL_X86_REGISTER_GPR
        && bound->value.reg.index == item->value
        && width_code(bound->bits) >= item->bits;
}

static int slice_enqueue(
    dispatch_slice_item *queue, pl_u32 capacity, pl_u32 *count,
    pl_u64 *visited, pl_u32 coordinate, pl_u8 value, pl_u8 bits)
{
    if (!queue || !count || !visited || value > DISPATCH_SLICE_SLOT
            || bits > 3u)
        return 0;
    pl_u32 state = value == DISPATCH_SLICE_SLOT
        ? 64u : (pl_u32)value * 4u + bits;
    pl_u64 mask = 1ull << (state & 63u);
    pl_u64 *word = &visited[(pl_u64)coordinate * 2u + (state >> 6u)];
    if (*word & mask) return 1;
    if (*count >= capacity) return 0;
    *word |= mask;
    queue[*count] = (dispatch_slice_item){
        coordinate, value, bits, 0u
    };
    ++*count;
    return 1;
}

static int slice_record(pl_u32 value, int *found, pl_u32 *maximum)
{
    if (!found || !maximum) return 0;
    if (!*found || value > *maximum) *maximum = value;
    *found = 1;
    return 1;
}

static int slice_table_target_map(
    const pl_elf_image *elf,
    const pl_x86_table *tables, pl_u32 table_count,
    pl_u64 function_start, pl_u64 function_limit,
    pl_u64 *base_by_coordinate)
{
    if (!base_by_coordinate) return 0;
    pl_u64 extent = function_limit - function_start;
    for (pl_u64 index = 0u; index < extent; ++index)
        base_by_coordinate[index] = 0u;
    if (!table_count) return 1;
    if (!elf || !tables) return 0;
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section relocations;
        if (pl_elf_section_read(elf, section_index, &relocations)) return 0;
        if (relocations.type != PL_ELF_SECTION_RELA) continue;
        if (relocations.entry_bytes != PL_ELF_RELOCATION_BYTES
                || relocations.file_bytes % relocations.entry_bytes)
            return 0;
        pl_elf_section place = { 0 };
        if (relocations.info
                && pl_elf_section_read(elf, relocations.info, &place))
            return 0;
        pl_x86_table_cursor cursor = { 0 };
        pl_u64 count = relocations.file_bytes / relocations.entry_bytes;
        for (pl_u64 index = 0u; index < count; ++index) {
            pl_elf_relocation relocation;
            pl_elf_symbol symbol;
            if (pl_elf_relocation_read(
                    elf, section_index, index, &relocation)
                    || pl_elf_symbol_read(
                        elf, relocation.symbol_table_section,
                        relocation.symbol_index, &symbol))
                return 0;
            int recognized = 0;
            pl_u64 base = 0u;
            pl_u64 actual = 0u;
            if (pl_x86_table_row(
                    elf, &relocation, &symbol, &place,
                    tables, table_count, &cursor,
                    &recognized, &base, &actual))
                return 0;
            if (!recognized || actual < function_start
                    || actual >= function_limit)
                continue;
            pl_u64 *coordinate =
                &base_by_coordinate[actual - function_start];
            /* Two distinct tables may deliberately share a case label.  The
             * compact single-base map refuses that uncommon shape rather
             * than dropping an incoming edge from the proof. */
            if (*coordinate && *coordinate != base)
                *coordinate = 0xffffffffffffffffull;
            else if (!*coordinate)
                *coordinate = base;
        }
    }
    return 1;
}

static int slice_indirect_base_predecessors(
    const pl_x86_table *tables, pl_u32 table_count, pl_u64 base,
    pl_u64 function_start, pl_u64 function_limit,
    const dispatch_slice_item *item,
    dispatch_slice_item *queue, pl_u32 queue_capacity,
    pl_u32 *queued, pl_u64 *visited,
    int *found, pl_u32 *maximum)
{
    pl_u32 first = 0u;
    pl_u32 limit = table_count;
    while (first < limit) {
        pl_u32 middle = first + (limit - first) / 2u;
        if (tables[middle].base < base) first = middle + 1u;
        else limit = middle;
    }
    int matched = 0;
    for (pl_u32 table = first;
            table < table_count && tables[table].base == base;
            ++table) {
        const pl_x86_table *descriptor = &tables[table];
        if (descriptor->consumer < function_start
                || descriptor->consumer >= function_limit)
            continue;
        matched = 1;
        if (item->value != DISPATCH_SLICE_SLOT
                && (descriptor->clobber_mask
                    & (1u << item->value)))
            return 0;
        if (item->value != DISPATCH_SLICE_SLOT
                && item->value == descriptor->index_register
                && descriptor->index_bits >= item->bits) {
            if (!descriptor->rows
                    || !slice_record(
                        descriptor->rows - 1u, found, maximum))
                return 0;
            continue;
        }
        if (!slice_enqueue(
                queue, queue_capacity, queued, visited,
                (pl_u32)(descriptor->consumer - function_start),
                item->value, item->bits))
            return 0;
    }
    return matched;
}

static int slice_indirect_target_predecessors(
    const pl_elf_image *elf,
    const pl_x86_table *tables, pl_u32 table_count, pl_u64 target,
    pl_u64 function_start, pl_u64 function_limit,
    const dispatch_slice_item *item,
    dispatch_slice_item *queue, pl_u32 queue_capacity,
    pl_u32 *queued, pl_u64 *visited,
    int *found, pl_u32 *maximum)
{
    int matched = 0;
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section relocations;
        if (pl_elf_section_read(elf, section_index, &relocations)) return 0;
        if (relocations.type != PL_ELF_SECTION_RELA) continue;
        if (relocations.entry_bytes != PL_ELF_RELOCATION_BYTES
                || relocations.file_bytes % relocations.entry_bytes)
            return 0;
        pl_elf_section place = { 0 };
        if (relocations.info
                && pl_elf_section_read(elf, relocations.info, &place))
            return 0;
        pl_x86_table_cursor cursor = { 0 };
        pl_u64 count = relocations.file_bytes / relocations.entry_bytes;
        for (pl_u64 index = 0u; index < count; ++index) {
            pl_elf_relocation relocation;
            pl_elf_symbol symbol;
            if (pl_elf_relocation_read(
                    elf, section_index, index, &relocation)
                    || pl_elf_symbol_read(
                        elf, relocation.symbol_table_section,
                        relocation.symbol_index, &symbol))
                return 0;
            int recognized = 0;
            pl_u64 base = 0u;
            pl_u64 actual = 0u;
            if (pl_x86_table_row(
                    elf, &relocation, &symbol, &place,
                    tables, table_count, &cursor,
                    &recognized, &base, &actual))
                return 0;
            if (!recognized || actual != target) continue;
            if (!slice_indirect_base_predecessors(
                    tables, table_count, base,
                    function_start, function_limit, item,
                    queue, queue_capacity, queued, visited,
                    found, maximum))
                return 0;
            matched = 1;
        }
    }
    return matched;
}

static int slice_definition(
    const pl_x86_instruction *instruction,
    const dispatch_slice_item *item,
    const pl_x86_operand *slot,
    dispatch_slice_item *source,
    int *bounded, pl_u32 *maximum)
{
    *bounded = 0;
    if (item->value == DISPATCH_SLICE_SLOT) {
        pl_x86_register frame = {
            PL_X86_REGISTER_GPR, 5u, 64u, 0u
        };
        if (writes_gpr(instruction, frame)) return 0;
        if (!(instruction->flags & PL_X86_INSTRUCTION_WRITES_MEMORY))
            return 2;
        for (pl_u32 index = 0u;
                index < instruction->operand_count; ++index) {
            const pl_x86_operand *written = &instruction->operands[index];
            if (written->kind != PL_X86_OPERAND_MEMORY
                    || !(written->flags
                         & (PL_X86_OPERAND_WRITE
                            | PL_X86_OPERAND_CONDITIONAL_WRITE))
                    || !frame_slot_overlap(written, slot))
                continue;
            if (index != 0u
                    || instruction->operation != PL_X86_OPERATION_MOVE
                    || instruction->visible_operand_count < 2u
                    || !exact_frame_slot(written, slot)
                    || (written->flags
                        & PL_X86_OPERAND_CONDITIONAL_WRITE))
                return 0;
            const pl_x86_operand *input = &instruction->operands[1];
            if (input->kind == PL_X86_OPERAND_IMMEDIATE) {
                if (!immediate_u32(input, item->bits, maximum)) return 0;
                *bounded = 1;
                return 1;
            }
            if (input->kind != PL_X86_OPERAND_REGISTER
                    || input->value.reg.class_id
                       != PL_X86_REGISTER_GPR
                    || input->value.reg.index >= 16u)
                return 0;
            pl_u8 input_bits = width_code(input->bits);
            if (input_bits == 0xffu) return 0;
            *source = (dispatch_slice_item){
                0u, input->value.reg.index,
                input_bits < item->bits ? input_bits : item->bits, 0u
            };
            return 1;
        }
        return 2;
    }

    pl_x86_register tracked = {
        PL_X86_REGISTER_GPR, item->value,
        (pl_u16)(8u << item->bits), 0u
    };
    if (instruction->flow == PL_X86_FLOW_CALL
            && !call_preserves_gpr(item->value))
        return 0;
    if (!writes_gpr(instruction, tracked)) return 2;
    if (instruction->visible_operand_count < 2u
            || instruction->operands[0].kind
               != PL_X86_OPERAND_REGISTER
            || !same_register(
                instruction->operands[0].value.reg, tracked)
            || (instruction->operands[0].flags
                & PL_X86_OPERAND_CONDITIONAL_WRITE))
        return 0;
    pl_u8 destination_bits = width_code(instruction->operands[0].bits);
    if (destination_bits == 0xffu
            || (destination_bits < item->bits
                && destination_bits != 2u))
        return 0;
    const pl_x86_operand *input = &instruction->operands[1];
    if (instruction->operation == PL_X86_OPERATION_MOVE
            || instruction->operation
               == PL_X86_OPERATION_MOVE_ZERO_EXTEND) {
        if (input->kind == PL_X86_OPERAND_IMMEDIATE) {
            if (!immediate_u32(input, item->bits, maximum)) return 0;
            *bounded = 1;
            return 1;
        }
        if (input->kind == PL_X86_OPERAND_REGISTER
                && input->value.reg.class_id == PL_X86_REGISTER_GPR
                && input->value.reg.index < 16u) {
            pl_u8 input_bits = width_code(input->bits);
            if (input_bits == 0xffu) return 0;
            *source = (dispatch_slice_item){
                0u, input->value.reg.index,
                input_bits < item->bits ? input_bits : item->bits, 0u
            };
            return 1;
        }
        if (input->kind == PL_X86_OPERAND_MEMORY
                && exact_frame_slot(input, slot)) {
            *source = (dispatch_slice_item){
                0u, DISPATCH_SLICE_SLOT, width_code(input->bits), 0u
            };
            return source->bits == 0xffu ? 0 : 1;
        }
        if (instruction->operation == PL_X86_OPERATION_MOVE_ZERO_EXTEND
                && input->bits && input->bits <= 32u) {
            pl_u8 input_bits = width_code(input->bits);
            if (input_bits == 0xffu) return 0;
            *maximum = width_mask_u32(input_bits);
            *bounded = 1;
            return 1;
        }
        return 0;
    }
    if (instruction->operation == PL_X86_OPERATION_XOR
            && input->kind == PL_X86_OPERAND_REGISTER
            && same_register(
                input->value.reg, instruction->operands[0].value.reg)) {
        *maximum = 0u;
        *bounded = 1;
        return 1;
    }
    if (instruction->operation == PL_X86_OPERATION_AND
            && input->kind == PL_X86_OPERAND_IMMEDIATE
            && immediate_u32(input, item->bits, maximum)) {
        *bounded = 1;
        return 1;
    }
    if (instruction->operation == PL_X86_OPERATION_SHIFT
            && input->kind == PL_X86_OPERAND_IMMEDIATE
            && instruction->condition == 5u) {
        pl_u64 amount = input->value.immediate;
        pl_u32 bits = 8u << item->bits;
        if (amount >= bits) return 0;
        pl_u64 lane_maximum = bits == 64u
            ? 0xffffffffffffffffull : (1ull << bits) - 1u;
        lane_maximum >>= (pl_u32)amount;
        if (lane_maximum > 0xffffffffu) return 0;
        *maximum = (pl_u32)lane_maximum;
        *bounded = 1;
        return 1;
    }
    return 0;
}

static int relation_value_equal(const dispatch_relation_value *left,
                                const dispatch_relation_value *right)
{
    if (left->is_constant || right->is_constant)
        return left->is_constant && right->is_constant
            && left->constant == right->constant;
    return left->item.value == right->item.value
        && left->item.bits == right->item.bits;
}

static int relation_value_less(const dispatch_relation_value *left,
                               const dispatch_relation_value *right)
{
    if (left->is_constant != right->is_constant)
        return left->is_constant < right->is_constant;
    if (left->is_constant) return left->constant < right->constant;
    if (left->item.value != right->item.value)
        return left->item.value < right->item.value;
    return left->item.bits < right->item.bits;
}

static void relation_order(dispatch_relation_state *state)
{
    if (!relation_value_less(&state->right, &state->left)) return;
    dispatch_relation_value swap = state->left;
    state->left = state->right;
    state->right = swap;
}

static int relation_inverse(
    const pl_x86_instruction *instruction,
    const dispatch_relation_value *value,
    const pl_x86_operand *slot,
    dispatch_relation_value *source)
{
    *source = *value;
    if (value->is_constant) return 1;
    dispatch_slice_item item_source = value->item;
    int bounded = 0;
    pl_u32 maximum = 0u;
    int definition = slice_definition(
        instruction, &value->item, slot,
        &item_source, &bounded, &maximum);
    if (!definition) return 0;
    if (definition == 2) return 1;
    if (!bounded) {
        source->item = item_source;
        return 1;
    }
    int exact = 0;
    if (instruction->operation == PL_X86_OPERATION_MOVE
            && instruction->visible_operand_count >= 2u
            && instruction->operands[1].kind
               == PL_X86_OPERAND_IMMEDIATE)
        exact = 1;
    if (instruction->operation == PL_X86_OPERATION_XOR
            && instruction->visible_operand_count >= 2u
            && instruction->operands[0].kind
               == PL_X86_OPERAND_REGISTER
            && instruction->operands[1].kind
               == PL_X86_OPERAND_REGISTER
            && same_register(
                instruction->operands[0].value.reg,
                instruction->operands[1].value.reg))
        exact = 1;
    if (!exact) return 0;
    source->constant = maximum;
    source->is_constant = 1u;
    return 1;
}

static int relation_state_equal(const dispatch_relation_state *left,
                                const dispatch_relation_state *right)
{
    return left->coordinate == right->coordinate
        && relation_value_equal(&left->left, &right->left)
        && relation_value_equal(&left->right, &right->right);
}

static int relation_enqueue(
    dispatch_relation_state *states, pl_u8 *seen,
    pl_u32 *queue, pl_u32 capacity, pl_u32 *count,
    dispatch_relation_state state)
{
    relation_order(&state);
    if (relation_value_equal(&state.left, &state.right)) return 1;
    if (state.coordinate >= capacity) return 0;
    if (seen[state.coordinate])
        return relation_state_equal(&states[state.coordinate], &state);
    if (*count >= capacity) return 0;
    seen[state.coordinate] = 1u;
    states[state.coordinate] = state;
    queue[(*count)++] = state.coordinate;
    return 1;
}

/* Prove equality of two live values at one control cut by substituting every
 * reaching definition backwards.  A join is accepted only when all incoming
 * paths reach the same relation state; calls and aliasing stores are rejected
 * by slice_definition unless the System V preserved register/private-frame
 * contract makes them irrelevant. */
static int relation_proves_equal(
    const pl_x86_frontend *frontend,
    pl_u64 function_start,
    const pl_u64 *function_entries, pl_u32 function_count,
    const pl_u32 *predecessor_offsets, const pl_u32 *predecessors,
    const pl_x86_operand *slot,
    dispatch_relation_state *states, pl_u8 *seen, pl_u32 *queue,
    pl_u32 extent, pl_u32 coordinate,
    dispatch_relation_value left, dispatch_relation_value right)
{
    for (pl_u32 index = 0u; index < extent; ++index) seen[index] = 0u;
    pl_u32 queued = 0u;
    dispatch_relation_state seed = { coordinate, left, right };
    if (!relation_enqueue(states, seen, queue, extent, &queued, seed))
        return 0;
    for (pl_u32 first = 0u; first < queued; ++first) {
        dispatch_relation_state state = states[queue[first]];
        pl_u64 current = function_start + state.coordinate;
        for (pl_u32 entry = 0u; entry < function_count; ++entry)
            if (function_entries[entry] == current) return 0;
        pl_u32 begin = predecessor_offsets[state.coordinate];
        pl_u32 end = predecessor_offsets[state.coordinate + 1u];
        if (begin == end) return 0;
        for (pl_u32 edge = begin; edge < end; ++edge) {
            pl_u32 predecessor = predecessors[edge];
            pl_x86_instruction instruction;
            if (pl_x86_frontend_decode(
                    frontend, function_start + predecessor, &instruction))
                return 0;
            dispatch_relation_state source = state;
            source.coordinate = predecessor;
            if (!relation_inverse(
                    &instruction, &state.left, slot, &source.left)
                    || !relation_inverse(
                        &instruction, &state.right, slot, &source.right))
                return 0;
            if (!relation_enqueue(
                    states, seen, queue, extent, &queued, source))
                return 0;
        }
    }
    return 1;
}

static int cfg_dispatch_rows(
    const pl_elf_image *elf,
    const pl_x86_frontend *frontend,
    pl_u64 function_start, pl_u64 function_limit,
    const pl_u64 *function_entries, pl_u32 function_count,
    const pl_x86_table *known_tables, pl_u32 known_table_count,
    pl_u64 dispatch_start, pl_x86_register index_register,
    pl_u8 *workspace, pl_u64 workspace_bytes, pl_u32 *rows)
{
    union {
        pl_u64 alignment;
        pl_u8 bytes[65536u];
    } local;
    pl_x86_operand slot = { 0 };
    pl_u64 reload = dispatch_start;
    if (!frontend || !rows || function_start >= function_limit
            || dispatch_start < function_start
            || dispatch_start >= function_limit
            || index_register.class_id != PL_X86_REGISTER_GPR
            || index_register.index >= 16u)
        return 0;
    int have_slot = dispatch_index_slot(
        frontend, function_start, dispatch_start,
        index_register, &slot, &reload);
    pl_u64 extent64 = function_limit - function_start;
    if (!extent64 || extent64 > 0xffffffffu / 16u) return 0;
    pl_u64 required = 0u;
    if (!pl_checked_mul_u64(extent64, 212u, &required)
            || !pl_checked_add_u64(required, 64u, &required))
        return 0;
    if (!workspace || workspace_bytes < required) {
        if (required > sizeof local.bytes) return 0;
        workspace = local.bytes;
        workspace_bytes = sizeof local.bytes;
    }
    (void)workspace_bytes;
    pl_u32 extent = (pl_u32)extent64;
    pl_u64 offset = extent;
    offset = (offset + 7u) & ~7ull;
    pl_u8 *starts = workspace;
    pl_u32 *predecessor_offsets =
        (pl_u32 *)(void *)(workspace + offset);
    offset += ((pl_u64)extent + 1u) * sizeof *predecessor_offsets;
    pl_u32 *cursor = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)extent * sizeof *cursor;
    pl_u32 *predecessors = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)extent * 2u * sizeof *predecessors;
    pl_u64 *visited = (pl_u64 *)(void *)(workspace + offset);
    offset += (pl_u64)extent * 2u * sizeof *visited;
    pl_u64 *table_base = (pl_u64 *)(void *)(workspace + offset);
    offset += (pl_u64)extent * sizeof *table_base;
    dispatch_slice_item *queue =
        (dispatch_slice_item *)(void *)(workspace + offset);
    pl_u32 queue_capacity = extent * 16u;
    offset += (pl_u64)queue_capacity * sizeof *queue;
    offset = (offset + 7u) & ~7ull;
    dispatch_relation_state *relation_states =
        (dispatch_relation_state *)(void *)(workspace + offset);
    offset += (pl_u64)extent * sizeof *relation_states;
    pl_u8 *relation_seen = workspace + offset;
    offset += extent;
    offset = (offset + 3u) & ~3ull;
    pl_u32 *relation_queue =
        (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)extent * sizeof *relation_queue;
    if (offset > required) return 0;

    for (pl_u32 index = 0u; index < extent; ++index) starts[index] = 0u;
    for (pl_u32 index = 0u; index <= extent; ++index)
        predecessor_offsets[index] = 0u;
    for (pl_u64 at = function_start; at < function_limit;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at
                || instruction.fallthrough > function_limit)
            return 0;
        starts[(pl_u32)(at - function_start)] = 1u;
        at = instruction.fallthrough;
    }
    for (pl_u64 at = function_start; at < function_limit;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)) return 0;
        if (instruction.flow == PL_X86_FLOW_CONDITIONAL
                && !(instruction.flags & PL_X86_INSTRUCTION_DIRECT_TARGET))
            return 0;
        pl_u64 successor[2];
        pl_u32 successor_count =
            dispatch_successors(&instruction, successor);
        for (pl_u32 index = 0u; index < successor_count; ++index) {
            if (successor[index] < function_start
                    || successor[index] >= function_limit)
                continue;
            pl_u32 relative =
                (pl_u32)(successor[index] - function_start);
            if (!starts[relative]
                    || predecessor_offsets[relative + 1u]
                       == 0xffffffffu)
                return 0;
            ++predecessor_offsets[relative + 1u];
        }
        at = instruction.fallthrough;
    }
    for (pl_u32 index = 0u; index < extent; ++index) {
        if (predecessor_offsets[index + 1u]
                > 0xffffffffu - predecessor_offsets[index])
            return 0;
        predecessor_offsets[index + 1u] += predecessor_offsets[index];
        cursor[index] = predecessor_offsets[index];
    }
    if (predecessor_offsets[extent] > extent * 2u) return 0;
    for (pl_u64 at = function_start; at < function_limit;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)) return 0;
        pl_u64 successor[2];
        pl_u32 successor_count =
            dispatch_successors(&instruction, successor);
        for (pl_u32 index = 0u; index < successor_count; ++index) {
            if (successor[index] < function_start
                    || successor[index] >= function_limit)
                continue;
            pl_u32 relative =
                (pl_u32)(successor[index] - function_start);
            predecessors[cursor[relative]++] =
                (pl_u32)(at - function_start);
        }
        at = instruction.fallthrough;
    }
    for (pl_u64 index = 0u; index < (pl_u64)extent * 2u; ++index)
        visited[index] = 0u;
    if (!slice_table_target_map(
            elf, known_tables, known_table_count,
            function_start, function_limit, table_base)) {
        return 0;
    }

    pl_u32 queued = 0u;
    pl_u8 seed_bits = have_slot
        ? width_code(slot.bits) : width_code(index_register.bits);
    pl_u8 seed_value = have_slot
        ? DISPATCH_SLICE_SLOT : index_register.index;
    if (seed_bits == 0xffu
            || !slice_enqueue(
                queue, queue_capacity, &queued, visited,
                (pl_u32)(reload - function_start),
                seed_value, seed_bits))
        return 0;
    pl_u32 maximum = 0u;
    int found = 0;
    for (pl_u32 first = 0u; first < queued; ++first) {
        dispatch_slice_item item = queue[first];
        pl_u64 current = function_start + item.coordinate;
        for (pl_u32 entry = 0u; entry < function_count; ++entry)
            if (function_entries[entry] == current) return 0;
        pl_u32 begin = predecessor_offsets[item.coordinate];
        pl_u32 end = predecessor_offsets[item.coordinate + 1u];
        if (table_base[item.coordinate]
                && table_base[item.coordinate]
                   != 0xffffffffffffffffull
                && !slice_indirect_base_predecessors(
                    known_tables, known_table_count,
                    table_base[item.coordinate],
                    function_start, function_limit, &item,
                    queue, queue_capacity, &queued, visited,
                    &found, &maximum))
            return 0;
        if (table_base[item.coordinate]
                    == 0xffffffffffffffffull
                && !slice_indirect_target_predecessors(
                    elf, known_tables, known_table_count, current,
                    function_start, function_limit, &item,
                    queue, queue_capacity, &queued, visited,
                    &found, &maximum))
            return 0;
        if (begin == end && !table_base[item.coordinate]) {
            return 0;
        }
        for (pl_u32 edge = begin; edge < end; ++edge) {
            pl_u32 predecessor = predecessors[edge];
            pl_u64 predecessor_address = function_start + predecessor;
            pl_x86_instruction instruction;
            if (pl_x86_frontend_decode(
                    frontend, predecessor_address, &instruction))
                return 0;

            pl_x86_operand branch_bound;
            pl_u32 branch_maximum = 0u;
            int bounded_target = 0;
            int have_branch_bound = dispatch_branch_bound(
                frontend, &instruction, &branch_bound,
                &branch_maximum, &bounded_target);
            int target_edge = instruction.flow == PL_X86_FLOW_CONDITIONAL
                && instruction.target == current;
            int same_branch_value = have_branch_bound
                && target_edge == bounded_target
                && slice_bound_matches(&item, &branch_bound, &slot);
            if (have_branch_bound && target_edge == bounded_target
                    && !same_branch_value
                    && item.value != DISPATCH_SLICE_SLOT
                    && (frame_slot_operand(&branch_bound)
                        || (branch_bound.kind
                                == PL_X86_OPERAND_REGISTER
                            && branch_bound.value.reg.class_id
                                == PL_X86_REGISTER_GPR
                            && branch_bound.value.reg.index < 16u))) {
                pl_u8 branch_bits = width_code(branch_bound.bits);
                pl_u8 branch_value = frame_slot_operand(&branch_bound)
                    ? DISPATCH_SLICE_SLOT
                    : branch_bound.value.reg.index;
                dispatch_relation_value left = {
                    { predecessor, item.value, item.bits, 0u },
                    0u, 0u, { 0u, 0u, 0u }
                };
                dispatch_relation_value right = {
                    { predecessor, branch_value, branch_bits, 0u },
                    0u, 0u, { 0u, 0u, 0u }
                };
                if (branch_bits != 0xffu)
                    same_branch_value = relation_proves_equal(
                        frontend, function_start,
                        function_entries, function_count,
                        predecessor_offsets, predecessors,
                        &branch_bound,
                        relation_states, relation_seen, relation_queue,
                        extent, predecessor, left, right);
            }
            if (have_branch_bound
                    && target_edge == bounded_target
                    && same_branch_value) {
                pl_u32 lane_mask = width_mask_u32(item.bits);
                if (branch_maximum > lane_mask)
                    branch_maximum = lane_mask;
                if (!slice_record(
                        branch_maximum, &found, &maximum))
                    return 0;
                continue;
            }

            dispatch_slice_item source = item;
            source.coordinate = predecessor;
            int bounded = 0;
            pl_u32 definition_maximum = 0u;
            int definition = slice_definition(
                &instruction, &item, &slot, &source,
                &bounded, &definition_maximum);
            if (!definition) {
                return 0;
            }
            if (definition == 1 && bounded) {
                if (!slice_record(
                        definition_maximum, &found, &maximum))
                    return 0;
                continue;
            }
            if (!slice_enqueue(
                    queue, queue_capacity, &queued, visited,
                    predecessor, source.value, source.bits))
                return 0;
        }
    }
    if (!found || maximum >= 0xffffffffu) return 0;
    *rows = maximum + 1u;
    return *rows != 0u;
}

static int shared_base_consumer(const pl_x86_frontend *frontend,
                                const pl_elf_image *elf,
                                pl_u64 function_start,
                                pl_u64 function_limit,
                                const pl_u64 *function_entries,
                                pl_u32 function_count,
                                const pl_x86_table *known_tables,
                                pl_u32 known_table_count,
                                int allow_cfg,
                                pl_u8 *analysis_workspace,
                                pl_u64 analysis_workspace_bytes,
                                pl_u64 at, pl_x86_register base,
                                pl_u32 *rows, pl_u64 *consumer,
                                pl_u8 *index_register,
                                pl_u8 *index_bits,
                                pl_u16 *clobber_mask)
{
    pl_x86_instruction load_delta;
    if (pl_x86_frontend_decode(frontend, at, &load_delta)
            || (load_delta.operation != PL_X86_OPERATION_MOVE_SIGN_EXTEND
                && load_delta.operation != PL_X86_OPERATION_MOVE)
            || load_delta.visible_operand_count < 2u
            || load_delta.operands[0].kind != PL_X86_OPERAND_REGISTER
            || load_delta.operands[1].kind != PL_X86_OPERAND_MEMORY
            || !same_register(
                load_delta.operands[1].value.memory.base, base))
        return 0;
    const pl_x86_memory *memory =
        &load_delta.operands[1].value.memory;
    int singleton = memory->index.class_id == PL_X86_REGISTER_NONE
        && (!memory->has_displacement || !memory->displacement);
    if (!singleton && memory->scale != 4u) return 0;
    pl_x86_register delta = load_delta.operands[0].value.reg;
    pl_x86_register bounded_index =
        load_delta.operands[1].value.memory.index;
    pl_x86_instruction add_base;
    pl_x86_instruction jump;
    pl_u32 bounded_rows = 0u;
    int found_add = 0;
    pl_u64 add_at = load_delta.fallthrough;
    while (!found_add
            && add_at >= load_delta.fallthrough
            && add_at - load_delta.fallthrough
               <= 2u * PL_X86_MAX_INSTRUCTION_BYTES) {
        pl_x86_instruction candidate;
        if (pl_x86_frontend_decode(frontend, add_at, &candidate)
                || candidate.fallthrough <= add_at)
            break;
        if (candidate.operation == PL_X86_OPERATION_ADD
                && candidate.visible_operand_count >= 2u
                && candidate.operands[0].kind == PL_X86_OPERAND_REGISTER
                && candidate.operands[1].kind == PL_X86_OPERAND_REGISTER
                && same_register(candidate.operands[0].value.reg, delta)
                && same_register(candidate.operands[1].value.reg, base)) {
            add_base = candidate;
            found_add = 1;
            break;
        }
        if (candidate.flow != PL_X86_FLOW_NEXT) break;
        int clobbers_dispatch = 0;
        for (pl_u32 operand = 0u;
                operand < candidate.operand_count; ++operand)
            if (candidate.operands[operand].kind
                    == PL_X86_OPERAND_REGISTER
                    && (candidate.operands[operand].flags
                        & (PL_X86_OPERAND_WRITE
                           | PL_X86_OPERAND_CONDITIONAL_WRITE))
                    && (same_register(
                            candidate.operands[operand].value.reg, delta)
                        || same_register(
                            candidate.operands[operand].value.reg, base))) {
                clobbers_dispatch = 1;
                break;
            }
        if (clobbers_dispatch) break;
        add_at = candidate.fallthrough;
    }
    int found_jump = 0;
    pl_u64 jump_at = found_add ? add_base.fallthrough : 0u;
    while (found_add && !found_jump
            && jump_at >= add_base.fallthrough
            && jump_at - add_base.fallthrough
               <= 2u * PL_X86_MAX_INSTRUCTION_BYTES) {
        pl_x86_instruction candidate;
        if (pl_x86_frontend_decode(frontend, jump_at, &candidate)
                || candidate.fallthrough <= jump_at)
            break;
        if (candidate.flow == PL_X86_FLOW_JUMP
                && (candidate.flags & PL_X86_INSTRUCTION_INDIRECT)) {
            jump = candidate;
            found_jump = 1;
            break;
        }
        if (candidate.flow != PL_X86_FLOW_NEXT) break;
        int clobbers_target = 0;
        for (pl_u32 operand = 0u;
                operand < candidate.operand_count; ++operand)
            if (candidate.operands[operand].kind
                    == PL_X86_OPERAND_REGISTER
                    && (candidate.operands[operand].flags
                        & (PL_X86_OPERAND_WRITE
                           | PL_X86_OPERAND_CONDITIONAL_WRITE))
                    && (same_register(
                            candidate.operands[operand].value.reg, delta)
                        || same_register(
                            candidate.operands[operand].value.reg, base))) {
                clobbers_target = 1;
                break;
            }
        if (clobbers_target) break;
        jump_at = candidate.fallthrough;
    }
    if (same_register(delta, base)
            || !found_add
            || add_base.visible_operand_count < 2u
            || !found_jump
            || jump.flow != PL_X86_FLOW_JUMP
            || !(jump.flags & PL_X86_INSTRUCTION_INDIRECT)
            || !jump.visible_operand_count
            || jump.operands[0].kind != PL_X86_OPERAND_REGISTER
            || !same_register(jump.operands[0].value.reg, delta)
            || (!singleton && !bounded_table_rows(
                    frontend, function_start, load_delta.rip,
                    bounded_index, &bounded_rows)
                && !masked_table_rows(
                    frontend, load_delta.rip,
                    bounded_index, &bounded_rows)
                && (!allow_cfg || !cfg_dispatch_rows(
                    elf, frontend, function_start, function_limit,
                    function_entries, function_count,
                    known_tables, known_table_count,
                    load_delta.rip, bounded_index,
                    analysis_workspace, analysis_workspace_bytes,
                    &bounded_rows))))
        return 0;
    if (singleton) bounded_rows = 1u;
    *rows = bounded_rows;
    if (consumer) *consumer = jump.rip;
    if (index_register)
        *index_register = singleton ? 0xffu : bounded_index.index;
    if (index_bits)
        *index_bits = singleton ? 0xffu : width_code(bounded_index.bits);
    if (clobber_mask) {
        pl_u16 mask = 0u;
        for (pl_u64 instruction_at = load_delta.rip;
                instruction_at <= jump.rip;) {
            pl_x86_instruction instruction;
            if (pl_x86_frontend_decode(
                    frontend, instruction_at, &instruction)
                    || instruction.fallthrough <= instruction_at)
                return 0;
            for (pl_u32 operand = 0u;
                    operand < instruction.operand_count; ++operand)
                if (instruction.operands[operand].kind
                        == PL_X86_OPERAND_REGISTER
                        && (instruction.operands[operand].flags
                            & (PL_X86_OPERAND_WRITE
                               | PL_X86_OPERAND_CONDITIONAL_WRITE))
                        && instruction.operands[operand].value.reg.class_id
                           == PL_X86_REGISTER_GPR
                        && instruction.operands[operand].value.reg.index
                           < 16u)
                    mask |= (pl_u16)(1u
                        << instruction.operands[operand].value.reg.index);
            instruction_at = instruction.fallthrough;
        }
        *clobber_mask = mask;
    }
    return 1;
}

/* Prove the compiler's common shared-base table normal form directly from the
 * linked x86 consumer:
 *
 *   base = &rows[0]; delta = sign_extend(rows[index]); target = base + delta;
 *   jump target
 *
 * Requiring the complete adjacent slice prevents an arbitrary PC32 datum from
 * being promoted to a control entry. */
static int static_function_extent(const pl_elf_image *elf,
                                  pl_u64 address,
                                  pl_u64 *start, pl_u64 *end)
{
    int found = 0;
    pl_u64 selected_start = 0u;
    pl_u64 selected_end = 0u;
    if (!elf || !start || !end) return 0;
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section symbols;
        if (pl_elf_section_read(elf, section_index, &symbols)) return 0;
        if ((symbols.type != PL_ELF_SECTION_SYMTAB
                    && symbols.type != PL_ELF_SECTION_DYNSYM)
                || symbols.entry_bytes != PL_ELF_SYMBOL_BYTES
                || symbols.file_bytes % symbols.entry_bytes)
            continue;
        pl_u64 count = symbols.file_bytes / symbols.entry_bytes;
        for (pl_u64 index = 0u; index < count; ++index) {
            pl_elf_symbol symbol;
            pl_elf_section code;
            if (index > 0xffffffffu
                    || pl_elf_symbol_read(
                        elf, section_index, (pl_u32)index, &symbol))
                return 0;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION || !symbol.bytes
                    || symbol.value > 0xffffffffffffffffull - symbol.bytes)
                continue;
            int executable = code_symbol(elf, &symbol, &code);
            if (executable < 0) return 0;
            pl_u64 limit = symbol.value + symbol.bytes;
            if (!executable || address < symbol.value || address >= limit)
                continue;
            /* Nested aliases describe the same linked bytes.  The narrowest
             * containing function is the strongest lexical extent. */
            if (!found || symbol.value > selected_start
                    || (symbol.value == selected_start
                        && limit < selected_end)) {
                selected_start = symbol.value;
                selected_end = limit;
                found = 1;
            }
        }
    }
    if (found) {
        *start = selected_start;
        *end = selected_end;
    }
    return found;
}

static int shared_base_dispatch(const pl_elf_image *elf,
                                const pl_x86_image *image,
                                pl_u64 relocation_field,
                                const pl_u64 *function_entries,
                                pl_u32 function_count,
                                const pl_x86_table *known_tables,
                                pl_u32 known_table_count,
                                int allow_cfg,
                                pl_u8 *analysis_workspace,
                                pl_u64 analysis_workspace_bytes,
                                pl_u32 *rows, pl_u64 *consumer,
                                pl_u8 *index_register,
                                pl_u8 *index_bits,
                                pl_u16 *clobber_mask)
{
    pl_x86_frontend frontend;
    pl_x86_instruction load_base;
    if (pl_x86_frontend_open(image, &frontend)
            || !relocated_instruction(
                &frontend, relocation_field,
                PL_X86_RELOCATION_DISPLACEMENT, &load_base)
            || load_base.operation != PL_X86_OPERATION_LOAD_ADDRESS
            || load_base.visible_operand_count < 2u
            || load_base.operands[0].kind != PL_X86_OPERAND_REGISTER
            || load_base.operands[1].kind != PL_X86_OPERAND_MEMORY)
        return 0;
    pl_x86_register base = load_base.operands[0].value.reg;

    pl_u32 function_end = 0u;
    pl_u32 low = 0u;
    pl_u32 high = function_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (function_entries[middle] <= load_base.rip)
            low = middle + 1u;
        else
            high = middle;
    }
    function_end = low;
    pl_u64 function_start = 0u;
    pl_u64 function_limit = 0u;
    if (!static_function_extent(
            elf, load_base.rip, &function_start, &function_limit)) {
        if (!function_end) return 0;
        function_start = function_entries[function_end - 1u];
        function_limit = function_end < function_count
                       ? function_entries[function_end]
                       : 0xffffffffffffffffull;
    }

    /* GCC commonly hoists one immutable table base to a callee-saved
     * register in the function prologue.  The consumer is still the same
     * finite shared-base machine; adjacency to the LEA is not observable.
     * Follow the bounded source CFG, not lexical bytes: an early-return path
     * may restore the callee-saved register immediately before a later
     * branch target that still carries the original base. */
    enum { SHARED_BASE_WINDOW = 4096u };
    pl_u8 queued[SHARED_BASE_WINDOW] = { 0u };
    pl_u64 queue[SHARED_BASE_WINDOW];
    pl_u32 first = 0u;
    pl_u32 count = 1u;
    pl_u64 begin = load_base.fallthrough;
    pl_u64 limit = begin <= 0xffffffffffffffffull - SHARED_BASE_WINDOW
                 ? begin + SHARED_BASE_WINDOW
                 : 0xffffffffffffffffull;
    queue[0] = begin;
    queued[0] = 1u;
    while (first < count) {
        pl_u64 at = queue[first++];
        if (at < begin || at >= limit) continue;
        pl_x86_instruction load_delta;
        if (pl_x86_frontend_decode(&frontend, at, &load_delta)
                || load_delta.fallthrough <= at)
            continue;

        if (shared_base_consumer(
                &frontend, elf, function_start, function_limit,
                function_entries, function_count,
                known_tables, known_table_count, allow_cfg,
                analysis_workspace, analysis_workspace_bytes,
                at, base, rows, consumer, index_register, index_bits,
                clobber_mask))
            return 1;

        int clobbers_base = 0;
        for (pl_u32 operand = 0u;
                operand < load_delta.operand_count; ++operand)
            if (load_delta.operands[operand].kind
                    == PL_X86_OPERAND_REGISTER
                    && (load_delta.operands[operand].flags
                        & (PL_X86_OPERAND_WRITE
                           | PL_X86_OPERAND_CONDITIONAL_WRITE))
                    && same_register(
                        load_delta.operands[operand].value.reg, base)) {
                clobbers_base = 1;
                break;
            }
        if (clobbers_base) continue;

        pl_u64 successor[2];
        pl_u32 successor_count = 0u;
        if (load_delta.flow == PL_X86_FLOW_NEXT
                || load_delta.flow == PL_X86_FLOW_CALL
                || load_delta.flow == PL_X86_FLOW_CONDITIONAL)
            successor[successor_count++] = load_delta.fallthrough;
        if ((load_delta.flow == PL_X86_FLOW_JUMP
                    || load_delta.flow == PL_X86_FLOW_CONDITIONAL)
                && (load_delta.flags & PL_X86_INSTRUCTION_DIRECT_TARGET))
            successor[successor_count++] = load_delta.target;
        for (pl_u32 index = 0u; index < successor_count; ++index) {
            if (successor[index] < begin || successor[index] >= limit)
                continue;
            pl_u32 next = (pl_u32)(successor[index] - begin);
            if (queued[next]) continue;
            if (count >= SHARED_BASE_WINDOW) return 0;
            queued[next] = 1u;
            queue[count++] = successor[index];
        }
    }
    /* An earlier finite dispatcher can cut the local CFG before a later
     * consumer of the same hoisted base is discovered.  Lexical discovery is
     * safe here because acceptance still requires the exact shared-base
     * consumer and its own finite predecessor proof; the source dataflow that
     * supplies the callee-saved base is not an output representation. */
    if (callee_saved_base(base) && function_limit > begin) {
        pl_u64 lexical_limit = function_limit < limit
                             ? function_limit : limit;
        for (pl_u64 at = begin; at < lexical_limit;) {
            if (shared_base_consumer(
                    &frontend, elf, function_start, function_limit,
                    function_entries, function_count,
                    known_tables, known_table_count, allow_cfg,
                    analysis_workspace, analysis_workspace_bytes,
                    at, base, rows,
                    consumer, index_register, index_bits, clobber_mask))
                return 1;
            pl_x86_instruction instruction;
            if (pl_x86_frontend_decode(&frontend, at, &instruction)
                    || instruction.fallthrough <= at)
                break;
            at = instruction.fallthrough;
        }
    }
    return 0;
}

static int visit_base_candidates(
    const pl_elf_image *elf, const pl_x86_image *image,
    const pl_u64 *function_entries, pl_u32 function_count,
    const pl_x86_table *known_tables, pl_u32 known_table_count,
    int allow_cfg,
    pl_x86_table *values, pl_u32 capacity,
    pl_u8 *analysis_workspace, pl_u64 analysis_workspace_bytes,
    pl_u32 *count)
{
    pl_u32 written = 0u;
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section relocations;
        int status = pl_elf_section_read(elf, section_index, &relocations);
        if (status) return status;
        if (relocations.type != PL_ELF_SECTION_RELA) continue;
        if (relocations.entry_bytes != PL_ELF_RELOCATION_BYTES
                || relocations.file_bytes % relocations.entry_bytes)
            return PL_ERROR_ELF;
        pl_elf_section place;
        int code_place = 0;
        if (relocations.info) {
            status = pl_elf_section_read(elf, relocations.info, &place);
            if (status) return status;
            code_place = pl_elf_section_is_executable(&place);
        }
        if (!code_place) continue;
        pl_u64 rows = relocations.file_bytes / relocations.entry_bytes;
        for (pl_u64 index = 0u; index < rows; ++index) {
            pl_elf_relocation relocation;
            pl_elf_symbol symbol;
            pl_elf_section target;
            status = pl_elf_relocation_read(
                elf, section_index, index, &relocation);
            if (!status)
                status = pl_elf_symbol_read(
                    elf, relocation.symbol_table_section,
                    relocation.symbol_index, &symbol);
            if (status) return status;
            int data = data_symbol(elf, &symbol, &target);
            if (data < 0) return PL_ERROR_ELF;
            pl_u64 candidate;
            pl_u32 table_rows = 0u;
            pl_u64 consumer = 0u;
            pl_u8 index_register = 0u;
            pl_u8 index_bits = 0u;
            pl_u16 clobber_mask = 0u;
            if (!data || relocation.type != R_X86_64_PC32
                    || !add_signed(symbol.value, relocation.addend_bits,
                                   4u, &candidate)
                    || candidate < target.address
                    || candidate - target.address >= target.file_bytes)
                continue;
            if (image) {
                if (!shared_base_dispatch(
                        elf, image, relocation.offset,
                        function_entries, function_count,
                        known_tables, known_table_count, allow_cfg,
                        analysis_workspace, analysis_workspace_bytes,
                        &table_rows, &consumer,
                        &index_register, &index_bits, &clobber_mask))
                    continue;
                pl_u64 table_offset = candidate - target.address;
                if ((pl_u64)table_rows
                        > (target.file_bytes - table_offset) / 4u)
                    continue;
            }
            if (written == 0xffffffffu || (values && written >= capacity))
                return PL_ERROR_ELF_RANGE;
            if (values) values[written] = (pl_x86_table){
                candidate, consumer, table_rows,
                index_register, index_bits, clobber_mask
            };
            ++written;
        }
    }
    *count = written;
    return 0;
}

static void radix_sort(pl_x86_table *values, pl_x86_table *scratch,
                       pl_u32 count)
{
    pl_x86_table *source = values;
    pl_x86_table *target = scratch;
    for (pl_u32 pass = 0u; pass < 8u; ++pass) {
        pl_u32 counts[256] = { 0u };
        pl_u32 offsets[256];
        pl_u32 shift = pass * 8u;
        for (pl_u32 index = 0u; index < count; ++index)
            ++counts[(source[index].base >> shift) & 0xffu];
        pl_u32 at = 0u;
        for (pl_u32 digit = 0u; digit < 256u; ++digit) {
            offsets[digit] = at;
            at += counts[digit];
        }
        for (pl_u32 index = 0u; index < count; ++index) {
            pl_u32 digit =
                (pl_u32)((source[index].base >> shift) & 0xffu);
            target[offsets[digit]++] = source[index];
        }
        pl_x86_table *swap = source;
        source = target;
        target = swap;
    }
}

static int sort_unique_tables(pl_x86_table *tables,
                              pl_x86_table *scratch,
                              pl_u32 populated, pl_u32 *unique_out)
{
    radix_sort(tables, scratch, populated);
    pl_u32 unique = 0u;
    for (pl_u32 index = 0u; index < populated; ++index)
        if (!unique || tables[index].base != tables[unique - 1u].base) {
            tables[unique++] = tables[index];
        } else if (tables[index].rows != tables[unique - 1u].rows) {
            return PL_ERROR_ELF;
        }
    *unique_out = unique;
    return 0;
}

int pl_x86_table_base_measure(const pl_elf_image *elf, pl_u32 *capacity)
{
    if (!elf || !capacity) return PL_ERROR_ELF;
    return visit_base_candidates(
        elf, 0, 0, 0u, 0, 0u, 0,
        0, 0u, 0, 0u, capacity);
}

int pl_x86_table_base_write(
    const pl_elf_image *elf, const pl_x86_image *image,
    const pl_u64 *function_entries, pl_u32 function_count,
    pl_x86_table *tables, pl_u32 capacity,
    pl_x86_table *scratch, pl_u32 scratch_capacity,
    pl_u8 *analysis_workspace, pl_u64 analysis_workspace_bytes,
    pl_u32 *count)
{
    if (!elf || !image || !function_entries || !function_count
            || !tables || !scratch || !analysis_workspace || !count
            || scratch_capacity < capacity)
        return PL_ERROR_ELF;
    pl_u32 locally_populated = 0u;
    int status = visit_base_candidates(
        elf, image, function_entries, function_count,
        0, 0u, 0,
        tables, capacity,
        analysis_workspace, analysis_workspace_bytes,
        &locally_populated);
    if (status) return status;
    radix_sort(tables, scratch, locally_populated);
    for (pl_u32 index = 0u; index < locally_populated; ++index)
        scratch[index] = tables[index];

    pl_u32 populated = 0u;
    status = visit_base_candidates(
        elf, image, function_entries, function_count,
        scratch, locally_populated, 1,
        tables, capacity,
        analysis_workspace, analysis_workspace_bytes,
        &populated);
    if (status) return status;
    status = sort_unique_tables(tables, scratch, populated, count);
    if (status) return status;
    return 0;
}

static pl_u32 lower_bound(const pl_x86_table *values,
                          pl_u32 count, pl_u64 key)
{
    pl_u32 first = 0u;
    while (first < count) {
        pl_u32 middle = first + (count - first) / 2u;
        if (values[middle].base < key) first = middle + 1u;
        else count = middle;
    }
    return first;
}

int pl_x86_table_row(
    const pl_elf_image *elf, const pl_elf_relocation *relocation,
    const pl_elf_symbol *symbol, const pl_elf_section *place_section,
    const pl_x86_table *tables, pl_u32 table_count,
    pl_x86_table_cursor *cursor, int *recognized,
    pl_u64 *base, pl_u64 *target)
{
    if (!elf || !relocation || !symbol || !place_section || !cursor
            || !recognized || !base || !target
            || (table_count && !tables))
        return PL_ERROR_ELF;
    *recognized = 0;
    if (!(place_section->flags & PL_ELF_SECTION_ALLOC)
            || pl_elf_section_is_executable(place_section)
            || relocation->type != R_X86_64_PC32) {
        cursor->in_table = 0u;
        return 0;
    }
    pl_elf_section code;
    int executable = code_symbol(elf, symbol, &code);
    if (executable < 0) return PL_ERROR_ELF;
    if (!executable) {
        cursor->in_table = 0u;
        return 0;
    }
    pl_u64 field = relocation->offset;
    if (cursor->in_table && field <= cursor->previous_field) {
        cursor->in_table = 0u;
        cursor->table_cursor = lower_bound(tables, table_count, field);
    }
    while (cursor->table_cursor < table_count
            && tables[cursor->table_cursor].base < field)
        ++cursor->table_cursor;
    if (cursor->table_cursor < table_count
            && tables[cursor->table_cursor].base == field) {
        cursor->in_table = 1u;
        cursor->current = tables[cursor->table_cursor];
        ++cursor->table_cursor;
    } else if (!cursor->in_table
            || field != cursor->previous_field + 4u
            || field - cursor->current.base
               >= (pl_u64)cursor->current.rows * 4u) {
        cursor->in_table = 0u;
        return 0;
    }
    pl_u64 raw;
    if (!add_signed(symbol->value, relocation->addend_bits, 0u, &raw))
        return PL_ERROR_ELF_RANGE;
    pl_u64 actual;
    if (cursor->current.base >= field) {
        if (!pl_checked_add_u64(
                raw, cursor->current.base - field, &actual))
            return PL_ERROR_ELF_RANGE;
    } else {
        pl_u64 bias = field - cursor->current.base;
        if (raw < bias) return PL_ERROR_ELF_RANGE;
        actual = raw - bias;
    }
    if (actual < code.address
            || actual - code.address >= code.memory_bytes) {
        cursor->in_table = 0u;
        return 0;
    }
    cursor->previous_field = field;
    *recognized = 1;
    *base = cursor->current.base;
    *target = actual;
    return 0;
}
