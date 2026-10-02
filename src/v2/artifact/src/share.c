#include <artifact/share.h>

static artifact_complete_observation read_observation_array(
    const void *context, pl_u32 index)
{
    const artifact_complete_observation *observations = context;
    return observations[index];
}

artifact_observation_view artifact_observations_view(
    const artifact_complete_observation *observations)
{
    return (artifact_observation_view){
        observations, observations ? read_observation_array : 0,
    };
}

static int valid_observation(const artifact_complete_observation *value)
{
    return value && value->family >= ARTIFACT_OBSERVATION_BLOCK
        && value->family <= ARTIFACT_OBSERVATION_PAYLOAD
        && value->domain_bytes && value->domain
        && value->response_bytes && value->response;
}

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    if (*value > 0xffffffffffffffffull - addend) return 0;
    *value += addend;
    return 1;
}

int artifact_share_measure(pl_u32 occurrences, pl_u32 *digest_bytes,
                           pl_u32 *index_capacity)
{
    if (!occurrences || !digest_bytes || !index_capacity
            || occurrences > 0xffffffffu / PL_SHA256_BYTES)
        return ARTIFACT_ERROR_SHARE_RANGE;
    *digest_bytes = occurrences * PL_SHA256_BYTES;
    *index_capacity = occurrences;
    return 0;
}

static void write_u32_be(pl_u8 bytes[4], pl_u32 value)
{
    bytes[0] = (pl_u8)(value >> 24u);
    bytes[1] = (pl_u8)(value >> 16u);
    bytes[2] = (pl_u8)(value >> 8u);
    bytes[3] = (pl_u8)value;
}

static void observation_digest(const artifact_complete_observation *value,
                               pl_u8 digest[PL_SHA256_BYTES])
{
    static const pl_u8 domain[] = "artifact-complete-observation-v1";
    pl_u8 scalar[4];
    pl_sha256 state;
    pl_sha256_open(&state);
    pl_sha256_write(&state, domain, (pl_u64)(sizeof(domain) - 1u));
    write_u32_be(scalar, value->family);
    pl_sha256_write(&state, scalar, sizeof(scalar));
    write_u32_be(scalar, value->domain_bytes);
    pl_sha256_write(&state, scalar, sizeof(scalar));
    pl_sha256_write(&state, value->domain, value->domain_bytes);
    write_u32_be(scalar, value->response_bytes);
    pl_sha256_write(&state, scalar, sizeof(scalar));
    pl_sha256_write(&state, value->response, value->response_bytes);
    pl_sha256_close(&state, digest);
}

static int byte_order(const pl_u8 *left, pl_u32 left_bytes,
                      const pl_u8 *right, pl_u32 right_bytes)
{
    pl_u32 common = left_bytes < right_bytes ? left_bytes : right_bytes;
    for (pl_u32 index = 0u; index < common; ++index) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
    }
    return left_bytes < right_bytes ? -1 : left_bytes > right_bytes;
}

static int observation_order(const artifact_complete_observation *left,
                             const artifact_complete_observation *right)
{
    if (left->family < right->family) return -1;
    if (left->family > right->family) return 1;
    int order = byte_order(left->domain, left->domain_bytes,
                           right->domain, right->domain_bytes);
    return order ? order
                 : byte_order(left->response, left->response_bytes,
                              right->response, right->response_bytes);
}

static int observation_equal(const artifact_complete_observation *left,
                             const artifact_complete_observation *right)
{
    return observation_order(left, right) == 0;
}

static int digest_equal(const pl_u8 *left, const pl_u8 *right)
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        difference |= (pl_u32)(left[index] ^ right[index]);
    return difference == 0u;
}

static int digest_order(const pl_u8 *left, const pl_u8 *right)
{
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
    }
    return 0;
}

/* Stable LSD radix over the digest gives deterministic O(32N) primary order.
 * It never decides equality. */
