#include <artifact/namespace.h>

enum {
    TOPOLOGY_HEAD_BYTES = 13u,
    INODE_BYTES = 27u,
    ALIAS_BYTES = 13u,
    XATTR_HEAD_BYTES = 13u,
};

static int bytes_compare(const pl_u8 *left, pl_u32 left_bytes,
                         const pl_u8 *right, pl_u32 right_bytes)
{
    pl_u32 common = left_bytes < right_bytes ? left_bytes : right_bytes;
    for (pl_u32 index = 0u; index < common; ++index) {
        if (left[index] < right[index]) return -1;
        if (left[index] > right[index]) return 1;
    }
    return left_bytes < right_bytes ? -1 : left_bytes > right_bytes;
}

static int equal_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (left[index] != right[index]) return 0;
    return 1;
}

/* Compare path component sequences, not their slash-delimited byte strings.
 * Consequently every directory immediately precedes its complete subtree. */
static int path_compare(const pl_u8 *left, pl_u32 left_bytes,
                        const pl_u8 *right, pl_u32 right_bytes)
{
    pl_u32 left_at = 0u, right_at = 0u;
    while (left_at < left_bytes && right_at < right_bytes) {
        pl_u32 left_end = left_at, right_end = right_at;
        while (left_end < left_bytes && left[left_end] != '/') ++left_end;
        while (right_end < right_bytes && right[right_end] != '/') ++right_end;
        int order = bytes_compare(
            left + left_at, left_end - left_at,
            right + right_at, right_end - right_at);
        if (order) return order;
        left_at = left_end < left_bytes ? left_end + 1u : left_end;
        right_at = right_end < right_bytes ? right_end + 1u : right_end;
    }
    return left_at < left_bytes ? 1 : right_at < right_bytes ? -1 : 0;
}

static pl_u32 path_depth(const artifact_namespace_path *entry)
{
    if (!entry->path_bytes) return 0u;
    pl_u32 depth = 1u;
    for (pl_u32 index = 0u; index < entry->path_bytes; ++index)
        depth += entry->path[index] == '/';
    return depth;
}

static void path_basename(const artifact_namespace_path *entry,
                          const pl_u8 **name, pl_u32 *name_bytes)
{
    pl_u32 at = entry->path_bytes;
    while (at && entry->path[at - 1u] != '/') --at;
    *name = entry->path + at;
    *name_bytes = entry->path_bytes - at;
}

static void write_u32(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)(value >> 24u);
    target[1] = (pl_u8)(value >> 16u);
    target[2] = (pl_u8)(value >> 8u);
    target[3] = (pl_u8)value;
}

static void write_u64(pl_u8 *target, pl_u64 value)
{
    for (pl_u32 index = 0u; index < 8u; ++index)
        target[index] = (pl_u8)(value >> ((7u - index) * 8u));
}

static pl_u32 read_u32(const pl_u8 *source)
{
    return ((pl_u32)source[0] << 24u)
         | ((pl_u32)source[1] << 16u)
         | ((pl_u32)source[2] << 8u)
         | (pl_u32)source[3];
}

static pl_u64 read_u64(const pl_u8 *source)
{
    pl_u64 value = 0u;
    for (pl_u32 index = 0u; index < 8u; ++index)
        value = (value << 8u) | source[index];
    return value;
}

static void copy_bytes(pl_u8 *target, const pl_u8 *source, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        target[index] = source[index];
}

static int bytes_have_zero(const pl_u8 *bytes, pl_u32 length)
{
    for (pl_u32 index = 0u; index < length; ++index)
        if (!bytes[index]) return 1;
    return 0;
}

static int descriptor_fits(
    const artifact_namespace_workspace *workspace,
    pl_u32 at, pl_u32 bytes)
{
    return at <= workspace->descriptor_capacity
        && bytes <= workspace->descriptor_capacity - at;
}

static int path_valid(const pl_u8 *path, pl_u32 bytes)
{
    if (!bytes) return 1;
    if (!path || path[0] == '/' || path[bytes - 1u] == '/') return 0;
    pl_u32 component = 0u;
    for (pl_u32 index = 0u; index <= bytes; ++index) {
        if (index < bytes && path[index] != '/') {
            if (!path[index]) return 0;
            continue;
        }
        pl_u32 extent = index - component;
        if (!extent || (extent == 1u && path[component] == '.')
                || (extent == 2u && path[component] == '.'
                    && path[component + 1u] == '.'))
            return 0;
        component = index + 1u;
    }
    return 1;
}

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    if (*value > 0xffffffffffffffffull - addend) return 0;
    *value += addend;
    return 1;
}

static int append_payload(
    const artifact_namespace_workspace *workspace,
    artifact_namespace_projection *projection,
    const pl_u8 *bytes, pl_u32 length)
{
    if (!bytes || !length
            || projection->material_occurrences
               >= workspace->material_capacity)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    workspace->material[projection->material_occurrences++] =
        (artifact_payload){ bytes, length };
    return 0;
}

static int verify_reopened_population(
    const artifact_namespace_population *population,
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace);

