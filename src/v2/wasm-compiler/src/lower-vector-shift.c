#include "cut-internal.h"

pl_u32 cut_vector_shift_shape(const pl_x86_instruction *instruction)
{
    if(instruction->visible_operand_count!=2u)return 0u;
    const pl_x86_operand *source=&instruction->operands[1],*target=&instruction->operands[0];
    if(source->kind!=PL_X86_OPERAND_IMMEDIATE || source->bits!=8u
            || source->value.immediate>255u || target->kind!=PL_X86_OPERAND_REGISTER)return 0u;
    pl_u64 argument=instruction->machine_argument;
    pl_u32 kind=(pl_u32)(argument&255u),width=0u,left=0u;
    pl_u64 expected=kind|((pl_u64)target->value.reg.index<<8u);
    if(kind==5u || kind==6u || kind==11u || kind==12u) {
        width=kind<10u?32u:64u;left=kind==6u || kind==12u;
        expected|=((pl_u64)target->value.reg.index<<16u)|(source->value.immediate<<32u);
    } else if(kind==60u) {
        pl_u32 operation=(pl_u32)(argument>>32u)&255u;
        if(operation!=28u && operation!=45u)return 0u;
        width=16u;left=operation==28u;
        expected|=((pl_u64)operation<<32u)|(source->value.immediate<<40u);
    } else return 0u;
    return argument==expected?width|(left?128u:0u):0u;
}
static void simd(cut_lowering *cut,pl_u32 opcode)
{ cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,opcode); }
void cut_lower_vector_shift(cut_lowering *cut,const pl_x86_instruction *instruction,pl_u32 shape)
{
    pl_u32 width=shape&127u,count=(pl_u32)instruction->operands[1].value.immediate;
    pl_u32 offset=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[0].value.reg.index*16u;
    /* The precise control frontier precedes even the identity/zero cases.
     * x86 saturates oversized counts to zero; Wasm masks counts modulo width.
     * Substitute the admitted immediate before choosing a vector operation. */
    if(!count)return;
    cut_get(cut,0u);
    if(count>=width) {
        /* One vector publication, with no old operand read or output image. */
        cut_const(cut,0u);simd(cut,0x12u);
    } else {
        cut_get(cut,0u);simd(cut,0x00u);
        wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,offset);
        cut_op(cut,0x41u);wasm_writer_uleb(cut->writer,count);
        pl_u32 opcode=width==16u?0x8bu:width==32u?0xabu:0xcbu;
        simd(cut,opcode+((shape&128u)?0u:2u));
    }
    simd(cut,0x0bu);wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,offset);
}
