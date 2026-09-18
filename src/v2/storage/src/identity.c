#include <storage/identity.h>
#include <support/checked.h>

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    pl_u32 different = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index)
        different |= (pl_u32)(left[index] ^ right[index]);
    return different == 0u;
}

static int nonzero_digest(const pl_u8 digest[PL_SHA256_BYTES])
{
    pl_u32 value = 0u;
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        value |= digest[index];
    return value != 0u;
}

static int read_uleb(const pl_u8 *bytes, pl_u32 length, pl_u32 *cursor,
                     pl_u64 *value)
{
    if (!bytes || !cursor || !value || *cursor >= length)
        return PL_ERROR_PHYSICAL_RANGE;
    pl_u32 start = *cursor;
    pl_u64 result = 0u;
    pl_u32 shift = 0u;
    for (;;) {
        if (*cursor >= length || shift > 63u)
            return PL_ERROR_PHYSICAL_RANGE;
        pl_u8 byte = bytes[(*cursor)++];
        pl_u64 lane = (pl_u64)(byte & 0x7fu);
        if (shift == 63u && lane > 1u)
            return PL_ERROR_PHYSICAL_RANGE;
        result |= lane << shift;
        if (!(byte & 0x80u)) {
            if (*cursor - start > 1u && !lane)
                return PL_ERROR_PHYSICAL;
            *value = result;
            return 0;
        }
        shift += 7u;
    }
}

static int manifest_open(const pl_u8 *bytes, pl_u32 length,
                         pl_physical_bundle *out)
{
    if (!bytes || !out || length < PL_PHYSICAL_MANIFEST_HEADER_BYTES
            || !same_bytes(bytes, (const pl_u8 *)PL_PHYSICAL_MANIFEST_MAGIC,
                           4u)
            || pl_read_u16(bytes + 4u) != PL_PHYSICAL_MANIFEST_VERSION
            || pl_read_u16(bytes + 6u)
               != PL_PHYSICAL_MANIFEST_HEADER_BYTES)
        return PL_ERROR_PHYSICAL;
    pl_u64 object_length = pl_read_u64(bytes + 48u);
    pl_u32 page_bytes = pl_read_u32(bytes + 56u);
    pl_u32 unique_pages = pl_read_u32(bytes + 60u);
    pl_u16 data_shards = (pl_u16)pl_read_u16(bytes + 64u);
    pl_u16 parity_shards = (pl_u16)pl_read_u16(bytes + 66u);
    pl_u32 nonzero_pages = pl_read_u32(bytes + 100u);
    if (!object_length || !page_bytes || !unique_pages || !data_shards
            || !parity_shards
            || object_length > ~(pl_u64)0 - (page_bytes - 1u))
        return PL_ERROR_PHYSICAL_RANGE;
    pl_u64 wide_pages = (object_length + page_bytes - 1u) / page_bytes;
    if (!wide_pages || wide_pages > 0xffffffffu
            || nonzero_pages < unique_pages
            || nonzero_pages > (pl_u32)wide_pages)
        return PL_ERROR_PHYSICAL_RANGE;

    pl_u32 cursor = PL_PHYSICAL_MANIFEST_HEADER_BYTES;
    pl_u64 previous = ~(pl_u64)0;
    pl_u32 next_rank = 1u;
    for (pl_u32 ordinal = 0u; ordinal < nonzero_pages; ++ordinal) {
        pl_u64 gap = 0u, rank = 0u;
        int status = read_uleb(bytes, length, &cursor, &gap);
        if (!status) status = read_uleb(bytes, length, &cursor, &rank);
        pl_u64 page = previous == ~(pl_u64)0 ? gap : previous + gap + 1u;
        if (status || page >= wide_pages || !rank || rank > unique_pages
                || (rank >= next_rank && rank != next_rank))
            return PL_ERROR_PHYSICAL;
        if (rank == next_rank) ++next_rank;
        previous = page;
    }
    if (cursor != length || next_rank != unique_pages + 1u)
        return PL_ERROR_PHYSICAL;

    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index) {
        out->object_digest[index] = bytes[8u + index];
        out->shard_root[index] = bytes[68u + index];
    }
    if (!nonzero_digest(out->object_digest)
            || !nonzero_digest(out->shard_root))
        return PL_ERROR_PHYSICAL_DIGEST;
    out->generation = pl_read_u64(bytes + 40u);
    out->length = object_length;
    out->page_bytes = page_bytes;
    out->page_count = (pl_u32)wide_pages;
    out->unique_pages = unique_pages;
    out->nonzero_pages = nonzero_pages;
    out->data_shards = data_shards;
    out->parity_shards = parity_shards;
    out->directory = bytes + PL_PHYSICAL_MANIFEST_HEADER_BYTES;
    out->directory_bytes = length - PL_PHYSICAL_MANIFEST_HEADER_BYTES;
    return 0;
}

