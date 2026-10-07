#include "cut-internal.h"
#include <stdint.h>

static int overlaps(const void *left,pl_u64 left_bytes,const void *right,pl_u64 right_bytes)
{
    pl_u64 a=(pl_u64)(uintptr_t)left,b=(pl_u64)(uintptr_t)right;
    return left_bytes && right_bytes && (a<=b?b-a<left_bytes:a-b<right_bytes);
}

typedef struct { const pl_x86_image *image;wasm_coverage_report *report; } coverage_owner;
static int visit(const pl_x86_instruction *instruction,void *pointer)
{
    coverage_owner *owner=pointer;wasm_coverage_report *report=owner->report;
    wasm_cut_options options={instruction->rip,1u,65536u};cut_plan plan;
    int status=cut_prepare_image(owner->image,&options,&plan);
    if(!status){
        wasm_writer writer={.capacity=~0ull};wasm_cut_report measured;pl_u32 imports=0u;
        status=cut_measure_body(&writer,&plan,&measured,&imports);
        if(!status){
            wasm_writer header={.capacity=~0ull};
            wasm_module_prefix(&header,imports,1u,1u+wasm_uleb_bytes(writer.used)+writer.used);
            wasm_writer_uleb(&header,writer.used);
            if(header.error || header.used+writer.used>options.maximum_module_bytes)
                status=WASM_COMPILER_ERROR_CAPACITY;
        }
    }
    if(!status){++report->lowerable;return 0;}
    if(status==WASM_COMPILER_ERROR_FETCH)++report->fetch_demands;
    else if(status==WASM_COMPILER_ERROR_CAPACITY)++report->capacity_refusals;
    else if(status==WASM_COMPILER_ERROR_GRAMMAR){
        if(instruction->flow==PL_X86_FLOW_FAULT)++report->unlowered_faults;
        else ++report->unlowered_valid;
        if(instruction->operation<=PL_X86_OPERATION_MAX)++report->operations[instruction->operation];
        if(instruction->machine_operation<=PL_X86_MACHINE_EXTENSION)
            ++report->machine_operations[instruction->machine_operation];
        if(instruction->machine_operation==PL_X86_MACHINE_X87)
            ++report->x87_operations[instruction->machine_argument&255u];
        if(instruction->machine_operation==PL_X86_MACHINE_VECTOR)
            ++report->vector_operations[instruction->machine_argument&255u];
    }else return status;
    if(!report->first_status){
        report->first_status=status;report->first_unlowered=instruction->rip;
        report->first_operation=instruction->operation;report->first_machine_operation=instruction->machine_operation;
        report->first_decode_status=instruction->status;report->first_source_bytes=instruction->source_bytes;
        for(pl_u32 i=0u;i<instruction->source_bytes;++i)report->first_source[i]=instruction->source[i];
    }
    return 0;
}
int wasm_compiler_coverage(const wasm_compiler *compiler,wasm_coverage_report *report)
{
    if(!compiler || !report)return WASM_COMPILER_ERROR_INPUT;
    if((pl_u64)(uintptr_t)report>(pl_u64)UINTPTR_MAX-sizeof *report
            || overlaps(report,sizeof *report,compiler,sizeof *compiler)
            || overlaps(report,sizeof *report,compiler->image.bytes,compiler->image.length))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_compile_report admission={0};int status=wasm_lower_machine_abi(compiler,&admission);
    if(status)return status;
    pl_elf_image elf;pl_u32 count=0u;
    if(pl_elf_open(compiler->image.bytes,compiler->image.length,&elf)
            || pl_x86_elf_map_count(&elf,&count))return WASM_COMPILER_ERROR_PROOF;
    if(count>64u)return WASM_COMPILER_ERROR_CAPACITY;
    pl_x86_map maps[64];pl_x86_image image;
    if(pl_x86_image_from_elf(&elf,0u,1u,maps,64u,&image))return WASM_COMPILER_ERROR_PROOF;
    wasm_coverage_report measured={0};coverage_owner owner={&image,&measured};
    status=pl_x86_catalog_profile(&image,visit,&owner,&measured.catalog);
    if(status)return status;
    if(measured.catalog.coordinates!=measured.lowerable+measured.unlowered_valid+measured.unlowered_faults
            +measured.fetch_demands+measured.capacity_refusals)return WASM_COMPILER_ERROR_GRAMMAR;
    *report=measured;return 0;
}
