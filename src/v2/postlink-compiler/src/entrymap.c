#include <postlink/entrymap.h>

static pl_u64 hash_row(const pl_u32 *row)
{
    /* Deterministic build-side index only.  Equality is always checked against
     * the complete row, so collisions cannot change semantic identity. */
    pl_u64 hash = 0x9e3779b97f4a7c15ull;
    for (pl_u32 index = 0; index < PL_ENTRY_TAIL_VALUES; ++index) {
        hash ^= (pl_u64)row[index] + 0x9e3779b97f4a7c15ull
              + (hash << 6u) + (hash >> 2u);
    }
    return hash;
}

static int same_row(const pl_u32 *left, const pl_u32 *right)
{
    for (pl_u32 index = 0; index < PL_ENTRY_TAIL_VALUES; ++index)
        if (left[index] != right[index]) return 0;
    return 1;
}

static void copy_row(pl_u32 *target, const pl_u32 *source)
{
    for (pl_u32 index = 0; index < PL_ENTRY_TAIL_VALUES; ++index)
        target[index] = source[index];
}

int pl_entry_map_builder_open(pl_entry_map_builder *builder,
                              pl_u32 *page_rows, pl_u32 page_capacity,
                              pl_u32 *tail_rows, pl_u32 tail_row_capacity,
                              pl_u32 *hash_slots, pl_u32 hash_slot_count,
                              pl_u32 function_count)
{
    if (!builder || !page_rows || !page_capacity || !tail_rows
            || !tail_row_capacity || !hash_slots || !function_count
            || hash_slot_count <= tail_row_capacity
            || (hash_slot_count & (hash_slot_count - 1u)) != 0u)
        return PL_ERROR_ENTRY_MAP;
    builder->page_rows = page_rows;
    builder->page_capacity = page_capacity;
    builder->page_count = 0u;
    builder->tail_rows = tail_rows;
    builder->tail_row_capacity = tail_row_capacity;
    builder->tail_row_count = 0u;
    builder->hash_slots = hash_slots;
    builder->hash_slot_count = hash_slot_count;
    builder->function_count = function_count;
    for (pl_u32 index = 0; index < hash_slot_count; ++index)
        hash_slots[index] = 0u;
    return 0;
}

static int intern_row(pl_entry_map_builder *builder, const pl_u32 *row,
                      pl_u32 *rank, pl_u32 *inserted_slot)
{
    pl_u32 mask = builder->hash_slot_count - 1u;
    pl_u32 slot = (pl_u32)hash_row(row) & mask;
    for (pl_u32 probe = 0; probe < builder->hash_slot_count; ++probe) {
        pl_u32 encoded = builder->hash_slots[slot];
        if (!encoded) {
            if (builder->tail_row_count >= builder->tail_row_capacity)
                return PL_ERROR_ENTRY_MAP_FULL;
            pl_u32 fresh = builder->tail_row_count++;
            copy_row(builder->tail_rows
                   + (pl_u64)fresh * PL_ENTRY_TAIL_VALUES, row);
            builder->hash_slots[slot] = fresh + 1u;
            *rank = fresh;
            *inserted_slot = slot;
            return 0;
        }
        pl_u32 candidate = encoded - 1u;
        if (candidate >= builder->tail_row_count)
            return PL_ERROR_ENTRY_MAP;
        if (same_row(builder->tail_rows
                   + (pl_u64)candidate * PL_ENTRY_TAIL_VALUES, row)) {
            *rank = candidate;
            *inserted_slot = 0xffffffffu;
            return 0;
        }
        slot = (slot + 1u) & mask;
    }
    return PL_ERROR_ENTRY_MAP_FULL;
}

int pl_entry_map_add_page(pl_entry_map_builder *builder,
                          const pl_u32 functions[PL_ENTRY_PAGE_VALUES],
                          pl_u32 *page_rank)
{
    if (!builder || !functions || !page_rank
            || builder->page_count >= builder->page_capacity)
        return PL_ERROR_ENTRY_MAP_FULL;
    for (pl_u32 index = 0; index < PL_ENTRY_PAGE_VALUES; ++index)
        if (functions[index] >= builder->function_count)
            return PL_ERROR_ENTRY_MAP;

    pl_u32 saved_rows = builder->tail_row_count;
    pl_u32 ranks[PL_ENTRY_PAGE_ROWS];
    pl_u32 inserted[PL_ENTRY_PAGE_ROWS];
    for (pl_u32 index = 0; index < PL_ENTRY_PAGE_ROWS; ++index)
        inserted[index] = 0xffffffffu;

    for (pl_u32 high = 0; high < PL_ENTRY_PAGE_ROWS; ++high) {
        int status = intern_row(
            builder, functions + (pl_u64)high * PL_ENTRY_TAIL_VALUES,
            &ranks[high], &inserted[high]);
        if (status) {
            for (pl_u32 index = 0; index <= high; ++index)
                if (inserted[index] != 0xffffffffu)
                    builder->hash_slots[inserted[index]] = 0u;
            builder->tail_row_count = saved_rows;
            return status;
        }
    }

    pl_u32 page = builder->page_count++;
    for (pl_u32 high = 0; high < PL_ENTRY_PAGE_ROWS; ++high)
        builder->page_rows[(pl_u64)page * PL_ENTRY_PAGE_ROWS + high]
            = ranks[high];
    *page_rank = page;
    return 0;
}

