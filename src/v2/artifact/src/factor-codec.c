#include <artifact/factor-codec.h>

static pl_u32 bit_width(pl_u32 value)
{
    pl_u32 width = 0u;
    do {
        ++width;
        value >>= 1u;
    } while (value);
    return width;
}

static int bit_extent(pl_u64 bits, pl_u32 *bytes)
{
    if (!bytes || bits > (pl_u64)0xffffffffu * 8u) return 0;
    *bytes = (pl_u32)((bits + 7u) >> 3u);
    return 1;
}

static void put_bit(pl_u8 *code, pl_u64 at, pl_u32 bit)
{
    pl_u8 mask = (pl_u8)(1u << (7u - (pl_u32)(at & 7u)));
    if (bit) code[at >> 3u] |= mask;
}

static void put_value(pl_u8 *code, pl_u64 *at, pl_u32 value, pl_u32 width)
{
    for (pl_u32 remaining = width; remaining; --remaining)
        put_bit(code, (*at)++, (value >> (remaining - 1u)) & 1u);
}

static int get_bit(const pl_u8 *code, pl_u64 bits,
                   pl_u64 *at, pl_u32 *out)
{
    if (*at >= bits) return 0;
    *out = (code[*at >> 3u] >> (7u - (pl_u32)(*at & 7u))) & 1u;
    ++*at;
    return 1;
}

static int get_value(const pl_u8 *code, pl_u64 bits, pl_u64 *at,
                     pl_u32 width, pl_u32 *out)
{
    pl_u32 value = 0u;
    for (pl_u32 index = 0u; index < width; ++index) {
        pl_u32 bit = 0u;
        if (!get_bit(code, bits, at, &bit)) return 0;
        value = (value << 1u) | bit;
    }
    *out = value;
    return 1;
}

int artifact_factor_code_write(
    const artifact_byte_view *opened,
    const pl_u32 *source, const pl_u32 *length, pl_u32 choice_capacity,
    pl_u8 *code, pl_u32 code_capacity,
    artifact_factor_code_projection *out)
{
    if (artifact_byte_view_validate(opened)
            || opened->bytes > 0xffffffffu || !source || !length
            || !opened->bytes
            || !code || !out)
        return ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    pl_u32 opened_bytes = (pl_u32)opened->bytes;
    if (choice_capacity < opened_bytes)
        return ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    pl_u32 width = bit_width(opened_bytes);
    pl_u64 bits = 0u;
    pl_u32 tokens = 0u;
    for (pl_u32 at = 0u; at < opened_bytes;) {
        pl_u32 extent = length[at];
        if (!extent) {
            if (bits > 0xffffffffffffffffull - 9u)
                return ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
            bits += 9u;
            ++at;
        } else {
            if (source[at] >= at || extent > opened_bytes - at
                    || bits > 0xffffffffffffffffull
                               - (1u + (pl_u64)width * 2u))
                return ARTIFACT_ERROR_FACTOR_CODEC;
            bits += 1u + (pl_u64)width * 2u;
            at += extent;
        }
        ++tokens;
    }
    pl_u32 bytes = 0u;
    if (!bit_extent(bits, &bytes) || code_capacity < bytes)
        return ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    for (pl_u32 index = 0u; index < bytes; ++index) code[index] = 0u;
    pl_u64 cursor = 0u;
    for (pl_u32 at = 0u; at < opened_bytes;) {
        pl_u32 extent = length[at];
        if (!extent) {
            put_bit(code, cursor++, 0u);
            put_value(code, &cursor, artifact_byte_view_at(opened, at), 8u);
            ++at;
        } else {
            put_bit(code, cursor++, 1u);
            put_value(code, &cursor, extent, width);
            put_value(code, &cursor, source[at], width);
            at += extent;
        }
    }
    if (cursor != bits) return ARTIFACT_ERROR_FACTOR_CODEC;
    *out = (artifact_factor_code_projection){
        opened_bytes, width, tokens, bits, bytes,
    };
    return 0;
}

