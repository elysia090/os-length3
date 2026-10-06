#include "cut-internal.h"

void cut_lower_register_update(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_x86_register_update law;
    if(!pl_x86_register_update_lower(instruction,&law)){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    const pl_x86_operand *destination=&instruction->operands[0],*source=&instruction->operands[1];
    pl_x86_operand accumulator={0};accumulator.kind=PL_X86_OPERAND_REGISTER;accumulator.bits=law.bits;
    accumulator.value.reg=(pl_x86_register){.class_id=PL_X86_REGISTER_GPR,.bits=law.bits};
    if(law.compare){
        /* Seed every parent before either conditional arm. Static load sharing
         * must not make the other arm read an uninitialized Wasm local. */
        cut_read_operand(cut,&accumulator,law.bits);cut_set(cut,CUT_LEFT);
        cut_read_operand(cut,destination,law.bits);cut_set(cut,CUT_RIGHT);
        cut_read_operand(cut,source,law.bits);cut_op(cut,0x1au);
        cut_get(cut,CUT_LEFT);cut_get(cut,CUT_RIGHT);cut_op(cut,0x7du);
        cut_mask(cut,law.bits);cut_set(cut,CUT_VALUE);
        cut_arithmetic_flags(cut,law.bits,1,0,CUT_CARRY_NORMAL);
        cut_get(cut,CUT_LEFT);cut_get(cut,CUT_RIGHT);cut_op(cut,0x51u);
        cut_op(cut,0x04u);cut_op(cut,0x40u);
        cut_read_operand(cut,source,law.bits);cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&destination->value.reg);
        cut_op(cut,0x05u);
        cut_get(cut,CUT_RIGHT);cut_set(cut,CUT_VALUE);cut_write_register(cut,&accumulator.value.reg);
        cut_op(cut,0x0bu);
    }else{
        cut_read_operand(cut,destination,law.bits);cut_set(cut,CUT_LEFT);
        cut_read_operand(cut,source,law.bits);cut_set(cut,CUT_RIGHT);
        cut_get(cut,CUT_LEFT);cut_get(cut,CUT_RIGHT);cut_op(cut,0x7cu);
        cut_mask(cut,law.bits);cut_set(cut,CUT_VALUE);
        cut_arithmetic_flags(cut,law.bits,0,0,CUT_CARRY_NORMAL);
        cut_get(cut,CUT_VALUE);cut_set(cut,CUT_NEXT);
        if(destination->value.reg.index!=source->value.reg.index
                || destination->value.reg.flags!=source->value.reg.flags){
            cut_get(cut,CUT_LEFT);cut_set(cut,CUT_VALUE);cut_write_register(cut,&source->value.reg);
        }
        cut_get(cut,CUT_NEXT);cut_set(cut,CUT_VALUE);cut_write_register(cut,&destination->value.reg);
    }
}
