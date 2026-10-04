#include "cut-internal.h"

int cut_double_shift_supported(const pl_x86_instruction *instruction)
{
    const pl_x86_operand *destination=&instruction->operands[0],
        *source=&instruction->operands[1],*count=&instruction->operands[2];
    return instruction->operation==PL_X86_OPERATION_DOUBLE_SHIFT
        && instruction->visible_operand_count==3u && instruction->condition<2u
        && (destination->bits==16u || destination->bits==32u || destination->bits==64u)
        && source->kind==PL_X86_OPERAND_REGISTER && cut_gpr(&source->value.reg)
        && source->bits==destination->bits && source->value.reg.bits==source->bits
        && !source->value.reg.flags
        && (count->kind==PL_X86_OPERAND_IMMEDIATE
            || (count->kind==PL_X86_OPERAND_REGISTER && cut_gpr(&count->value.reg)
                && count->value.reg.index==1u && count->value.reg.bits==8u
                && !count->value.reg.flags));
}

static void flags(cut_lowering *cut,pl_u32 width,int right)
{
    pl_u32 wanted=cut->wanted_flags;
    if(!wanted)return;
    if(width==16u) {
        /* Beyond the operand width both value and arithmetic flags are
         * undefined. Zero is one representative; no defined flag is erased. */
        cut_get(cut,CUT_RIGHT);cut_const(cut,width);cut_op(cut,0x56u);
        cut_op(cut,0x04u);cut_op(cut,0x40u);
        cut_get(cut,CUT_FLAGS);cut_const(cut,~(pl_u64)wanted);cut_op(cut,0x83u);
        cut_set(cut,CUT_FLAGS);cut_op(cut,0x05u);
    }
    cut_arithmetic_flags(cut,width,0,1,0);
    cut_get(cut,CUT_FLAGS);
    if(wanted&1u) {
        cut_get(cut,CUT_LEFT);
        if(right) { cut_get(cut,CUT_RIGHT);cut_const(cut,1u);cut_op(cut,0x7du); }
        else { cut_const(cut,width);cut_get(cut,CUT_RIGHT);cut_op(cut,0x7du); }
        cut_op(cut,0x88u);cut_const(cut,1u);cut_op(cut,0x83u);cut_op(cut,0x84u);
    }
    if(wanted&0x800u) {
        /* OF for one bit is exactly old_sign XOR new_sign, on both sides. */
        cut_get(cut,CUT_LEFT);cut_get(cut,CUT_VALUE);cut_op(cut,0x85u);
        cut_const(cut,width-1u);cut_op(cut,0x88u);cut_const(cut,1u);cut_op(cut,0x83u);
        cut_const(cut,0u);cut_get(cut,CUT_RIGHT);cut_const(cut,1u);cut_op(cut,0x51u);cut_op(cut,0x1bu);
        cut_const(cut,11u);cut_op(cut,0x86u);cut_op(cut,0x84u);
    }
    cut_set(cut,CUT_FLAGS);
    if(width==16u)cut_op(cut,0x0bu);
    cut->report.flags_written=1u;
}

void cut_double_shift_value(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_u32 width=instruction->operands[0].bits;int right=instruction->condition!=0u;
    /* LEFT=old destination, NEXT=old source, RIGHT=masked count. All are
     * captured before an aliased register publication or C reservation. */
    cut_get(cut,CUT_LEFT);cut_set(cut,CUT_VALUE);
    cut_get(cut,CUT_RIGHT);cut_op(cut,0x50u);cut_op(cut,0x45u);
    cut_op(cut,0x04u);cut_op(cut,0x40u);
    if(width==16u) {
        /* The exact defined domain fits one 32-bit concatenation. This also
         * handles count==16 without a masked shift-by-width accident. */
        cut_get(cut,right?CUT_NEXT:CUT_LEFT);cut_const(cut,16u);cut_op(cut,0x86u);
        cut_get(cut,right?CUT_LEFT:CUT_NEXT);cut_op(cut,0x84u);
        cut_get(cut,CUT_RIGHT);cut_op(cut,right?0x88u:0x86u);
        if(!right) { cut_const(cut,16u);cut_op(cut,0x88u); }
        cut_const(cut,0u);cut_get(cut,CUT_RIGHT);cut_const(cut,width);cut_op(cut,0x58u);cut_op(cut,0x1bu);
    } else {
        cut_get(cut,CUT_LEFT);cut_get(cut,CUT_RIGHT);cut_op(cut,right?0x88u:0x86u);
        cut_get(cut,CUT_NEXT);cut_const(cut,width);cut_get(cut,CUT_RIGHT);cut_op(cut,0x7du);
        cut_op(cut,right?0x86u:0x88u);cut_op(cut,0x84u);
    }
    cut_mask(cut,width);cut_set(cut,CUT_VALUE);
    flags(cut,width,right);cut_op(cut,0x0bu);
}

void cut_lower_double_shift(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    cut_read_operand(cut,&instruction->operands[0],instruction->operands[0].bits);cut_set(cut,CUT_LEFT);
    cut_read_operand(cut,&instruction->operands[1],instruction->operands[0].bits);cut_set(cut,CUT_NEXT);
    cut_shift_count(cut,instruction);cut_set(cut,CUT_RIGHT);
    cut_double_shift_value(cut,instruction);
    cut_write_register(cut,&instruction->operands[0].value.reg);
}
