/* Canonical exact-identity projection and parameter delivery pages. */

#include <postlink/instantiation.h>

static const pl_u8 INSTANTIATION_MAGIC[8] = {
    'P', 'L', 'I', 'N', 'S', 'T', '1', '\n',
};
static const pl_u8 PARAMETER_MAGIC[8] = {
    'P', 'L', 'P', 'A', 'R', 'M', '1', '\n',
};

static pl_u32 read_u24(const pl_u8 *source)
{
    return (pl_u32)source[0]
         | ((pl_u32)source[1] << 8u)
         | ((pl_u32)source[2] << 16u);
}

static void write_u24(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8u);
    target[2] = (pl_u8)(value >> 16u);
}

static pl_u32 read_u32(const pl_u8 *source)
{
    return (pl_u32)source[0]
         | ((pl_u32)source[1] << 8u)
         | ((pl_u32)source[2] << 16u)
         | ((pl_u32)source[3] << 24u);
}

static void write_u32(pl_u8 *target, pl_u32 value)
{
    target[0] = (pl_u8)value;
    target[1] = (pl_u8)(value >> 8u);
    target[2] = (pl_u8)(value >> 16u);
    target[3] = (pl_u8)(value >> 24u);
}

static pl_u64 read_u64(const pl_u8 *source)
{
    pl_u64 value = 0u;
    for (pl_u32 byte = 0u; byte < 8u; ++byte)
        value |= (pl_u64)source[byte] << (byte * 8u);
    return value;
}

static void write_u64(pl_u8 *target, pl_u64 value)
{
    for (pl_u32 byte = 0u; byte < 8u; ++byte)
        target[byte] = (pl_u8)(value >> (byte * 8u));
}

static int same_magic(const pl_u8 *source, const pl_u8 expected[8])
{
    pl_u32 difference = 0u;
    for (pl_u32 index = 0u; index < 8u; ++index)
        difference |= (pl_u32)(source[index] ^ expected[index]);
    return difference == 0u;
}

static int all_zero(const pl_u8 *source, pl_u32 bytes)
{
    pl_u32 any = 0u;
    for (pl_u32 index = 0u; index < bytes; ++index) any |= source[index];
    return any == 0u;
}

static void clear_page(pl_u8 *target)
{
    for (pl_u32 index = 0u; index < PL_INSTANTIATION_PAGE_BYTES; ++index)
        target[index] = 0u;
}

int pl_instantiation_validate(const pl_instantiation_table *table)
{
    if (!table || !table->topologies || !table->parameter_offsets
            || !table->parameter_counts || !table->instantiation_count
            || !table->topology_count
            || table->instantiation_count >= (1u << 24u)
            || table->topology_count >= (1u << 24u)
            || table->parameter_word_count > (1u << 24u)
            || (table->parameter_word_count && !table->parameters))
        return PL_ERROR_INSTANTIATION;

    pl_u32 next = 0u;
    for (pl_u32 rank = 0u; rank < table->instantiation_count; ++rank) {
        pl_u32 count = table->parameter_counts[rank];
        if (table->topologies[rank] >= table->topology_count
                || table->parameter_offsets[rank] != next
                || next > table->parameter_word_count
                || count > table->parameter_word_count - next)
            return PL_ERROR_INSTANTIATION;
        next += count;
    }
    return next == table->parameter_word_count
         ? 0 : PL_ERROR_INSTANTIATION;
}

int pl_instantiation_page_writer_open(
    pl_instantiation_page_writer *writer,
    const pl_instantiation_table *table)
{
    if (!writer || pl_instantiation_validate(table))
        return PL_ERROR_INSTANTIATION;
    writer->table = table;
    return 0;
}

