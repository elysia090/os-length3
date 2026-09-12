#include <artifact/archive.h>

enum { AR_MAGIC_BYTES = 8u, AR_HEADER_BYTES = 60u };

static int equal_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes);

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    if (*value > 0xffffffffffffffffull - addend)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    *value += addend;
    return 0;
}

static int padded_add(pl_u64 *value, pl_u64 bytes)
{
    return add_u64(value, bytes) || add_u64(value, bytes & 1u)
         ? ARTIFACT_ERROR_ARCHIVE_RANGE : 0;
}

static int name_valid(const pl_u8 *name, pl_u32 bytes)
{
    if (!name || !bytes) return 0;
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (!name[index] || name[index] == '\n' || name[index] == '/')
            return 0;
    return 1;
}

static int symbol_valid(const pl_u8 *name, pl_u32 bytes)
{
    if (!name || !bytes) return 0;
    for (pl_u32 index = 0u; index < bytes; ++index)
        if (!name[index]) return 0;
    return 1;
}

static pl_u32 read_u32_be(const pl_u8 *source)
{
    return (pl_u32)source[0] << 24u | (pl_u32)source[1] << 16u
         | (pl_u32)source[2] << 8u | (pl_u32)source[3];
}

static int read_number(const pl_u8 *source, pl_u32 bytes, pl_u32 base,
                       pl_u32 *out)
{
    if (!source || !bytes || (base != 8u && base != 10u) || !out)
        return 0;
    pl_u64 value = 0u;
    pl_u32 digits = 0u;
    while (digits < bytes && source[digits] != ' ') {
        pl_u8 character = source[digits];
        if (character < '0' || character >= '0' + base
                || value > (0xffffffffull - (character - '0')) / base)
            return 0;
        value = value * base + (character - '0');
        ++digits;
    }
    if (!digits) return 0;
    for (pl_u32 index = digits; index < bytes; ++index)
        if (source[index] != ' ') return 0;
    *out = (pl_u32)value;
    return 1;
}

static int read_metadata_number(const pl_u8 *source, pl_u32 bytes,
                                pl_u32 base, pl_u32 *out)
{
    pl_u32 index = 0u;
    while (index < bytes && source[index] == ' ') ++index;
    if (index == bytes) {
        *out = 0u;
        return 1;
    }
    return read_number(source, bytes, base, out);
}

static pl_u32 field_bytes(const pl_u8 *field, pl_u32 capacity)
{
    while (capacity && field[capacity - 1u] == ' ') --capacity;
    return capacity;
}

static int long_name_at(const pl_u8 *table, pl_u32 table_bytes,
                        pl_u32 offset, const pl_u8 **name,
                        pl_u32 *name_bytes)
{
    if (!table || offset >= table_bytes || !name || !name_bytes)
        return 0;
    pl_u32 end = offset;
    while (end + 1u < table_bytes
            && !(table[end] == '/' && table[end + 1u] == '\n'))
        ++end;
    if (end + 1u >= table_bytes || end == offset
            || !name_valid(table + offset, end - offset))
        return 0;
    *name = table + offset;
    *name_bytes = end - offset;
    return 1;
}

static pl_u32 member_rank_at(const pl_u32 *header, pl_u32 members,
                             pl_u32 coordinate)
{
    pl_u32 first = 0u, last = members;
    while (first < last) {
        pl_u32 middle = first + (last - first) / 2u;
        if (header[middle] < coordinate) first = middle + 1u;
        else last = middle;
    }
    return first < members && header[first] == coordinate
         ? first : 0xffffffffu;
}

