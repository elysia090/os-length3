#include <postlink/delivery.h>

static const pl_u8 DELIVERY_MAGIC[PL_DELIVERY_MAGIC_BYTES] =
    PL_DELIVERY_MAGIC;

static int compare_digest(const pl_u8 *left, const pl_u8 *right)
{
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
    }
    return 0;
}

static int nonzero_digest(const pl_u8 *digest)
{
    pl_u32 value = 0u;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        value |= digest[index];
    return value != 0u;
}

static int locator_valid(const pl_delivery_locator *locator,
                         pl_u64 pack_bytes)
{
    return locator && nonzero_digest(locator->digest) && locator->bytes
        && locator->offset <= pack_bytes
        && locator->bytes <= pack_bytes - locator->offset;
}

int pl_delivery_index_write(
    const pl_delivery_locator *locators, pl_u32 count, pl_u64 pack_bytes,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!locators || !count || !pack_bytes || !target || !written
            || count > (0xffffffffu - PL_DELIVERY_HEADER_BYTES)
                     / PL_DELIVERY_ROW_BYTES)
        return PL_ERROR_DELIVERY_RANGE;
    pl_u32 extent = PL_DELIVERY_HEADER_BYTES
                  + count * PL_DELIVERY_ROW_BYTES;
    if (extent > capacity) return PL_ERROR_DELIVERY_RANGE;
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        if (!locator_valid(&locators[rank], pack_bytes)
                || (rank && compare_digest(
                    locators[rank - 1u].digest,
                    locators[rank].digest) >= 0))
            return PL_ERROR_DELIVERY;
    }
    for (pl_u32 index = 0u; index < extent; ++index) target[index] = 0u;
    for (pl_u32 index = 0u; index < PL_DELIVERY_MAGIC_BYTES; ++index)
        target[index] = DELIVERY_MAGIC[index];
    pl_write_u32(target + 32u, PL_DELIVERY_VERSION);
    pl_write_u32(target + 36u, PL_DELIVERY_HEADER_BYTES);
    pl_write_u32(target + 40u, count);
    pl_write_u32(target + 44u, PL_DELIVERY_ROW_BYTES);
    pl_write_u64(target + 48u, pack_bytes);
    pl_write_u64(target + 56u, extent);
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        pl_u8 *row = target + PL_DELIVERY_HEADER_BYTES
                   + (pl_u64)rank * PL_DELIVERY_ROW_BYTES;
        for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
            row[index] = locators[rank].digest[index];
        pl_write_u64(row + 32u, locators[rank].offset);
        pl_write_u32(row + 40u, locators[rank].bytes);
        pl_write_u32(row + 44u, 0u);
    }
    *written = extent;
    return 0;
}

int pl_delivery_index_open(
    const pl_u8 *bytes, pl_u64 length, pl_u64 pack_bytes,
    pl_delivery_index *out)
{
    if (!bytes || !out || length < PL_DELIVERY_HEADER_BYTES
            || length > 0xffffffffu)
        return PL_ERROR_DELIVERY_RANGE;
    for (pl_u32 index = 0u; index < PL_DELIVERY_MAGIC_BYTES; ++index)
        if (bytes[index] != DELIVERY_MAGIC[index])
            return PL_ERROR_DELIVERY;
    pl_u32 count = pl_read_u32(bytes + 40u);
    pl_u64 extent = (pl_u64)PL_DELIVERY_HEADER_BYTES
                  + (pl_u64)count * PL_DELIVERY_ROW_BYTES;
    if (pl_read_u32(bytes + 32u) != PL_DELIVERY_VERSION
            || pl_read_u32(bytes + 36u) != PL_DELIVERY_HEADER_BYTES
            || !count
            || pl_read_u32(bytes + 44u) != PL_DELIVERY_ROW_BYTES
            || pl_read_u64(bytes + 48u) != pack_bytes
            || pl_read_u64(bytes + 56u) != extent
            || length != extent)
        return PL_ERROR_DELIVERY;
    pl_delivery_locator prior = { { 0u }, 0u, 0u };
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        const pl_u8 *row = bytes + PL_DELIVERY_HEADER_BYTES
                         + (pl_u64)rank * PL_DELIVERY_ROW_BYTES;
        pl_delivery_locator locator = { { 0u },
            pl_read_u64(row + 32u), pl_read_u32(row + 40u) };
        for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
            locator.digest[index] = row[index];
        if (pl_read_u32(row + 44u)
                || !locator_valid(&locator, pack_bytes)
                || (rank && compare_digest(
                    prior.digest, locator.digest) >= 0))
            return PL_ERROR_DELIVERY;
        prior = locator;
    }
    *out = (pl_delivery_index){ bytes, (pl_u32)length, count, pack_bytes };
    return 0;
}

int pl_delivery_index_find_rank(
    const pl_delivery_index *index,
    const pl_u8 digest[PL_SHA256_BYTES], pl_u32 *rank,
    pl_delivery_locator *out)
{
    if (!index || !digest || !rank || !out) return PL_ERROR_DELIVERY;
    pl_u32 low = 0u, high = index->count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        const pl_u8 *row = index->bytes + PL_DELIVERY_HEADER_BYTES
                         + (pl_u64)middle * PL_DELIVERY_ROW_BYTES;
        if (compare_digest(row, digest) < 0) low = middle + 1u;
        else high = middle;
    }
    if (low >= index->count) return PL_ERROR_DELIVERY_ABSENT;
    const pl_u8 *row = index->bytes + PL_DELIVERY_HEADER_BYTES
                     + (pl_u64)low * PL_DELIVERY_ROW_BYTES;
    if (compare_digest(row, digest)) return PL_ERROR_DELIVERY_ABSENT;
    for (pl_u32 at = 0u; at < PL_SHA256_BYTES; ++at)
        out->digest[at] = row[at];
    out->offset = pl_read_u64(row + 32u);
    out->bytes = pl_read_u32(row + 40u);
    *rank = low;
    return locator_valid(out, index->pack_bytes)
         ? 0 : PL_ERROR_DELIVERY;
}

int pl_delivery_index_find(
    const pl_delivery_index *index,
    const pl_u8 digest[PL_SHA256_BYTES], pl_delivery_locator *out)
{
    pl_u32 rank = 0u;
    return pl_delivery_index_find_rank(index, digest, &rank, out);
}

int pl_delivery_payload_validate(
    const pl_delivery_locator *locator,
    const pl_u8 *payload, pl_u64 bytes)
{
    if (!locator || !payload || bytes != locator->bytes)
        return PL_ERROR_DELIVERY_RANGE;
    pl_u8 digest[PL_SHA256_BYTES];
    pl_sha256_digest(payload, bytes, digest);
    return compare_digest(locator->digest, digest)
         ? PL_ERROR_DELIVERY : 0;
}
