/* The x86 frontend owns the selection law; this backend spells its coordinates. */
#include "cut-internal.h"

static void simd(cut_lowering *cut, pl_u32 opcode)
{
    cut_op(cut, 0xfdu);
    wasm_writer_uleb(cut->writer, opcode);
}

static int unchanged(const pl_x86_vector_projection *projection)
{
    for (pl_u32 byte = 0u; byte < 16u; ++byte)
        if (pl_x86_vector_project_byte(projection, byte) != byte) return 0;
    return 1;
}

int cut_vector_projection_local(const pl_x86_instruction *instruction)
{
    pl_x86_vector_projection projection;
    return pl_x86_vector_project(instruction, &projection)
        && projection.inputs == 1u && !unchanged(&projection);
}

static void load_vector(cut_lowering *cut, pl_u32 index)
{
    cut_get(cut, 0u);
    simd(cut, 0x00u);
    wasm_writer_uleb(cut->writer, 4u);
    wasm_writer_uleb(cut->writer,
        offsetof(machine_state, xmm) + index * 16u);
}

static void load_source(cut_lowering *cut,
                         const pl_x86_vector_projection *projection)
{
    if (!projection->inputs||(projection->lane_bytes == 1u&&(projection->control<2u||projection->start>=16u))) {
        cut_const(cut,0u);
        simd(cut,0x12u);
        return;
    }
    if(projection->start==PL_X86_VECTOR_INSERT_COORDINATES
        &&(projection->control&(1u<<((projection->control>>4u)&3u)))){load_vector(cut,projection->first_register);return;}
    if (!projection->source_memory) {
        load_vector(cut, projection->inputs == 2u
                    ? projection->second_register : projection->first_register);
        return;
    }
    /* Both source halves were preflighted before output publication. The
     * scalar port words need not be contiguous; no vector image is created. */
    cut_access_value(cut);
    simd(cut, 0x12u);
    if(pl_x86_vector_projection_extent(projection)<=8u)return;
    cut_op(cut, 0x20u);
    wasm_writer_uleb(cut->writer, 1u);
    cut_op(cut, 0x29u);
    wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_pair_port, high));
    simd(cut, 0x1eu);
    cut_op(cut, 1u);
}

void cut_emit_vector_projection(cut_lowering *cut,
    const pl_x86_instruction *instruction,
    const pl_x86_vector_projection *projection)
{
    if (projection->identity||(projection->inputs==2u&&unchanged(projection)
        &&projection->start!=PL_X86_VECTOR_INSERT_COORDINATES)) return;
    cut_get(cut, 0u);
    int first_only=projection->inputs==2u&&unchanged(projection);
    if (projection->inputs == 2u) load_vector(cut, projection->first_register);
    if(!first_only)load_source(cut, projection);
    if (projection->inputs && !unchanged(projection)) {
        if (projection->inputs == 1u) {
            cut_op(cut, 0x22u);
            wasm_writer_uleb(cut->writer, cut->vector_local);
            cut_op(cut, 0x20u);
            wasm_writer_uleb(cut->writer, cut->vector_local);
        }
        simd(cut, 0x0du);
        for (pl_u32 byte = 0u; byte < 16u; ++byte)
            cut_op(cut, pl_x86_vector_project_byte(projection, byte));
    }
    if(projection->start==PL_X86_VECTOR_INSERT_COORDINATES&&(projection->control&15u)&&projection->inputs){
        simd(cut,0x0cu);for(pl_u32 b=0u;b<16u;++b)cut_op(cut,(pl_u8)((projection->control&(1u<<(b/4u)))?0u:255u));
        simd(cut,0x4eu);
    }
    simd(cut, 0x0bu);
    wasm_writer_uleb(cut->writer, 4u);
    wasm_writer_uleb(cut->writer,
        offsetof(machine_state, xmm) + instruction->operands[0].value.reg.index * 16u);
}
