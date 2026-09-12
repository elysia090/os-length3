#include <artifact/derive.h>

static const pl_u8 exception_domain[] = "derived-cell-exception-v1";
static const pl_u8 empty_exception_domain[] =
    "derived-empty-cell-exception-v1";

static int equal_cell(const artifact_cell *left, const artifact_cell *right)
{
    if (left->length != right->length) return 0;
    for (pl_u32 index = 0u; index < left->length; ++index)
        if (left->bytes[index] != right->bytes[index]) return 0;
    return 1;
}

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    if (!value || *value > 0xffffffffffffffffull - addend) return 0;
    *value += addend;
    return 1;
}

int artifact_derive_measure(pl_u32 coordinates, pl_u32 *support_bytes,
                            pl_u32 *share_digest_bytes,
                            pl_u32 *share_index_capacity)
{
    if (!coordinates || !support_bytes || !share_digest_bytes
            || !share_index_capacity)
        return ARTIFACT_ERROR_DERIVE_RANGE;
    *support_bytes = (coordinates + 7u) >> 3u;
    return artifact_share_measure(
        coordinates, share_digest_bytes, share_index_capacity);
}

static int workspace_valid(const artifact_derive_workspace *workspace,
                           pl_u32 coordinates)
{
    return workspace && workspace->support && workspace->rank
        && workspace->exception_coordinate
        && workspace->representative_coordinate
        && workspace->observation && workspace->capacity >= coordinates
        && workspace->support_bytes >= ((coordinates + 7u) >> 3u);
}

int artifact_derive_project(
    const artifact_cell *actual, const artifact_cell *generated,
    pl_u32 coordinates, const artifact_derive_workspace *workspace,
    artifact_derive_projection *out)
{
    if (!actual || !generated || !coordinates
            || !workspace_valid(workspace, coordinates) || !out)
        return ARTIFACT_ERROR_DERIVE_RANGE;
    for (pl_u32 index = 0u; index < workspace->support_bytes; ++index)
        workspace->support[index] = 0u;
    for (pl_u32 index = 0u; index < coordinates; ++index)
        workspace->rank[index] = 0xffffffffu;

    static const pl_u8 empty = 0u;
    pl_u32 exceptions = 0u;
    pl_u64 opened = 0u, removed = 0u;
    for (pl_u32 coordinate = 0u; coordinate < coordinates; ++coordinate) {
        if ((actual[coordinate].length && !actual[coordinate].bytes)
                || (generated[coordinate].length
                    && !generated[coordinate].bytes)
                || !add_u64(&opened, actual[coordinate].length))
            return ARTIFACT_ERROR_DERIVE_RANGE;
        if (equal_cell(&actual[coordinate], &generated[coordinate])) {
            if (!add_u64(&removed, actual[coordinate].length))
                return ARTIFACT_ERROR_DERIVE_RANGE;
            continue;
        }
        workspace->support[coordinate >> 3u] |=
            (pl_u8)(1u << (coordinate & 7u));
        workspace->exception_coordinate[exceptions] = coordinate;
        workspace->observation[exceptions] =
            (artifact_complete_observation){
                ARTIFACT_OBSERVATION_DERIVED_CELL,
                actual[coordinate].length
                    ? exception_domain : empty_exception_domain,
                actual[coordinate].length
                    ? (pl_u32)(sizeof(exception_domain) - 1u)
                    : (pl_u32)(sizeof(empty_exception_domain) - 1u),
                actual[coordinate].length
                    ? actual[coordinate].bytes : &empty,
                actual[coordinate].length
                    ? actual[coordinate].length : 1u,
            };
        ++exceptions;
    }

    pl_u32 classes = 0u;
    pl_u64 retained = 0u;
    if (exceptions) {
        artifact_share_projection quotient = { 0 };
        int status = artifact_share_project(
            workspace->observation, exceptions,
            &workspace->share, &quotient);
        if (status) return status;
        classes = quotient.classes;
        for (pl_u32 exception = 0u; exception < exceptions; ++exception) {
            pl_u32 coordinate = workspace->exception_coordinate[exception];
            workspace->rank[coordinate] = workspace->share.rank[exception];
        }
        for (pl_u32 rank = 0u; rank < classes; ++rank) {
            pl_u32 exception = workspace->share.representative[rank];
            if (exception >= exceptions) return ARTIFACT_ERROR_DERIVE;
            pl_u32 coordinate = workspace->exception_coordinate[exception];
            workspace->representative_coordinate[rank] = coordinate;
            if (!add_u64(&retained, actual[coordinate].length))
                return ARTIFACT_ERROR_DERIVE_RANGE;
        }
    }
    *out = (artifact_derive_projection){
        coordinates, coordinates - exceptions, exceptions, classes,
        opened, retained, removed,
    };
    return 0;
}

int artifact_derive_cell(
    const artifact_cell *actual, const artifact_cell *generated,
    pl_u32 coordinates, const artifact_derive_workspace *workspace,
    pl_u32 coordinate, artifact_cell *out)
{
    if (!actual || !generated || coordinate >= coordinates || !out
            || !workspace_valid(workspace, coordinates))
        return ARTIFACT_ERROR_DERIVE_RANGE;
    if (!(workspace->support[coordinate >> 3u]
            & (pl_u8)(1u << (coordinate & 7u)))) {
        *out = generated[coordinate];
        return equal_cell(out, &actual[coordinate])
             ? 0 : ARTIFACT_ERROR_DERIVE;
    }
    pl_u32 rank = workspace->rank[coordinate];
    if (rank == 0xffffffffu || rank >= workspace->capacity)
        return ARTIFACT_ERROR_DERIVE;
    pl_u32 representative = workspace->representative_coordinate[rank];
    if (representative >= coordinates) return ARTIFACT_ERROR_DERIVE;
    *out = actual[representative];
    return equal_cell(out, &actual[coordinate])
         ? 0 : ARTIFACT_ERROR_DERIVE;
}