static int archive_read_impl(
    const pl_u8 *source, pl_u32 source_bytes,
    const artifact_archive_read_workspace *workspace,
    artifact_archive_view *out, pl_u32 *measured_members,
    pl_u32 *measured_symbols)
{
    static const pl_u8 magic[AR_MAGIC_BYTES] = {
        '!', '<', 'a', 'r', 'c', 'h', '>', '\n',
    };
    if (!source || source_bytes < AR_MAGIC_BYTES
            || !measured_members || !measured_symbols
            || !equal_bytes(source, magic, AR_MAGIC_BYTES))
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    if ((workspace && (!out
                       || (workspace->member_capacity
                           && (!workspace->members
                               || !workspace->member_header))))
            || (!workspace && out))
        return ARTIFACT_ERROR_ARCHIVE_RANGE;

    const pl_u8 *long_names = 0;
    pl_u32 long_name_bytes = 0u;
    const pl_u8 *symbol_payload = 0;
    pl_u32 symbol_payload_bytes = 0u;
    pl_u32 symbol_count = 0u, member_count = 0u;
    int saw_symbols = 0, saw_long_names = 0, saw_member = 0;
    pl_u32 cursor = AR_MAGIC_BYTES;
    while (cursor < source_bytes) {
        if (source_bytes - cursor < AR_HEADER_BYTES)
            return ARTIFACT_ERROR_ARCHIVE;
        const pl_u8 *header = source + cursor;
        pl_u32 mtime = 0u, uid = 0u, gid = 0u, mode = 0u, extent = 0u;
        if (header[58] != '`' || header[59] != '\n'
                || !read_metadata_number(
                    header + 16u, 12u, 10u, &mtime)
                || !read_metadata_number(header + 28u, 6u, 10u, &uid)
                || !read_metadata_number(header + 34u, 6u, 10u, &gid)
                || !read_metadata_number(header + 40u, 8u, 8u, &mode)
                || !read_number(header + 48u, 10u, 10u, &extent))
            return ARTIFACT_ERROR_ARCHIVE;
        /* mtime/uid/gid are admitted syntax but not view fields.  The
         * canonical writer substitutes zero, so build-host ownership and
         * clock values cannot create archive identity. */
        (void)mtime;
        (void)uid;
        (void)gid;
        pl_u32 name_extent = field_bytes(header, 16u);
        pl_u64 payload_at64 = (pl_u64)cursor + AR_HEADER_BYTES;
        pl_u64 end64 = payload_at64 + extent + (extent & 1u);
        if (!name_extent || end64 > source_bytes
                || (extent & 1u && source[payload_at64 + extent] != '\n'))
            return ARTIFACT_ERROR_ARCHIVE;
        const pl_u8 *payload = source + payload_at64;

        if (name_extent == 1u && header[0] == '/') {
            if (saw_symbols || saw_long_names || saw_member || extent < 4u)
                return ARTIFACT_ERROR_ARCHIVE;
            symbol_count = read_u32_be(payload);
            if (symbol_count > (extent - 4u) / 5u)
                return ARTIFACT_ERROR_ARCHIVE;
            pl_u64 names_at = 4ull + (pl_u64)symbol_count * 4u;
            if (names_at > extent)
                return ARTIFACT_ERROR_ARCHIVE;
            pl_u32 at = (pl_u32)names_at;
            for (pl_u32 symbol = 0u; symbol < symbol_count; ++symbol) {
                pl_u32 first = at;
                while (at < extent && payload[at]) ++at;
                if (at == extent || !symbol_valid(
                        payload + first, at - first))
                    return ARTIFACT_ERROR_ARCHIVE;
                ++at;
            }
            /* GNU ar may charge one NUL alignment byte inside the symbol
             * table extent.  It carries no symbol response and is discarded
             * by the canonical writer, which uses ordinary archive padding. */
            if (at != extent
                    && !(at + 1u == extent && payload[at] == 0u))
                return ARTIFACT_ERROR_ARCHIVE;
            symbol_payload = payload;
            symbol_payload_bytes = extent;
            saw_symbols = 1;
        } else if (name_extent == 2u
                && header[0] == '/' && header[1] == '/') {
            if (saw_long_names || saw_member || !extent)
                return ARTIFACT_ERROR_ARCHIVE;
            pl_u32 at = 0u;
            while (at < extent) {
                /* GNU ar may account the even-byte alignment newline as
                 * part of the long-name table rather than as outer member
                 * padding. It has no lookup response, so the canonical view
                 * excludes it and the writer regenerates ordinary padding. */
                if (at + 1u == extent && payload[at] == '\n') break;
                const pl_u8 *ignored = 0;
                pl_u32 ignored_bytes = 0u;
                if (!long_name_at(payload, extent, at,
                                  &ignored, &ignored_bytes))
                    return ARTIFACT_ERROR_ARCHIVE;
                at += ignored_bytes + 2u;
            }
            if (at != extent
                    && !(at + 1u == extent && payload[at] == '\n'))
                return ARTIFACT_ERROR_ARCHIVE;
            long_names = payload;
            long_name_bytes = at;
            saw_long_names = 1;
        } else {
            if (member_count == 0xffffffffu)
                return ARTIFACT_ERROR_ARCHIVE_RANGE;
            const pl_u8 *name = 0;
            pl_u32 bytes = 0u;
            if (header[0] == '/') {
                pl_u32 offset = 0u;
                if (!saw_long_names || name_extent < 2u
                        || !read_number(
                            header + 1u, name_extent - 1u, 10u, &offset)
                        || !long_name_at(long_names, long_name_bytes,
                                        offset, &name, &bytes))
                    return ARTIFACT_ERROR_ARCHIVE;
            } else {
                if (header[name_extent - 1u] != '/' || name_extent == 1u)
                    return ARTIFACT_ERROR_ARCHIVE;
                name = header;
                bytes = name_extent - 1u;
                if (!name_valid(name, bytes))
                    return ARTIFACT_ERROR_ARCHIVE;
            }
            if (workspace) {
                if (member_count >= workspace->member_capacity)
                    return ARTIFACT_ERROR_ARCHIVE_RANGE;
                workspace->members[member_count] =
                    (artifact_archive_member){
                        name, bytes, mode, payload, extent,
                    };
                workspace->member_header[member_count] = cursor;
            }
            ++member_count;
            saw_member = 1;
        }
        cursor = (pl_u32)end64;
    }
    if (cursor != source_bytes)
        return ARTIFACT_ERROR_ARCHIVE;
    if (workspace) {
        if (symbol_count > workspace->symbol_capacity
                || (symbol_count && !workspace->symbols))
            return ARTIFACT_ERROR_ARCHIVE_RANGE;
        pl_u32 name_at = symbol_count
            ? 4u + symbol_count * 4u : 0u;
        for (pl_u32 symbol = 0u; symbol < symbol_count; ++symbol) {
            pl_u32 coordinate = read_u32_be(
                symbol_payload + 4u + symbol * 4u);
            pl_u32 rank = member_rank_at(
                workspace->member_header, member_count, coordinate);
            pl_u32 end = name_at;
            while (end < symbol_payload_bytes && symbol_payload[end]) ++end;
            if (rank == 0xffffffffu || end == symbol_payload_bytes)
                return ARTIFACT_ERROR_ARCHIVE;
            workspace->symbols[symbol] = (artifact_archive_symbol){
                symbol_payload + name_at, end - name_at, rank,
            };
            name_at = end + 1u;
        }
        if (symbol_count && name_at != symbol_payload_bytes
                && !(name_at + 1u == symbol_payload_bytes
                     && symbol_payload[name_at] == 0u))
            return ARTIFACT_ERROR_ARCHIVE;
        *out = (artifact_archive_view){
            workspace->members, member_count,
            workspace->symbols, symbol_count,
        };
    }
    *measured_members = member_count;
    *measured_symbols = symbol_count;
    return 0;
}