static int instantiation_page_write(
    const pl_instantiation_table *table, pl_u32 page_rank,
    pl_u8 target[PL_INSTANTIATION_PAGE_BYTES])
{
    if (!table || !target
            || page_rank >= (table->instantiation_count
                              + PL_INSTANTIATION_PAGE_ROWS - 1u)
                             / PL_INSTANTIATION_PAGE_ROWS)
        return PL_ERROR_INSTANTIATION;
    clear_page(target);
    for (pl_u32 index = 0u; index < 8u; ++index)
        target[index] = INSTANTIATION_MAGIC[index];
    pl_u32 first = page_rank * PL_INSTANTIATION_PAGE_ROWS;
    pl_u32 count = table->instantiation_count - first;
    if (count > PL_INSTANTIATION_PAGE_ROWS)
        count = PL_INSTANTIATION_PAGE_ROWS;
    pl_u32 first_parameter = table->parameter_offsets[first];
    pl_u32 final = first + count;
    pl_u32 final_parameter = final == table->instantiation_count
                           ? table->parameter_word_count
                           : table->parameter_offsets[final];
    write_u32(target + 8u, page_rank);
    write_u32(target + 12u, count);
    write_u32(target + 16u, first_parameter);
    write_u32(target + 20u, final_parameter);
    for (pl_u32 local = 0u; local < count; ++local) {
        pl_u32 rank = first + local;
        pl_u8 *row = target + PL_INSTANTIATION_PAGE_HEADER
                   + local * PL_INSTANTIATION_ROW_BYTES;
        write_u24(row, table->topologies[rank]);
        write_u24(row + 3u, table->parameter_offsets[rank]);
        row[6] = table->parameter_counts[rank];
    }
    return 0;
}

int pl_instantiation_page_writer_write(
    const pl_instantiation_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_INSTANTIATION_PAGE_BYTES])
{
    return !writer || !writer->table ? PL_ERROR_INSTANTIATION
        : instantiation_page_write(writer->table, page_rank, target);
}

int pl_instantiation_page_write(
    const pl_instantiation_table *table, pl_u32 page_rank,
    pl_u8 target[PL_INSTANTIATION_PAGE_BYTES])
{
    pl_instantiation_page_writer writer;
    int status = pl_instantiation_page_writer_open(&writer, table);
    return status ? status
                  : pl_instantiation_page_writer_write(
                      &writer, page_rank, target);
}

int pl_instantiation_page_open(
    const pl_u8 page[PL_INSTANTIATION_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 instantiation_count, pl_u32 topology_count,
    pl_u32 parameter_word_count, pl_u32 expected_first_parameter)
{
    if (!page || !instantiation_count || !topology_count
            || instantiation_count >= (1u << 24u)
            || topology_count >= (1u << 24u)
            || parameter_word_count > (1u << 24u)
            || !same_magic(page, INSTANTIATION_MAGIC)
            || read_u32(page + 8u) != page_rank
            || !all_zero(page + 24u,
                         PL_INSTANTIATION_PAGE_HEADER - 24u)
            || !all_zero(page + PL_INSTANTIATION_PAGE_USED,
                         PL_INSTANTIATION_PAGE_BYTES
                         - PL_INSTANTIATION_PAGE_USED))
        return PL_ERROR_INSTANTIATION;
    if (page_rank > 0xffffffffu / PL_INSTANTIATION_PAGE_ROWS)
        return PL_ERROR_INSTANTIATION;
    pl_u32 first = page_rank * PL_INSTANTIATION_PAGE_ROWS;
    if (first >= instantiation_count) return PL_ERROR_INSTANTIATION;
    pl_u32 expected_count = instantiation_count - first;
    if (expected_count > PL_INSTANTIATION_PAGE_ROWS)
        expected_count = PL_INSTANTIATION_PAGE_ROWS;
    pl_u32 count = read_u32(page + 12u);
    pl_u32 next = read_u32(page + 16u);
    pl_u32 final_parameter = read_u32(page + 20u);
    if (count != expected_count || next != expected_first_parameter
            || final_parameter < next
            || final_parameter > parameter_word_count)
        return PL_ERROR_INSTANTIATION;
    for (pl_u32 local = 0u; local < count; ++local) {
        const pl_u8 *row = page + PL_INSTANTIATION_PAGE_HEADER
                         + local * PL_INSTANTIATION_ROW_BYTES;
        pl_u32 topology = read_u24(row);
        pl_u32 offset = read_u24(row + 3u);
        pl_u32 words = row[6];
        if (topology >= topology_count || offset != next
                || next > final_parameter
                || words > final_parameter - next)
            return PL_ERROR_INSTANTIATION;
        next += words;
    }
    if (next != final_parameter
            || !all_zero(page + PL_INSTANTIATION_PAGE_HEADER
                          + count * PL_INSTANTIATION_ROW_BYTES,
                         PL_INSTANTIATION_PAGE_USED
                         - PL_INSTANTIATION_PAGE_HEADER
                         - count * PL_INSTANTIATION_ROW_BYTES))
        return PL_ERROR_INSTANTIATION;
    return 0;
}

int pl_instantiation_page_get(
    const pl_u8 page[PL_INSTANTIATION_PAGE_BYTES], pl_u32 local,
    pl_u32 *topology, pl_u32 *first_parameter, pl_u32 *parameter_count)
{
    if (!page || !topology || !first_parameter || !parameter_count
            || !same_magic(page, INSTANTIATION_MAGIC)
            || local >= read_u32(page + 12u)
            || local >= PL_INSTANTIATION_PAGE_ROWS)
        return PL_ERROR_INSTANTIATION;
    const pl_u8 *row = page + PL_INSTANTIATION_PAGE_HEADER
                     + local * PL_INSTANTIATION_ROW_BYTES;
    *topology = read_u24(row);
    *first_parameter = read_u24(row + 3u);
    *parameter_count = row[6];
    return 0;
}

static int parameter_page_write(
    const pl_instantiation_table *table, pl_u32 page_rank,
    pl_u8 target[PL_PARAMETER_PAGE_BYTES])
{
    if (!table || !target
            || !table->parameter_word_count
            || page_rank >= (table->parameter_word_count
                              + PL_PARAMETER_PAGE_WORDS - 1u)
                             / PL_PARAMETER_PAGE_WORDS)
        return PL_ERROR_INSTANTIATION;
    clear_page(target);
    for (pl_u32 index = 0u; index < 8u; ++index)
        target[index] = PARAMETER_MAGIC[index];
    pl_u32 first = page_rank * PL_PARAMETER_PAGE_WORDS;
    pl_u32 count = table->parameter_word_count - first;
    if (count > PL_PARAMETER_PAGE_WORDS) count = PL_PARAMETER_PAGE_WORDS;
    write_u32(target + 8u, page_rank);
    write_u32(target + 12u, count);
    for (pl_u32 local = 0u; local < count; ++local)
        write_u64(target + PL_PARAMETER_PAGE_HEADER + local * 8u,
                  table->parameters[first + local]);
    return 0;
}

int pl_parameter_page_writer_write(
    const pl_instantiation_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_PARAMETER_PAGE_BYTES])
{
    return !writer || !writer->table ? PL_ERROR_INSTANTIATION
        : parameter_page_write(writer->table, page_rank, target);
}

