#include "../../src/v2/wasm-compiler/src/cut-internal.h"
#include <stdio.h>
#include <stdlib.h>
/* Diagnostic traversal of the product's complete PF_X domain. It does not
 * change acceptance, publish modules or execute a guest instruction. */
static int visit(const pl_x86_instruction *i,void *context)
{
    const pl_x86_image *image=context;cut_plan plan;wasm_cut_options options={i->rip,1u,65536u};
    int status=cut_prepare_image(image,&options,&plan);
    if(!status){wasm_writer writer={.capacity=~0ull};wasm_cut_report report;pl_u32 imports=0u;
        status=cut_measure_body(&writer,&plan,&report,&imports);}
    if(!status)return 0;
    printf("%llx status=%d op=%u machine=%u argument=%llx flow=%u width=%u address=%u flags=%x source=",
        (unsigned long long)i->rip,status,i->operation,i->machine_operation,(unsigned long long)i->machine_argument,
        i->flow,i->operand_width,i->address_width,i->flags);
    for(pl_u32 b=0u;b<i->source_bytes;++b)printf("%02x",i->source[b]);
    if(i->operation==PL_X86_OPERATION_TRANSLATE_BYTE)for(pl_u32 n=0u;n<i->operand_count;++n){const pl_x86_operand *o=i->operands+n;
        printf(" operand=%u:%u:%u",o->kind,o->bits,o->flags);
        if(o->kind==PL_X86_OPERAND_MEMORY){const pl_x86_memory *m=&o->value.memory;
            printf(" memory=%u:%u,%u:%u:%u,%u:%u:%u,%u,%lld",m->segment.class_id,m->segment.index,m->base.class_id,m->base.index,m->base.bits,
                m->index.class_id,m->index.index,m->index.bits,m->scale,(long long)m->displacement);}}
    putchar('\n');return 0;
}
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    FILE *file=fopen(argv[1],"rb");if(!file)return 2;
    if(fseek(file,0,SEEK_END)){fclose(file);return 2;}
    long size=ftell(file);if(size<1||fseek(file,0,SEEK_SET)){fclose(file);return 2;}
    pl_u8 *bytes=malloc((size_t)size);if(!bytes){fclose(file);return 2;}
    int status=fread(bytes,1u,(size_t)size,file)!=(size_t)size;if(fclose(file))status=1;
    pl_elf_image elf;pl_x86_map maps[64];pl_x86_image image;pl_x86_catalog catalog;
    if(!status)status=pl_elf_open(bytes,(pl_u64)size,&elf);
    if(!status)status=pl_x86_image_from_elf(&elf,0u,1u,maps,64u,&image);
    if(!status)status=pl_x86_catalog_profile(&image,visit,&image,&catalog);
    free(bytes);return status?1:0;
}
