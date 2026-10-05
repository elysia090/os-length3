#include "cut-internal.h"

static void simd(cut_lowering *cut,pl_u32 opcode)
{
    cut_op(cut,0xfdu);wasm_writer_uleb(cut->writer,opcode);
}
static void load_xmm(cut_lowering *cut,pl_u32 index)
{
    cut_get(cut,0u);simd(cut,0x00u);
    wasm_writer_uleb(cut->writer,4u);
    wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+index*16u);
}
void cut_lower_vector_shuffle(cut_lowering *cut,const pl_x86_instruction *instruction)
{
    pl_u32 target=instruction->operands[0].value.reg.index;
    /* State and the complete memory operand have already passed the precise
     * frontier. Keep both old vectors on the stack, including self-alias. */
    cut_get(cut,0u);load_xmm(cut,target);
    if(instruction->machine_argument&(1ull<<24u)) {
        /* The pair port has noncontiguous words: do not read its fault fields
         * as vector payload or construct a sixteen-byte intermediate image. */
        cut_access_value(cut);simd(cut,0x12u); /* i64x2.splat */
        cut_op(cut,0x20u);wasm_writer_uleb(cut->writer,1u);
        cut_op(cut,0x29u);wasm_writer_uleb(cut->writer,3u);
        wasm_writer_uleb(cut->writer,offsetof(machine_memory_pair_port,high));
        simd(cut,0x1eu);cut_op(cut,1u); /* i64x2.replace_lane 1 */
    } else load_xmm(cut,instruction->operands[1].value.reg.index);
    /* PSHUFB: bit 7 zeroes, bits 3:0 select, bits 6:4 are irrelevant.
     * Masking by 0x8f retains exactly those distinctions. Deterministic
     * i8x16.swizzle zeroes every index >= 16; relaxed swizzle is not used. */
    simd(cut,0x0cu);for(pl_u32 i=0u;i<16u;++i)cut_op(cut,0x8fu);
    simd(cut,0x4eu);simd(cut,0x0eu); /* v128.and; i8x16.swizzle */
    simd(cut,0x0bu);wasm_writer_uleb(cut->writer,4u);
    wasm_writer_uleb(cut->writer,offsetof(machine_state,xmm)+target*16u);
}
