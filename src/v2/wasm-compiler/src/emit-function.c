#include "internal.h"

void wasm_writer_byte(wasm_writer *writer, pl_u32 value)
{
    if (!writer || writer->error) return;
    if (writer->used >= writer->capacity) {
        writer->error = WASM_COMPILER_ERROR_CAPACITY;
        return;
    }
    if (writer->bytes) {
        if (!writer->window_bytes) writer->bytes[writer->used] = (pl_u8)value;
        else if (writer->used >= writer->window_start
                && writer->used - writer->window_start < writer->window_bytes)
            writer->bytes[writer->used - writer->window_start] = (pl_u8)value;
    }
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