static int find_path(const artifact_namespace_population *population,
                     const pl_u8 *path, pl_u32 path_bytes, pl_u32 *ordinal)
{
    pl_u32 low = 0u, high = population->path_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        const artifact_namespace_path *candidate = &population->path[middle];
        int order = path_compare(
            candidate->path, candidate->path_bytes, path, path_bytes);
        if (order < 0) low = middle + 1u;
        else high = middle;
    }
    if (low >= population->path_count
            || path_compare(population->path[low].path,
                            population->path[low].path_bytes,
                            path, path_bytes))
        return ARTIFACT_ERROR_NAMESPACE;
    *ordinal = low;
    return 0;
}

static int parent_is_directory(
    const artifact_namespace_population *population, pl_u32 path)
{
    const artifact_namespace_path *entry = &population->path[path];
    if (!entry->path_bytes) return path == 0u;
    pl_u32 parent_bytes = entry->path_bytes;
    while (parent_bytes && entry->path[parent_bytes - 1u] != '/')
        --parent_bytes;
    if (parent_bytes) --parent_bytes;
    pl_u32 parent = 0u;
    if (find_path(population, entry->path, parent_bytes, &parent)) return 0;
    pl_u32 inode = population->path[parent].inode;
    return inode < population->inode_count
        && population->inode[inode].kind == ARTIFACT_NAMESPACE_DIRECTORY;
}

