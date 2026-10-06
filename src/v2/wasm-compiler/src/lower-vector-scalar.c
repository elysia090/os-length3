#include "cut-internal.h"

static int vector(const pl_x86_operand *operand,pl_u32 width)
{
    return operand->kind==PL_X86_OPERAND_REGISTER
        && operand->value.reg.class_id==PL_X86_REGISTER_VECTOR
        && operand->value.reg.index<16u && operand->value.reg.bits==128u
        && !operand->value.reg.flags && (operand->bits==width || operand->bits==128u);
}
static int scalar(const pl_x86_operand *operand,pl_u32 width)
{
    return operand->bits==width && (operand->kind==PL_X86_OPERAND_MEMORY
        || (operand->kind==PL_X86_OPERAND_REGISTER && cut_gpr(&operand->value.reg)
            && operand->value.reg.bits==width && !operand->value.reg.flags));
}
int cut_vector_scalar_supported(const pl_x86_instruction *instruction)
{
    if(instruction->status!=PL_X86_DECODE_VALID || instruction->flow!=PL_X86_FLOW_NEXT
            || instruction->machine_operation!=PL_X86_MACHINE_VECTOR
            || instruction->visible_operand_count!=2u
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    pl_u32 kind=(pl_u32)(instruction->machine_argument&255u),width=kind==9u?32u:64u;
    const pl_x86_operand *target=&instruction->operands[0],*source=&instruction->operands[1];
    if(kind==39u)return vector(target,64u) && target->bits==128u && vector(source,64u)
        && instruction->machine_argument==(39u|((pl_u64)target->value.reg.index<<8u)
            |((pl_u64)source->value.reg.index<<16u)|(3ull<<32u));
    if(kind==14u) {
        int read=source->kind==PL_X86_OPERAND_MEMORY,write=target->kind==PL_X86_OPERAND_MEMORY;
        const pl_x86_operand *memory=read?source:target,*lane=read?target:source;
        if(read==write || memory->bits!=64u || !vector(lane,64u)
                || (instruction->address_width!=32u && instruction->address_width!=64u)
                || !cut_memory_address_supported(instruction,&memory->value.memory))return 0;
        pl_u64 high=instruction->machine_argument>>32u;
        if(high>1u)return 0;
        return instruction->machine_argument==(14u|((pl_u64)(read?lane->value.reg.index:0u)<<8u)
            |((pl_u64)(write?lane->value.reg.index:0u)<<16u)|((pl_u64)read<<24u)
            |((pl_u64)write<<25u)|(high<<32u));
    }
    if(kind!=9u && kind!=13u)return 0;
    int from=vector(source,width),to=vector(target,width);
    if(from==to || (from?!scalar(target,width):!scalar(source,width)))return 0;
    int read=source->kind==PL_X86_OPERAND_MEMORY,write=target->kind==PL_X86_OPERAND_MEMORY;
    const pl_x86_operand *operand=from?target:source;
    if((read || write) && ((instruction->address_width!=32u && instruction->address_width!=64u)
            || !cut_memory_address_supported(instruction,&operand->value.memory)))return 0;
    pl_u32 general=operand->kind==PL_X86_OPERAND_REGISTER?operand->value.reg.index:0u;
    pl_u64 argument=kind|((pl_u64)(to?target->value.reg.index:0u)<<8u)
        |((pl_u64)(from?source->value.reg.index:0u)<<16u)|((pl_u64)read<<24u)
        |((pl_u64)write<<25u)|((pl_u64)((pl_u32)from|(general<<1u))<<32u);
    return instruction->machine_argument==argument;
}

void cut_lower_vector_scalar(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_u32 width=(instruction->machine_argument&255u)==9u?32u:64u;
    int half=(instruction->machine_argument&255u)==14u;
    pl_u32 selected=half?(pl_u32)(instruction->machine_argument>>32u)*8u:0u;
    const pl_x86_operand *target=&instruction->operands[0],*source=&instruction->operands[1];
    int read=source->kind==PL_X86_OPERAND_MEMORY,write=target->kind==PL_X86_OPERAND_MEMORY;
    cut_sse_guard(cut);
    /* Only the low scalar is live. Capture it before touching an aliased XMM
     * destination or publishing any CPU state; 32-bit GPR output zero-extends. */
    if(read)cut_const(cut,0u);
    else if(vector(source,width)) {
        cut_load(cut,(pl_u32)offsetof(machine_state,xmm)+source->value.reg.index*16u+selected);
        cut_mask(cut,width);
    } else cut_read_operand(cut,source,width);
    cut_set(cut,CUT_VALUE);
    if(read || write) {
        const pl_x86_memory *memory=&instruction->operands[write?0u:1u].value.memory;
        cut_effective_address(cut,instruction,memory);cut_set(cut,CUT_ADDRESS);
        cut->report.memory_access=write?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ;
        cut->report.memory_access|=cut_memory_role(memory);
        /* A single precise 4/8-byte access, including cross-page preflight.
         * No 16-byte pair or intermediate SIMD record is needed here. */
        cut_access(cut);
        if(read) {cut_access_value(cut);cut_mask(cut,width);cut_set(cut,CUT_VALUE);}
    }
    if(vector(target,width)) {
        pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+target->value.reg.index*16u;
        /* A selected-half write leaves the other half resident and untouched.
         * No old-vector read, blend, second store or pair access is required. */
        cut_store(cut,offset+selected,CUT_VALUE);
        if(half)return;
        cut_const(cut,0u);cut_set(cut,CUT_RIGHT);
        cut_store(cut,offset+8u,CUT_RIGHT);
    } else if(!write)cut_write_register(cut,&target->value.reg);
}
