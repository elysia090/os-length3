#include "cut-internal.h"

void cut_op(cut_lowering *cut, pl_u32 opcode) { wasm_writer_byte(cut->writer, opcode); }
void cut_get(cut_lowering *cut, pl_u32 local)
{ cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, local ? local + 3u : 0u); }
void cut_set(cut_lowering *cut, pl_u32 local)
{ cut_op(cut, 0x21u); wasm_writer_uleb(cut->writer, local ? local + 3u : 0u); }

static void signed_immediate(cut_lowering *cut, pl_u64 bits)
{
    for (;;) {
        pl_u32 byte = (pl_u32)bits & 0x7fu;
        pl_u64 next = bits >> 7u;
        if (bits >> 63u) next |= ~0ull << 57u;
        int last = (!next && !(byte & 0x40u))
                || (next == ~0ull && (byte & 0x40u));
        wasm_writer_byte(cut->writer, byte | (last ? 0u : 0x80u));
        if (last) break;
        bits = next;
    }
}

void cut_const(cut_lowering *cut, pl_u64 bits)
{ cut_op(cut,0x42u); signed_immediate(cut,bits); }

void cut_i32_const(cut_lowering *cut, pl_u32 bits)
{
    cut_op(cut,0x41u);
    signed_immediate(cut,(pl_u64)bits | (bits & 0x80000000u ? ~0ull << 32u : 0u));
}

void cut_mask(cut_lowering *cut, pl_u32 bits)
{
    if (bits < 64u) { cut_const(cut, (1ull << bits) - 1u); cut_op(cut, 0x83u); }
}

void cut_coordinate(cut_lowering *cut, pl_u64 address)
{
    pl_u64 offset = address - cut->report.entry;
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 2u);
    if (offset) { cut_const(cut, offset); cut_op(cut, 0x7cu); }
}

void cut_load(cut_lowering *cut, pl_u32 offset)
{
    cut_get(cut, 0u); cut_op(cut, 0x29u); /* i64.load */
    wasm_writer_uleb(cut->writer, 3u); wasm_writer_uleb(cut->writer, offset);
}
void cut_store(cut_lowering *cut, pl_u32 offset, pl_u32 local)
{
    cut_get(cut, 0u); cut_get(cut, local); cut_op(cut, 0x37u);
    wasm_writer_uleb(cut->writer, 3u); wasm_writer_uleb(cut->writer, offset);
}

int cut_gpr(const pl_x86_register *reg)
{
    return reg->class_id == PL_X86_REGISTER_GPR && reg->index < 16u
        && (reg->bits == 8u || reg->bits == 16u || reg->bits == 32u || reg->bits == 64u)
        && (!(reg->flags & PL_X86_REGISTER_HIGH8) || (reg->bits == 8u && reg->index < 4u));
}
int cut_selector_read_supported(const pl_x86_instruction *instruction)
{
    if (instruction->status!=PL_X86_DECODE_VALID || instruction->flow!=PL_X86_FLOW_NEXT
            || instruction->operation!=PL_X86_OPERATION_MOVE
            || instruction->machine_operation!=PL_X86_MACHINE_READ_SELECTOR
            || instruction->visible_operand_count!=2u
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_PRIVILEGED|PL_X86_INSTRUCTION_TRAP_AFTER))) return 0;
    const pl_x86_operand *destination=&instruction->operands[0], *source=&instruction->operands[1];
    if (source->kind!=PL_X86_OPERAND_REGISTER || source->bits!=16u
            || source->value.reg.class_id!=PL_X86_REGISTER_SEGMENT
            || source->value.reg.index>=6u || source->value.reg.bits!=16u
            || source->value.reg.flags) return 0;
    int memory=destination->kind==PL_X86_OPERAND_MEMORY;
    if (memory ? destination->bits!=16u
        : destination->kind!=PL_X86_OPERAND_REGISTER || !cut_gpr(&destination->value.reg)
            || destination->bits<16u || destination->bits!=destination->value.reg.bits) return 0;
    pl_u32 target=memory ? 0u : destination->value.reg.index;
    return instruction->machine_argument==(source->value.reg.index|((pl_u64)memory<<8u)
        |((pl_u64)target<<16u)|((pl_u64)destination->bits<<24u));
}
static int source_operand(const pl_x86_operand *operand)
{
    return (operand->kind == PL_X86_OPERAND_REGISTER && cut_gpr(&operand->value.reg))
        || operand->kind == PL_X86_OPERAND_IMMEDIATE;
}
static int canonical(pl_u64 address)
{ return (address >> 47u) == 0u || (address >> 47u) == 0x1ffffu; }

