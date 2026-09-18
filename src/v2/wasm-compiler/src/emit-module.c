#include "internal.h"

int wasm_emit_module(wasm_writer *writer, const wasm_compiler *compiler,
                     const wasm_compile_options *options,
                     wasm_compile_report *report)
{
    pl_u32 function;
    int status;
    (void)options;
    status = wasm_lower_machine_abi(compiler, report);
    if (status) return status;
    for (function = 0u; function < compiler->function_count; ++function) {
        status = wasm_emit_function(writer, compiler, function, report);
        if (status) return status;
    }
    return WASM_COMPILER_ERROR_INCOMPLETE;
}

static int compile(const wasm_compiler *compiler,
                   const wasm_compile_options *options,
                   pl_u8 *target, pl_u64 capacity, pl_u64 *written,
                   wasm_compile_report *report)
{
    wasm_writer writer = { target, capacity, 0u, 0 };
    wasm_compile_report measured = { 0 };
    int status;
    if (!compiler || !options || !written
            || !options->maximum_functions_per_module
            || !options->maximum_module_bytes)
        return WASM_COMPILER_ERROR_INPUT;
    status = wasm_emit_module(&writer, compiler, options, &measured);
    if (status) return status;
    if (writer.error) return writer.error;
    measured.bytes = writer.used;
    *written = writer.used;
    if (report) *report = measured;
    return 0;
}

int wasm_compiler_measure(const wasm_compiler *compiler,
                          const wasm_compile_options *options,
                          pl_u64 *wasm_bytes,
                          wasm_compile_report *report)
{
    return compile(compiler, options, 0, ~0ull, wasm_bytes, report);
}

int wasm_compiler_emit(const wasm_compiler *compiler,
                       const wasm_compile_options *options,
                       pl_u8 *target, pl_u64 capacity,
                       pl_u64 *written,
                       wasm_compile_report *report)
{
    if (!target) return WASM_COMPILER_ERROR_INPUT;
    return compile(compiler, options, target, capacity, written, report);
}
