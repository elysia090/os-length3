/* Privileged cold construction exports; never imports of generated guest code. */
#include <wasm-compiler/cut.h>
#include <wasm-compiler/image.h>
#include <machine/entry.h>
#include <stdint.h>

extern unsigned char __heap_base;
static wasm_compiler compiler;
static pl_x86_map maps[2];
static pl_x86_image source;
static pl_u32 mode;
static pl_u64 source_generation;
static wasm_image_plan image_plan;
static wasm_image_iterator image_iterator;
static pl_u32 image_ready;

_Static_assert(sizeof(wasm_cut_report) == 80u, "cut report transport extent");
_Static_assert(__builtin_offsetof(wasm_cut_report, operand_binding) == 76u,
    "scalar binding fills the old report tail padding");

pl_u32 compiler_static_min(void) { return COLD_STATIC_MIN; }
pl_u32 compiler_arena_min(void)
{ return ((pl_u32)(uintptr_t)&__heap_base + 4095u) & ~4095u; }
pl_u32 compiler_report_bytes(void) { return sizeof(wasm_cut_report); }
pl_u32 compiler_entry_abi(void) { return MACHINE_ENTRY_ABI_VERSION; }

static int range(pl_u32 offset, pl_u64 bytes)
{
    return offset >= compiler_arena_min()
        && (pl_u64)offset + bytes <= (pl_u64)__builtin_wasm_memory_size(0) * 65536u;
}

void compiler_close(void)
{
    image_ready=0u;image_plan=(wasm_image_plan){0};image_iterator=(wasm_image_iterator){0};
    compiler = (wasm_compiler){0}; source = (pl_x86_image){0};
    maps[0] = maps[1] = (pl_x86_map){0}; mode = 0u; source_generation = 0u;
}

int compiler_open_elf(pl_u32 offset, pl_u32 bytes)
{
    compiler_close();
    if (!bytes || !range(offset,bytes)) return WASM_COMPILER_ERROR_INPUT;
    int status = wasm_compiler_open(&compiler,(const pl_u8 *)(uintptr_t)offset,bytes);
    if (!status) mode = 1u;
    return status;
}

int compiler_open_fragments(pl_u32 first, pl_u32 second, pl_u32 count,
                            pl_u64 address, pl_u64 generation)
{
    compiler_close();
    if (!count || count > 2u || !generation || (address & 4095u)
            || address > ~0ull - (pl_u64)count * 4096u
            || !range(first,4096u) || (count == 2u && !range(second,4096u)))
        return WASM_COMPILER_ERROR_INPUT;
    for (pl_u32 i = 0u; i < count; ++i)
        maps[i] = (pl_x86_map){(const pl_u8 *)(uintptr_t)(i ? second : first),
                              address + (pl_u64)i * 4096u,4096u,4096u,
                              PL_ELF_FLAG_EXECUTE,generation};
    source = (pl_x86_image){maps,count,0u,address};
    if (pl_x86_image_validate(&source)) { compiler_close(); return WASM_COMPILER_ERROR_INPUT; }
    mode = 2u; source_generation = generation;
    return 0;
}

/* Contiguous standalone input is the same image admission, not a runtime
 * fallback. Fragment order is virtual; physical fragments may alias. */
int compiler_open_pages(pl_u32 offset, pl_u32 count, pl_u64 address, pl_u64 generation)
{
    if (count == 2u && (pl_u64)offset + 4096u > UINT32_MAX) {
        compiler_close(); return WASM_COMPILER_ERROR_INPUT;
    }
    return compiler_open_fragments(offset,offset + 4096u,count,address,generation);
}

static int overlaps(pl_u32 left, pl_u64 left_bytes, const void *right, pl_u64 right_bytes)
{
    pl_u64 a = left, b = (pl_u32)(uintptr_t)right;
    return left_bytes && right_bytes && (a <= b ? b - a < left_bytes : a - b < right_bytes);
}