pl_u32 cut_flag_write_mask(const pl_x86_instruction *instruction)
{
    if (cut_paired_exchange_supported(instruction)) return 0x40u;
    switch (instruction->operation) {
    case PL_X86_OPERATION_STRING: return instruction->condition>=3u && instruction->condition<=4u ? 0x8d5u : 0u;
    case PL_X86_OPERATION_ADD:
    case PL_X86_OPERATION_ADD_CARRY:
    case PL_X86_OPERATION_SUBTRACT:
    case PL_X86_OPERATION_SUBTRACT_BORROW:
    case PL_X86_OPERATION_COMPARE:
    case PL_X86_OPERATION_COMPARE_EXCHANGE:
    case PL_X86_OPERATION_EXCHANGE_ADD:
    case PL_X86_OPERATION_NEGATE:
    case PL_X86_OPERATION_AND:
    case PL_X86_OPERATION_OR:
    case PL_X86_OPERATION_XOR:
    case PL_X86_OPERATION_TEST: return 0x8d5u;
    case PL_X86_OPERATION_INCREMENT:
    case PL_X86_OPERATION_DECREMENT: return 0x8d4u;
    case PL_X86_OPERATION_SHIFT:
        if (!cut_shift_supported(instruction)) return 0u;
        if (instruction->operands[1].kind == PL_X86_OPERAND_IMMEDIATE
                && !(instruction->operands[1].value.immediate
                     & (instruction->operands[0].bits == 64u ? 63u : 31u))) return 0u;
        return instruction->condition<2u ? 0x801u : 0x8d5u;
    case PL_X86_OPERATION_DOUBLE_SHIFT:
        if(!cut_double_shift_supported(instruction))return 0u;
        if(instruction->operands[2].kind==PL_X86_OPERAND_IMMEDIATE
            && !(instruction->operands[2].value.immediate
                & (instruction->operands[0].bits==64u?63u:31u)))return 0u;
        return 0x8d5u;
    case PL_X86_OPERATION_FLAG_CONTROL:
        return instruction->condition < 2u ? 1u
            : instruction->condition == 3u || instruction->condition == 4u ? 0x400u : 0u;
    case PL_X86_OPERATION_BIT_TEST: return 1u;
    case PL_X86_OPERATION_BIT_SUMMARY:
        return instruction->condition<2u ? 0x40u : instruction->condition==4u ? 0x8d5u : 0u;
    case PL_X86_OPERATION_MULTIPLY_UNSIGNED:
    case PL_X86_OPERATION_MULTIPLY_SIGNED: return cut_multiply_supported(instruction) ? 0x801u : 0u;
    default: return 0u;
    }
}

pl_u32 cut_flag_kill_mask(const pl_x86_instruction *instruction)
{
    if(instruction->operation==PL_X86_OPERATION_STRING && (instruction->flags&PL_X86_INSTRUCTION_REPEATED))return 0u;
    if (instruction->operation == PL_X86_OPERATION_SHIFT
            && instruction->operands[1].kind == PL_X86_OPERAND_REGISTER) return 0u;
    if(instruction->operation==PL_X86_OPERATION_DOUBLE_SHIFT
        && instruction->operands[2].kind==PL_X86_OPERAND_REGISTER)return 0u;
    return cut_flag_write_mask(instruction);
}

pl_u32 cut_flag_read_mask(const pl_x86_instruction *instruction)
{
    if(instruction->operation==PL_X86_OPERATION_STRING)return 0x400u;
    pl_x86_count_branch count;
    if(pl_x86_count_branch_lower(instruction,&count))return count.zero_flag?0x40u:0u;
    static const pl_u32 condition_bits[] = { 0x800u,1u,0x40u,0x41u,0x80u,4u,0x880u,0x8c0u };
    if (instruction->operation == PL_X86_OPERATION_ADD_CARRY
            || instruction->operation == PL_X86_OPERATION_SUBTRACT_BORROW) return 1u;
    if (instruction->condition < 16u
            && (instruction->operation == PL_X86_OPERATION_CONDITIONAL_SET
                || instruction->operation == PL_X86_OPERATION_CONDITIONAL_MOVE
                || (instruction->operation == PL_X86_OPERATION_BRANCH
                    && instruction->flow == PL_X86_FLOW_CONDITIONAL)))
        return condition_bits[instruction->condition >> 1u];
    return 0u;
}