int artifact_namespace_project(
    const artifact_namespace_population *population,
    const artifact_namespace_workspace *workspace,
    artifact_namespace_projection *out)
{
    if (!population || !workspace || !out || !population->path
            || !population->path_count || !population->inode
            || !population->inode_count || !workspace->material
            || !workspace->descriptor || !workspace->first_path
            || !workspace->alias_path || !workspace->alias_inode
            || workspace->first_path_capacity < population->inode_count
            || workspace->alias_capacity < population->path_count)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    artifact_namespace_projection result = {
        .paths = population->path_count,
        .inodes = population->inode_count,
    };
    for (pl_u32 inode = 0u; inode < population->inode_count; ++inode)
        workspace->first_path[inode] = 0xffffffffu;
    pl_u32 next_inode = 0u;
    for (pl_u32 path = 0u; path < population->path_count; ++path) {
        const artifact_namespace_path *entry = &population->path[path];
        if (!path_valid(entry->path, entry->path_bytes)
                || entry->inode >= population->inode_count
                || (path && path_compare(
                    population->path[path - 1u].path,
                    population->path[path - 1u].path_bytes,
                    entry->path, entry->path_bytes) >= 0)
                || (!path && (entry->path_bytes || entry->inode))
                || !parent_is_directory(population, path))
            return ARTIFACT_ERROR_NAMESPACE;
        if (!add_u64(&result.opened_path_bytes, entry->path_bytes))
            return ARTIFACT_ERROR_NAMESPACE_RANGE;
        if (workspace->first_path[entry->inode] == 0xffffffffu) {
            if (entry->inode != next_inode) return ARTIFACT_ERROR_NAMESPACE;
            workspace->first_path[entry->inode] = path;
            ++next_inode;
        } else {
            if (population->inode[entry->inode].kind
                    == ARTIFACT_NAMESPACE_DIRECTORY)
                return ARTIFACT_ERROR_NAMESPACE;
            workspace->alias_path[result.hardlink_aliases] = path;
            workspace->alias_inode[result.hardlink_aliases] = entry->inode;
            ++result.hardlink_aliases;
        }
    }
    if (next_inode != population->inode_count)
        return ARTIFACT_ERROR_NAMESPACE;

    pl_u32 content_count[4] = { 0u, 0u, 0u, 0u };
    pl_u32 descriptor_at = 0u;
    static const pl_u8 topology_tag[] = { 'N','S','T','P',1u };
    static const pl_u8 inode_tag[] = { 'N','S','I','N',1u };
    static const pl_u8 alias_tag[] = { 'N','S','A','L',1u };
    static const pl_u8 xattr_tag[] = { 'N','S','X','A',1u };

    /* The root open/close are implicit. Every other node contributes one
     * open and one close bit, which is the canonical ordered-tree code. */
    pl_u64 topology_bits = population->path_count > 0u
        ? (pl_u64)(population->path_count - 1u) * 2u : 0u;
    pl_u64 topology_body_bytes = (topology_bits + 7u) / 8u;
    pl_u64 topology_bytes64 = TOPOLOGY_HEAD_BYTES + topology_body_bytes;
    if (topology_bytes64 > 0xffffffffu
            || !descriptor_fits(
                workspace, descriptor_at, (pl_u32)topology_bytes64))
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    pl_u8 *topology = workspace->descriptor + descriptor_at;
    copy_bytes(topology, topology_tag, sizeof(topology_tag));
    write_u32(topology + 5u, population->path_count);
    write_u32(topology + 9u, result.hardlink_aliases);
    for (pl_u32 index = TOPOLOGY_HEAD_BYTES;
            index < (pl_u32)topology_bytes64; ++index)
        topology[index] = 0u;
    pl_u64 bit = 0u;
    pl_u32 previous_depth = 0u;
    for (pl_u32 path = 1u; path < population->path_count; ++path) {
        pl_u32 depth = path_depth(&population->path[path]);
        if (!depth || previous_depth + 1u < depth)
            return ARTIFACT_ERROR_NAMESPACE;
        pl_u32 closes = previous_depth - (depth - 1u);
        bit += closes;
        topology[TOPOLOGY_HEAD_BYTES + (pl_u32)(bit / 8u)] |=
            (pl_u8)(0x80u >> (bit % 8u));
        ++bit;
        previous_depth = depth;
    }
    bit += previous_depth;
    if (bit != topology_bits)
        return ARTIFACT_ERROR_NAMESPACE;
    int status = append_payload(
        workspace, &result, topology, (pl_u32)topology_bytes64);
    descriptor_at += (pl_u32)topology_bytes64;
    if (status) return status;
    result.topology_bits = topology_bits;

    /* Prefixes are generated from the topology. Retaining complete path
     * spellings would duplicate every ancestor and can become quadratic. */
    for (pl_u32 path = 1u; path < population->path_count; ++path) {
        const pl_u8 *name = 0;
        pl_u32 name_bytes = 0u;
        path_basename(&population->path[path], &name, &name_bytes);
        if (!descriptor_fits(workspace, descriptor_at, name_bytes))
            return ARTIFACT_ERROR_NAMESPACE_RANGE;
        copy_bytes(workspace->descriptor + descriptor_at, name, name_bytes);
        status = append_payload(
            workspace, &result,
            workspace->descriptor + descriptor_at, name_bytes);
        descriptor_at += name_bytes;
        if (status || !add_u64(&result.retained_name_bytes, name_bytes))
            return status ? status : ARTIFACT_ERROR_NAMESPACE_RANGE;
    }

    for (pl_u32 ordinal = 0u; ordinal < population->inode_count; ++ordinal) {
        const artifact_namespace_inode *inode = &population->inode[ordinal];
        if (inode->kind < ARTIFACT_NAMESPACE_DIRECTORY
                || inode->kind > ARTIFACT_NAMESPACE_SOCKET
                || inode->content_kind > ARTIFACT_NAMESPACE_ARCHIVE
                || (inode->kind == ARTIFACT_NAMESPACE_REGULAR
                    ? 0 : inode->content_kind
                         != ARTIFACT_NAMESPACE_NO_CONTENT)
                || (inode->kind == ARTIFACT_NAMESPACE_SYMLINK
                    ? !inode->symlink || !inode->symlink_bytes
                        || bytes_have_zero(inode->symlink,
                                           inode->symlink_bytes)
                    : inode->symlink || inode->symlink_bytes)
                || ((inode->kind != ARTIFACT_NAMESPACE_CHARACTER
                     && inode->kind != ARTIFACT_NAMESPACE_BLOCK)
                    && inode->rdev)
                || (inode->mode & ~07777u)
                || (inode->xattr_count && !inode->xattr))
            return ARTIFACT_ERROR_NAMESPACE;
        if (inode->kind == ARTIFACT_NAMESPACE_REGULAR
                && inode->content_kind != ARTIFACT_NAMESPACE_NO_CONTENT) {
            if (inode->content_ordinal != content_count[inode->content_kind])
                return ARTIFACT_ERROR_NAMESPACE;
            ++content_count[inode->content_kind];
        } else if (inode->content_ordinal) {
            return ARTIFACT_ERROR_NAMESPACE;
        }
        if (!descriptor_fits(workspace, descriptor_at, INODE_BYTES))
            return ARTIFACT_ERROR_NAMESPACE_RANGE;
        pl_u8 *descriptor = workspace->descriptor + descriptor_at;
        for (pl_u32 index = 0u; index < sizeof(inode_tag); ++index)
            descriptor[index] = inode_tag[index];
        descriptor[5] = (pl_u8)inode->kind;
        descriptor[6] = (pl_u8)inode->content_kind;
        write_u32(descriptor + 7u, inode->mode);
        write_u32(descriptor + 11u, inode->uid);
        write_u32(descriptor + 15u, inode->gid);
        write_u64(descriptor + 19u, inode->rdev);
        status = append_payload(
            workspace, &result, descriptor, INODE_BYTES);
        descriptor_at += INODE_BYTES;
        if (status) return status;
        if (inode->kind == ARTIFACT_NAMESPACE_SYMLINK) {
            if (!descriptor_fits(
                    workspace, descriptor_at, inode->symlink_bytes))
                return ARTIFACT_ERROR_NAMESPACE_RANGE;
            copy_bytes(workspace->descriptor + descriptor_at,
                       inode->symlink, inode->symlink_bytes);
            status = append_payload(
                workspace, &result, workspace->descriptor + descriptor_at,
                inode->symlink_bytes);
            descriptor_at += inode->symlink_bytes;
            if (status || !add_u64(&result.opened_symlink_bytes,
                                   inode->symlink_bytes))
                return status ? status : ARTIFACT_ERROR_NAMESPACE_RANGE;
        }
        if (inode->xattr_count) {
            if (!descriptor_fits(
                    workspace, descriptor_at, XATTR_HEAD_BYTES))
                return ARTIFACT_ERROR_NAMESPACE_RANGE;
            descriptor = workspace->descriptor + descriptor_at;
            for (pl_u32 index = 0u; index < sizeof(xattr_tag); ++index)
                descriptor[index] = xattr_tag[index];
            write_u32(descriptor + 5u, ordinal);
            write_u32(descriptor + 9u, inode->xattr_count);
            status = append_payload(
                workspace, &result, descriptor, XATTR_HEAD_BYTES);
            descriptor_at += XATTR_HEAD_BYTES;
            if (status) return status;
        }
        for (pl_u32 xattr = 0u; xattr < inode->xattr_count; ++xattr) {
            const artifact_namespace_xattr *value = &inode->xattr[xattr];
            if (!value->name || !value->name_bytes
                    || bytes_have_zero(value->name, value->name_bytes)
                    || (value->value_bytes && !value->value)
                    || (xattr && bytes_compare(
                        inode->xattr[xattr - 1u].name,
                        inode->xattr[xattr - 1u].name_bytes,
                        value->name, value->name_bytes) >= 0))
                return ARTIFACT_ERROR_NAMESPACE;
            pl_u64 row_bytes64 = (pl_u64)value->name_bytes
                               + value->value_bytes + 13u;
            if (row_bytes64 > 0xffffffffu
                    || !descriptor_fits(
                        workspace, descriptor_at, (pl_u32)row_bytes64))
                return ARTIFACT_ERROR_NAMESPACE_RANGE;
            descriptor = workspace->descriptor + descriptor_at;
            static const pl_u8 value_tag[] = { 'N','S','X','V',1u };
            copy_bytes(descriptor, value_tag, sizeof(value_tag));
            write_u32(descriptor + 5u, value->name_bytes);
            copy_bytes(descriptor + 9u, value->name, value->name_bytes);
            write_u32(descriptor + 9u + value->name_bytes,
                      value->value_bytes);
            copy_bytes(descriptor + 13u + value->name_bytes,
                       value->value, value->value_bytes);
            status = append_payload(
                workspace, &result, descriptor, (pl_u32)row_bytes64);
            descriptor_at += (pl_u32)row_bytes64;
            if (status || !add_u64(&result.opened_xattr_bytes,
                    (pl_u64)value->name_bytes + value->value_bytes))
                return status ? status : ARTIFACT_ERROR_NAMESPACE_RANGE;
            ++result.xattrs;
        }
    }
    for (pl_u32 alias = 0u; alias < result.hardlink_aliases; ++alias) {
        if (!descriptor_fits(workspace, descriptor_at, ALIAS_BYTES))
            return ARTIFACT_ERROR_NAMESPACE_RANGE;
        pl_u8 *descriptor = workspace->descriptor + descriptor_at;
        for (pl_u32 index = 0u; index < sizeof(alias_tag); ++index)
            descriptor[index] = alias_tag[index];
        write_u32(descriptor + 5u, workspace->alias_path[alias]);
        write_u32(descriptor + 9u, workspace->alias_inode[alias]);
        status = append_payload(
            workspace, &result, descriptor, ALIAS_BYTES);
        descriptor_at += ALIAS_BYTES;
        if (status) return status;
    }
    result.descriptor_bytes = descriptor_at;

    /* Verify the emitted normal form as one physical stream.  Reopening the
     * nth inode from the beginning for every n made publication quadratic
     * even though the stored inode sequence is already canonical. */
    status = verify_reopened_population(population, &result, workspace);
    if (!status) status = artifact_namespace_validate(&result, workspace);
    if (status) return status;
    *out = result;
    return 0;
}

