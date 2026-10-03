#include <wasm-compiler/cut.h>
#include <machine/memory.h>
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
    /* Count encodings are legacy scans in the immutable no-BMI1/LZCNT
     * profile. POPCNT has its own enabled feature, not either extension. */
    options.maximum_source_instructions=1u;
    /* Selector reads are not descriptor loads. Register destinations use
     * their own width; even a REX.W memory form stores only two bytes. */
    for (pl_u32 segment=0u;segment<6u;++segment)
    for (pl_u32 width=16u;width<=64u;width*=2u)
    for (pl_u32 extended=0u;extended<2u;++extended) {
        pl_u32 at=0u, reg=extended ? 9u : 0u;
        memset(pages,0x90,sizeof pages);
        if (width==16u) pages[at++]=0x66u;
        if (width==64u || extended) pages[at++]=(pl_u8)(0x40u|(width==64u ? 8u : 0u)|extended);
        pages[at++]=0x8cu; pages[at++]=(pl_u8)(0xc0u|(segment<<3u)|(reg&7u));
        int status=wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        EXPECT(!status);
        if (!status) EXPECT(report.source_instructions==1u && report.source_bytes==at
            && report.boundary==WASM_CUT_SYSTEM && !report.memory_bytes
            && !report.flags_written && report.written_registers==(1u<<reg)
            && report.read_registers==(width==16u ? 1u<<reg : 0u));
    }
    for (pl_u32 segment=0u;segment<6u;++segment)
    for (pl_u32 prefix=0u;prefix<3u;++prefix)
    for (pl_u32 address32=0u;address32<2u;++address32) {
        pl_u32 at=0u;
        memset(pages,0x90,sizeof pages);
        if (address32) pages[at++]=0x67u;
        if (prefix) pages[at++]=(pl_u8)(prefix==1u ? 0x66u : 0x48u);
        pages[at++]=0x8cu; pages[at++]=(pl_u8)(7u|(segment<<3u));
        int status=wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        EXPECT(!status);
        if (!status) EXPECT(report.source_instructions==1u && report.source_bytes==at
            && report.boundary==WASM_CUT_MEMORY && report.memory_bytes==2u
            && report.memory_access==2u && report.read_registers==128u
            && !report.written_registers && !report.flags_written);
    }
    static const pl_u8 selector_refused[][3]={
        {0x8cu,0xf0u,0x90u}, {0x8cu,0xf8u,0x90u}, /* Reserved Sreg encodings. */
        {0xf0u,0x8cu,0xd0u}, {0xf0u,0x8cu,0x17u}, /* LOCK is not a selector read. */
        {0x64u,0x8cu,0x17u}, {0x65u,0x8cu,0x17u}, /* Unlowered address bases. */
    };
    for (pl_u32 rank=0u;rank<sizeof selector_refused/sizeof selector_refused[0];++rank) {
        memset(pages,0x90,sizeof pages); memcpy(pages,selector_refused[rank],3u);
        memset(output,0xa5,sizeof output);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            ==WASM_COMPILER_ERROR_GRAMMAR);
        for (pl_u32 at=0u;at<sizeof output;++at) EXPECT(output[at]==0xa5u);
    }
    /* A nonzero whole-width turn keeps the value but updates CF. The flag
     * count is masked, not reduced modulo the narrow destination width. */
    for (pl_u32 kind=0u;kind<2u;++kind)
    for (pl_u32 width=8u;width<=64u;width*=2u)
    for (pl_u32 edge=0u;edge<6u;++edge) {
        pl_u32 count=edge==0u ? 0u : edge==1u ? 1u : edge==2u ? width/2u
            : edge==3u ? width : edge==4u ? 255u : 0u;
        pl_u32 at=0u;
        memset(pages,0x90,sizeof pages);
        if (width==16u) pages[at++]=0x66u;
        if (width==64u) pages[at++]=0x48u;
        pages[at++]=(pl_u8)(edge==5u ? (width==8u ? 0xd2u : 0xd3u)
                                                   : (width==8u ? 0xc0u : 0xc1u));
        pages[at++]=(pl_u8)(0xc0u|(kind<<3u));
        if (edge!=5u) pages[at++]=(pl_u8)count;
        int status=wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        EXPECT(!status);
        if (!status) EXPECT(report.source_instructions==1u && report.source_bytes==at
            && !report.memory_bytes && report.written_registers==1u
            && report.flags_written==(edge==5u || !!(count&(width==64u ? 63u : 31u))));
    }
    /* Do not admit through-carry or memory forms through the pure register
     * grammar just because their rotate/shift operation tag is shared. */
    for (pl_u32 kind=0u;kind<4u;++kind) {
        memset(pages,0x90,sizeof pages);
        pages[0]=0x66u; pages[1]=0xc1u;
        pages[2]=(pl_u8)((kind<2u ? 0xd0u : 0x07u)|((kind&1u)<<3u));
        pages[3]=8u;
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            ==WASM_COMPILER_ERROR_GRAMMAR);
    }
    for (pl_u32 kind=0u;kind<5u;++kind)
    for (pl_u32 width=16u;width<=64u;width*=2u) {
        pl_u32 at=0u;
        memset(pages,0x90,sizeof pages);
        if (kind>=2u) pages[at++]=0xf3u;
        if (width==16u) pages[at++]=0x66u;
        if (width==64u) pages[at++]=0x48u;
        pages[at++]=0x0fu; pages[at++]=kind==4u ? 0xb8u : (kind&1u) ? 0xbdu : 0xbcu;
        pages[at++]=0xc7u;
        int status=wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        EXPECT(!status);
        if (!status) EXPECT(report.source_instructions==1u && report.source_bytes==at
            && !report.memory_bytes && report.written_registers==1u && report.flags_written);
    }
    options.maximum_source_instructions=1024u;
    /* Memory register indexes name a signed bit-string coordinate, unlike
     * immediate indexes. Cover every family/width/address-size entrance. */
    static const pl_u8 bit_opcodes[] = {0xa3u,0xabu,0xb3u,0xbbu};
    for (pl_u32 address32=0u;address32<2u;++address32)
    for (pl_u32 width=16u;width<=64u;width*=2u)
    for (pl_u32 kind=0u;kind<4u;++kind) {
        pl_u32 at=0u;
        if (address32) pages[at++]=0x67u;
        if (width==16u) pages[at++]=0x66u;
        if (width==64u) pages[at++]=0x48u;
        pages[at++]=0x0fu; pages[at++]=bit_opcodes[kind]; pages[at++]=0x0fu;
        int status=wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        EXPECT(!status);
        if (!status) EXPECT(report.source_instructions==1u && report.source_bytes==at
            && report.boundary==WASM_CUT_MEMORY && report.memory_bytes==width/8u
            && report.memory_access==(kind ? 3u : 1u) && report.read_registers==130u
            && !report.written_registers && report.flags_written);
    }
    /* Memory SETcc always stores a byte, even for a false condition. Its
     * flag predicate shares the pure register path; only the store can fault. */
    for (pl_u32 address32 = 0u; address32 < 2u; ++address32)
    for (pl_u32 condition = 0u; condition < 16u; ++condition) {
        pl_u32 at = address32;
        pages[0] = 0x67u; pages[at] = 0x0fu;
        pages[at+1u] = (pl_u8)(0x90u+condition); pages[at+2u] = 0x07u;
        int status = wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report);
        EXPECT(!status);
        if (!status) EXPECT(report.source_instructions == 1u && report.source_bytes == at+3u
            && report.boundary == WASM_CUT_MEMORY && report.memory_bytes == 1u
            && report.memory_access == 2u && report.read_registers == 128u
            && !report.written_registers && !report.flags_written);
    }
    static const pl_u8 set_stack[] = {0x0fu,0x94u,0x44u,0x24u,0x2eu};
    memcpy(pages,set_stack,sizeof set_stack);
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.source_bytes == sizeof set_stack
        && report.memory_bytes == 1u && report.memory_access == 6u
        && report.read_registers == 16u && !report.written_registers && !report.flags_written);
    /* The pure predecessor must retire separately. A later faulting store
     * cannot roll back its flags, nor speculate past it during compilation. */
    static const pl_u8 set_prefix[] = {0x48u,0x39u,0xc8u,0x0fu,0x94u,0x07u};
    memcpy(pages,set_prefix,sizeof set_prefix);
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.source_bytes == 3u
        && report.flags_written && !report.memory_bytes && report.continuation == source.entry+3u);
    static const pl_u8 set_rejected[][4] = {
        {0xf0u,0x0fu,0x94u,0x07u}, {0x64u,0x0fu,0x94u,0x07u}, {0x65u,0x0fu,0x94u,0x07u},
    };
    for (pl_u32 rank = 0u; rank < sizeof set_rejected/sizeof set_rejected[0]; ++rank) {
        memcpy(pages,set_rejected[rank],sizeof set_rejected[rank]); memset(output,0xa5,sizeof output);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            == WASM_COMPILER_ERROR_GRAMMAR);
        for (pl_u32 at = 0u; at < sizeof output; ++at) EXPECT(output[at] == 0xa5u);
    }
    /* MSR transfers and SWAPGS must be ordinary one-instruction system cuts,
     * not address-specific startup exceptions. */
    static const pl_u8 msr_codes[][3] = {{0x0f,0x30,0x90},{0x0f,0x32,0x90},{0x0f,0x01,0xf8}};
    for (pl_u32 rank = 0u; rank < 3u; ++rank) {
        memcpy(pages,msr_codes[rank],3u);
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions == 1u && report.source_bytes == (rank == 2u ? 3u : 2u)
            && report.boundary == WASM_CUT_SYSTEM && !report.flags_written && !report.memory_bytes);
        EXPECT(report.read_registers == (rank == 0u ? 7u : rank == 1u ? 2u : 0u));
        EXPECT(report.written_registers == (rank == 1u ? 5u : 0u));
        if (argc == 2 && !failures) {
            char prefix[4096], json[256];
            int n = snprintf(prefix,sizeof prefix,"%s/msr-%u",argv[1],rank);
            if (n <= 0 || (size_t)n >= sizeof prefix) return 1;
            n = snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"operation\":%u,\"sourceBytes\":%u}\n",
                rank == 0u ? 1u : rank == 1u ? 0u : 2u,rank == 2u ? 3u : 2u);
            if (n <= 0 || (size_t)n >= sizeof json || write_record(prefix,"json",json,(size_t)n)
                || write_record(prefix,"wasm",output,(size_t)bytes)
                || write_record(prefix,"source-page",pages,4096u)) return 1;
        }
    }
    // Memory input uses the same product SSA after one precise C load.
    // Immediate zero still reads/faults; aliased RDI is not published early.
    static const pl_u8 memory_multiply[][8] = {
        {0x48u,0x6bu,0x05u,0x64u,0x1fu,0x75u,0x00u,0x18u},
        {0x48u,0x0fu,0xafu,0x3fu,0x90u,0x90u,0x90u,0x90u},
        {0x6bu,0x07u,0x00u,0x90u,0x90u,0x90u,0x90u,0x90u},
    };
    options.maximum_source_instructions = 1u;
    for (pl_u32 rank=0u;rank<3u;++rank) {
        memcpy(pages,memory_multiply[rank],sizeof memory_multiply[rank]);
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions==1u && report.source_bytes==(rank==0u ? 8u : rank==1u ? 4u : 3u)
            && report.boundary==WASM_CUT_MEMORY && report.flags_written
            && report.memory_bytes==(rank==2u ? 4u : 8u) && report.memory_access==MACHINE_MEMORY_READ);
        EXPECT(report.written_registers==(rank==1u ? 128u : 1u));
        EXPECT(report.read_registers==(rank==0u ? 0u : 128u));
    }
    // Implicit double-width, FS and LOCK forms still explicitly refuse.
    static const pl_u8 multiply_rejected[][5] = {
        {0xf7u,0xe8u,0x90u,0x90u,0x90u},
        {0xf7u,0x28u,0x90u,0x90u,0x90u},
        {0x64u,0x0fu,0xafu,0x07u,0x90u},
        {0xf0u,0x0fu,0xafu,0xc7u,0x90u},
    };
    options.maximum_source_instructions = 1u;
    for (pl_u32 rank = 0u; rank < sizeof multiply_rejected / sizeof multiply_rejected[0]; ++rank) {
        memcpy(pages,multiply_rejected[rank],sizeof multiply_rejected[rank]);
        memset(output,0xa5,sizeof output);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            == WASM_COMPILER_ERROR_GRAMMAR);
        for (pl_u32 at = 0u; at < sizeof output; ++at) EXPECT(output[at] == 0xa5u);
    }
    options.maximum_source_instructions = 1024u;
    /* LEAVE is a possibly faulting read, not a pure MOV RSP,RBP prefix.
     * No output publication is allowed for a locked encoding. */
    pages[0] = 0xc9u;
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.boundary == WASM_CUT_MEMORY
        && report.memory_bytes == 8u && report.read_registers == 32u && report.written_registers == 48u);
    pages[0] = 0x66u; pages[1] = 0xc9u;
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.memory_bytes == 2u);
    pages[0] = 0xf0u; pages[1] = 0xc9u; memset(output,0xa5,sizeof output);
    EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
        == WASM_COMPILER_ERROR_GRAMMAR);
    for (pl_u32 at = 0u; at < sizeof output; ++at) EXPECT(output[at] == 0xa5u);
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
    pages[0] = 0x48u; pages[1] = 0xcfu; /* IRETQ is a one-instruction C event boundary. */
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_instructions == 1u && report.source_bytes == 2u
        && report.boundary == WASM_CUT_CONTROL && report.flags_written);
    pages[0] = 0xcfu; /* IRETD/IRETW must not silently use the 64-bit frame. */
    EXPECT(wasm_compiler_measure_code_cut(&source,9u,&options,&bytes,&report) == WASM_COMPILER_ERROR_GRAMMAR);
    pages[0] = 0x66u; pages[1] = 0xcfu;
    EXPECT(wasm_compiler_measure_code_cut(&source,9u,&options,&bytes,&report) == WASM_COMPILER_ERROR_GRAMMAR);
    pages[0] = 0xf0u; pages[1] = 0x48u; pages[2] = 0xcfu;
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
    for (pl_u32 family = 0u; family < 2u; ++family)
    for (pl_u32 address = 32u; address <= 64u; address += 32u)
    for (pl_u32 width = 8u; width <= 64u; width *= 2u) {
        pl_u32 at = 0u;
        memset(pages,0x90,sizeof pages); pages[at++] = 0xf3u;
        if (address == 32u) pages[at++] = 0x67u;
        if (width == 16u) pages[at++] = 0x66u;
        if (width == 64u) pages[at++] = 0x48u;
        pages[at++] = (pl_u8)((family ? 0xaau : 0xa4u) + (width != 8u));
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_bytes == at && report.source_instructions == 1u
            && report.memory_bytes == width / 8u && report.memory_access == (family ? 2u : 3u)
            && report.read_registers == (family ? 0x83u : 0xc2u)
            && report.written_registers == (family ? 0x82u : 0xc2u)
            && !report.flags_written);
        if (argc == 2 && !failures) {
            char prefix[4096], json[160];
            int n = snprintf(prefix,sizeof prefix,"%s/%s-%u-%u",argv[1],family ? "stos" : "repeat",width,address);
            int j = snprintf(json,sizeof json,"{\"entry\":\"4194304\",\"sourceBytes\":%u,\"instructions\":1,\"width\":%u,\"address\":%u}\n",at,width,address);
            if (n <= 0 || (size_t)n >= sizeof prefix || j <= 0 || (size_t)j >= sizeof json
                || write_record(prefix,"json",json,(size_t)j) || write_record(prefix,"wasm",output,(size_t)bytes)
                || write_record(prefix,"source-page",pages,4096u)) return 1;
        }
        pages[0] = 0x64u; pages[1] = 0xf3u; pages[2] = 0xa4u;
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
               == WASM_COMPILER_ERROR_GRAMMAR); /* FS base is not silently DS. */
        pages[0] = 0xf0u; pages[1] = 0xf3u; pages[2] = 0xa4u;
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
               == WASM_COMPILER_ERROR_GRAMMAR);
    }
    /* Generic indirect control, including the pure-prefix boundary that
     * otherwise misclassified an unemitted successor as a branch. */
    for (pl_u32 family = 0u; family < 2u; ++family)
    for (pl_u32 form = 0u; form < 3u; ++form) {
        memset(pages,0x90,sizeof pages); pages[0] = 0xffu;
        pages[1] = (pl_u8)((form ? 0x20u : 0xe0u) - (family ? 0x10u : 0u));
        if (form == 2u) {
            static const pl_u8 prefix[] = {0x48u,0x8du,0x80u,0x31u,0u,0u,0u,0xffu,0xe0u};
            memcpy(pages,prefix,sizeof prefix);
            if (family) pages[8] = 0xd0u;
        }
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions == 1u && report.source_bytes == (form == 2u ? 7u : 2u));
        EXPECT(report.boundary == (form == 2u ? WASM_CUT_LIMIT : WASM_CUT_CONTROL));
        EXPECT(report.memory_bytes == (form != 2u && (family || form == 1u) ? 8u : 0u)
            && !report.flags_written);
        EXPECT(report.written_registers == (family && form != 2u ? 16u : form == 2u ? 1u : 0u));
    }
    static const pl_u8 rejected[][3] = {
        {0x64u,0xffu,0x20u}, /* FS memory target needs explicit base semantics. */
        {0x65u,0xffu,0x20u}, {0xffu,0x28u,0x90u}, /* Far control is not near JMP. */
        {0xf0u,0xffu,0xe0u}, {0xffu,0x18u,0x90u}, {0x64u,0xffu,0x10u},
    };
    /* ADC/SBB consume CF even if a later instruction overwrites every flag.
     * SBB EAX,EAX is also the next instruction in the shipped boot payload. */
    for (pl_u32 borrow = 0u; borrow < 2u; ++borrow) {
        memset(pages,0x90,sizeof pages);
        pages[0] = (pl_u8)(borrow ? 0x19u : 0x11u); pages[1] = 0xc0u;
        options.maximum_source_instructions = 1u;
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_bytes == 2u && report.source_instructions == 1u
            && report.read_registers == 1u && report.written_registers == 1u
            && report.flags_written && !report.memory_bytes);
    }
    options.maximum_source_instructions = 1024u;
    /* Actual shipped startup instruction: BTS RSI,58. It is a pure register
     * cut, not a special kernel callback or a memory-address bit operation. */
    static const pl_u8 bit_source[] = {0x48u,0x0fu,0xbau,0xeeu,0x3au};
    memset(pages,0x90,sizeof pages); memcpy(pages,bit_source,sizeof bit_source);
    options.maximum_source_instructions = 1u;
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_bytes == 5u && report.written_registers == 64u
        && report.read_registers == 64u && report.flags_written && !report.memory_bytes);
    options.maximum_source_instructions = 1024u;
    /* A memory CMOV loads unconditionally, then selects the destination.
     * Its first instruction is never folded into an infallible pure slice. */
    static const pl_u8 conditional_load[] = {0x48u,0x0fu,0x44u,0x05u,0x90u,0xb3u,0u,0u};
    memset(pages,0x90,sizeof pages); memcpy(pages,conditional_load,sizeof conditional_load);
    EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
    EXPECT(report.source_bytes == 8u && report.source_instructions == 1u
        && report.boundary == WASM_CUT_MEMORY && report.memory_bytes == 8u
        && report.memory_access == 1u && report.written_registers == 1u && !report.flags_written);
    static const pl_u8 rejected_carry_loads[][5] = {
        {0xf0u,0x19u,0xc0u,0x90u,0x90u}, /* LOCK register SBB is invalid. */
        {0x48u,0x19u,0x00u,0x90u,0x90u}, /* Memory carry needs precise RMW semantics. */
        {0x64u,0x48u,0x0fu,0x44u,0x00u}, /* An FS-base source is not ordinary DS. */
        {0xf0u,0x48u,0x0fu,0x44u,0x00u}, /* CMOV does not accept LOCK. */
    };
    for (pl_u32 form = 0u; form < sizeof rejected_carry_loads / sizeof rejected_carry_loads[0]; ++form) {
        memset(pages,0x90,sizeof pages); memcpy(pages,rejected_carry_loads[form],sizeof rejected_carry_loads[0]);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            == WASM_COMPILER_ERROR_GRAMMAR);
    }
    static const pl_u8 rejected_bits[][6] = {
        {0xf0u,0x48u,0x0fu,0xbau,0xeeu,0x3au}, /* LOCK register BTS is invalid. */
        {0xf0u,0x48u,0x0fu,0xbau,0x28u,0x3au}, /* Locked memory RMW is not admitted yet. */
        {0x64u,0x48u,0x0fu,0xabu,0x08u,0x90u}, /* FS base is not ordinary flat memory. */
    };
    for (pl_u32 form = 0u; form < sizeof rejected_bits / sizeof rejected_bits[0]; ++form) {
        memset(pages,0x90,sizeof pages); memcpy(pages,rejected_bits[form],sizeof rejected_bits[0]);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            == WASM_COMPILER_ERROR_GRAMMAR);
    }
    for (pl_u32 condition=0u;condition<4u;++condition) {
        memset(pages,0x90,sizeof pages);
        const pl_u8 bit[]={0x48u,0x0fu,0xbau,(pl_u8)(0x20u+condition*8u),0x3fu};
        memcpy(pages,bit,sizeof bit);
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions == 1u && report.source_bytes == sizeof bit
            && report.memory_bytes == 8u && report.boundary == WASM_CUT_MEMORY
            && report.memory_access == (condition ? 3u : 1u) && report.flags_written == 1u);
    }
    for (pl_u32 operation=0u;operation<4u;++operation) {
        for (pl_u32 width=0u;width<4u;++width) {
            pl_u8 unary[3]; pl_u32 count=0u;
            if (width == 1u) unary[count++]=0x66u;
            if (width == 3u) unary[count++]=0x48u;
            unary[count++]=(pl_u8)((operation < 2u ? 0xfeu : 0xf6u)+(width != 0u));
            unary[count++]=(pl_u8)(operation < 2u ? operation*8u : operation == 2u ? 0x18u : 0x10u);
            memset(pages,0x90,sizeof pages); memcpy(pages,unary,count);
            EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
            EXPECT(report.source_instructions == 1u && report.source_bytes == count
                && report.memory_bytes == (1u << width) && report.memory_access == 3u
                && report.boundary == WASM_CUT_MEMORY && !report.written_registers
                && report.flags_written == (operation != 3u));
        }
        /* LOCK is a separate atomicity contract, not an ignored prefix. */
        const pl_u8 locked[]={0xf0u,0x48u,(pl_u8)(operation < 2u ? 0xffu : 0xf7u),
            (pl_u8)(operation < 2u ? operation*8u : operation == 2u ? 0x18u : 0x10u)};
        memset(pages,0x90,sizeof pages); memcpy(pages,locked,sizeof locked);
        memset(output,0xa5,sizeof output);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            == WASM_COMPILER_ERROR_GRAMMAR);
        for (pl_u32 at=0u;at<sizeof output;++at) EXPECT(output[at] == 0xa5u);
    }
    for (pl_u32 locked=0u;locked<2u;++locked) for (pl_u32 width=0u;width<4u;++width) {
        pl_u8 exchange[5]; pl_u32 count=0u;
        if (locked) exchange[count++]=0xf0u;
        if (width == 1u) exchange[count++]=0x66u;
        if (width == 3u) exchange[count++]=0x48u;
        exchange[count++]=0x0fu; exchange[count++]=(pl_u8)(0xb0u+(width != 0u));
        exchange[count++]=0x0fu; /* [RDI], CL/CX/ECX/RCX, implicit accumulator */
        memset(pages,0x90,sizeof pages); memcpy(pages,exchange,count);
        EXPECT(!wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report));
        EXPECT(report.source_instructions == 1u && report.source_bytes == count
            && report.memory_bytes == (1u << width) && report.memory_access == 3u
            && report.boundary == WASM_CUT_MEMORY && report.written_registers == 1u
            && report.read_registers == 0x83u && report.flags_written);
    }
    static const pl_u8 exchange_rejected[][6] = {
        {0xf0u,0x48u,0x0fu,0xb1u,0xcfu,0x90u}, /* LOCK register destination is invalid. */
        {0x64u,0x48u,0x0fu,0xb1u,0x0fu,0x90u}, /* Missing FS base. */
        {0x48u,0x0fu,0xc7u,0x0fu,0x90u,0x90u}, /* CMPXCHG16B is a distinct pair/align contract. */
        {0x0fu,0xc7u,0x0fu,0x90u,0x90u,0x90u}, /* CMPXCHG8B is not scalar CMPXCHG. */
    };
    for (pl_u32 i=0u;i<sizeof exchange_rejected/sizeof exchange_rejected[0];++i) {
        memset(pages,0x90,sizeof pages); memcpy(pages,exchange_rejected[i],sizeof exchange_rejected[0]);
        memset(output,0xa5,sizeof output);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            == WASM_COMPILER_ERROR_GRAMMAR);
        for (pl_u32 at=0u;at<sizeof output;++at) EXPECT(output[at] == 0xa5u);
    }
    for (pl_u32 form = 0u; form < sizeof rejected / sizeof rejected[0]; ++form) {
        memset(pages,0x90,sizeof pages); memcpy(pages,rejected[form],sizeof rejected[0]);
        memset(output,0xa5,sizeof output);
        EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
            == WASM_COMPILER_ERROR_GRAMMAR);
        for (pl_u32 i = 0u; i < sizeof output; ++i) EXPECT(output[i] == 0xa5u);
    }
    memset(pages,0x90,sizeof pages);
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
    /* Only an incomplete FIRST instruction requests source admission. A
     * preceding complete instruction commits without fetching its successor. */
    source.entry = options.entry = 0x400fffu;
    memset(output,0xa5,sizeof output); memset(&report,0xa5,sizeof report); bytes = 99u;
    wasm_cut_report fetch_saved = report;
    EXPECT(wasm_compiler_emit_code_cut(&source,9u,&options,output,sizeof output,&bytes,&report)
        == WASM_COMPILER_ERROR_FETCH);
    EXPECT(bytes == 99u && !memcmp(&report,&fetch_saved,sizeof report));
    for (pl_u32 i=0u;i<sizeof output;++i) EXPECT(output[i] == 0xa5u);
    /* A complete but unsupported instruction must not ask for more bytes. */
    options.entry = source.entry = 0x400ffeu; pages[4094] = 0x0fu; pages[4095] = 0x05u;
    EXPECT(wasm_compiler_measure_code_cut(&source,9u,&options,&bytes,0)
        == WASM_COMPILER_ERROR_GRAMMAR);
    options.entry = source.entry = 0x400fffu; pages[4095] = 0x0fu;
    EXPECT(wasm_compiler_measure_code_cut(&source,9u,&options,&bytes,0)
        == WASM_COMPILER_ERROR_FETCH);
    options.entry = source.entry = 0x400ff1u;
    memset(pages+4081u,0x66,15u); /* Too-long prefix stream is not truncation. */
    EXPECT(wasm_compiler_measure_code_cut(&source,9u,&options,&bytes,0)
        == WASM_COMPILER_ERROR_GRAMMAR);
    source.entry = options.entry = 0x400ffeu;
    pages[4094] = 0xfcu; pages[4095] = 0x48u; pages[4096] = 0xb8u;
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
