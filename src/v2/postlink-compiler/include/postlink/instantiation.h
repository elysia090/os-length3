/* Canonical projection from exact block identities to shared Wasm bodies. */

#ifndef POSTLINK_INSTANTIATION_H
#define POSTLINK_INSTANTIATION_H

#include <postlink/format.h>

#define PL_ERROR_INSTANTIATION          (-55)
#define PL_ERROR_INSTANTIATION_CAPACITY (-56)

#define PL_INSTANTIATION_PAGE_BYTES 4096u
#define PL_INSTANTIATION_PAGE_HEADER 64u
#define PL_INSTANTIATION_PAGE_ROWS 512u
#define PL_INSTANTIATION_ROW_BYTES 7u
#define PL_INSTANTIATION_PAGE_USED \
    (PL_INSTANTIATION_PAGE_HEADER \
     + PL_INSTANTIATION_PAGE_ROWS * PL_INSTANTIATION_ROW_BYTES)

#define PL_PARAMETER_PAGE_BYTES 4096u
#define PL_PARAMETER_PAGE_HEADER 64u
#define PL_PARAMETER_PAGE_WORDS \
    ((PL_PARAMETER_PAGE_BYTES - PL_PARAMETER_PAGE_HEADER) / 8u)

/* Each exact block identity selects one shared topology and one packed span
 * of u64 constants.  Parameter spans are contiguous and gap-free, so the
 * table has one canonical spelling and a selected row touches at most the
 * pages covering that span. */
typedef struct {
    const pl_u32 *topologies;
    const pl_u32 *parameter_offsets;
    const pl_u8 *parameter_counts;
    const pl_u64 *parameters;
    pl_u32 instantiation_count;
    pl_u32 topology_count;
    pl_u32 parameter_word_count;
} pl_instantiation_table;

typedef struct {
    const pl_instantiation_table *table;
} pl_instantiation_page_writer;

int pl_instantiation_validate(const pl_instantiation_table *table);
int pl_instantiation_page_writer_open(
    pl_instantiation_page_writer *writer,
    const pl_instantiation_table *table);

int pl_instantiation_page_write(
    const pl_instantiation_table *table, pl_u32 page_rank,
    pl_u8 target[PL_INSTANTIATION_PAGE_BYTES]);
int pl_instantiation_page_writer_write(
    const pl_instantiation_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_INSTANTIATION_PAGE_BYTES]);
int pl_instantiation_page_open(
    const pl_u8 page[PL_INSTANTIATION_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 instantiation_count, pl_u32 topology_count,
    pl_u32 parameter_word_count, pl_u32 expected_first_parameter);
int pl_instantiation_page_get(
    const pl_u8 page[PL_INSTANTIATION_PAGE_BYTES], pl_u32 local,
    pl_u32 *topology, pl_u32 *first_parameter, pl_u32 *parameter_count);

int pl_parameter_page_write(
    const pl_instantiation_table *table, pl_u32 page_rank,
    pl_u8 target[PL_PARAMETER_PAGE_BYTES]);
int pl_parameter_page_writer_write(
    const pl_instantiation_page_writer *writer, pl_u32 page_rank,
    pl_u8 target[PL_PARAMETER_PAGE_BYTES]);
int pl_parameter_page_open(
    const pl_u8 page[PL_PARAMETER_PAGE_BYTES], pl_u32 page_rank,
    pl_u32 parameter_word_count);
int pl_parameter_page_get(
    const pl_u8 page[PL_PARAMETER_PAGE_BYTES], pl_u32 local,
    pl_u64 *value);

#endif /* POSTLINK_INSTANTIATION_H */