/* Report and target are caller-owned disjoint reservations, above C static
 * data/stack. Source/CPU/load attestation and an immutable borrowed input
 * lifetime are the supervisor's obligations. These exports neither publish
 * a function table nor confer execution admission. They cannot compile an
 * unimplemented instruction or turn a prefix into a whole-image proof. */
int compiler_emit(pl_u64 entry, pl_u32 maximum_instructions,
                    pl_u32 target, pl_u32 capacity, pl_u32 report_offset)
{
    if (!mode || !capacity || !range(target,capacity) || (report_offset & 7u)
            || !range(report_offset,sizeof(wasm_cut_report))
            || overlaps(target,capacity,(const void *)(uintptr_t)report_offset,sizeof(wasm_cut_report)))
        return WASM_COMPILER_ERROR_INPUT;
    /* Check full reservations before planning; a short result must not make
     * an overlapping output reservation appear to be a valid borrowed view. */
    if (mode == 1u) {
        if (overlaps(target,capacity,compiler.image.bytes,compiler.image.length)
                || overlaps(report_offset,sizeof(wasm_cut_report),compiler.image.bytes,compiler.image.length))
            return WASM_COMPILER_ERROR_INPUT;
    } else for (pl_u32 i = 0u; i < source.map_count; ++i) {
        if (overlaps(target,capacity,maps[i].bytes,maps[i].file_bytes)
                || overlaps(report_offset,sizeof(wasm_cut_report),maps[i].bytes,maps[i].file_bytes))
            return WASM_COMPILER_ERROR_INPUT;
    }
    wasm_cut_options options = {entry,maximum_instructions,capacity};
    wasm_cut_report *report = (wasm_cut_report *)(uintptr_t)report_offset;
    pl_u64 written = 0u;
    if (mode == 1u)
        return wasm_compiler_emit_cut(&compiler,&options,(pl_u8 *)(uintptr_t)target,
                                      capacity,&written,report);
    return wasm_compiler_emit_code_cut(&source,source_generation,&options,
                                       (pl_u8 *)(uintptr_t)target,capacity,&written,report);
}

static int emit_collection(pl_u32 cut_offset,pl_u32 count,pl_u32 target,pl_u32 capacity,pl_u32 report_offset,int projection)
{
    pl_u64 cut_bytes=(pl_u64)count*sizeof(wasm_cut_options),report_bytes=(pl_u64)count*sizeof(wasm_cut_report);
    if(!mode || (projection && mode!=2u) || !count || count>WASM_CUT_MODULE_MAX_FUNCTIONS || !capacity || capacity>WASM_CUT_MODULE_MAX_BYTES
            || (cut_offset&7u) || (report_offset&7u) || !range(cut_offset,cut_bytes)
            || !range(target,capacity) || !range(report_offset,report_bytes)
            || overlaps(target,capacity,(const void *)(uintptr_t)report_offset,report_bytes)
            || overlaps(target,capacity,(const void *)(uintptr_t)cut_offset,cut_bytes)
            || overlaps(report_offset,report_bytes,(const void *)(uintptr_t)cut_offset,cut_bytes))
        return WASM_COMPILER_ERROR_INPUT;
    if(mode==1u){
        if(overlaps(target,capacity,compiler.image.bytes,compiler.image.length)
                || overlaps(report_offset,report_bytes,compiler.image.bytes,compiler.image.length))return WASM_COMPILER_ERROR_INPUT;
    }else for(pl_u32 i=0u;i<source.map_count;++i)
        if(overlaps(target,capacity,maps[i].bytes,maps[i].file_bytes)
                || overlaps(report_offset,report_bytes,maps[i].bytes,maps[i].file_bytes))return WASM_COMPILER_ERROR_INPUT;
    const wasm_cut_options *cuts=(const wasm_cut_options *)(uintptr_t)cut_offset;
    pl_u64 written=0u;wasm_cut_report *reports=(wasm_cut_report *)(uintptr_t)report_offset;
    if(projection)return wasm_compiler_emit_code_projection(&source,source_generation,cuts,count,
        (pl_u8 *)(uintptr_t)target,capacity,&written,reports);
    return mode==1u?wasm_compiler_emit_cut_module(&compiler,cuts,count,(pl_u8 *)(uintptr_t)target,capacity,&written,reports)
        :wasm_compiler_emit_code_module(&source,source_generation,cuts,count,(pl_u8 *)(uintptr_t)target,capacity,&written,reports);
}
int compiler_emit_module(pl_u32 cut_offset,pl_u32 count,pl_u32 target,pl_u32 capacity,pl_u32 report_offset)
{return emit_collection(cut_offset,count,target,capacity,report_offset,0);}
int compiler_emit_projection(pl_u32 cut_offset,pl_u32 count,pl_u32 target,pl_u32 capacity,pl_u32 report_offset)
{return emit_collection(cut_offset,count,target,capacity,report_offset,1);}