int cut_instruction_supported(const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    pl_u32 count = instruction->visible_operand_count;
    if (instruction->status != PL_X86_DECODE_VALID
            || instruction->machine_operation != PL_X86_MACHINE_NONE
            || (instruction->flags & (PL_X86_INSTRUCTION_READS_MEMORY
                | PL_X86_INSTRUCTION_WRITES_MEMORY | PL_X86_INSTRUCTION_MAY_TRAP
                | PL_X86_INSTRUCTION_BARRIER | PL_X86_INSTRUCTION_LOCKED
                | PL_X86_INSTRUCTION_PRIVILEGED | PL_X86_INSTRUCTION_TRAP_AFTER))
            || !canonical(instruction->rip) || !canonical(instruction->fallthrough)) return 0;
    if (instruction->operation == PL_X86_OPERATION_NOP) return 1;
    if (instruction->operation == PL_X86_OPERATION_ACCUMULATOR_EXTEND
            || instruction->operation == PL_X86_OPERATION_HIGH_EXTEND)
        return instruction->flow == PL_X86_FLOW_NEXT && !count
            && instruction->condition < 3u
            && instruction->operand_width == (16u << instruction->condition);
    if (instruction->operation == PL_X86_OPERATION_FLAG_CONTROL)
        return instruction->flow == PL_X86_FLOW_NEXT && !count
            && (instruction->condition < 2u || instruction->condition == 3u || instruction->condition == 4u);
    if (instruction->operation == PL_X86_OPERATION_BRANCH)
        return (instruction->flow == PL_X86_FLOW_JUMP
                || (instruction->flow == PL_X86_FLOW_CONDITIONAL && instruction->condition < 16u))
            && (instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET) && canonical(instruction->target);
    if (instruction->flow != PL_X86_FLOW_NEXT || !count
            || operands[0].kind != PL_X86_OPERAND_REGISTER || !cut_gpr(&operands[0].value.reg)) return 0;
    pl_x86_register_update update;
    if(pl_x86_register_update_lower(instruction,&update))return 1;
    switch (instruction->operation) {
    case PL_X86_OPERATION_BYTE_SWAP:
        return count == 1u && (operands[0].bits == 32u || operands[0].bits == 64u)
            && operands[0].bits == operands[0].value.reg.bits && !operands[0].value.reg.flags;
    case PL_X86_OPERATION_EXCHANGE:
        return count==2u && operands[1].kind==PL_X86_OPERAND_REGISTER
            && cut_gpr(&operands[1].value.reg) && operands[0].bits==operands[1].bits
            && operands[0].bits==operands[0].value.reg.bits
            && operands[1].bits==operands[1].value.reg.bits;
    case PL_X86_OPERATION_COMPLEMENT:
    case PL_X86_OPERATION_NEGATE:
    case PL_X86_OPERATION_INCREMENT:
    case PL_X86_OPERATION_DECREMENT: return count == 1u;
    case PL_X86_OPERATION_SHIFT: return cut_shift_supported(instruction);
    case PL_X86_OPERATION_DOUBLE_SHIFT: return cut_double_shift_supported(instruction);
    case PL_X86_OPERATION_MULTIPLY_UNSIGNED:
    case PL_X86_OPERATION_MULTIPLY_SIGNED: return cut_multiply_supported(instruction);
    case PL_X86_OPERATION_BIT_SUMMARY:
        return count==2u && (instruction->condition<2u || instruction->condition==4u)
            && operands[0].bits>=16u && operands[1].kind==PL_X86_OPERAND_REGISTER
            && cut_gpr(&operands[1].value.reg) && operands[0].bits==operands[1].bits;
    case PL_X86_OPERATION_BIT_TEST:
        return count == 2u && instruction->condition < 4u && operands[0].bits >= 16u
            && source_operand(&operands[1])
            && (operands[1].kind == PL_X86_OPERAND_IMMEDIATE || operands[0].bits == operands[1].bits);
    case PL_X86_OPERATION_CONDITIONAL_SET:
        return count == 1u && operands[0].bits == 8u && instruction->condition < 16u;
    case PL_X86_OPERATION_CONDITIONAL_MOVE:
        return count == 2u && instruction->condition < 16u && operands[0].bits >= 16u
            && operands[1].kind == PL_X86_OPERAND_REGISTER && cut_gpr(&operands[1].value.reg)
            && operands[0].bits == operands[1].bits;
    case PL_X86_OPERATION_MOVE:
    case PL_X86_OPERATION_MOVE_ZERO_EXTEND:
    case PL_X86_OPERATION_MOVE_SIGN_EXTEND:
    case PL_X86_OPERATION_ADD:
    case PL_X86_OPERATION_ADD_CARRY:
    case PL_X86_OPERATION_SUBTRACT:
    case PL_X86_OPERATION_SUBTRACT_BORROW:
    case PL_X86_OPERATION_AND:
    case PL_X86_OPERATION_OR:
    case PL_X86_OPERATION_XOR:
    case PL_X86_OPERATION_COMPARE:
    case PL_X86_OPERATION_TEST: return count == 2u && source_operand(&operands[1]);
    case PL_X86_OPERATION_LOAD_ADDRESS: {
        const pl_x86_memory *memory = &operands[1].value.memory;
        return count == 2u && operands[1].kind == PL_X86_OPERAND_MEMORY
            && (instruction->address_width == 32u || instruction->address_width == 64u)
            && (memory->base.class_id == PL_X86_REGISTER_NONE
                || memory->base.class_id == PL_X86_REGISTER_IP || cut_gpr(&memory->base))
            && (memory->index.class_id == PL_X86_REGISTER_NONE || cut_gpr(&memory->index))
            && (!memory->scale || memory->scale == 1u || memory->scale == 2u
                || memory->scale == 4u || memory->scale == 8u);
    }
    default: return 0;
    }
}

