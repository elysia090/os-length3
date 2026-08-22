/* Authenticated direct-execution projection of one unchanged linked image. */

#ifndef POSTLINK_PROJECTION_H
#define POSTLINK_PROJECTION_H

#include <postlink/executable.h>

#define PL_PROJECTION_MAGIC "postlink-projection-v1\n"
#define PL_PROJECTION_MAGIC_BYTES 32u
#define PL_PROJECTION_VERSION 1u
#define PL_PROJECTION_HEADER_BYTES 400u

#define PL_PROJECTION_OFF_MAGIC 0u
#define PL_PROJECTION_OFF_VERSION 32u
#define PL_PROJECTION_OFF_HEADER_BYTES 36u
#define PL_PROJECTION_OFF_SOURCE_BYTES 40u
#define PL_PROJECTION_OFF_SOURCE_DIGEST 48u
#define PL_PROJECTION_OFF_ENTRY_RIP 80u
#define PL_PROJECTION_OFF_ENTRY_RESIDUAL 88u
#define PL_PROJECTION_OFF_FUNCTION_COUNT 92u
#define PL_PROJECTION_OFF_INSTANTIATION_COUNT 96u
#define PL_PROJECTION_OFF_PARAMETER_WORD_COUNT 100u
#define PL_PROJECTION_OFF_RESIDUAL_COUNT 104u
#define PL_PROJECTION_OFF_RESIDUAL_EDGE_COUNT 108u
#define PL_PROJECTION_OFF_ENTRY_PAGE_COUNT 112u
#define PL_PROJECTION_OFF_ENTRY_TAIL_ROW_COUNT 116u
#define PL_PROJECTION_OFF_MODULE_INDEX 120u
#define PL_PROJECTION_OFF_RESOURCE_INDEX 208u
#define PL_PROJECTION_OFF_BINDING_INDEX 296u
#define PL_PROJECTION_OFF_FILE_BYTES 384u

#define PL_ERROR_PROJECTION       (-57)
#define PL_ERROR_PROJECTION_RANGE (-58)

typedef struct {
    pl_u64 source_bytes;
    pl_u8 source_digest[PL_EXECUTABLE_DIGEST_BYTES];
    pl_u64 entry_rip;
    pl_u32 entry_residual;
    pl_u32 function_count;
    pl_u32 instantiation_count;
    pl_u32 parameter_word_count;
    pl_u32 residual_count;
    pl_u32 residual_edge_count;
    pl_u32 entry_page_count;
    pl_u32 entry_tail_row_count;
    pl_index_ref modules;
    pl_index_ref resources;
    pl_index_ref bindings;
} pl_projection;

int pl_projection_validate(const pl_projection *projection);
int pl_projection_write(
    const pl_projection *projection,
    pl_u8 target[PL_PROJECTION_HEADER_BYTES]);
int pl_projection_open(
    const pl_u8 *bytes, pl_u64 length, pl_projection *out);

#endif /* POSTLINK_PROJECTION_H */