static void radix_digest(const pl_u8 *digest, pl_u32 *order,
                         pl_u32 *temporary, pl_u32 count)
{
    pl_u32 *source = order;
    pl_u32 *target = temporary;
    for (pl_u32 pass = 0u; pass < PL_SHA256_BYTES; ++pass) {
        pl_u32 bins[256] = { 0u };
        pl_u32 column = PL_SHA256_BYTES - 1u - pass;
        for (pl_u32 index = 0u; index < count; ++index)
            ++bins[digest[(pl_u64)source[index] * PL_SHA256_BYTES + column]];
        pl_u32 offset = 0u;
        for (pl_u32 byte = 0u; byte < 256u; ++byte) {
            pl_u32 size = bins[byte];
            bins[byte] = offset;
            offset += size;
        }
        for (pl_u32 index = 0u; index < count; ++index) {
            pl_u32 member = source[index];
            pl_u8 byte = digest[(pl_u64)member * PL_SHA256_BYTES + column];
            target[bins[byte]++] = member;
        }
        pl_u32 *swap = source;
        source = target;
        target = swap;
    }
    /* Thirty-two passes leave the result in `order`. */
}

static void merge_collision_group(
    const artifact_observation_view *observations,
    pl_u32 *order, pl_u32 *temporary, pl_u32 first, pl_u32 last)
{
    pl_u32 count = last - first;
    for (pl_u32 width = 1u; width < count;) {
        pl_u32 step = width > count - width ? count : width * 2u;
        for (pl_u32 base = 0u; base < count;) {
            pl_u32 middle = base + width < count ? base + width : count;
            pl_u32 end = base + step < count ? base + step : count;
            pl_u32 left = base, right = middle, out = base;
            while (left < middle && right < end) {
                pl_u32 a = order[first + left];
                pl_u32 b = order[first + right];
                artifact_complete_observation av = observations->read(observations->context, a);
                artifact_complete_observation bv = observations->read(observations->context, b);
                if (observation_order(&av, &bv) <= 0) {
                    temporary[first + out++] = a;
                    ++left;
                } else {
                    temporary[first + out++] = b;
                    ++right;
                }
            }
            while (left < middle)
                temporary[first + out++] = order[first + left++];
            while (right < end)
                temporary[first + out++] = order[first + right++];
            base = end;
        }
        for (pl_u32 index = first; index < last; ++index)
            order[index] = temporary[index];
        if (width > count / 2u) break;
        width *= 2u;
    }
}

static int workspace_valid(const artifact_share_workspace *workspace,
                           pl_u32 occurrences)
{
    return occurrences <= 0xffffffffu / PL_SHA256_BYTES
        && workspace && workspace->digest && workspace->order
        && workspace->temporary && workspace->rank
        && workspace->representative && workspace->capacity >= occurrences
        && workspace->digest_bytes >= occurrences * PL_SHA256_BYTES;
}

