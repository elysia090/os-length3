#ifndef CHECK_FAULT_ADMISSION_H
#define CHECK_FAULT_ADMISSION_H
#include <wasm-compiler/cut.h>
#include <x86/semantics.h>
#include <stdio.h>
/* Only explicitly marked architectural-fault test rows use this positive
 * admission. Legal, unimplemented operations still test immutable refusal.
 * Independent native/page-priority/runtime observations live in fault-cut. */
static int check_fault_admission(const pl_x86_image *image,const wasm_cut_options *options,pl_u8 vector)
{
    pl_x86_instruction instruction={0};pl_x86_fault_cut fault;pl_u8 module[4096];
    wasm_cut_report report;pl_u64 bytes=0u;
    if(pl_x86_decode_profile(image,options->entry,&instruction)
            || !pl_x86_fault_cut_lower(&instruction,&fault) || fault.vector!=vector
            || wasm_compiler_emit_code_cut(image,9u,options,module,sizeof module,&bytes,&report)
            || report.boundary!=WASM_CUT_FAULT || report.continuation!=options->entry
            || report.source_instructions!=1u || report.source_bytes!=fault.bytes
            || report.read_registers || report.written_registers || report.flags_written
            || report.memory_bytes || !bytes){
        fprintf(stderr,"fault admission: source=%02x%02x%02x%02x vector=%u flow=%u status=%u machine=%u\n",
            instruction.source[0],instruction.source[1],instruction.source[2],instruction.source[3],
            instruction.trap_vector,instruction.flow,instruction.status,instruction.machine_operation);
        return -1;
    }
    return 0;
}
#endif
