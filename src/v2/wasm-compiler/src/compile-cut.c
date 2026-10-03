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

static int result_aliases(const wasm_compiler *compiler, const pl_x86_image *source,
                          const wasm_cut_options *options, const pl_u64 *written,
                          const wasm_cut_report *report)
{
    const void *outputs[2] = { written, report };
    const pl_u64 sizes[2] = { sizeof *written, sizeof *report };
    if (report && overlaps(written, sizeof *written, report, sizeof *report)) return 1;
    for (pl_u32 i = 0u; i < 2u; ++i) {
        if (!outputs[i]) continue;
        if ((pl_u64)(uintptr_t)outputs[i] > (pl_u64)UINTPTR_MAX - sizes[i]
                || overlaps(outputs[i], sizes[i], options, sizeof *options)) return 1;
        if (compiler && (overlaps(outputs[i], sizes[i], compiler, sizeof *compiler)
                || overlaps(outputs[i], sizes[i], compiler->image.bytes, compiler->image.length))) return 1;
        if (source) {
            if (overlaps(outputs[i], sizes[i], source, sizeof *source)
                    || overlaps(outputs[i], sizes[i], source->maps, source->map_count * sizeof(pl_x86_map))) return 1;
            for (pl_u32 j = 0u; j < source->map_count; ++j)
                if (overlaps(outputs[i], sizes[i], source->maps[j].bytes, source->maps[j].file_bytes)) return 1;
        }
    }
    return 0;
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

static void module_header(wasm_writer *writer, pl_u64 body_bytes, int boundary)
{
    static const pl_u8 header[] = { 0,0x61,0x73,0x6d,1,0,0,0 };
    static const pl_u8 type[] = { 1,0x60,2,0x7f,0x7f,1,0x7e };
    static const pl_u8 imports[] = {
        1,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1
    };
    static const pl_u8 functions[] = { 1,0 };
    static const pl_u8 exports[] = { 1,3,'c','u','t',0,0 };
    static const pl_u8 memory_type[] = {
        2,0x60,5,0x7f,0x7e,0x7f,0x7f,0x7e,1,0x7e,
        0x60,2,0x7f,0x7f,1,0x7e
    };
    static const pl_u8 memory_imports[] = {
        2,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',6,'a','c','c','e','s','s',0,0
    };
    static const pl_u8 memory_functions[] = { 1,1 };
    static const pl_u8 memory_exports[] = { 1,3,'c','u','t',0,1 };
    static const pl_u8 segment_type[] = {
        2,0x60,3,0x7f,0x7f,0x7f,1,0x7e,
        0x60,2,0x7f,0x7f,1,0x7e
    };
    static const pl_u8 segment_imports[] = {
        2,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',7,'s','e','g','m','e','n','t',0,0
    };
    static const pl_u8 rmw_type[] = {
        3,0x60,4,0x7f,0x7e,0x7f,0x7f,1,0x7e,
        0x60,2,0x7f,0x7e,1,0x7e, 0x60,2,0x7f,0x7f,1,0x7e
    };
    static const pl_u8 rmw_imports[] = {
        3,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',7,'r','e','s','e','r','v','e',0,0,
        7,'m','a','c','h','i','n','e',6,'c','o','m','m','i','t',0,1
    };
    static const pl_u8 rmw_functions[] = { 1,2 };
    static const pl_u8 rmw_exports[] = { 1,3,'c','u','t',0,2 };
    static const pl_u8 table_type[] = {
        2,0x60,4,0x7f,0x7e,0x7f,0x7f,1,0x7e, 0x60,2,0x7f,0x7f,1,0x7e
    };
    static const pl_u8 table_imports[] = {
        2,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',5,'t','a','b','l','e',0,0
    };
    static const pl_u8 return_imports[] = {
        2,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',10,'f','a','r','_','r','e','t','u','r','n',0,0
    };
    static const pl_u8 control_type[] = {
        2,0x60,3,0x7f,0x7f,0x7e,1,0x7e, 0x60,2,0x7f,0x7f,1,0x7e
    };
    static const pl_u8 control_imports[] = {
        2,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',7,'c','o','n','t','r','o','l',0,0
    };
    static const pl_u8 interrupt_type[] = {
        2,0x60,1,0x7f,1,0x7e, 0x60,2,0x7f,0x7f,1,0x7e
    };
    static const pl_u8 interrupt_imports[] = {
        2,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',4,'i','r','e','t',0,0
    };
    static const pl_u8 msr_type[] = {
        2,0x60,4,0x7f,0x7f,0x7f,0x7e,1,0x7e, 0x60,2,0x7f,0x7f,1,0x7e
    };
    static const pl_u8 msr_imports[] = {
        2,7,'m','a','c','h','i','n','e',6,'m','e','m','o','r','y',2,0,1,
        7,'m','a','c','h','i','n','e',3,'m','s','r',0,0
    };
    raw(writer, header, sizeof header);
    if (boundary == 8) {
        section(writer,1u,sizeof msr_type); raw(writer,msr_type,sizeof msr_type);
        section(writer,2u,sizeof msr_imports); raw(writer,msr_imports,sizeof msr_imports);
        section(writer,3u,sizeof memory_functions); raw(writer,memory_functions,sizeof memory_functions);
        section(writer,7u,sizeof memory_exports); raw(writer,memory_exports,sizeof memory_exports);
    } else if (boundary == 7) {
        section(writer,1u,sizeof interrupt_type); raw(writer,interrupt_type,sizeof interrupt_type);
        section(writer,2u,sizeof interrupt_imports); raw(writer,interrupt_imports,sizeof interrupt_imports);
        section(writer,3u,sizeof memory_functions); raw(writer,memory_functions,sizeof memory_functions);
        section(writer,7u,sizeof memory_exports); raw(writer,memory_exports,sizeof memory_exports);
    } else if (boundary == 6) {
        section(writer,1u,sizeof control_type); raw(writer,control_type,sizeof control_type);
        section(writer,2u,sizeof control_imports); raw(writer,control_imports,sizeof control_imports);
        section(writer,3u,sizeof memory_functions); raw(writer,memory_functions,sizeof memory_functions);
        section(writer,7u,sizeof memory_exports); raw(writer,memory_exports,sizeof memory_exports);
    } else if (boundary == 5) {
        section(writer,1u,sizeof type); raw(writer,type,sizeof type);
        section(writer,2u,sizeof return_imports); raw(writer,return_imports,sizeof return_imports);
        section(writer,3u,sizeof functions); raw(writer,functions,sizeof functions);
        section(writer,7u,sizeof memory_exports); raw(writer,memory_exports,sizeof memory_exports);
    } else if (boundary == 3 || boundary == 4) {
        section(writer,1u,boundary == 3 ? sizeof rmw_type : sizeof table_type);
        if (boundary == 3) raw(writer,rmw_type,sizeof rmw_type);
        else raw(writer,table_type,sizeof table_type);
        section(writer,2u,boundary == 3 ? sizeof rmw_imports : sizeof table_imports);
        if (boundary == 3) raw(writer,rmw_imports,sizeof rmw_imports);
        else raw(writer,table_imports,sizeof table_imports);
        section(writer,3u,sizeof memory_functions);
        raw(writer,boundary == 3 ? rmw_functions : memory_functions,sizeof memory_functions);
        section(writer,7u,sizeof memory_exports);
        raw(writer,boundary == 3 ? rmw_exports : memory_exports,sizeof memory_exports);
    } else if (boundary) {
        section(writer, 1u, boundary == 2 ? sizeof segment_type : sizeof memory_type);
        if (boundary == 2) raw(writer,segment_type,sizeof segment_type);
        else raw(writer,memory_type,sizeof memory_type);
        section(writer, 2u, boundary == 2 ? sizeof segment_imports : sizeof memory_imports);
        if (boundary == 2) raw(writer,segment_imports,sizeof segment_imports);
        else raw(writer,memory_imports,sizeof memory_imports);
        section(writer, 3u, sizeof memory_functions); raw(writer, memory_functions, sizeof memory_functions);
        section(writer, 7u, sizeof memory_exports); raw(writer, memory_exports, sizeof memory_exports);
    } else {
        section(writer, 1u, sizeof type); raw(writer, type, sizeof type);
        section(writer, 2u, sizeof imports); raw(writer, imports, sizeof imports);
        section(writer, 3u, sizeof functions); raw(writer, functions, sizeof functions);
        section(writer, 7u, sizeof exports); raw(writer, exports, sizeof exports);
    }
    section(writer, 10u, 1u + uleb_bytes(body_bytes) + body_bytes);
    wasm_writer_uleb(writer, 1u); wasm_writer_uleb(writer, body_bytes);
}

static int boundary_kind(const cut_plan *plan, const wasm_cut_report *report)
{
    /* A CALL's target read and stack write are ordered scalar transactions,
     * not an RMW reservation on a single memory operand. */
    if (plan->repeat_cut || (plan->indirect_cut && report->memory_bytes)) return 1;
    if (plan->system_cut == CUT_SYSTEM_MSR) return 8;
    if (plan->system_cut == CUT_SYSTEM_INTERRUPT_RETURN) return 7;
    if (plan->system_cut == CUT_SYSTEM_CONTROL_WRITE) return 6;
    if (plan->system_cut == CUT_SYSTEM_FAR_RETURN) return 5;
    if (plan->system_cut == CUT_SYSTEM_TABLE) return 4;
    if (plan->system_cut == CUT_SYSTEM_SEGMENT) return 2;
    return (report->memory_access & 3u) == 3u ? 3 : report->memory_bytes != 0u;
}

static int prepare(const wasm_compiler *compiler, const pl_x86_image *source,
                    pl_u64 generation, const wasm_cut_options *options,
                    cut_plan *plan, pl_u64 *body_bytes)
{
    wasm_compile_report admission = { 0 };
    wasm_cut_report measured;
    wasm_writer body = { 0, ~0ull, 0u, 0 };
    wasm_writer header = { 0, ~0ull, 0u, 0 };
    if ((!compiler && !source) || !options || !options->maximum_module_bytes
            || !options->maximum_source_instructions
            || options->maximum_source_instructions > WASM_CUT_MAX_INSTRUCTIONS)
        return WASM_COMPILER_ERROR_INPUT;
    int status;
    if (compiler) {
        status = wasm_lower_machine_abi(compiler, &admission);
        if (!status) status = cut_prepare(compiler, options, plan);
    } else {
        if (!generation || source->reserved || !source->map_count || source->map_count > 2u
                || pl_x86_image_validate(source) || !pl_x86_image_contains(source, options->entry))
            return WASM_COMPILER_ERROR_INPUT;
        for (pl_u32 i = 0u; i < source->map_count; ++i) {
            const pl_x86_map *map = source->maps + i;
            if ((map->address & 4095u) || map->file_bytes != 4096u || map->memory_bytes != 4096u
                    || map->generation != generation || !(map->flags & PL_ELF_FLAG_EXECUTE)
                    || (pl_u64)(uintptr_t)map->bytes > (pl_u64)UINTPTR_MAX - 4096u
                    || (i && source->maps[i - 1u].address + 4096u != map->address))
                return WASM_COMPILER_ERROR_INPUT;
        }
        status = cut_prepare_image(source, options, plan);
    }
    if (!status) status = cut_emit_body(&body, plan, &measured);
    if (status) return status;
    module_header(&header, body.used, boundary_kind(plan, &measured));
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
    int status = prepare(compiler, 0, 0u, options, &plan, &body_bytes);
    if (status) return status;
    if (result_aliases(compiler, 0, options, bytes, report)) return WASM_COMPILER_ERROR_INPUT;
    *bytes = plan.report.module_bytes;
    if (report) *report = plan.report;
    return 0;
}

static int emit(const wasm_compiler *compiler, const pl_x86_image *source, pl_u64 generation,
                           const wasm_cut_options *options,
                           pl_u8 *target, pl_u64 capacity,
                           pl_u64 *written, wasm_cut_report *report)
{
    pl_u64 body_bytes;
    cut_plan plan;
    wasm_cut_report measured;
    if (!target || !written) return WASM_COMPILER_ERROR_INPUT;
    int status = prepare(compiler, source, generation, options, &plan, &body_bytes);
    if (status) return status;
    if (result_aliases(compiler, source, options, written, report)) return WASM_COMPILER_ERROR_INPUT;
    pl_u64 bytes = plan.report.module_bytes;
    if (capacity < bytes) return WASM_COMPILER_ERROR_CAPACITY;
    if (bytes > (pl_u64)UINTPTR_MAX - (pl_u64)(uintptr_t)target
            || (compiler && (overlaps(target, bytes, compiler->image.bytes, compiler->image.length)
                             || overlaps(target, bytes, compiler, sizeof *compiler)))
            || overlaps(target, bytes, options, sizeof *options)
            || overlaps(target, bytes, written, sizeof *written)
            || (report && overlaps(target, bytes, report, sizeof *report)))
        return WASM_COMPILER_ERROR_INPUT;
    if (source) {
        if (overlaps(target, bytes, source, sizeof *source)
                || overlaps(target, bytes, source->maps, source->map_count * sizeof(pl_x86_map)))
            return WASM_COMPILER_ERROR_INPUT;
        for (pl_u32 i = 0u; i < source->map_count; ++i)
            if (overlaps(target, bytes, source->maps[i].bytes, source->maps[i].file_bytes))
                return WASM_COMPILER_ERROR_INPUT;
    }
    wasm_writer writer = { target, capacity, 0u, 0 };
    module_header(&writer, body_bytes, boundary_kind(&plan, &plan.report));
    status = cut_emit_body(&writer, &plan, &measured);
    if (status) return status;
    measured.module_bytes = writer.used;
    *written = writer.used;
    if (report) *report = measured;
    return 0;
}

int wasm_compiler_emit_cut(const wasm_compiler *compiler, const wasm_cut_options *options,
                           pl_u8 *target, pl_u64 capacity, pl_u64 *written, wasm_cut_report *report)
{ return emit(compiler, 0, 0u, options, target, capacity, written, report); }

int wasm_compiler_measure_code_cut(const pl_x86_image *source, pl_u64 generation,
                                   const wasm_cut_options *options, pl_u64 *bytes,
                                   wasm_cut_report *report)
{
    cut_plan plan;
    pl_u64 body_bytes;
    if (!bytes) return WASM_COMPILER_ERROR_INPUT;
    int status = prepare(0, source, generation, options, &plan, &body_bytes);
    if (status) return status;
    if (result_aliases(0, source, options, bytes, report)) return WASM_COMPILER_ERROR_INPUT;
    *bytes = plan.report.module_bytes;
    if (report) *report = plan.report;
    return 0;
}
int wasm_compiler_emit_code_cut(const pl_x86_image *source, pl_u64 generation,
                                const wasm_cut_options *options, pl_u8 *target,
                                pl_u64 capacity, pl_u64 *written, wasm_cut_report *report)
{ return emit(0, source, generation, options, target, capacity, written, report); }
