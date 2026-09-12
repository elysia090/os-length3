#include "internal/closure.h"

int pl_x86_close_direct(const pl_x86_frontend *frontend,
                        const pl_x86_block_workspace *workspace,
                        const pl_x86_instruction *instruction,
                        pl_x86_rank_resolver resolve, void *opaque,
                        pl_direct_block *out)
{
    if (!frontend || !workspace || !instruction || !resolve || !out)
        return PL_ERROR_BLOCK;
    pl_x86_block block;
    int status = pl_x86_block_lower(
        frontend, instruction->rip, workspace, &block);
    if (status) return status;
    if (block.kind == PL_X86_BLOCK_DIRECT) {
        pl_u32 successor[2] = {
            PL_X86_BLOCK_RESOLVE_RANK, PL_X86_BLOCK_RESOLVE_RANK,
        };
        for (pl_u32 arm = 0u; arm < block.successor_count; ++arm) {
            int found = resolve(opaque, block.successor[arm], &successor[arm]);
            if (found < 0) return found;
            if (!found) successor[arm] = PL_X86_BLOCK_RESOLVE_RANK;
        }
        status = pl_x86_block_direct(&block, successor, out);
    } else {
        status = pl_x86_block_terminal_direct(instruction, &block, out);
    }
    return status;
}
