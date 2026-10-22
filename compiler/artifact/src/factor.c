#include <artifact/factor.h>

static pl_u32 bit_width(pl_u32 value)
{
    pl_u32 width = 0u;
    do {
        ++width;
        value >>= 1u;
    } while (value);
    return width;
}

int artifact_factor_measure(pl_u32 bytes, pl_u32 *suffix_capacity,
                            pl_u32 *choice_capacity, pl_u32 *z_capacity)
{
    if (!bytes || !suffix_capacity || !choice_capacity || !z_capacity
            || bytes == 0xffffffffu || bytes > 0x7fffffffu)
        return ARTIFACT_ERROR_FACTOR_RANGE;
    *suffix_capacity = bytes + 1u;
    *choice_capacity = bytes;
    *z_capacity = bytes * 2u + 1u;
    return 0;
}

static pl_u32 virtual_symbol(const pl_u8 *bytes, pl_u32 byte_count,
                             pl_u32 target, pl_u32 coordinate)
{
    pl_u32 suffix = byte_count - target;
    if (coordinate < suffix) return bytes[target + coordinate];
    if (coordinate == suffix) return 256u;
    return bytes[coordinate - suffix - 1u];
}

/* Z(target-suffix || sentinel || complete-word) supplies, in one linear pass,
 * the exact match length for every possible prior coordinate. */
static void suffix_matches(const pl_u8 *bytes, pl_u32 byte_count,
                           pl_u32 target, pl_u32 *z)
{
    pl_u32 suffix = byte_count - target;
    pl_u32 count = suffix + 1u + byte_count;
    z[0] = count;
    pl_u32 left = 0u, right = 0u;
    for (pl_u32 index = 1u; index < count; ++index) {
        pl_u32 length = 0u;
        if (index < right) {
            pl_u32 mirrored = z[index - left];
            pl_u32 available = right - index;
            length = mirrored < available ? mirrored : available;
        }
        while (index + length < count
                && virtual_symbol(bytes, byte_count, target, length)
                   == virtual_symbol(bytes, byte_count, target,
                                     index + length))
            ++length;
        z[index] = length;
        if (index + length > right) {
            left = index;
            right = index + length;
        }
    }
}

int artifact_factor_exact_project(const pl_u8 *bytes, pl_u32 byte_count,
                                  const artifact_factor_workspace *workspace,
                                  artifact_factor_projection *out)
{
    pl_u32 suffix_capacity = 0u, choice_capacity = 0u, z_capacity = 0u;
    int status = artifact_factor_measure(
        byte_count, &suffix_capacity, &choice_capacity, &z_capacity);
    if (status || !bytes || !workspace || !out
            || !workspace->suffix_bits || !workspace->source
            || !workspace->length || !workspace->z
            || workspace->suffix_capacity < suffix_capacity
            || workspace->choice_capacity < choice_capacity
            || workspace->z_capacity < z_capacity)
        return ARTIFACT_ERROR_FACTOR_RANGE;

    for (pl_u32 index = 0u; index < byte_count; ++index) {
        workspace->source[index] = 0xffffffffu;
        workspace->length[index] = 0u;
    }
    workspace->suffix_bits[byte_count] = 0u;
    pl_u32 width = bit_width(byte_count);
    pl_u64 reference_bits = 1u + (pl_u64)width * 2u;

    for (pl_u32 target = byte_count; target-- > 0u;) {
        suffix_matches(bytes, byte_count, target, workspace->z);
        pl_u32 suffix = byte_count - target;
        pl_u32 maximum = 0u;
        for (pl_u32 source = 0u; source < target; ++source) {
            pl_u32 match = workspace->z[suffix + 1u + source];
            if (match > suffix) match = suffix;
            if (match > maximum) maximum = match;
        }

        if (workspace->suffix_bits[target + 1u]
                > 0xffffffffffffffffull - 9u)
            return ARTIFACT_ERROR_FACTOR_RANGE;
        pl_u64 best = 9u + workspace->suffix_bits[target + 1u];
        pl_u32 selected = 0u;
        for (pl_u32 length = 1u; length <= maximum; ++length) {
            pl_u64 tail = workspace->suffix_bits[target + length];
            if (tail > 0xffffffffffffffffull - reference_bits)
                return ARTIFACT_ERROR_FACTOR_RANGE;
            pl_u64 candidate = reference_bits + tail;
            if (candidate < best
                    || (candidate == best && selected
                        && length < selected)) {
                best = candidate;
                selected = length;
            }
        }
        workspace->suffix_bits[target] = best;
        if (selected) {
            workspace->length[target] = selected;
            for (pl_u32 source = 0u; source < target; ++source) {
                pl_u32 match = workspace->z[suffix + 1u + source];
                if (match >= selected) {
                    workspace->source[target] = source;
                    break;
                }
            }
            if (workspace->source[target] == 0xffffffffu)
                return ARTIFACT_ERROR_FACTOR;
        }
    }

    pl_u32 tokens = 0u, literals = 0u, references = 0u;
    pl_u64 literal_bytes = 0u, referenced_bytes = 0u;
    for (pl_u32 at = 0u; at < byte_count;) {
        ++tokens;
        pl_u32 length = workspace->length[at];
        if (!length) {
            ++literals;
            ++literal_bytes;
            ++at;
        } else {
            if (length > byte_count - at || workspace->source[at] >= at)
                return ARTIFACT_ERROR_FACTOR;
            ++references;
            referenced_bytes += length;
            at += length;
        }
    }
    *out = (artifact_factor_projection){
        byte_count, width, tokens, literals, references,
        literal_bytes, referenced_bytes,
        (pl_u64)byte_count * 9u, workspace->suffix_bits[0], 0u,
    };
    return 0;
}

int artifact_factor_decode(const pl_u8 *bytes, pl_u32 byte_count,
                           const artifact_factor_workspace *workspace,
                           pl_u8 *target, pl_u32 target_capacity)
{
    if (!bytes || !workspace || !workspace->source || !workspace->length
            || !target || target_capacity < byte_count
            || workspace->choice_capacity < byte_count)
        return ARTIFACT_ERROR_FACTOR_RANGE;
    for (pl_u32 at = 0u; at < byte_count;) {
        pl_u32 length = workspace->length[at];
        if (!length) {
            target[at] = bytes[at];
            ++at;
            continue;
        }
        pl_u32 source = workspace->source[at];
        if (source >= at || length > byte_count - at)
            return ARTIFACT_ERROR_FACTOR;
        for (pl_u32 index = 0u; index < length; ++index)
            target[at + index] = target[source + index];
        at += length;
    }
    for (pl_u32 index = 0u; index < byte_count; ++index)
        if (target[index] != bytes[index]) return ARTIFACT_ERROR_FACTOR;
    return 0;
}
