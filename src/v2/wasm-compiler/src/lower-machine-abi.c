#include "internal.h"
#include <machine/state.h>

int wasm_lower_machine_abi(const wasm_compiler *compiler,
                           wasm_compile_report *report)
{
    if (!compiler || !report
            || compiler->image.proof.machine_abi != MACHINE_ABI_VERSION
            || compiler->function_count == 0u
            || compiler->coordinate_count == 0u)
        return WASM_COMPILER_ERROR_PROOF;
    report->functions = compiler->function_count;
    return 0;
}
