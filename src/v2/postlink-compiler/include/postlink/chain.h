/* Static successors, and resolving them to block ranks.
 *
 * A dispatch is a lookup from RIP to block.  For a block whose successor is
 * statically known the lookup is a constant, so it can be folded into the
 * block and the dispatch disappears.  This header names the successors and
 * resolves them; whether the artifact should carry the resolved ranks is a
 * format question answered by the measurements in tools/chain.c.
 */

#ifndef POSTLINK_CHAIN_H
#define POSTLINK_CHAIN_H

#include <postlink/directory.h>

/* A control transfer names at most two static targets. */
#define PL_MAX_SUCCESSORS 2u

typedef struct {
    pl_u32 count;
    pl_u64 rip[PL_MAX_SUCCESSORS];
} pl_successors;

/* The static successors of one admitted block, in the artifact's own order.
 *
 *   conditional  both targets, deduplicated
 *   branch       each non-zero target, deduplicated
 *   dynamic, halt, far-return, interrupt-return, exception, syscall, sysret
 *                none: the successor is not a compile-time constant
 *   next, timeslice
 *                the boundary coordinate
 *   everything else
 *                the first continuation field
 *
 * This mirrors kernel/x86snapshot.py's native_x86_static_successors, which is
 * the definition the artifact was written against.
 */
void pl_static_successors(const pl_admission *admission, pl_successors *out);

/* Whether a control's successors are compile-time constants at all. */
int pl_control_is_static_dispatch(pl_u32 control);

typedef struct {
    pl_u32 index;      /* first block row at this coordinate */
    pl_u32 variants;   /* rows sharing the coordinate */
} pl_chain_target;

/* Resolve one successor coordinate to a block row.  Returns PL_ERROR_ABSENT
 * when the coordinate has no block, which is what an artifact that is not
 * closed under static control looks like. */
int pl_chain_resolve(const pl_directory *directory, pl_u64 rip,
                     pl_chain_target *out);

#endif /* POSTLINK_CHAIN_H */
