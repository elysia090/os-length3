#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <vm/module.h>
#include <support/checked.h>
#include <artifact/resource.h>
#include <sys/mman.h>
#include <stdio.h>
#include <string.h>
extern void native_cut(machine_state *,const void *);
enum { COUNT=130 };
static pl_u8 page[4096],projected[65536],code[65536],saved[65536];
static wasm_cut_options options[COUNT];
static wasm_cut_report reports[COUNT];
static machine_state native[COUNT][2];
static pl_u8 pair[8192];
static unsigned failures;
#define EXPECT(x) do{if(!(x)){if(failures<8u)fprintf(stderr,"source module: %u\n",(unsigned)__LINE__);++failures;}}while(0)
static int save(const char *directory,const char *name,const void *bytes,size_t length)
{
    if(!directory)return 0;
    char path[4096];int n=snprintf(path,sizeof path,"%s/%s",directory,name);
    if(n<1 || (size_t)n>=sizeof path)return 1;
    FILE *file=fopen(path,"wbx");if(!file)return 1;
    int failed=fwrite(bytes,1u,length,file)!=length;if(fclose(file))failed=1;return failed;
}
static int save_projection_root(const char *directory,const char *root_name,const pl_u8 *module,pl_u32 length,pl_u32 pages)
{
    if(!directory)return 0;
    pl_u8 rows[2*ARTIFACT_RESOURCE_BYTES],node[4096],encoded[PL_INDEX_REF_BYTES];
    artifact_resource resource={.object={.bytes=length,.kind=ARTIFACT_RESOURCE_WASM_MODULE,.version=1u},.generation=9u};
    pl_sha256_digest(module,length,resource.object.digest);
    for(pl_u32 i=0u;i<pages;++i){resource.key=(pl_index_key){1u,i};resource.coordinate=i;
        if(artifact_resource_write(&resource,rows+i*ARTIFACT_RESOURCE_BYTES))return 1;}
    pl_u32 bytes;pl_index_ref ref;
    if(pl_index_leaf_write(rows,ARTIFACT_RESOURCE_BYTES,pages,node,sizeof node,&bytes)
            ||pl_index_ref_from_node(node,bytes,&ref)||pl_index_ref_write(&ref,encoded))return 1;
    char name[65];for(pl_u32 i=0u;i<32u;++i)snprintf(name+i*2u,3u,"%02x",ref.digest[i]);
    if(save(directory,name,node,bytes)||save(directory,root_name,encoded,sizeof encoded))return 1;
    for(pl_u32 i=0u;i<32u;++i)snprintf(name+i*2u,3u,"%02x",resource.object.digest[i]);
    return save(directory,name,module,length);
}
int main(int argc,char **argv)
{
    if(argc>2)return 2;
    memset(page,0x90,sizeof page);
    for(pl_u32 i=0u;i<COUNT;++i){
        pl_u32 at=64u+i*16u;page[at]=0xb8u;pl_write_u32(page+at+1u,i*31337u);page[at+5u]=0xc3u;
        options[i]=(wasm_cut_options){0x400000u+at,1u,sizeof projected};
    }
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};pl_u64 code_bytes=0u,bytes=0u;
    EXPECT(!wasm_compiler_emit_code_module(&image,9u,options,COUNT,code,sizeof code,&code_bytes,0));
    EXPECT(!wasm_compiler_emit_code_projection(&image,9u,options,COUNT,projected,sizeof projected,&bytes,reports));
    pl_u64 truncations=bytes;
    vm_module opened={0};EXPECT(!vm_module_open(projected,(pl_u32)bytes,&opened));
    EXPECT(opened.count==COUNT && opened.pages==1u && opened.generation==9u
        && opened.code_bytes==code_bytes && !memcmp(code,projected,(size_t)code_bytes)
        && !memcmp(page,opened.source,sizeof page));
    for(pl_u32 i=0u;i<COUNT;++i){
        vm_module_entry entry;
        EXPECT(!vm_module_find(&opened,9u,64u+i*16u,1u,&entry));
        EXPECT(entry.export_rank==i && entry.source_bytes==5u && entry.source_instructions==1u
            && entry.limit==1u && entry.operand_binding==i*31337u && reports[i].module_bytes==bytes);
    }
    /* Allocation-free parser/output failure checks, including every truncation. */
    vm_module sentinel;memset(&sentinel,0xa5,sizeof sentinel);
    for(pl_u32 n=0u;n<(pl_u32)bytes;++n){vm_module out=sentinel;
        EXPECT(vm_module_open(projected,n,&out)<0 && !memcmp(&out,&sentinel,sizeof out));}
    memcpy(saved,projected,(size_t)bytes);
    pl_u32 row=(pl_u32)(opened.rows-projected),header=row-MACHINE_SOURCE_HEADER_BYTES;
    for(pl_u32 kind=0u;kind<12u;++kind){
        memcpy(projected,saved,(size_t)bytes);
        if(kind<3u)pl_write_u32(projected+header+kind*4u,999u);
        if(kind==3u)pl_write_u32(projected+header+12u,COUNT-1u);
        if(kind==4u)pl_write_u64(projected+header+16u,0u);
        if(kind==5u)pl_write_u32(projected+header+24u,3u);
        if(kind==6u)pl_write_u32(projected+header+28u,1u);
        if(kind==7u)pl_write_u16(projected+row+4u,0u);
        if(kind==8u)pl_write_u16(projected+row+6u,9u);
        if(kind==9u)pl_write_u16(projected+row+8u,0u);
        if(kind==10u)pl_write_u16(projected+row+10u,1u);
        if(kind==11u)pl_write_u32(projected+row+MACHINE_SOURCE_ROW_BYTES,64u);
        vm_module out=sentinel;EXPECT(vm_module_open(projected,(pl_u32)bytes,&out)<0
            && !memcmp(&out,&sentinel,sizeof out));
    }
    memcpy(projected,saved,(size_t)bytes);EXPECT(!vm_module_open(projected,(pl_u32)bytes,&opened));
    vm_module_entry entry,before;memset(&before,0xa5,sizeof before);entry=before;
    EXPECT(vm_module_find(&opened,8u,64u,1u,&entry)<0 && !memcmp(&entry,&before,sizeof entry));
    EXPECT(vm_module_find(&opened,9u,65u,1u,&entry)==VM_MODULE_ERROR_ABSENT && !memcmp(&entry,&before,sizeof entry));
    EXPECT(vm_module_find(&opened,9u,64u,1024u,&entry)==VM_MODULE_ERROR_SOURCE && !memcmp(&entry,&before,sizeof entry));
    /* A projection's witness must fit its full output cap before any write. */
    memset(code,0xa5,sizeof code);pl_u64 untouched=77u;
    EXPECT(wasm_compiler_emit_code_projection(&image,9u,options,COUNT,code,code_bytes,&untouched,0)==WASM_COMPILER_ERROR_CAPACITY);
    EXPECT(untouched==77u);for(pl_u32 i=0u;i<sizeof code;++i)EXPECT(code[i]==0xa5u);
    pl_u8 *executable=mmap(NULL,4096u,PROT_READ|PROT_WRITE|PROT_EXEC,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(executable==MAP_FAILED)return 1;
    memcpy(executable,page,sizeof page);
    for(pl_u32 i=0u;i<COUNT;++i){
        for(pl_u32 r=0u;r<16u;++r)native[i][0].registers[r]=0x1234567890000000ull+(pl_u64)r*1777u+i;
        native[i][0].rflags=0x202u|((i*17u)&0x8d5u);native[i][1]=native[i][0];
        native_cut(&native[i][1],executable+64u+i*16u);native[i][0].registers[4]=native[i][1].registers[4];
        EXPECT(native[i][1].registers[0]==i*31337u && native[i][0].rflags==native[i][1].rflags);
        for(pl_u32 r=1u;r<16u;++r)EXPECT(native[i][0].registers[r]==native[i][1].registers[r]);
    }
    if(munmap(executable,4096u))return 1;
    if(failures)return 1;
    if(argc==2 && (save(argv[1],"projection.wasm",projected,(size_t)bytes)
            ||save(argv[1],"source-page",page,sizeof page)||save(argv[1],"native",native,sizeof native)))return 1;
    /* Same-length but different destinations must not be falsely merged.
     * Repeated instances of each destination still share an exact body. */
    for(pl_u32 i=0u;i<COUNT;++i)page[64u+i*16u]=(pl_u8)(0xb8u+i%4u);
    EXPECT(!wasm_compiler_emit_code_projection(&image,9u,options,COUNT,projected,sizeof projected,&bytes,reports));
    EXPECT(!vm_module_open(projected,(pl_u32)bytes,&opened));
    for(pl_u32 i=(pl_u32)bytes;i<30614u;++i)EXPECT(projected[i]==0u);
    if(argc==2 && (save(argv[1],"mixed.wasm",projected,(size_t)bytes)
            ||save(argv[1],"mixed.source",page,sizeof page)
            ||save_projection_root(argv[1],"mixed.root-ref",projected,(pl_u32)bytes,1u)))return 1;
    memset(pair,0x90,sizeof pair);
    const pl_u32 offsets[]={32u,4094u,4128u};const pl_u32 values[]={17u,0x12345678u,29u};
    pl_x86_map maps[2]={{pair,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u},
        {pair+4096u,0x401000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u}};
    pl_x86_image cross={maps,2u,0u,maps[0].address};wasm_cut_options cuts[3];
    for(pl_u32 i=0u;i<3u;++i){pair[offsets[i]]=0xb8u;pl_write_u32(pair+offsets[i]+1u,values[i]);pair[offsets[i]+5u]=0xc3u;
        cuts[i]=(wasm_cut_options){maps[0].address+offsets[i],1u,sizeof projected};}
    EXPECT(!wasm_compiler_emit_code_projection(&cross,9u,cuts,3u,projected,sizeof projected,&bytes,0));
    EXPECT(!vm_module_open(projected,(pl_u32)bytes,&opened) && opened.pages==2u);
    EXPECT(!vm_module_find(&opened,9u,4094u,1u,&entry) && entry.source_bytes==5u && entry.source_instructions==1u);
    if(failures)return 1;
    if(argc==2 && (save(argv[1],"crossing.wasm",projected,(size_t)bytes)
            ||save(argv[1],"crossing.source",pair,sizeof pair)
            ||save_projection_root(argv[1],"crossing.root-ref",projected,(pl_u32)bytes,2u)))return 1;
    printf("Source module: %u native GPR/flags rows, exact code prefix, %llu truncation refusals and 12 corrupt descriptors; not whole ELF\n",
        COUNT,(unsigned long long)truncations);
    return 0;
}
