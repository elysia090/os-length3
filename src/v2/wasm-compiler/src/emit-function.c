#include "internal.h"

void wasm_writer_byte(wasm_writer *writer, pl_u32 value)
{
    if (!writer || writer->error) return;
    if (writer->used >= writer->capacity) {
        writer->error = WASM_COMPILER_ERROR_CAPACITY;
        return;
    }
    if (writer->bytes) writer->bytes[writer->used] = (pl_u8)value;
    ++writer->used;
}

void wasm_writer_uleb(wasm_writer *writer, pl_u64 value)
{
    do {
        pl_u32 byte = (pl_u32)(value & 0x7fu);
        value >>= 7u;
        if (value) byte |= 0x80u;
        wasm_writer_byte(writer, byte);
    } while (value && !writer->error);
}

int wasm_emit_function(wasm_writer *writer, const wasm_compiler *compiler,
                       pl_u32 function_rank,
                       wasm_compile_report *report)
{
    (void)writer;
    if (!compiler || !report || function_rank >= compiler->function_count)
        return WASM_COMPILER_ERROR_GRAMMAR;
    /* The backend must decode the accepted optimized x86 program segments.
     * A private SSA/program section would create a second executable identity.
     * Until direct x86 decoding and lowering are connected, publication stays
     * red rather than consulting such a sidecar. */
    return WASM_COMPILER_ERROR_INCOMPLETE;
}
