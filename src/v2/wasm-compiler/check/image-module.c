#include <wasm-compiler/compiler.h>
#include <vm/module.h>
#include "../cli/io.h"
#include <support/checked.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static pl_u8 output[65536],saved[65536];static unsigned failures;
#define EXPECT(x) do{if(!(x)){if(failures<8u)fprintf(stderr,"image metadata: %u\n",(unsigned)__LINE__);++failures;}}while(0)
static void refused(pl_u32 bytes,const vm_image_module *sentinel)
{
    vm_image_module out=*sentinel;
    EXPECT(vm_image_module_open(output,bytes,&out)<0 && !memcmp(&out,sentinel,sizeof out));
}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    pl_u64 input_bytes=0u;pl_u8 *input=cli_read_file(argv[1],&input_bytes);if(!input)return 2;
    wasm_compiler compiler;wasm_compile_options options={256u,sizeof output};wasm_compile_report report;pl_u64 bytes=0u;
    EXPECT(!wasm_compiler_open(&compiler,input,input_bytes));
    EXPECT(!wasm_compiler_emit(&compiler,&options,output,sizeof output,&bytes,&report));
    vm_image_module module,sentinel;EXPECT(!vm_image_module_open(output,(pl_u32)bytes,&module));
    EXPECT(module.count==report.source_instructions && module.code_bytes<bytes && !memcmp(module.digest,compiler.input_digest,32));
    pl_u32 source=0u,rank=0u;
    for(pl_u32 i=0u;i<module.range_count;++i){const pl_u8 *range=module.ranges+i*MACHINE_IMAGE_RANGE_BYTES;
        pl_u64 first=pl_read_u64(range);pl_u32 n=pl_read_u16(range+8u),w=pl_read_u16(range+10u);
        for(pl_u32 j=0u;j<n;++j){vm_module_entry selected;
            EXPECT(!vm_image_module_find(&module,first+j,1u,&selected));
            EXPECT(selected.source_offset==source+j && selected.source_instructions==1u && selected.source_bytes<=15u && !selected.operand_binding);
            ++rank;}
        source+=w;
    }
    EXPECT(rank==module.count && source==module.witness_bytes);
    memset(&sentinel,0xa5,sizeof sentinel);
    for(pl_u32 n=0u;n<(pl_u32)bytes;++n){vm_image_module out=sentinel;
        EXPECT(vm_image_module_open(output,n,&out)<0 && !memcmp(&out,&sentinel,sizeof out));}
    memcpy(saved,output,(size_t)bytes);pl_u32 header=(pl_u32)(module.digest-output)-32u;
    const pl_u32 positions[]={0u,4u,8u,12u,16u,20u,24u,28u};
    for(pl_u32 i=0u;i<sizeof positions/sizeof positions[0];++i){
        memcpy(output,saved,(size_t)bytes);pl_write_u32(output+header+positions[i],~0u);vm_image_module out=sentinel;
        EXPECT(vm_image_module_open(output,(pl_u32)bytes,&out)<0 && !memcmp(&out,&sentinel,sizeof out));}
    memcpy(output,saved,(size_t)bytes);EXPECT(!vm_image_module_open(output,(pl_u32)bytes,&module));
    pl_u32 packed=(pl_u32)(module.lengths-output);output[packed]|=15u;vm_image_module out=sentinel;
    EXPECT(vm_image_module_open(output,(pl_u32)bytes,&out)<0 && !memcmp(&out,&sentinel,sizeof out));
    pl_u32 range=(pl_u32)(module.ranges-output);
    memcpy(output,saved,(size_t)bytes);pl_write_u16(output+range+8u,0u);refused((pl_u32)bytes,&sentinel);
    memcpy(output,saved,(size_t)bytes);pl_write_u16(output+range+10u,0u);refused((pl_u32)bytes,&sentinel);
    memcpy(output,saved,(size_t)bytes);pl_write_u32(output+range+12u,1u);refused((pl_u32)bytes,&sentinel);
    memcpy(output,saved,(size_t)bytes);pl_write_u64(output+range,~0ull);refused((pl_u32)bytes,&sentinel);
    if(module.count&1u){memcpy(output,saved,(size_t)bytes);output[packed+module.count/2u]|=0x10u;refused((pl_u32)bytes,&sentinel);}
    // Append an unused suffix while keeping section/layout extents valid.
    // Its presence must not create a second spelling of the same module.
    pl_u32 length_at=module.code_bytes+1u,length_end=length_at,payload=0u,shift=0u;
    do{payload|=(pl_u32)(saved[length_end]&127u)<<shift;shift+=7u;}while(saved[length_end++]&128u);
    pl_u32 expanded=payload+1u,width=1u;for(pl_u32 rest=expanded>>7u;rest;rest>>=7u)++width;
    EXPECT(width==length_end-length_at && bytes<sizeof output);
    if(width==length_end-length_at && bytes<sizeof output){
        memcpy(output,saved,(size_t)bytes);output[bytes]=0u;
        for(pl_u32 i=0u;i<width;++i){output[length_at+i]=(pl_u8)(expanded&127u);expanded>>=7u;
            if(i+1u<width)output[length_at+i]|=128u;}
        pl_u32 last=range+(module.range_count-1u)*MACHINE_IMAGE_RANGE_BYTES;
        pl_write_u16(output+last+10u,(pl_u16)(pl_read_u16(output+last+10u)+1u));
        pl_write_u32(output+header+20u,module.witness_bytes+1u);refused((pl_u32)bytes+1u,&sentinel);
    }
    if(module.range_count>1u){memcpy(output,saved,(size_t)bytes);
        pl_write_u64(output+range+MACHINE_IMAGE_RANGE_BYTES,pl_read_u64(output+range)+pl_read_u16(output+range+8u));
        refused((pl_u32)bytes,&sentinel);}
    memcpy(output,saved,(size_t)bytes);EXPECT(!vm_image_module_open(output,(pl_u32)bytes,&module));
    vm_module_entry before,entry;memset(&before,0xa5,sizeof before);entry=before;
    EXPECT(vm_image_module_find(&module,pl_read_u64(module.ranges),1024u,&entry)==VM_MODULE_ERROR_SOURCE
        && !memcmp(&entry,&before,sizeof entry));
    entry=before;EXPECT(vm_image_module_find(&module,pl_read_u64(module.ranges)-1u,1u,&entry)==VM_MODULE_ERROR_ABSENT
        && !memcmp(&entry,&before,sizeof entry));
    free(input);if(failures)return 1;
    printf("Image metadata: %u exact coordinates, %llu unchanged truncation refusals, malformed ABI/range/span/padding/nonminimal witness and budget; no ISA parser\n",
        rank,(unsigned long long)bytes);return 0;
}
