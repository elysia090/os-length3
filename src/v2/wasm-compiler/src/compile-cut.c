#include "cut-internal.h"
#include <stdint.h>

static int overlaps(const void *left, pl_u64 left_bytes,
                     const void *right, pl_u64 right_bytes)
{
    pl_u64 a = (pl_u64)(uintptr_t)left;
    pl_u64 b = (pl_u64)(uintptr_t)right;
    if (!left_bytes || !right_bytes) return 0;
    return a <= b ? b - a < left_bytes : a - b < right_bytes;
}

static void section(wasm_writer *writer, pl_u32 id, pl_u64 bytes)
{ wasm_writer_byte(writer, id); wasm_writer_uleb(writer, bytes); }
static void raw(wasm_writer *writer, const pl_u8 *bytes, pl_u32 count)
{ for (pl_u32 i = 0u; i < count; ++i) wasm_writer_byte(writer, bytes[i]); }
static pl_u32 uleb_bytes(pl_u64 value)
{
    pl_u32 bytes = 1u;
    while ((value >>= 7u)) ++bytes;
    return bytes;
}

static void module_header(wasm_writer *writer, pl_u64 body_bytes)
{
    static const pl_u8 header[] = { 0,0x61,0x73,0x6d,1,0,0,0 };
    static const pl_u8 type[] = { 1,0x60,1,0x7f,1,0x7e };
    static const pl_u8 imports[] = {
        1,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1
    };
    static const pl_u8 functions[] = { 1,0 };
    static const pl_u8 exports[] = { 1,3,'c','u','t',0,0 };
    raw(writer, header, sizeof header);
    section(writer, 1u, sizeof type); raw(writer, type, sizeof type);
    section(writer, 2u, sizeof imports); raw(writer, imports, sizeof imports);
    section(writer, 3u, sizeof functions); raw(writer, functions, sizeof functions);
    section(writer, 7u, sizeof exports); raw(writer, exports, sizeof exports);
    section(writer, 10u, 1u + uleb_bytes(body_bytes) + body_bytes);
    wasm_writer_uleb(writer, 1u); wasm_writer_uleb(writer, body_bytes);
}

static int prepare(const wasm_compiler *compiler, const wasm_cut_options *options,
                    cut_plan *plan, pl_u64 *body_bytes)
{
    wasm_compile_report admission = { 0 };
    wasm_cut_report measured;
    wasm_writer body = { 0, ~0ull, 0u, 0 };
    wasm_writer header = { 0, ~0ull, 0u, 0 };
    if (!compiler || !options || !options->maximum_module_bytes
            || !options->maximum_source_instructions
            || options->maximum_source_instructions > WASM_CUT_MAX_INSTRUCTIONS)
        return WASM_COMPILER_ERROR_INPUT;
    int status = wasm_lower_machine_abi(compiler, &admission);
    if (!status) status = cut_prepare(compiler, options, plan);
    if (!status) status = cut_emit_body(&body, plan, &measured);
    if (status) return status;
    module_header(&header, body.used);
    if (!pl_checked_add_u64(header.used, body.used, &measured.module_bytes)
            || measured.module_bytes > options->maximum_module_bytes)
        return WASM_COMPILER_ERROR_CAPACITY;
    plan->report = measured;
    *body_bytes = body.used;
    return 0;
}

int wasm_compiler_measure_cut(const wasm_compiler *compiler,
                              const wasm_cut_options *options,
                              pl_u64 *bytes, wasm_cut_report *report)
{
    cut_plan plan;
    pl_u64 body_bytes;
    if (!bytes) return WASM_COMPILER_ERROR_INPUT;
    int status = prepare(compiler, options, &plan, &body_bytes);
    if (status) return status;
    *bytes = plan.report.module_bytes;
    if (report) *report = plan.report;
    return 0;
}

int wasm_compiler_emit_cut(const wasm_compiler *compiler,
                           const wasm_cut_options *options,
                           pl_u8 *target, pl_u64 capacity,
                           pl_u64 *written, wasm_cut_report *report)
{
    pl_u64 body_bytes;
    cut_plan plan;
    wasm_cut_report measured;
    if (!target || !written) return WASM_COMPILER_ERROR_INPUT;
    int status = prepare(compiler, options, &plan, &body_bytes);
    if (status) return status;
    pl_u64 bytes = plan.report.module_bytes;
    if (capacity < bytes) return WASM_COMPILER_ERROR_CAPACITY;
    if (bytes > (pl_u64)UINTPTR_MAX - (pl_u64)(uintptr_t)target
            || overlaps(target, bytes, compiler->image.bytes, compiler->image.length)
            || overlaps(target, bytes, compiler, sizeof *compiler)
            || overlaps(target, bytes, options, sizeof *options)
            || overlaps(target, bytes, written, sizeof *written)
            || (report && overlaps(target, bytes, report, sizeof *report)))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_writer writer = { target, capacity, 0u, 0 };
    module_header(&writer, body_bytes);
    status = cut_emit_body(&writer, &plan, &measured);
    if (status) return status;
    measured.module_bytes = writer.used;
    *written = writer.used;
    if (report) *report = measured;
    return 0;
}
