#include <wasm-compiler/image.h>
#include "../cli/io.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static pl_u8 output[65536],before[65536];
static unsigned failures;
#define EXPECT(x) do{if(!(x)){if(failures<8u)fprintf(stderr,"image stream: %u\n",(unsigned)__LINE__);++failures;}}while(0)
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    pl_u64 input_bytes=0u;pl_u8 *input=cli_read_file(argv[1],&input_bytes);if(!input)return 2;
    wasm_compiler compiler;wasm_coverage_report coverage;wasm_compile_options options={256u,65536u};
    wasm_image_plan plan,sentinel;wasm_image_iterator iterator;wasm_image_module info,old_info;
    EXPECT(!wasm_compiler_open(&compiler,input,input_bytes));EXPECT(!wasm_compiler_coverage(&compiler,&coverage));
    EXPECT(coverage.catalog.coordinates>256u && coverage.catalog.coordinates==coverage.lowerable);
    EXPECT(!wasm_compiler_prepare_image(&compiler,&options,&plan));
    EXPECT(plan.report.source_instructions==coverage.catalog.coordinates && plan.report.modules>1u);
    EXPECT(!wasm_image_iterator_open(&plan,&iterator));
    pl_u64 count=0u,coordinates=0u,bytes=0u,last=0u;
    while(1){int next=wasm_image_iterator_next(&iterator,output,sizeof output,&info);EXPECT(next>=0);if(next<=0)break;
        EXPECT(info.first>=last && info.end>info.first && info.end-info.first==info.code.source_instructions
            && info.code.modules==1u && info.code.dispatchers==1u && info.code.bytes<=plan.maximum_module_bytes);
        ++count;coordinates+=info.end-info.first;bytes+=info.code.bytes;last=info.end;
    }
    EXPECT(count==plan.report.modules && coordinates==plan.report.source_instructions && bytes==plan.report.bytes);
    old_info=info;EXPECT(!wasm_image_iterator_next(&iterator,output,sizeof output,&info) && !memcmp(&info,&old_info,sizeof info));
    EXPECT(!wasm_image_iterator_open(&plan,&iterator));
    wasm_image_iterator saved=iterator;memset(&info,0xa5,sizeof info);old_info=info;
    memset(output,0xa5,sizeof output);memcpy(before,output,sizeof output);
    EXPECT(wasm_image_iterator_next(&iterator,output,plan.maximum_module_bytes-1u,&info)==WASM_COMPILER_ERROR_CAPACITY);
    EXPECT(!memcmp(&iterator,&saved,sizeof saved) && !memcmp(&info,&old_info,sizeof info) && !memcmp(output,before,sizeof output));
    EXPECT(wasm_image_iterator_next(&iterator,(pl_u8 *)(void *)&iterator,sizeof iterator,&info)==WASM_COMPILER_ERROR_INPUT);
    EXPECT(!memcmp(&iterator,&saved,sizeof saved));
    memset(&sentinel,0xa5,sizeof sentinel);wasm_image_plan bad=sentinel;options.maximum_functions_per_module=1u;
    EXPECT(wasm_compiler_prepare_image(&compiler,&options,&bad)==WASM_COMPILER_ERROR_CAPACITY && !memcmp(&bad,&sentinel,sizeof bad));
    wasm_compiler reopened=compiler;compiler=(wasm_compiler){0};
    EXPECT(wasm_image_iterator_open(&plan,&iterator)==WASM_COMPILER_ERROR_INPUT);compiler=reopened;
    bad=plan;bad.input_digest[0]^=1u;
    EXPECT(wasm_image_iterator_open(&bad,&iterator)==WASM_COMPILER_ERROR_PROOF);
    free(input);if(failures)return 1;
    printf("Image stream: %llu final coordinates / %llu bounded modules / %llu bytes; complete preflight, exact completion and unchanged capacity/alias/reopen/digest controls\n",
        (unsigned long long)coordinates,(unsigned long long)count,(unsigned long long)bytes);return 0;
}
