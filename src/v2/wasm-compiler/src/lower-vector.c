#include "cut-internal.h"

static int xmm(const pl_x86_operand *operand, int selected_half)
{
    return operand->kind==PL_X86_OPERAND_REGISTER
        && (operand->bits==128u || (selected_half && operand->bits==64u))
        && operand->value.reg.class_id==PL_X86_REGISTER_VECTOR
        && operand->value.reg.bits==128u && operand->value.reg.index<16u
        && !operand->value.reg.flags;
}
int cut_vector_supported(const pl_x86_instruction *instruction)
{
    if(instruction->status!=PL_X86_DECODE_VALID || instruction->flow!=PL_X86_FLOW_NEXT
            || instruction->machine_operation!=PL_X86_MACHINE_VECTOR
            || instruction->visible_operand_count!=2u
            || (instruction->flags&(PL_X86_INSTRUCTION_LOCKED|PL_X86_INSTRUCTION_REPEATED
                |PL_X86_INSTRUCTION_TRAP_AFTER)))return 0;
    const pl_x86_operand *target=&instruction->operands[0],*source=&instruction->operands[1];
    pl_u32 kind=(pl_u32)(instruction->machine_argument&255u);
    pl_u64 operation=instruction->machine_argument>>32u;
    pl_u32 unpack=cut_vector_unpack_shape(instruction);
    pl_u32 add=cut_vector_add_width(instruction);
    int packed=kind==10u && (add || operation==12u || unpack);
    int logic=(kind>=1u && kind<=3u) || kind==24u;
    if(kind && !packed && !logic && !add)return 0;
    int read=source->kind==PL_X86_OPERAND_MEMORY,write=target->kind==PL_X86_OPERAND_MEMORY;
    if((read && write) || (kind && write))return 0;
    if((read?source->bits!=128u:!xmm(source,!!unpack))
            || (write?target->bits!=128u:!xmm(target,0)))return 0;
    const pl_x86_operand *memory=write?target:source;
    if((read || write) && ((instruction->address_width!=32u && instruction->address_width!=64u)
            || !cut_memory_address_supported(instruction,&memory->value.memory)))return 0;
    pl_u64 argument=kind|((pl_u64)(write?0u:target->value.reg.index)<<8u)
        |((pl_u64)(read?0u:source->value.reg.index)<<16u)|((pl_u64)read<<24u)|((pl_u64)write<<25u);
    if(packed)argument|=(operation<<32u)|((pl_u64)read<<26u);
    else if(logic || add)argument|=(pl_u64)read<<26u;
    else if(read || write)argument|=instruction->machine_argument&(1ull<<26u);
    return instruction->machine_argument==argument;
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
void cut_sse_guard(cut_lowering *cut)
{
    /* Fixed SSE/SSE2 profile: #UD before #NM before operand access, for
     * register transfers too. No host FP state or mnemonic callback. */
    cut_load(cut,offsetof(machine_state,cr0));cut_const(cut,4u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x45u);
    cut_load(cut,offsetof(machine_state,cr4));cut_const(cut,512u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x72u);fault_if(cut,6u);
    cut_load(cut,offsetof(machine_state,cr0));cut_const(cut,8u);cut_op(cut,0x83u);
    cut_op(cut,0x50u);cut_op(cut,0x45u);fault_if(cut,7u);
}
static void write_word(cut_lowering *cut,pl_u32 offset,pl_u32 local)
{
    cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
    cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,offset);
    cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,8u);
    cut_get(cut,local);cut_op(cut,0x10u);wasm_writer_uleb(cut->writer,1u);cut_access_status(cut);
}
void cut_lower_vector(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    int read=!!(instruction->machine_argument&(1ull<<24u));
    int write=!!(instruction->machine_argument&(1ull<<25u));
    pl_u32 kind=(pl_u32)(instruction->machine_argument&255u);
    if(kind==10u && (instruction->machine_argument>>32u)==12u)kind=24u;
    cut_sse_guard(cut);
    /* Equal logical operands normalize to zero or identity. Control faults
     * still precede this pure substitution; no old XMM payload is needed. */
    if(!read && (kind==1u || kind==2u || kind==3u || kind==24u)
            && instruction->operands[0].value.reg.index==instruction->operands[1].value.reg.index) {
        if(kind==1u || kind==24u) {
            pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[0].value.reg.index*16u;
            cut_const(cut,0u);cut_set(cut,CUT_LEFT);cut_store(cut,offset,CUT_LEFT);cut_store(cut,offset+8u,CUT_LEFT);
        }
        return;
    }
    if(read || write) {
        const pl_x86_memory *memory=&instruction->operands[write?0u:1u].value.memory;
        cut_effective_address(cut,instruction,memory);cut_set(cut,CUT_ADDRESS);
        cut->report.memory_access=write?MACHINE_MEMORY_WRITE:MACHINE_MEMORY_READ;
        if(memory->segment.class_id==PL_X86_REGISTER_SEGMENT && memory->segment.index==2u)
            cut->report.memory_access|=MACHINE_MEMORY_STACK;
        if(instruction->machine_argument&(1ull<<26u))cut->report.memory_access|=MACHINE_MEMORY_ALIGNED16;
        /* All sixteen bytes obtain their rights/residency before either
         * XMM publication or the first store. Two scalar access calls would
         * expose a partial operand on a second-page fault. */
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);cut_get(cut,CUT_ADDRESS);
        cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,16u);
        cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,cut->report.memory_access);
        cut_op(cut,0x10u);wasm_writer_uleb(cut->writer,0u);cut_access_status(cut);
    }
    pl_u32 unpack=cut_vector_unpack_shape(instruction);
    if(unpack) {cut_lower_vector_unpack(cut,instruction,unpack);return;}
    if(read) {
        cut_access_value(cut);cut_set(cut,CUT_LEFT);
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x29u);wasm_writer_uleb(cut->writer,3u);
        wasm_writer_uleb(cut->writer,offsetof(machine_memory_pair_port,high));cut_set(cut,CUT_RIGHT);
    } else {
        pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[1].value.reg.index*16u;
        cut_load(cut,offset);cut_set(cut,CUT_LEFT);cut_load(cut,offset+8u);cut_set(cut,CUT_RIGHT);
    }
    pl_u32 add=cut_vector_add_width(instruction);
    if(add && add<64u)cut_lower_vector_add(cut,instruction,add);
    else if(kind) {
        /* Two pure lanes share one precise operand preflight. PADDQ is
         * modulo-2^64 addition; AND-NOT complements the old destination,
         * not the source. Capture both results before any publication. */
        pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[0].value.reg.index*16u;
        for(pl_u32 i=0u;i<2u;++i) {
            pl_u32 local=i?CUT_RIGHT:CUT_LEFT;
            cut_load(cut,offset+i*8u);
            if(kind==24u) {cut_const(cut,~0ull);cut_op(cut,0x85u);}
            cut_get(cut,local);
            cut_op(cut,kind==10u?0x7cu:kind==1u?0x85u:kind==3u?0x84u:0x83u);
            cut_set(cut,local);
        }
    }
    if(write) {
        write_word(cut,0u,CUT_LEFT);write_word(cut,8u,CUT_RIGHT);
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x10u);wasm_writer_uleb(cut->writer,2u);cut_access_status(cut);
    } else {
        pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[0].value.reg.index*16u;
        cut_store(cut,offset,CUT_LEFT);cut_store(cut,offset+8u,CUT_RIGHT);
    }
}
