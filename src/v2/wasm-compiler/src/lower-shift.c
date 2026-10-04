#include "cut-internal.h"

int cut_shift_supported(const pl_x86_instruction *instruction)
{
    const pl_x86_operand *count = &instruction->operands[1];
    return instruction->operation == PL_X86_OPERATION_SHIFT
        && instruction->visible_operand_count == 2u
        && (instruction->condition < 2u || instruction->condition == 4u || instruction->condition == 5u
            || instruction->condition == 7u)
        && (count->kind == PL_X86_OPERAND_IMMEDIATE
            || (count->kind == PL_X86_OPERAND_REGISTER && cut_gpr(&count->value.reg)
                && count->value.reg.index == 1u && count->value.reg.bits == 8u
                && !(count->value.reg.flags & PL_X86_REGISTER_HIGH8)));
}

static void carry(cut_lowering *cut, pl_u32 width, pl_u32 kind)
{
    cut_get(cut, CUT_LEFT);
    if (kind == 4u) {
        cut_const(cut, width); cut_get(cut, CUT_RIGHT); cut_op(cut, 0x7du);
    } else {
        cut_get(cut, CUT_RIGHT); cut_const(cut, 1u); cut_op(cut, 0x7du);
        if (kind == 7u && width < 32u) {
            /* SAR keeps shifting out the sign after the entire narrow word. */
            cut_const(cut, width - 1u);
            cut_get(cut, CUT_RIGHT); cut_const(cut, width); cut_op(cut, 0x58u);
            cut_op(cut, 0x1bu);
        }
    }
    cut_op(cut, 0x88u); cut_const(cut, 1u); cut_op(cut, 0x83u);
    if (kind != 7u && width < 32u) {
        /* Logical-shift CF at/above width is undefined; choose zero. */
        cut_const(cut, 0u); cut_get(cut, CUT_RIGHT); cut_const(cut, width);
        cut_op(cut, 0x54u); cut_op(cut, 0x1bu);
    }
    cut_set(cut, CUT_NEXT);
}

static void flags(cut_lowering *cut, pl_u32 width, pl_u32 kind)
{
    pl_u32 wanted = cut->wanted_flags;
    if (!wanted) return;
    /* Count zero preserves even AF/OF. No predecessor may be erased merely
     * because this instruction is the last possible flag writer. */
    cut_get(cut, CUT_RIGHT); cut_op(cut, 0x50u); cut_op(cut, 0x45u);
    cut_op(cut, 0x04u); cut_op(cut, 0x40u);
    if (wanted & (1u | 0x800u)) carry(cut, width, kind);
    cut_arithmetic_flags(cut, width, 0, 1, 0);
    cut_get(cut, CUT_FLAGS);
    if (wanted & 1u) { cut_get(cut, CUT_NEXT); cut_op(cut, 0x84u); }
    if ((wanted & 0x800u) && kind != 7u) {
        cut_get(cut, kind == 4u ? CUT_VALUE : CUT_LEFT);
        cut_const(cut, width - 1u); cut_op(cut, 0x88u);
        if (kind == 4u) { cut_get(cut, CUT_NEXT); cut_op(cut, 0x85u); }
        cut_const(cut, 1u); cut_op(cut, 0x83u);
        cut_const(cut, 0u); cut_get(cut, CUT_RIGHT); cut_const(cut, 1u);
        cut_op(cut, 0x51u); cut_op(cut, 0x1bu);
        cut_const(cut, 11u); cut_op(cut, 0x86u); cut_op(cut, 0x84u);
    }
    /* Undefined AF and multi-bit OF are deterministically zero. */
    cut_set(cut, CUT_FLAGS); cut_op(cut, 0x0bu);
    cut->report.flags_written = 1u;
}

