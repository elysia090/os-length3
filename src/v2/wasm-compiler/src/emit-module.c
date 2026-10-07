#include "cut-internal.h"
#include "image-internal.h"

int wasm_emit_image(const wasm_compiler *compiler,const wasm_compile_options *options,
    pl_u8 *target,pl_u64 capacity,pl_u64 *written,wasm_compile_report *report)
{
    wasm_image_view view;int status=wasm_image_open(compiler,&view);if(status)return status;
    /* Actual final PF_X memory extents include zero-fill and interior entries.
     * Proof/source function counts do not identify this code domain. */
    /* The bounded collector must not publish a truncated directory. */
    if(view.coordinates>WASM_CUT_MODULE_MAX_FUNCTIONS)return WASM_COMPILER_ERROR_INCOMPLETE;
    pl_u32 limit=options->maximum_module_bytes;
    if(limit>WASM_CUT_MODULE_MAX_BYTES)limit=WASM_CUT_MODULE_MAX_BYTES;
    wasm_cut_options cuts[WASM_CUT_MODULE_MAX_FUNCTIONS];pl_u32 count=0u;
    for(pl_u32 i=0u;i<view.image.map_count;++i)for(pl_u64 offset=0u;offset<view.maps[i].memory_bytes;++offset)
        cuts[count++]=(wasm_cut_options){view.maps[i].address+offset,1u,limit};
    return wasm_emit_image_collection(compiler,options,cuts,count,target,capacity,written,report);
}

static int compile(const wasm_compiler *compiler,
                   const wasm_compile_options *options,
                   pl_u8 *target, pl_u64 capacity, pl_u64 *written,
                   wasm_compile_report *report)
{
    if (!compiler || !options || !written
            || !options->maximum_functions_per_module
            || !options->maximum_module_bytes)
        return WASM_COMPILER_ERROR_INPUT;
    return wasm_emit_image(compiler,options,target,capacity,written,report);
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
