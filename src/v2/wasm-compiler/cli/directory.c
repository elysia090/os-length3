/* Filesystem publication adapter. Compiler core has no storage/index dependency. */
#include "io.h"
#include <wasm-compiler/image.h>
#include <artifact/index-stream.h>
#include <artifact/resource.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#ifdef _WIN32
#include <direct.h>
#define create_directory(path) _mkdir(path)
#else
#include <sys/stat.h>
#define create_directory(path) mkdir(path,0700)
#endif

typedef struct { const char *directory;pl_u64 objects,bytes; } publisher;
static int publish(void *opaque,const pl_u8 digest[32],const pl_u8 *bytes,pl_u32 length)
{
    publisher *owner=opaque;char path[4096],name[65];
    for(pl_u32 i=0u;i<32u;++i)snprintf(name+i*2u,3u,"%02x",digest[i]);
    int n=snprintf(path,sizeof path,"%s/%s",owner->directory,name);
    if(n<0 || (size_t)n>=sizeof path)return WASM_COMPILER_ERROR_INPUT;
    FILE *file=fopen(path,"wbx");
    if(!file){
        file=fopen(path,"rb");if(!file)return WASM_COMPILER_ERROR_INPUT;
        pl_u8 chunk[4096];pl_u32 at=0u;int failed=0;
        while(at<length){pl_u32 take=length-at;if(take>sizeof chunk)take=sizeof chunk;
            if(fread(chunk,1u,take,file)!=take || memcmp(chunk,bytes+at,take)){failed=1;break;}at+=take;}
        if(!failed && fgetc(file)!=EOF)failed=1;
        if(fclose(file))failed=1;
        return failed?WASM_COMPILER_ERROR_PROOF:0;
    }
    int failed=fwrite(bytes,1u,length,file)!=length;if(fclose(file))failed=1;
    if(failed){remove(path);return WASM_COMPILER_ERROR_INPUT;}
    ++owner->objects;owner->bytes+=length;return 0;
}
int cli_directory(const char *input_path,const char *output_directory)
{
    pl_u64 input_bytes=0u;pl_u8 *input=cli_read_file(input_path,&input_bytes);if(!input)return 1;
    wasm_compiler compiler;wasm_image_plan plan;wasm_compile_options options={256u,65536u};
    int status=wasm_compiler_open(&compiler,input,input_bytes);
    if(!status)status=wasm_compiler_prepare_image(&compiler,&options,&plan);
    if(status){fprintf(stderr,"image directory: entire input refused (%d); no directory/root published\n",status);free(input);return 1;}
    if(input_bytes>0xffffffffu){free(input);return 1;}
    pl_u8 *module=malloc(plan.maximum_module_bytes);pl_index_stream *index=malloc(sizeof *index);
    if(!module || !index){free(module);free(index);free(input);return 1;}
    wasm_image_iterator iterator;status=wasm_image_iterator_open(&plan,&iterator);
    if(!status && create_directory(output_directory)){
        fprintf(stderr,"image directory: output already exists or is unwritable; previous root preserved\n");
        free(index);free(module);free(input);return 1;
    }
    publisher owner={.directory=output_directory};pl_u8 row[ARTIFACT_RESOURCE_BYTES];
    artifact_resource source={.key={0u,0u},.object={.bytes=input_bytes,.kind=ARTIFACT_RESOURCE_IMAGE_SOURCE,.version=1u},.generation=1u};
    memcpy(source.object.digest,plan.input_digest,32u);
    if(!status)status=pl_index_stream_open(index,sizeof row,publish,&owner);
    if(!status)status=publish(&owner,plan.input_digest,input,(pl_u32)input_bytes);
    if(!status)status=artifact_resource_write(&source,row);
    if(!status)status=pl_index_stream_push(index,row);
    wasm_image_module info;
    while(!status){int next=wasm_image_iterator_next(&iterator,module,plan.maximum_module_bytes,&info);
        if(next<=0){status=next;break;}
        artifact_resource resource={.key={1u,info.first},.object={.bytes=info.code.bytes,
            .kind=ARTIFACT_RESOURCE_IMAGE_MODULE,.version=1u},.coordinate=info.end,.generation=1u};
        pl_sha256_digest(module,info.code.bytes,resource.object.digest);
        status=publish(&owner,resource.object.digest,module,(pl_u32)info.code.bytes);
        if(!status)status=artifact_resource_write(&resource,row);
        if(!status)status=pl_index_stream_push(index,row);
    }
    pl_index_ref root;pl_u8 root_bytes[PL_INDEX_REF_BYTES];
    if(!status)status=pl_index_stream_finish(index,&root);
    if(!status)status=pl_index_ref_write(&root,root_bytes);
    if(!status){char path[4096],temporary[4096];int n=snprintf(path,sizeof path,"%s/root-ref",output_directory);
        int t=snprintf(temporary,sizeof temporary,"%s/.root-ref.tmp",output_directory);
        if(n<0 || t<0 || (size_t)n>=sizeof path || (size_t)t>=sizeof temporary)status=WASM_COMPILER_ERROR_INPUT;
        else{FILE *file=fopen(temporary,"wbx");if(!file)status=WASM_COMPILER_ERROR_INPUT;
            else{int failed=fwrite(root_bytes,1u,sizeof root_bytes,file)!=sizeof root_bytes;if(fclose(file))failed=1;
                if(!failed && rename(temporary,path))failed=1;
                if(failed){remove(temporary);status=WASM_COMPILER_ERROR_INPUT;}}}}
    if(!status)printf("Image directory: %llu coordinates / %llu ordinary modules; %llu objects / %llu bytes; root-ref last; not signed release/Linux boot\n",
        plan.report.source_instructions,plan.report.modules,owner.objects,owner.bytes+sizeof root_bytes);
    else fprintf(stderr,"image directory: refused (%d); root unpublished (staged objects may remain)\n",status);
    free(index);free(module);free(input);return status?1:0;
}
