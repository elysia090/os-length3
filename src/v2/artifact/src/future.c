#include <artifact/future.h>

int artifact_future_project(
    const artifact_future_population *population,
    const artifact_future_workspace *workspace,
    artifact_future_projection *out)
{
    if (!population || !workspace || !out || !population->observation
            || !population->successor || !population->states
            || !population->arms)
        return ARTIFACT_ERROR_FUTURE_RANGE;
    for (pl_u32 state = 0u; state < population->states; ++state)
        if (population->observation[state].family
                != ARTIFACT_OBSERVATION_BLOCK)
            return ARTIFACT_ERROR_FUTURE;

    artifact_future_projection result = { 0 };
    int status = artifact_share_project(
        population->observation, population->states,
        &workspace->immediate, &result.immediate);
    if (status) return status;

    pl_finite_future_machine machine = {
        population->states,
        result.immediate.classes,
        population->arms,
        workspace->immediate.rank,
        population->successor,
    };
    status = pl_finite_future_project(
        &machine, &workspace->future, &result.future);
    if (status) return status;
    if (!result.future.classes
            || result.future.classes > population->states)
        return ARTIFACT_ERROR_FUTURE;
    result.shared_state_occurrences =
        population->states - result.future.classes;
    *out = result;
    return 0;
}
