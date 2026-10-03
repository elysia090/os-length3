/* Address-only invalidation must not turn into a guest payload load. */
#include <wasm-compiler/cut.h>
#include <stdio.h>
#include <string.h>

static pl_u8 page[4096], output[65536];
static unsigned failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr,"invalidate: line %u\n",(unsigned)__LINE__); ++failures; } } while (0)
static int record(const char *directory, unsigned rank, const char *suffix,
                  const void *data, size_t size)
{
    char path[4096];
    int n=snprintf(path,sizeof path,"%s/invalidate-%u.%s",directory,rank,suffix);
    if (n<=0 || (size_t)n>=sizeof path) return -1;
    FILE *file=fopen(path,"wbx");
    if (!file) return -1;
    int status=fwrite(data,1u,size,file)==size ? 0 : -1;
    if (fclose(file)) status=-1;
    return status;
}
int main(int argc, char **argv)
{
    if (argc!=1 && argc!=2) return 2;
    const pl_u8 segments[]={0u,0x26u,0x2eu,0x36u,0x3eu,0x64u,0x65u};
    const pl_u8 forms[][6]={
        {0x3fu},                         /* [rdi] */
        {0x7cu,0x8fu,0xf9u},             /* [rdi+rcx*4-7] */
        {0xbcu,0x8fu,0,0,0,0x80u},       /* [rdi+rcx*4-2^31] */
        {0x3du,0xf0u,0xffu,0xffu,0xffu}, /* RIP-relative, or EIP with 67 */
        {0x3cu,0x25u,0,0,0,0x80u},       /* absolute sign-extended disp32 */
        {0x3cu,0x24u},                   /* SS:[rsp] */
    };
    const unsigned sizes[]={1u,3u,6u,5u,6u,2u};
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,0x400000u};
    wasm_cut_options options={image.entry,1024u,sizeof output};
    unsigned rank=0u;
    for (unsigned address32=0u;address32<2u;++address32)
    for (unsigned segment=0u;segment<sizeof segments;++segment)
    for (unsigned form=0u;form<sizeof sizes/sizeof sizes[0];++form,++rank) {
        memset(page,0x90,sizeof page);
        unsigned at=0u;
        if (address32) page[at++]=0x67u;
        if (segments[segment]) page[at++]=segments[segment];
        page[at++]=0x0fu; page[at++]=0x01u;
        memcpy(page+at,forms[form],sizes[form]); at+=sizes[form];
        wasm_cut_report report; pl_u64 bytes=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&bytes,&report);
        EXPECT(!status);
        if (status) continue;
        EXPECT(report.source_instructions==1u && report.source_bytes==at
            && report.boundary==WASM_CUT_SYSTEM && report.continuation==image.entry+at
            && !report.read_registers && !report.written_registers
            && !report.flags_written && !report.memory_bytes && !report.memory_access);
        if (argc==2 && !failures) {
            char json[256];
            int n=snprintf(json,sizeof json,
                "{\"entry\":\"4194304\",\"sourceBytes\":%u,\"address32\":%u,\"segment\":%u,\"form\":%u}\n",
                at,address32,segment,form);
            if (n<=0 || (size_t)n>=sizeof json || record(argv[1],rank,"json",json,(size_t)n)
                || record(argv[1],rank,"wasm",output,(size_t)bytes)
                || record(argv[1],rank,"source-page",page,sizeof page)) return 1;
        }
    }
    /* A preceding register effect retires before a privileged cut. */
    const pl_u8 prefix[]={0x48u,0x01u,0xc8u,0x0fu,0x01u,0x3fu};
    memset(page,0x90,sizeof page); memcpy(page,prefix,sizeof prefix);
    wasm_cut_report report; pl_u64 bytes=0u;
    EXPECT(!wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions==1u && report.source_bytes==3u
        && report.written_registers==1u && report.flags_written);
    const pl_u8 refused[][4]={{0xf0u,0x0fu,0x01u,0x3fu},
        {0x0fu,0x01u,0xf9u,0x90u}}; /* RDTSCP is not register INVLPG. */
    for (unsigned i=0u;i<sizeof refused/sizeof refused[0];++i) {
        memset(page,0x90,sizeof page); memcpy(page,refused[i],sizeof refused[i]);
        memset(output,0xa5,sizeof output);
        EXPECT(wasm_compiler_emit_code_cut(&image,9u,&options,output,sizeof output,&bytes,&report)
            ==WASM_COMPILER_ERROR_GRAMMAR);
        for (unsigned j=0u;j<sizeof output;++j) EXPECT(output[j]==0xa5u);
    }
    if (failures) return 1;
    puts("Address-only invalidation: 84 entrance forms green (not Linux boot)");
    return 0;
}