int artifact_archive_read_measure(
    const pl_u8 *source, pl_u32 source_bytes,
    pl_u32 *members, pl_u32 *symbols)
{
    return archive_read_impl(
        source, source_bytes, 0, 0, members, symbols);
}

int artifact_archive_read(
    const pl_u8 *source, pl_u32 source_bytes,
    const artifact_archive_read_workspace *workspace,
    artifact_archive_view *out)
{
    pl_u32 members = 0u, symbols = 0u;
    return archive_read_impl(
        source, source_bytes, workspace, out, &members, &symbols);
}

static int simple_name(const artifact_archive_member *member)
{
    return member->name_bytes <= 15u;
}

static int equal_payload(const artifact_archive_member *member,
                         const artifact_payload *payload)
{
    if (member->payload_bytes != payload->length) return 0;
    for (pl_u32 index = 0u; index < payload->length; ++index)
        if (member->payload[index] != payload->bytes[index]) return 0;
    return 1;
}

int artifact_archive_verify_payload_ranks(
    const artifact_archive_view *view,
    const artifact_payload *global_payloads, pl_u32 payload_occurrences,
    const pl_u32 *member_occurrence,
    const artifact_payload_workspace *payload_workspace,
    const artifact_payload_projection *payload_projection)
{
    if (!view || !view->members || !view->member_count || !global_payloads
            || !payload_occurrences || !member_occurrence
            || !payload_workspace || !payload_projection)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (payload_projection->occurrences != payload_occurrences)
        return ARTIFACT_ERROR_ARCHIVE;
    for (pl_u32 member = 0u; member < view->member_count; ++member) {
        pl_u32 occurrence = member_occurrence[member];
        if (occurrence >= payload_occurrences
                || !equal_payload(
                    &view->members[member], &global_payloads[occurrence]))
            return ARTIFACT_ERROR_ARCHIVE;
    }
    return 0;
}

