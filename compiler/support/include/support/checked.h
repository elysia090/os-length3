/* Overflow-safe extent arithmetic used at every untrusted byte boundary. */

#ifndef SUPPORT_CHECKED_H
#define SUPPORT_CHECKED_H

#include <support/types.h>

static inline int pl_checked_add_u64(pl_u64 left, pl_u64 right, pl_u64 *out)
{
    if (left > ~0ull - right) return 0;
    if (out) *out = left + right;
    return 1;
}

static inline int pl_checked_mul_u64(pl_u64 left, pl_u64 right, pl_u64 *out)
{
    if (left && right > ~0ull / left) return 0;
    if (out) *out = left * right;
    return 1;
}

static inline int pl_checked_extent(pl_u64 offset, pl_u64 bytes,
                                    pl_u64 limit)
{
    return offset <= limit && bytes <= limit - offset;
}

/* Canonical little-endian accessors. Callers validate the enclosing extent
 * before using them; the helpers themselves perform no speculative reads. */
static inline pl_u32 pl_read_u16(const pl_u8 *source)
{
    return (pl_u32)source[0] | ((pl_u32)source[1] << 8u);
}

static inline pl_u32 pl_read_u32(const pl_u8 *source)
{
    return (pl_u32)source[0] | ((pl_u32)source[1] << 8u)
         | ((pl_u32)source[2] << 16u) | ((pl_u32)source[3] << 24u);
}

static inline pl_u64 pl_read_u64(const pl_u8 *source)
{
    return (pl_u64)pl_read_u32(source)
         | ((pl_u64)pl_read_u32(source + 4u) << 32u);
}

static inline pl_i64 pl_read_i64_width(const pl_u8 *source, pl_u32 width)
{
    pl_u64 value = 0u;
    pl_u32 index;
    for (index = 0u; index < width; ++index)
        value |= (pl_u64)source[index] << (index * 8u);
    if (width && width < 8u && ((value >> (width * 8u - 1u)) & 1u))
        value |= ~(pl_u64)0u << (width * 8u);
    return (pl_i64)value;
}

static inline void pl_write_u16(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8u);
}

static inline void pl_write_u32(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8u);
    target[2] = (pl_u8)(value >> 16u);
    target[3] = (pl_u8)(value >> 24u);
}

static inline void pl_write_u64(pl_u8 *target, pl_u64 value)
{
    pl_write_u32(target, (pl_u32)value);
    pl_write_u32(target + 4u, (pl_u32)(value >> 32u));
}

#endif /* SUPPORT_CHECKED_H */
