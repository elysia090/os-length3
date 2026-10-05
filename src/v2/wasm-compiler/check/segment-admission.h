#ifndef CHECK_SEGMENT_ADMISSION_H
#define CHECK_SEGMENT_ADMISSION_H
#include <wasm-compiler/cut.h>
#include <machine/memory.h>
/* Positive counterpart of the former FS/GS admission refusals. Runtime base,
 * fault and residency behavior is checked by the separate native/C-MMU oracle. */
static int check_segment_admission(const pl_x86_image *image,const wasm_cut_options *options,pl_u32 prefix)
{
    pl_u8 module[4096];pl_u64 bytes=0u;wasm_cut_report report;
    pl_u32 role=prefix==0x64u?MACHINE_MEMORY_FS:MACHINE_MEMORY_GS;
    return wasm_compiler_emit_code_cut(image,9u,options,module,sizeof module,&bytes,&report)
        || !bytes || report.source_instructions!=1u || !report.memory_bytes
        || !(report.memory_access & role);
}
#endif
