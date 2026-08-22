#include <postlink/index.h>

static int same_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 count)
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0; index < count; ++index)
        difference |= (pl_u32)(left[index] ^ right[index]);
    return difference == 0u;
}

static void copy_bytes(pl_u8 *target, const pl_u8 *source, pl_u32 count)
{
    for (pl_u32 index = 0; index < count; ++index)
        target[index] = source[index];
}

static int nonzero_digest(const pl_u8 *digest)
{
    pl_u32 value = 0u;
    for (pl_u32 index = 0; index < PL_SHA256_BYTES; ++index)
        value |= digest[index];
    return value != 0u;
}

int pl_index_key_compare(pl_index_key left, pl_index_key right)
{
    if (left.major < right.major) return -1;
    if (left.major > right.major) return 1;
    if (left.minor < right.minor) return -1;
    if (left.minor > right.minor) return 1;
    return 0;
}

static pl_index_key read_key(const pl_u8 *row)
{
    pl_index_key key = { pl_read_u64(row), pl_read_u64(row + 8u) };
    return key;
}

static void write_key(pl_u8 *row, pl_index_key key)
{
    pl_write_u64(row, key.major);
    pl_write_u64(row + 8u, key.minor);
}

int pl_index_ref_read(const pl_u8 row[PL_INDEX_REF_BYTES],
                      pl_index_ref *out)
{
    if (!row || !out) return PL_ERROR_INDEX;
    copy_bytes(out->digest, row, PL_SHA256_BYTES);
    out->rows = pl_read_u64(row + 32u);
    out->node_bytes = pl_read_u32(row + 40u);
    out->level = pl_read_u32(row + 44u);
    out->leaf_row_bytes = pl_read_u32(row + 48u);
    out->reserved = pl_read_u32(row + 52u);
    out->first = read_key(row + 56u);
    out->last = read_key(row + 72u);
    return pl_index_ref_validate(out);
}

int pl_index_ref_write(const pl_index_ref *ref,
                       pl_u8 row[PL_INDEX_REF_BYTES])
{
    int status = pl_index_ref_validate(ref);
    if (status || !row) return status ? status : PL_ERROR_INDEX;
    copy_bytes(row, ref->digest, PL_SHA256_BYTES);
    pl_write_u64(row + 32u, ref->rows);
    pl_write_u32(row + 40u, ref->node_bytes);
    pl_write_u32(row + 44u, ref->level);
    pl_write_u32(row + 48u, ref->leaf_row_bytes);
    pl_write_u32(row + 52u, 0u);
    write_key(row + 56u, ref->first);
    write_key(row + 72u, ref->last);
    return 0;
}

int pl_index_ref_validate(const pl_index_ref *ref)
{
    return ref && nonzero_digest(ref->digest) && ref->rows
        && ref->node_bytes >= PL_INDEX_HEADER_BYTES
        && ref->node_bytes <= PL_INDEX_NODE_BYTES
        && ref->level <= PL_INDEX_MAX_LEVEL
        && ref->leaf_row_bytes >= PL_INDEX_KEY_BYTES
        && ref->leaf_row_bytes <= PL_INDEX_NODE_BYTES - PL_INDEX_HEADER_BYTES
        && !ref->reserved
        && pl_index_key_compare(ref->first, ref->last) <= 0
         ? 0 : PL_ERROR_INDEX;
}

static int extent(pl_u32 rows, pl_u32 row_bytes, pl_u32 *bytes)
{
    if (!rows || !row_bytes
            || rows > (PL_INDEX_NODE_BYTES - PL_INDEX_HEADER_BYTES)
                      / row_bytes)
        return 0;
    *bytes = PL_INDEX_HEADER_BYTES + rows * row_bytes;
    return 1;
}

static void write_header(pl_u8 *target, pl_u32 level,
                         pl_u32 leaf_row_bytes, pl_u32 row_bytes,
                         pl_u32 row_count, pl_index_key first,
                         pl_index_key last, pl_u32 file_bytes)
{
    for (pl_u32 index = 0; index < PL_INDEX_MAGIC_BYTES; ++index)
        target[index] = index < sizeof(PL_INDEX_MAGIC) - 1u
                      ? (pl_u8)PL_INDEX_MAGIC[index] : 0u;
    pl_write_u32(target + 32u, PL_INDEX_VERSION);
    pl_write_u32(target + 36u, PL_INDEX_HEADER_BYTES);
    pl_write_u32(target + 40u, level);
    pl_write_u32(target + 44u, leaf_row_bytes);
    pl_write_u32(target + 48u, row_count);
    pl_write_u32(target + 52u, row_bytes);
    write_key(target + 56u, first);
    write_key(target + 72u, last);
    pl_write_u32(target + 88u, file_bytes);
    pl_write_u32(target + 92u, 0u);
}

