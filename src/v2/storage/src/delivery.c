#include <storage/delivery.h>
#include <support/checked.h>

static const pl_u8 DELIVERY_MAGIC[PL_DELIVERY_MAGIC_BYTES] =
    PL_DELIVERY_MAGIC;
static const pl_u8 DELIVERY_DIRECTORY_MAGIC[PL_DELIVERY_MAGIC_BYTES] =
    PL_DELIVERY_DIRECTORY_MAGIC;
static const pl_u8 DELIVERY_NODE_MAGIC[PL_DELIVERY_MAGIC_BYTES] =
    PL_DELIVERY_NODE_MAGIC;

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

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 count)
{
    pl_u32 different = 0u;
    for (pl_u32 index = 0u; index < count; ++index)
        different |= (pl_u32)(left[index] ^ right[index]);
    return different == 0u;
}

static void copy_bytes(pl_u8 *target, const pl_u8 *source, pl_u32 count)
{
    for (pl_u32 index = 0u; index < count; ++index)
        target[index] = source[index];
}

static void clear_bytes(pl_u8 *target, pl_u32 count)
{
    for (pl_u32 index = 0u; index < count; ++index) target[index] = 0u;
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

int pl_delivery_ref_validate(const pl_delivery_ref *ref, pl_u64 pack_bytes)
{
    return ref && pack_bytes && nonzero_digest(ref->digest)
        && ref->node_bytes >= PL_DELIVERY_NODE_HEADER_BYTES
        && ref->node_bytes <= PL_DELIVERY_NODE_BYTES
        && ref->level <= PL_DELIVERY_MAX_LEVEL && ref->rows
        && compare_digest(ref->first, ref->last) <= 0
        && ref->offset <= pack_bytes
        && ref->node_bytes <= pack_bytes - ref->offset
         ? 0 : PL_ERROR_DELIVERY_RANGE;
}

int pl_delivery_ref_read(
    const pl_u8 bytes[PL_DELIVERY_REF_BYTES], pl_u64 pack_bytes,
    pl_delivery_ref *out)
{
    if (!bytes || !out || pl_read_u64(bytes + 120u))
        return PL_ERROR_DELIVERY;
    copy_bytes(out->digest, bytes, PL_SHA256_BYTES);
    out->offset = pl_read_u64(bytes + 32u);
    out->node_bytes = pl_read_u32(bytes + 40u);
    out->level = pl_read_u32(bytes + 44u);
    out->rows = pl_read_u64(bytes + 48u);
    copy_bytes(out->first, bytes + 56u, PL_SHA256_BYTES);
    copy_bytes(out->last, bytes + 88u, PL_SHA256_BYTES);
    return pl_delivery_ref_validate(out, pack_bytes);
}

int pl_delivery_ref_write(
    const pl_delivery_ref *ref, pl_u64 pack_bytes,
    pl_u8 bytes[PL_DELIVERY_REF_BYTES])
{
    int status = pl_delivery_ref_validate(ref, pack_bytes);
    if (status || !bytes) return status ? status : PL_ERROR_DELIVERY;
    clear_bytes(bytes, PL_DELIVERY_REF_BYTES);
    copy_bytes(bytes, ref->digest, PL_SHA256_BYTES);
    pl_write_u64(bytes + 32u, ref->offset);
    pl_write_u32(bytes + 40u, ref->node_bytes);
    pl_write_u32(bytes + 44u, ref->level);
    pl_write_u64(bytes + 48u, ref->rows);
    copy_bytes(bytes + 56u, ref->first, PL_SHA256_BYTES);
    copy_bytes(bytes + 88u, ref->last, PL_SHA256_BYTES);
    return 0;
}

static void write_node_header(
    pl_u8 *target, pl_u32 level, pl_u32 row_count, pl_u32 row_bytes,
    pl_u64 rows, const pl_u8 *first, const pl_u8 *last, pl_u32 file_bytes)
{
    clear_bytes(target, PL_DELIVERY_NODE_HEADER_BYTES);
    copy_bytes(target, DELIVERY_NODE_MAGIC, PL_DELIVERY_MAGIC_BYTES);
    pl_write_u32(target + 32u, PL_DELIVERY_DIRECTORY_VERSION);
    pl_write_u32(target + 36u, PL_DELIVERY_NODE_HEADER_BYTES);
    pl_write_u32(target + 40u, level);
    pl_write_u32(target + 44u, row_count);
    pl_write_u32(target + 48u, row_bytes);
    pl_write_u32(target + 52u, file_bytes);
    pl_write_u64(target + 56u, rows);
    copy_bytes(target + 64u, first, PL_SHA256_BYTES);
    copy_bytes(target + 96u, last, PL_SHA256_BYTES);
}

static void write_locator(const pl_delivery_locator *locator, pl_u8 *row)
{
    clear_bytes(row, PL_DELIVERY_LEAF_ROW_BYTES);
    copy_bytes(row, locator->digest, PL_SHA256_BYTES);
    pl_write_u64(row + 32u, locator->offset);
    pl_write_u32(row + 40u, locator->bytes);
}

static int read_locator(const pl_u8 *row, pl_u64 pack_bytes,
                        pl_delivery_locator *out)
{
    if (!row || !out || pl_read_u32(row + 44u))
        return PL_ERROR_DELIVERY;
    copy_bytes(out->digest, row, PL_SHA256_BYTES);
    out->offset = pl_read_u64(row + 32u);
    out->bytes = pl_read_u32(row + 40u);
    return locator_valid(out, pack_bytes) ? 0 : PL_ERROR_DELIVERY;
}

int pl_delivery_leaf_write(
    const pl_delivery_locator *locators, pl_u32 count,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!locators || !count || count > PL_DELIVERY_LEAF_CAPACITY
            || !target || !written)
        return PL_ERROR_DELIVERY_RANGE;
    pl_u32 bytes = PL_DELIVERY_NODE_HEADER_BYTES
                 + count * PL_DELIVERY_LEAF_ROW_BYTES;
    if (bytes > capacity) return PL_ERROR_DELIVERY_RANGE;
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        if (!nonzero_digest(locators[rank].digest) || !locators[rank].bytes
                || (rank && compare_digest(
                    locators[rank - 1u].digest,
                    locators[rank].digest) >= 0))
            return PL_ERROR_DELIVERY;
    }
    write_node_header(
        target, 0u, count, PL_DELIVERY_LEAF_ROW_BYTES, count,
        locators[0].digest, locators[count - 1u].digest, bytes);
    for (pl_u32 rank = 0u; rank < count; ++rank)
        write_locator(&locators[rank],
                      target + PL_DELIVERY_NODE_HEADER_BYTES
                             + (pl_u64)rank * PL_DELIVERY_LEAF_ROW_BYTES);
    *written = bytes;
    return 0;
}

