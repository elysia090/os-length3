/* Post-link machine container framing.
 *
 * Freestanding: no libc.  The header is compact ASCII JSON with sorted keys,
 * so the few integer fields the framing needs are found by walking keys
 * rather than by building a document.
 */

#include <postlink/machine.h>

static const char MAGIC_V5[] = PL_MACHINE_MAGIC_V5;
static const char MAGIC_V4[] = PL_MACHINE_MAGIC_V4;
static const char MAGIC_V3[] = PL_MACHINE_MAGIC_V3;
static const char MAGIC_V2[] = PL_MACHINE_MAGIC_V2;
static const char MAGIC_V1[] = PL_MACHINE_MAGIC_V1;

static pl_u32 literal_length(const char *text)
{
    pl_u32 length = 0;
    while (text[length]) length += 1;
    return length;
}

static int has_prefix(const pl_u8 *payload, pl_u64 bytes, const char *magic,
                      pl_u32 *length)
{
    pl_u32 extent = literal_length(magic);
    if (bytes < extent) return 0;
    for (pl_u32 index = 0; index < extent; ++index)
        if (payload[index] != (pl_u8)magic[index]) return 0;
    *length = extent;
    return 1;
}

/* One key step of a dotted path: match "name": at `cursor`, returning the
 * offset just past the colon, or 0 when the key is not the next one. */
static pl_u32 match_key(const pl_u8 *header, pl_u32 bytes, pl_u32 cursor,
                        const char *name, pl_u32 name_bytes)
{
    if (cursor >= bytes || header[cursor] != '"') return 0;
    if (bytes - cursor < name_bytes + 3u) return 0;
    for (pl_u32 index = 0; index < name_bytes; ++index)
        if (header[cursor + 1u + index] != (pl_u8)name[index]) return 0;
    if (header[cursor + 1u + name_bytes] != '"') return 0;
    if (header[cursor + 2u + name_bytes] != ':') return 0;
    return cursor + 3u + name_bytes;
}

/* Skip one JSON value and return the offset just past it.  A scalar ends at
 * the enclosing separator; a string ends after its closing quote; an object
 * or array ends after the brace that returns the depth to zero. */
static pl_u32 skip_value(const pl_u8 *header, pl_u32 bytes, pl_u32 cursor)
{
    pl_u32 depth = 0;
    int in_string = 0;
    while (cursor < bytes) {
        pl_u8 byte = header[cursor];
        if (in_string) {
            if (byte == '\\') { cursor += 2u; continue; }
            cursor += 1u;
            if (byte == '"') {
                in_string = 0;
                if (!depth) return cursor;
            }
            continue;
        }
        if (byte == '"') { in_string = 1; cursor += 1u; continue; }
        if (byte == '{' || byte == '[') { depth += 1u; cursor += 1u; continue; }
        if (byte == '}' || byte == ']') {
            if (!depth) return cursor;      /* the enclosing object ended */
            depth -= 1u;
            cursor += 1u;
            if (!depth) return cursor;
            continue;
        }
        if (!depth && byte == ',') return cursor;
        cursor += 1u;
    }
    return cursor;
}

/* Find the value offset for a dotted path, descending one object per step. */
static pl_u32 find_path(const pl_u8 *header, pl_u32 bytes, pl_u32 cursor,
                        const char *path)
{
    while (*path) {
        pl_u32 name_bytes = 0;
        while (path[name_bytes] && path[name_bytes] != '.') name_bytes += 1;

        if (cursor >= bytes || header[cursor] != '{') return 0;
        cursor += 1u;
        pl_u32 value = 0;
        while (cursor < bytes && header[cursor] != '}') {
            value = match_key(header, bytes, cursor, path, name_bytes);
            if (value) break;
            cursor = skip_value(header, bytes, cursor);         /* the key */
            if (cursor >= bytes || header[cursor] != ':') return 0;
            cursor = skip_value(header, bytes, cursor + 1u);    /* the value */
            if (cursor < bytes && header[cursor] == ',') cursor += 1u;
        }
        if (!value) return 0;
        cursor = value;
        path += name_bytes;
        if (*path == '.') path += 1;
    }
    return cursor;
}

