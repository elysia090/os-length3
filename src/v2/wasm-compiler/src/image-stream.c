#include <wasm-compiler/image.h>
#include "cut-internal.h"
#include "image-internal.h"
#include <support/checked.h>
#include <support/sha256.h>
#include <stdint.h>

static int overlap(const void *left,pl_u64 a,const void *right,pl_u64 b)
{
    pl_u64 x=(pl_u64)(uintptr_t)left,y=(pl_u64)(uintptr_t)right;
    return a && b && (x<=y?y-x<a:x-y<b);
}
static int range(const void *pointer,pl_u64 bytes)
{return pointer && bytes<=(pl_u64)UINTPTR_MAX-(pl_u64)(uintptr_t)pointer;}
static int output_alias(const wasm_compiler *compiler,const void *output,pl_u64 bytes)
{
    return !range(output,bytes) || overlap(output,bytes,compiler,sizeof *compiler)
        || overlap(output,bytes,compiler->image.bytes,compiler->image.length);
}
static void init(const wasm_image_plan *plan,const wasm_image_view *view,wasm_image_iterator *iterator)
{
    *iterator=(wasm_image_iterator){.plan=plan,.image=view->image};
    for(pl_u32 i=0u;i<view->image.map_count;++i)iterator->maps[i]=view->maps[i];
    iterator->image.maps=iterator->maps;
}
static int partition(wasm_image_iterator *iterator,pl_u8 *target,pl_u64 capacity,wasm_image_module *module)
{
    if(iterator->map==iterator->image.map_count)return 0;
    const pl_x86_map *map=iterator->maps+iterator->map;
    pl_u64 remaining=map->memory_bytes-iterator->offset;
    pl_u32 count=remaining>WASM_CUT_MODULE_MAX_FUNCTIONS?WASM_CUT_MODULE_MAX_FUNCTIONS:(pl_u32)remaining;
    wasm_cut_options cuts[WASM_CUT_MODULE_MAX_FUNCTIONS];
    for(pl_u32 i=0u;i<count;++i)cuts[i]=(wasm_cut_options){map->address+iterator->offset+i,1u,
        iterator->plan->options.maximum_module_bytes};
    pl_u64 written=0u;wasm_compile_report report;int status;
    for(;;){
        status=wasm_emit_image_collection(iterator->plan->compiler,&iterator->plan->options,cuts,count,
            target,capacity,&written,&report);
        if(status!=WASM_COMPILER_ERROR_CAPACITY || count==1u)break;
        count/=2u;
    }
    if(status)return status;
    *module=(wasm_image_module){.first=cuts[0].entry,.end=cuts[0].entry+count,.code=report};
    iterator->offset+=count;iterator->coordinates+=count;++iterator->modules;iterator->bytes+=written;
    if(iterator->offset==map->memory_bytes){++iterator->map;iterator->offset=0u;}
    return 1;
}
int wasm_compiler_prepare_image(const wasm_compiler *compiler,
    const wasm_compile_options *options,wasm_image_plan *plan)
{
    if(!compiler || !options || !plan || !options->maximum_functions_per_module || !options->maximum_module_bytes)
        return WASM_COMPILER_ERROR_INPUT;
    if(output_alias(compiler,plan,sizeof *plan) || overlap(plan,sizeof *plan,options,sizeof *options))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_image_view view;int status=wasm_image_open(compiler,&view);if(status)return status;
    wasm_image_plan made={.compiler=compiler,.input=compiler->image.bytes,.input_bytes=compiler->image.length,.options=*options};
    if(made.options.maximum_module_bytes>WASM_CUT_MODULE_MAX_BYTES)made.options.maximum_module_bytes=WASM_CUT_MODULE_MAX_BYTES;
    wasm_image_iterator iterator;init(&made,&view,&iterator);wasm_image_module module;
    while((status=partition(&iterator,0,made.options.maximum_module_bytes,&module))>0){
        if(!pl_checked_add_u64(made.report.functions,module.code.functions,&made.report.functions)
                || !pl_checked_add_u64(made.report.bytes,module.code.bytes,&made.report.bytes))return WASM_COMPILER_ERROR_CAPACITY;
        if(module.code.bytes>made.maximum_module_bytes)made.maximum_module_bytes=(pl_u32)module.code.bytes;
    }
    if(status)return status;
    if(iterator.coordinates!=view.coordinates)return WASM_COMPILER_ERROR_GRAMMAR;
    made.report.dispatchers=made.report.modules=iterator.modules;made.report.source_instructions=view.coordinates;
    for(pl_u32 i=0u;i<sizeof made.input_digest;++i)made.input_digest[i]=compiler->input_digest[i];
    *plan=made;return 0;
}
static int plan_current(const wasm_image_plan *plan)
{
    return plan && plan->compiler && plan->input==plan->compiler->image.bytes
        && plan->input_bytes==plan->compiler->image.length && plan->options.maximum_functions_per_module
        && plan->options.maximum_module_bytes && plan->options.maximum_module_bytes<=WASM_CUT_MODULE_MAX_BYTES
        && plan->maximum_module_bytes && plan->maximum_module_bytes<=plan->options.maximum_module_bytes
        && plan->report.modules && plan->report.dispatchers==plan->report.modules;
}
int wasm_image_iterator_open(const wasm_image_plan *plan,wasm_image_iterator *iterator)
{
    if(!plan_current(plan) || !iterator)return WASM_COMPILER_ERROR_INPUT;
    if(output_alias(plan->compiler,iterator,sizeof *iterator) || overlap(iterator,sizeof *iterator,plan,sizeof *plan))
        return WASM_COMPILER_ERROR_INPUT;
    pl_u8 digest[32];pl_sha256_digest(plan->input,plan->input_bytes,digest);
    for(pl_u32 i=0u;i<sizeof digest;++i)if(digest[i]!=plan->input_digest[i])return WASM_COMPILER_ERROR_PROOF;
    wasm_image_view view;int status=wasm_image_open(plan->compiler,&view);if(status)return status;
    if(view.coordinates!=plan->report.source_instructions)return WASM_COMPILER_ERROR_PROOF;
    init(plan,&view,iterator);return 0;
}
int wasm_image_iterator_next(wasm_image_iterator *iterator,pl_u8 *target,
    pl_u64 capacity,wasm_image_module *module)
{
    if(!iterator || !plan_current(iterator->plan) || !target || !module)return WASM_COMPILER_ERROR_INPUT;
    const wasm_image_plan *plan=iterator->plan;
    if(output_alias(plan->compiler,target,capacity) || output_alias(plan->compiler,module,sizeof *module)
            || overlap(target,capacity,iterator,sizeof *iterator) || overlap(target,capacity,plan,sizeof *plan)
            || overlap(target,capacity,module,sizeof *module) || overlap(module,sizeof *module,iterator,sizeof *iterator)
            || overlap(module,sizeof *module,plan,sizeof *plan))return WASM_COMPILER_ERROR_INPUT;
    if(capacity<plan->maximum_module_bytes)return WASM_COMPILER_ERROR_CAPACITY;
    if(iterator->finished)return 0;
    int status=partition(iterator,target,capacity,module);
    if(!status){
        if(iterator->modules!=plan->report.modules || iterator->coordinates!=plan->report.source_instructions
                || iterator->bytes!=plan->report.bytes)return WASM_COMPILER_ERROR_GRAMMAR;
        iterator->finished=1u;
    }
    return status;
}