int artifact_archive_project(const artifact_archive_view *view,
                             const artifact_archive_workspace *workspace,
                             artifact_archive_projection *out)
{
    if (!view || !workspace || !out
            || (view->member_count
                && (!view->members || !workspace->member_header
                    || !workspace->long_name_offset
                    || workspace->member_capacity < view->member_count))
            || (view->symbol_count && !view->symbols))
        return ARTIFACT_ERROR_ARCHIVE_RANGE;

    pl_u64 long_names = 0u, symbol_index = view->symbol_count ? 4u : 0u;
    pl_u64 payloads = 0u;
    for (pl_u32 index = 0u; index < view->member_count; ++index) {
        const artifact_archive_member *member = &view->members[index];
        if (!name_valid(member->name, member->name_bytes)
                || member->mode > 07777777u
                || (member->payload_bytes && !member->payload)
                || add_u64(&payloads, member->payload_bytes))
            return ARTIFACT_ERROR_ARCHIVE_RANGE;
        if (simple_name(member)) {
            workspace->long_name_offset[index] = 0xffffffffu;
        } else {
            if (long_names > 0xffffffffull
                    || member->name_bytes > 0xffffffffu - 2u
                    || add_u64(&long_names, member->name_bytes + 2u))
                return ARTIFACT_ERROR_ARCHIVE_RANGE;
            workspace->long_name_offset[index] = (pl_u32)(
                long_names - member->name_bytes - 2u);
        }
    }
    for (pl_u32 index = 0u; index < view->symbol_count; ++index) {
        const artifact_archive_symbol *symbol = &view->symbols[index];
        if (!symbol_valid(symbol->name, symbol->name_bytes)
                || symbol->member_rank >= view->member_count
                || add_u64(&symbol_index, 4u)
                || add_u64(&symbol_index, symbol->name_bytes + 1u))
            return ARTIFACT_ERROR_ARCHIVE_RANGE;
    }
    if (long_names > 0xffffffffull || symbol_index > 0xffffffffull)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;

    pl_u64 cursor = AR_MAGIC_BYTES;
    if (view->symbol_count
            && (add_u64(&cursor, AR_HEADER_BYTES)
                || padded_add(&cursor, symbol_index)))
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (long_names
            && (add_u64(&cursor, AR_HEADER_BYTES)
                || padded_add(&cursor, long_names)))
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    for (pl_u32 index = 0u; index < view->member_count; ++index) {
        workspace->member_header[index] = cursor;
        if (cursor > 0xffffffffull
                || add_u64(&cursor, AR_HEADER_BYTES)
                || padded_add(&cursor, view->members[index].payload_bytes))
            return ARTIFACT_ERROR_ARCHIVE_RANGE;
    }
    if (cursor > 0xffffffffull || payloads > cursor)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    *out = (artifact_archive_projection){
        view->member_count, view->symbol_count, payloads,
        cursor - payloads, cursor,
        (pl_u32)long_names, (pl_u32)symbol_index,
    };
    return 0;
}

