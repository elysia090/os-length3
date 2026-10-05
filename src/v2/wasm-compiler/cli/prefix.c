/* Construction-time prefix compilation. No compiled prefix is a closed image. */
#include "io.h"
#include <stdlib.h>
#include <string.h>

enum { MAX_MODULES = 256, MAX_MODULE_BYTES = 1048576, PATH_BYTES = 4096 };

static int path(char *target, const char *prefix, pl_u32 rank, const char *suffix)
{
    int n = rank ? snprintf(target, PATH_BYTES, "%s.%u.%s", prefix, rank, suffix)
                 : snprintf(target, PATH_BYTES, "%s.%s", prefix, suffix);
    return n > 0 && n < PATH_BYTES;
}

static int record(const char *name, const void *bytes, size_t count)
{
    FILE *file = fopen(name, "wbx");
    if (!file) return 0;
    int okay = fwrite(bytes, 1u, count, file) == count;
    if (fclose(file)) okay = 0;
    /* This path was exclusively created here. Never remove an existing file. */
    if (!okay) remove(name);
    return okay;
}

static void rollback(const char *prefix, pl_u32 modules)
{
    char name[PATH_BYTES];
    for (pl_u32 i = 0u; i < modules; ++i) {
        if (path(name, prefix, i, "wasm")) remove(name);
        if (path(name, prefix, i, "json")) remove(name);
    }
}

