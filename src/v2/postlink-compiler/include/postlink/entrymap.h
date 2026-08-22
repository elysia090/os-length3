/* Total executable-page entry map in direct physical-array form.
 *
 * A page offset has a 4-bit row coordinate and an 8-bit tail coordinate:
 *
 *     row = page_rows[page_rank * 16 + (offset >> 8)]
 *     function = tail_rows[row * 256 + (offset & 255)]
 *
 * Equal 256-entry rows have one rank across every page.  The runtime performs
 * two dependent loads only on a genuinely dynamic transfer; static successors
 * already carry their function rank.  No block record or decoded instruction
 * is reconstructed by this lookup.
 */

#ifndef POSTLINK_ENTRYMAP_H
#define POSTLINK_ENTRYMAP_H

#include <postlink/executable.h>

#define PL_ENTRY_PAGE_VALUES PL_EXECUTABLE_PAGE_BYTES
#define PL_ENTRY_TAIL_BITS 8u
#define PL_ENTRY_TAIL_VALUES (1u << PL_ENTRY_TAIL_BITS)
#define PL_ENTRY_PAGE_ROWS (PL_ENTRY_PAGE_VALUES / PL_ENTRY_TAIL_VALUES)

#define PL_ERROR_ENTRY_MAP      (-28)
#define PL_ERROR_ENTRY_MAP_FULL (-29)

typedef struct {
    const pl_u32 *page_rows;
    pl_u32 page_count;
    const pl_u32 *tail_rows;
    pl_u32 tail_row_count;
    pl_u32 function_count;
} pl_entry_map;

/* Build-side state.  Capacities are counts of pages, 256-entry tail rows, and
 * hash slots respectively.  The hash table is temporary proof-erased work;
 * only page_rows and the distinct tail_rows become executable module data. */
typedef struct {
    pl_u32 *page_rows;
    pl_u32 page_capacity;
    pl_u32 page_count;
    pl_u32 *tail_rows;
    pl_u32 tail_row_capacity;
    pl_u32 tail_row_count;
    pl_u32 *hash_slots;       /* tail-row rank + 1; zero means empty */
    pl_u32 hash_slot_count;
    pl_u32 function_count;
} pl_entry_map_builder;

typedef struct {
    const pl_entry_map *map;
} pl_entry_map_page_writer;

/* `hash_slot_count` must be a power of two and exceed tail_row_capacity, which
 * keeps lookup finite even when every admitted row is distinct. */
int pl_entry_map_builder_open(pl_entry_map_builder *builder,
                              pl_u32 *page_rows, pl_u32 page_capacity,
                              pl_u32 *tail_rows, pl_u32 tail_row_capacity,
                              pl_u32 *hash_slots, pl_u32 hash_slot_count,
                              pl_u32 function_count);

/* Add one complete 4096-coordinate page.  The operation is transactional: on
 * failure neither the page count nor the distinct-row set changes. */
int pl_entry_map_add_page(pl_entry_map_builder *builder,
                          const pl_u32 functions[PL_ENTRY_PAGE_VALUES],
                          pl_u32 *page_rank);

void pl_entry_map_finish(const pl_entry_map_builder *builder,
                         pl_entry_map *out);

int pl_entry_map_validate(const pl_entry_map *map);
int pl_entry_map_page_writer_open(
    pl_entry_map_page_writer *writer, const pl_entry_map *map);
int pl_entry_map_page_writer_write(
    const pl_entry_map_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES]);
int pl_entry_map_tail_writer_write(
    const pl_entry_map_page_writer *writer, pl_u32 tail_rank,
    pl_u8 target[PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES]);
int pl_entry_map_page_open(
    const pl_u8 page[PL_EXECUTABLE_ENTRY_PAGE_ROWS_BYTES],
    pl_u32 tail_row_count);
int pl_entry_map_tail_open(
    const pl_u8 page[PL_EXECUTABLE_ENTRY_TAIL_ROW_BYTES],
    pl_u32 function_count);

/* The exact runtime hot path after publication has proved every bound. */
static inline pl_u32 pl_entry_map_direct(const pl_u32 *page_rows,
                                         const pl_u32 *tail_rows,
                                         pl_u32 page_rank,
                                         pl_u32 page_offset)
{
    pl_u32 row = page_rows[
        (pl_u64)page_rank * PL_ENTRY_PAGE_ROWS
        + (page_offset >> PL_ENTRY_TAIL_BITS)];
    return tail_rows[(pl_u64)row * PL_ENTRY_TAIL_VALUES
                     + (page_offset & (PL_ENTRY_TAIL_VALUES - 1u))];
}

/* Checked boundary used by loaders, tests and untrusted coordinates. */
int pl_entry_map_lookup(const pl_entry_map *map, pl_u32 page_rank,
                        pl_u32 page_offset, pl_u32 *function_rank);

#endif /* POSTLINK_ENTRYMAP_H */
