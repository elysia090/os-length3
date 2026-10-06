#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <wasm-compiler/compiler.h>
#include "io.h"

int main(int argc, char **argv)
{
    unsigned char *input;
    pl_u64 input_bytes;
    wasm_compiler compiler;
    wasm_compile_options options = { 256u, 1u << 20u };
    pl_u64 output_bytes = 0u;
    int status;
    if(argc==3 && !strcmp(argv[1],"--coverage"))return cli_coverage(argv[2]);
    if (argc == 4 && !strcmp(argv[1],"--prefix"))
        return cli_prefix(argv[2],argv[3],0,0u,0u);
    if (argc == 6 && !strcmp(argv[1],"--code-pages")) {
        pl_u64 address, entry;
        if (cli_address(argv[2],&address) && cli_address(argv[3],&entry))
            return cli_prefix(argv[4],argv[5],1,address,entry);
    }
    if (argc != 3 || argv[1][0] == '-') {
        fprintf(stderr, "usage: wasm-compiler INPUT.elf OUTPUT.wasm\n"
                "       wasm-compiler --coverage INPUT.elf\n"
                "       wasm-compiler --prefix INPUT.elf OUTPUT-PREFIX\n"
                "       wasm-compiler --code-pages PAGE-ADDRESS ENTRY INPUT.pages OUTPUT-PREFIX\n"
                "prefix modes return 3 with an explicit non-closure diagnostic, not a bootable image\n");
        return 2;
    }
    input = cli_read_file(argv[1], &input_bytes);
    if (!input) {
        fprintf(stderr, "wasm-compiler: cannot read %s\n", argv[1]);
        return 1;
    }
    status = wasm_compiler_open(&compiler, input, input_bytes);
    if (!status)
        status = wasm_compiler_measure(&compiler, &options,
                                       &output_bytes, NULL);
    if (status) {
        if (status == WASM_COMPILER_ERROR_INCOMPLETE)
            fprintf(stderr,
                    "wasm-compiler: whole-image executable lowering is incomplete; "
                    "no module was published\n");
        fprintf(stderr, "wasm-compiler: refused input (%d)\n", status);
        free(input);
        return 1;
    }
    /* Keep the borrowed ELF live through emission, not just measurement. */
    unsigned char *output = output_bytes <= (size_t)-1 ? malloc((size_t)output_bytes) : NULL;
    if (!output) { free(input); return 1; }
    pl_u64 written = 0u;
    status = wasm_compiler_emit(&compiler,&options,output,output_bytes,&written,NULL);
    if (!status && written != output_bytes) status = WASM_COMPILER_ERROR_INCOMPLETE;
    if (!status) {
        FILE *file = fopen(argv[2],"wbx");
        if (!file) status = WASM_COMPILER_ERROR_INPUT;
        else {
            int okay = fwrite(output,1u,(size_t)written,file) == (size_t)written;
            if (fclose(file)) okay = 0;
            if (!okay) { remove(argv[2]); status = WASM_COMPILER_ERROR_INPUT; }
        }
    }
    free(output); free(input);
    return status ? 1 : 0;
}
