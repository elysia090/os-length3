#include "cut-internal.h"

void cut_lower_summary(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_u32 width=instruction->operands[0].bits, kind=instruction->condition;
    int scan=kind<2u;
    cut_read_operand(cut,&instruction->operands[1],width); cut_set(cut,CUT_LEFT);
    if (scan) {
        /* Zero-source scans leave the destination undefined. Choose its
         * incoming whole-parent representative, including 32-bit high bits;
         * do not claim that CPU-dependent value is a defined native result. */
        pl_x86_operand previous=instruction->operands[0];
        previous.bits=64u; previous.value.reg.bits=64u;
        cut_read_operand(cut,&previous,64u); cut_set(cut,CUT_RIGHT);
    }
    if (!kind) cut_const(cut,63u);
    cut_get(cut,CUT_LEFT); cut_op(cut,kind==0u ? 0x79u : kind==1u ? 0x7au : 0x7bu);
    if (!kind) cut_op(cut,0x7du); /* BSR = 63 - clz(masked source). */
    cut_set(cut,CUT_VALUE); cut_write_register(cut,&instruction->operands[0].value.reg);
    if (scan) {
        /* Select the old parent only for zero, without a branch or a local
         * that was initialized only along the nonzero control arm. */
        cut_get(cut,CUT_RIGHT); cut_get(cut,instruction->operands[0].value.reg.index+1u);
        cut_get(cut,CUT_LEFT); cut_op(cut,0x50u); cut_op(cut,0x1bu);
        cut_set(cut,instruction->operands[0].value.reg.index+1u);
    }
    pl_u32 flags=scan ? 0x40u : 0x8d5u;
    if (!(cut->wanted_flags&flags)) return;
    cut_get(cut,CUT_FLAGS); cut_const(cut,~(pl_u64)flags); cut_op(cut,0x83u);
    cut_get(cut,CUT_LEFT); cut_op(cut,0x50u); cut_op(cut,0xadu);
    cut_const(cut,6u); cut_op(cut,0x86u); cut_op(cut,0x84u);
    cut_set(cut,CUT_FLAGS); cut->report.flags_written=1u;
}