static void load_register(cut_lowering *cut, pl_u32 index)
{
    pl_u32 bit = 1u << index;
    if (!(cut->loaded & bit)) {
        cut_load(cut, (pl_u32)offsetof(machine_state, registers) + index * 8u);
        cut_set(cut, index + 1u); cut->loaded |= bit; cut->report.read_registers |= bit;
    }
}
static void read_register(cut_lowering *cut, const pl_x86_register *reg)
{
    load_register(cut, reg->index); cut_get(cut, (pl_u32)reg->index + 1u);
    if (reg->flags & PL_X86_REGISTER_HIGH8) { cut_const(cut, 8u); cut_op(cut, 0x88u); }
    cut_mask(cut, reg->bits);
}
void cut_read_operand(cut_lowering *cut, const pl_x86_operand *operand, pl_u32 width)
{
    if (operand->kind==PL_X86_OPERAND_REGISTER
            && operand->value.reg.class_id==PL_X86_REGISTER_SEGMENT) {
        /* The visible selector is already owned by architectural state.
         * Reading it neither consults a descriptor nor changes its cache. */
        cut_load(cut,offsetof(machine_state,system)
            +(MACHINE_SYSTEM_ES+operand->value.reg.index)*8u);
        cut_mask(cut,16u);
    } else if (operand->kind == PL_X86_OPERAND_REGISTER) read_register(cut, &operand->value.reg);
    else if(cut->operand_binding_kind==CUT_BIND_IMMEDIATE_UNSIGNED
            || cut->operand_binding_kind==CUT_BIND_IMMEDIATE_SIGNED){
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,3u);
        cut_op(cut,cut->operand_binding_kind==CUT_BIND_IMMEDIATE_SIGNED?0xacu:0xadu);
    }else cut_const(cut, operand->value.immediate);
    cut_mask(cut, width);
}

/* Narrow writes preserve the parent; a 32-bit write defines all 64 bits. */
void cut_write_register(cut_lowering *cut, const pl_x86_register *reg)
{
    pl_u32 index = reg->index;
    pl_u32 shift = reg->flags & PL_X86_REGISTER_HIGH8 ? 8u : 0u;
    if (reg->bits < 32u) {
        load_register(cut, index); cut_get(cut, index + 1u);
        cut_const(cut, ~(((1ull << reg->bits) - 1u) << shift)); cut_op(cut, 0x83u);
        cut_get(cut, CUT_VALUE);
        if (shift) { cut_const(cut, shift); cut_op(cut, 0x86u); }
        cut_op(cut, 0x84u);
    } else cut_get(cut, CUT_VALUE);
    cut_set(cut, index + 1u); cut->loaded |= 1u << index;
    cut->report.written_registers |= 1u << index;
}