int pl_index_leaf_write(const pl_u8 *rows, pl_u32 row_bytes,
                        pl_u32 row_count, pl_u8 *target, pl_u32 capacity,
                        pl_u32 *written)
{
    pl_u32 bytes = 0u;
    if (!rows || !target || !written || row_bytes < PL_INDEX_KEY_BYTES
            || !extent(row_count, row_bytes, &bytes) || bytes > capacity)
        return PL_ERROR_INDEX_RANGE;
    pl_index_key first = read_key(rows);
    pl_index_key prior = first;
    for (pl_u32 index = 1u; index < row_count; ++index) {
        pl_index_key key = read_key(rows + (pl_u64)index * row_bytes);
        if (pl_index_key_compare(prior, key) >= 0) return PL_ERROR_INDEX;
        prior = key;
    }
    write_header(target, 0u, row_bytes, row_bytes, row_count,
                 first, prior, bytes);
    copy_bytes(target + PL_INDEX_HEADER_BYTES, rows,
               row_count * row_bytes);
    *written = bytes;
    return 0;
}

int pl_index_branch_write(const pl_index_ref *children, pl_u32 child_count,
                          pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    pl_u32 bytes = 0u;
    if (!children || !target || !written
            || !extent(child_count, PL_INDEX_REF_BYTES, &bytes)
            || bytes > capacity || pl_index_ref_validate(&children[0]))
        return PL_ERROR_INDEX_RANGE;
    pl_u32 level = children[0].level + 1u;
    pl_u32 leaf_row_bytes = children[0].leaf_row_bytes;
    if (level > PL_INDEX_MAX_LEVEL) return PL_ERROR_INDEX_RANGE;
    pl_index_key prior = children[0].last;
    for (pl_u32 index = 0u; index < child_count; ++index) {
        const pl_index_ref *child = &children[index];
        if (pl_index_ref_validate(child) || child->level + 1u != level
                || child->leaf_row_bytes != leaf_row_bytes
                || (index && pl_index_key_compare(prior, child->first) >= 0))
            return PL_ERROR_INDEX;
        prior = child->last;
    }
    write_header(target, level, leaf_row_bytes, PL_INDEX_REF_BYTES,
                 child_count, children[0].first,
                 children[child_count - 1u].last, bytes);
    for (pl_u32 index = 0u; index < child_count; ++index)
        if (pl_index_ref_write(
                &children[index], target + PL_INDEX_HEADER_BYTES
                                  + (pl_u64)index * PL_INDEX_REF_BYTES))
            return PL_ERROR_INDEX;
    *written = bytes;
    return 0;
}

static int open_structure(const pl_u8 *bytes, pl_u32 length,
                          pl_index_node *out, pl_u64 *rows)
{
    if (!bytes || !out || !rows || length < PL_INDEX_HEADER_BYTES
            || length > PL_INDEX_NODE_BYTES)
        return PL_ERROR_INDEX_RANGE;
    for (pl_u32 index = 0; index < PL_INDEX_MAGIC_BYTES; ++index) {
        pl_u8 expected = index < sizeof(PL_INDEX_MAGIC) - 1u
                       ? (pl_u8)PL_INDEX_MAGIC[index] : 0u;
        if (bytes[index] != expected) return PL_ERROR_INDEX;
    }
    pl_u32 version = pl_read_u32(bytes + 32u);
    pl_u32 header_bytes = pl_read_u32(bytes + 36u);
    pl_u32 level = pl_read_u32(bytes + 40u);
    pl_u32 leaf_row_bytes = pl_read_u32(bytes + 44u);
    pl_u32 row_count = pl_read_u32(bytes + 48u);
    pl_u32 row_bytes = pl_read_u32(bytes + 52u);
    pl_index_key first = read_key(bytes + 56u);
    pl_index_key last = read_key(bytes + 72u);
    pl_u32 file_bytes = pl_read_u32(bytes + 88u);
    pl_u32 reserved = pl_read_u32(bytes + 92u);
    pl_u32 measured = 0u;
    if (version != PL_INDEX_VERSION || header_bytes != PL_INDEX_HEADER_BYTES
            || level > PL_INDEX_MAX_LEVEL
            || leaf_row_bytes < PL_INDEX_KEY_BYTES
            || (level ? row_bytes != PL_INDEX_REF_BYTES
                      : row_bytes != leaf_row_bytes)
            || !extent(row_count, row_bytes, &measured)
            || file_bytes != measured || length != measured || reserved
            || pl_index_key_compare(first, last) > 0)
        return PL_ERROR_INDEX;

    pl_index_key prior = first;
    pl_u64 total = 0u;
    for (pl_u32 index = 0u; index < row_count; ++index) {
        const pl_u8 *row = bytes + PL_INDEX_HEADER_BYTES
                         + (pl_u64)index * row_bytes;
        pl_index_key row_first, row_last;
        pl_u64 row_total;
        if (!level) {
            row_first = row_last = read_key(row);
            row_total = 1u;
        } else {
            pl_index_ref child;
            if (pl_index_ref_read(row, &child)
                    || child.level + 1u != level
                    || child.leaf_row_bytes != leaf_row_bytes)
                return PL_ERROR_INDEX;
            row_first = child.first;
            row_last = child.last;
            row_total = child.rows;
        }
        if ((!index && pl_index_key_compare(row_first, first) != 0)
                || (index && pl_index_key_compare(prior, row_first) >= 0)
                || (index + 1u == row_count
                    && pl_index_key_compare(row_last, last) != 0)
                || total > ~(pl_u64)0 - row_total)
            return PL_ERROR_INDEX;
        prior = row_last;
        total += row_total;
    }
    *out = (pl_index_node){
        bytes, length, level, leaf_row_bytes, row_bytes, row_count,
        first, last,
    };
    *rows = total;
    return 0;
}