int pl_delivery_branch_write(
    const pl_delivery_ref *children, pl_u32 count, pl_u64 pack_bytes,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!children || count < 2u || count > PL_DELIVERY_BRANCH_CAPACITY
            || !pack_bytes || !target || !written)
        return PL_ERROR_DELIVERY_RANGE;
    pl_u32 bytes = PL_DELIVERY_NODE_HEADER_BYTES
                 + count * PL_DELIVERY_BRANCH_ROW_BYTES;
    if (bytes > capacity) return PL_ERROR_DELIVERY_RANGE;
    pl_u32 child_level = children[0].level;
    pl_u64 rows = 0u;
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        const pl_delivery_ref *child = &children[rank];
        if (pl_delivery_ref_validate(child, pack_bytes)
                || child->level != child_level
                || (rank && compare_digest(
                    children[rank - 1u].last, child->first) >= 0)
                || rows > ~(pl_u64)0 - child->rows)
            return PL_ERROR_DELIVERY;
        rows += child->rows;
    }
    if (child_level >= PL_DELIVERY_MAX_LEVEL)
        return PL_ERROR_DELIVERY_RANGE;
    write_node_header(
        target, child_level + 1u, count, PL_DELIVERY_BRANCH_ROW_BYTES,
        rows, children[0].first, children[count - 1u].last, bytes);
    for (pl_u32 rank = 0u; rank < count; ++rank) {
        int status = pl_delivery_ref_write(
            &children[rank], pack_bytes,
            target + PL_DELIVERY_NODE_HEADER_BYTES
                   + (pl_u64)rank * PL_DELIVERY_BRANCH_ROW_BYTES);
        if (status) return status;
    }
    *written = bytes;
    return 0;
}

