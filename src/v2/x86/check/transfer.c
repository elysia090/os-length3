#include <x86/decode.h>

#include <stdio.h>

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (left[index] != right[index]) return 0;
    return 1;
}

static int spell(const pl_x86_instruction *instruction,
                 pl_u8 bytes[256], pl_u32 *written)
{
    pl_u32 measured = 0u;
    int status = pl_x86_transfer_measure(instruction, &measured);
    if (!status)
        status = pl_x86_transfer_write(
            instruction, bytes, 256u, written);
    return !status && measured != *written ? PL_ERROR_X86 : status;
}

int main(void)
{
    pl_x86_instruction left = { 0 };
    left.rip = 0x1000u;
    left.fallthrough = 0x1005u;
    left.target = 0x2000u;
    left.flags = PL_X86_INSTRUCTION_FALLTHROUGH;
    left.operand_width = 64u;
    left.address_width = 64u;
    left.length = 5u;
    left.status = PL_X86_DECODE_VALID;
    left.flow = PL_X86_FLOW_NEXT;
    left.family = 7u;
    left.opcode = 0x81u;
    left.operand_count = 2u;
    left.visible_operand_count = 2u;
    left.source_bytes = 2u;
    left.source[0] = 0x48u;
    left.source[1] = 0x01u;
    left.operation = 3u;
    left.operands[0].kind = PL_X86_OPERAND_REGISTER;
    left.operands[0].bits = 64u;
    left.operands[0].flags = PL_X86_OPERAND_READ
                           | PL_X86_OPERAND_WRITE;
    left.operands[0].value.reg = (pl_x86_register){
        PL_X86_REGISTER_GPR, 1u, 64u, 0u,
    };
    left.operands[1].kind = PL_X86_OPERAND_IMMEDIATE;
    left.operands[1].bits = 32u;
    left.operands[1].flags = PL_X86_OPERAND_READ;
    left.operands[1].value.immediate = 17u;

    pl_x86_instruction moved = left;
    moved.rip = 0x900000u;
    moved.fallthrough = 0x900005u;
    moved.target = 0x910000u;
    moved.displacement_offset = 3u;
    moved.immediate_offset[0] = 1u;
    moved.operands[0].reserved = 0xffu;

    pl_u8 left_bytes[256], moved_bytes[256], changed_bytes[256];
    pl_u32 left_written = 0u, moved_written = 0u, changed_written = 0u;
    int status = spell(&left, left_bytes, &left_written);
    if (!status) status = spell(&moved, moved_bytes, &moved_written);
    if (!status && (!pl_x86_transfer_equal(&left, &moved)
            || left_written != moved_written
            || !same_bytes(left_bytes, moved_bytes, left_written)))
        status = PL_ERROR_X86;

    pl_x86_instruction changed = moved;
    changed.operands[1].value.immediate = 18u;
    if (!status) status = spell(&changed, changed_bytes, &changed_written);
    if (!status && (pl_x86_transfer_equal(&left, &changed)
            || left_written != changed_written
            || same_bytes(left_bytes, changed_bytes, left_written)))
        status = PL_ERROR_X86;

    pl_x86_instruction fault_a = left;
    pl_x86_instruction fault_b = changed;
    fault_a.flow = PL_X86_FLOW_FAULT;
    fault_b.flow = PL_X86_FLOW_FAULT;
    fault_a.trap_vector = 13u;
    fault_b.trap_vector = 13u;
    if (!status) status = spell(&fault_a, left_bytes, &left_written);
    if (!status) status = spell(&fault_b, moved_bytes, &moved_written);
    if (!status && (!pl_x86_transfer_equal(&fault_a, &fault_b)
            || left_written != moved_written
            || !same_bytes(left_bytes, moved_bytes, left_written)))
        status = PL_ERROR_X86;
    fault_b.trap_vector = 14u;
    if (!status) status = spell(&fault_b, changed_bytes, &changed_written);
    if (!status && (pl_x86_transfer_equal(&fault_a, &fault_b)
            || left_written != changed_written
            || same_bytes(left_bytes, changed_bytes, left_written)))
        status = PL_ERROR_X86;

    if (status) {
        fprintf(stderr, "canonical x86 transfer spelling: RED (%d)\n",
                status);
        return 1;
    }
    printf("canonical x86 transfer spelling: green "
           "(address/padding erased; semantic distinction retained)\n");
    return 0;
}