int pl_parameter_page_write(
    const pl_instantiation_table *table, pl_u32 page_rank,
    pl_u8 target[PL_PARAMETER_PAGE_BYTES])
{
    pl_instantiation_page_writer writer;
    int status = pl_instantiation_page_writer_open(&writer, table);
    return status ? status
                  : pl_parameter_page_writer_write(
                      &writer, page_rank, target);
}

int pl_parameter_page_open(
    const pl_u8 page[PL_PARAMETER_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 parameter_word_count)
{
    if (!page || !parameter_word_count
            || parameter_word_count > (1u << 24u)
            || !same_magic(page, PARAMETER_MAGIC)
            || read_u32(page + 8u) != page_rank
            || !all_zero(page + 16u, PL_PARAMETER_PAGE_HEADER - 16u))
        return PL_ERROR_INSTANTIATION;
    if (page_rank > 0xffffffffu / PL_PARAMETER_PAGE_WORDS)
        return PL_ERROR_INSTANTIATION;
    pl_u32 first = page_rank * PL_PARAMETER_PAGE_WORDS;
    if (first >= parameter_word_count) return PL_ERROR_INSTANTIATION;
    pl_u32 expected = parameter_word_count - first;
    if (expected > PL_PARAMETER_PAGE_WORDS) expected = PL_PARAMETER_PAGE_WORDS;
    pl_u32 count = read_u32(page + 12u);
    if (count != expected
            || !all_zero(page + PL_PARAMETER_PAGE_HEADER + count * 8u,
                         PL_PARAMETER_PAGE_BYTES
                         - PL_PARAMETER_PAGE_HEADER - count * 8u))
        return PL_ERROR_INSTANTIATION;
    return 0;
}

int pl_parameter_page_get(
    const pl_u8 page[PL_PARAMETER_PAGE_BYTES], pl_u32 local,
    pl_u64 *value)
{
    if (!page || !value || !same_magic(page, PARAMETER_MAGIC)
            || local >= read_u32(page + 12u)
            || local >= PL_PARAMETER_PAGE_WORDS)
        return PL_ERROR_INSTANTIATION;
    *value = read_u64(page + PL_PARAMETER_PAGE_HEADER + local * 8u);
    return 0;
}
