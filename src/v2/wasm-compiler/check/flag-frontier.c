#include "../src/cut-internal.h"
#include <stdio.h>
#include <string.h>

static pl_u32 decodes;
int __real_pl_x86_decode_profile(const pl_x86_image *,pl_u64,pl_x86_instruction *);
int __wrap_pl_x86_decode_profile(const pl_x86_image *image,pl_u64 rip,pl_x86_instruction *instruction)
{
    ++decodes;
    return __real_pl_x86_decode_profile(image,rip,instruction);
}
static pl_u8 page[4096],module[65536];
int main(void)
{
    static const struct {pl_u8 bytes[4];pl_u32 size;} operations[]={
        {{0x90},1},{{0x31,0xc0},2},{{0x11,0xd8},2},{{0x19,0xc1},2},
        {{0xd3,0xe0},2},{{0xc1,0xe0,0},3},{{0xc1,0xe0,1},3},
        {{0xf8},1},{{0xf9},1},{{0xfc},1},{{0xfd},1},
        {{0x0f,0x94,0xc0},3},{{0x0f,0x4c,0xc1},3},
        {{0x0f,0xbc,0xc1},3},{{0x0f,0xaf,0xc1},3},
        {{0x0f,0x90,0xc0},3},{{0x0f,0x92,0xc0},3},{{0x0f,0x96,0xc0},3},
        {{0x0f,0x98,0xc0},3},{{0x0f,0x9a,0xc0},3},{{0x0f,0x9e,0xc0},3},
    };
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};
    pl_u32 cases=0u;
    for(pl_u32 length=1u;length<=1024u;length*=2u)
    for(pl_u32 rotation=0u;rotation<sizeof operations/sizeof operations[0];++rotation) {
        memset(page,0xcc,sizeof page);pl_u32 at=0u;
        for(pl_u32 rank=0u;rank<length;++rank) {
            pl_u32 selected=(rank+rotation)%(sizeof operations/sizeof operations[0]);
            memcpy(page+at,operations[selected].bytes,operations[selected].size);
            at+=operations[selected].size;
        }
        wasm_cut_options options={map.address,length,sizeof module};
        wasm_cut_report report;pl_u64 bytes;
        decodes=0u;
        int status=wasm_compiler_emit_code_cut(&image,9u,&options,module,sizeof module,&bytes,&report);
        if(status || report.source_instructions!=length || report.source_bytes!=at
                || decodes!=3u*length) {
            fprintf(stderr,"flag frontier red: length=%u rotation=%u status=%d decodes=%u expected=%u\n",
                length,rotation,status,decodes,3u*length);
            return 1;
        }
        wasm_cut_report measured;pl_u64 predicted=0u;decodes=0u;
        status=wasm_compiler_measure_code_cut(&image,9u,&options,&predicted,&measured);
        if(status || predicted!=bytes || memcmp(&measured,&report,sizeof report)
                || decodes!=2u*length) {
            fprintf(stderr,"flag measure red: length=%u rotation=%u status=%d decodes=%u expected=%u\n",
                length,rotation,status,decodes,2u*length);
            return 1;
        }
        ++cases;
    }
    printf("flag frontier: %u exact decode-count cuts; no reverse-pass redecoding\n",cases);
    return 0;
}