int artifact_share_project_view(
    const artifact_observation_view *observations, pl_u32 occurrences,
    const artifact_share_workspace *workspace,
    artifact_share_projection *out)
{
    if (!observations || !observations->read || !out || !occurrences
            || !workspace_valid(workspace, occurrences))
        return ARTIFACT_ERROR_SHARE_RANGE;

    pl_u64 opened = 0u;
    for (pl_u32 index = 0u; index < occurrences; ++index) {
        artifact_complete_observation value = observations->read(observations->context, index);
        if (!valid_observation(&value)
                || !add_u64(&opened, value.domain_bytes)
                || !add_u64(&opened, value.response_bytes))
            return ARTIFACT_ERROR_SHARE_RANGE;
        observation_digest(&value,
                           workspace->digest
                               + (pl_u64)index * PL_SHA256_BYTES);
        workspace->order[index] = index;
    }
    radix_digest(workspace->digest, workspace->order,
                 workspace->temporary, occurrences);

    for (pl_u32 first = 0u; first < occurrences;) {
        pl_u32 last = first + 1u;
        const pl_u8 *key = workspace->digest
            + (pl_u64)workspace->order[first] * PL_SHA256_BYTES;
        while (last < occurrences
                && digest_equal(key, workspace->digest
                    + (pl_u64)workspace->order[last] * PL_SHA256_BYTES))
            ++last;
        if (last - first > 1u)
            merge_collision_group(observations, workspace->order,
                                  workspace->temporary, first, last);
        first = last;
    }

    pl_u32 classes = 0u;
    pl_u64 retained = 0u;
    for (pl_u32 at = 0u; at < occurrences; ++at) {
        pl_u32 member = workspace->order[at];
        artifact_complete_observation value = observations->read(observations->context, member);
        artifact_complete_observation previous = classes
            ? observations->read(observations->context, workspace->representative[classes - 1u])
            : (artifact_complete_observation){ 0 };
        if (!classes || !observation_equal(&value, &previous)) {
            workspace->representative[classes++] = member;
            if (!add_u64(&retained, value.domain_bytes)
                    || !add_u64(&retained,
                                value.response_bytes))
                return ARTIFACT_ERROR_SHARE_RANGE;
        }
        workspace->rank[member] = classes - 1u;
    }
    *out = (artifact_share_projection){
        occurrences, classes, opened, retained, occurrences,
    };
    return 0;
}

int artifact_share_project(
    const artifact_complete_observation *observations, pl_u32 occurrences,
    const artifact_share_workspace *workspace,
    artifact_share_projection *out)
{
    artifact_observation_view view = artifact_observations_view(observations);
    return artifact_share_project_view(&view, occurrences, workspace, out);
}

int artifact_share_verify(
    const artifact_complete_observation *observations, pl_u32 occurrences,
    const pl_u32 *claimed_rank, pl_u32 claimed_classes,
    const artifact_share_workspace *workspace,
    artifact_share_projection *out)
{
    if (!claimed_rank || !claimed_classes || claimed_classes > occurrences)
        return ARTIFACT_ERROR_SHARE_RANGE;
    int status = artifact_share_project(
        observations, occurrences, workspace, out);
    if (status) return status;
    if (out->classes != claimed_classes) return ARTIFACT_ERROR_SHARE_RANK;
    for (pl_u32 index = 0u; index < occurrences; ++index)
        if (claimed_rank[index] >= claimed_classes
                || claimed_rank[index] != workspace->rank[index])
            return ARTIFACT_ERROR_SHARE_RANK;
    return 0;
}

int artifact_share_find(
    const artifact_complete_observation *observations, pl_u32 occurrences,
    const artifact_share_workspace *workspace,
    const artifact_complete_observation *needle, pl_u32 *rank)
{
    if (!observations || !occurrences
            || !workspace_valid(workspace, occurrences)
            || !valid_observation(needle) || !rank)
        return ARTIFACT_ERROR_SHARE_RANGE;
    pl_u8 digest[PL_SHA256_BYTES];
    observation_digest(needle, digest);
    pl_u32 first = 0u, last = occurrences;
    while (first < last) {
        pl_u32 middle = first + (last - first) / 2u;
        pl_u32 occurrence = workspace->order[middle];
        int order = digest_order(
            workspace->digest
                + (pl_u64)occurrence * PL_SHA256_BYTES,
            digest);
        if (!order)
            order = observation_order(
                &observations[occurrence], needle);
        if (order < 0) first = middle + 1u;
        else last = middle;
    }
    if (first >= occurrences) return ARTIFACT_ERROR_SHARE_RANK;
    pl_u32 occurrence = workspace->order[first];
    if (digest_order(
            workspace->digest + (pl_u64)occurrence * PL_SHA256_BYTES,
            digest)
            || !observation_equal(&observations[occurrence], needle))
        return ARTIFACT_ERROR_SHARE_RANK;
    *rank = workspace->rank[occurrence];
    return 0;
}
