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
    /* Function/coordinate proof counts do not identify executable cuts in the
     * optimized program. Bounded register cuts use the public cold decoder;
     * complete function/control admission remains required before publication.
     * A private execution section is not an alternate source of program meaning. */
    return WASM_COMPILER_ERROR_INCOMPLETE;
}
