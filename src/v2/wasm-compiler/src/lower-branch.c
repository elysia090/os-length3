#include "cut-internal.h"

static int canonical(pl_u64 value)
{ return value >> 47u == 0u || value >> 47u == 0x1ffffu; }

void cut_lower_counter_branch(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_x86_count_branch law;
    if(!pl_x86_count_branch_lower(instruction,&law) || law.bits==16u){cut->writer->error=WASM_COMPILER_ERROR_GRAMMAR;return;}
    pl_x86_operand counter={0};counter.kind=PL_X86_OPERAND_REGISTER;counter.bits=law.bits;
    counter.value.reg=(pl_x86_register){.class_id=PL_X86_REGISTER_GPR,.index=1u,.bits=law.bits};
    cut_read_operand(cut,&counter,law.bits);
    if(law.decrement){
        cut_const(cut,1u);cut_op(cut,0x7du);cut_mask(cut,law.bits);
        cut_set(cut,2u);cut->report.written_registers|=2u;cut_get(cut,2u);
    }
    cut_op(cut,0x50u); /* count == 0, i32 */
    if(law.decrement)cut_op(cut,0x45u);
    if(law.zero_flag){
        cut_get(cut,CUT_FLAGS);cut_const(cut,0x40u);cut_op(cut,0x83u);cut_op(cut,0x50u);
        if(law.zero_flag==1u)cut_op(cut,0x45u);
        cut_op(cut,0x71u);
    }
    cut_op(cut,0xadu);cut_set(cut,CUT_RIGHT);
    cut_coordinate(cut,instruction->fallthrough);cut_set(cut,CUT_NEXT);
    cut_get(cut,CUT_RIGHT);cut_op(cut,0x50u);cut_op(cut,0x45u);
    cut_op(cut,0x04u);cut_op(cut,0x40u);
    if(cut->operand_binding_kind==CUT_BIND_CONTROL_DISPLACEMENT){
        cut_coordinate(cut,instruction->fallthrough);cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,3u);
        cut_op(cut,0xacu);cut_op(cut,0x7cu);
    }else cut_coordinate(cut,instruction->target);
    cut_set(cut,CUT_LEFT);cut_reject_target(cut);cut_get(cut,CUT_LEFT);cut_set(cut,CUT_NEXT);
    cut_op(cut,0x0bu);
}

int cut_indirect_supported(const pl_x86_instruction *instruction)
{
    int call = instruction->operation == PL_X86_OPERATION_CALL && instruction->flow == PL_X86_FLOW_CALL;
    if (instruction->status != PL_X86_DECODE_VALID
            || (!call && (instruction->operation != PL_X86_OPERATION_BRANCH || instruction->flow != PL_X86_FLOW_JUMP))
            || instruction->machine_operation != PL_X86_MACHINE_NONE
            || !(instruction->flags & PL_X86_INSTRUCTION_INDIRECT)
            || instruction->flags & (PL_X86_INSTRUCTION_DIRECT_TARGET | PL_X86_INSTRUCTION_LOCKED
                | PL_X86_INSTRUCTION_PRIVILEGED | PL_X86_INSTRUCTION_REPEATED | PL_X86_INSTRUCTION_TRAP_AFTER)
            || instruction->visible_operand_count != 1u || instruction->operand_width != 64u
            || !canonical(instruction->rip) || !canonical(instruction->fallthrough)) return 0;
    const pl_x86_operand *operand = instruction->operands;
    if (operand->kind == PL_X86_OPERAND_REGISTER)
        return cut_gpr(&operand->value.reg) && operand->value.reg.bits == 64u;
    if (operand->kind != PL_X86_OPERAND_MEMORY || operand->bits != 64u
            || (instruction->address_width != 32u && instruction->address_width != 64u)) return 0;
    const pl_x86_memory *address = &operand->value.memory;
    return (address->segment.class_id == PL_X86_REGISTER_NONE
            || (address->segment.class_id == PL_X86_REGISTER_SEGMENT && address->segment.index < 6u))
        && (address->base.class_id == PL_X86_REGISTER_NONE || address->base.class_id == PL_X86_REGISTER_IP
            || cut_gpr(&address->base))
        && (address->index.class_id == PL_X86_REGISTER_NONE || cut_gpr(&address->index))
        && (!address->scale || address->scale == 1u || address->scale == 2u
            || address->scale == 4u || address->scale == 8u);
}

/* Target is in LEFT. A pending #GP is not exception delivery or CR2.
 * Port/state reservations have already been checked. No CPU publication
 * precedes this check. CALL's return-address payload store does precede it:
 * a target #GP retains that store but never publishes the new RSP/RIP. */
void cut_reject_target(cut_lowering *cut)
{
    cut_get(cut,CUT_LEFT); cut_const(cut,47u); cut_op(cut,0x88u); cut_op(cut,0x50u);
    cut_get(cut,CUT_LEFT); cut_const(cut,47u); cut_op(cut,0x88u);
    cut_const(cut,0x1ffffu); cut_op(cut,0x51u); cut_op(cut,0x72u); cut_op(cut,0x45u);
    cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_get(cut,CUT_LEFT); cut_op(cut,0x37u); wasm_writer_uleb(cut->writer,3u);
    wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_address));
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_const(cut,13u); cut_op(cut,0x37u); wasm_writer_uleb(cut->writer,3u);
    wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_vector));
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,13u)); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
}
void cut_lower_indirect(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    const pl_x86_operand *operand = instruction->operands;
    if (operand->kind == PL_X86_OPERAND_MEMORY) {
        cut_effective_address(cut,instruction,&operand->value.memory); cut_set(cut,CUT_ADDRESS);
        cut_const(cut,0u); cut_set(cut,CUT_VALUE);
        cut->report.memory_bytes = 8u; cut->report.memory_access = MACHINE_MEMORY_READ;
        cut->report.memory_access |= cut_memory_role(&operand->value.memory);
        cut_access(cut); cut_access_value(cut);
    } else cut_read_operand(cut,operand,64u);
    cut_set(cut,CUT_LEFT);
    pl_u32 target_access = cut->report.memory_access;
    if (instruction->operation == PL_X86_OPERATION_CALL)
        cut_lower_stack(cut,instruction); /* Uses old RSP after reading the target. */
    cut_reject_target(cut);
    cut_get(cut,CUT_LEFT); cut_set(cut,CUT_NEXT);
    cut->report.memory_access |= target_access;
}
