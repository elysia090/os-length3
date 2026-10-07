#include "image-internal.h"
#include <support/checked.h>
int wasm_image_open(const wasm_compiler *compiler,wasm_image_view *view)
{
    wasm_compile_report admission={0};int status=wasm_lower_machine_abi(compiler,&admission);
    if(status)return status;
    pl_elf_image elf;pl_u32 count;
    if(pl_elf_open(compiler->image.bytes,compiler->image.length,&elf)
            || pl_x86_elf_map_count(&elf,&count))return WASM_COMPILER_ERROR_PROOF;
    if(count>64u)return WASM_COMPILER_ERROR_CAPACITY;
    if(pl_x86_image_from_elf(&elf,0u,1u,view->maps,64u,&view->image))return WASM_COMPILER_ERROR_PROOF;
    view->coordinates=0u;
    for(pl_u32 i=0u;i<count;++i)
        if(!pl_checked_add_u64(view->coordinates,view->maps[i].memory_bytes,&view->coordinates))return WASM_COMPILER_ERROR_CAPACITY;
    return view->coordinates?0:WASM_COMPILER_ERROR_PROOF;
}