static void flag_bit(cut_lowering *cut, pl_u32 bit)
{
    cut_get(cut, CUT_FLAGS); cut_const(cut, bit); cut_op(cut, 0x88u);
    cut_const(cut, 1u); cut_op(cut, 0x83u); cut_op(cut, 0xa7u);
}
void cut_condition(cut_lowering *cut, pl_u32 code)
{
    switch (code >> 1u) {
    case 0u: flag_bit(cut, 11u); break;
    case 1u: flag_bit(cut, 0u); break;
    case 2u: flag_bit(cut, 6u); break;
    case 3u: flag_bit(cut, 0u); flag_bit(cut, 6u); cut_op(cut, 0x72u); break;
    case 4u: flag_bit(cut, 7u); break;
    case 5u: flag_bit(cut, 2u); break;
    case 6u: flag_bit(cut, 7u); flag_bit(cut, 11u); cut_op(cut, 0x73u); break;
    case 7u:
        flag_bit(cut, 7u); flag_bit(cut, 11u); cut_op(cut, 0x73u);
        flag_bit(cut, 6u); cut_op(cut, 0x72u); break;
    }
    if (code & 1u) cut_op(cut, 0x45u);
}
static void shift_flag(cut_lowering *cut, pl_u32 bit)
{
    if (bit) { cut_const(cut, bit); cut_op(cut, 0x86u); }
    cut_op(cut, 0x84u);
}
void cut_arithmetic_flags(cut_lowering *cut, pl_u32 width,
                              int subtraction, int logical, int carry_mode)
{
    pl_u32 wanted = cut->wanted_flags;
    if (!wanted) return;
    cut_get(cut, CUT_FLAGS);
    cut_const(cut, ~(pl_u64)wanted); cut_op(cut, 0x83u);
    if (!logical) {
        if (carry_mode != CUT_CARRY_PRESERVE && (wanted & 1u)) {
            cut_get(cut, subtraction ? CUT_LEFT : CUT_VALUE);
            cut_get(cut, subtraction ? CUT_RIGHT : CUT_LEFT);
            cut_op(cut, 0x54u);
            if (carry_mode == CUT_CARRY_INPUT) {
                /* With r reduced modulo 2^width and c the original CF:
                 * ADC carry = (r < a) | (c & (r == a));
                 * SBB borrow = (a < b) | (c & (a == b)).
                 * Folding c into b first loses a carry at b == UINT_MAX. */
                cut_get(cut, CUT_LEFT);
                cut_get(cut, subtraction ? CUT_RIGHT : CUT_VALUE); cut_op(cut, 0x51u);
                cut_get(cut, CUT_NEXT); cut_op(cut, 0xa7u); cut_op(cut, 0x71u);
                cut_op(cut, 0x72u);
            }
            cut_op(cut, 0xadu); shift_flag(cut, 0u);
        }
        if (wanted & 0x10u) {
            cut_get(cut, CUT_LEFT); cut_get(cut, CUT_RIGHT); cut_op(cut, 0x85u);
            cut_get(cut, CUT_VALUE); cut_op(cut, 0x85u);
            cut_const(cut, 0x10u); cut_op(cut, 0x83u); cut_op(cut, 0x84u);
        }
        if (wanted & 0x800u) {
            cut_get(cut, CUT_LEFT); cut_get(cut, CUT_RIGHT); cut_op(cut, 0x85u);
            if (!subtraction) { cut_const(cut, ~0ull); cut_op(cut, 0x85u); }
            cut_get(cut, CUT_LEFT); cut_get(cut, CUT_VALUE); cut_op(cut, 0x85u);
            cut_op(cut, 0x83u); cut_const(cut, width - 1u); cut_op(cut, 0x88u);
            cut_const(cut, 1u); cut_op(cut, 0x83u); shift_flag(cut, 11u);
        }
    }
    if (wanted & 4u) {
        cut_get(cut, CUT_VALUE); cut_const(cut, 255u); cut_op(cut, 0x83u);
        cut_op(cut, 0x7bu); cut_const(cut, 1u); cut_op(cut, 0x83u);
        cut_const(cut, 1u); cut_op(cut, 0x85u); shift_flag(cut, 2u);
    }
    if (wanted & 0x40u) {
        cut_get(cut, CUT_VALUE); cut_op(cut, 0x50u); cut_op(cut, 0xadu); shift_flag(cut, 6u);
    }
    if (wanted & 0x80u) {
        cut_get(cut, CUT_VALUE); cut_const(cut, width - 1u); cut_op(cut, 0x88u);
        cut_const(cut, 1u); cut_op(cut, 0x83u); shift_flag(cut, 7u);
    }
    cut_set(cut, CUT_FLAGS); cut->report.flags_written = 1u;
}