static int aliases_valid(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace);

int artifact_namespace_reopen_inode(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 path, pl_u32 *inode)
{
    if (!projection || !workspace || !inode || path >= projection->paths
            || !workspace->material
            || projection->hardlink_aliases
               > projection->material_occurrences)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    int valid = aliases_valid(projection, workspace);
    if (valid) return valid;
    pl_u32 base = projection->material_occurrences
                - projection->hardlink_aliases;
    pl_u32 low = 0u, high = projection->hardlink_aliases;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        const artifact_payload *row = &workspace->material[base + middle];
        if (!row->bytes || row->length != ALIAS_BYTES
                || !equal_bytes(row->bytes, (const pl_u8 *)"NSAL\1", 5u))
            return ARTIFACT_ERROR_NAMESPACE;
        pl_u32 coordinate = read_u32(row->bytes + 5u);
        if (coordinate < path) low = middle + 1u;
        else high = middle;
    }
    if (low < projection->hardlink_aliases) {
        const artifact_payload *row = &workspace->material[base + low];
        pl_u32 coordinate = read_u32(row->bytes + 5u);
        if (coordinate == path) {
            pl_u32 answer = read_u32(row->bytes + 9u);
            if (answer >= path - low || answer >= projection->inodes)
                return ARTIFACT_ERROR_NAMESPACE;
            *inode = answer;
            return 0;
        }
    }
    if (path < low || path - low >= projection->inodes)
        return ARTIFACT_ERROR_NAMESPACE;
    *inode = path - low;
    return 0;
}

