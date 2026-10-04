#include "cut-internal.h"

int cut_mxcsr_supported(const pl_x86_instruction *instruction)
{
    return instruction->status==PL_X86_DECODE_VALID && instruction->flow==PL_X86_FLOW_NEXT
        && instruction->machine_operation==PL_X86_MACHINE_VECTOR
        && (instruction->machine_argument==(PL_X86_VECTOR_MXCSR|(1ull<<24u))
            || instruction->machine_argument==(PL_X86_VECTOR_MXCSR|(1ull<<25u)))
        && instruction->visible_operand_count==1u
        && instruction->operands[0].kind==PL_X86_OPERAND_MEMORY
        && instruction->operands[0].bits==32u
        && !(instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_TRAP_AFTER))
        && (instruction->address_width==32u || instruction->address_width==64u)
        && cut_memory_address_supported(instruction,&instruction->operands[0].value.memory);
}

static void fault_if(cut_lowering *cut,pl_u32 vector)
{
    cut_op(cut,0x04u);cut_op(cut,0x40u);
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
    cut_load(cut,offsetof(machine_state,rip));cut_op(cut,0x37u);
    wasm_writer_uleb(cut->writer,3u);wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_address));
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
    cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,vector);cut_op(cut,0x36u);
    wasm_writer_uleb(cut->writer,2u);wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_vector));
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
    cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,0u);cut_op(cut,0x36u);
    wasm_writer_uleb(cut->writer,2u);wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_error));
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,vector));cut_op(cut,0x0fu);cut_op(cut,0x0bu);
}

void cut_lower_mxcsr(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    int store=!!(instruction->machine_argument&(1ull<<25u));
    const pl_x86_memory *address=&instruction->operands[0].value.memory;
    /* SSE is fixed by the CPU profile. #UD precedes #NM and operand access;
     * OSFXSR=0 is not the implementation-dependent FXSAVE case. */
    cut_load(cut,offsetof(machine_state,cr0));cut_const(cut,4u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x45u);
    cut_load(cut,offsetof(machine_state,cr4));cut_const(cut,512u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x72u);fault_if(cut,6u);
    cut_load(cut,offsetof(machine_state,cr0));cut_const(cut,8u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x45u);fault_if(cut,7u);
    cut_effective_address(cut,instruction,address);cut_set(cut,CUT_ADDRESS);
    cut->report.memory_access=store?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ;
    if(address->segment.class_id==PL_X86_REGISTER_SEGMENT && address->segment.index==2u)
        cut->report.memory_access|=MACHINE_MEMORY_STACK;
    if(store) {
        cut_get(cut,0u);cut_op(cut,0x35u);wasm_writer_uleb(cut->writer,2u);
        wasm_writer_uleb(cut->writer,offsetof(machine_state,mxcsr));
    } else cut_const(cut,0u);
    cut_set(cut,CUT_VALUE);cut_access(cut);
    if(!store) {
        cut_access_value(cut);cut_set(cut,CUT_VALUE);
        /* The fixed DAZ-capable profile uses mask 0xffff. Check after the
         * complete read: operand #PF/wait precedes reserved-bit #GP. No SIMD
         * exception is raised merely by installing status/unmasked bits. */
        cut_get(cut,CUT_VALUE);cut_const(cut,0xffff0000u);cut_op(cut,0x83u);
        cut_op(cut,0x50u);cut_op(cut,0x45u);fault_if(cut,13u);
        /* A narrow store preserves adjacent msr_count and msr_keys fields. */
        cut_get(cut,0u);cut_get(cut,CUT_VALUE);cut_op(cut,0x3eu);
        wasm_writer_uleb(cut->writer,2u);wasm_writer_uleb(cut->writer,offsetof(machine_state,mxcsr));
    }
}
