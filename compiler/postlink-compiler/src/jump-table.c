#include "internal/jump-table.h"

/* Discover and prove finite targets of indirect control transfers. */

#include <support/checked.h>
#include <stdint.h>

#define R_X86_64_PC32 2u

enum table_proof_pass {
    TABLE_PROOF_COMPLETE = 1,
    TABLE_PROOF_CANDIDATE = 2,
};

typedef struct {
    pl_u64 start;
    pl_u64 end;
    pl_u64 maximum_end;
} function_extent;

static int extent_find(const function_extent *items,
                       pl_u32 begin, pl_u32 end, pl_u64 address,
                       pl_u64 *start, pl_u64 *limit);

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

/* A compiler can copy a structure pointer into a second register immediately
 * before comparing one field, then reload that field through the copy on the
 * accepted arm.  The spelling differs, but the address and generation do not
 * if the copy is exact and the short arm contains no intervening mutation. */
static int copied_memory_value_at(
    const pl_x86_frontend *frontend,
    const pl_x86_instruction *compare, const pl_x86_operand *bound,
    const pl_x86_instruction *branch,
    const pl_x86_instruction *load, const pl_x86_operand *source)
{
    if (!frontend || !compare || !bound || !branch || !load || !source
            || bound->kind != PL_X86_OPERAND_MEMORY
            || source->kind != PL_X86_OPERAND_MEMORY
            || bound->bits != source->bits
            || !bound->bits
            || branch->condition != 7u
            || !(branch->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            || branch->target <= load->rip
            || bound->value.memory.base.class_id != PL_X86_REGISTER_GPR
            || source->value.memory.base.class_id != PL_X86_REGISTER_GPR
            || bound->value.memory.base.bits != 64u
            || source->value.memory.base.bits != 64u
            || bound->value.memory.index.class_id != PL_X86_REGISTER_NONE
            || source->value.memory.index.class_id != PL_X86_REGISTER_NONE
            || !same_register(bound->value.memory.segment,
                              source->value.memory.segment)
            || bound->value.memory.scale != source->value.memory.scale
            || bound->value.memory.has_displacement
               != source->value.memory.has_displacement
            || bound->value.memory.displacement
               != source->value.memory.displacement)
        return 0;
    pl_x86_register old_base = bound->value.memory.base;
    pl_x86_register copied_base = source->value.memory.base;
    if (same_register(old_base, copied_base)) return 0;
    int exact_copy = 0;
    for (pl_u32 bytes = 1u; bytes <= PL_X86_MAX_INSTRUCTION_BYTES;
            ++bytes) {
        if (compare->rip < bytes) break;
        pl_x86_instruction copy;
        if (pl_x86_frontend_decode(
                frontend, compare->rip - bytes, &copy)
                || copy.fallthrough != compare->rip
                || copy.operation != PL_X86_OPERATION_MOVE
                || copy.visible_operand_count < 2u
                || copy.operands[0].kind != PL_X86_OPERAND_REGISTER
                || copy.operands[1].kind != PL_X86_OPERAND_REGISTER
                || copy.operands[0].bits != 64u
                || copy.operands[1].bits != 64u
                || !same_register(copy.operands[0].value.reg, copied_base)
                || !same_register(copy.operands[1].value.reg, old_base))
            continue;
        exact_copy = 1;
        break;
    }
    if (!exact_copy) return 0;
    for (pl_u64 at = branch->fallthrough; at < load->rip;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at
                || instruction.fallthrough > load->rip
                || instruction.flow != PL_X86_FLOW_NEXT
                || (instruction.flags & PL_X86_INSTRUCTION_WRITES_MEMORY)
                || writes_gpr(&instruction, old_base)
                || writes_gpr(&instruction, copied_base))
            return 0;
        at = instruction.fallthrough;
    }
    return 1;
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

static int guard_enqueue(pl_u64 next, pl_u64 guard, pl_u64 dispatch_start,
                         pl_u64 *queue, pl_u64 *seen, pl_u32 *count,
                         pl_u32 capacity, pl_u32 slots)
{
    if (next == guard) return 1;
    if (next == dispatch_start) return 0;
    pl_u32 slot = (pl_u32)((next * 11400714819323198485ull) & (slots - 1u));
    while (seen[slot] && seen[slot] != next)
        slot = (slot + 1u) & (slots - 1u);
    if (seen[slot]) return 1;
    if (*count == capacity) return 0;
    seen[slot] = next;
    queue[(*count)++] = next;
    return 1;
}

static int guard_failure_rechecks(const pl_x86_frontend *frontend,
                                  const pl_elf_image *elf,
                                  const pl_elf_section *table_section,
                                  const pl_x86_table *known_tables,
                                  pl_u32 known_table_count,
                                  pl_u64 function_start,
                                  pl_u64 function_limit,
                                  pl_u64 target, pl_u64 guard,
                                  pl_u64 dispatch_start, int provisional)
{
    enum { CAPACITY = 8192u, SLOTS = 16384u };
    if (function_start >= function_limit) return 0;
    pl_u64 queue[CAPACITY];
    pl_u64 seen[SLOTS] = { 0u };
    pl_u32 count = 1u;
    queue[0] = target;
    /* The rejected arm may loop through earlier code. It is safe only if
     * every route back to the table crosses this same comparison again.
     * Unknown control or a route directly into the table rejects the proof. */
    for (pl_u32 first = 0u; first < count; ++first) {
        pl_u64 at = queue[first];
        if (at == guard) continue;
        /* Outlined cold arms and tail-called functions use this same finite
         * control queue. A symbol boundary is neither a return nor an excuse
         * to stop after a short lexical prefix. Follow every direct arm until
         * a real terminal or the guard; an external route into the dispatch
         * still rejects the proof. The queue bound limits workspace, and an
         * exhausted bound is failure rather than an accepted terminal. */
        if (at == dispatch_start)
            return 0;
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at)
            return 0;
        if (instruction.flow == PL_X86_FLOW_RETURN
                || instruction.flow == PL_X86_FLOW_HALT
                || instruction.flow == PL_X86_FLOW_FAULT)
            continue;
        pl_u64 successors[2];
        pl_u32 successor_count = 0u;
        if (instruction.flow == PL_X86_FLOW_NEXT
                || instruction.flow == PL_X86_FLOW_CALL
                || instruction.flow == PL_X86_FLOW_SYSTEM
                || instruction.flow == PL_X86_FLOW_CONDITIONAL)
            successors[successor_count++] = instruction.fallthrough;
        if (instruction.flow == PL_X86_FLOW_JUMP
                || instruction.flow == PL_X86_FLOW_CONDITIONAL) {
            if (instruction.flags & PL_X86_INSTRUCTION_DIRECT_TARGET) {
                successors[successor_count++] = instruction.target;
            } else if (instruction.flow == PL_X86_FLOW_JUMP
                    && (instruction.flags & PL_X86_INSTRUCTION_INDIRECT)) {
                const pl_x86_table *table = 0;
                for (pl_u32 index = 0u; index < known_table_count; ++index)
                    if (known_tables[index].consumer == at) {
                        table = &known_tables[index];
                        break;
                    }
                /* Candidate discovery may stop at another unresolved table.
                 * This is not an accepted control edge: the complete set is
                 * subsequently checked without this provisional cut. */
                if (!table && provisional) continue;
                if (!table || !table->rows
                        || table->base < table_section->address)
                    return 0;
                for (pl_u32 row = 0u; row < table->rows; ++row) {
                    pl_u64 relative;
                    if (!pl_checked_add_u64(
                            table->base - table_section->address,
                            (pl_u64)row * 4u, &relative))
                        return 0;
                    if (relative > table_section->file_bytes
                            || table_section->file_bytes - relative < 4u
                            || table_section->file_offset > elf->length
                            || relative > elf->length
                                        - table_section->file_offset
                            || elf->length - table_section->file_offset
                                - relative < 4u)
                        return 0;
                    const pl_u8 *bytes = elf->bytes
                        + table_section->file_offset + relative;
                    pl_u32 raw = (pl_u32)bytes[0]
                               | (pl_u32)bytes[1] << 8u
                               | (pl_u32)bytes[2] << 16u
                               | (pl_u32)bytes[3] << 24u;
                    pl_u64 next;
                    if (!add_signed(
                            table->base, (pl_u64)(pl_i64)(pl_i32)raw,
                            0u, &next)
                            || !guard_enqueue(next, guard, dispatch_start,
                                queue, seen, &count, CAPACITY, SLOTS))
                        return 0;
                }
                continue;
            } else {
                return 0;
            }
        }
        if (!successor_count)
            return 0;
        for (pl_u32 edge = 0u; edge < successor_count; ++edge) {
            pl_u64 next = successors[edge];
            if (next == guard) continue;
            /* A tail-position call cannot reenter this function without a
             * new call. Its fallthrough belongs to the next function. */
            if ((instruction.flow == PL_X86_FLOW_CALL
                    || instruction.flow == PL_X86_FLOW_SYSTEM)
                    && next == function_limit)
                continue;
            if (!guard_enqueue(next, guard, dispatch_start,
                    queue, seen, &count, CAPACITY, SLOTS))
                return 0;
        }
    }
    return 1;
}