static int material_tag(const artifact_payload *payload,
                        const char tag[5], pl_u32 bytes)
{
    return payload && payload->bytes && payload->length == bytes
        && equal_bytes(payload->bytes, (const pl_u8 *)tag, 5u);
}

static int decode_xattr(const artifact_payload *row,
                        artifact_namespace_xattr *out)
{
    if (!row || !row->bytes || row->length < 13u
            || !equal_bytes(row->bytes, (const pl_u8 *)"NSXV\1", 5u))
        return ARTIFACT_ERROR_NAMESPACE;
    pl_u32 name_bytes = read_u32(row->bytes + 5u);
    if (!name_bytes || name_bytes > row->length - 13u)
        return ARTIFACT_ERROR_NAMESPACE;
    pl_u32 value_bytes = read_u32(row->bytes + 9u + name_bytes);
    if (value_bytes != row->length - 13u - name_bytes
            || bytes_have_zero(row->bytes + 9u, name_bytes))
        return ARTIFACT_ERROR_NAMESPACE;
    *out = (artifact_namespace_xattr){
        row->bytes + 9u, name_bytes,
        row->bytes + 13u + name_bytes, value_bytes,
    };
    return 0;
}

typedef struct {
    pl_u32 cursor;
    pl_u32 end;
    pl_u32 ordinal;
    pl_u32 content_count[4];
} inode_material_cursor;

static int inode_material_open(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    inode_material_cursor *cursor)
{
    if (!projection || !workspace || !workspace->material || !cursor
            || projection->paths > projection->material_occurrences
            || projection->hardlink_aliases
               > projection->material_occurrences)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    *cursor = (inode_material_cursor){
        .cursor = projection->paths,
        .end = projection->material_occurrences
             - projection->hardlink_aliases,
    };
    return 0;
}

static int inode_material_next(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    inode_material_cursor *cursor,
    artifact_namespace_reopened_inode *out, pl_u32 *xattr_first)
{
    if (!projection || !workspace || !cursor || !out
            || cursor->ordinal >= projection->inodes
            || cursor->cursor >= cursor->end
            || !material_tag(&workspace->material[cursor->cursor],
                             "NSIN\1", INODE_BYTES))
        return ARTIFACT_ERROR_NAMESPACE;
    const pl_u8 *row = workspace->material[cursor->cursor++].bytes;
    artifact_namespace_reopened_inode value = {
        .kind = row[5],
        .content_kind = row[6],
        .mode = read_u32(row + 7u),
        .uid = read_u32(row + 11u),
        .gid = read_u32(row + 15u),
        .rdev = read_u64(row + 19u),
    };
    if (value.kind < ARTIFACT_NAMESPACE_DIRECTORY
            || value.kind > ARTIFACT_NAMESPACE_SOCKET
            || value.content_kind > ARTIFACT_NAMESPACE_ARCHIVE
            || (value.kind == ARTIFACT_NAMESPACE_REGULAR
                ? 0 : value.content_kind != ARTIFACT_NAMESPACE_NO_CONTENT)
            || (value.mode & ~07777u)
            || ((value.kind != ARTIFACT_NAMESPACE_CHARACTER
                 && value.kind != ARTIFACT_NAMESPACE_BLOCK)
                && value.rdev))
        return ARTIFACT_ERROR_NAMESPACE;
    if (value.kind == ARTIFACT_NAMESPACE_REGULAR
            && value.content_kind != ARTIFACT_NAMESPACE_NO_CONTENT)
        value.content_ordinal =
            cursor->content_count[value.content_kind]++;
    if (value.kind == ARTIFACT_NAMESPACE_SYMLINK) {
        if (cursor->cursor >= cursor->end
                || !workspace->material[cursor->cursor].bytes
                || !workspace->material[cursor->cursor].length
                || bytes_have_zero(
                    workspace->material[cursor->cursor].bytes,
                    workspace->material[cursor->cursor].length))
            return ARTIFACT_ERROR_NAMESPACE;
        value.symlink = workspace->material[cursor->cursor].bytes;
        value.symlink_bytes = workspace->material[cursor->cursor++].length;
    }
    pl_u32 first = cursor->cursor;
    if (cursor->cursor < cursor->end && material_tag(
            &workspace->material[cursor->cursor],
            "NSXA\1", XATTR_HEAD_BYTES)) {
        const pl_u8 *head = workspace->material[cursor->cursor++].bytes;
        if (read_u32(head + 5u) != cursor->ordinal)
            return ARTIFACT_ERROR_NAMESPACE;
        value.xattr_count = read_u32(head + 9u);
        first = cursor->cursor;
        if (value.xattr_count > cursor->end - cursor->cursor)
            return ARTIFACT_ERROR_NAMESPACE;
        artifact_namespace_xattr previous = { 0 };
        for (pl_u32 xattr = 0u; xattr < value.xattr_count; ++xattr) {
            artifact_namespace_xattr decoded = { 0 };
            int status = decode_xattr(
                &workspace->material[cursor->cursor + xattr], &decoded);
            if (status || (xattr && bytes_compare(
                    previous.name, previous.name_bytes,
                    decoded.name, decoded.name_bytes) >= 0))
                return ARTIFACT_ERROR_NAMESPACE;
            previous = decoded;
        }
        cursor->cursor += value.xattr_count;
    }
    ++cursor->ordinal;
    if (cursor->ordinal == projection->inodes
            && cursor->cursor != cursor->end)
        return ARTIFACT_ERROR_NAMESPACE;
    *out = value;
    if (xattr_first) *xattr_first = first;
    return 0;
}

