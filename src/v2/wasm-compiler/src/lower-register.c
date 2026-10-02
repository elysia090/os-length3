#include "cut-internal.h"

void cut_op(cut_lowering *cut, pl_u32 opcode) { wasm_writer_byte(cut->writer, opcode); }
void cut_get(cut_lowering *cut, pl_u32 local)
{ cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, local ? local + 1u : 0u); }
void cut_set(cut_lowering *cut, pl_u32 local)
{ cut_op(cut, 0x21u); wasm_writer_uleb(cut->writer, local ? local + 1u : 0u); }

void cut_const(cut_lowering *cut, pl_u64 bits)
{
    cut_op(cut, 0x42u);
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

void cut_mask(cut_lowering *cut, pl_u32 bits)
{
    if (bits < 64u) { cut_const(cut, (1ull << bits) - 1u); cut_op(cut, 0x83u); }
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
static int source_operand(const pl_x86_operand *operand)
{
    return (operand->kind == PL_X86_OPERAND_REGISTER && cut_gpr(&operand->value.reg))
        || operand->kind == PL_X86_OPERAND_IMMEDIATE;
}
static int canonical(pl_u64 address)
{ return (address >> 47u) == 0u || (address >> 47u) == 0x1ffffu; }

pl_u32 cut_flag_write_mask(const pl_x86_instruction *instruction)
{
    switch (instruction->operation) {
    case PL_X86_OPERATION_ADD:
    case PL_X86_OPERATION_SUBTRACT:
    case PL_X86_OPERATION_COMPARE:
    case PL_X86_OPERATION_NEGATE:
    case PL_X86_OPERATION_AND:
    case PL_X86_OPERATION_OR:
    case PL_X86_OPERATION_XOR:
    case PL_X86_OPERATION_TEST: return 0x8d5u;
    case PL_X86_OPERATION_INCREMENT:
    case PL_X86_OPERATION_DECREMENT: return 0x8d4u;
    case PL_X86_OPERATION_FLAG_CONTROL:
        return instruction->condition < 2u ? 1u
            : instruction->condition == 3u || instruction->condition == 4u ? 0x400u : 0u;
    default: return 0u;
    }
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
    if (instruction->operation == PL_X86_OPERATION_FLAG_CONTROL)
        return instruction->flow == PL_X86_FLOW_NEXT && !count
            && (instruction->condition < 2u || instruction->condition == 3u || instruction->condition == 4u);
    if (instruction->operation == PL_X86_OPERATION_BRANCH)
        return (instruction->flow == PL_X86_FLOW_JUMP
                || (instruction->flow == PL_X86_FLOW_CONDITIONAL && instruction->condition < 16u))
            && (instruction->flags & PL_X86_INSTRUCTION_DIRECT_TARGET) && canonical(instruction->target);
    if (instruction->flow != PL_X86_FLOW_NEXT || !count
            || operands[0].kind != PL_X86_OPERAND_REGISTER || !cut_gpr(&operands[0].value.reg)) return 0;
    switch (instruction->operation) {
    case PL_X86_OPERATION_COMPLEMENT:
    case PL_X86_OPERATION_NEGATE:
    case PL_X86_OPERATION_INCREMENT:
    case PL_X86_OPERATION_DECREMENT: return count == 1u;
    case PL_X86_OPERATION_MOVE:
    case PL_X86_OPERATION_MOVE_ZERO_EXTEND:
    case PL_X86_OPERATION_MOVE_SIGN_EXTEND:
    case PL_X86_OPERATION_ADD:
    case PL_X86_OPERATION_SUBTRACT:
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
    if (operand->kind == PL_X86_OPERAND_REGISTER) read_register(cut, &operand->value.reg);
    else cut_const(cut, operand->value.immediate);
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
static void condition(cut_lowering *cut, pl_u32 code)
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
                              int subtraction, int logical, int keep_carry)
{
    pl_u32 wanted = cut->wanted_flags;
    if (!wanted) return;
    cut_get(cut, CUT_FLAGS);
    cut_const(cut, ~(pl_u64)wanted); cut_op(cut, 0x83u);
    if (!logical) {
        if (!keep_carry && (wanted & 1u)) {
            cut_get(cut, subtraction ? CUT_LEFT : CUT_VALUE);
            cut_get(cut, subtraction ? CUT_RIGHT : CUT_LEFT);
            cut_op(cut, 0x54u); cut_op(cut, 0xadu); shift_flag(cut, 0u);
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
    if (memory->base.class_id == PL_X86_REGISTER_IP) cut_const(cut, instruction->fallthrough);
    else if (memory->base.class_id == PL_X86_REGISTER_GPR) read_register(cut, &memory->base);
    else cut_const(cut, 0u);
    if (memory->index.class_id == PL_X86_REGISTER_GPR) {
        read_register(cut, &memory->index);
        if (memory->scale > 1u) { cut_const(cut, memory->scale); cut_op(cut, 0x7eu); }
        cut_op(cut, 0x7cu);
    }
    cut_const(cut, (pl_u64)memory->displacement); cut_op(cut, 0x7cu);
    cut_mask(cut, instruction->address_width);
}

void cut_lower_instruction(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    pl_u32 operation = instruction->operation;
    if (operation == PL_X86_OPERATION_NOP) return;
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
        cut_const(cut, instruction->target);
        if (instruction->flow == PL_X86_FLOW_CONDITIONAL) {
            cut_const(cut, instruction->fallthrough);
            condition(cut, instruction->condition); cut_op(cut, 0x1bu);
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
                    || operation == PL_X86_OPERATION_DECREMENT || operation == PL_X86_OPERATION_NEGATE)
                opcode = 0x7du;
            else if (operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_TEST) opcode = 0x83u;
            else if (operation == PL_X86_OPERATION_OR) opcode = 0x84u;
            else if (operation == PL_X86_OPERATION_XOR) opcode = 0x85u;
            cut_op(cut, opcode);
        }
        cut_mask(cut, width); cut_set(cut, CUT_VALUE);
        if (operation != PL_X86_OPERATION_COMPLEMENT)
            cut_arithmetic_flags(cut, width,
                operation == PL_X86_OPERATION_SUBTRACT || operation == PL_X86_OPERATION_COMPARE
                    || operation == PL_X86_OPERATION_DECREMENT || operation == PL_X86_OPERATION_NEGATE,
                operation == PL_X86_OPERATION_AND || operation == PL_X86_OPERATION_OR
                    || operation == PL_X86_OPERATION_XOR || operation == PL_X86_OPERATION_TEST,
                operation == PL_X86_OPERATION_INCREMENT || operation == PL_X86_OPERATION_DECREMENT);
        if (writes) cut_write_register(cut, &operands[0].value.reg);
        return;
    }
    cut_mask(cut, width); cut_set(cut, CUT_VALUE); cut_write_register(cut, &operands[0].value.reg);
}