/* Substitute one proved 64-bit affine index definition into the two memory
 * addresses. Equal effective addresses, width and memory generation denote
 * the same bounded value even when their x86 addressing spellings differ. */
static int affine_memory_value_at(
    const pl_x86_frontend *frontend, const pl_elf_image *elf,
    const pl_elf_section *table_section,
    const pl_x86_table *known_tables, pl_u32 known_table_count,
    pl_u64 function_start, pl_u64 function_limit,
    const pl_x86_instruction *definition,
    const pl_x86_instruction *compare, const pl_x86_operand *bound,
    const pl_x86_instruction *branch,
    const pl_x86_instruction *load, const pl_x86_operand *source,
    int provisional)
{
    if (!definition || definition->fallthrough != compare->rip
            || definition->operation != PL_X86_OPERATION_LOAD_ADDRESS
            || definition->visible_operand_count < 2u
            || definition->operands[0].kind != PL_X86_OPERAND_REGISTER
            || definition->operands[0].bits != 64u
            || definition->operands[1].kind != PL_X86_OPERAND_MEMORY
            || bound->kind != PL_X86_OPERAND_MEMORY
            || source->kind != PL_X86_OPERAND_MEMORY
            || !bound->bits || bound->bits != source->bits
            || !same_register(bound->value.memory.segment,
                              source->value.memory.segment))
        return 0;
    const pl_x86_memory *left = &bound->value.memory;
    const pl_x86_memory *right = &source->value.memory;
    const pl_x86_memory *expression = &definition->operands[1].value.memory;
    pl_x86_register destination = definition->operands[0].value.reg;
    if (left->base.class_id != PL_X86_REGISTER_GPR
            || left->index.class_id != PL_X86_REGISTER_GPR
            || left->base.bits != 64u || left->index.bits != 64u
            || right->base.bits != 64u || right->index.bits != 64u
            || !same_register(left->base, right->base)
            || !same_register(destination, right->index)
            || same_register(destination, left->base)
            || same_register(destination, left->index)
            || !same_register(expression->base, left->index)
            || expression->base.bits != 64u
            || expression->index.class_id != PL_X86_REGISTER_NONE
            || (left->scale != 1u && left->scale != 2u
                && left->scale != 4u && left->scale != 8u)
            || left->scale != right->scale
            || (pl_u64)left->displacement
               != (pl_u64)right->displacement
                  + (pl_u64)expression->displacement * left->scale)
        return 0;
    /* Lexical adjacency alone cannot establish a register generation. Every
     * route from the function entry to CMP must cross this exact LEA. */
    if (!guard_failure_rechecks(frontend, elf, table_section,
            known_tables, known_table_count, function_start, function_limit,
            function_start, definition->rip, compare->rip, provisional))
        return 0;
    for (pl_u64 at = definition->fallthrough; at < load->rip;) {
        pl_x86_instruction step;
        if (pl_x86_frontend_decode(frontend, at, &step)
                || step.fallthrough <= at || step.fallthrough > load->rip
                || (step.flow != PL_X86_FLOW_NEXT && at != branch->rip)
                || (step.flags & PL_X86_INSTRUCTION_WRITES_MEMORY)
                || writes_gpr(&step, left->base)
                || writes_gpr(&step, left->index)
                || writes_gpr(&step, destination))
            return 0;
        at = step.fallthrough;
    }
    return 1;
}