pl_u32 compiler_image_report_bytes(void){return sizeof(wasm_compile_report);}
int compiler_emit_image(pl_u32 functions,pl_u32 module_bytes,pl_u32 target,pl_u32 capacity,pl_u32 report_offset)
{
    if(mode!=1u || !capacity || !range(target,capacity) || (report_offset&7u)
            || !range(report_offset,sizeof(wasm_compile_report))
            || overlaps(target,capacity,(const void *)(uintptr_t)report_offset,sizeof(wasm_compile_report))
            || overlaps(target,capacity,compiler.image.bytes,compiler.image.length)
            || overlaps(report_offset,sizeof(wasm_compile_report),compiler.image.bytes,compiler.image.length))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_compile_options options={functions,module_bytes};pl_u64 written=0u;
    return wasm_compiler_emit(&compiler,&options,(pl_u8 *)(uintptr_t)target,capacity,&written,
        (wasm_compile_report *)(uintptr_t)report_offset);
}

int compiler_prepare_image(pl_u32 functions,pl_u32 module_bytes,pl_u32 report_offset)
{
    image_ready=0u;image_plan=(wasm_image_plan){0};image_iterator=(wasm_image_iterator){0};
    if(mode!=1u || (report_offset&7u) || !range(report_offset,sizeof(wasm_compile_report))
            || overlaps(report_offset,sizeof(wasm_compile_report),compiler.image.bytes,compiler.image.length))
        return WASM_COMPILER_ERROR_INPUT;
    wasm_compile_options options={functions,module_bytes};
    int status=wasm_compiler_prepare_image(&compiler,&options,&image_plan);
    if(status)return status;
    *(wasm_compile_report *)(uintptr_t)report_offset=image_plan.report;image_ready=1u;return 0;
}
pl_u32 compiler_image_module_bytes(void){return sizeof(wasm_image_module);}
int compiler_image_next(pl_u32 target,pl_u32 capacity,pl_u32 info_offset)
{
    if(mode!=1u || !image_ready || !capacity || !range(target,capacity) || (info_offset&7u)
            || !range(info_offset,sizeof(wasm_image_module))
            || overlaps(target,capacity,(const void *)(uintptr_t)info_offset,sizeof(wasm_image_module))
            || overlaps(target,capacity,compiler.image.bytes,compiler.image.length)
            || overlaps(info_offset,sizeof(wasm_image_module),compiler.image.bytes,compiler.image.length))return WASM_COMPILER_ERROR_INPUT;
    if(image_ready==1u){int status=wasm_image_iterator_open(&image_plan,&image_iterator);if(status){image_ready=0u;return status;}image_ready=2u;}
    return wasm_image_iterator_next(&image_iterator,(pl_u8 *)(uintptr_t)target,capacity,
        (wasm_image_module *)(uintptr_t)info_offset);
}