void pl_entry_map_finish(const pl_entry_map_builder *builder,
                         pl_entry_map *out)
{
    if (!builder || !out) return;
    out->page_rows = builder->page_rows;
    out->page_count = builder->page_count;
    out->tail_rows = builder->tail_rows;
    out->tail_row_count = builder->tail_row_count;
    out->function_count = builder->function_count;
}

int pl_entry_map_lookup(const pl_entry_map *map, pl_u32 page_rank,
                        pl_u32 page_offset, pl_u32 *function_rank)
{
    if (!map || !function_rank || page_rank >= map->page_count
            || page_offset >= PL_ENTRY_PAGE_VALUES)
        return PL_ERROR_ENTRY_MAP;
    pl_u32 row = map->page_rows[
        (pl_u64)page_rank * PL_ENTRY_PAGE_ROWS
        + (page_offset >> PL_ENTRY_TAIL_BITS)];
    if (row >= map->tail_row_count) return PL_ERROR_ENTRY_MAP;
    pl_u32 function = pl_entry_map_direct(
        map->page_rows, map->tail_rows, page_rank, page_offset);
    if (function >= map->function_count) return PL_ERROR_ENTRY_MAP;
    *function_rank = function;
    return 0;
}

int pl_entry_map_validate(const pl_entry_map *map)
{
    if (!map || !map->page_rows || !map->page_count || !map->tail_rows
            || !map->tail_row_count || !map->function_count)
        return PL_ERROR_ENTRY_MAP;
    pl_u64 page_words = (pl_u64)map->page_count * PL_ENTRY_PAGE_ROWS;
    for (pl_u64 index = 0u; index < page_words; ++index)
        if (map->page_rows[index] >= map->tail_row_count)
            return PL_ERROR_ENTRY_MAP;
    pl_u64 tail_words = (pl_u64)map->tail_row_count * PL_ENTRY_TAIL_VALUES;
    for (pl_u64 index = 0u; index < tail_words; ++index)
        if (map->tail_rows[index] >= map->function_count)
            return PL_ERROR_ENTRY_MAP;
    return 0;
}

int pl_entry_map_page_writer_open(
    pl_entry_map_page_writer *writer, const pl_entry_map *map)
{
    if (!writer || pl_entry_map_validate(map)) return PL_ERROR_ENTRY_MAP;
    writer->map = map;
    return 0;
}

int pl_entry_map_page_writer_write(
    const pl_entry_map_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES])
{
    if (!writer || !writer->map || !target
            || page_rank >= writer->map->page_count)
        return PL_ERROR_ENTRY_MAP;
    const pl_u32 *rows = writer->map->page_rows
        + (pl_u64)page_rank * PL_ENTRY_PAGE_ROWS;
    for (pl_u32 index = 0u; index < PL_ENTRY_PAGE_ROWS; ++index) {
        if (rows[index] >= writer->map->tail_row_count)
            return PL_ERROR_ENTRY_MAP;
        pl_write_u32(target + index * 4u, rows[index]);
    }
    return 0;
}

int pl_entry_map_tail_writer_write(
    const pl_entry_map_page_writer *writer, pl_u32 tail_rank,
    pl_u8 target[PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES])
{
    if (!writer || !writer->map || !target
            || tail_rank >= writer->map->tail_row_count)
        return PL_ERROR_ENTRY_MAP;
    const pl_u32 *values = writer->map->tail_rows
        + (pl_u64)tail_rank * PL_ENTRY_TAIL_VALUES;
    for (pl_u32 index = 0u; index < PL_ENTRY_TAIL_VALUES; ++index) {
        if (values[index] >= writer->map->function_count)
            return PL_ERROR_ENTRY_MAP;
        pl_write_u32(target + index * 4u, values[index]);
    }
    return 0;
}

int pl_entry_map_page_open(
    const pl_u8 page[PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES],
    pl_u32 tail_row_count)
{
    if (!page || !tail_row_count) return PL_ERROR_ENTRY_MAP;
    for (pl_u32 index = 0u; index < PL_ENTRY_PAGE_ROWS; ++index)
        if (pl_read_u32(page + index * 4u) >= tail_row_count)
            return PL_ERROR_ENTRY_MAP;
    return 0;
}

int pl_entry_map_tail_open(
    const pl_u8 page[PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES],
    pl_u32 function_count)
{
    if (!page || !function_count) return PL_ERROR_ENTRY_MAP;
    for (pl_u32 index = 0u; index < PL_ENTRY_TAIL_VALUES; ++index)
        if (pl_read_u32(page + index * 4u) >= function_count)
            return PL_ERROR_ENTRY_MAP;
    return 0;
}
