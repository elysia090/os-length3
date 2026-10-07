#include <wasm-compiler/compiler.h>
#include "../cli/io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static pl_u8 output[65536],before[65536];
static unsigned failures;
#define EXPECT(x) do{if(!(x)){if(failures<8u)fprintf(stderr,"image: %u\n",(unsigned)__LINE__);++failures;}}while(0)
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    pl_u64 input_bytes=0u;pl_u8 *input=cli_read_file(argv[1],&input_bytes);if(!input)return 2;
    wasm_compiler compiler;wasm_coverage_report coverage;wasm_compile_options options={256u,sizeof output};
    wasm_compile_report measured,emitted,sentinel;pl_u64 bytes=0u,written=77u;
    EXPECT(!wasm_compiler_open(&compiler,input,input_bytes));
    EXPECT(!wasm_compiler_coverage(&compiler,&coverage));
    EXPECT(coverage.catalog.coordinates>1u && coverage.catalog.coordinates==coverage.lowerable);
    EXPECT(!wasm_compiler_measure(&compiler,&options,&bytes,&measured));
    EXPECT(measured.dispatchers==1u && measured.modules==1u && measured.functions>0u
        && measured.source_instructions==coverage.catalog.coordinates && measured.bytes==bytes);
    memset(output,0xa5,sizeof output);
    EXPECT(!wasm_compiler_emit(&compiler,&options,output,sizeof output,&written,&emitted));
    EXPECT(written==bytes && !memcmp(&measured,&emitted,sizeof measured));
    for(pl_u64 i=bytes;i<sizeof output;++i)EXPECT(output[i]==0xa5u);
    memset(&sentinel,0xa5,sizeof sentinel);
    for(pl_u32 kind=0u;kind<5u;++kind){
        memset(output,0xa5,sizeof output);memcpy(before,output,sizeof output);emitted=sentinel;written=77u;
        wasm_compile_options bounded=options;pl_u64 capacity=sizeof output;
        if(kind==0u)capacity=bytes-1u;
        if(kind==1u)bounded.maximum_module_bytes=(pl_u32)bytes-1u;
        if(kind==2u)bounded.maximum_functions_per_module=(pl_u32)measured.functions;
        int status=wasm_compiler_emit(&compiler,&bounded,kind==3u?input:output,capacity,
            kind==4u?&emitted.bytes:&written,&emitted);
        EXPECT(status==(kind<3u?WASM_COMPILER_ERROR_CAPACITY:WASM_COMPILER_ERROR_INPUT));
        EXPECT(written==77u && !memcmp(output,before,sizeof output) && !memcmp(&emitted,&sentinel,sizeof emitted));
    }
    free(input);if(failures)return 1;
    printf("Image: every %llu final PF_X coordinate / %llu bodies / one dispatcher / %llu bytes; five unchanged refusals; not Linux\n",
        (unsigned long long)coverage.catalog.coordinates,(unsigned long long)measured.functions,(unsigned long long)bytes);
    return 0;
}