static int open_node_structure(
    const pl_u8 *bytes, pl_u32 length, pl_u64 pack_bytes,
    pl_delivery_node *out)
{
    if (!bytes || !out || !pack_bytes
            || length < PL_DELIVERY_NODE_HEADER_BYTES
            || length > PL_DELIVERY_NODE_BYTES
            || !same_bytes(bytes, DELIVERY_NODE_MAGIC,
                           PL_DELIVERY_MAGIC_BYTES))
        return PL_ERROR_DELIVERY_RANGE;
    pl_u32 version = pl_read_u32(bytes + 32u);
    pl_u32 header_bytes = pl_read_u32(bytes + 36u);
    pl_u32 level = pl_read_u32(bytes + 40u);
    pl_u32 row_count = pl_read_u32(bytes + 44u);
    pl_u32 row_bytes = pl_read_u32(bytes + 48u);
    pl_u32 file_bytes = pl_read_u32(bytes + 52u);
    pl_u64 rows = pl_read_u64(bytes + 56u);
    const pl_u8 *first = bytes + 64u;
    const pl_u8 *last = bytes + 96u;
    pl_u32 expected_row_bytes = level
        ? PL_DELIVERY_BRANCH_ROW_BYTES : PL_DELIVERY_LEAF_ROW_BYTES;
    pl_u32 row_capacity = level
        ? PL_DELIVERY_BRANCH_CAPACITY : PL_DELIVERY_LEAF_CAPACITY;
    pl_u64 wide = (pl_u64)PL_DELIVERY_NODE_HEADER_BYTES
                + (pl_u64)row_count * row_bytes;
    if (version != PL_DELIVERY_DIRECTORY_VERSION
            || header_bytes != PL_DELIVERY_NODE_HEADER_BYTES
            || level > PL_DELIVERY_MAX_LEVEL || !row_count
            || row_count > row_capacity || row_bytes != expected_row_bytes
            || wide != length || file_bytes != length || !rows
            || compare_digest(first, last) > 0)
        return PL_ERROR_DELIVERY;

    pl_u64 observed_rows = 0u;
    pl_u8 prior_last[PL_SHA256_BYTES] = { 0u };
    for (pl_u32 rank = 0u; rank < row_count; ++rank) {
        const pl_u8 *row = bytes + PL_DELIVERY_NODE_HEADER_BYTES
                         + (pl_u64)rank * row_bytes;
        const pl_u8 *row_first = 0, *row_last = 0;
        pl_u64 row_rows = 0u;
        pl_delivery_locator locator;
        pl_delivery_ref child;
        int status;
        if (!level) {
            status = read_locator(row, pack_bytes, &locator);
            row_first = row_last = locator.digest;
            row_rows = 1u;
        } else {
            status = pl_delivery_ref_read(row, pack_bytes, &child);
            if (!status && child.level + 1u != level)
                status = PL_ERROR_DELIVERY;
            row_first = child.first;
            row_last = child.last;
            row_rows = child.rows;
        }
        if (status || (rank && compare_digest(prior_last, row_first) >= 0)
                || observed_rows > ~(pl_u64)0 - row_rows
                || (!rank && compare_digest(first, row_first))
                || (rank + 1u == row_count
                    && compare_digest(last, row_last)))
            return PL_ERROR_DELIVERY;
        copy_bytes(prior_last, row_last, PL_SHA256_BYTES);
        observed_rows += row_rows;
    }
    if (observed_rows != rows) return PL_ERROR_DELIVERY;
    *out = (pl_delivery_node){
        bytes, length, level, row_count, row_bytes, rows, first, last,
    };
    return 0;
}

int pl_delivery_ref_from_node(
    const pl_u8 *bytes, pl_u32 length, pl_u64 offset, pl_u64 pack_bytes,
    pl_delivery_ref *out)
{
    pl_delivery_node node;
    int status = open_node_structure(bytes, length, pack_bytes, &node);
    if (status || !out || offset > pack_bytes
            || length > pack_bytes - offset)
        return status ? status : PL_ERROR_DELIVERY_RANGE;
    pl_sha256_digest(bytes, length, out->digest);
    out->offset = offset;
    out->node_bytes = length;
    out->level = node.level;
    out->rows = node.rows;
    copy_bytes(out->first, node.first, PL_SHA256_BYTES);
    copy_bytes(out->last, node.last, PL_SHA256_BYTES);
    return pl_delivery_ref_validate(out, pack_bytes);
}

int pl_delivery_directory_write(
    const pl_delivery_ref *root, pl_u64 pack_bytes,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    int status = pl_delivery_ref_validate(root, pack_bytes);
    if (status || !target || !written
            || capacity < PL_DELIVERY_DIRECTORY_BYTES)
        return status ? status : PL_ERROR_DELIVERY_RANGE;
    clear_bytes(target, PL_DELIVERY_DIRECTORY_BYTES);
    copy_bytes(target, DELIVERY_DIRECTORY_MAGIC, PL_DELIVERY_MAGIC_BYTES);
    pl_write_u32(target + 32u, PL_DELIVERY_DIRECTORY_VERSION);
    pl_write_u32(target + 36u, PL_DELIVERY_DIRECTORY_BYTES);
    pl_write_u64(target + 40u, pack_bytes);
    status = pl_delivery_ref_write(root, pack_bytes, target + 48u);
    if (status) return status;
    pl_write_u64(target + 176u, PL_DELIVERY_DIRECTORY_BYTES);
    *written = PL_DELIVERY_DIRECTORY_BYTES;
    return 0;
}