int cli_prefix(const char *input_path, const char *prefix, int pages,
                pl_u64 page_address, pl_u64 entry)
{
    pl_u64 input_bytes = 0u;
    pl_u8 *input = cli_read_file(input_path, &input_bytes);
    pl_u8 *output = NULL;
    wasm_compiler compiler = {0};
    pl_x86_map maps[2];
    pl_x86_image source = {0};
    pl_elf_image elf;
    pl_x86_map elf_maps[64];
    char name[PATH_BYTES], summary[PATH_BYTES];
    pl_u32 modules = 0u;
    pl_u64 instructions = 0u, emitted_bytes = 0u;
    pl_u64 stop_address = 0u;
    int status = WASM_COMPILER_ERROR_INPUT;
    const char *stop = "unlowered";
    FILE *manifest = NULL;
    if (!input) goto failure;
    if (pages) {
        if ((page_address & 4095u) || (input_bytes != 4096u && input_bytes != 8192u)
                || page_address > ~0ull - input_bytes) goto failure;
        for (pl_u32 i = 0u; i < input_bytes / 4096u; ++i)
            maps[i] = (pl_x86_map){input + i * 4096u, page_address + (pl_u64)i * 4096u,
                                   4096u,4096u,PL_ELF_FLAG_EXECUTE,1u};
        source = (pl_x86_image){maps,(pl_u32)(input_bytes / 4096u),0u,entry};
    } else {
        status = wasm_compiler_open(&compiler,input,input_bytes);
        if (status) goto failure;
        entry = compiler.image.entry;
        if (pl_elf_open(input,input_bytes,&elf)
                || pl_x86_image_from_elf(&elf,0u,1u,elf_maps,64u,&source)) {
            status = WASM_COMPILER_ERROR_INPUT; goto failure;
        }
    }
    if (!path(summary,prefix,0u,"summary.json")) goto failure;
    /* Exclusive create also prevents overwriting the input via a path alias. */
    manifest = fopen(summary,"wbx");
    if (!manifest) goto failure;
    if (fprintf(manifest,"{\"format\":\"compiled-x86-prefix-v1\",\"closed\":false,"
            "\"linuxBoot\":\"not-tested\",\"sourceKind\":\"%s\",\"entry\":\"%llu\",\"cuts\":[",
            pages ? "resident-code-pages" : "optimized-elf",entry) < 0) goto failure;
    output = malloc(MAX_MODULE_BYTES);
    if (!output) goto failure;
    wasm_cut_options options = {entry,WASM_CUT_MAX_INSTRUCTIONS,MAX_MODULE_BYTES};
    for (; modules < MAX_MODULES;) {
        if (!pl_x86_image_contains(&source,options.entry)) {
            if (!modules) { status = WASM_COMPILER_ERROR_INPUT; goto failure; }
            stop = "source-end"; status = WASM_COMPILER_ERROR_INCOMPLETE; break;
        }
        wasm_cut_report report;
        pl_u64 bytes = 0u;
        status = pages ? wasm_compiler_emit_code_cut(&source,1u,&options,output,MAX_MODULE_BYTES,&bytes,&report)
                       : wasm_compiler_emit_cut(&compiler,&options,output,MAX_MODULE_BYTES,&bytes,&report);
        if (status) {
            if (status != WASM_COMPILER_ERROR_GRAMMAR) goto failure;
            break;
        }
        char json[768];
        int n = snprintf(json,sizeof json,
                "{\"operandBinding\":%u,\"entry\":\"%llu\",\"continuation\":\"%llu\",\"branchTarget\":\"%llu\","
                "\"sourceBytes\":%llu,\"instructions\":%llu,\"boundary\":%u,"
                "\"moduleBytes\":%llu,\"closed\":false}\n",
                report.operand_binding,report.entry,report.continuation,report.branch_target,report.source_bytes,
                report.source_instructions,report.boundary,bytes);
        if (n <= 0 || (size_t)n >= sizeof json || !path(name,prefix,modules,"wasm")
                || !record(name,output,(size_t)bytes)) goto failure;
        if (!path(name,prefix,modules,"json") || !record(name,json,(size_t)n)) {
            if (path(name,prefix,modules,"wasm")) remove(name);
            goto failure;
        }
        ++modules;
        if (fprintf(manifest,"%s{\"rank\":%u,\"entry\":\"%llu\",\"continuation\":\"%llu\","
                "\"sourceBytes\":%llu,\"instructions\":%llu,\"moduleBytes\":%llu,\"operandBinding\":%u}",
                modules == 1u ? "" : ",",modules - 1u,report.entry,report.continuation,
                report.source_bytes,report.source_instructions,bytes,report.operand_binding) < 0) goto failure;
        instructions += report.source_instructions; emitted_bytes += bytes;
        options.entry = report.continuation;
        /* A transfer's fallthrough is not an execution trace. Do not guess
         * branch outcomes, CALL/RET targets or newly modified source pages. */
        if (report.boundary == WASM_CUT_CONTROL) {
            stop_address = report.entry;
            stop = "control"; status = WASM_COMPILER_ERROR_INCOMPLETE; break;
        }
    }
    if (modules == MAX_MODULES && !status) { stop = "budget"; status = WASM_COMPILER_ERROR_CAPACITY; }
    if (strcmp(stop,"control")) stop_address = options.entry;
    pl_x86_instruction instruction = {0};
    int decoded = !pl_x86_decode(&source,stop_address,&instruction);
    if (fprintf(manifest,"],\"modules\":%u,\"instructions\":%llu,\"moduleBytes\":%llu,"
            "\"stop\":{\"kind\":\"%s\",\"entry\":\"%llu\",\"linearContinuation\":\"%llu\",\"status\":%d,"
            "\"decoded\":%s,\"operation\":%u,\"machineOperation\":%u,\"flow\":%u}}\n",
            modules,instructions,emitted_bytes,stop,stop_address,options.entry,status,
            decoded ? "true" : "false",instruction.operation,instruction.machine_operation,instruction.flow) < 0)
        goto failure;
    if (fclose(manifest)) { manifest = NULL; remove(summary); goto failure; }
    manifest = NULL;
    printf("wasm-compiler: prefix modules=%u instructions=%llu bytes=%llu; %s at 0x%llx (%d); image NOT closed\n",
            modules,instructions,emitted_bytes,stop,stop_address,status);
    free(output); free(input);
    /* Deliberately distinct from successful whole-image publication. */
    return 3;
failure:
    if (!status) status = WASM_COMPILER_ERROR_INPUT;
    if (manifest) { fclose(manifest); remove(summary); }
    rollback(prefix,modules);
    free(output); free(input);
    fprintf(stderr,"wasm-compiler: prefix construction failed (%d); no new prefix retained\n",status);
    return 1;
}