static int write_number(pl_u8 *field, pl_u32 width, pl_u64 value,
                        pl_u32 base)
{
    pl_u8 reversed[32];
    pl_u32 digits = 0u;
    do {
        pl_u32 digit = (pl_u32)(value % base);
        reversed[digits++] = (pl_u8)('0' + digit);
        value /= base;
    } while (value && digits < sizeof(reversed));
    if (value || digits > width) return ARTIFACT_ERROR_ARCHIVE_RANGE;
    for (pl_u32 index = 0u; index < digits; ++index)
        field[index] = reversed[digits - 1u - index];
    for (pl_u32 index = digits; index < width; ++index) field[index] = ' ';
    return 0;
}

static int write_header(pl_u8 *target, const pl_u8 *name,
                        pl_u32 name_bytes, pl_u32 mode, pl_u32 bytes)
{
    if (!target || !name || !name_bytes || name_bytes > 16u)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    for (pl_u32 index = 0u; index < AR_HEADER_BYTES; ++index)
        target[index] = ' ';
    for (pl_u32 index = 0u; index < name_bytes; ++index)
        target[index] = name[index];
    int status = write_number(target + 16u, 12u, 0u, 10u);
    if (!status) status = write_number(target + 28u, 6u, 0u, 10u);
    if (!status) status = write_number(target + 34u, 6u, 0u, 10u);
    if (!status) status = write_number(target + 40u, 8u, mode, 8u);
    if (!status) status = write_number(target + 48u, 10u, bytes, 10u);
    target[58] = '`';
    target[59] = '\n';
    return status;
}

static void write_u32_be(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)(value >> 24u);
    target[1] = (pl_u8)(value >> 16u);
    target[2] = (pl_u8)(value >> 8u);
    target[3] = (pl_u8)value;
}

static void copy_bytes(pl_u8 *target, const pl_u8 *source, pl_u32 bytes)
{
    for (pl_u32 index = 0u; index < bytes; ++index)
        target[index] = source[index];
}

int artifact_archive_member_material_write(
    const artifact_archive_member *member,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    static const pl_u8 tag[] = { 'A','R','V','M',1u };
    if (!member || !name_valid(member->name, member->name_bytes)
            || !target || !written || member->name_bytes > 0xffffffffu - 13u
            || capacity < member->name_bytes + 13u)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    copy_bytes(target, tag, sizeof(tag));
    write_u32_be(target + sizeof(tag), member->name_bytes);
    copy_bytes(target + sizeof(tag) + 4u,
               member->name, member->name_bytes);
    write_u32_be(target + sizeof(tag) + 4u + member->name_bytes,
                 member->mode);
    *written = member->name_bytes + 13u;
    return 0;
}

int artifact_archive_symbol_material_write(
    const artifact_archive_symbol *symbol,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    static const pl_u8 tag[] = { 'A','R','V','S',1u };
    if (!symbol || !symbol_valid(symbol->name, symbol->name_bytes)
            || !target || !written || symbol->name_bytes > 0xffffffffu - 13u
            || capacity < symbol->name_bytes + 13u)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    copy_bytes(target, tag, sizeof(tag));
    write_u32_be(target + sizeof(tag), symbol->name_bytes);
    copy_bytes(target + sizeof(tag) + 4u,
               symbol->name, symbol->name_bytes);
    write_u32_be(target + sizeof(tag) + 4u + symbol->name_bytes,
                 symbol->member_rank);
    *written = symbol->name_bytes + 13u;
    return 0;
}

int artifact_archive_member_response_write(
    const artifact_archive_member *member,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!member || !name_valid(member->name, member->name_bytes)
            || (member->payload_bytes && !member->payload)
            || !target || !written || member->name_bytes > 0xffffffffu - 12u
            || member->payload_bytes
               > 0xffffffffu - member->name_bytes - 12u)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    pl_u32 bytes = member->name_bytes + 12u + member->payload_bytes;
    if (bytes > capacity) return ARTIFACT_ERROR_ARCHIVE_RANGE;
    write_u32_be(target, member->name_bytes);
    copy_bytes(target + 4u, member->name, member->name_bytes);
    write_u32_be(target + 4u + member->name_bytes, member->mode);
    write_u32_be(target + 8u + member->name_bytes, member->payload_bytes);
    copy_bytes(target + 12u + member->name_bytes,
               member->payload, member->payload_bytes);
    *written = bytes;
    return 0;
}