int pl_delivery_directory_open(
    const pl_u8 *bytes, pl_u64 length, pl_delivery_directory *out)
{
    if (!bytes || !out || length != PL_DELIVERY_DIRECTORY_BYTES
            || !same_bytes(bytes, DELIVERY_DIRECTORY_MAGIC,
                           PL_DELIVERY_MAGIC_BYTES)
            || pl_read_u32(bytes + 32u)
               != PL_DELIVERY_DIRECTORY_VERSION
            || pl_read_u32(bytes + 36u) != PL_DELIVERY_DIRECTORY_BYTES
            || pl_read_u64(bytes + 176u) != PL_DELIVERY_DIRECTORY_BYTES
            || pl_read_u64(bytes + 184u))
        return PL_ERROR_DELIVERY;
    pl_u64 pack_bytes = pl_read_u64(bytes + 40u);
    pl_delivery_ref root;
    int status = pl_delivery_ref_read(bytes + 48u, pack_bytes, &root);
    if (status) return status;
    *out = (pl_delivery_directory){ pack_bytes, root };
    return 0;
}

int pl_delivery_node_open(
    const pl_delivery_directory *directory,
    const pl_delivery_ref *expected,
    const pl_u8 *bytes, pl_u32 length, pl_delivery_node *out)
{
    if (!directory || pl_delivery_ref_validate(
            expected, directory->pack_bytes)
            || !bytes || !out || length != expected->node_bytes)
        return PL_ERROR_DELIVERY_RANGE;
    pl_u8 digest[PL_SHA256_BYTES];
    pl_sha256_digest(bytes, length, digest);
    if (!same_bytes(digest, expected->digest, PL_SHA256_BYTES))
        return PL_ERROR_DELIVERY;
    pl_delivery_node node;
    int status = open_node_structure(
        bytes, length, directory->pack_bytes, &node);
    if (status || node.level != expected->level
            || node.rows != expected->rows
            || compare_digest(node.first, expected->first)
            || compare_digest(node.last, expected->last))
        return status ? status : PL_ERROR_DELIVERY;
    *out = node;
    return 0;
}

int pl_delivery_node_select(
    const pl_delivery_directory *directory, const pl_delivery_node *node,
    const pl_u8 digest[PL_SHA256_BYTES], pl_delivery_ref *out)
{
    if (!directory || !node || !digest || !out || !node->level
            || compare_digest(digest, node->first) < 0
            || compare_digest(digest, node->last) > 0)
        return PL_ERROR_DELIVERY_ABSENT;
    pl_u32 low = 0u, high = node->row_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        pl_delivery_ref child;
        int status = pl_delivery_ref_read(
            node->bytes + PL_DELIVERY_NODE_HEADER_BYTES
                        + (pl_u64)middle * node->row_bytes,
            directory->pack_bytes, &child);
        if (status) return status;
        if (compare_digest(child.last, digest) < 0) low = middle + 1u;
        else high = middle;
    }
    if (low >= node->row_count) return PL_ERROR_DELIVERY_ABSENT;
    int status = pl_delivery_ref_read(
        node->bytes + PL_DELIVERY_NODE_HEADER_BYTES
                    + (pl_u64)low * node->row_bytes,
        directory->pack_bytes, out);
    if (status) return status;
    return compare_digest(digest, out->first) < 0
         ? PL_ERROR_DELIVERY_ABSENT : 0;
}

int pl_delivery_node_find(
    const pl_delivery_directory *directory, const pl_delivery_node *node,
    const pl_u8 digest[PL_SHA256_BYTES], pl_delivery_locator *out)
{
    if (!directory || !node || !digest || !out || node->level)
        return PL_ERROR_DELIVERY;
    pl_u32 low = 0u, high = node->row_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        const pl_u8 *row = node->bytes + PL_DELIVERY_NODE_HEADER_BYTES
                          + (pl_u64)middle * node->row_bytes;
        if (compare_digest(row, digest) < 0) low = middle + 1u;
        else high = middle;
    }
    if (low >= node->row_count) return PL_ERROR_DELIVERY_ABSENT;
    const pl_u8 *row = node->bytes + PL_DELIVERY_NODE_HEADER_BYTES
                      + (pl_u64)low * node->row_bytes;
    if (compare_digest(row, digest)) return PL_ERROR_DELIVERY_ABSENT;
    return read_locator(row, directory->pack_bytes, out);
}