static int find_inode_material(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 target, artifact_namespace_reopened_inode *out,
    pl_u32 *xattr_first)
{
    if (!out || !projection || target >= projection->inodes)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    inode_material_cursor cursor;
    int status = inode_material_open(projection, workspace, &cursor);
    while (!status && cursor.ordinal <= target)
        status = inode_material_next(
            projection, workspace, &cursor, out, xattr_first);
    return status;
}

int artifact_namespace_reopen_metadata(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 inode, artifact_namespace_reopened_inode *out)
{
    if (!out) return ARTIFACT_ERROR_NAMESPACE_RANGE;
    return find_inode_material(
        projection, workspace, inode, out, 0);
}

int artifact_namespace_reopen_content_counts(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 counts[4])
{
    if (!projection || !workspace || !counts)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    inode_material_cursor cursor;
    int status = inode_material_open(projection, workspace, &cursor);
    while (!status && cursor.ordinal < projection->inodes) {
        artifact_namespace_reopened_inode inode = { 0 };
        status = inode_material_next(
            projection, workspace, &cursor, &inode, 0);
    }
    if (status || cursor.cursor != cursor.end)
        return status ? status : ARTIFACT_ERROR_NAMESPACE;
    for (pl_u32 kind = 0u; kind < 4u; ++kind)
        counts[kind] = cursor.content_count[kind];
    return 0;
}

int artifact_namespace_reopen_xattr(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 inode, pl_u32 xattr,
    artifact_namespace_xattr *out)
{
    if (!out) return ARTIFACT_ERROR_NAMESPACE_RANGE;
    artifact_namespace_reopened_inode value = { 0 };
    pl_u32 first = 0u;
    int status = find_inode_material(
        projection, workspace, inode, &value, &first);
    if (status) return status;
    if (xattr >= value.xattr_count)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    return decode_xattr(&workspace->material[first + xattr], out);
}

static int verify_reopened_population(
    const artifact_namespace_population *population,
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace)
{
    if (!population || !projection || !workspace
            || population->path_count != projection->paths
            || population->inode_count != projection->inodes)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    int status = aliases_valid(projection, workspace);
    if (status) return status;

    /* The sparse alias rows are sorted by path coordinate.  Merge them with
     * the dense path ordinal once; validating the complete alias population
     * separately for every path was O(paths * aliases). */
    pl_u32 alias = 0u;
    pl_u32 alias_base = projection->material_occurrences
                      - projection->hardlink_aliases;
    for (pl_u32 path = 0u; path < projection->paths; ++path) {
        pl_u32 reopened;
        if (alias < projection->hardlink_aliases
                && read_u32(workspace->material[
                    alias_base + alias].bytes + 5u) == path) {
            reopened = read_u32(
                workspace->material[alias_base + alias].bytes + 9u);
            ++alias;
        } else {
            if (path < alias) return ARTIFACT_ERROR_NAMESPACE;
            reopened = path - alias;
        }
        if (reopened != population->path[path].inode)
            return ARTIFACT_ERROR_NAMESPACE;
    }
    if (alias != projection->hardlink_aliases)
        return ARTIFACT_ERROR_NAMESPACE;

    /* Inode descriptors already form one canonical ordinal stream.  Decode
     * it once and compare in lockstep, including xattrs, instead of reopening
     * prefixes 0..n independently for every n. */
    inode_material_cursor cursor;
    status = inode_material_open(projection, workspace, &cursor);
    for (pl_u32 ordinal = 0u;
            !status && ordinal < projection->inodes; ++ordinal) {
        const artifact_namespace_inode *expected =
            &population->inode[ordinal];
        artifact_namespace_reopened_inode reopened = { 0 };
        pl_u32 xattr_first = 0u;
        status = inode_material_next(
            projection, workspace, &cursor, &reopened, &xattr_first);
        if (status || reopened.kind != expected->kind
                || reopened.content_kind != expected->content_kind
                || reopened.content_ordinal != expected->content_ordinal
                || reopened.mode != expected->mode
                || reopened.uid != expected->uid
                || reopened.gid != expected->gid
                || reopened.rdev != expected->rdev
                || reopened.symlink_bytes != expected->symlink_bytes
                || (reopened.symlink_bytes && !equal_bytes(
                    reopened.symlink, expected->symlink,
                    reopened.symlink_bytes))
                || reopened.xattr_count != expected->xattr_count)
            return ARTIFACT_ERROR_NAMESPACE;
        for (pl_u32 xattr = 0u; xattr < expected->xattr_count; ++xattr) {
            artifact_namespace_xattr value = { 0 };
            status = decode_xattr(
                &workspace->material[xattr_first + xattr], &value);
            if (status
                    || value.name_bytes != expected->xattr[xattr].name_bytes
                    || value.value_bytes != expected->xattr[xattr].value_bytes
                    || !equal_bytes(value.name, expected->xattr[xattr].name,
                                    value.name_bytes)
                    || !equal_bytes(value.value, expected->xattr[xattr].value,
                                    value.value_bytes))
                return ARTIFACT_ERROR_NAMESPACE;
        }
    }
    return status;
}

