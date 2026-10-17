/* Streaming construction of the existing canonical sorted index. */
#ifndef ARTIFACT_INDEX_STREAM_H
#define ARTIFACT_INDEX_STREAM_H
#include <artifact/index.h>
#define PL_INDEX_BRANCH_CAPACITY ((PL_INDEX_NODE_BYTES-PL_INDEX_HEADER_BYTES)/PL_INDEX_REF_BYTES)

typedef struct {
    pl_index_publish publish;
    void *context;
    pl_u64 rows;
    pl_u32 row_bytes,leaf_count;
    int error,closed;
    pl_index_key last;
    pl_index_ref root;
    pl_u32 count[PL_INDEX_MAX_LEVEL+1u];
    pl_index_ref children[PL_INDEX_MAX_LEVEL+1u][PL_INDEX_BRANCH_CAPACITY];
    pl_u8 leaf[PL_INDEX_NODE_BYTES],node[PL_INDEX_NODE_BYTES];
} pl_index_stream;

/* Caller owns the bounded frontier, no full row/reference population. Rows
 * and emitted nodes are borrowed only for each call/callback. Root publication
 * is separate: only successful finish yields a complete canonical root. */
int pl_index_stream_open(pl_index_stream *stream,pl_u32 row_bytes,
    pl_index_publish publish,void *context);
int pl_index_stream_push(pl_index_stream *stream,const pl_u8 *row);
int pl_index_stream_finish(pl_index_stream *stream,pl_index_ref *root);
#endif