int pl_index_ref_from_node(const pl_u8 *bytes, pl_u32 length,
                           pl_index_ref *out)
{
    pl_index_node node;
    pl_u64 rows = 0u;
    int status = open_structure(bytes, length, &node, &rows);
    if (status || !out) return status ? status : PL_ERROR_INDEX;
    pl_sha256_digest(bytes, length, out->digest);
    out->rows = rows;
    out->node_bytes = length;
    out->level = node.level;
    out->leaf_row_bytes = node.leaf_row_bytes;
    out->reserved = 0u;
    out->first = node.first;
    out->last = node.last;
    return 0;
}

int pl_index_build(const pl_u8 *rows, pl_u32 row_bytes, pl_u32 row_count,
                   pl_index_ref *references, pl_u32 reference_capacity,
                   pl_u8 node[PL_INDEX_NODE_BYTES],
                   pl_index_publish publish, void *context,
                   pl_index_ref *root)
{
    if (!rows || row_bytes < PL_INDEX_KEY_BYTES || !row_count
            || !references || !node || !publish || !root)
        return PL_ERROR_INDEX_RANGE;
    pl_u32 leaf_capacity =
        (PL_INDEX_NODE_BYTES - PL_INDEX_HEADER_BYTES) / row_bytes;
    pl_u32 branch_capacity =
        (PL_INDEX_NODE_BYTES - PL_INDEX_HEADER_BYTES) / PL_INDEX_REF_BYTES;
    if (!leaf_capacity || branch_capacity < 2u)
        return PL_ERROR_INDEX_RANGE;
    pl_u32 frontier = row_count / leaf_capacity
                    + (row_count % leaf_capacity != 0u);
    if (frontier > reference_capacity) return PL_ERROR_INDEX_RANGE;

    pl_u32 written_refs = 0u;
    for (pl_u32 first = 0u; first < row_count;) {
        pl_u32 count = row_count - first;
        if (count > leaf_capacity) count = leaf_capacity;
        pl_u32 written = 0u;
        int status = pl_index_leaf_write(
            rows + (pl_u64)first * row_bytes, row_bytes, count,
            node, PL_INDEX_NODE_BYTES, &written);
        if (!status)
            status = pl_index_ref_from_node(
                node, written, &references[written_refs]);
        if (!status)
            status = publish(context, references[written_refs].digest,
                             node, written);
        if (status) return status;
        ++written_refs;
        first += count;
    }
    if (written_refs != frontier) return PL_ERROR_INDEX;

    while (frontier > 1u) {
        pl_u32 next = 0u;
        for (pl_u32 first = 0u; first < frontier;) {
            pl_u32 count = frontier - first;
            if (count > branch_capacity) count = branch_capacity;
            pl_u32 written = 0u;
            int status = pl_index_branch_write(
                references + first, count,
                node, PL_INDEX_NODE_BYTES, &written);
            pl_index_ref parent;
            if (!status)
                status = pl_index_ref_from_node(node, written, &parent);
            if (!status)
                status = publish(context, parent.digest, node, written);
            if (status) return status;
            references[next++] = parent;
            first += count;
        }
        frontier = next;
    }
    *root = references[0];
    return 0;
}

