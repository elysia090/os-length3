#include "cut-internal.h"

int cut_multiply_supported(const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operands = instruction->operands;
    pl_u32 count = instruction->visible_operand_count, width = operands[0].bits;
    int signed_product = instruction->operation == PL_X86_OPERATION_MULTIPLY_SIGNED;
    if (!signed_product && instruction->operation != PL_X86_OPERATION_MULTIPLY_UNSIGNED) return 0;
    if (count == 1u)
        return (width == 8u || width == 16u || width == 32u || width == 64u)
            && (operands[0].kind == PL_X86_OPERAND_MEMORY
                || (operands[0].kind == PL_X86_OPERAND_REGISTER && cut_gpr(&operands[0].value.reg)));
    if (!signed_product
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

static void unsigned_high(cut_lowering *cut)
{
    /* Let a=a0+2^32*a1, b=b0+2^32*b1, and t=(a0*b0>>32)+a1*b0.
     * hi_u=a1*b1+(t>>32)+((a0*b1+(t mod 2^32))>>32).
     * Both t and the second sum fit u64. Every step is defined modular i64, without division,
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
}

static void signed_high(cut_lowering *cut)
{
    /* Two's-complement signed high is hi_u-[a<0]*b-[b<0]*a mod 2^64. */
    unsigned_high(cut);
    cut_get(cut,CUT_LEFT); cut_const(cut,63u); cut_op(cut,0x87u);
    cut_get(cut,CUT_RIGHT); cut_op(cut,0x83u); cut_op(cut,0x7du);
    cut_get(cut,CUT_RIGHT); cut_const(cut,63u); cut_op(cut,0x87u);
    cut_get(cut,CUT_LEFT); cut_op(cut,0x83u); cut_op(cut,0x7du);
}

void cut_implicit_multiply_value(cut_lowering *cut, pl_u32 width, int signed_product)
{
    /* LEFT and RIGHT already snapshot the implicit accumulator and source.
     * Keep both product halves local until a successful read can retire. */
    if (signed_product && width < 64u) {
        signed_value(cut,CUT_LEFT,width); signed_value(cut,CUT_RIGHT,width);
    } else { cut_get(cut,CUT_LEFT); cut_get(cut,CUT_RIGHT); }
    cut_op(cut,0x7eu); cut_set(cut,CUT_NEXT);
    cut_get(cut,CUT_NEXT); cut_mask(cut,width); cut_set(cut,CUT_VALUE);
    if (width < 64u) {
        cut_get(cut,CUT_NEXT); cut_const(cut,width); cut_op(cut,0x88u); cut_mask(cut,width);
    } else if (signed_product) signed_high(cut);
    else unsigned_high(cut);
    cut_set(cut,CUT_NEXT);
    pl_u32 wanted=cut->wanted_flags & 0x801u;
    if (wanted) {
        cut_get(cut,CUT_FLAGS); cut_const(cut,~(pl_u64)wanted); cut_op(cut,0x83u);
        cut_get(cut,CUT_NEXT);
        /* CF=OF iff high is nonzero (unsigned), or differs from the
         * width-bit sign mask of low (signed). Undefined flags stay chosen. */
        if (signed_product) {
            signed_value(cut,CUT_VALUE,width); cut_const(cut,63u); cut_op(cut,0x87u); cut_mask(cut,width);
        } else cut_const(cut,0u);
        cut_op(cut,0x52u); cut_op(cut,0xadu);
        cut_const(cut,wanted); cut_op(cut,0x7eu); cut_op(cut,0x84u);
        cut_set(cut,CUT_FLAGS); cut->report.flags_written=1u;
    }
    pl_x86_register destination={0}; destination.class_id=PL_X86_REGISTER_GPR;
    /* Byte products replace AX, not just AL. Word publications preserve the
     * upper parent; dword publications zero it; qword publications replace it. */
    destination.bits=(pl_u16)(width == 8u ? 16u : width);
    if (width == 8u) {
        cut_get(cut,CUT_VALUE); cut_get(cut,CUT_NEXT); cut_const(cut,8u); cut_op(cut,0x86u);
        cut_op(cut,0x84u); cut_set(cut,CUT_VALUE);
    }
    cut_write_register(cut,&destination);
    if (width > 8u) {
        cut_get(cut,CUT_NEXT); cut_set(cut,CUT_VALUE); destination.index=2u;
        cut_write_register(cut,&destination);
    }
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
    if (count == 1u) {
        cut_read_operand(cut,&operands[0],width); cut_set(cut,CUT_RIGHT);
        pl_x86_operand acc={0}; acc.kind=PL_X86_OPERAND_REGISTER; acc.bits=(pl_u16)width;
        acc.value.reg.class_id=PL_X86_REGISTER_GPR; acc.value.reg.bits=(pl_u16)width;
        cut_read_operand(cut,&acc,width); cut_set(cut,CUT_LEFT);
        cut_implicit_multiply_value(cut,width,instruction->operation == PL_X86_OPERATION_MULTIPLY_SIGNED);
        return;
    }
    // Read both sources before publishing any aliased or narrow destination.
    cut_read_operand(cut,&operands[count == 2u ? 0u : 1u],width); cut_set(cut,CUT_LEFT);
    cut_read_operand(cut,&operands[count - 1u],width); cut_set(cut,CUT_RIGHT);
    cut_multiply_value(cut,width);
    cut_write_register(cut,&operands[0].value.reg);
}