void cut_effective_address(cut_lowering *cut, const pl_x86_instruction *instruction,
                            const pl_x86_memory *memory)
{
    if (memory->base.class_id == PL_X86_REGISTER_IP) cut_coordinate(cut, instruction->fallthrough);
    else if (memory->base.class_id == PL_X86_REGISTER_GPR) read_register(cut, &memory->base);
    else cut_const(cut, 0u);
    if (memory->index.class_id == PL_X86_REGISTER_GPR) {
        read_register(cut, &memory->index);
        if (memory->scale > 1u) { cut_const(cut, memory->scale); cut_op(cut, 0x7eu); }
        cut_op(cut, 0x7cu);
    }
    if (cut->operand_binding_kind == CUT_BIND_MEMORY_DISPLACEMENT) {
        cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 3u);
        cut_op(cut, 0xacu); /* i64.extend_i32_s, before address-size truncation */
    } else cut_const(cut, (pl_u64)memory->displacement);
    cut_op(cut, 0x7cu);
    cut_mask(cut, instruction->address_width);
}

static void swap_groups(cut_lowering *cut, pl_u64 mask, pl_u32 shift)
{
    cut_get(cut, CUT_LEFT); cut_const(cut, mask); cut_op(cut, 0x83u);
    cut_const(cut, shift); cut_op(cut, 0x86u);
    cut_get(cut, CUT_LEFT); cut_const(cut, shift); cut_op(cut, 0x88u);
    cut_const(cut, mask); cut_op(cut, 0x83u); cut_op(cut, 0x84u);
    cut_set(cut, CUT_LEFT);
}