int artifact_factor_code_verify(
    const pl_u8 *code, pl_u32 code_bytes, pl_u64 code_bits,
    const artifact_byte_view *expected,
    artifact_factor_code_projection *out)
{
    pl_u32 required_bytes = 0u;
    if (!code || !code_bits || artifact_byte_view_validate(expected)
            || expected->bytes > 0xffffffffu || !out
            || !bit_extent(code_bits, &required_bytes)
            || code_bytes != required_bytes)
        return ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    if ((code_bits & 7u) != 0u) {
        pl_u32 padding = 8u - (pl_u32)(code_bits & 7u);
        pl_u8 mask = (pl_u8)((1u << padding) - 1u);
        if (code[code_bytes - 1u] & mask)
            return ARTIFACT_ERROR_FACTOR_CODEC;
    }
    pl_u32 output_bytes = (pl_u32)expected->bytes;
    pl_u32 width = bit_width(output_bytes);
    pl_u32 at = 0u, tokens = 0u;
    pl_u64 cursor = 0u;
    while (at < output_bytes) {
        pl_u32 reference = 0u;
        if (!get_bit(code, code_bits, &cursor, &reference))
            return ARTIFACT_ERROR_FACTOR_CODEC;
        if (!reference) {
            pl_u32 byte = 0u;
            if (!get_value(code, code_bits, &cursor, 8u, &byte)
                    || byte != artifact_byte_view_at(expected, at))
                return ARTIFACT_ERROR_FACTOR_CODEC;
            ++at;
        } else {
            pl_u32 extent = 0u, source = 0u;
            if (!get_value(code, code_bits, &cursor, width, &extent)
                    || !get_value(code, code_bits, &cursor, width, &source)
                    || !extent || source >= at
                    || extent > output_bytes - at
                    || !artifact_byte_view_equal(
                        expected, source, at, extent))
                return ARTIFACT_ERROR_FACTOR_CODEC;
            at += extent;
        }
        ++tokens;
    }
    if (cursor != code_bits) return ARTIFACT_ERROR_FACTOR_CODEC;
    *out = (artifact_factor_code_projection){
        output_bytes, width, tokens, code_bits, code_bytes,
    };
    return 0;
}

int artifact_factor_code_read(
    const pl_u8 *code, pl_u32 code_bytes, pl_u64 code_bits,
    pl_u8 *target, pl_u32 target_capacity, pl_u32 output_bytes,
    artifact_factor_code_projection *out)
{
    pl_u32 required_bytes = 0u;
    if (!code || !code_bits || !target || !output_bytes || !out
            || target_capacity < output_bytes
            || !bit_extent(code_bits, &required_bytes)
            || code_bytes != required_bytes)
        return ARTIFACT_ERROR_FACTOR_CODEC_RANGE;
    if ((code_bits & 7u) != 0u) {
        pl_u32 padding = 8u - (pl_u32)(code_bits & 7u);
        pl_u8 mask = (pl_u8)((1u << padding) - 1u);
        if (code[code_bytes - 1u] & mask)
            return ARTIFACT_ERROR_FACTOR_CODEC;
    }
    pl_u32 width = bit_width(output_bytes);
    pl_u32 at = 0u, tokens = 0u;
    pl_u64 cursor = 0u;
    while (at < output_bytes) {
        pl_u32 reference = 0u;
        if (!get_bit(code, code_bits, &cursor, &reference))
            return ARTIFACT_ERROR_FACTOR_CODEC;
        if (!reference) {
            pl_u32 byte = 0u;
            if (!get_value(code, code_bits, &cursor, 8u, &byte))
                return ARTIFACT_ERROR_FACTOR_CODEC;
            target[at++] = (pl_u8)byte;
        } else {
            pl_u32 extent = 0u, source = 0u;
            if (!get_value(code, code_bits, &cursor, width, &extent)
                    || !get_value(code, code_bits, &cursor, width, &source)
                    || !extent || source >= at
                    || extent > output_bytes - at)
                return ARTIFACT_ERROR_FACTOR_CODEC;
            for (pl_u32 index = 0u; index < extent; ++index)
                target[at + index] = target[source + index];
            at += extent;
        }
        ++tokens;
    }
    if (cursor != code_bits) return ARTIFACT_ERROR_FACTOR_CODEC;
    *out = (artifact_factor_code_projection){
        output_bytes, width, tokens, code_bits, code_bytes,
    };
    return 0;
}
