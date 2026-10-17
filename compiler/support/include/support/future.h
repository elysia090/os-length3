/* Exact complete-future quotient for a finite total Moore machine. */

#ifndef SUPPORT_FUTURE_H
#define SUPPORT_FUTURE_H

#include <support/types.h>

#define PL_ERROR_FUTURE       (-84)
#define PL_ERROR_FUTURE_RANGE (-85)

typedef struct {
    pl_u32 states;
    pl_u32 observation_classes;
    pl_u32 arms;
    const pl_u32 *observation;
    const pl_u32 *successor; /* row-major [states][arms], total */
} pl_finite_future_machine;

typedef struct {
    pl_u32 *state_class;
    pl_u32 state_capacity;
    pl_u8 *scratch;
    pl_u32 scratch_bytes;
} pl_finite_future_workspace;

typedef struct {
    pl_u32 classes;
    pl_u64 checked_transitions;
    pl_u64 splitters;
    pl_u64 moved_states;
    pl_u32 failure_stage;
    pl_u64 failure_value;
    pl_u64 failure_limit;
} pl_finite_future_projection;

/* Observation classes are canonical dense ranks.  Partition refinement over
 * every total arm returns the unique minimum complete-future partition up to
 * rank renaming; no history depth, source image, or runtime representation is
 * part of the equivalence relation. */
int pl_finite_future_workspace_measure(pl_u32 states, pl_u32 arms,
                                       pl_u32 *bytes);
int pl_finite_future_project(const pl_finite_future_machine *machine,
                             const pl_finite_future_workspace *workspace,
                             pl_finite_future_projection *out);

#endif /* SUPPORT_FUTURE_H */
