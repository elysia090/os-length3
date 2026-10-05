#include "cut-internal.h"

pl_u32 cut_vector_permutation_shape(const pl_x86_instruction *instruction)
{
    if(instruction->visible_operand_count!=3u)return 0u;
    const pl_x86_operand *control=&instruction->operands[2];
    if(control->kind!=PL_X86_OPERAND_IMMEDIATE || control->bits!=8u
            || control->value.immediate>255u)return 0u;
    pl_u32 kind=(pl_u32)(instruction->machine_argument&255u);
    return kind==7u?32u:kind==27u?16u|128u:kind==PL_X86_VECTOR_SHUFFLE_LOW_WORDS?16u:0u;
}
static void simd(cut_lowering *cut,pl_u32 opcode)
{ cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,opcode); }
void cut_lower_vector_permutation(cut_lowering *cut,const pl_x86_instruction *instruction,pl_u32 shape)
{
    pl_u32 target=(pl_u32)offsetof(machine_state,xmm)+instruction->operands[0].value.reg.index*16u;
    pl_u32 control=(pl_u32)instruction->operands[2].value.immediate;
    cut_get(cut,0u);
    if(instruction->machine_argument&(1ull<<24u)) {
        /* The complete operand has passed C preflight; pair words are not
         * contiguous. Capture once without a sixteen-byte output image. */
        cut_access_value(cut);simd(cut,0x12u);
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x29u);wasm_writer_uleb(cut->writer,3u);
        wasm_writer_uleb(cut->writer,offsetof(machine_memory_pair_port,high));
        simd(cut,0x1eu);cut_op(cut,1u);
    } else {
        cut_get(cut,0u);simd(cut,0x00u);wasm_writer_uleb(cut->writer,4u);
        wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+instruction->operands[1].value.reg.index*16u);
    }
    if(control!=0xe4u) {
        /* Substitute the immediate into static byte coordinates. A single
         * captured SSA value supplies both shuffle inputs, including alias. */
        cut_op(cut,0x22u);wasm_writer_uleb(cut->writer,cut->vector_local);
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,cut->vector_local);
        simd(cut,0x0du);
        pl_u32 bytes=(shape&127u)/8u,start=(shape&128u)?8u:0u;
        for(pl_u32 i=0u;i<16u;++i) {
            pl_u32 coordinate=i;
            if(i>=start && i<start+4u*bytes) {
                pl_u32 lane=(i-start)/bytes;
                coordinate=start+bytes*((control>>(lane*2u))&3u)+(i-start)%bytes;
            }
            cut_op(cut,coordinate);
        }
    }
    simd(cut,0x0bu);wasm_writer_uleb(cut->writer,4u);wasm_writer_uleb(cut->writer,target);
}
