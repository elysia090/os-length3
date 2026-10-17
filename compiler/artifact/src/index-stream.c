#include <artifact/index-stream.h>
#include <support/checked.h>

static int fail(pl_index_stream *stream,int error)
{stream->error=error;return error;}
static int publish_node(pl_index_stream *stream,pl_u32 bytes,pl_index_ref *ref)
{
    int status=pl_index_ref_from_node(stream->node,bytes,ref);
    if(!status)status=stream->publish(stream->context,ref->digest,stream->node,bytes);
    return status?fail(stream,status):0;
}
static int append(pl_index_stream *stream,const pl_index_ref *ref)
{
    pl_u32 level=ref->level;
    if(level>PL_INDEX_MAX_LEVEL)return fail(stream,PL_ERROR_INDEX_RANGE);
    stream->children[level][stream->count[level]++]=*ref;
    if(stream->count[level]<PL_INDEX_BRANCH_CAPACITY)return 0;
    if(level==PL_INDEX_MAX_LEVEL)return fail(stream,PL_ERROR_INDEX_RANGE);
    pl_u32 bytes;pl_index_ref parent;
    int status=pl_index_branch_write(stream->children[level],stream->count[level],
        stream->node,sizeof stream->node,&bytes);
    if(!status)status=publish_node(stream,bytes,&parent);
    if(status)return fail(stream,status);
    stream->count[level]=0u;return append(stream,&parent);
}
static int flush_leaf(pl_index_stream *stream)
{
    if(!stream->leaf_count)return 0;
    pl_u32 bytes;pl_index_ref ref;
    int status=pl_index_leaf_write(stream->leaf,stream->row_bytes,stream->leaf_count,
        stream->node,sizeof stream->node,&bytes);
    if(!status)status=publish_node(stream,bytes,&ref);
    if(status)return fail(stream,status);
    stream->leaf_count=0u;return append(stream,&ref);
}
int pl_index_stream_open(pl_index_stream *stream,pl_u32 row_bytes,
    pl_index_publish publish,void *context)
{
    if(!stream || !publish || row_bytes<PL_INDEX_KEY_BYTES
            || row_bytes>PL_INDEX_NODE_BYTES-PL_INDEX_HEADER_BYTES)return PL_ERROR_INDEX_RANGE;
    *stream=(pl_index_stream){.publish=publish,.context=context,.row_bytes=row_bytes};return 0;
}
int pl_index_stream_push(pl_index_stream *stream,const pl_u8 *row)
{
    if(!stream || !row || !stream->publish || stream->closed)return PL_ERROR_INDEX;
    if(stream->error)return stream->error;
    pl_index_key key={pl_read_u64(row),pl_read_u64(row+8u)};
    if(stream->rows && pl_index_key_compare(stream->last,key)>=0)return fail(stream,PL_ERROR_INDEX);
    if(stream->rows==~0ull)return fail(stream,PL_ERROR_INDEX_RANGE);
    for(pl_u32 i=0u;i<stream->row_bytes;++i)
        stream->leaf[stream->leaf_count*stream->row_bytes+i]=row[i];
    ++stream->rows;++stream->leaf_count;stream->last=key;
    pl_u32 capacity=(PL_INDEX_NODE_BYTES-PL_INDEX_HEADER_BYTES)/stream->row_bytes;
    return stream->leaf_count==capacity?flush_leaf(stream):0;
}
int pl_index_stream_finish(pl_index_stream *stream,pl_index_ref *root)
{
    if(!stream || !root || !stream->publish || !stream->rows)return PL_ERROR_INDEX;
    if(stream->error)return stream->error;
    if(stream->closed){*root=stream->root;return 0;}
    int status=flush_leaf(stream);if(status)return status;
    for(;;){
        pl_u32 total=0u,first=PL_INDEX_MAX_LEVEL+1u;
        for(pl_u32 level=0u;level<=PL_INDEX_MAX_LEVEL;++level){
            total+=stream->count[level];if(stream->count[level] && first>level)first=level;}
        if(total==1u){stream->root=stream->children[first][0];stream->closed=1;*root=stream->root;return 0;}
        if(!total || first>=PL_INDEX_MAX_LEVEL)return fail(stream,PL_ERROR_INDEX_RANGE);
        pl_u32 bytes;pl_index_ref parent;
        /* A lone low-level child must be lifted when a higher frontier exists,
         * exactly like the last partial group in the batch canonical writer. */
        status=pl_index_branch_write(stream->children[first],stream->count[first],
            stream->node,sizeof stream->node,&bytes);
        if(!status)status=publish_node(stream,bytes,&parent);
        if(status)return fail(stream,status);
        stream->count[first]=0u;status=append(stream,&parent);if(status)return status;
    }
}
