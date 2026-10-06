/* Backend spelling of the common lane law. No scalar lane reconstruction. */
#include "cut-internal.h"

static void simd(cut_lowering *cut, pl_u32 opcode)
{ cut_op(cut, 0xfdu); wasm_writer_uleb(cut->writer, opcode); }

static void load_vector(cut_lowering *cut, pl_u32 index)
{
    cut_get(cut, 0u); simd(cut, 0x00u);
    wasm_writer_uleb(cut->writer, 4u);
    wasm_writer_uleb(cut->writer, offsetof(machine_state, xmm) + index * 16u);
}

static void source(cut_lowering *cut, const pl_x86_instruction *instruction,
                    const pl_x86_vector_binary *law)
{
    if (!law->source_memory) { load_vector(cut, instruction->operands[1].value.reg.index); return; }
    cut_access_value(cut); simd(cut, 0x12u);
    cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, 1u);
    cut_op(cut, 0x29u); wasm_writer_uleb(cut->writer, 3u);
    wasm_writer_uleb(cut->writer, offsetof(machine_memory_pair_port, high));
    simd(cut, 0x1eu); cut_op(cut, 1u);
}

int cut_vector_binary_local(const pl_x86_instruction *instruction)
{
    pl_x86_vector_binary law;
    return pl_x86_vector_binary_lower(instruction, &law)
        && law.alias && law.result == PL_X86_VECTOR_BINARY_VALUE;
}

void cut_emit_vector_binary(cut_lowering *cut, const pl_x86_instruction *instruction,
                             const pl_x86_vector_binary *law)
{
    static const pl_u32 bitwise[] = {0x4eu, 0x50u, 0x51u, 0x4fu};
    static const pl_u32 add[] = {0x6eu, 0x8eu, 0xaeu, 0xceu};
    static const pl_u32 equal[] = {0x23u, 0x2du, 0x37u};
    if (law->result == PL_X86_VECTOR_BINARY_IDENTITY) return;
    cut_get(cut, 0u);
    if (law->result != PL_X86_VECTOR_BINARY_VALUE) {
        cut_const(cut, law->result == PL_X86_VECTOR_BINARY_ONES ? ~0ull : 0u);
        simd(cut, 0x12u);
    } else {
        if (law->reverse) source(cut, instruction, law);
        load_vector(cut, instruction->operands[0].value.reg.index);
        if (law->alias) {
            cut_op(cut, 0x22u); wasm_writer_uleb(cut->writer, cut->vector_local);
            cut_op(cut, 0x20u); wasm_writer_uleb(cut->writer, cut->vector_local);
        } else if (!law->reverse) source(cut, instruction, law);
        pl_u32 width = law->lane_bytes == 1u ? 0u : law->lane_bytes == 2u ? 1u
                       : law->lane_bytes == 4u ? 2u : 3u;
        simd(cut, law->operation < PL_X86_VECTOR_BINARY_ADD
                    ? bitwise[law->operation]
                    : law->operation == PL_X86_VECTOR_BINARY_ADD ? add[width] : equal[width]);
    }
    simd(cut, 0x0bu); wasm_writer_uleb(cut->writer, 4u);
    wasm_writer_uleb(cut->writer,
        offsetof(machine_state, xmm) + instruction->operands[0].value.reg.index * 16u);
}
