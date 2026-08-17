/* Fusible traces over the block graph.  See include/postlink/trace.h. */

#include <postlink/trace.h>

int pl_trace_edges(const pl_directory *directory,
                   pl_u32 *successor, pl_u8 *predecessor)
{
    pl_u32 count = directory->counts.block_count;
    for (pl_u32 index = 0; index < count; ++index) {
        successor[index] = PL_NO_BLOCK;
        predecessor[index] = PL_PRED_NONE;
    }

    for (pl_u32 index = 0; index < count; ++index) {
        pl_admission admission;
        int status = pl_directory_admit(directory, index, &admission);
        if (status) return status;

        pl_successors successors;
        pl_static_successors(&admission, &successors);
        /* Exactly one successor, or the boundary is a real branch point and
         * nothing can be composed across it. */
        if (successors.count != 1u) continue;

        pl_chain_target target;
        if (pl_chain_resolve(directory, successors.rip[0], &target)) continue;
        /* Several proof variants at the coordinate means the runtime chooses
         * between them, so the edge is not a constant. */
        if (target.variants != 1u) continue;

        successor[index] = target.index;
    }

    /* Count only the edges recorded above.  A successor reached from two such
     * edges is a join, and a join cannot be absorbed into either predecessor. */
    for (pl_u32 index = 0; index < count; ++index) {
        pl_u32 next = successor[index];
        if (next == PL_NO_BLOCK) continue;
        if (predecessor[next] < PL_PRED_MANY) predecessor[next] += 1u;
    }

    /* A block whose successor has other predecessors that this pass did not
     * record -- a branch target, a dynamic transfer -- must not be treated as
     * having one predecessor.  Recover that by counting every static edge,
     * including the ones with two successors, as reaching its target. */
    for (pl_u32 index = 0; index < count; ++index) {
        pl_admission admission;
        if (pl_directory_admit(directory, index, &admission)) continue;
        pl_successors successors;
        pl_static_successors(&admission, &successors);
        if (successors.count < 2u) continue;
        for (pl_u32 slot = 0; slot < successors.count; ++slot) {
            pl_chain_target target;
            if (pl_chain_resolve(directory, successors.rip[slot], &target))
                continue;
            predecessor[target.index] = PL_PRED_MANY;
        }
    }
    return 0;
}

pl_u32 pl_trace_run(const pl_u32 *successor, const pl_u8 *predecessor,
                    pl_u32 block_count, pl_u32 index, pl_u8 *visited,
                    pl_u32 *last)
{
    pl_u32 length = 1;
    pl_u32 cursor = index;
    if (visited) visited[cursor] = 1;
    while (cursor < block_count
            && pl_trace_fusible(successor, predecessor, cursor)) {
        pl_u32 next = successor[cursor];
        /* A backedge closes the run rather than extending it: composing a
         * block into itself is a recurrence, not a fusion, and that is the
         * closure's decision to make. */
        if (visited && visited[next]) break;
        if (next == index) break;
        cursor = next;
        if (visited) visited[cursor] = 1;
        length += 1u;
    }
    if (last) *last = cursor;
    return length;
}