static void rotate_flags(cut_lowering *cut, pl_u32 width, pl_u32 kind)
{
    pl_u32 wanted=cut->wanted_flags&0x801u;
    if (!wanted) return;
    /* Use the masked count, not count modulo width: a nonzero whole-word
     * turn updates CF even though its result equals the incoming value. */
    cut_get(cut,CUT_RIGHT); cut_op(cut,0x50u); cut_op(cut,0x45u);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_get(cut,CUT_FLAGS); cut_const(cut,~(pl_u64)wanted); cut_op(cut,0x83u);
    if (wanted&1u) {
        cut_get(cut,CUT_VALUE);
        if (kind) { cut_const(cut,width-1u); cut_op(cut,0x88u); }
        cut_const(cut,1u); cut_op(cut,0x83u); cut_op(cut,0x84u);
    }
    if (wanted&0x800u) {
        cut_get(cut,CUT_VALUE); cut_const(cut,width-1u); cut_op(cut,0x88u);
        cut_get(cut,CUT_VALUE);
        if (kind) { cut_const(cut,width-2u); cut_op(cut,0x88u); }
        cut_op(cut,0x85u); cut_const(cut,1u); cut_op(cut,0x83u);
        cut_const(cut,0u); cut_get(cut,CUT_RIGHT); cut_const(cut,1u);
        cut_op(cut,0x51u); cut_op(cut,0x1bu);
        cut_const(cut,11u); cut_op(cut,0x86u); cut_op(cut,0x84u);
    }
    /* SF/ZF/AF/PF are unchanged. Multi-bit OF chooses zero; count zero
     * preserves every flag, including definitions earlier in this slice. */
    cut_set(cut,CUT_FLAGS); cut_op(cut,0x0bu);
    cut->report.flags_written=1u;
}

static void rotate_value(cut_lowering *cut, pl_u32 width, pl_u32 kind)
{
    cut_get(cut,CUT_LEFT);
    if (width==32u) {
        cut_op(cut,0xa7u); cut_get(cut,CUT_RIGHT); cut_op(cut,0xa7u);
        cut_op(cut,kind ? 0x78u : 0x77u); cut_op(cut,0xadu);
    } else {
        if (width<32u) {
            /* K = sum_j 2^(j*w). Masked x*K repeats the w-bit word without
             * carry. Its period is w, so one 64-bit rotate projects exactly
             * to rotate_w(x,count); no bit loop or second count is needed. */
            cut_const(cut,width==8u ? 0x0101010101010101ull : 0x0001000100010001ull);
            cut_op(cut,0x7eu);
        }
        cut_get(cut,CUT_RIGHT); cut_op(cut,kind ? 0x8au : 0x89u);
    }
    cut_mask(cut,width); cut_set(cut,CUT_VALUE);
    rotate_flags(cut,width,kind);
}

void cut_shift_count(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    cut_read_operand(cut, &instruction->operands[1], 8u);
    cut_const(cut, instruction->operands[0].bits == 64u ? 63u : 31u); cut_op(cut, 0x83u);
}

void cut_shift_value(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    pl_u32 width = instruction->operands[0].bits, kind = instruction->condition;
    if (kind<2u) {
        rotate_value(cut,width,kind);
        return;
    }
    cut_get(cut, CUT_LEFT);
    if (kind == 7u && width < 64u) {
        cut_const(cut, 64u - width); cut_op(cut, 0x86u);
        cut_const(cut, 64u - width); cut_op(cut, 0x87u);
    }
    cut_get(cut, CUT_RIGHT);
    cut_op(cut, kind == 4u ? 0x86u : kind == 5u ? 0x88u : 0x87u);
    cut_mask(cut, width); cut_set(cut, CUT_VALUE);
    flags(cut, width, kind);
}

void cut_lower_shift(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    /* Capture both inputs before a destination such as CL/CH changes RCX. */
    cut_read_operand(cut, &operands[0], operands[0].bits); cut_set(cut, CUT_LEFT);
    cut_shift_count(cut,instruction); cut_set(cut, CUT_RIGHT);
    cut_shift_value(cut,instruction);
    cut_write_register(cut, &operands[0].value.reg);
}
