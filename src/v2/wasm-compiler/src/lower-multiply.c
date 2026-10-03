#include "cut-internal.h"

int cut_multiply_supported(const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    pl_u32 count = instruction->visible_operand_count, width = operands[0].bits;
    if (instruction->operation != PL_X86_OPERATION_MULTIPLY_SIGNED
            || (count != 2u && count != 3u) || (width != 16u && width != 32u && width != 64u)
            || operands[0].kind != PL_X86_OPERAND_REGISTER || !cut_gpr(&operands[0].value.reg)
            || (operands[1].kind != PL_X86_OPERAND_MEMORY
                && (operands[1].kind != PL_X86_OPERAND_REGISTER || !cut_gpr(&operands[1].value.reg)))
            || operands[1].bits != width) return 0;
    return count == 2u || operands[2].kind == PL_X86_OPERAND_IMMEDIATE;
}

static void signed_value(cut_lowering *cut, pl_u32 local, pl_u32 width)
{
    cut_get(cut,local);
    if (width < 64u) {
        cut_const(cut,64u - width); cut_op(cut,0x86u);
        cut_const(cut,64u - width); cut_op(cut,0x87u);
    }
}

static void limb(cut_lowering *cut, pl_u32 local, int high)
{
    cut_get(cut,local);
    if (high) { cut_const(cut,32u); cut_op(cut,0x88u); }
    else cut_mask(cut,32u);
}

static void signed_high(cut_lowering *cut)
{
    /* Let a=a0+2^32*a1, b=b0+2^32*b1, and t=(a0*b0>>32)+a1*b0.
     * hi_u=a1*b1+(t>>32)+((a0*b1+(t mod 2^32))>>32).
     * Both t and the second sum fit u64. Signed high subtracts b for a<0
     * and a for b<0. Every step is defined modular i64, without division,
     * floating point, i128, a host import or an overflowing C expression. */
    limb(cut,CUT_LEFT,1); limb(cut,CUT_RIGHT,1); cut_op(cut,0x7eu);
    limb(cut,CUT_LEFT,0); limb(cut,CUT_RIGHT,0); cut_op(cut,0x7eu);
    cut_const(cut,32u); cut_op(cut,0x88u);
    limb(cut,CUT_LEFT,1); limb(cut,CUT_RIGHT,0); cut_op(cut,0x7eu); cut_op(cut,0x7cu);
    cut_set(cut,CUT_NEXT);
    cut_get(cut,CUT_NEXT); cut_const(cut,32u); cut_op(cut,0x88u); cut_op(cut,0x7cu);
    limb(cut,CUT_LEFT,0); limb(cut,CUT_RIGHT,1); cut_op(cut,0x7eu);
    cut_get(cut,CUT_NEXT); cut_mask(cut,32u); cut_op(cut,0x7cu);
    cut_const(cut,32u); cut_op(cut,0x88u); cut_op(cut,0x7cu);
    cut_get(cut,CUT_LEFT); cut_const(cut,63u); cut_op(cut,0x87u);
    cut_get(cut,CUT_RIGHT); cut_op(cut,0x83u); cut_op(cut,0x7du);
    cut_get(cut,CUT_RIGHT); cut_const(cut,63u); cut_op(cut,0x87u);
    cut_get(cut,CUT_LEFT); cut_op(cut,0x83u); cut_op(cut,0x7du);
}

void cut_multiply_value(cut_lowering *cut, pl_u32 width)
{
    cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); cut_op(cut,0x7eu);
    cut_mask(cut,width); cut_set(cut,CUT_VALUE);
    pl_u32 wanted = cut->wanted_flags & 0x801u;
    if (wanted) {
        cut_get(cut,CUT_FLAGS); cut_const(cut,~(pl_u64)wanted); cut_op(cut,0x83u);
        if (width < 64u) {
            signed_value(cut,CUT_LEFT,width); signed_value(cut,CUT_RIGHT,width); cut_op(cut,0x7eu);
            signed_value(cut,CUT_VALUE,width);
        } else {
            signed_high(cut);
            cut_get(cut,CUT_VALUE); cut_const(cut,63u); cut_op(cut,0x87u);
        }
        // CF=OF precisely when the full signed product is not sign-extension
        // of the truncated result. SF/ZF/AF/PF are undefined and stay chosen.
        cut_op(cut,0x52u); cut_op(cut,0xadu);
        cut_const(cut,wanted); cut_op(cut,0x7eu); cut_op(cut,0x84u);
        cut_set(cut,CUT_FLAGS); cut->report.flags_written = 1u;
    }
}

void cut_lower_multiply(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    pl_u32 count = instruction->visible_operand_count, width = operands[0].bits;
    // Read both sources before publishing any aliased or narrow destination.
    cut_read_operand(cut,&operands[count == 2u ? 0u : 1u],width); cut_set(cut,CUT_LEFT);
    cut_read_operand(cut,&operands[count - 1u],width); cut_set(cut,CUT_RIGHT);
    cut_multiply_value(cut,width);
    cut_write_register(cut,&operands[0].value.reg);
}
