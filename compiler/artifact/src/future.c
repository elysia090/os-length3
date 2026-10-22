#include <artifact/future.h>

int artifact_future_project_view(
    const artifact_observation_view *observation,
    const pl_u32 *successor, pl_u32 states, pl_u32 arms,
    const artifact_future_workspace *workspace,
    artifact_future_projection *out)
{
    if (!observation || !observation->read || !workspace || !out
            || !successor || !states || !arms)
        return ARTIFACT_ERROR_FUTURE_RANGE;
    for (pl_u32 state = 0u; state < states; ++state) {
        artifact_complete_observation value = observation->read(observation->context, state);
        if (value.family != ARTIFACT_OBSERVATION_BLOCK)
            return ARTIFACT_ERROR_FUTURE;
    }

    artifact_future_projection result = { 0 };
    int status = artifact_share_project_view(
        observation, states,
        &workspace->immediate, &result.immediate);
    if (status) return status;

    pl_finite_future_machine machine = {
        states,
        result.immediate.classes,
        arms,
        workspace->immediate.rank,
        successor,
    };
    status = pl_finite_future_project(
        &machine, &workspace->future, &result.future);
    if (status) return status;
    if (!result.future.classes
            || result.future.classes > states)
        return ARTIFACT_ERROR_FUTURE;
    result.shared_state_occurrences =
        states - result.future.classes;
    *out = result;
    return 0;
}

int artifact_future_project(
    const artifact_future_population *population,
    const artifact_future_workspace *workspace,
    artifact_future_projection *out)
{
    if (!population) return ARTIFACT_ERROR_FUTURE_RANGE;
    artifact_observation_view view = artifact_observations_view(population->observation);
    return artifact_future_project_view(&view, population->successor,
                                      population->states, population->arms, workspace, out);
}
