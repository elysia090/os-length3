#ifndef WASM_COMPILER_CLI_IO_H
#define WASM_COMPILER_CLI_IO_H
#include <wasm-compiler/cut.h>
#include <stdio.h>

pl_u8 *cli_read_file(const char *path, pl_u64 *bytes);
int cli_address(const char *text, pl_u64 *address);
int cli_coverage(const char *input_path);
int cli_directory(const char *input_path,const char *output_directory);
int cli_prefix(const char *input_path, const char *prefix, int pages,
                pl_u64 page_address, pl_u64 entry);
#endif
