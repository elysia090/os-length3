#include <vm/directory.h>
#include <support/checked.h>
#include <stdio.h>
#include <string.h>

enum { ROWS=3000, MAX_NODES=80 };
static pl_u8 rows[ROWS][ARTIFACT_RESOURCE_BYTES], scratch[PL_INDEX_NODE_BYTES];
static pl_index_ref references[64];
static struct { pl_u8 bytes[PL_INDEX_NODE_BYTES];pl_u32 length;pl_u8 digest[32]; } nodes[MAX_NODES];
static pl_u32 node_count, visits, longest;
static pl_u8 object[65536];static pl_u32 object_bytes=32u;
static unsigned failures;
#define EXPECT(x) do {if(!(x)){fprintf(stderr,"directory: line %u\n",(unsigned)__LINE__);++failures;}} while(0)
static int same(const void *a,const void *b,size_t bytes) {return !memcmp(a,b,bytes);}
static int publish(void *owner,const pl_u8 digest[32],const pl_u8 *bytes,pl_u32 length)
{
    (void)owner;if(node_count>=MAX_NODES)return -1;
    memcpy(nodes[node_count].digest,digest,32u);memcpy(nodes[node_count].bytes,bytes,length);
    nodes[node_count++].length=length;return 0;
}
static pl_u32 find(const pl_index_ref *ref)
{
    for(pl_u32 i=0u;i<node_count;++i)
        if(same(nodes[i].digest,ref->digest,32u) && nodes[i].length==ref->node_bytes)return i;
    return MAX_NODES;
}
static int walk(vm_directory *directory,pl_index_key key)
{
    int status=vm_directory_begin(directory,9u,key,ARTIFACT_RESOURCE_WASM_MODULE);pl_u32 count=0u;
    if(status)return status;
    while(directory->stage==VM_DIRECTORY_NODE){
        pl_u32 rank=find(&directory->pending);if(rank==MAX_NODES)return -1;
        status=vm_directory_node(directory,9u,directory->ticket,nodes[rank].bytes,nodes[rank].length);
        if(status<0)return status;
        ++count;
    }
    visits+=count;if(count>longest)longest=count;
    return vm_directory_object(directory,9u,directory->ticket,object,object_bytes);
}
static int save(const char *directory,const char *name,const pl_u8 *bytes,pl_u32 length)
{
    char path[4096];int n=snprintf(path,sizeof path,"%s/%s",directory,name);
    if(n<1 || (size_t)n>=sizeof path)return -1;
    FILE *file=fopen(path,"wbx");if(!file)return -1;
    int status=fwrite(bytes,1u,length,file)==length?0:-1;
    if(fclose(file))status=-1;
    return status;
}
int main(int argc,char **argv)
{
    if(argc!=1 && argc!=3)return 2;
    for(pl_u32 i=0u;i<object_bytes;++i)object[i]=(pl_u8)(i*7u);
    if(argc==3){
        FILE *file=fopen(argv[2],"rb");if(!file)return 3;
        size_t bytes=fread(object,1u,sizeof object,file);int extra=fgetc(file);
        int failed=ferror(file) || extra!=EOF || !bytes;
        if(fclose(file))failed=1;
        if(failed)return 4;
        object_bytes=(pl_u32)bytes;
    }
    artifact_resource resource={.object={.bytes=object_bytes,.kind=ARTIFACT_RESOURCE_WASM_MODULE,.version=1u},.generation=9u};
    pl_sha256_digest(object,object_bytes,resource.object.digest);
    for(pl_u32 i=0u;i<ROWS;++i){
        resource.key=(pl_index_key){1u,i};resource.coordinate=(pl_u64)i*16u;
        EXPECT(!artifact_resource_write(&resource,rows[i]));
    }
    pl_index_ref root;
    int built=pl_index_build(rows[0],ARTIFACT_RESOURCE_BYTES,ROWS,references,64u,scratch,publish,0,&root);
    EXPECT(!built);if(built)return 1;
    EXPECT(root.level==2u && root.rows==ROWS);
    vm_directory directory={0};
    EXPECT(!vm_directory_open(&directory,&root,9u,sizeof object));
    for(pl_u32 i=0u;i<ROWS;++i){
        EXPECT(!walk(&directory,(pl_index_key){1u,i}));
        EXPECT(directory.stage==VM_DIRECTORY_READY && directory.resource.coordinate==(pl_u64)i*16u);
    }
    EXPECT(longest==3u && visits==ROWS*3u);
    vm_directory_cancel(&directory);EXPECT(directory.stage==VM_DIRECTORY_IDLE);
    EXPECT(!vm_directory_begin(&directory,9u,(pl_index_key){1u,7u},1u));
    pl_u32 rank=find(&directory.pending);EXPECT(rank<MAX_NODES);
    vm_directory before=directory;
    EXPECT(vm_directory_begin(&directory,8u,(pl_index_key){1u,7u},1u)==VM_DIRECTORY_ERROR_STALE);
    EXPECT(vm_directory_begin(&directory,9u,(pl_index_key){1u,8u},1u)==VM_DIRECTORY_ERROR_BUSY);
    EXPECT(vm_directory_node(&directory,8u,directory.ticket,nodes[rank].bytes,nodes[rank].length)==VM_DIRECTORY_ERROR_STALE);
    EXPECT(vm_directory_node(&directory,9u,directory.ticket+1u,nodes[rank].bytes,nodes[rank].length)==VM_DIRECTORY_ERROR_STALE);
    EXPECT(vm_directory_node(&directory,9u,directory.ticket,nodes[rank].bytes,nodes[rank].length-1u)<0);
    EXPECT(same(&before,&directory,sizeof directory));
    memcpy(scratch,nodes[rank].bytes,nodes[rank].length);scratch[127]^=1u;
    EXPECT(vm_directory_node(&directory,9u,directory.ticket,scratch,nodes[rank].length)==PL_ERROR_INDEX_DIGEST);
    EXPECT(same(&before,&directory,sizeof directory));
    pl_u64 old=directory.ticket;vm_directory_cancel(&directory);
    EXPECT(!vm_directory_begin(&directory,9u,(pl_index_key){1u,7u},1u) && directory.ticket>old);
    EXPECT(vm_directory_node(&directory,9u,old,nodes[rank].bytes,nodes[rank].length)==VM_DIRECTORY_ERROR_STALE);
    while(directory.stage==VM_DIRECTORY_NODE){
        rank=find(&directory.pending);EXPECT(rank<MAX_NODES);
        EXPECT(vm_directory_node(&directory,9u,directory.ticket,nodes[rank].bytes,nodes[rank].length)>=0);
    }
    before=directory;object[0]^=1u;
    EXPECT(vm_directory_object(&directory,9u,directory.ticket,object,object_bytes)==PL_ERROR_INDEX_DIGEST);
    EXPECT(same(&before,&directory,sizeof directory));object[0]^=1u;
    EXPECT(vm_directory_object(&directory,8u,directory.ticket,object,object_bytes)==VM_DIRECTORY_ERROR_STALE);
    EXPECT(!vm_directory_object(&directory,9u,directory.ticket,object,object_bytes));
    EXPECT(vm_directory_object(&directory,9u,directory.ticket,object,object_bytes)==VM_DIRECTORY_ERROR_STALE);
    old=directory.ticket;vm_directory_close(&directory);
    EXPECT(!vm_directory_open(&directory,&root,9u,sizeof object));
    EXPECT(!vm_directory_begin(&directory,9u,(pl_index_key){1u,7u},1u) && directory.ticket>old);
    EXPECT(vm_directory_node(&directory,9u,old,nodes[find(&root)].bytes,root.node_bytes)==VM_DIRECTORY_ERROR_STALE);
    EXPECT(vm_directory_open(&directory,0,9u,sizeof object)==VM_DIRECTORY_ERROR_INPUT && !directory.stage);
    EXPECT(!vm_directory_open(&directory,&root,9u,1u));
    EXPECT(walk(&directory,(pl_index_key){1u,7u})==PL_ERROR_INDEX_RANGE);
    vm_directory_cancel(&directory);
    EXPECT(!vm_directory_begin(&directory,9u,(pl_index_key){1u,7u},ARTIFACT_RESOURCE_MEMORY_PAGE));
    while(directory.pending.level){
        rank=find(&directory.pending);EXPECT(rank<MAX_NODES);
        EXPECT(!vm_directory_node(&directory,9u,directory.ticket,nodes[rank].bytes,nodes[rank].length));
    }
    rank=find(&directory.pending);
    EXPECT(vm_directory_node(&directory,9u,directory.ticket,nodes[rank].bytes,nodes[rank].length)==PL_ERROR_INDEX);
    EXPECT(directory.stage==VM_DIRECTORY_NODE);
    vm_directory_cancel(&directory);directory.sequence=~0ull;
    EXPECT(vm_directory_begin(&directory,9u,(pl_index_key){1u,7u},1u)==VM_DIRECTORY_ERROR_EXHAUSTED);
    EXPECT(directory.stage==VM_DIRECTORY_IDLE);
    /* Malformed resource rows are rejected without changing caller output. */
    artifact_resource unchanged=resource,decoded=unchanged;
    memcpy(scratch,rows[0],ARTIFACT_RESOURCE_BYTES);pl_write_u64(scratch+72u,0u);
    EXPECT(artifact_resource_read(scratch,&decoded)<0 && same(&decoded,&unchanged,sizeof decoded));
    if(failures)return 1;
    if(argc==3){
        pl_u8 encoded[PL_INDEX_REF_BYTES];EXPECT(!pl_index_ref_write(&root,encoded));
        if(save(argv[1],"root-ref",encoded,sizeof encoded))return 5;
        for(pl_u32 i=0u;i<node_count+1u;++i){
            const pl_u8 *digest=i<node_count?nodes[i].digest:resource.object.digest;
            char name[65];for(pl_u32 b=0u;b<32u;++b){name[b*2u]="0123456789abcdef"[digest[b]>>4u];name[b*2u+1u]="0123456789abcdef"[digest[b]&15u];}name[64]=0;
            if(save(argv[1],name,i<node_count?nodes[i].bytes:object,i<node_count?nodes[i].length:object_bytes))return 6;
        }
    }
    printf("Artifact directory: 3000 bounded 3-node authenticated paths; stale/corrupt/cancel/reopen/exhaustion controls; owner %u bytes, no payload copy\n",(unsigned)sizeof(vm_directory));
    return failures?1:0;
}
