#include <wasm-compiler/cut.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static pl_u8 pages[8192], saved[8192], output[65536];
static int failures;
#define EXPECT(x) do { if (!(x)) { fprintf(stderr, "code-cut: line %u\n", (unsigned)__LINE__); ++failures; } } while (0)
static int write_record(const char *prefix, const char *suffix, const void *bytes, size_t count)
{
    char path[4096];
    int n = snprintf(path, sizeof path, "%s.%s", prefix, suffix);
    if (n <= 0 || (size_t)n >= sizeof path) return -1;
    FILE *file = fopen(path, "wbx");
    if (!file) return -1;
    int status = fwrite(bytes, 1u, count, file) == count ? 0 : -1;
    if (fclose(file)) status = -1;
    return status;
}
int main(int argc, char **argv)
{
    if (argc != 1 && argc != 2 && argc != 4) return 2;
    pl_x86_map maps[2] = {
        {pages, 0x400000u, 4096u, 4096u, PL_ELF_FLAG_EXECUTE, 9u},
        {pages + 4096u, 0x401000u, 4096u, 4096u, PL_ELF_FLAG_EXECUTE, 9u},
    };
    pl_x86_image source = { maps, 1u, 0u, 0x400000u };
    wasm_cut_options options = { source.entry, 1024u, sizeof output };
    wasm_cut_report report;
    pl_u64 bytes = 0u;
    memset(pages, 0x90, sizeof pages); pages[0] = 0xfcu; pages[1] = 0xfau;
    EXPECT(!wasm_compiler_measure_code_cut(&source, 9u, &options, &bytes, &report));
    EXPECT(report.source_bytes == 1u && report.source_instructions == 1u);
    EXPECT(report.continuation == source.entry + 1u && report.boundary == WASM_CUT_SYSTEM);
    memcpy(saved, pages, sizeof pages);
    EXPECT(wasm_compiler_measure_code_cut(&source, 9u, &options, &maps[0].generation, 0)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(maps[0].generation == 9u);
    pages[0] = 0x8eu; pages[1] = 0xd8u; /* MOV DS,AX: precise C segment boundary. */
    EXPECT(!wasm_compiler_measure_code_cut(&source,9u,&options,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.source_bytes == 2u && report.boundary == WASM_CUT_SYSTEM);
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    pages[0] = 0xfcu; pages[1] = 0xfau;
    /* Typed descriptor transfers are barrier flow, not ordinary NEXT flow. */
    for (pl_u32 rank = 0u; rank < 4u; ++rank) {
        pages[0] = 0x0fu; pages[1] = 0x01u; pages[2] = (pl_u8)(0x10u + rank * 8u);
        int status = wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        if (rank < 2u) EXPECT(!status && report.source_bytes == 3u
            && report.source_instructions == 1u && report.boundary == WASM_CUT_SYSTEM);
        else EXPECT(status == WASM_COMPILER_ERROR_GRAMMAR); /* Non-table-load encodings. */
    }
    pages[0] = 0xfcu; pages[1] = 0xfau;
    for (pl_u32 rank = 0u; rank < 6u; ++rank)
    for (pl_u32 reg = 0u; reg < 16u; ++reg) {
        pl_u32 at = reg >= 8u ? 1u : 0u;
        pages[0] = 0x41u; pages[at] = 0x8eu;
        pages[at + 1u] = (pl_u8)(0xc0u | (rank << 3u) | (reg & 7u));
        int status = wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        if (rank == 1u) EXPECT(status == WASM_COMPILER_ERROR_GRAMMAR);
        else {
            EXPECT(!status && report.source_bytes == at + 2u && report.source_instructions == 1u);
            EXPECT(report.read_registers == (1u << reg) && !report.written_registers && !report.flags_written);
        }
    }
    pages[0] = 0x48u; pages[1] = 0xcbu;
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.source_bytes == 2u && report.boundary == WASM_CUT_CONTROL);
    pages[0] = 0xcbu;
    EXPECT(wasm_compiler_measure_code_cut(&source,9u,&options,&bytes,&report) == WASM_COMPILER_ERROR_GRAMMAR);
    /* Every long-mode control source and destination GPR shares one lowering.
     * No privileged hardware instruction is executed by this fixture tool. */
    static const pl_u32 controls[] = {0u,2u,3u,4u,8u};
    for (pl_u32 rank = 0u; rank < sizeof controls / sizeof controls[0]; ++rank)
    for (pl_u32 reg = 0u; reg < 16u; ++reg) {
        pl_u32 control = controls[rank], rex = (control == 8u ? 4u : 0u) | (reg >= 8u ? 1u : 0u);
        pl_u32 at = rex ? 1u : 0u;
        pages[0] = (pl_u8)(0x40u | rex); pages[at] = 0x0fu; pages[at + 1u] = 0x20u;
        pages[at + 2u] = (pl_u8)(0xc0u | ((control & 7u) << 3u) | (reg & 7u));
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions == 1u && report.source_bytes == at + 3u
            && report.boundary == WASM_CUT_SYSTEM && report.written_registers == (1u << reg)
            && !report.read_registers && !report.flags_written);
        if (argc == 2 && !failures) {
            char prefix[4096], json[256];
            int n = snprintf(prefix,sizeof prefix,"%s/control-%u-%u",argv[1],control,reg);
            if (n <= 0 || (size_t)n >= sizeof prefix) return 1;
            n = snprintf(json,sizeof json,
                "{\"entry\":\"4194304\",\"control\":%u,\"reg\":%u,\"sourceBytes\":%u}\n",control,reg,at + 3u);
            if (n <= 0 || (size_t)n >= sizeof json || write_record(prefix,"json",json,(size_t)n)
                    || write_record(prefix,"wasm",output,(size_t)bytes)
                    || write_record(prefix,"source-page",pages,4096u)) return 1;
        }
        pages[at + 1u] = 0x22u;
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions == 1u && report.source_bytes == at + 3u
            && report.boundary == WASM_CUT_SYSTEM && report.read_registers == (1u << reg)
            && !report.written_registers && !report.flags_written);
        if (argc == 2 && !failures) {
            char prefix[4096], json[256];
            int n = snprintf(prefix,sizeof prefix,"%s/control-write-%u-%u",argv[1],control,reg);
            if (n <= 0 || (size_t)n >= sizeof prefix) return 1;
            n = snprintf(json,sizeof json,
                "{\"entry\":\"4194304\",\"control\":%u,\"reg\":%u,\"sourceBytes\":%u}\n",control,reg,at + 3u);
            if (n <= 0 || (size_t)n >= sizeof json || write_record(prefix,"json",json,(size_t)n)
                    || write_record(prefix,"wasm",output,(size_t)bytes)
                    || write_record(prefix,"source-page",pages,4096u)) return 1;
        }
    }
    pages[0] = 0x0fu; pages[1] = 0xa2u; /* CPUID: frozen profile, no host callback. */
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.source_bytes == 2u
        && report.boundary == WASM_CUT_SYSTEM && report.read_registers == 1u
        && report.written_registers == 15u && !report.flags_written && !report.memory_bytes);
    if (argc == 2 && !failures) {
        char prefix[4096];
        int n = snprintf(prefix,sizeof prefix,"%s/cpuid",argv[1]);
        static const char json[] = "{\"entry\":\"4194304\",\"sourceBytes\":2,\"instructions\":1}\n";
        if (n <= 0 || (size_t)n >= sizeof prefix || write_record(prefix,"json",json,sizeof json - 1u)
            || write_record(prefix,"wasm",output,(size_t)bytes)
            || write_record(prefix,"source-page",pages,4096u)) return 1;
    }
    pages[0] = 0xf0u; pages[1] = 0x0fu; pages[2] = 0xa2u;
    EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
           == WASM_COMPILER_ERROR_GRAMMAR); /* LOCK CPUID is not a valid transfer. */
    for (pl_u32 rank = 0u; rank < 4u; ++rank) {
        static const char *const names[] = {"pushfq", "popfq", "pushf", "popf"};
        pl_u32 at = rank >= 2u ? 1u : 0u;
        pages[0] = 0x66u; pages[at] = (pl_u8)(0x9cu + (rank & 1u)); pages[at + 1u] = 0x90u;
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions == 1u && report.source_bytes == at + 1u
            && report.memory_bytes == (at ? 2u : 8u) && report.read_registers == 16u
            && report.written_registers == 16u && report.flags_written == (rank & 1u));
        if (argc == 2 && !failures) {
            char prefix[4096], json[128];
            int n = snprintf(prefix,sizeof prefix,"%s/%s",argv[1],names[rank]);
            int j = snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"instructions\":1}\n",at + 1u);
            if (n <= 0 || (size_t)n >= sizeof prefix || j <= 0 || (size_t)j >= sizeof json
                || write_record(prefix,"json",json,(size_t)j) || write_record(prefix,"wasm",output,(size_t)bytes)
                || write_record(prefix,"source-page",pages,4096u)) return 1;
        }
        pages[0] = 0xf0u; pages[1] = (pl_u8)(0x9cu + (rank & 1u));
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
               == WASM_COMPILER_ERROR_GRAMMAR);
    }
    pages[0] = 0xfcu; pages[1] = 0xfau; pages[2] = 0x90u;
    pages[3] = 0x90u;
    EXPECT(wasm_compiler_measure_code_cut(&source, 9u, &options, &options.entry, 0)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(options.entry == source.entry);
    EXPECT(wasm_compiler_measure_code_cut(&source, 9u, &options, &bytes,
                                        (wasm_cut_report *)(void *)pages) == WASM_COMPILER_ERROR_INPUT);
    EXPECT(!memcmp(saved, pages, sizeof pages));
    EXPECT(wasm_compiler_emit_code_cut(&source, 9u, &options, pages, sizeof pages, &bytes, 0)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(!memcmp(saved, pages, sizeof pages));
    EXPECT(wasm_compiler_emit_code_cut(&source, 9u, &options, output, sizeof output,
                                     &maps[0].generation, 0) == WASM_COMPILER_ERROR_INPUT);
    EXPECT(maps[0].generation == 9u);
    bytes = 99u;
    EXPECT(wasm_compiler_measure_code_cut(&source, 8u, &options, &bytes, 0) == WASM_COMPILER_ERROR_INPUT);
    EXPECT(bytes == 99u);
    maps[0].file_bytes = 4095u;
    EXPECT(wasm_compiler_measure_code_cut(&source, 9u, &options, &bytes, 0) == WASM_COMPILER_ERROR_INPUT);
    maps[0].file_bytes = 4096u;
    // No implicit executable zero-fill; no speculative fetch past the prefix.
    source.entry = options.entry = 0x400ffeu;
    pages[4094] = 0xfcu; pages[4095] = 0x48u; pages[4096] = 0xb8u;
    EXPECT(!wasm_compiler_measure_code_cut(&source, 9u, &options, &bytes, &report));
    EXPECT(report.source_bytes == 1u && report.source_instructions == 1u);
    source.map_count = 2u;
    for (pl_u32 i = 4097u; i < 4105u; ++i) pages[i] = (pl_u8)i;
    pages[4105] = 0xfau;
    EXPECT(!wasm_compiler_measure_code_cut(&source, 9u, &options, &bytes, &report));
    EXPECT(report.source_bytes == 1u && report.source_instructions == 1u);
    options.entry = 0x400fffu;
    EXPECT(!wasm_compiler_measure_code_cut(&source, 9u, &options, &bytes, &report));
    EXPECT(report.source_bytes == 10u && report.source_instructions == 1u);
    EXPECT(report.continuation == 0x401009u);
    maps[1].generation = 8u; bytes = 99u;
    EXPECT(wasm_compiler_measure_code_cut(&source, 9u, &options, &bytes, 0) == WASM_COMPILER_ERROR_INPUT);
    EXPECT(bytes == 99u);
    if (failures) return 1;
    if (argc == 4) {
        char *end = 0;
        pl_u64 entry = strtoull(argv[2], &end, 0);
        if (!end || !*argv[2] || *end) return 2;
        FILE *file = fopen(argv[1], "rb");
        if (!file) return 1;
        int status = fread(pages, 1u, 4096u, file) != 4096u || fgetc(file) != EOF;
        if (fclose(file)) status = 1;
        if (status) return 1;
        maps[0].address = entry & ~4095ull; source.map_count = 1u;
        source.entry = options.entry = entry;
        if (wasm_compiler_emit_code_cut(&source, 9u, &options, output, sizeof output, &bytes, &report)) return 1;
        char json[512];
        int n = snprintf(json, sizeof json,
            "{\"entry\":\"%llu\",\"continuation\":\"%llu\",\"sourceBytes\":%llu,"
            "\"instructions\":%llu,\"boundary\":%u,\"moduleBytes\":%llu}\n",
            report.entry, report.continuation, report.source_bytes, report.source_instructions,
            report.boundary, report.module_bytes);
        if (n <= 0 || (size_t)n >= sizeof json || write_record(argv[3], "json", json, (size_t)n)
                || write_record(argv[3], "wasm", output, (size_t)bytes)) return 1;
        // Sequential compile admission only. Never execute/interpret opcodes.
        for (pl_u32 i = 1u; i < 16u; ++i) {
            options.entry = report.continuation;
            if (report.boundary == WASM_CUT_CONTROL) break;
            int next = wasm_compiler_emit_code_cut(&source, 9u, &options, output, sizeof output, &bytes, &report);
            if (next == WASM_COMPILER_ERROR_GRAMMAR) break;
            if (next) return 1;
            char suffix[32];
            n = snprintf(json, sizeof json,
                "{\"entry\":\"%llu\",\"continuation\":\"%llu\",\"sourceBytes\":%llu,"
                "\"instructions\":%llu,\"boundary\":%u,\"moduleBytes\":%llu}\n",
                report.entry, report.continuation, report.source_bytes, report.source_instructions,
                report.boundary, report.module_bytes);
            if (n <= 0 || (size_t)n >= sizeof json) return 1;
            snprintf(suffix, sizeof suffix, "%u.json", i);
            if (write_record(argv[3], suffix, json, (size_t)n)) return 1;
            snprintf(suffix, sizeof suffix, "%u.wasm", i);
            if (write_record(argv[3], suffix, output, (size_t)bytes)) return 1;
        }
    }
    puts("Borrowed executable-page cut compiler: green (no ELF-proof/boot claim)");
    return 0;
}
