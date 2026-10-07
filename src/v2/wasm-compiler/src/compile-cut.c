#include "cut-internal.h"
#include <stdint.h>
#include <machine/module.h>

static int overlaps(const void *left, pl_u64 left_bytes,
                     const void *right, pl_u64 right_bytes)
{
    pl_u64 a = (pl_u64)(uintptr_t)left;
    pl_u64 b = (pl_u64)(uintptr_t)right;
    if (!left_bytes || !right_bytes) return 0;
    return a <= b ? b - a < left_bytes : a - b < right_bytes;
}

static int result_aliases(const wasm_compiler *compiler, const pl_x86_image *source,
                          const wasm_cut_options *options,pl_u64 option_bytes,
                          const pl_u64 *written,const wasm_cut_report *report,pl_u64 report_bytes)
{
    const void *outputs[2] = { written, report };
    const pl_u64 sizes[2] = { sizeof *written, report_bytes };
    if (report && overlaps(written, sizeof *written, report, report_bytes)) return 1;
    for (pl_u32 i = 0u; i < 2u; ++i) {
        if (!outputs[i]) continue;
        if ((pl_u64)(uintptr_t)outputs[i] > (pl_u64)UINTPTR_MAX - sizes[i]
                || overlaps(outputs[i], sizes[i], options, option_bytes)) return 1;
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
static int target_aliases(const wasm_compiler *compiler,const pl_x86_image *source,
    const wasm_cut_options *options,pl_u64 option_bytes,pl_u8 *target,pl_u64 bytes,
    const pl_u64 *written,const wasm_cut_report *reports,pl_u64 report_bytes)
{
    if (bytes>(pl_u64)UINTPTR_MAX-(pl_u64)(uintptr_t)target
            || overlaps(target,bytes,options,option_bytes)
            || overlaps(target,bytes,written,sizeof *written)
            || (reports && overlaps(target,bytes,reports,report_bytes))
            || (compiler && (overlaps(target,bytes,compiler,sizeof *compiler)
                || overlaps(target,bytes,compiler->image.bytes,compiler->image.length)))) return 1;
    if(source){
        if(overlaps(target,bytes,source,sizeof *source)
                || overlaps(target,bytes,source->maps,source->map_count*sizeof(pl_x86_map)))return 1;
        for(pl_u32 i=0u;i<source->map_count;++i)
            if(overlaps(target,bytes,source->maps[i].bytes,source->maps[i].file_bytes))return 1;
    }
    return 0;
}

/* One typed interface serves isolated cuts and multi-function modules. */

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
    if (!status) status = cut_measure_body(&body, plan, &measured,&plan->imports);
    if (status) return status;
    wasm_module_prefix(&header,plan->imports,1u,1u+wasm_uleb_bytes(body.used)+body.used);
    wasm_writer_uleb(&header,body.used);
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
    if (result_aliases(compiler,0,options,sizeof *options,bytes,report,sizeof *report)) return WASM_COMPILER_ERROR_INPUT;
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
    if (result_aliases(compiler,source,options,sizeof *options,written,report,sizeof *report)) return WASM_COMPILER_ERROR_INPUT;
    pl_u64 bytes = plan.report.module_bytes;
    if (capacity < bytes) return WASM_COMPILER_ERROR_CAPACITY;
    if(target_aliases(compiler,source,options,sizeof *options,target,bytes,written,report,sizeof *report))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_writer writer = { target, capacity, 0u, 0 };
    wasm_module_prefix(&writer,plan.imports,1u,1u+wasm_uleb_bytes(body_bytes)+body_bytes);
    wasm_writer_uleb(&writer,body_bytes);
    status = cut_emit_body(&writer, &plan, &measured,plan.imports);
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
    if (result_aliases(0,source,options,sizeof *options,bytes,report,sizeof *report)) return WASM_COMPILER_ERROR_INPUT;
    *bytes = plan.report.module_bytes;
    if (report) *report = plan.report;
    return 0;
}
int wasm_compiler_emit_code_cut(const pl_x86_image *source, pl_u64 generation,
                                const wasm_cut_options *options, pl_u8 *target,
                                pl_u64 capacity, pl_u64 *written, wasm_cut_report *report)
{ return emit(0, source, generation, options, target, capacity, written, report); }

static int emit_module(const wasm_compiler *compiler,const pl_x86_image *source,pl_u64 generation,
    const wasm_cut_options *cuts,pl_u32 count,pl_u8 *target,pl_u64 capacity,
    pl_u64 *written,wasm_cut_report *reports,int projection)
{
    if(!cuts || !count || count>WASM_CUT_MODULE_MAX_FUNCTIONS || !target || !written)
        return WASM_COMPILER_ERROR_INPUT;
    if(projection && (compiler || !source || !source->map_count || source->map_count>2u))
        return WASM_COMPILER_ERROR_INPUT;
    pl_u32 limit=cuts[0].maximum_module_bytes,imports=0u;
    if(!limit || limit>WASM_CUT_MODULE_MAX_BYTES)return WASM_COMPILER_ERROR_INPUT;
    pl_u64 option_bytes=(pl_u64)count*sizeof *cuts,report_bytes=(pl_u64)count*sizeof *reports;
    pl_u64 code_bytes=wasm_uleb_bytes(count);
    cut_plan plan;pl_u64 bodies[WASM_CUT_MODULE_MAX_FUNCTIONS];
    /* One transient plan is recycled. No decoded-instruction population or
     * object-sized directory is materialized. Complete preflight precedes all
     * externally visible writes, including when a later cut is unlowered. */
    for(pl_u32 i=0u;i<count;++i){
        if(cuts[i].maximum_module_bytes!=limit || (i && cuts[i-1u].entry>=cuts[i].entry))
            return WASM_COMPILER_ERROR_INPUT;
        int status=prepare(compiler,source,generation,cuts+i,&plan,bodies+i);
        if(status)return status;
        imports|=plan.imports;
        if(!pl_checked_add_u64(code_bytes,wasm_uleb_bytes(bodies[i])+bodies[i],&code_bytes))
            return WASM_COMPILER_ERROR_CAPACITY;
    }
    wasm_writer measure={0,~0ull,0u,0};wasm_module_prefix(&measure,imports,count,code_bytes);
    pl_u64 code_total=measure.used+code_bytes-wasm_uleb_bytes(count),total=code_total;
    static const pl_u8 name[]=MACHINE_SOURCE_SECTION;
    pl_u32 metadata_bytes=0u;
    if(projection){
        metadata_bytes=wasm_uleb_bytes(sizeof name-1u)+(pl_u32)sizeof name-1u
            +MACHINE_SOURCE_HEADER_BYTES+count*MACHINE_SOURCE_ROW_BYTES+source->map_count*4096u;
        total+=1u+wasm_uleb_bytes(metadata_bytes)+metadata_bytes;
    }
    if(measure.error)return measure.error;
    if(total>limit || total>capacity)return WASM_COMPILER_ERROR_CAPACITY;
    if(result_aliases(compiler,source,cuts,option_bytes,written,reports,report_bytes)
            || target_aliases(compiler,source,cuts,option_bytes,target,total,written,reports,report_bytes))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_writer writer={target,capacity,0u,0};wasm_module_prefix(&writer,imports,count,code_bytes);
    wasm_writer metadata={target,capacity,code_total,0};
    if(projection){
        wasm_writer_byte(&metadata,0u);wasm_writer_uleb(&metadata,metadata_bytes);
        wasm_writer_uleb(&metadata,sizeof name-1u);
        for(pl_u32 i=0u;i<sizeof name-1u;++i)wasm_writer_byte(&metadata,name[i]);
        pl_u8 header[MACHINE_SOURCE_HEADER_BYTES]={0};
        pl_write_u32(header,MACHINE_SOURCE_VERSION);pl_write_u32(header+4u,MACHINE_ABI_VERSION);
        pl_write_u32(header+8u,MACHINE_ENTRY_ABI_VERSION);pl_write_u32(header+12u,count);
        pl_write_u64(header+16u,generation);pl_write_u32(header+24u,source->map_count);
        for(pl_u32 i=0u;i<sizeof header;++i)wasm_writer_byte(&metadata,header[i]);
    }
    for(pl_u32 i=0u;i<count;++i){
        pl_u64 body_bytes;int status=prepare(compiler,source,generation,cuts+i,&plan,&body_bytes);
        if(status || body_bytes!=bodies[i])return status?status:WASM_COMPILER_ERROR_GRAMMAR;
        wasm_writer_uleb(&writer,body_bytes);wasm_cut_report report;
        status=cut_emit_body(&writer,&plan,&report,imports);
        if(status)return status;
        report.module_bytes=total;if(reports)reports[i]=report;
        if(projection){
            pl_u8 row[MACHINE_SOURCE_ROW_BYTES]={0};
            pl_write_u32(row,(pl_u32)(cuts[i].entry-source->maps[0].address));
            pl_write_u16(row+4u,(pl_u16)report.source_bytes);
            pl_write_u16(row+6u,(pl_u16)report.source_instructions);
            pl_write_u16(row+8u,(pl_u16)cuts[i].maximum_source_instructions);
            pl_write_u32(row+12u,report.operand_binding);
            for(pl_u32 j=0u;j<sizeof row;++j)wasm_writer_byte(&metadata,row[j]);
        }
    }
    if(writer.error)return writer.error;
    if(writer.used!=code_total)return WASM_COMPILER_ERROR_GRAMMAR;
    if(projection){
        for(pl_u32 page=0u;page<source->map_count;++page)
            for(pl_u32 i=0u;i<4096u;++i)wasm_writer_byte(&metadata,source->maps[page].bytes[i]);
        if(metadata.error)return metadata.error;
        if(metadata.used!=total)return WASM_COMPILER_ERROR_GRAMMAR;
    }
    *written=total;return 0;
}
int wasm_compiler_emit_cut_module(const wasm_compiler *compiler,const wasm_cut_options *cuts,
    pl_u32 count,pl_u8 *target,pl_u64 capacity,pl_u64 *written,wasm_cut_report *reports)
{ return emit_module(compiler,0,0u,cuts,count,target,capacity,written,reports,0); }
int wasm_compiler_emit_code_module(const pl_x86_image *source,pl_u64 generation,const wasm_cut_options *cuts,
    pl_u32 count,pl_u8 *target,pl_u64 capacity,pl_u64 *written,wasm_cut_report *reports)
{ return emit_module(0,source,generation,cuts,count,target,capacity,written,reports,0); }
int wasm_compiler_emit_code_projection(const pl_x86_image *source,pl_u64 generation,const wasm_cut_options *cuts,
    pl_u32 count,pl_u8 *target,pl_u64 capacity,pl_u64 *written,wasm_cut_report *reports)
{ return emit_module(0,source,generation,cuts,count,target,capacity,written,reports,1); }