static int bound_path_rows(const pl_x86_frontend *frontend,
                           const pl_elf_image *elf,
                           const pl_elf_section *table_section,
                           const pl_x86_table *known_tables,
                           pl_u32 known_table_count,
                           pl_u64 function_start,
                           pl_u64 function_limit,
                           const pl_x86_instruction *branch,
                           const pl_x86_instruction *compare,
                           const pl_x86_instruction *address_definition,
                           pl_u64 dispatch_start,
                           pl_x86_register index_register,
                           const pl_x86_operand *bound,
                           pl_u64 maximum, pl_u32 *rows, int provisional)
{
    pl_u64 at = branch->fallthrough;
    if (branch->condition == 6u) {
        if (!(branch->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
                || branch->target < branch->fallthrough
                || branch->target > dispatch_start
                || !guard_failure_rechecks(
                        frontend, elf, table_section,
                        known_tables, known_table_count,
                        function_start, function_limit,
                        branch->fallthrough, branch->rip, dispatch_start,
                        provisional))
            return 0;
        at = branch->target;
    } else if (branch->condition == 7u) {
        if (!(branch->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
                || !guard_failure_rechecks(
                        frontend, elf, table_section,
                        known_tables, known_table_count,
                        function_start, function_limit,
                        branch->target, branch->rip, dispatch_start,
                        provisional))
            return 0;
    } else {
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
                     || copied_memory_value_at(
                         frontend, compare, bound, branch,
                         &move, source)
                     || affine_memory_value_at(
                         frontend, elf, table_section,
                         known_tables, known_table_count,
                         function_start, function_limit, address_definition,
                         compare, bound, branch, &move, source, provisional)
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

typedef struct {
    pl_u64 branch;
    pl_u32 rows;
} table_guard_bound;

static int record_guard_bound(table_guard_bound *bounds, pl_u32 *count,
                              pl_u32 capacity, pl_u64 branch, pl_u32 rows)
{
    if (!rows) return 1;
    for (pl_u32 index = 0u; index < *count; ++index)
        if (bounds[index].branch == branch) {
            if (rows > bounds[index].rows) bounds[index].rows = rows;
            return 1;
        }
    if (*count == capacity) return 0;
    bounds[(*count)++] = (table_guard_bound){ branch, rows };
    return 1;
}

static int nested_guard_path(const pl_x86_frontend *frontend,
                             const pl_elf_image *elf,
                             const pl_elf_section *table_section,
                             const pl_x86_table *known_tables,
                             pl_u32 known_table_count,
                             pl_u64 function_start,
                             pl_u64 function_limit,
                             pl_u64 dispatch_start,
                             pl_u64 earlier_at, pl_u64 later_at,
                             int provisional)
{
    pl_x86_instruction earlier;
    pl_x86_instruction later;
    if (earlier_at >= later_at
            || pl_x86_frontend_decode(frontend, earlier_at, &earlier)
            || pl_x86_frontend_decode(frontend, later_at, &later)
            || (earlier.condition != 6u && earlier.condition != 7u)
            || later.condition != 7u
            || !(earlier.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            || !(later.flags & PL_X86_INSTRUCTION_DIRECT_TARGET))
        return 0;
    /* On the earlier guard's accepted arm, the later guard must be crossed.
     * An intervening rejected arm is permitted only when it joins the same
     * failure path already checked for the later guard. */
    pl_u64 accepted = earlier.condition == 6u
                    ? earlier.target : earlier.fallthrough;
    if (accepted > later_at) return 0;
    for (pl_u64 at = accepted; at < later_at;) {
        pl_x86_instruction step;
        if (pl_x86_frontend_decode(frontend, at, &step)
                || step.fallthrough <= at
                || step.fallthrough > later_at)
            return 0;
        if (step.flow == PL_X86_FLOW_CONDITIONAL) {
            if (!(step.flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
                    || (step.target != later.target
                        && !guard_failure_rechecks(
                            frontend, elf, table_section,
                            known_tables, known_table_count,
                            function_start, function_limit,
                            step.target, later.rip, dispatch_start,
                            provisional)))
                return 0;
        } else if (step.flow != PL_X86_FLOW_NEXT) {
            return 0;
        }
        at = step.fallthrough;
    }
    return 1;
}

typedef struct {
    pl_x86_instruction compare;
    pl_x86_instruction previous;
} table_comparison;

static int bounded_branch_rows(const pl_x86_frontend *frontend,
                                const pl_elf_image *elf,
                                const pl_elf_section *table_section,
                                const pl_x86_table *known_tables,
                                pl_u32 known_table_count,
                                pl_u64 function_start,
                                pl_u64 function_limit,
                                const pl_x86_instruction *branch,
                                const table_comparison *comparisons,
                                pl_u32 comparison_count,
                                pl_u64 dispatch_start,
                                pl_x86_register index_register,
                                table_guard_bound *bounds,
                                pl_u32 *count, pl_u32 capacity,
                                int provisional)
{
    /* Record each proved bound separately. Alternative paths form a union;
     * sequential guards on the same accepted path form an intersection. */
    for (pl_u32 index = 0u; index < comparison_count; ++index) {
        const pl_x86_instruction compare = comparisons[index].compare;
        if (compare.rip >= branch->rip
                || branch->rip - compare.rip
                   > 3u * PL_X86_MAX_INSTRUCTION_BYTES
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
                    frontend, elf, table_section,
                    known_tables, known_table_count,
                    function_start, function_limit,
                    branch, &compare, &comparisons[index].previous,
                    dispatch_start,
                    index_register, &projected_bound,
                    projected, &candidate, provisional)
                    && !record_guard_bound(bounds, count, capacity,
                                           branch->rip, candidate))
                return 0;
        }
        candidate = 0u;
        if (bound_path_rows(
                frontend, elf, table_section,
                known_tables, known_table_count,
                function_start, function_limit,
                branch, &compare, &comparisons[index].previous,
                dispatch_start,
                index_register, bound, maximum, &candidate, provisional)
                && !record_guard_bound(bounds, count, capacity,
                                       branch->rip, candidate))
            return 0;
    }
    return 1;
}

static int bounded_table_rows(const pl_x86_frontend *frontend,
                              const pl_elf_image *elf,
                              const pl_elf_section *table_section,
                              const pl_x86_table *known_tables,
                              pl_u32 known_table_count,
                              pl_u64 function_start,
                              pl_u64 function_limit,
                              pl_u64 dispatch_start,
                              pl_x86_register index_register,
                              pl_u32 *rows, int provisional)
{
    enum {
        GUARD_CAPACITY = 128u,
        COMPARE_WINDOW = 3u * PL_X86_MAX_INSTRUCTION_BYTES,
    };
    table_guard_bound bounds[GUARD_CAPACITY];
    pl_u32 count = 0u;
    table_comparison comparisons[COMPARE_WINDOW];
    pl_x86_instruction previous = { 0 };
    pl_u32 comparison_count = 0u;
    /* Decode boundaries once, then retain only the nearby real comparisons.
     * Decoding backwards from every byte can invent CMP/Jcc inside another
     * instruction's immediate or displacement and enlarge a finite domain.
     * A distant accepted arm still uses these exact source definitions. */
    for (pl_u64 at = function_start;
            at < dispatch_start && at <= 0xffffffffffffffffull - 1u;) {
        pl_x86_instruction branch;
        if (pl_x86_frontend_decode(frontend, at, &branch)
                || branch.fallthrough <= at)
            break;
        pl_u32 expired = 0u;
        while (expired < comparison_count
                && branch.rip - comparisons[expired].compare.rip > COMPARE_WINDOW)
            ++expired;
        if (expired) {
            comparison_count -= expired;
            for (pl_u32 index = 0u; index < comparison_count; ++index)
                comparisons[index] = comparisons[index + expired];
        }
        if (branch.operation == PL_X86_OPERATION_COMPARE) {
            if (comparison_count == COMPARE_WINDOW) return 0;
            comparisons[comparison_count++] = (table_comparison){ branch, previous };
        }
        if (branch.flow == PL_X86_FLOW_CONDITIONAL
                && (branch.flags & PL_X86_INSTRUCTION_DIRECT_TARGET))
            if (!bounded_branch_rows(
                frontend, elf, table_section,
                known_tables, known_table_count,
                    function_start, function_limit, &branch,
                    comparisons, comparison_count,
                    dispatch_start, index_register,
                    bounds, &count, GUARD_CAPACITY, provisional))
                return 0;
        previous = branch;
        at = branch.fallthrough;
    }
    pl_u32 result = 0u;
    for (pl_u32 index = 0u; index < count; ++index) {
        int dominated = 0;
        for (pl_u32 later = 0u; later < count; ++later)
            if (bounds[later].rows < bounds[index].rows
                    && nested_guard_path(frontend, elf, table_section,
                        known_tables, known_table_count,
                        function_start, function_limit, dispatch_start,
                        bounds[index].branch, bounds[later].branch,
                        provisional)) {
                dominated = 1;
                break;
            }
        if (!dominated && bounds[index].rows > result)
            result = bounds[index].rows;
    }
    *rows = result;
    return result != 0u;
}

static int masked_table_rows(const pl_x86_frontend *frontend,
                             pl_u64 dispatch_start,
                             pl_x86_register index_register,
                             pl_u32 *rows)
{
    /* The mask need not be adjacent to the load.  Independent register or
     * memory reads can be scheduled between them, but no intervening write
     * to the index (or control transfer) may invalidate the bound. */
    for (pl_u32 instruction_bytes = 1u;
            instruction_bytes <= 4u * PL_X86_MAX_INSTRUCTION_BYTES;
            ++instruction_bytes) {
        if (dispatch_start < instruction_bytes) break;
        pl_x86_instruction mask;
        if (pl_x86_frontend_decode(
                frontend, dispatch_start - instruction_bytes, &mask)
                || mask.fallthrough > dispatch_start
                || mask.operation != PL_X86_OPERATION_AND
                || mask.visible_operand_count < 2u
                || mask.operands[0].kind != PL_X86_OPERAND_REGISTER
                || mask.operands[1].kind != PL_X86_OPERAND_IMMEDIATE
                || !same_register(
                    mask.operands[0].value.reg, index_register))
            continue;
        pl_u64 at = mask.fallthrough;
        while (at < dispatch_start) {
            pl_x86_instruction intervening;
            if (pl_x86_frontend_decode(frontend, at, &intervening)
                    || intervening.fallthrough <= at
                    || intervening.fallthrough > dispatch_start
                    || intervening.flow != PL_X86_FLOW_NEXT)
                break;
            int clobbers_index = 0;
            for (pl_u32 operand = 0u;
                    operand < intervening.operand_count; ++operand)
                if (intervening.operands[operand].kind
                        == PL_X86_OPERAND_REGISTER
                        && (intervening.operands[operand].flags
                            & (PL_X86_OPERAND_WRITE
                               | PL_X86_OPERAND_CONDITIONAL_WRITE))
                        && same_register(
                            intervening.operands[operand].value.reg,
                            index_register)) {
                    clobbers_index = 1;
                    break;
                }
            if (clobbers_index) break;
            at = intervening.fallthrough;
        }
        if (at != dispatch_start) continue;
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
        && operand->value.memory.base.bits == 64u
        && (operand->value.memory.base.index == 4u
            || operand->value.memory.base.index == 5u)
        && operand->value.memory.index.class_id == PL_X86_REGISTER_NONE
        && operand->value.memory.has_displacement;
}

static int frame_slot_overlap(const pl_x86_operand *left,
                              const pl_x86_operand *right)
{
    if (!frame_slot_operand(left) || !frame_slot_operand(right)
            || !same_register(left->value.memory.base,
                              right->value.memory.base)
            || !same_register(left->value.memory.segment,
                              right->value.memory.segment))
        return 0;
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
        && same_register(left->value.memory.base,
                         right->value.memory.base)
        && same_register(left->value.memory.segment,
                         right->value.memory.segment)
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
                || instruction->operands[1].bits > 64u)
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
        pl_x86_register frame = slot->value.memory.base;
        /* A red-zone slot is stable only while RSP stays fixed. CALL may
         * overwrite it through a callee even though RSP later recovers. */
        if (frame.index == 4u
                && (instruction->flow == PL_X86_FLOW_CALL
                    || instruction->operation == PL_X86_OPERATION_PUSH
                    || instruction->operation == PL_X86_OPERATION_POP
                    || instruction->operation == PL_X86_OPERATION_PUSH_FLAGS
                    || instruction->operation == PL_X86_OPERATION_POP_FLAGS
                    || instruction->operation == PL_X86_OPERATION_ENTER
                    || instruction->operation == PL_X86_OPERATION_LEAVE))
            return 0;
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
        && left->item.bits == right->item.bits
        && (left->item.value < 17u
            || left->item.coordinate == right->item.coordinate);
}

static int relation_value_less(const dispatch_relation_value *left,
                               const dispatch_relation_value *right)
{
    if (left->is_constant != right->is_constant)
        return left->is_constant < right->is_constant;
    if (left->is_constant) return left->constant < right->constant;
    if (left->item.value != right->item.value)
        return left->item.value < right->item.value;
    if (left->item.value >= 17u
            && left->item.coordinate != right->item.coordinate)
        return left->item.coordinate < right->item.coordinate;
    return left->item.bits < right->item.bits;
}

/* A linked leaf's complete extent can prove more than the external ABI.
 * Do not assume caller-saved registers change when no reachable instruction
 * can write them. Unknown calls, transfers and machine operations refuse the
 * refinement; closed local jump tables must stay within that same extent. */
static int leaf_preserves_gpr(
    const pl_elf_image *elf, const pl_x86_frontend *frontend,
    const pl_x86_instruction *call,
    const function_extent *functions, pl_u32 function_count,
    const pl_x86_table *tables, pl_u32 table_count, pl_u8 value)
{
    pl_u64 begin = 0u, limit = 0u;
    if (!(call->flags & PL_X86_INSTRUCTION_DIRECT_TARGET)
            || !extent_find(functions, 0u, function_count,
                            call->target, &begin, &limit)
            || begin != call->target || limit - begin > 8192u)
        return 0;
    pl_u8 starts[1024] = { 0u }, targets[1024] = { 0u };
    pl_x86_register tracked = { PL_X86_REGISTER_GPR, value, 64u, 0u };
    int returns = 0;
    for (pl_u64 at = begin; at < limit;) {
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, at, &instruction)
                || instruction.fallthrough <= at
                || instruction.fallthrough > limit
                || (value < 16u && writes_gpr(&instruction, tracked))
                || (value >= 16u
                    && (instruction.flags & PL_X86_INSTRUCTION_WRITES_MEMORY))
                || instruction.flow == PL_X86_FLOW_CALL
                || (instruction.flow != PL_X86_FLOW_NEXT
                    && instruction.flow != PL_X86_FLOW_RETURN
                    && instruction.flow != PL_X86_FLOW_JUMP
                    && instruction.flow != PL_X86_FLOW_CONDITIONAL))
            return 0;
        if (instruction.flow == PL_X86_FLOW_RETURN) returns = 1;
        pl_u64 relative = at - begin;
        starts[relative / 8u] |= (pl_u8)(1u << (relative % 8u));
        if (instruction.flow == PL_X86_FLOW_JUMP
                || instruction.flow == PL_X86_FLOW_CONDITIONAL) {
            if (instruction.flags & PL_X86_INSTRUCTION_DIRECT_TARGET) {
                if (instruction.target < begin || instruction.target >= limit)
                    return 0;
                pl_u64 target = instruction.target - begin;
                targets[target / 8u] |= (pl_u8)(1u << (target % 8u));
            } else {
                int closed = 0;
                for (pl_u32 table = 0u; table < table_count; ++table)
                    if (tables[table].consumer == at
                            && tables[table].domain_closed) {
                        closed = 1;
                        break;
                    }
                if (!closed) return 0;
            }
        }
        at = instruction.fallthrough;
    }
    /* A branch into an immediate can execute another instruction stream.
     * Preservation requires every local edge to use the decoded boundaries. */
    for (pl_u32 byte = 0u; byte < sizeof(starts); ++byte)
        if (targets[byte] & (pl_u8)~starts[byte]) return 0;
    for (pl_u32 table = 0u; table < table_count; ++table) {
        const pl_x86_table *descriptor = &tables[table];
        if (descriptor->consumer < begin || descriptor->consumer >= limit)
            continue;
        pl_elf_section section = { 0 };
        int mapped = 0;
        for (pl_u32 index = 0u; index < elf->section_count; ++index) {
            if (pl_elf_section_read(elf, index, &section)) return 0;
            if ((section.flags & PL_ELF_SECTION_ALLOC)
                    && descriptor->base >= section.address
                    && descriptor->base - section.address < section.file_bytes) {
                mapped = 1;
                break;
            }
        }
        if (!mapped || !descriptor->rows) return 0;
        pl_u64 offset = descriptor->base - section.address;
        if ((pl_u64)descriptor->rows * 4u > section.file_bytes - offset
                || section.file_offset > elf->length
                || offset > elf->length - section.file_offset
                || (pl_u64)descriptor->rows * 4u
                    > elf->length - section.file_offset - offset)
            return 0;
        for (pl_u32 row = 0u; row < descriptor->rows; ++row) {
            const pl_u8 *bytes = elf->bytes + section.file_offset + offset
                               + (pl_u64)row * 4u;
            pl_u32 raw = (pl_u32)bytes[0] | (pl_u32)bytes[1] << 8u
                        | (pl_u32)bytes[2] << 16u | (pl_u32)bytes[3] << 24u;
            pl_u64 target = 0u;
            if (!add_signed(descriptor->base, (pl_u64)(pl_i64)(pl_i32)raw,
                            0u, &target)
                    || target < begin || target >= limit)
                return 0;
            pl_u64 relative = target - begin;
            if (!(starts[relative / 8u] & (1u << (relative % 8u)))) return 0;
        }
    }
    return returns;
}

static void relation_order(dispatch_relation_state *state)
{
    if (!relation_value_less(&state->right, &state->left)) return;
    dispatch_relation_value swap = state->left;
    state->left = state->right;
    state->right = swap;
}

static int relation_inverse(
    const pl_elf_image *elf,
    const pl_x86_frontend *frontend,
    const function_extent *functions, pl_u32 function_count,
    const pl_x86_table *tables, pl_u32 table_count,
    int provisional,
    const pl_x86_instruction *instruction,
    const dispatch_relation_value *value,
    const pl_x86_operand *slot,
    dispatch_relation_value *source)
{
    *source = *value;
    if (value->is_constant) return 1;
    if (instruction->flow == PL_X86_FLOW_CALL && value->item.value >= 17u) {
        /* An opaque callee can alias a spill through a passed pointer. The
         * encoding discovery pass may over-approximate the source prefix,
         * but that assumption must never become a closed control proof. */
        if (value->item.value == 17u) return 0;
        return provisional || leaf_preserves_gpr(
            elf, frontend, instruction, functions, function_count,
            tables, table_count, DISPATCH_SLICE_SLOT);
    }
    if (instruction->flow == PL_X86_FLOW_CALL
            && value->item.value < 16u
            && !call_preserves_gpr(value->item.value))
        return leaf_preserves_gpr(elf, frontend, instruction,
                                 functions, function_count,
                                 tables, table_count, value->item.value);
    /* Keep a private frame coordinate in the residual value, not an entire
     * memory history. This also covers a register saved across a leaf call
     * and restored before the later dispatch guard. */
    if (value->item.value < 16u
            && instruction->operation == PL_X86_OPERATION_MOVE
            && instruction->visible_operand_count >= 2u
            && instruction->operands[0].kind == PL_X86_OPERAND_REGISTER
            && instruction->operands[0].value.reg.index == value->item.value
            && instruction->operands[0].value.reg.class_id == PL_X86_REGISTER_GPR
            && width_code(instruction->operands[0].bits) >= value->item.bits
            && frame_slot_operand(&instruction->operands[1])) {
        const pl_x86_operand *input = &instruction->operands[1];
        if (input->value.memory.segment.class_id != PL_X86_REGISTER_SEGMENT
                || input->value.memory.segment.index != 2u)
            return 0;
        pl_i64 displacement = input->value.memory.displacement;
        if (displacement < -2147483647ll - 1ll || displacement > 2147483647ll)
            return 0;
        source->item.coordinate = (pl_u32)(pl_i32)displacement;
        source->item.value = input->value.memory.base.index == 4u ? 17u : 18u;
        source->item.bits = width_code(input->bits);
        return source->item.bits != 0xffu;
    }
    pl_x86_operand private_slot = { 0 };
    dispatch_slice_item tracked = value->item;
    if (tracked.value >= 17u) {
        private_slot.kind = PL_X86_OPERAND_MEMORY;
        private_slot.value.memory.segment = (pl_x86_register){
            PL_X86_REGISTER_SEGMENT, 2u, 16u, 0u
        };
        private_slot.bits = (pl_u16)(8u << tracked.bits);
        private_slot.value.memory.base = (pl_x86_register){
            PL_X86_REGISTER_GPR, tracked.value == 17u ? 4u : 5u, 64u, 0u
        };
        private_slot.value.memory.has_displacement = 1u;
        private_slot.value.memory.displacement = (pl_i32)tracked.coordinate;
        tracked.value = DISPATCH_SLICE_SLOT;
        slot = &private_slot;
    }
    dispatch_slice_item item_source = tracked;
    int bounded = 0;
    pl_u32 maximum = 0u;
    int definition = slice_definition(
        instruction, &tracked, slot,
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

static int function_entry_contains(const pl_u64 *entries, pl_u32 count,
                                   pl_u64 address)
{
    pl_u32 low = 0u;
    pl_u32 high = count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (entries[middle] < address)
            low = middle + 1u;
        else
            high = middle;
    }
    return low < count && entries[low] == address;
}

/* Prove equality of two live values at one control cut by substituting every
 * reaching definition backwards.  A join is accepted only when all incoming
 * paths reach the same relation state; calls and aliasing stores are rejected
 * by slice_definition unless the System V preserved register/private-frame
 * contract makes them irrelevant. */
static int relation_proves_equal(
    const pl_elf_image *elf,
    const pl_x86_frontend *frontend,
    const function_extent *functions, pl_u32 functions_count,
    pl_u64 function_start,
    const pl_u64 *function_entries, pl_u32 function_count,
    const pl_u32 *predecessor_offsets, const pl_u32 *predecessors,
    const pl_u8 *reachable,
    const pl_x86_table *tables, pl_u32 table_count,
    const pl_u64 *table_base,
    int provisional,
    const pl_u8 *speculative_targets, pl_u32 speculative_jump,
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
        if (function_entry_contains(
                function_entries, function_count, current))
            return 0;
        pl_u32 begin = predecessor_offsets[state.coordinate];
        pl_u32 end = predecessor_offsets[state.coordinate + 1u];
        pl_u32 live_predecessors = 0u;
        /* A case label is a real join, even without a lexical predecessor.
         * Carry both values through every established table consumer. The
         * delta-load/add frontier must preserve both; an omitted indirect
         * edge is not evidence that two unrelated values are equal. */
        pl_u64 base = table_base[state.coordinate];
        if (base == 0xffffffffffffffffull) return 0;
        if (base) {
            pl_u32 low = 0u, high = table_count;
            while (low < high) {
                pl_u32 middle = low + (high - low) / 2u;
                if (tables[middle].base < base) low = middle + 1u;
                else high = middle;
            }
            int matched = 0;
            for (pl_u32 index = low;
                    index < table_count && tables[index].base == base;
                    ++index) {
                const pl_x86_table *table = &tables[index];
                if (table->consumer < function_start
                        || table->consumer - function_start >= extent)
                    continue;
                const dispatch_relation_value *values[2] = {
                    &state.left, &state.right
                };
                for (pl_u32 value = 0u; value < 2u; ++value)
                    if (!values[value]->is_constant
                            && values[value]->item.value < DISPATCH_SLICE_SLOT
                            && (table->clobber_mask
                                & (1u << values[value]->item.value)))
                        return 0;
                dispatch_relation_state source = state;
                source.coordinate = (pl_u32)(table->consumer - function_start);
                if (!relation_enqueue(states, seen, queue, extent, &queued, source))
                    return 0;
                matched = 1;
                ++live_predecessors;
            }
            if (!matched) return 0;
        }
        if (speculative_targets[state.coordinate]) {
            pl_x86_instruction jump;
            if (pl_x86_frontend_decode(
                    frontend, function_start + speculative_jump, &jump))
                return 0;
            dispatch_relation_state source = state;
            source.coordinate = speculative_jump;
            if (!relation_inverse(
                    elf, frontend, functions, functions_count, tables, table_count, provisional,
                    &jump, &state.left, slot, &source.left)
                    || !relation_inverse(
                        elf, frontend, functions, functions_count, tables, table_count, provisional,
                        &jump, &state.right, slot, &source.right)
                    || !relation_enqueue(
                        states, seen, queue, extent, &queued, source))
                return 0;
            ++live_predecessors;
        }
        for (pl_u32 edge = begin; edge < end; ++edge) {
            pl_u32 predecessor = predecessors[edge];
            if (reachable[predecessor] != 2u) continue;
            ++live_predecessors;
            pl_x86_instruction instruction;
            if (pl_x86_frontend_decode(
                    frontend, function_start + predecessor, &instruction))
                return 0;
            dispatch_relation_state source = state;
            source.coordinate = predecessor;
            if (!relation_inverse(
                    elf, frontend, functions, functions_count, tables, table_count, provisional,
                    &instruction, &state.left, slot, &source.left)
                    || !relation_inverse(
                        elf, frontend, functions, functions_count, tables, table_count, provisional,
                        &instruction, &state.right, slot, &source.right))
                return 0;
            if (!relation_enqueue(
                    states, seen, queue, extent, &queued, source))
                return 0;
        }
        if (!live_predecessors) return 0;
    }
    return 1;
}

int pl_x86_table_cfg_workspace_measure(pl_u64 extent, pl_u64 *bytes)
{
    /* One transient CFG buffer is reused across functions and proof passes.
     * Its lifetime ends before executable emission; it is never serialized. */
    if (!bytes
            || !pl_checked_mul_u64(extent, 213u, bytes)
            || !pl_checked_add_u64(*bytes, 64u, bytes))
        return PL_ERROR_ELF_RANGE;
    return 0;
}

static int cfg_dispatch_rows(
    const pl_elf_image *elf,
    const pl_elf_section *table_section,
    const pl_x86_frontend *frontend,
    const function_extent *functions, pl_u32 functions_count,
    pl_u64 function_start, pl_u64 function_limit,
    const pl_u64 *function_entries, pl_u32 function_count,
    const pl_x86_table *known_tables, pl_u32 known_table_count,
    pl_u64 dispatch_start, pl_x86_register index_register,
    pl_u64 speculative_base, pl_u64 speculative_consumer,
    pl_u8 *workspace, pl_u64 workspace_bytes,
    int provisional, pl_u32 *rows)
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
    (void)dispatch_index_slot(
        frontend, function_start, dispatch_start,
        index_register, &slot, &reload);
    pl_u64 extent64 = function_limit - function_start;
    if (!extent64 || extent64 > 0xffffffffu / 16u) return 0;
    pl_u64 required = 0u;
    if (pl_x86_table_cfg_workspace_measure(extent64, &required))
        return 0;
    if (!workspace || workspace_bytes < required) {
        if (required > sizeof local.bytes) return 0;
        workspace = local.bytes;
        workspace_bytes = sizeof local.bytes;
    }
    if ((uintptr_t)workspace & 7u) return 0;
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
    offset = (offset + 7u) & ~7ull;
    pl_u64 *visited = (pl_u64 *)(void *)(workspace + offset);
    offset += (pl_u64)extent * 2u * sizeof *visited;
    pl_u64 *table_base = (pl_u64 *)(void *)(workspace + offset);
    offset += (pl_u64)extent * sizeof *table_base;
    pl_u8 *speculative_targets = workspace + offset;
    offset += extent;
    offset = (offset + 7u) & ~7ull;
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
    for (pl_u32 index = 0u; index < extent; ++index)
        speculative_targets[index] = 0u;
    /* This is only a predecessor over-approximation for the bound proof.
     * A row is not accepted merely because it points into the function: the
     * independent bound must fit the complete prefix read below. */
    pl_u32 speculative_rows = 0u;
    if (speculative_consumer < function_start
            || speculative_consumer >= function_limit)
        return 0;
    for (; speculative_rows < 0xffffffffu; ++speculative_rows) {
        pl_u64 field = speculative_base + (pl_u64)speculative_rows * 4u;
        if (field < speculative_base || field < table_section->address
                || field - table_section->address
                   > table_section->file_bytes
                || table_section->file_bytes
                   - (field - table_section->address) < 4u)
            break;
        pl_u64 file = table_section->file_offset
                    + field - table_section->address;
        if (file > elf->length || elf->length - file < 4u) break;
        const pl_u8 *bytes = elf->bytes + file;
        pl_u32 raw = (pl_u32)bytes[0]
                   | (pl_u32)bytes[1] << 8u
                   | (pl_u32)bytes[2] << 16u
                   | (pl_u32)bytes[3] << 24u;
        pl_u64 target = 0u;
        int target_ok = add_signed(speculative_base,
                        (pl_u64)(pl_i64)(pl_i32)raw, 0u, &target);
        if (!target_ok
                || target < function_start || target >= function_limit
                || !starts[target - function_start])
            break;
        speculative_targets[target - function_start] = 1u;
    }
    if (!speculative_rows) return 0;
    if (!slice_table_target_map(
            elf, known_tables, known_table_count,
            function_start, function_limit, table_base)) {
        return 0;
    }

    /* The lexical x86 sweep includes alignment padding and dead byte runs.
     * Only paths from a function entry or an established/candidate table row
     * can constrain the live index. Do not let a dead NOP preceding a real
     * case label become a fabricated predecessor of that label. */
    pl_u32 live_first = 0u;
    pl_u32 live_count = 0u;
    pl_u32 entry_low = 0u;
    pl_u32 entry_high = function_count;
    while (entry_low < entry_high) {
        pl_u32 middle = entry_low + (entry_high - entry_low) / 2u;
        if (function_entries[middle] < function_start)
            entry_low = middle + 1u;
        else
            entry_high = middle;
    }
    for (pl_u32 coordinate = 0u; coordinate < extent; ++coordinate) {
        pl_u64 address = function_start + coordinate;
        int entry = coordinate == 0u;
        while (entry_low < function_count
                && function_entries[entry_low] == address) {
            entry = 1;
            ++entry_low;
        }
        if (!entry && !table_base[coordinate]
                && !speculative_targets[coordinate])
            continue;
        if (!starts[coordinate] || live_count >= extent) return 0;
        starts[coordinate] = 2u;
        cursor[live_count++] = coordinate;
    }
    while (live_first < live_count) {
        pl_u32 coordinate = cursor[live_first++];
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(
                frontend, function_start + coordinate, &instruction))
            return 0;
        if (!provisional && instruction.flow == PL_X86_FLOW_JUMP
                && (instruction.flags & PL_X86_INSTRUCTION_INDIRECT)
                && instruction.rip != speculative_consumer) {
            int known = 0;
            for (pl_u32 index = 0u; index < known_table_count; ++index)
                if (known_tables[index].consumer == instruction.rip) {
                    known = 1;
                    break;
                }
            /* An unknown indirect edge may reenter any predecessor. Its
             * absence from the local graph is not a finite-domain proof. */
            if (!known) return 0;
        }
        pl_u64 successors[2];
        pl_u32 successor_count =
            dispatch_successors(&instruction, successors);
        for (pl_u32 index = 0u; index < successor_count; ++index) {
            if (successors[index] < function_start
                    || successors[index] >= function_limit)
                continue;
            pl_u32 next = (pl_u32)(successors[index] - function_start);
            if (!starts[next]) return 0;
            if (starts[next] == 2u) continue;
            if (live_count >= extent) return 0;
            starts[next] = 2u;
            cursor[live_count++] = next;
        }
    }

    pl_u32 queued = 0u;
    /* Start at the consumer, not at an earlier reload. A later guard may
     * bound that register after the spill was restored, including through a
     * different register proved equal at the guard. Substitution reaches the
     * slot only if that guard has not already discharged the live value. */
    pl_u8 seed_bits = width_code(index_register.bits);
    pl_u8 seed_value = index_register.index;
    if (seed_bits == 0xffu
            || !slice_enqueue(
                queue, queue_capacity, &queued, visited,
                (pl_u32)(dispatch_start - function_start),
                seed_value, seed_bits))
        return 0;
    pl_u32 maximum = 0u;
    int found = 0;
    for (pl_u32 first = 0u; first < queued; ++first) {
        dispatch_slice_item item = queue[first];
        pl_u64 current = function_start + item.coordinate;
        if (function_entry_contains(
                function_entries, function_count, current))
            return 0;
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
        if (speculative_targets[item.coordinate]
                && !slice_enqueue(
                    queue, queue_capacity, &queued, visited,
                    (pl_u32)(speculative_consumer - function_start),
                    item.value, item.bits))
            return 0;
        pl_u32 live_predecessors = 0u;
        if (table_base[item.coordinate]
                || speculative_targets[item.coordinate])
            ++live_predecessors;
        for (pl_u32 edge = begin; edge < end; ++edge) {
            pl_u32 predecessor = predecessors[edge];
            if (starts[predecessor] != 2u) continue;
            ++live_predecessors;
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
                &branch_maximum, &bounded_target)
                /* Identical successors carry the union of both arms. No
                 * comparison bound survives that merged control edge. */
                && instruction.target != instruction.fallthrough;
            int target_edge = instruction.flow == PL_X86_FLOW_CONDITIONAL
                && instruction.target == current;
            int same_branch_value = have_branch_bound
                && target_edge == bounded_target
                && slice_bound_matches(&item, &branch_bound, &slot);
            if (have_branch_bound && target_edge == bounded_target
                    && !same_branch_value
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
                        elf, frontend, functions, functions_count, function_start,
                        function_entries, function_count,
                        predecessor_offsets, predecessors,
                        starts,
                        known_tables, known_table_count, table_base,
                        provisional,
                        speculative_targets,
                        (pl_u32)(speculative_consumer - function_start),
                        item.value == DISPATCH_SLICE_SLOT
                            ? &slot : &branch_bound,
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
        if (!live_predecessors) return 0;
    }
    if (!found || maximum >= speculative_rows) return 0;
    *rows = maximum + 1u;
    return *rows != 0u;
}

/* The rows a compiler-generated shared-base table has when no proof bounds
 * its index: the longest prefix whose every row names an instruction inside
 * the consumer's own function (target = base + sign_extend(row)). A switch
 * table is exactly such a run of `.long label - table` rows; the run ends
 * where a row no longer names this function's code. The caller cuts the run
 * at the next known table and records it as an open domain. */
enum { SHARED_BASE_RUN_LIMIT = 4096u };

static pl_u32 shared_base_run(const pl_x86_frontend *frontend,
                              const pl_elf_image *elf,
                              const pl_elf_section *table_section,
                              pl_u64 base,
                              pl_u64 function_start, pl_u64 function_limit)
{
    pl_u32 rows = 0u;
    for (; rows < SHARED_BASE_RUN_LIMIT; ++rows) {
        pl_u64 field = base + (pl_u64)rows * 4u;
        if (field < base || field < table_section->address
                || field - table_section->address
                   > table_section->file_bytes
                || table_section->file_bytes
                   - (field - table_section->address) < 4u)
            break;
        pl_u64 file = table_section->file_offset
                    + field - table_section->address;
        if (file > elf->length || elf->length - file < 4u) break;
        pl_u64 target;
        if (!add_signed(base,
                (pl_u64)(pl_i64)(pl_i32)pl_read_u32(elf->bytes + file),
                0u, &target)
                || target < function_start || target >= function_limit)
            break;
        pl_x86_instruction instruction;
        if (pl_x86_frontend_decode(frontend, target, &instruction)) break;
    }
    return rows;
}

static int shared_base_consumer(const pl_x86_frontend *frontend,
                                const pl_elf_image *elf,
                                const pl_elf_section *table_section,
                                const function_extent *functions,
                                pl_u32 functions_count,
                                pl_u64 function_start,
                                pl_u64 function_limit,
                                const pl_u64 *function_entries,
                                pl_u32 function_count,
                                const pl_x86_table *known_tables,
                                pl_u32 known_table_count,
                                int proof_pass,
                                int shape_only,
                                pl_u8 *analysis_workspace,
                                pl_u64 analysis_workspace_bytes,
                                pl_u64 at, pl_x86_register base,
                                pl_u64 table_base,
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
        /* ADD has already captured the shared base in delta. Reusing the
         * base register for a call argument no longer changes the target. */
        int clobbers_target = 0;
        for (pl_u32 operand = 0u;
                operand < candidate.operand_count; ++operand)
            if (candidate.operands[operand].kind
                    == PL_X86_OPERAND_REGISTER
                    && (candidate.operands[operand].flags
                        & (PL_X86_OPERAND_WRITE
                           | PL_X86_OPERAND_CONDITIONAL_WRITE))
                    && same_register(
                        candidate.operands[operand].value.reg, delta)) {
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
            || (!shape_only && !singleton && !bounded_table_rows(
                    frontend, elf, table_section,
                    known_tables, known_table_count,
                    function_start, function_limit,
                    load_delta.rip,
                    bounded_index, &bounded_rows,
                    proof_pass == TABLE_PROOF_CANDIDATE)
                && !masked_table_rows(
                    frontend, load_delta.rip,
                    bounded_index, &bounded_rows)
                && (!proof_pass || !cfg_dispatch_rows(
                    elf, table_section, frontend,
                    functions, functions_count,
                    function_start, function_limit,
                    function_entries, function_count,
                    known_tables, known_table_count,
                    load_delta.rip, bounded_index,
                    table_base, jump.rip,
                    analysis_workspace, analysis_workspace_bytes,
                    proof_pass == TABLE_PROOF_CANDIDATE,
                    &bounded_rows))))
        return 0;
    if (shape_only && !singleton)
        bounded_rows = shared_base_run(frontend, elf, table_section,
                                       table_base, function_start,
                                       function_limit);
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
int pl_x86_table_function_index_measure(
    const pl_elf_image *elf, pl_u32 *symbol_rows, pl_u64 *maximum_extent)
{
    if (!elf || !symbol_rows) return PL_ERROR_ELF;
    pl_u32 count = 0u;
    pl_u64 maximum = 0u;
    for (pl_u32 section = 0u; section < elf->section_count; ++section) {
        pl_elf_section symbols;
        int status = pl_elf_section_read(elf, section, &symbols);
        if (status) return status;
        if (symbols.type != PL_ELF_SECTION_SYMTAB
                && symbols.type != PL_ELF_SECTION_DYNSYM)
            continue;
        if (symbols.entry_bytes != PL_ELF_SYMBOL_BYTES
                || symbols.file_bytes % symbols.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 rows = symbols.file_bytes / symbols.entry_bytes;
        if (rows > 0xffffffffu - count) return PL_ERROR_ELF_RANGE;
        count += (pl_u32)rows;
        if (!maximum_extent) continue;
        for (pl_u32 index = 0u; index < (pl_u32)rows; ++index) {
            pl_elf_symbol symbol;
            pl_elf_section code;
            status = pl_elf_symbol_read(elf, section, index, &symbol);
            if (status) return status;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION || !symbol.bytes
                    || symbol.value > 0xffffffffffffffffull - symbol.bytes)
                continue;
            int executable = code_symbol(elf, &symbol, &code);
            if (executable < 0) return PL_ERROR_ELF;
            if (executable
                    && (symbol.value < code.address
                        || symbol.value - code.address > code.file_bytes
                        || symbol.bytes > code.file_bytes
                            - (symbol.value - code.address)))
                return PL_ERROR_ELF_RANGE;
            if (executable && symbol.bytes > maximum) maximum = symbol.bytes;
        }
    }
    *symbol_rows = count;
    if (maximum_extent) *maximum_extent = maximum;
    return 0;
}

static int extent_less(const function_extent *left,
                       const function_extent *right)
{
    return left->start < right->start
        || (left->start == right->start && left->end > right->end);
}

static void extent_sift_down(function_extent *items,
                             pl_u32 root, pl_u32 count)
{
    for (;;) {
        if (root >= count / 2u) return;
        pl_u32 child = root * 2u + 1u;
        if (child + 1u < count
                && extent_less(&items[child], &items[child + 1u]))
            ++child;
        if (!extent_less(&items[root], &items[child])) return;
        function_extent swap = items[root];
        items[root] = items[child];
        items[child] = swap;
        root = child;
    }
}

static pl_u64 extent_build_maximum(function_extent *items,
                                   pl_u32 begin, pl_u32 end)
{
    if (begin == end) return 0u;
    pl_u32 middle = begin + (end - begin) / 2u;
    pl_u64 maximum = items[middle].end;
    pl_u64 left = extent_build_maximum(items, begin, middle);
    pl_u64 right = extent_build_maximum(items, middle + 1u, end);
    if (left > maximum) maximum = left;
    if (right > maximum) maximum = right;
    items[middle].maximum_end = maximum;
    return maximum;
}

static int extent_index_open(const pl_elf_image *elf,
                             function_extent *items, pl_u32 capacity,
                             pl_u32 *count)
{
    if (!elf || !items || !count) return PL_ERROR_ELF;
    pl_u32 written = 0u;
    for (pl_u32 section = 0u; section < elf->section_count; ++section) {
        pl_elf_section symbols;
        int status = pl_elf_section_read(elf, section, &symbols);
        if (status) return status;
        if (symbols.type != PL_ELF_SECTION_SYMTAB
                && symbols.type != PL_ELF_SECTION_DYNSYM)
            continue;
        pl_u64 rows = symbols.file_bytes / symbols.entry_bytes;
        for (pl_u32 index = 0u; index < (pl_u32)rows; ++index) {
            pl_elf_symbol symbol;
            pl_elf_section code;
            status = pl_elf_symbol_read(elf, section, index, &symbol);
            if (status) return status;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION || !symbol.bytes
                    || symbol.value > 0xffffffffffffffffull - symbol.bytes)
                continue;
            int executable = code_symbol(elf, &symbol, &code);
            if (executable < 0) return PL_ERROR_ELF;
            if (!executable) continue;
            if (written >= capacity) return PL_ERROR_ELF_RANGE;
            items[written++] = (function_extent){
                symbol.value, symbol.value + symbol.bytes, 0u
            };
        }
    }
    for (pl_u32 first = written / 2u; first; --first)
        extent_sift_down(items, first - 1u, written);
    for (pl_u32 remaining = written; remaining > 1u; --remaining) {
        function_extent swap = items[0];
        items[0] = items[remaining - 1u];
        items[remaining - 1u] = swap;
        extent_sift_down(items, 0u, remaining - 1u);
    }
    (void)extent_build_maximum(items, 0u, written);
    *count = written;
    return 0;
}

static int extent_find(const function_extent *items,
                       pl_u32 begin, pl_u32 end, pl_u64 address,
                       pl_u64 *start, pl_u64 *limit)
{
    if (begin == end) return 0;
    pl_u32 middle = begin + (end - begin) / 2u;
    if (items[middle].maximum_end <= address) return 0;
    if (items[middle].start <= address) {
        if (extent_find(
                items, middle + 1u, end, address, start, limit))
            return 1;
        if (items[middle].end > address) {
            *start = items[middle].start;
            *limit = items[middle].end;
            return 1;
        }
    }
    return extent_find(items, begin, middle, address, start, limit);
}

static int shared_base_dispatch(const pl_elf_image *elf,
                                const pl_x86_image *image,
                                pl_u64 relocation_field,
                                pl_u64 table_base,
                                const pl_elf_section *table_section,
                                const function_extent *function_index,
                                pl_u32 function_index_count,
                                const pl_u64 *function_entries,
                                pl_u32 function_count,
                                const pl_x86_table *known_tables,
                                pl_u32 known_table_count,
                                int proof_pass,
                                int shape_only,
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
    if (!extent_find(
            function_index, 0u, function_index_count,
            load_base.rip, &function_start, &function_limit)) {
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
                &frontend, elf, table_section,
                function_index, function_index_count,
                function_start, function_limit,
                function_entries, function_count,
                known_tables, known_table_count, proof_pass, shape_only,
                analysis_workspace, analysis_workspace_bytes,
                at, base, table_base,
                rows, consumer, index_register, index_bits,
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
                    &frontend, elf, table_section,
                    function_index, function_index_count,
                    function_start, function_limit,
                    function_entries, function_count,
                    known_tables, known_table_count, proof_pass, shape_only,
                    analysis_workspace, analysis_workspace_bytes,
                    at, base, table_base, rows,
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
    const function_extent *function_index, pl_u32 function_index_count,
    const pl_u64 *function_entries, pl_u32 function_count,
    const pl_x86_table *known_tables, pl_u32 known_table_count,
    int proof_pass, int shape_only,
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
                        elf, image, relocation.offset, candidate,
                        &target,
                        function_index, function_index_count,
                        function_entries, function_count,
                        known_tables, known_table_count, proof_pass,
                        shape_only,
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
                index_register, index_bits, clobber_mask, 1u
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

static int same_table(const pl_x86_table *left, const pl_x86_table *right)
{
    return left->base == right->base && left->consumer == right->consumer
        && left->rows == right->rows
        && left->index_register == right->index_register
        && left->index_bits == right->index_bits
        && left->clobber_mask == right->clobber_mask;
}

int pl_x86_table_base_measure(const pl_elf_image *elf, pl_u32 *capacity)
{
    if (!elf || !capacity) return PL_ERROR_ELF;
    return visit_base_candidates(
        elf, 0, 0, 0u, 0, 0u, 0, 0u, 0, 0,
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
    pl_u32 symbol_rows = 0u;
    int status = pl_x86_table_function_index_measure(
        elf, &symbol_rows, 0);
    pl_u64 index_bytes = (pl_u64)symbol_rows * sizeof(function_extent);
    if (status || index_bytes > analysis_workspace_bytes)
        return status ? status : PL_ERROR_ELF_RANGE;
    function_extent *function_index =
        (function_extent *)(void *)analysis_workspace;
    pl_u32 function_index_count = 0u;
    status = extent_index_open(
        elf, function_index, symbol_rows, &function_index_count);
    if (status) return status;
    analysis_workspace += index_bytes;
    analysis_workspace_bytes -= index_bytes;
    pl_u32 populated = 0u;
    status = visit_base_candidates(
        elf, image, function_index, function_index_count,
        function_entries, function_count,
        0, 0u, TABLE_PROOF_CANDIDATE, 0,
        tables, capacity,
        analysis_workspace, analysis_workspace_bytes,
        &populated);
    if (status) return status;
    status = sort_unique_tables(tables, scratch, populated, count);
    if (status) return status;
    /* Discovery itself has dependencies: an earlier indirect join can expose
     * the equality needed by a later consumer. Close the candidate population
     * monotonically before pruning strict proofs. A table found only during
     * pruning must not be discarded merely because it was absent on pass one.
     * Every addition has a distinct relocated base, so capacity bounds this
     * worklist without a convergence guess or a serialized intermediate. */
    for (;;) {
        pl_u32 known_count = *count;
        status = visit_base_candidates(
            elf, image, function_index, function_index_count,
            function_entries, function_count,
            tables, known_count, TABLE_PROOF_CANDIDATE, 0,
            scratch, scratch_capacity,
            analysis_workspace, analysis_workspace_bytes,
            &populated);
        if (status) return status;
        pl_u32 appended = known_count;
        for (pl_u32 index = 0u; index < populated; ++index) {
            pl_u32 prior = lower_bound(tables, known_count, scratch[index].base);
            if (prior < known_count && tables[prior].base == scratch[index].base)
                continue;
            if (appended >= capacity) return PL_ERROR_ELF_RANGE;
            tables[appended++] = scratch[index];
        }
        if (appended == known_count) break;
        status = sort_unique_tables(tables, scratch, appended, count);
        if (status) return status;
    }
    /* Shared rejected loops may contain mutually dependent dispatch tables.
     * Discover their algebraic candidates first, then remove every candidate
     * whose complete guard proof fails. Repeat after each removal so a table
     * cannot survive by assuming another rejected table. The published set
     * is a fixed point of the strict proof, not the provisional population. */
    for (;;) {
        pl_u32 known_count = *count;
        for (pl_u32 index = 0u; index < known_count; ++index)
            scratch[index] = tables[index];
        status = visit_base_candidates(
            elf, image, function_index, function_index_count,
            function_entries, function_count,
            scratch, known_count, TABLE_PROOF_COMPLETE, 0,
            tables, capacity,
            analysis_workspace, analysis_workspace_bytes,
            &populated);
        if (status) return status;
        pl_u32 retained = 0u;
        for (pl_u32 index = 0u; index < populated; ++index) {
            pl_u32 prior = lower_bound(scratch, known_count,
                                       tables[index].base);
            if (prior < known_count
                    && same_table(&tables[index], &scratch[prior]))
                tables[retained++] = tables[index];
        }
        status = sort_unique_tables(tables, scratch, retained, count);
        if (status) return status;
        if (*count == known_count) break;
    }

    /* A failed control-domain proof does not change the row encoding.
     * Recover the independently decoded shared-base prefixes once, using
     * only the strictly closed set as control evidence. These additional
     * rows retain their real targets and use the same relocation writer;
     * they never become assumptions of the fixed-point bound proof. */
    status = visit_base_candidates(
        elf, image, function_index, function_index_count,
        function_entries, function_count,
        tables, *count, TABLE_PROOF_CANDIDATE, 0,
        scratch, scratch_capacity,
        analysis_workspace, analysis_workspace_bytes,
        &populated);
    if (status) return status;
    for (pl_u32 index = 0u; index < populated; ++index) {
        pl_u32 prior = lower_bound(tables, *count, scratch[index].base);
        if (prior < *count && tables[prior].base == scratch[index].base)
            scratch[index] = tables[prior];
        else
            scratch[index].domain_closed = 0u;
    }
    status = sort_unique_tables(scratch, tables, populated, count);
    if (status) return status;
    for (pl_u32 index = 0u; index < *count; ++index)
        tables[index] = scratch[index];

    /* Every consumer with the exact shared-base shape must be one of the
     * encodings above, or its targets are neither retained nor rewritten and
     * the moved dispatch reads rows that still name the old layout. One whose
     * index no proof bounds is recorded as an open domain over its row run
     * (see shared_base_run), cut at the next table so no row is claimed by
     * two bases; its targets are then retained and its rows rewritten like
     * any recovered prefix, and the relocation writer checks that every row
     * was. A consumer with no such run is refused. */
    pl_u32 shaped = 0u;
    status = visit_base_candidates(
        elf, image, function_index, function_index_count,
        function_entries, function_count,
        tables, *count, TABLE_PROOF_CANDIDATE, 1,
        scratch, scratch_capacity,
        analysis_workspace, analysis_workspace_bytes,
        &shaped);
    if (status) return status;
    pl_u32 known = *count;
    pl_u32 appended = known;
    for (pl_u32 index = 0u; index < shaped; ++index) {
        pl_u32 prior = lower_bound(tables, known, scratch[index].base);
        if (prior < known && tables[prior].base == scratch[index].base)
            continue;
        pl_u64 limit = scratch[index].base
                     + (pl_u64)scratch[index].rows * 4u;
        if (prior < known && tables[prior].base < limit)
            limit = tables[prior].base;
        for (pl_u32 other = 0u; other < shaped; ++other)
            if (scratch[other].base > scratch[index].base
                    && scratch[other].base < limit)
                limit = scratch[other].base;
        pl_u32 rows = (pl_u32)((limit - scratch[index].base) / 4u);
        if (!rows) return PL_ERROR_TABLE_UNPROVED;
        if (appended >= capacity) return PL_ERROR_ELF_RANGE;
        tables[appended] = scratch[index];
        tables[appended].rows = rows;
        tables[appended].domain_closed = 0u;
        ++appended;
    }
    if (appended != known) {
        status = sort_unique_tables(tables, scratch, appended, count);
        if (status) return status;
    }
    return 0;
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
    /* Allocated linked bytes are authoritative, including after a linker or
     * post-link table permutation. RELA supplies ownership, not stale values.
     * Every row is relative to the decoded consumer's shared base. */
    if (field < place_section->address
            || field - place_section->address > place_section->file_bytes
            || place_section->file_bytes
               - (field - place_section->address) < 4u)
        return PL_ERROR_ELF_RANGE;
    pl_u64 file = 0u;
    if (!pl_checked_add_u64(place_section->file_offset,
                field - place_section->address, &file)
            || file > elf->length || elf->length - file < 4u)
        return PL_ERROR_ELF_RANGE;
    pl_u64 actual;
    if (!add_signed(cursor->current.base,
            (pl_u64)(pl_i64)(pl_i32)pl_read_u32(elf->bytes + file),
            0u, &actual))
        return PL_ERROR_ELF_RANGE;
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
