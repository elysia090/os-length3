#include "cut-internal.h"

static const pl_x86_memory *source_address(const pl_x86_instruction *instruction)
{
    for(pl_u32 rank=0u;rank<instruction->operand_count;++rank){
        const pl_x86_operand *operand=instruction->operands+rank;
        if(operand->kind==PL_X86_OPERAND_MEMORY
                && operand->value.memory.base.class_id==PL_X86_REGISTER_GPR
                && operand->value.memory.base.index==6u)return &operand->value.memory;
    }
    return NULL;
}

int cut_string_supported(const pl_x86_instruction *instruction)
{
    if(!(instruction->status == PL_X86_DECODE_VALID
        && instruction->operation == PL_X86_OPERATION_STRING
        && !(instruction->flags & (PL_X86_INSTRUCTION_LOCKED | PL_X86_INSTRUCTION_PRIVILEGED
                                   | PL_X86_INSTRUCTION_TRAP_AFTER))
        && (instruction->operand_width == 8u || instruction->operand_width == 16u
            || instruction->operand_width == 32u || instruction->operand_width == 64u)
        && (instruction->address_width == 32u || instruction->address_width == 64u)
        && (instruction->rip >> 47u == 0u || instruction->rip >> 47u == 0x1ffffu)
        && (instruction->fallthrough >> 47u == 0u || instruction->fallthrough >> 47u == 0x1ffffu)))return CUT_STRING_NONE;
    int repeated=!!(instruction->flags&PL_X86_INSTRUCTION_REPEATED);
    if(instruction->condition==0u){
        const pl_x86_memory *source=source_address(instruction);
        if(!source || !cut_memory_address_supported(instruction,source)
                || instruction->machine_operation!=(repeated?PL_X86_MACHINE_STRING:PL_X86_MACHINE_NONE))return CUT_STRING_NONE;
    }else if(instruction->condition!=1u || instruction->machine_operation!=PL_X86_MACHINE_NONE
            || instruction->flags&PL_X86_INSTRUCTION_REPEAT_WHILE_NOT_EQUAL)return CUT_STRING_NONE;
    return repeated?CUT_STRING_REPEAT:CUT_STRING_SINGLE;
}

void cut_repeat_frontier(cut_lowering *cut)
{
    const pl_u32 registers[] = {1u,6u,7u};
    for (pl_u32 rank = 0u; rank < 3u; ++rank)
        if (cut->report.written_registers & (1u << registers[rank]))
            cut_store(cut,offsetof(machine_state,registers) + registers[rank] * 8u,registers[rank] + 1u);
}

void cut_lower_string(cut_lowering *cut, const pl_x86_instruction *instruction)
{
    int store = instruction->condition == 1u;
    int repeated = !!(instruction->flags & PL_X86_INSTRUCTION_REPEATED);
    /* The exact frontier is known before the first possible partial return.
     * A store neither reads nor narrows/publishes RSI or RAX. */
    cut->report.written_registers |= (store ? 0x80u : 0xc0u) | (repeated ? 2u : 0u);
    const pl_u32 registers[] = {1u,6u,7u};
    for (pl_u32 rank = 0u; rank < 3u; ++rank) {
        if ((!repeated && registers[rank] == 1u) || (store && registers[rank] == 6u)) continue;
        pl_x86_operand operand = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
            .value.reg = {PL_X86_REGISTER_GPR, (pl_u8)registers[rank], 64u, 0u} };
        cut_read_operand(cut,&operand,64u); cut_op(cut,0x1au);
        if (instruction->address_width == 32u) {
            cut_get(cut,registers[rank] + 1u); cut_mask(cut,32u); cut_set(cut,registers[rank] + 1u);
        }
    }
    if (store) {
        const pl_x86_operand accumulator = { .kind = PL_X86_OPERAND_REGISTER, .bits = 64u,
            .value.reg = {PL_X86_REGISTER_GPR,0u,64u,0u} };
        cut_read_operand(cut,&accumulator,64u); cut_mask(cut,instruction->operand_width); cut_set(cut,CUT_LEFT);
    }
    pl_u32 bytes = instruction->operand_width / 8u, width = instruction->address_width;
    cut_const(cut,0u - (pl_u64)bytes); cut_const(cut,bytes);
    cut_get(cut,CUT_FLAGS); cut_const(cut,0x400u); cut_op(cut,0x83u); cut_op(cut,0xa7u);
    cut_op(cut,0x1bu); cut_set(cut,CUT_RIGHT); /* DF ? -bytes : bytes */
    if (repeated) {
        cut_const(cut,MACHINE_REPEAT_MAX_ELEMENTS); cut_set(cut,CUT_REPEAT_BUDGET);
        cut_op(cut,0x02u); cut_op(cut,0x40u); /* block */
        cut_op(cut,0x03u); cut_op(cut,0x40u); /* loop */
        cut_get(cut,2u); cut_mask(cut,width); cut_op(cut,0x50u);
        cut_op(cut,0x0du); wasm_writer_uleb(cut->writer,1u);
        cut_get(cut,CUT_REPEAT_BUDGET); cut_op(cut,0x50u);
        cut_op(cut,0x04u); cut_op(cut,0x40u);
        cut_repeat_frontier(cut);
        cut_const(cut,machine_result_make(MACHINE_RESULT_BARRIER,MACHINE_BARRIER_QUANTUM));
        cut_op(cut,0x0fu); cut_op(cut,0x0bu);
    }
    if (store) { cut_get(cut,CUT_LEFT); cut_set(cut,CUT_VALUE); }
    else {
        cut_get(cut,7u); cut_mask(cut,width); cut_set(cut,CUT_ADDRESS);
        cut_const(cut,0u); cut_set(cut,CUT_VALUE);
        const pl_x86_memory *source=source_address(instruction);
        cut->report.memory_access = MACHINE_MEMORY_READ;
        cut->report.memory_access|=cut_memory_role(source);
        cut_access(cut);
        cut_access_value(cut); cut_set(cut,CUT_VALUE);
    }
    cut_get(cut,8u); cut_mask(cut,width); cut_set(cut,CUT_ADDRESS);
    cut->report.memory_access = MACHINE_MEMORY_WRITE; cut_access(cut);
    /* A fault/miss commits no part of this element. Only REP publishes a
     * completed-element frontier on partial return. Without REP, RCX is
     * neither read nor written and faulting 32-bit pointers keep their old
     * parent values. Successful publication zero-extends the new pointers. */
    if (repeated) {
        cut_get(cut,2u); cut_const(cut,1u); cut_op(cut,0x7du); cut_mask(cut,width); cut_set(cut,2u);
    }
    for (pl_u32 local = store ? 8u : 7u; local <= 8u; ++local) {
        cut_get(cut,local); cut_get(cut,CUT_RIGHT); cut_op(cut,0x7cu);
        cut_mask(cut,width); cut_set(cut,local);
    }
    if (repeated) {
        cut_get(cut,CUT_REPEAT_BUDGET); cut_const(cut,1u); cut_op(cut,0x7du); cut_set(cut,CUT_REPEAT_BUDGET);
        cut_op(cut,0x0cu); wasm_writer_uleb(cut->writer,0u);
        cut_op(cut,0x0bu); cut_op(cut,0x0bu);
    }
    cut->report.memory_access = store ? MACHINE_MEMORY_WRITE : MACHINE_MEMORY_READ | MACHINE_MEMORY_WRITE;
    if(!store)cut->report.memory_access|=cut_memory_role(source_address(instruction));
}