int pl_physical_bundle_open(const pl_u8 *bytes, pl_u64 length,
                            pl_physical_bundle *out)
{
    if (!bytes || !out || length < PL_PHYSICAL_BUNDLE_HEADER_BYTES
            || !same_bytes(bytes, (const pl_u8 *)PL_PHYSICAL_BUNDLE_MAGIC,
                           4u)
            || pl_read_u16(bytes + 4u) != PL_PHYSICAL_BUNDLE_VERSION
            || pl_read_u16(bytes + 6u)
               != PL_PHYSICAL_BUNDLE_HEADER_BYTES)
        return PL_ERROR_PHYSICAL;
    pl_u32 manifest_bytes = pl_read_u32(bytes + 8u);
    pl_u32 record_count = pl_read_u32(bytes + 12u);
    pl_u32 proof_nodes = pl_read_u32(bytes + 16u);
    pl_u64 prefix = (pl_u64)PL_PHYSICAL_BUNDLE_HEADER_BYTES
                  + manifest_bytes
                  + (pl_u64)record_count * PL_PHYSICAL_BUNDLE_RECORD_BYTES;
    if (!manifest_bytes || !record_count || proof_nodes || prefix > length)
        return PL_ERROR_PHYSICAL_RANGE;

    pl_physical_bundle parsed = { 0 };
    int status = manifest_open(
        bytes + PL_PHYSICAL_BUNDLE_HEADER_BYTES, manifest_bytes, &parsed);
    if (status) return status;
    const pl_u8 *records = bytes + PL_PHYSICAL_BUNDLE_HEADER_BYTES
                         + manifest_bytes;
    pl_u64 payload_end = 0u;
    pl_u64 prior_position = ~(pl_u64)0;
    pl_u32 data_records = 0u;
    pl_u32 total_shards = (pl_u32)parsed.data_shards
                        + (pl_u32)parsed.parity_shards;
    pl_u32 group_count = parsed.unique_pages / parsed.data_shards
                       + (parsed.unique_pages % parsed.data_shards != 0u);
    for (pl_u32 rank = 0u; rank < record_count; ++rank) {
        const pl_u8 *row = records
                         + (pl_u64)rank * PL_PHYSICAL_BUNDLE_RECORD_BYTES;
        pl_u32 group = pl_read_u32(row);
        pl_u16 slot = (pl_u16)pl_read_u16(row + 4u);
        pl_u32 offset = pl_read_u32(row + 6u);
        pl_u32 payload_bytes = pl_read_u32(row + 10u);
        pl_u64 position = (pl_u64)group * total_shards + slot;
        if (group >= group_count || slot >= total_shards || !payload_bytes
                || (rank && position <= prior_position)
                || offset != payload_end
                || !nonzero_digest(row + 14u))
            return PL_ERROR_PHYSICAL;
        if (slot < parsed.data_shards) {
            pl_u64 unique = (pl_u64)group * parsed.data_shards + slot;
            if (unique < parsed.unique_pages) ++data_records;
        }
        prior_position = position;
        payload_end += payload_bytes;
        if (payload_end > length - prefix)
            return PL_ERROR_PHYSICAL_RANGE;
    }
    if (prefix + payload_end != length
            || data_records != parsed.unique_pages)
        return PL_ERROR_PHYSICAL;
    parsed.bytes = bytes;
    parsed.bytes_count = length;
    parsed.records = records;
    parsed.record_count = record_count;
    parsed.payloads = bytes + prefix;
    parsed.payload_bytes = payload_end;
    *out = parsed;
    return 0;
}

void pl_physical_cursor_open(const pl_physical_bundle *bundle,
                             pl_physical_cursor *cursor)
{
    if (!cursor) return;
    *cursor = (pl_physical_cursor){ bundle, 0u, 0u, 0xffffffffu };
}

