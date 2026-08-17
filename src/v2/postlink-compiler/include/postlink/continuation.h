/* Canonical continuation residual codec.  See src/continuation.c. */

#ifndef POSTLINK_CONTINUATION_H
#define POSTLINK_CONTINUATION_H

#include <postlink/format.h>

/* Field order inside a continuation row. */
#define PL_FIELD_BOUNDARY 0u
#define PL_FIELD_FIRST    1u
#define PL_FIELD_SECOND   2u
#define PL_FIELD_THIRD    3u

typedef struct {
    pl_u32 control;
    pl_u64 field[PL_CONTINUATION_FIELDS];
} pl_continuation;

#define PL_ERROR_CONTINUATION (-8)
#define PL_ERROR_CANONICAL    (-9)

/* Absolute <-> RIP-relative residual form. */
void pl_continuation_project(pl_u64 rip, const pl_continuation *absolute,
                             pl_continuation *relative);
void pl_continuation_instantiate(pl_u64 rip, const pl_continuation *relative,
                                 pl_continuation *absolute);

/* Encode a projected continuation.  Writes at most
 * PL_CONTINUATION_HEADER_BYTES + 4 * 8 bytes and reports the exact extent. */
#define PL_CONTINUATION_MAX_BYTES \
    (PL_CONTINUATION_HEADER_BYTES + PL_CONTINUATION_FIELDS * 8u)

int pl_continuation_encode(const pl_continuation *relative,
                           pl_u8 *target, pl_u32 capacity, pl_u32 *written);

/* Decode a projected continuation, rejecting any non-minimal spelling. */
int pl_continuation_decode(const pl_u8 *payload, pl_u32 bytes,
                           pl_continuation *relative);

#endif /* POSTLINK_CONTINUATION_H */
