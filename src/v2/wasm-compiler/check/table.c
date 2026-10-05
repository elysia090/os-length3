#include <wasm-compiler/cut.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096], output[65536];
static unsigned failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"table compiler: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static int save(const char *directory, unsigned rank, const char *suffix, const void *data, size_t size)
{
    char path[4096]; int n=snprintf(path,sizeof path,"%s/table-%u.%s",directory,rank,suffix);
    if (n<=0 || (size_t)n>=sizeof path) return -1;
    FILE *file=fopen(path,"wbx"); if (!file) return -1;
    int status=fwrite(data,1u,size,file)==size ? 0 : -1;
    if (fclose(file)) status=-1;
    return status;
}
int main(int argc, char **argv)
{
    if (argc!=1 && argc!=2) return 2;
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,0x400000u}; wasm_cut_options options={image.entry,1024u,sizeof output};
    unsigned rank=0u;
    for (unsigned store=0u;store<2u;++store)
    for (unsigned table=0u;table<2u;++table)
    for (unsigned prefix=0u;prefix<3u;++prefix)
    for (unsigned address32=0u;address32<2u;++address32)
    for (unsigned shape=0u;shape<4u;++shape,++rank) {
        memset(page,0x90,sizeof page); unsigned at=0u;
        if (address32) page[at++]=0x67u;
        if (prefix==1u) page[at++]=0x66u;
        if (prefix==2u || shape==2u)
            page[at++]=(pl_u8)(0x40u|(prefix==2u ? 8u : 0u)|(shape==2u ? 1u : 0u));
        page[at++]=0x0fu; page[at++]=0x01u;
        page[at++]=(pl_u8)(((store ? 0u : 2u)+table)<<3u
            | (shape==0u ? 7u : shape==3u ? 5u : 0x44u));
        if (shape==1u || shape==2u) { page[at++]=(pl_u8)(shape==1u ? 0x24u : 0x8cu); page[at++]=14u; }
        if (shape==3u) for (unsigned i=0u;i<4u;++i) page[at++]=(pl_u8)(512u>>(i*8u));
        wasm_cut_report report; pl_u64 length=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report);
        EXPECT(!status);
        if (status) continue;
        EXPECT(report.source_instructions==1u && report.source_bytes==at && report.boundary==WASM_CUT_SYSTEM
            && !report.memory_bytes && !report.memory_access && !report.written_registers && !report.flags_written);
        if (argc==2 && !failures) {
            char json[256]; int n=snprintf(json,sizeof json,
                "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"store\":%u,\"table\":%u,\"prefix\":%u,\"address32\":%u,\"shape\":%u}\n",
                at,store,table,prefix,address32,shape);
            if (n<=0 || (size_t)n>=sizeof json || save(argv[1],rank,"json",json,(size_t)n)
                    || save(argv[1],rank,"wasm",output,(size_t)length) || save(argv[1],rank,"source-page",page,sizeof page)) return 1;
        }
    }
    /* FS/GS use the same C-owned table boundary; LOCK stays invalid. */
    for (unsigned prefix=0u;prefix<3u;++prefix) {
        memset(page,0x90,sizeof page); page[0]=(pl_u8)(prefix==0u ? 0x64u : prefix==1u ? 0x65u : 0xf0u);
        page[1]=0x0fu; page[2]=0x01u; page[3]=0x07u; memset(output,0xa5,sizeof output);
        pl_u64 length=123u; wasm_cut_report report; memset(&report,0xa5,sizeof report);
        if(prefix<2u){
            EXPECT(!wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report));
            EXPECT(report.source_bytes==4u && report.source_instructions==1u && report.boundary==WASM_CUT_SYSTEM);
            continue;
        }
        EXPECT(wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&length,&report)==WASM_COMPILER_ERROR_GRAMMAR);
        EXPECT(length==123u);
        for (unsigned i=0u;i<sizeof output;++i) EXPECT(output[i]==0xa5u);
    }
    if (!failures) puts("Descriptor transfers: 96 C entrance forms green (not Linux boot)");
    return failures ? 1 : 0;
}