int pl_physical_cursor_next(pl_physical_cursor *cursor,
                            pl_u32 *logical_page, pl_u32 *unique_rank)
{
    if (!cursor || !cursor->bundle || !logical_page || !unique_rank)
        return PL_ERROR_PHYSICAL;
    if (cursor->ordinal == cursor->bundle->nonzero_pages) {
        if (cursor->cursor != cursor->bundle->directory_bytes)
            return PL_ERROR_PHYSICAL;
        return 0;
    }
    pl_u64 gap = 0u, rank = 0u;
    int status = read_uleb(
        cursor->bundle->directory, cursor->bundle->directory_bytes,
        &cursor->cursor, &gap);
    if (!status)
        status = read_uleb(
            cursor->bundle->directory, cursor->bundle->directory_bytes,
            &cursor->cursor, &rank);
    pl_u64 page = cursor->prior_page == 0xffffffffu
                ? gap : (pl_u64)cursor->prior_page + gap + 1u;
    if (status || page >= cursor->bundle->page_count
            || !rank || rank > cursor->bundle->unique_pages)
        return PL_ERROR_PHYSICAL;
    cursor->prior_page = (pl_u32)page;
    ++cursor->ordinal;
    *logical_page = (pl_u32)page;
    *unique_rank = (pl_u32)rank;
    return 1;
}

int pl_physical_bundle_record(const pl_physical_bundle *bundle,
                              pl_u32 unique_rank,
                              pl_physical_record *out)
{
    if (!bundle || !out || !unique_rank
            || unique_rank > bundle->unique_pages)
        return PL_ERROR_PHYSICAL_RANGE;
    pl_u32 group = (unique_rank - 1u) / bundle->data_shards;
    pl_u16 slot = (pl_u16)((unique_rank - 1u) % bundle->data_shards);
    pl_u64 wanted = (pl_u64)group
                  * ((pl_u32)bundle->data_shards + bundle->parity_shards)
                  + slot;
    pl_u32 low = 0u, high = bundle->record_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        const pl_u8 *row = bundle->records
                         + (pl_u64)middle
                           * PL_PHYSICAL_BUNDLE_RECORD_BYTES;
        pl_u64 position = (pl_u64)pl_read_u32(row)
                        * ((pl_u32)bundle->data_shards
                           + bundle->parity_shards)
                        + pl_read_u16(row + 4u);
        if (position < wanted) low = middle + 1u;
        else high = middle;
    }
    if (low >= bundle->record_count)
        return PL_ERROR_PHYSICAL_ABSENT;
    const pl_u8 *row = bundle->records
                     + (pl_u64)low * PL_PHYSICAL_BUNDLE_RECORD_BYTES;
    if (pl_read_u32(row) != group || pl_read_u16(row + 4u) != slot)
        return PL_ERROR_PHYSICAL_ABSENT;
    pl_u32 offset = pl_read_u32(row + 6u);
    pl_u32 payload_bytes = pl_read_u32(row + 10u);
    if ((pl_u64)offset + payload_bytes > bundle->payload_bytes)
        return PL_ERROR_PHYSICAL_RANGE;
    pl_physical_record record = {
        group, slot, bundle->payloads + offset, payload_bytes, { 0u }
    };
    for (pl_u32 index = 0u; index < PL_SHA256_BYTES; ++index)
        record.digest[index] = row[14u + index];
    *out = record;
    return 0;
}

int pl_physical_bundle_decode(const pl_physical_bundle *bundle,
                              pl_u32 unique_rank,
                              pl_u8 *target, pl_u32 target_bytes,
                              pl_physical_inflate inflate, void *context)
{
    if (!bundle || !target || target_bytes != bundle->page_bytes)
        return PL_ERROR_PHYSICAL_RANGE;
    pl_physical_record record;
    int status = pl_physical_bundle_record(bundle, unique_rank, &record);
    if (status) return status;
    if (!record.payload_bytes) return PL_ERROR_PHYSICAL_CODEC;
    pl_u8 codec = record.payload[0];
    if (!codec) {
        if (record.payload_bytes != target_bytes + 1u)
            return PL_ERROR_PHYSICAL_CODEC;
        for (pl_u32 index = 0u; index < target_bytes; ++index)
            target[index] = record.payload[index + 1u];
    } else if (codec == 1u) {
        if (!inflate || inflate(
                context, record.payload + 1u, record.payload_bytes - 1u,
                target, target_bytes))
            return PL_ERROR_PHYSICAL_CODEC;
    } else {
        return PL_ERROR_PHYSICAL_CODEC;
    }
    pl_sha256 hash;
    pl_u8 digest[PL_SHA256_BYTES];
    const pl_u8 leaf = 0u;
    pl_sha256_open(&hash);
    pl_sha256_write(&hash, &leaf, 1u);
    pl_sha256_write(&hash, target, target_bytes);
    pl_sha256_close(&hash, digest);
    return same_bytes(digest, record.digest, PL_SHA256_BYTES)
         ? 0 : PL_ERROR_PHYSICAL_DIGEST;
}
