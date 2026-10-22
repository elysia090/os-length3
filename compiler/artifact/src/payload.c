#include <artifact/payload.h>

static const pl_u8 payload_domain[] = "canonical-immutable-payload-v1";
static const pl_u8 empty_payload_domain[] =
    "canonical-empty-immutable-payload-v1";

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    if (!value || *value > 0xffffffffffffffffull - addend) return 0;
    *value += addend;
    return 1;
}

static int workspace_valid(const artifact_payload_workspace *workspace,
                           pl_u32 occurrences)
{
    return workspace && workspace->observation
        && workspace->observation_capacity >= occurrences;
}

int artifact_payload_project(
    const artifact_payload *payloads, pl_u32 occurrences,
    const artifact_payload_workspace *workspace,
    artifact_payload_projection *out)
{
    if (!payloads || !occurrences || !workspace_valid(workspace, occurrences)
            || !out)
        return ARTIFACT_ERROR_PAYLOAD_RANGE;
    pl_u64 opened = 0u;
    for (pl_u32 index = 0u; index < occurrences; ++index) {
        if ((payloads[index].length && !payloads[index].bytes)
                || !add_u64(&opened, payloads[index].length))
            return ARTIFACT_ERROR_PAYLOAD_RANGE;
        /* share requires nonempty response bytes.  Empty payloads all have
         * one explicit zero response; their observable extent remains zero. */
        static const pl_u8 empty = 0u;
        workspace->observation[index] = (artifact_complete_observation){
            ARTIFACT_OBSERVATION_PAYLOAD,
            payloads[index].length ? payload_domain : empty_payload_domain,
            payloads[index].length
                ? (pl_u32)(sizeof(payload_domain) - 1u)
                : (pl_u32)(sizeof(empty_payload_domain) - 1u),
            payloads[index].length ? payloads[index].bytes : &empty,
            payloads[index].length ? payloads[index].length : 1u,
        };
    }
    artifact_share_projection quotient = { 0 };
    int status = artifact_share_project(
        workspace->observation, occurrences, &workspace->share, &quotient);
    if (status) return status;
    pl_u64 unique = 0u;
    for (pl_u32 rank = 0u; rank < quotient.classes; ++rank) {
        pl_u32 representative = workspace->share.representative[rank];
        if (representative >= occurrences
                || !add_u64(&unique, payloads[representative].length))
            return ARTIFACT_ERROR_PAYLOAD_RANGE;
    }
    if (unique > opened) return ARTIFACT_ERROR_PAYLOAD;
    *out = (artifact_payload_projection){
        occurrences, quotient.classes, opened, unique, opened - unique,
    };
    return 0;
}

int artifact_payload_view(
    const artifact_payload *payloads, pl_u32 occurrences,
    const artifact_payload_workspace *workspace,
    const artifact_payload_projection *projection,
    pl_u64 *end, pl_u32 end_capacity,
    artifact_byte_view *out)
{
    if (!payloads || !occurrences || !workspace || !projection
            || projection->occurrences != occurrences
            || !end || end_capacity < projection->classes || !out)
        return ARTIFACT_ERROR_PAYLOAD_RANGE;
    pl_u64 at = 0u;
    for (pl_u32 rank = 0u; rank < projection->classes; ++rank) {
        pl_u32 representative = workspace->share.representative[rank];
        if (representative >= occurrences)
            return ARTIFACT_ERROR_PAYLOAD;
        const artifact_payload *payload = &payloads[representative];
        if ((payload->length && !payload->bytes)
                || payload->length > projection->unique_bytes - at)
            return ARTIFACT_ERROR_PAYLOAD;
        at += payload->length;
        end[rank] = at;
    }
    if (at != projection->unique_bytes) return ARTIFACT_ERROR_PAYLOAD;
    *out = (artifact_byte_view){
        payloads, occurrences, workspace->share.representative,
        end, projection->classes, at,
    };
    return 0;
}

