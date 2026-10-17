#include <artifact/index-stream.h>
#include <support/checked.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
enum { MAX_NODES=256 };
typedef struct {
    pl_u8 bytes[MAX_NODES][PL_INDEX_NODE_BYTES],digest[MAX_NODES][32];
    pl_u32 length[MAX_NODES],order[MAX_NODES],count,seen;
    int fail_after;
} store;
static store expected;
static pl_index_stream stream;
static unsigned failures;
#define EXPECT(x) do{if(!(x)){if(failures<8u)fprintf(stderr,"index stream: %u\n",(unsigned)__LINE__);++failures;}}while(0)
static int remember(void *opaque,const pl_u8 digest[32],const pl_u8 *bytes,pl_u32 length)
{
    store *s=opaque;if(s->count==MAX_NODES)return PL_ERROR_INDEX_RANGE;
    pl_u32 n=s->count++;memcpy(s->bytes[n],bytes,length);memcpy(s->digest[n],digest,32);s->length[n]=length;s->order[n]=n;return 0;
}
static int compare(const void *left,const void *right)
{return memcmp(expected.digest[*(const pl_u32 *)left],expected.digest[*(const pl_u32 *)right],32);}
static int verify(void *opaque,const pl_u8 digest[32],const pl_u8 *bytes,pl_u32 length)
{
    store *s=opaque;if(s->fail_after>=0 && s->seen==(pl_u32)s->fail_after)return -999;
    pl_u32 low=0u,high=s->count;
    while(low<high){pl_u32 middle=low+(high-low)/2u;
        if(memcmp(s->digest[s->order[middle]],digest,32)<0)low=middle+1u;else high=middle;}
    if(low==s->count)return PL_ERROR_INDEX_ABSENT;
    pl_u32 n=s->order[low];
    if(memcmp(s->digest[n],digest,32) || s->length[n]!=length || memcmp(s->bytes[n],bytes,length))return PL_ERROR_INDEX_DIGEST;
    ++s->seen;return 0;
}
static void exercise(pl_u32 count,pl_u32 width)
{
    pl_u8 *rows=calloc(count,width);if(!rows){++failures;return;}
    for(pl_u32 i=0u;i<count;++i){pl_write_u64(rows+(pl_u64)i*width,1u);pl_write_u64(rows+(pl_u64)i*width+8u,(pl_u64)i*17u);
        for(pl_u32 j=16u;j<width;++j)rows[(pl_u64)i*width+j]=(pl_u8)(i+j);}
    pl_index_ref refs[MAX_NODES],batch,actual,sentinel;pl_u8 node[4096];
    expected=(store){.fail_after=-1};
    EXPECT(!pl_index_build(rows,width,count,refs,MAX_NODES,node,remember,&expected,&batch));
    qsort(expected.order,expected.count,sizeof expected.order[0],compare);
    EXPECT(!pl_index_stream_open(&stream,width,verify,&expected));
    for(pl_u32 i=0u;i<count;++i)EXPECT(!pl_index_stream_push(&stream,rows+(pl_u64)i*width));
    EXPECT(!pl_index_stream_finish(&stream,&actual));
    pl_u8 a[88],b[88];EXPECT(!pl_index_ref_write(&batch,a) && !pl_index_ref_write(&actual,b) && !memcmp(a,b,sizeof a));
    EXPECT(expected.seen==expected.count);pl_u32 seen=expected.seen;
    EXPECT(!pl_index_stream_finish(&stream,&actual) && expected.seen==seen);
    EXPECT(pl_index_stream_push(&stream,rows)<0 && expected.seen==seen);
    memset(&sentinel,0xa5,sizeof sentinel);actual=sentinel;expected.seen=0u;
    EXPECT(!pl_index_stream_open(&stream,width,verify,&expected));
    EXPECT(!pl_index_stream_push(&stream,rows));
    EXPECT(pl_index_stream_push(&stream,rows)==PL_ERROR_INDEX);
    EXPECT(pl_index_stream_finish(&stream,&actual)==PL_ERROR_INDEX && !memcmp(&actual,&sentinel,sizeof actual));
    expected.seen=0u;expected.fail_after=0;actual=sentinel;
    EXPECT(!pl_index_stream_open(&stream,width,verify,&expected));
    int status=0;for(pl_u32 i=0u;i<count && !status;++i)status=pl_index_stream_push(&stream,rows+(pl_u64)i*width);
    if(!status)status=pl_index_stream_finish(&stream,&actual);
    EXPECT(status==-999 && !memcmp(&actual,&sentinel,sizeof actual));
    EXPECT(pl_index_stream_finish(&stream,&actual)==-999);
    free(rows);
}
int main(void)
{
    const pl_u32 sizes[]={1u,49u,50u,51u,2249u,2250u,2251u,4500u,5000u};
    for(pl_u32 i=0u;i<sizeof sizes/sizeof sizes[0];++i)exercise(sizes[i],80u);
    exercise(46u,4000u);exercise(251u,16u);
    EXPECT(pl_index_stream_open(&stream,0u,verify,&expected)==PL_ERROR_INDEX_RANGE);
    if(failures)return 1;
    printf("Index stream: exact batch roots/nodes at 11 leaf/branch boundaries; bounded %zu-byte frontier; duplicate/failed publication/idempotent finish controls\n",sizeof stream);
    return 0;
}
