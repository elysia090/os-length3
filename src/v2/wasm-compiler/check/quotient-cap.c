#include <wasm-compiler/cut.h>
#include <support/checked.h>
#include "../src/internal.h"
#include <stdio.h>
#include <string.h>

enum { COUNT=130 };
static pl_u8 page[4096],output[65536],reference[65536];
static wasm_cut_options options[WASM_CUT_MODULE_MAX_FUNCTIONS];
static wasm_cut_report reports[COUNT],saved[COUNT];
static unsigned failures;
static pl_u64 decoder_calls;
extern int __real_pl_x86_decode_profile(const pl_x86_image *,pl_u64,pl_x86_instruction *);
int __wrap_pl_x86_decode_profile(const pl_x86_image *image,pl_u64 rip,pl_x86_instruction *instruction)
{
    ++decoder_calls;return __real_pl_x86_decode_profile(image,rip,instruction);
}
#define EXPECT(x) do{if(!(x)){if(failures<8u)fprintf(stderr,"quotient cap: %u\n",(unsigned)__LINE__);++failures;}}while(0)
static pl_u32 uleb(const pl_u8 *bytes,pl_u32 *at)
{
    pl_u32 value=0u,shift=0u;
    do{pl_u8 byte=bytes[(*at)++];value|=(pl_u32)(byte&127u)<<shift;
        if(!(byte&128u))return value;
        shift+=7u;}while(shift<32u);
    return ~0u;
}
static pl_u32 bodies(const pl_u8 *bytes,pl_u32 length)
{
    pl_u32 at=8u;
    while(at<length){pl_u32 id=bytes[at++],size=uleb(bytes,&at);
        if(id==10u)return uleb(bytes,&at);
        at+=size;}
    return ~0u;
}
static void expect_late_difference(const pl_u8 *bytes,pl_u32 length)
{
    pl_u32 at=8u;
    while(at<length){pl_u32 id=bytes[at++],size=uleb(bytes,&at);
        if(id==10u){EXPECT(uleb(bytes,&at)==2u);
            pl_u32 left_bytes=uleb(bytes,&at),left=at;at+=left_bytes;
            pl_u32 right_bytes=uleb(bytes,&at),right=at,i=0u;
            EXPECT(left_bytes==right_bytes && left_bytes>512u);
            while(i<left_bytes && i<right_bytes && bytes[left+i]==bytes[right+i])++i;
            EXPECT(i>512u && i<left_bytes);return;}
        at+=size;}
    EXPECT(0);
}
int main(void)
{
    /* Window output is not a second emitter, and must never address bytes
     * outside its small borrow, even when the virtual stream is much longer. */
    pl_u8 window[18];memset(window,0xa5,sizeof window);
    wasm_writer writer={.bytes=window+1u,.capacity=800u,.window_start=513u,.window_bytes=16u};
    for(pl_u32 i=0u;i<800u;++i)wasm_writer_byte(&writer,i);
    EXPECT(!writer.error && writer.used==800u && window[0]==0xa5u && window[17]==0xa5u);
    for(pl_u32 i=0u;i<16u;++i)EXPECT(window[i+1u]==(pl_u8)(513u+i));
    wasm_writer_byte(&writer,0u);EXPECT(writer.error==WASM_COMPILER_ERROR_CAPACITY && writer.used==800u);

    memset(page,0x90,sizeof page);
    for(pl_u32 i=0u;i<COUNT;++i){pl_u32 at=64u+i*16u;page[at]=0xb8u;
        pl_write_u32(page+at+1u,i*31337u);page[at+5u]=0xc3u;
        options[i]=(wasm_cut_options){0x400000u+at,1u,8000u};}
    pl_x86_map map={page,0x400000u,4096u,4096u,PL_ELF_FLAG_EXECUTE,9u};
    pl_x86_image image={&map,1u,0u,map.address};pl_u64 bytes=77u;
    memset(output,0xa5,sizeof output);
    EXPECT(!wasm_compiler_emit_code_projection(&image,9u,options,COUNT,output,8000u,&bytes,reports));
    EXPECT(bytes==7646u && bodies(output,(pl_u32)bytes)==1u);
    for(pl_u32 i=(pl_u32)bytes;i<sizeof output;++i)EXPECT(output[i]==0xa5u);
    memcpy(reference,output,(size_t)bytes);
    for(pl_u32 i=0u;i<COUNT;++i)options[i].maximum_module_bytes=(pl_u32)bytes;
    EXPECT(!wasm_compiler_emit_code_projection(&image,9u,options,COUNT,output,bytes,&bytes,reports));
    EXPECT(bytes==7646u && !memcmp(reference,output,(size_t)bytes));
    /* Final capacity, declared cap and a late outside-image entry refuse before
     * target/report publication. There is no raw-size rejection shortcut. */
    for(pl_u32 kind=0u;kind<3u;++kind){
        memset(output,0xa5,sizeof output);memcpy(reference,output,sizeof output);
        memset(reports,0xa5,sizeof reports);memcpy(saved,reports,sizeof reports);bytes=77u;
        for(pl_u32 i=0u;i<COUNT;++i)options[i].maximum_module_bytes=kind==1u?7645u:8000u;
        // Admission grows; an advertised instruction is not a stable negative
        // fixture. Use an absent executable coordinate for late input failure.
        pl_u64 last_entry=options[COUNT-1u].entry;
        if(kind==2u)options[COUNT-1u].entry=map.address+map.memory_bytes;
        int status=wasm_compiler_emit_code_projection(&image,9u,options,COUNT,output,
            kind==0u?7645u:sizeof output,&bytes,reports);
        EXPECT(status==(kind==2u?WASM_COMPILER_ERROR_INPUT:WASM_COMPILER_ERROR_CAPACITY));
        EXPECT(bytes==77u && !memcmp(reference,output,sizeof output) && !memcmp(saved,reports,sizeof reports));
        options[COUNT-1u].entry=last_entry;
    }
    /* Six long bodies agree beyond the first comparison window, then split
     * on an immediate. Exact equality must examine the complete stream. */
    memset(page,0x90,sizeof page);
    for(pl_u32 i=0u;i<6u;++i){pl_u32 at=i*512u;
        for(pl_u32 j=0u;j<32u;++j){page[at+j*6u]=0x48u;page[at+j*6u+1u]=0x05u;
            pl_write_u32(page+at+j*6u+2u,j==31u?i%2u:1u);}
        page[at+192u]=0xc3u;options[i]=(wasm_cut_options){map.address+at,32u,sizeof output};}
    EXPECT(!wasm_compiler_emit_code_module(&image,9u,options,6u,output,sizeof output,&bytes,reports));
    EXPECT(bodies(output,(pl_u32)bytes)==2u);
    expect_late_difference(output,(pl_u32)bytes);
    /* Maximum-rank and odd-run boundaries, with both many equal groups and
     * 256 unequal embedded wide literals (which cannot use scalar binding). */
    const pl_u32 counts[]={1u,2u,3u,127u,129u,255u,256u};
    for(pl_u32 mode=0u;mode<2u;++mode){
        memset(page,0x90,sizeof page);
        for(pl_u32 i=0u;i<WASM_CUT_MODULE_MAX_FUNCTIONS;++i){pl_u32 at=i*16u;
            page[at]=0x48u;page[at+1u]=0xb8u;
            pl_write_u64(page+at+2u,0x1122334400000000ull+(mode?i:i%17u));page[at+10u]=0xc3u;
            options[i]=(wasm_cut_options){map.address+at,1u,sizeof output};}
        for(pl_u32 n=0u;n<sizeof counts/sizeof counts[0];++n){pl_u32 count=counts[n];
            EXPECT(!wasm_compiler_emit_code_module(&image,9u,options,count,output,sizeof output,&bytes,0));
            EXPECT(bodies(output,(pl_u32)bytes)==(mode || count<17u?count:17u));}
    }
    /* A decoder-call counter rejects replaying a growing pure body from its
     * beginning for every fixed window. Two exact duplicate long cuts need
     * linear source traversal; the emitter cursor resumes at ISA fragments. */
    pl_u64 traversals[2];
    for(pl_u32 n=0u;n<2u;++n){pl_u32 instructions=n?128u:16u;
        memset(page,0x90,sizeof page);
        for(pl_u32 i=0u;i<2u;++i){pl_u32 at=i*1536u;
            for(pl_u32 j=0u;j<instructions;++j){page[at+j*6u]=0x48u;page[at+j*6u+1u]=0x05u;
                pl_write_u32(page+at+j*6u+2u,1u);}
            options[i]=(wasm_cut_options){map.address+at,instructions,sizeof output};}
        decoder_calls=0u;
        EXPECT(!wasm_compiler_emit_code_module(&image,9u,options,2u,output,sizeof output,&bytes,0));
        EXPECT(bodies(output,(pl_u32)bytes)==1u);
        traversals[n]=decoder_calls;
        if(decoder_calls>16u*instructions+64u)fprintf(stderr,"growing-body replay: %llu decodes for %u instructions\n",
            (unsigned long long)decoder_calls,instructions);
        EXPECT(decoder_calls<=16u*instructions+64u);
    }
    /* 130 identical large FXSAVE transfers have a raw population above the
     * fixed 64 KiB cap; only their unique body is an output-size obligation. */
    memset(page,0x90,sizeof page);
    for(pl_u32 i=0u;i<COUNT;++i){pl_u32 at=64u+i*16u;
        const pl_u8 instruction[]={0x48u,0x0fu,0xaeu,0x07u};memcpy(page+at,instruction,sizeof instruction);
        options[i]=(wasm_cut_options){map.address+at,1u,sizeof output};}
    EXPECT(!wasm_compiler_emit_code_projection(&image,9u,options,COUNT,output,sizeof output,&bytes,reports));
    EXPECT(bodies(output,(pl_u32)bytes)==1u);
    if(failures)return 1;
    printf("Quotient cap: 30,614 raw bytes -> 7,646 at cap 8,000/exact cap; untouched failures/tail; late-window distinctions; FXSAVE %llu bytes; decoder traversals %llu / %llu for 16 / 128 instructions\n",
        (unsigned long long)bytes,(unsigned long long)traversals[0],(unsigned long long)traversals[1]);
    return 0;
}