static int topology_bit(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u64 bit, pl_u32 *value)
{
    if (!projection || !workspace || !workspace->material
            || !projection->material_occurrences || !value
            || bit >= projection->topology_bits)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    const artifact_payload *topology = &workspace->material[0];
    pl_u64 required = TOPOLOGY_HEAD_BYTES
                    + (projection->topology_bits + 7u) / 8u;
    if (!topology->bytes || topology->length != (pl_u32)required
            || !equal_bytes(topology->bytes,
                            (const pl_u8 *)"NSTP\1", 5u)
            || read_u32(topology->bytes + 5u) != projection->paths
            || read_u32(topology->bytes + 9u)
               != projection->hardlink_aliases)
        return ARTIFACT_ERROR_NAMESPACE;
    *value = !!(topology->bytes[TOPOLOGY_HEAD_BYTES
                 + (pl_u32)(bit / 8u)] & (0x80u >> (bit % 8u)));
    return 0;
}

static int topology_valid(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace)
{
    pl_u32 depth = 1u, opens = 0u, closes = 0u;
    for (pl_u64 bit = 0u; bit < projection->topology_bits; ++bit) {
        pl_u32 value = 0u;
        int status = topology_bit(projection, workspace, bit, &value);
        if (status) return status;
        if (value) {
            if (depth == 0xffffffffu) return ARTIFACT_ERROR_NAMESPACE;
            ++depth;
            ++opens;
        } else {
            if (depth <= 1u) return ARTIFACT_ERROR_NAMESPACE;
            --depth;
            ++closes;
        }
    }
    const artifact_payload *topology = &workspace->material[0];
    pl_u32 used = (pl_u32)(projection->topology_bits % 8u);
    if (used) {
        pl_u8 padding_mask = (pl_u8)((1u << (8u - used)) - 1u);
        if (topology->bytes[topology->length - 1u] & padding_mask)
            return ARTIFACT_ERROR_NAMESPACE;
    }
    return depth == 1u && opens == projection->paths - 1u
        && closes == projection->paths - 1u
        ? 0 : ARTIFACT_ERROR_NAMESPACE;
}

static int aliases_valid(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace)
{
    if (projection->hardlink_aliases > projection->material_occurrences)
        return ARTIFACT_ERROR_NAMESPACE;
    pl_u32 base = projection->material_occurrences
                - projection->hardlink_aliases;
    pl_u32 previous = 0u;
    for (pl_u32 alias = 0u; alias < projection->hardlink_aliases; ++alias) {
        const artifact_payload *row = &workspace->material[base + alias];
        if (!row->bytes || row->length != ALIAS_BYTES
                || !equal_bytes(row->bytes, (const pl_u8 *)"NSAL\1", 5u))
            return ARTIFACT_ERROR_NAMESPACE;
        pl_u32 coordinate = read_u32(row->bytes + 5u);
        pl_u32 inode = read_u32(row->bytes + 9u);
        if (!coordinate || coordinate >= projection->paths
                || (alias && coordinate <= previous)
                || inode >= coordinate - alias
                || inode >= projection->inodes)
            return ARTIFACT_ERROR_NAMESPACE;
        previous = coordinate;
    }
    return projection->inodes
        == projection->paths - projection->hardlink_aliases
        ? 0 : ARTIFACT_ERROR_NAMESPACE;
}

int artifact_namespace_validate(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace)
{
    if (!projection || !workspace || !projection->paths
            || !projection->inodes || !projection->material_occurrences
            || !workspace->material || !workspace->descriptor
            || projection->material_occurrences
               > workspace->material_capacity
            || projection->descriptor_bytes > workspace->descriptor_capacity)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;

    /* There is one physical byte owner. Slice descriptors may name it, but
     * no source path, inode allocation or separately owned xattr/symlink
     * buffer is permitted to survive publication. */
    pl_u32 byte = 0u;
    for (pl_u32 material = 0u;
            material < projection->material_occurrences; ++material) {
        const artifact_payload *slice = &workspace->material[material];
        if (!slice->bytes || !slice->length
                || slice->bytes != workspace->descriptor + byte
                || slice->length > projection->descriptor_bytes - byte)
            return ARTIFACT_ERROR_NAMESPACE;
        byte += slice->length;
    }
    if (byte != projection->descriptor_bytes)
        return ARTIFACT_ERROR_NAMESPACE;

    int status = topology_valid(projection, workspace);
    if (!status) status = aliases_valid(projection, workspace);
    for (pl_u32 path = 1u; !status && path < projection->paths; ++path) {
        const artifact_payload *name = &workspace->material[path];
        if (!name->length || bytes_have_zero(name->bytes, name->length)
                || (name->length == 1u && name->bytes[0] == '.')
                || (name->length == 2u && name->bytes[0] == '.'
                    && name->bytes[1] == '.'))
            status = ARTIFACT_ERROR_NAMESPACE;
        for (pl_u32 index = 0u; !status && index < name->length; ++index)
            if (name->bytes[index] == '/') status = ARTIFACT_ERROR_NAMESPACE;
    }
    inode_material_cursor cursor;
    if (!status) status = inode_material_open(projection, workspace, &cursor);
    for (pl_u32 inode = 0u;
            !status && inode < projection->inodes; ++inode) {
        artifact_namespace_reopened_inode reopened = { 0 };
        status = inode_material_next(
            projection, workspace, &cursor, &reopened, 0);
    }
    return status;
}

