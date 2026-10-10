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
    pl_x86_vector_lane element;if(pl_x86_vector_lane_lower(instruction,&element))return !element.memory
        ||cut_memory_address_supported(instruction,&instruction->operands[element.insert?1u:0u].value.memory);
    pl_x86_vector_signmask mask;if(pl_x86_vector_signmask_lower(instruction,&mask))return 1;
    pl_x86_vector_extract extraction;if(pl_x86_vector_extract_lower(instruction,&extraction))return 1;
    pl_x86_scalar_vector_transfer transfer;
    if(pl_x86_scalar_vector_transfer_lower(instruction,&transfer))return !(transfer.source_memory||transfer.target_memory)
        ||cut_memory_address_supported(instruction,&instruction->operands[transfer.target_memory?0u:1u].value.memory);
    pl_x86_mmx_transfer mmx;
    if(pl_x86_mmx_transfer_lower(instruction,&mmx))return !(mmx.source_memory||mmx.target_memory)
        ||cut_memory_address_supported(instruction,&instruction->operands[mmx.target_memory?0u:1u].value.memory);
    if(instruction->status!=PL_X86_DECODE_VALID || instruction->flow!=PL_X86_FLOW_NEXT
            || instruction->machine_operation!=PL_X86_MACHINE_VECTOR
            || instruction->visible_operand_count!=2u
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    pl_u32 kind=(pl_u32)(instruction->machine_argument&255u),width=kind==9u?32u:64u;
    const pl_x86_operand *target=&instruction->operands[0],*source=&instruction->operands[1];
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
    pl_x86_vector_lane lane;if(pl_x86_vector_lane_lower(instruction,&lane)){cut_lower_vector_lane(cut,instruction,&lane);return;}
    pl_x86_vector_signmask mask;if(pl_x86_vector_signmask_lower(instruction,&mask)){
        if(mask.mmx){cut_mmx_guard(cut);cut_load(cut,offsetof(machine_state,x87_significand)+mask.source*8u);
            cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,0x12u);}
        else{cut_sse_guard(cut);cut_get(cut,0u);cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,0u);
            wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+mask.source*16u);}
        cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,mask.bytes==1u?0x64u:mask.bytes==4u?0xa4u:0xc4u);cut_op(cut,0xadu);
        if(mask.mmx)cut_mask(cut,8u);
        cut_set(cut,CUT_VALUE);cut_write_register(cut,&instruction->operands[0].value.reg);
        if(mask.mmx)cut_mmx_publish(cut,~0u);
        return;
    }
    pl_x86_vector_extract extraction;if(pl_x86_vector_extract_lower(instruction,&extraction)){
        if(extraction.mmx)cut_mmx_guard(cut);else cut_sse_guard(cut);
        pl_u32 base=extraction.mmx?offsetof(machine_state,x87_significand)+extraction.source*8u:offsetof(machine_state,xmm)+extraction.source*16u+(extraction.word/4u)*8u;
        cut_load(cut,base);cut_const(cut,(extraction.word&3u)*16u);cut_op(cut,0x88u);cut_mask(cut,16u);cut_set(cut,CUT_VALUE);
        cut_write_register(cut,&instruction->operands[0].value.reg);if(extraction.mmx)cut_mmx_publish(cut,~0u);return;
    }
    pl_x86_mmx_transfer law;int mmx=pl_x86_mmx_transfer_lower(instruction,&law);
    pl_x86_scalar_vector_transfer transfer;int scalar_lane=pl_x86_scalar_vector_transfer_lower(instruction,&transfer);
    pl_u32 width=scalar_lane?transfer.bytes*8u:mmx?law.bytes*8u:(instruction->machine_argument&255u)==9u?32u:64u;
    int half=(instruction->machine_argument&255u)==14u;
    pl_u32 selected=half?(pl_u32)(instruction->machine_argument>>32u)*8u:0u;
    const pl_x86_operand *target=&instruction->operands[0],*source=&instruction->operands[1];
    int read=source->kind==PL_X86_OPERAND_MEMORY,write=target->kind==PL_X86_OPERAND_MEMORY;
    if(mmx)cut_mmx_guard(cut);else cut_sse_guard(cut);
    if(scalar_lane&&transfer.alias&&!transfer.clear)return;
    /* Only the low scalar is live. Capture it before touching an aliased XMM
     * destination or publishing any CPU state; 32-bit GPR output zero-extends. */
    if(read)cut_const(cut,0u);
    else if(mmx&&law.source_mmx){cut_load(cut,offsetof(machine_state,x87_significand)+source->value.reg.index*8u);cut_mask(cut,width);}
    else if(vector(source,width)) {
        cut_load(cut,(pl_u32)offsetof(machine_state,xmm)+source->value.reg.index*16u+(scalar_lane?transfer.source_offset:selected));
        cut_mask(cut,width);
    } else cut_read_operand(cut,source,width);
    cut_set(cut,CUT_VALUE);
    if(read || write) {
        const pl_x86_memory *memory=&instruction->operands[write?0u:1u].value.memory;
        cut_effective_address(cut,instruction,memory);cut_set(cut,CUT_ADDRESS);
        cut->report.memory_access=write?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ;
        cut->report.memory_access|=cut_memory_role(memory);
        if(mmx&&law.aligned)cut->report.memory_access|=MACHINE_MEMORY_ALIGNED8;
        /* A single precise 4/8-byte access, including cross-page preflight.
         * No 16-byte pair or intermediate SIMD record is needed here. */
        cut_access(cut);
        if(read) {cut_access_value(cut);cut_mask(cut,width);cut_set(cut,CUT_VALUE);}
    }
    if(mmx){
        if(law.target_mmx)cut_store(cut,offsetof(machine_state,x87_significand)+target->value.reg.index*8u,CUT_VALUE);
        else if(!write)cut_write_register(cut,&target->value.reg);
        cut_mmx_publish(cut,law.target_mmx?target->value.reg.index:~0u);return;
    }
    if(vector(target,width)) {
        pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+target->value.reg.index*16u+(scalar_lane?transfer.target_offset:0u);
        if(scalar_lane){
            cut_get(cut,0u);cut_get(cut,CUT_VALUE);
            if(transfer.clear){
                cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,0x12u);cut_const(cut,0u);cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,0x1eu);cut_op(cut,1u);
                cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,0x0bu);wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,offset);
            }else{cut_op(cut,width==32u?0x3eu:0x37u);wasm_writer_uleb(cut->writer,width==32u?2u:3u);wasm_writer_uleb(cut->writer,offset);}
            return;
        }
        /* A selected-half write leaves the other half resident and untouched.
         * No old-vector read, blend, second store or pair access is required. */
        cut_store(cut,offset+selected,CUT_VALUE);
        if(half)return;
        cut_const(cut,0u);cut_set(cut,CUT_RIGHT);
        cut_store(cut,offset+8u,CUT_RIGHT);
    } else if(!write)cut_write_register(cut,&target->value.reg);
}
