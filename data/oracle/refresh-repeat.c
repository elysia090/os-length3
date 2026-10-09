/* Re-emit only the C-produced modules of a copied independent CPU fixture.
 * Hardware records, source pages and expected CPU/RAM observations are inputs. */
#include <wasm-compiler/cut.h>
#include <stdio.h>
#include <string.h>
static pl_u8 page[4096],module[65536];
int main(int argc,char **argv)
{
    if(argc!=2)return 2;
    for(pl_u32 family=0u;family<2u;++family)for(pl_u32 width=8u;width<=64u;width*=2u)
    for(pl_u32 address=32u;address<=64u;address*=2u){char file[4096];
        int n=snprintf(file,sizeof file,"%s/%s-%u-%u.source-page",argv[1],family?"stos":"repeat",width,address);
        if(n<1||(size_t)n>=sizeof file)return 2;
        FILE *input=fopen(file,"rb");if(!input)return 1;
        size_t count=fread(page,1u,sizeof page,input);int extra=fgetc(input);fclose(input);
        if(count!=sizeof page||extra!=EOF)return 1;
        pl_x86_map map={page,0x400000u,sizeof page,sizeof page,PL_ELF_FLAG_EXECUTE,9u};
        pl_x86_image source={&map,1u,0u,0x400000u};wasm_cut_options options={source.entry,8u,sizeof module};
        wasm_cut_report report;pl_u64 bytes;
        if(wasm_compiler_emit_code_cut(&source,9u,&options,module,sizeof module,&bytes,&report)
            ||report.source_instructions!=1u)return 1;
        n=snprintf(file,sizeof file,"%s/%s-%u-%u.wasm",argv[1],family?"stos":"repeat",width,address);
        if(n<1||(size_t)n>=sizeof file)return 2;
        FILE *out=fopen(file,"wb");if(!out)return 1;
        int failed=fwrite(module,1u,(size_t)bytes,out)!=(size_t)bytes;if(fclose(out))failed=1;if(failed)return 1;
    }
    puts("16 modules emitted by native C; independent CPU inputs unchanged");return 0;
}
