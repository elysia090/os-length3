#include "cut-internal.h"

int cut_fxsave_supported(const pl_x86_instruction *instruction)
{
    return instruction->status==PL_X86_DECODE_VALID && instruction->flow==PL_X86_FLOW_NEXT
        && instruction->machine_operation==PL_X86_MACHINE_X87
        && (instruction->machine_argument==PL_X86_X87_STATE_IMAGE
            || instruction->machine_argument==(PL_X86_X87_STATE_IMAGE|(1ull<<44u)))
        && instruction->visible_operand_count==1u
        && instruction->operands[0].kind==PL_X86_OPERAND_MEMORY
        && instruction->operands[0].bits==4096u
        && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
            |PL_X86_INSTRUCTION_TRAP_AFTER))
        && (instruction->address_width==32u || instruction->address_width==64u)
        && cut_memory_address_supported(instruction,&instruction->operands[0].value.memory);
}

static void output(cut_lowering *cut,pl_u32 offset)
{
    cut_set(cut,CUT_VALUE);
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_const(cut,offset); cut_op(cut,0xa7u);
    cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,8u);
    cut_get(cut,CUT_VALUE); cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,1u);
    cut_access_status(cut);
}

static void physical_register(cut_lowering *cut,pl_u32 rank,pl_u32 offset,pl_u32 shift,pl_u32 opcode)
{
    /* ST(i) is physical R[(TOP+i) mod 8]. No array rotation/materialization. */
    cut_get(cut,0u); cut_get(cut,CUT_LEFT); cut_const(cut,rank); cut_op(cut,0x7cu);
    cut_const(cut,7u); cut_op(cut,0x83u); cut_const(cut,shift); cut_op(cut,0x86u);
    cut_op(cut,0xa7u); cut_op(cut,0x6au); cut_op(cut,opcode);
    wasm_writer_uleb(cut->writer,shift); wasm_writer_uleb(cut->writer,offset);
}

void cut_lower_fxsave(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    const pl_x86_memory *address=&instruction->operands[0].value.memory;
    int wide=!!(instruction->machine_argument&(1ull<<44u));
    /* This profile advertises FXSR. Both EM and TS cause #NM, independent
     * of pending x87 exceptions. No FPU or payload state changes before it. */
    cut_load(cut,offsetof(machine_state,cr0)); cut_const(cut,12u); cut_op(cut,0x83u);
    cut_op(cut,0x50u); cut_op(cut,0x45u); cut_op(cut,0x04u); cut_op(cut,0x40u);
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_load(cut,offsetof(machine_state,rip)); cut_op(cut,0x37u); wasm_writer_uleb(cut->writer,3u);
    wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_address));
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u); cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,7u);
    cut_op(cut,0x36u); wasm_writer_uleb(cut->writer,2u); wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_vector));
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u); cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,0u);
    cut_op(cut,0x36u); wasm_writer_uleb(cut->writer,2u); wasm_writer_uleb(cut->writer,offsetof(machine_memory_port,fault_error));
    cut_const(cut,machine_result_make(MACHINE_RESULT_FAULT,7u)); cut_op(cut,0x0fu); cut_op(cut,0x0bu);
    cut->report.memory_bytes=512u;
    cut->report.memory_access=MACHINE_MEMORY_WRITE;
    if(address->segment.class_id==PL_X86_REGISTER_SEGMENT && address->segment.index==2u)
        cut->report.memory_access|=MACHINE_MEMORY_STACK;
    cut_effective_address(cut,instruction,address); cut_set(cut,CUT_ADDRESS);
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u); cut_get(cut,CUT_ADDRESS);
    cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,512u);
    cut_op(cut,0x41u); wasm_writer_uleb(cut->writer,cut->report.memory_access|MACHINE_MEMORY_ALIGNED16);
    cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,0u); cut_access_status(cut);

    cut_const(cut,0u); cut_set(cut,CUT_RIGHT);
    for(pl_u32 rank=0u;rank<8u;++rank) {
        cut_get(cut,CUT_RIGHT); cut_load(cut,offsetof(machine_state,x87_tag));
        cut_const(cut,rank*2u); cut_op(cut,0x88u); cut_const(cut,3u); cut_op(cut,0x83u);
        cut_const(cut,3u); cut_op(cut,0x52u); cut_op(cut,0xadu);
        cut_const(cut,rank+32u); cut_op(cut,0x86u); cut_op(cut,0x84u); cut_set(cut,CUT_RIGHT);
    }
    cut_load(cut,offsetof(machine_state,x87_control)); cut_const(cut,0xffffffffull); cut_op(cut,0x83u);
    cut_get(cut,CUT_RIGHT); cut_op(cut,0x84u);
    cut_load(cut,offsetof(machine_state,x87_opcode)); cut_const(cut,0x7ffu); cut_op(cut,0x83u);
    cut_const(cut,48u); cut_op(cut,0x86u); cut_op(cut,0x84u); output(cut,0u);
    cut_load(cut,offsetof(machine_state,x87_ip)); if(!wide)cut_mask(cut,32u); output(cut,8u);
    cut_load(cut,offsetof(machine_state,x87_dp)); if(!wide)cut_mask(cut,32u); output(cut,16u);
    /* Full XMM/MXCSR save is the chosen OSFXSR=0 implementation too. DAZ is
     * supported in this fixed profile, hence MXCSR_MASK = 0x0000ffff. */
    cut_load(cut,offsetof(machine_state,mxcsr)); cut_mask(cut,32u);
    cut_const(cut,0xffffull<<32u); cut_op(cut,0x84u); output(cut,24u);
    cut_load(cut,offsetof(machine_state,x87_status)); cut_const(cut,11u); cut_op(cut,0x88u);
    cut_const(cut,7u); cut_op(cut,0x83u); cut_set(cut,CUT_LEFT);
    for(pl_u32 rank=0u;rank<8u;++rank) {
        physical_register(cut,rank,offsetof(machine_state,x87_significand),3u,0x29u); output(cut,32u+rank*16u);
        physical_register(cut,rank,offsetof(machine_state,x87_sign_exponent),1u,0x33u); output(cut,40u+rank*16u);
    }
    for(pl_u32 rank=0u;rank<MACHINE_X86_XMM_WORDS;++rank) {
        cut_load(cut,offsetof(machine_state,xmm)+rank*8u); output(cut,160u+rank*8u);
    }
    /* Chosen reserved fields inside 0..415 are zero; 416..511 remain
     * untouched, including the architecturally software-owned 464..511. */
    cut_op(cut,0x20u); wasm_writer_uleb(cut->writer,1u);
    cut_op(cut,0x10u); wasm_writer_uleb(cut->writer,2u); cut_access_status(cut);
}