int artifact_namespace_reopen_parent(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    pl_u32 path, pl_u32 *parent)
{
    if (!projection || !workspace || !parent || path >= projection->paths)
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    int valid = topology_valid(projection, workspace);
    if (valid) return valid;
    if (!path) {
        *parent = 0u;
        return 0;
    }
    pl_u32 opens = 0u;
    pl_u64 open_bit = projection->topology_bits;
    for (pl_u64 bit = 0u; bit < projection->topology_bits; ++bit) {
        pl_u32 value = 0u;
        int status = topology_bit(projection, workspace, bit, &value);
        if (status) return status;
        if (value && ++opens == path) {
            open_bit = bit;
            break;
        }
    }
    if (open_bit == projection->topology_bits)
        return ARTIFACT_ERROR_NAMESPACE;
    pl_u32 balance = 0u, candidate = path - 1u;
    while (open_bit) {
        pl_u32 value = 0u;
        int status = topology_bit(
            projection, workspace, --open_bit, &value);
        if (status) return status;
        if (!value) {
            ++balance;
        } else if (balance) {
            --balance;
            --candidate;
        } else {
            *parent = candidate;
            return 0;
        }
    }
    *parent = 0u;
    return 0;
}

int artifact_namespace_reopen_lookup(
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    const pl_u8 *path, pl_u32 path_bytes,
    pl_u32 *path_ordinal, pl_u32 *inode)
{
    if (!projection || !workspace || !path_ordinal || !inode
            || !path_valid(path, path_bytes))
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    int status = topology_valid(projection, workspace);
    if (status) return status;
    if (!path_bytes) {
        *path_ordinal = 0u;
        return artifact_namespace_reopen_inode(
            projection, workspace, 0u, inode);
    }

    /* Ordered preorder lets one target path be recognized by one forward
     * walk.  Once a component matches, its descendants immediately follow;
     * unmatched sibling subtrees are skipped by the depth counter.  The old
     * implementation tried every candidate and recomputed that candidate's
     * parent from the root, making one lookup O(depth * paths^2). */
    const artifact_payload *topology = &workspace->material[0];
    pl_u32 component = 0u;
    pl_u32 component_end = 0u;
    while (component_end < path_bytes && path[component_end] != '/')
        ++component_end;
    pl_u32 depth = 0u;
    pl_u32 matched_depth = 0u;
    pl_u32 ordinal = 0u;
    for (pl_u64 bit = 0u; bit < projection->topology_bits; ++bit) {
        pl_u32 open = !!(topology->bytes[
            TOPOLOGY_HEAD_BYTES + (pl_u32)(bit / 8u)]
            & (0x80u >> (bit % 8u)));
        if (!open) {
            if (depth == matched_depth && matched_depth)
                return ARTIFACT_ERROR_NAMESPACE;
            --depth;
            continue;
        }
        ++depth;
        ++ordinal;
        if (depth != matched_depth + 1u) continue;
        const artifact_payload *name = &workspace->material[ordinal];
        if (!name->bytes || name->length != component_end - component
                || !equal_bytes(name->bytes, path + component,
                                component_end - component))
            continue;
        ++matched_depth;
        if (component_end == path_bytes) {
            *path_ordinal = ordinal;
            return artifact_namespace_reopen_inode(
                projection, workspace, ordinal, inode);
        }
        component = component_end + 1u;
        component_end = component;
        while (component_end < path_bytes
                && path[component_end] != '/')
            ++component_end;
    }
    return ARTIFACT_ERROR_NAMESPACE;
}

int artifact_namespace_lookup(
    const artifact_namespace_population *population,
    const artifact_namespace_projection *projection,
    const artifact_namespace_workspace *workspace,
    const pl_u8 *path, pl_u32 path_bytes,
    pl_u32 *path_ordinal, pl_u32 *inode)
{
    if (!population || !projection || !workspace || !path_ordinal || !inode
            || (path_bytes && !path))
        return ARTIFACT_ERROR_NAMESPACE_RANGE;
    int status = find_path(population, path, path_bytes, path_ordinal);
    return status ? status : artifact_namespace_reopen_inode(
        projection, workspace, *path_ordinal, inode);
}
