/* Total direct-control closure for one linked x86 coordinate. */

#ifndef POSTLINK_CLOSURE_H
#define POSTLINK_CLOSURE_H

#include "block.h"

/* Return positive and write rank for a closed coordinate, zero when the
 * address belongs to the total runtime resolver, or a negative compiler
 * status. */
typedef int (*pl_x86_rank_resolver)(void *opaque, pl_u64 address,
                                    pl_u32 *rank);

/* Form one normalized block and bind its control into the direct product.
 * The result is FUNCTION, RESOLVE, BARRIER or FAULT.  No successor-free result
 * type exists, so a residual state/edge graph cannot become an emitter input. */
int pl_x86_close_direct(const pl_x86_frontend *frontend,
                        const pl_x86_block_workspace *workspace,
                        const pl_x86_instruction *instruction,
                        pl_x86_rank_resolver resolve, void *opaque,
                        pl_direct_block *out);

#endif /* POSTLINK_CLOSURE_H */
