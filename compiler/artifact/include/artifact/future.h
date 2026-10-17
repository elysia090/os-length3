/* Release-wide complete-future quotient for executable block states. */

#ifndef ARTIFACT_FUTURE_H
#define ARTIFACT_FUTURE_H

#include <artifact/share.h>
#include <support/future.h>

#define ARTIFACT_ERROR_FUTURE       (-83)
#define ARTIFACT_ERROR_FUTURE_RANGE (-84)

typedef struct {
    /* One immediate, total observation per state.  Every observation must be
     * a BLOCK family value and must omit ELF identity, address and local rank.
     * `successor` is row-major [states][arms] and total over the disjoint
     * union of every linked image in the release. */
    const artifact_complete_observation *observation;
    const pl_u32 *successor;
    pl_u32 states;
    pl_u32 arms;
} artifact_future_population;

typedef struct {
    artifact_share_workspace immediate;
    pl_finite_future_workspace future;
} artifact_future_workspace;

typedef struct {
    artifact_share_projection immediate;
    pl_finite_future_projection future;
    pl_u32 shared_state_occurrences;
} artifact_future_projection;

/* First quotient the immediate block response, then refine that partition by
 * every future arm.  The result is necessary and sufficient:
 *
 *   class(p) = class(q)
 *     iff for every finite arm word w,
 *         observe(delta*(p,w)) = observe(delta*(q,w)).
 *
 * Image-local state numbers are construction coordinates only. */
int artifact_future_project(
    const artifact_future_population *population,
    const artifact_future_workspace *workspace,
    artifact_future_projection *out);

int artifact_future_project_view(
    const artifact_observation_view *observation,
    const pl_u32 *successor, pl_u32 states, pl_u32 arms,
    const artifact_future_workspace *workspace,
    artifact_future_projection *out);

#endif /* ARTIFACT_FUTURE_H */
