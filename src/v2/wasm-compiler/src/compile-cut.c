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
                          const pl_u64 *written,const void *report,pl_u64 report_bytes)
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
    const pl_u64 *written,const void *reports,pl_u64 report_bytes)
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

static int prepare_plan(const wasm_compiler *compiler,const pl_x86_image *source,
    pl_u64 generation,const wasm_cut_options *options,cut_plan *plan)
{
    wasm_compile_report admission = { 0 };
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
    return status;
}

static int prepare(const wasm_compiler *compiler, const pl_x86_image *source,
                    pl_u64 generation, const wasm_cut_options *options,
                    cut_plan *plan, pl_u64 *body_bytes)
{
    wasm_cut_report measured;
    wasm_writer body = { .capacity=~0ull };
    wasm_writer header = { .capacity=~0ull };
    int status=prepare_plan(compiler,source,generation,options,plan);
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
    wasm_writer writer = { .bytes=target, .capacity=capacity };
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

typedef struct {
    const wasm_compiler *compiler;
    const pl_x86_image *source;
    const wasm_cut_options *cuts;
    const cut_body_extent *extents;
    pl_u64 generation;
    pl_u32 imports;
    cut_plan *plan;
} body_view;

typedef struct {
    cut_body_cursor cursor,boundary;
    pl_u32 slots[WASM_IMPORT_COUNT];
    pl_u64 length,total,fragment_bytes,fragment_offset;
    pl_u32 offset,available;
    pl_u8 bytes[512];
} body_stream;

static int body_stream_open(const body_view *view,pl_u32 rank,cut_plan *plan,body_stream *stream)
{
    int status=prepare_plan(view->compiler,view->source,view->generation,view->cuts+rank,plan);
    if(status)return status;
    plan->imports=view->extents[rank].imports;
    *stream=(body_stream){.length=view->extents[rank].length};
    wasm_import_map(view->imports,stream->slots);cut_body_open(plan,stream->slots,&stream->cursor);
    return 0;
}

static int body_stream_fill(body_stream *stream)
{
    if(stream->available)return 1;
    for(;;){
        if(stream->fragment_offset<stream->fragment_bytes)stream->cursor=stream->boundary;
        else{stream->boundary=stream->cursor;stream->fragment_offset=0u;stream->fragment_bytes=0u;}
        /* Replay only the current bounded ISA fragment, not the preceding
         * body. Long pure slices therefore do not pay a quadratic rescan. */
        wasm_writer writer={.bytes=stream->bytes,.capacity=stream->length,
            .window_start=stream->fragment_offset,.window_bytes=sizeof stream->bytes};
        int status=cut_body_next(&stream->cursor,&writer);
        if(status<0)return status;
        if(!status)return stream->total==stream->length
            && stream->cursor.cut.imports_used==stream->cursor.plan->imports?0:WASM_COMPILER_ERROR_GRAMMAR;
        if(stream->fragment_bytes && writer.used!=stream->fragment_bytes)return WASM_COMPILER_ERROR_GRAMMAR;
        stream->fragment_bytes=writer.used;
        pl_u64 bytes=writer.used-stream->fragment_offset;
        if(bytes>sizeof stream->bytes)bytes=sizeof stream->bytes;
        stream->fragment_offset+=bytes;stream->total+=bytes;
        if(stream->total>stream->length)return WASM_COMPILER_ERROR_GRAMMAR;
        stream->offset=0u;stream->available=(pl_u32)bytes;
        if(bytes)return 1; /* A zero-byte instruction still advances its cursor. */
    }
}

static int body_compare(const body_view *view,pl_u32 a,pl_u32 b,int *order)
{
    *order=0;
    if(a==b)return 0;
    if(view->extents[a].length!=view->extents[b].length){
        *order=view->extents[a].length<view->extents[b].length?-1:1;return 0;}
    /* Only a fixed window is opened, never a body or raw collection owner.
     * Reuse the actual emitter under the final shared import mapping; no
     * digest or source-opcode shortcut is an equality authority. */
    cut_plan right_plan;body_stream left,right;
    int status=body_stream_open(view,a,view->plan,&left);
    if(!status)status=body_stream_open(view,b,&right_plan,&right);
    if(status)return status;
    for(pl_u64 compared=0u;compared<view->extents[a].length;){
        int left_status=body_stream_fill(&left),right_status=body_stream_fill(&right);
        if(left_status<=0 || right_status<=0)return left_status<0?left_status
            :right_status<0?right_status:WASM_COMPILER_ERROR_GRAMMAR;
        pl_u32 bytes=left.available<right.available?left.available:right.available;
        for(pl_u32 i=0u;i<bytes;++i)if(left.bytes[left.offset+i]!=right.bytes[right.offset+i]){
            *order=left.bytes[left.offset+i]<right.bytes[right.offset+i]?-1:1;return 0;}
        compared+=bytes;left.offset+=bytes;right.offset+=bytes;left.available-=bytes;right.available-=bytes;
    }
    status=body_stream_fill(&left);if(status)return status<0?status:WASM_COMPILER_ERROR_GRAMMAR;
    status=body_stream_fill(&right);if(status)return status<0?status:WASM_COMPILER_ERROR_GRAMMAR;
    return 0;
}

/* Sort bounded ranks of virtual bodies before any public output write. */
static int body_quotient(const body_view *view,pl_u32 count,pl_u16 *classes,
    pl_u16 *representatives,pl_u32 *unique)
{
    pl_u16 order[WASM_CUT_MODULE_MAX_FUNCTIONS],scratch[WASM_CUT_MODULE_MAX_FUNCTIONS],
        first[WASM_CUT_MODULE_MAX_FUNCTIONS],sizes[WASM_CUT_MODULE_MAX_FUNCTIONS];
    for(pl_u32 i=0u;i<count;++i){order[i]=(pl_u16)i;first[i]=(pl_u16)i;sizes[i]=1u;}
    for(pl_u32 width=1u;width<count;width*=2u){
        for(pl_u32 begin=0u;begin<count;begin+=2u*width){
            pl_u32 middle=begin+width;if(middle>count)middle=count;
            pl_u32 left_end=begin+sizes[begin],right_end=middle+(middle<count?sizes[middle]:0u);
            pl_u32 a=begin,b=middle,out=begin;
            /* Collapse equal representatives DURING the merge. A repeated
             * population therefore needs count-1 exact comparisons, not
             * another full-population scan at every sorting level. */
            while(a<left_end || b<right_end){
                int comparison=0,status=0;
                if(a<left_end && b<right_end)status=body_compare(view,order[a],order[b],&comparison);
                if(status)return status;
                if(a<left_end && b<right_end && !comparison){
                    pl_u16 left=order[a++],right=order[b++];
                    pl_u16 minimum=left<right?left:right,maximum=left<right?right:left;
                    first[maximum]=minimum;scratch[out++]=minimum;
                }else scratch[out++]=(b==right_end || (a<left_end && comparison<0))?order[a++]:order[b++];
            }
            sizes[begin]=(pl_u16)(out-begin);
        }
        for(pl_u32 begin=0u;begin<count;begin+=2u*width)
            for(pl_u32 i=0u;i<sizes[begin];++i)order[begin+i]=scratch[begin+i];
    }
    *unique=0u;
    for(pl_u32 i=0u;i<count;++i){
        if(first[i]==i){classes[i]=(pl_u16)*unique;representatives[(*unique)++]=(pl_u16)i;}
        else {pl_u16 root=first[i];while(first[root]!=root)root=first[root];
            first[i]=root;classes[i]=classes[root];}
    }
    return 0;
}

static int emit_module(const wasm_compiler *compiler,const pl_x86_image *source,pl_u64 generation,
    const wasm_cut_options *cuts,pl_u32 count,pl_u8 *target,pl_u64 capacity,
    pl_u64 *written,wasm_cut_report *reports,int projection,
    const wasm_compile_options *image_options,wasm_compile_report *image_report)
{
    if(!cuts || !count || count>WASM_CUT_MODULE_MAX_FUNCTIONS || (!target && !image_options) || !written)
        return WASM_COMPILER_ERROR_INPUT;
    if(projection && (compiler || !source || !source->map_count || source->map_count>2u))
        return WASM_COMPILER_ERROR_INPUT;
    pl_u32 limit=cuts[0].maximum_module_bytes,imports=0u;
    if(!limit || limit>WASM_CUT_MODULE_MAX_BYTES)return WASM_COMPILER_ERROR_INPUT;
    pl_u64 option_bytes=(pl_u64)count*sizeof *cuts;
    pl_u64 report_bytes=image_options?sizeof *image_report:(pl_u64)count*sizeof *reports;
    void *result=image_options?(void *)image_report:(void *)reports;
    cut_plan plan;cut_body_extent bodies[WASM_CUT_MODULE_MAX_FUNCTIONS];
    /* One transient plan is recycled. No decoded-instruction population or
     * object-sized directory is materialized. Complete preflight precedes all
     * externally visible writes, including when a later cut is unlowered. */
    for(pl_u32 i=0u;i<count;++i){
        if(cuts[i].maximum_module_bytes!=limit || (i && cuts[i-1u].entry>=cuts[i].entry))
            return WASM_COMPILER_ERROR_INPUT;
        pl_u64 body_bytes;int status=prepare(compiler,source,generation,cuts+i,&plan,&body_bytes);
        if(status)return status;
        bodies[i]=(cut_body_extent){(pl_u32)body_bytes,plan.imports,plan.report.operand_binding,(pl_u32)plan.report.source_bytes};
        imports|=plan.imports;
    }
    pl_u16 classes[WASM_CUT_MODULE_MAX_FUNCTIONS],representatives[WASM_CUT_MODULE_MAX_FUNCTIONS];
    body_view view={compiler,source,cuts,bodies,generation,imports,&plan};pl_u32 unique;
    int status=body_quotient(&view,count,classes,representatives,&unique);if(status)return status;
    if(image_options && unique+1u>image_options->maximum_functions_per_module)return WASM_COMPILER_ERROR_CAPACITY;
    pl_u32 definitions=unique+(image_options?1u:0u);
    pl_u64 code_bytes=wasm_uleb_bytes(definitions),dispatch_bytes=0u;
    for(pl_u32 i=0u;i<unique;++i){pl_u32 rank=representatives[i];
        if(!pl_checked_add_u64(code_bytes,wasm_uleb_bytes(bodies[rank].length)+bodies[rank].length,&code_bytes))
            return WASM_COMPILER_ERROR_CAPACITY;
    }
    if(image_options){wasm_writer dispatch={.capacity=~0ull};
        cut_emit_dispatch(&dispatch,cuts,bodies,classes,count,wasm_import_count(imports));
        if(dispatch.error)return dispatch.error;
        dispatch_bytes=dispatch.used;code_bytes+=wasm_uleb_bytes(dispatch_bytes)+dispatch_bytes;}
    wasm_writer measure={.capacity=~0ull};
    if(image_options)wasm_module_image_prefix(&measure,imports,unique,count,classes,code_bytes);
    else wasm_module_alias_prefix(&measure,imports,unique,count,classes,code_bytes);
    pl_u64 code_total=measure.used+code_bytes-wasm_uleb_bytes(definitions),total=code_total;
    cut_image_metadata image_metadata={0};
    if(image_options){status=cut_image_metadata_measure(cuts,bodies,count,&image_metadata);if(status)return status;
        total+=1u+wasm_uleb_bytes(image_metadata.payload_bytes)+image_metadata.payload_bytes;}
    static const pl_u8 name[]=MACHINE_SOURCE_SECTION;
    pl_u32 metadata_bytes=0u;
    if(projection){
        metadata_bytes=wasm_uleb_bytes(sizeof name-1u)+(pl_u32)sizeof name-1u
            +MACHINE_SOURCE_HEADER_BYTES+count*MACHINE_SOURCE_ROW_BYTES+source->map_count*4096u;
        total+=1u+wasm_uleb_bytes(metadata_bytes)+metadata_bytes;
    }
    if(measure.error)return measure.error;
    if(total>limit || total>capacity)return WASM_COMPILER_ERROR_CAPACITY;
    if(result_aliases(compiler,source,cuts,option_bytes,written,result,report_bytes)
            || (target && target_aliases(compiler,source,cuts,option_bytes,target,total,written,result,report_bytes)))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_writer writer={.bytes=target,.capacity=capacity};
    if(image_options)wasm_module_image_prefix(&writer,imports,unique,count,classes,code_bytes);
    else wasm_module_alias_prefix(&writer,imports,unique,count,classes,code_bytes);
    wasm_writer metadata={.bytes=target,.capacity=capacity,.used=code_total};
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
        pl_u64 body_bytes;status=prepare(compiler,source,generation,cuts+i,&plan,&body_bytes);
        if(status || body_bytes!=bodies[i].length)return status?status:WASM_COMPILER_ERROR_GRAMMAR;
        wasm_cut_report report=plan.report;
        if(representatives[classes[i]]==i){
            wasm_writer_uleb(&writer,body_bytes);
            status=cut_emit_body(&writer,&plan,&report,imports);if(status)return status;
        }
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
    if(image_options){wasm_writer_uleb(&writer,dispatch_bytes);
        cut_emit_dispatch(&writer,cuts,bodies,classes,count,wasm_import_count(imports));}
    if(writer.error)return writer.error;
    if(writer.used!=code_total)return WASM_COMPILER_ERROR_GRAMMAR;
    if(image_options){status=cut_image_metadata_emit(&writer,&image_metadata,cuts,bodies,count,&plan.image,compiler->input_digest);
        if(status)return status;
        if(writer.used!=total)return WASM_COMPILER_ERROR_GRAMMAR;}
    if(projection){
        for(pl_u32 page=0u;page<source->map_count;++page)
            for(pl_u32 i=0u;i<4096u;++i)wasm_writer_byte(&metadata,source->maps[page].bytes[i]);
        if(metadata.error)return metadata.error;
        if(metadata.used!=total)return WASM_COMPILER_ERROR_GRAMMAR;
    }
    *written=total;
    if(image_report)*image_report=(wasm_compile_report){.functions=unique,.dispatchers=1u,
        .source_instructions=count,.modules=1u,.bytes=total};
    return 0;
}
int wasm_compiler_emit_cut_module(const wasm_compiler *compiler,const wasm_cut_options *cuts,
    pl_u32 count,pl_u8 *target,pl_u64 capacity,pl_u64 *written,wasm_cut_report *reports)
{ return emit_module(compiler,0,0u,cuts,count,target,capacity,written,reports,0,0,0); }
int wasm_compiler_emit_code_module(const pl_x86_image *source,pl_u64 generation,const wasm_cut_options *cuts,
    pl_u32 count,pl_u8 *target,pl_u64 capacity,pl_u64 *written,wasm_cut_report *reports)
{ return emit_module(0,source,generation,cuts,count,target,capacity,written,reports,0,0,0); }
int wasm_compiler_emit_code_projection(const pl_x86_image *source,pl_u64 generation,const wasm_cut_options *cuts,
    pl_u32 count,pl_u8 *target,pl_u64 capacity,pl_u64 *written,wasm_cut_report *reports)
{ return emit_module(0,source,generation,cuts,count,target,capacity,written,reports,1,0,0); }

int wasm_emit_image_collection(const wasm_compiler *compiler,const wasm_compile_options *options,
    const wasm_cut_options *cuts,pl_u32 count,pl_u8 *target,pl_u64 capacity,
    pl_u64 *written,wasm_compile_report *report)
{
    if(result_aliases(compiler,0,(const wasm_cut_options *)options,sizeof *options,written,report,sizeof *report)
            || (target && target_aliases(compiler,0,(const wasm_cut_options *)options,sizeof *options,
                target,capacity,written,report,sizeof *report)))return WASM_COMPILER_ERROR_INPUT;
    return emit_module(compiler,0,0u,cuts,count,target,capacity,written,0,0,options,report);
}