int artifact_byte_view_validate(const artifact_byte_view *view)
{
    if (!view || !view->payload || !view->payload_occurrences
            || (!view->representative
                && view->payload_occurrences != view->spans)
            || !view->end || !view->spans
            || !view->bytes)
        return ARTIFACT_ERROR_PAYLOAD_RANGE;
    pl_u64 first = 0u;
    for (pl_u32 span = 0u; span < view->spans; ++span) {
        pl_u32 owner = view->representative
                     ? view->representative[span] : span;
        if (owner >= view->payload_occurrences
                || (view->payload[owner].length
                    && !view->payload[owner].bytes)
                || view->end[span] < first
                || view->end[span] - first
                   != view->payload[owner].length)
            return ARTIFACT_ERROR_PAYLOAD;
        first = view->end[span];
    }
    return first == view->bytes ? 0 : ARTIFACT_ERROR_PAYLOAD;
}

int artifact_byte_view_equal(
    const artifact_byte_view *view,
    pl_u32 left, pl_u32 right, pl_u32 bytes)
{
    if (!view || (pl_u64)left + bytes > view->bytes
            || (pl_u64)right + bytes > view->bytes)
        return 0;
    return artifact_byte_view_common_prefix(
        view, left, right, bytes) == bytes;
}

static pl_u32 span_at(const artifact_byte_view *view, pl_u32 coordinate)
{
    pl_u32 low = 0u, high = view->spans;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if ((pl_u64)coordinate < view->end[middle]) high = middle;
        else low = middle + 1u;
    }
    return low;
}

pl_u32 artifact_byte_view_common_prefix(
    const artifact_byte_view *view,
    pl_u32 left, pl_u32 right, pl_u32 limit)
{
    if (!view || (pl_u64)left + limit > view->bytes
            || (pl_u64)right + limit > view->bytes)
        return 0u;
    pl_u32 left_span = span_at(view, left);
    pl_u32 right_span = span_at(view, right);
    pl_u32 matched = 0u;
    while (matched < limit) {
        while (view->end[left_span] == left) ++left_span;
        while (view->end[right_span] == right) ++right_span;
        pl_u64 left_first = left_span ? view->end[left_span - 1u] : 0u;
        pl_u64 right_first = right_span ? view->end[right_span - 1u] : 0u;
        pl_u32 left_owner = view->representative
                          ? view->representative[left_span] : left_span;
        pl_u32 right_owner = view->representative
                           ? view->representative[right_span] : right_span;
        const pl_u8 *left_bytes = view->payload[left_owner].bytes
            + ((pl_u64)left - left_first);
        const pl_u8 *right_bytes = view->payload[right_owner].bytes
            + ((pl_u64)right - right_first);
        pl_u64 left_available = view->end[left_span] - left;
        pl_u64 right_available = view->end[right_span] - right;
        pl_u32 take = limit - matched;
        if (left_available < take) take = (pl_u32)left_available;
        if (right_available < take) take = (pl_u32)right_available;
        for (pl_u32 index = 0u; index < take; ++index)
            if (left_bytes[index] != right_bytes[index])
                return matched + index;
        left += take;
        right += take;
        matched += take;
    }
    return matched;
}

int artifact_payload_find(
    const artifact_payload *payloads, pl_u32 occurrences,
    const artifact_payload_workspace *workspace,
    const pl_u8 *bytes, pl_u32 length, pl_u32 *rank)
{
    if (!payloads || !occurrences || !workspace || !rank
            || (length && !bytes))
        return ARTIFACT_ERROR_PAYLOAD_RANGE;
    static const pl_u8 empty = 0u;
    artifact_complete_observation needle = {
        ARTIFACT_OBSERVATION_PAYLOAD,
        length ? payload_domain : empty_payload_domain,
        length ? (pl_u32)(sizeof(payload_domain) - 1u)
               : (pl_u32)(sizeof(empty_payload_domain) - 1u),
        length ? bytes : &empty,
        length ? length : 1u,
    };
    int status = artifact_share_find(
        workspace->observation, occurrences, &workspace->share,
        &needle, rank);
    return status == ARTIFACT_ERROR_SHARE_RANK
         ? ARTIFACT_ERROR_PAYLOAD : status;
}