static int read_u64_at(const pl_u8 *header, pl_u32 bytes, pl_u32 cursor,
                       pl_u64 *value)
{
    if (cursor >= bytes) return PL_ERROR_CONTAINER;
    pl_u64 result = 0;
    pl_u32 digits = 0;
    while (cursor < bytes && header[cursor] >= '0' && header[cursor] <= '9') {
        pl_u64 digit = (pl_u64)(header[cursor] - '0');
        if (result > (~(pl_u64)0 - digit) / 10u) return PL_ERROR_CONTAINER;
        result = result * 10u + digit;
        cursor += 1;
        digits += 1;
    }
    if (!digits) return PL_ERROR_CONTAINER;
    *value = result;
    return 0;
}

int pl_machine_header_u64(const pl_u8 *header, pl_u32 bytes,
                          const char *path, pl_u64 *value)
{
    pl_u32 cursor = find_path(header, bytes, 0, path);
    if (!cursor) return PL_ERROR_CONTAINER;
    return read_u64_at(header, bytes, cursor, value);
}

/* Read a [offset, length] pair from the region directory. */
static int read_region(const pl_u8 *header, pl_u32 bytes, const char *path,
                       pl_region *region)
{
    pl_u32 cursor = find_path(header, bytes, 0, path);
    if (!cursor || cursor >= bytes || header[cursor] != '[')
        return PL_ERROR_REGION;
    cursor += 1;
    if (read_u64_at(header, bytes, cursor, &region->offset))
        return PL_ERROR_REGION;
    while (cursor < bytes && header[cursor] != ',') cursor += 1;
    if (cursor >= bytes) return PL_ERROR_REGION;
    if (read_u64_at(header, bytes, cursor + 1u, &region->length))
        return PL_ERROR_REGION;
    return 0;
}

int pl_machine_parse(const pl_u8 *payload, pl_u64 bytes, pl_machine *out)
{
    pl_u32 prefix = 0;
    pl_u32 schema;
    if (has_prefix(payload, bytes, MAGIC_V5, &prefix)) schema = 5;
    else if (has_prefix(payload, bytes, MAGIC_V4, &prefix)) schema = 4;
    else if (has_prefix(payload, bytes, MAGIC_V3, &prefix)) schema = 3;
    else if (has_prefix(payload, bytes, MAGIC_V2, &prefix)) schema = 2;
    else if (has_prefix(payload, bytes, MAGIC_V1, &prefix)) schema = 1;
    else return PL_ERROR_MAGIC;

    if (bytes < (pl_u64)prefix + 4u) return PL_ERROR_CONTAINER;
    pl_u32 header_bytes = pl_read_u32(payload + prefix);
    pl_u64 header_offset = (pl_u64)prefix + 4u;
    if (header_bytes > bytes - header_offset) return PL_ERROR_CONTAINER;

    const pl_u8 *header = payload + header_offset;
    out->schema = schema;
    out->header_bytes = header_bytes;
    out->header_offset = (pl_u32)header_offset;

    pl_u64 page_bytes = PL_REGION_BYTES;
    if (pl_machine_header_u64(header, header_bytes, "regions.page_bytes",
                              &page_bytes))
        return PL_ERROR_REGION;
    if (!page_bytes || (page_bytes & (page_bytes - 1u)))
        return PL_ERROR_REGION;
    out->page_bytes = (pl_u32)page_bytes;

    if (read_region(header, header_bytes, "regions.memory", &out->memory)
            || read_region(header, header_bytes, "regions.descriptors",
                           &out->descriptors)
            || read_region(header, header_bytes, "regions.execution",
                           &out->execution))
        return PL_ERROR_REGION;

    /* Regions are written in this order, each aligned, none overlapping, all
     * inside the payload.  Checking the order lets the end-of-region bound be
     * a single comparison per region. */
    const pl_region *ordered[3] = {
        &out->memory, &out->descriptors, &out->execution };
    pl_u64 reach = header_offset + header_bytes;
    for (unsigned index = 0; index < 3; ++index) {
        pl_u64 offset = ordered[index]->offset;
        pl_u64 length = ordered[index]->length;
        if (offset % page_bytes) return PL_ERROR_REGION;
        if (offset < reach) return PL_ERROR_REGION;
        if (length > bytes - offset) return PL_ERROR_REGION;
        reach = offset + length;
    }
    return 0;
}