int artifact_archive_symbol_response_write(
    const artifact_archive_symbol *symbol,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written)
{
    if (!symbol || !symbol_valid(symbol->name, symbol->name_bytes)
            || !target || !written
            || symbol->name_bytes > 0xffffffffu - 8u)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    pl_u32 bytes = symbol->name_bytes + 8u;
    if (bytes > capacity) return ARTIFACT_ERROR_ARCHIVE_RANGE;
    write_u32_be(target, symbol->name_bytes);
    copy_bytes(target + 4u, symbol->name, symbol->name_bytes);
    write_u32_be(target + 4u + symbol->name_bytes, symbol->member_rank);
    *written = bytes;
    return 0;
}

int artifact_archive_write(const artifact_archive_view *view,
                           const artifact_archive_workspace *workspace,
                           pl_u8 *target, pl_u32 target_capacity,
                           pl_u32 *written)
{
    artifact_archive_projection projection;
    int status = artifact_archive_project(view, workspace, &projection);
    if (status || !target || !written
            || projection.archive_bytes > target_capacity)
        return status ? status : ARTIFACT_ERROR_ARCHIVE_RANGE;
    static const pl_u8 magic[AR_MAGIC_BYTES] = {
        '!', '<', 'a', 'r', 'c', 'h', '>', '\n',
    };
    copy_bytes(target, magic, sizeof(magic));
    pl_u32 cursor = AR_MAGIC_BYTES;

    if (view->symbol_count) {
        static const pl_u8 symbol_name[] = { '/' };
        status = write_header(target + cursor, symbol_name,
                              sizeof(symbol_name), 0u,
                              projection.symbol_index_bytes);
        cursor += AR_HEADER_BYTES;
        if (!status) {
            write_u32_be(target + cursor, view->symbol_count);
            cursor += 4u;
            for (pl_u32 index = 0u; index < view->symbol_count; ++index) {
                write_u32_be(target + cursor, (pl_u32)workspace->member_header[
                    view->symbols[index].member_rank]);
                cursor += 4u;
            }
            for (pl_u32 index = 0u; index < view->symbol_count; ++index) {
                copy_bytes(target + cursor, view->symbols[index].name,
                           view->symbols[index].name_bytes);
                cursor += view->symbols[index].name_bytes;
                target[cursor++] = 0u;
            }
            if (cursor & 1u) target[cursor++] = '\n';
        }
    }
    if (!status && projection.long_name_bytes) {
        static const pl_u8 long_name[] = { '/', '/' };
        status = write_header(target + cursor, long_name, sizeof(long_name),
                              0u, projection.long_name_bytes);
        cursor += AR_HEADER_BYTES;
        for (pl_u32 index = 0u; !status && index < view->member_count;
             ++index) {
            const artifact_archive_member *member = &view->members[index];
            if (simple_name(member)) continue;
            copy_bytes(target + cursor, member->name, member->name_bytes);
            cursor += member->name_bytes;
            target[cursor++] = '/';
            target[cursor++] = '\n';
        }
        if (!status && (cursor & 1u)) target[cursor++] = '\n';
    }

    for (pl_u32 index = 0u; !status && index < view->member_count; ++index) {
        const artifact_archive_member *member = &view->members[index];
        pl_u8 name[16];
        pl_u32 name_bytes = 0u;
        if (simple_name(member)) {
            copy_bytes(name, member->name, member->name_bytes);
            name_bytes = member->name_bytes;
            name[name_bytes++] = '/';
        } else {
            name[0] = '/';
            name_bytes = 1u;
            pl_u8 digits[15];
            pl_u32 digit_count = 0u;
            pl_u32 value = workspace->long_name_offset[index];
            do {
                digits[digit_count++] = (pl_u8)('0' + value % 10u);
                value /= 10u;
            } while (value);
            for (pl_u32 digit = 0u; digit < digit_count; ++digit)
                name[name_bytes++] = digits[digit_count - 1u - digit];
        }
        status = write_header(target + cursor, name, name_bytes,
                              member->mode, member->payload_bytes);
        cursor += AR_HEADER_BYTES;
        if (!status && member->payload_bytes) {
            copy_bytes(target + cursor, member->payload,
                       member->payload_bytes);
            cursor += member->payload_bytes;
        }
        if (!status && (cursor & 1u)) target[cursor++] = '\n';
    }
    if (status || cursor != projection.archive_bytes)
        return status ? status : ARTIFACT_ERROR_ARCHIVE;
    *written = cursor;
    return 0;
}