int pl_index_node_open(const pl_index_ref *expected, const pl_u8 *bytes,
                       pl_u32 length, pl_index_node *out)
{
    if (pl_index_ref_validate(expected) || !bytes || !out
            || expected->node_bytes != length)
        return PL_ERROR_INDEX_RANGE;
    pl_u8 digest[PL_SHA256_BYTES];
    pl_sha256_digest(bytes, length, digest);
    if (!same_bytes(digest, expected->digest, PL_SHA256_BYTES))
        return PL_ERROR_INDEX_DIGEST;
    pl_u64 rows = 0u;
    int status = open_structure(bytes, length, out, &rows);
    if (status) return status;
    if (rows != expected->rows || out->level != expected->level
            || out->leaf_row_bytes != expected->leaf_row_bytes
            || pl_index_key_compare(out->first, expected->first)
            || pl_index_key_compare(out->last, expected->last))
        return PL_ERROR_INDEX;
    return 0;
}

int pl_index_select_child(const pl_index_node *node, pl_index_key key,
                          pl_index_ref *out)
{
    if (!node || !out || !node->level
            || pl_index_key_compare(key, node->first) < 0
            || pl_index_key_compare(key, node->last) > 0)
        return PL_ERROR_INDEX_ABSENT;
    pl_u32 low = 0u, high = node->row_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        pl_index_ref child;
        if (pl_index_ref_read(
                node->bytes + PL_INDEX_HEADER_BYTES
                            + (pl_u64)middle * PL_INDEX_REF_BYTES, &child))
            return PL_ERROR_INDEX;
        if (pl_index_key_compare(child.last, key) < 0) low = middle + 1u;
        else high = middle;
    }
    if (low >= node->row_count) return PL_ERROR_INDEX_ABSENT;
    if (pl_index_ref_read(
            node->bytes + PL_INDEX_HEADER_BYTES
                        + (pl_u64)low * PL_INDEX_REF_BYTES, out))
        return PL_ERROR_INDEX;
    return pl_index_key_compare(key, out->first) < 0
         ? PL_ERROR_INDEX_ABSENT : 0;
}

int pl_index_find_row(const pl_index_node *node, pl_index_key key,
                      const pl_u8 **row)
{
    if (!node || !row || node->level) return PL_ERROR_INDEX;
    pl_u32 low = 0u, high = node->row_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        const pl_u8 *candidate = node->bytes + PL_INDEX_HEADER_BYTES
                               + (pl_u64)middle * node->row_bytes;
        int order = pl_index_key_compare(read_key(candidate), key);
        if (order < 0) low = middle + 1u;
        else high = middle;
    }
    if (low >= node->row_count) return PL_ERROR_INDEX_ABSENT;
    const pl_u8 *candidate = node->bytes + PL_INDEX_HEADER_BYTES
                           + (pl_u64)low * node->row_bytes;
    if (pl_index_key_compare(read_key(candidate), key))
        return PL_ERROR_INDEX_ABSENT;
    *row = candidate;
    return 0;
}

int pl_index_select_floor_child(const pl_index_node *node, pl_index_key key,
                                pl_index_ref *out)
{
    if (!node || !out || !node->level || !node->row_count
            || pl_index_key_compare(key, node->first) < 0)
        return PL_ERROR_INDEX_ABSENT;
    pl_u32 low = 0u, high = node->row_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        pl_index_ref child;
        if (pl_index_ref_read(
                node->bytes + PL_INDEX_HEADER_BYTES
                    + (pl_u64)middle * PL_INDEX_REF_BYTES,
                &child))
            return PL_ERROR_INDEX;
        if (pl_index_key_compare(child.first, key) <= 0) low = middle + 1u;
        else high = middle;
    }
    if (!low || pl_index_ref_read(
            node->bytes + PL_INDEX_HEADER_BYTES
                + (pl_u64)(low - 1u) * PL_INDEX_REF_BYTES,
            out))
        return PL_ERROR_INDEX_ABSENT;
    return 0;
}

int pl_index_find_floor(const pl_index_node *node, pl_index_key key,
                        const pl_u8 **row)
{
    if (!node || !row || node->level || !node->row_count
            || pl_index_key_compare(key, node->first) < 0)
        return PL_ERROR_INDEX_ABSENT;
    pl_u32 low = 0u, high = node->row_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        const pl_u8 *candidate = node->bytes + PL_INDEX_HEADER_BYTES
                               + (pl_u64)middle * node->row_bytes;
        if (pl_index_key_compare(read_key(candidate), key) <= 0)
            low = middle + 1u;
        else high = middle;
    }
    if (!low) return PL_ERROR_INDEX_ABSENT;
    *row = node->bytes + PL_INDEX_HEADER_BYTES
         + (pl_u64)(low - 1u) * node->row_bytes;
    return 0;
}