void cut_lower_instruction(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    pl_u32 operation = instruction->operation;
    if (operation == PL_X86_OPERATION_NOP) return;
    if(operation==PL_X86_OPERATION_EXCHANGE_ADD || operation==PL_X86_OPERATION_COMPARE_EXCHANGE){
        cut_lower_register_update(cut,instruction);return;
    }
    if (operation == PL_X86_OPERATION_EXCHANGE) {
        /* Reflexive substitution is identity except a 32-bit parent write:
         * even that self exchange must still clear its original upper half. */
        if (operands[0].value.reg.index==operands[1].value.reg.index
                && operands[0].value.reg.flags==operands[1].value.reg.flags
                && operands[0].bits!=32u) return;
        /* Simultaneous substitution, not three arithmetic operations. Capture
         * both current SSA values before either partial-parent write. AL/AH
         * then preserve the other's newly substituted field; 32-bit writes
         * define a zero upper half even for a self exchange. No flag change. */
        read_register(cut,&operands[0].value.reg); cut_set(cut,CUT_LEFT);
        read_register(cut,&operands[1].value.reg); cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&operands[0].value.reg);
        cut_get(cut,CUT_LEFT); cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&operands[1].value.reg);
        return;
    }
    if (operation == PL_X86_OPERATION_BYTE_SWAP) {
        pl_u32 width = operands[0].bits;
        /* Adjacent-byte and halfword permutations followed by a half rotation.
         * The current slice value is used; no entry-state reload or flag write.
         * A 32-bit rotation also defines the zero upper half of the parent. */
        read_register(cut, &operands[0].value.reg); cut_set(cut, CUT_LEFT);
        swap_groups(cut, width == 32u ? 0x00ff00ffull : 0x00ff00ff00ff00ffull, 8u);
        if (width == 64u) swap_groups(cut, 0x0000ffff0000ffffull, 16u);
        cut_get(cut, CUT_LEFT);
        if (width == 32u) {
            cut_op(cut, 0xa7u); cut_op(cut, 0x41u); wasm_writer_uleb(cut->writer, 16u);
            cut_op(cut, 0x77u); cut_op(cut, 0xadu); /* i32.rotl, i64.extend_i32_u */
        } else { cut_const(cut, 32u); cut_op(cut, 0x89u); }
        cut_set(cut, CUT_VALUE); cut_write_register(cut, &operands[0].value.reg);
        return;
    }
    if (operation == PL_X86_OPERATION_ACCUMULATOR_EXTEND
            || operation == PL_X86_OPERATION_HIGH_EXTEND) {
        pl_u32 width = instruction->operand_width;
        int high = operation == PL_X86_OPERATION_HIGH_EXTEND;
        pl_u32 source_bits = high ? width : width / 2u;
        /* The implicit source uses the current slice value, not entry RAM.
         * Wasm sign-extension truncates first; unrelated upper bits disappear.
         * High-half conversion is exactly an all-zero/all-one sign mask. */
        load_register(cut, 0u); cut_get(cut, 1u);
        if (source_bits < 64u) cut_op(cut, source_bits == 8u ? 0xc2u : source_bits == 16u ? 0xc3u : 0xc4u);
        if (high) { cut_const(cut, 63u); cut_op(cut, 0x87u); }
        cut_mask(cut, width); cut_set(cut, CUT_VALUE);
        pl_x86_register destination = { 0 };
        destination.class_id = PL_X86_REGISTER_GPR;
        destination.index = high ? 2u : 0u; destination.bits = (pl_u16)width;
        cut_write_register(cut, &destination);
        return;
    }
    if (operation == PL_X86_OPERATION_SHIFT) { cut_lower_shift(cut, instruction); return; }
    if(operation==PL_X86_OPERATION_DOUBLE_SHIFT) { cut_lower_double_shift(cut,instruction);return; }
    if (operation == PL_X86_OPERATION_MULTIPLY_SIGNED || operation == PL_X86_OPERATION_MULTIPLY_UNSIGNED) {
        cut_lower_multiply(cut, instruction); return;
    }
    if (operation == PL_X86_OPERATION_BIT_SUMMARY) { cut_lower_summary(cut,instruction); return; }
    if (operation == PL_X86_OPERATION_BIT_TEST) {
        pl_u32 width = operands[0].bits;
        if (!instruction->condition && !(cut->wanted_flags & 1u)) return;
        cut_read_operand(cut,&operands[0],width); cut_set(cut,CUT_LEFT);
        cut_read_operand(cut,&operands[1],width);
        cut_const(cut,width - 1u); cut_op(cut,0x83u); cut_set(cut,CUT_RIGHT);
        cut_const(cut,1u); cut_get(cut,CUT_RIGHT); cut_op(cut,0x86u); cut_set(cut,CUT_RIGHT);
        if (cut->wanted_flags & 1u) {
            /* CF observes the old bit, including a source/destination alias.
             * ZF is unaffected; undefined OF/SF/AF/PF keep their chosen value. */
            cut_get(cut,CUT_FLAGS); cut_const(cut,~1ull); cut_op(cut,0x83u);
            cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x83u);
            cut_op(cut,0x50u); cut_op(cut,0x45u); cut_op(cut,0xadu); cut_op(cut,0x84u);
            cut_set(cut,CUT_FLAGS); cut->report.flags_written = 1u;
        }
        if (instruction->condition) {
            cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT);
            if (instruction->condition == 2u) { cut_const(cut,~0ull); cut_op(cut,0x85u); }
            cut_op(cut,instruction->condition == 1u ? 0x84u : instruction->condition == 2u ? 0x83u : 0x85u);
            cut_mask(cut,width); cut_set(cut,CUT_VALUE); cut_write_register(cut,&operands[0].value.reg);
        }
        return;
    }
    if (operation == PL_X86_OPERATION_CONDITIONAL_SET) {
        cut_condition(cut, instruction->condition); cut_op(cut, 0xadu);
        cut_set(cut, CUT_VALUE); cut_write_register(cut, &operands[0].value.reg);
        return;
    }
    if (operation == PL_X86_OPERATION_CONDITIONAL_MOVE) {
        // Both values are captured before updating an aliased destination.
        // A 32-bit destination zeroes its parent even when the condition fails.
        cut_read_operand(cut,&operands[1],operands[0].bits);
        cut_read_operand(cut,&operands[0],operands[0].bits);
        cut_condition(cut,instruction->condition); cut_op(cut,0x1bu);
        cut_set(cut,CUT_VALUE); cut_write_register(cut,&operands[0].value.reg);
        return;
    }
    if (operation == PL_X86_OPERATION_FLAG_CONTROL) {
        pl_u32 bit = instruction->condition < 2u ? 1u : 0x400u;
        if (!(cut->wanted_flags & bit)) return;
        cut_get(cut, CUT_FLAGS); cut_const(cut, ~(pl_u64)bit); cut_op(cut, 0x83u);
        if (instruction->condition == 1u || instruction->condition == 4u) {
            cut_const(cut, bit); cut_op(cut, 0x84u);
        }
        cut_set(cut, CUT_FLAGS); cut->report.flags_written = 1u;
        return;
    }
    if (operation == PL_X86_OPERATION_BRANCH) {
        if (cut->operand_binding_kind == CUT_BIND_CONTROL_DISPLACEMENT) {
            cut_coordinate(cut, instruction->fallthrough);
            cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 3u);
            cut_op(cut, 0xacu); cut_op(cut, 0x7cu);
        } else cut_coordinate(cut, instruction->target);
        if (instruction->flow == PL_X86_FLOW_CONDITIONAL) {
            cut_coordinate(cut, instruction->fallthrough);
            cut_condition(cut, instruction->condition); cut_op(cut, 0x1bu);
        }
        cut_set(cut, CUT_NEXT); return;
    }
    pl_u32 width = operands[0].value.reg.bits;
    int writes = operation != PL_X86_OPERATION_COMPARE && operation != PL_X86_OPERATION_TEST;
    if (operation == PL_X86_OPERATION_MOVE || operation == PL_X86_OPERATION_MOVE_ZERO_EXTEND
            || operation == PL_X86_OPERATION_MOVE_SIGN_EXTEND) {
        cut_read_operand(cut, &operands[1], width);
        if (operation == PL_X86_OPERATION_MOVE_SIGN_EXTEND) {
            pl_u32 source_bits = operands[1].bits;
            cut_const(cut, 64u - source_bits); cut_op(cut, 0x86u);
            cut_const(cut, 64u - source_bits); cut_op(cut, 0x87u);
        }
    } else if (operation == PL_X86_OPERATION_LOAD_ADDRESS)
        cut_effective_address(cut, instruction, &operands[1].value.memory);
    else {
        int carry_input = operation == PL_X86_OPERATION_ADD_CARRY
                       || operation == PL_X86_OPERATION_SUBTRACT_BORROW;
        if (carry_input) {
            /* The next control target is assigned after this pure slice.
             * Capture CF before any flag definition, including self aliases. */
            cut_get(cut, CUT_FLAGS); cut_const(cut, 1u); cut_op(cut, 0x83u);
            cut_set(cut, CUT_NEXT);
        }
        read_register(cut, &operands[0].value.reg); cut_set(cut, CUT_LEFT);
        if (instruction->visible_operand_count == 2u) cut_read_operand(cut, &operands[1], width);
        else cut_const(cut, 1u);
        cut_set(cut, CUT_RIGHT);
        if (operation == PL_X86_OPERATION_NEGATE) {
            cut_get(cut, CUT_LEFT); cut_set(cut, CUT_RIGHT);
            cut_const(cut, 0u); cut_set(cut, CUT_LEFT);
        }
        cut_get(cut, CUT_LEFT);
        if (operation == PL_X86_OPERATION_COMPLEMENT) {
            cut_const(cut, ~0ull); cut_op(cut, 0x85u);
        } else {
            cut_get(cut, CUT_RIGHT);
            pl_u32 opcode = 0x7cu;
            if (operation == PL_X86_OPERATION_SUBTRACT || operation == PL_X86_OPERATION_COMPARE
                    || operation == PL_X86_OPERATION_SUBTRACT_BORROW
                    || operation == PL_X86_OPERATION_DECREMENT || operation == PL_X86_OPERATION_NEGATE)
                opcode = 0x7du;
            else if (operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_TEST) opcode = 0x83u;
            else if (operation == PL_X86_OPERATION_OR) opcode = 0x84u;
            else if (operation == PL_X86_OPERATION_XOR) opcode = 0x85u;
            cut_op(cut, opcode);
            if (carry_input) { cut_get(cut, CUT_NEXT); cut_op(cut, opcode); }
        }
        cut_mask(cut, width); cut_set(cut, CUT_VALUE);
        if (operation != PL_X86_OPERATION_COMPLEMENT)
            cut_arithmetic_flags(cut, width,
                operation == PL_X86_OPERATION_SUBTRACT || operation == PL_X86_OPERATION_COMPARE
                    || operation == PL_X86_OPERATION_SUBTRACT_BORROW
                    || operation == PL_X86_OPERATION_DECREMENT || operation == PL_X86_OPERATION_NEGATE,
                operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_OR
                    || operation == PL_X86_OPERATION_XOR || operation == PL_X86_OPERATION_TEST,
                carry_input ? CUT_CARRY_INPUT
                    : operation == PL_X86_OPERATION_INCREMENT || operation == PL_X86_OPERATION_DECREMENT
                        ? CUT_CARRY_PRESERVE : CUT_CARRY_NORMAL);
        if (writes) cut_write_register(cut, &operands[0].value.reg);
        return;
    }
    cut_mask(cut, width); cut_set(cut, CUT_VALUE); cut_write_register(cut, &operands[0].value.reg);
}