static int equal_bytes(const pl_u8 *left, const pl_u8 *right, pl_u32 bytes)
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index)
        difference |= (pl_u32)(left[index] ^ right[index]);
    return difference == 0u;
}

int artifact_archive_complete_project(
    const artifact_archive_instance *archives, pl_u32 archive_count,
    const artifact_payload *global_payloads, pl_u32 payload_occurrences,
    const artifact_payload_projection *payload_projection,
    const artifact_archive_complete_workspace *workspace,
    artifact_archive_complete_projection *out)
{
    if (!archives || !archive_count || !global_payloads
            || !payload_occurrences || !payload_projection
            || payload_projection->occurrences != payload_occurrences
            || !workspace || !out
            || !workspace->generated || !workspace->generated_capacity)
        return ARTIFACT_ERROR_ARCHIVE_RANGE;
    artifact_archive_complete_projection result = {
        .payload = *payload_projection,
    };
    int status = 0;
    for (pl_u32 archive = 0u; !status && archive < archive_count; ++archive) {
        const artifact_archive_instance *instance = &archives[archive];
        if ((instance->view.member_count
                && (!instance->view.members
                    || !instance->member_payload_occurrence
                    || !workspace->member_header
                    || !workspace->long_name_offset
                    || instance->view.member_count
                       > workspace->member_capacity))
                || !instance->canonical_bytes
                || !instance->canonical_byte_count)
            return ARTIFACT_ERROR_ARCHIVE_RANGE;
        for (pl_u32 member = 0u;
                member < instance->view.member_count; ++member) {
            pl_u32 occurrence = instance->member_payload_occurrence[member];
            if (occurrence >= payload_occurrences
                    || !equal_payload(
                        &instance->view.members[member],
                        &global_payloads[occurrence]))
                return ARTIFACT_ERROR_ARCHIVE;
        }
        artifact_archive_workspace archive_workspace = {
            workspace->member_header, workspace->long_name_offset,
            workspace->member_capacity,
        };
        artifact_archive_projection projection = { 0 };
        status = artifact_archive_project(
            &instance->view, &archive_workspace, &projection);
        if (!status && (projection.archive_bytes
                        != instance->canonical_byte_count
                || projection.archive_bytes > workspace->generated_capacity))
            status = ARTIFACT_ERROR_ARCHIVE;
        pl_u32 written = 0u;
        if (!status)
            status = artifact_archive_write(
                &instance->view, &archive_workspace,
                workspace->generated, workspace->generated_capacity,
                &written);
        if (!status && (written != instance->canonical_byte_count
                || !equal_bytes(
                    workspace->generated, instance->canonical_bytes,
                    written)))
            status = ARTIFACT_ERROR_ARCHIVE;
        if (!status && (result.members
                        > 0xffffffffu - instance->view.member_count
                || result.symbols
                   > 0xffffffffu - instance->view.symbol_count
                || add_u64(
                    &result.opened_archive_bytes,
                    instance->canonical_byte_count)
                || add_u64(
                    &result.generated_archive_bytes, written)))
            status = ARTIFACT_ERROR_ARCHIVE_RANGE;
        if (!status) {
            result.members += instance->view.member_count;
            result.symbols += instance->view.symbol_count;
            ++result.archives;
        }
    }
    if (status) return status;
    if (result.opened_archive_bytes != result.generated_archive_bytes)
        return ARTIFACT_ERROR_ARCHIVE;
    result.removed_archive_bytes = result.opened_archive_bytes;
    *out = result;
    return 0;
}
