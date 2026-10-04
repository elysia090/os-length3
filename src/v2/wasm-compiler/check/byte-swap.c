#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>

extern void native_cut(machine_state *, const void *);
static pl_u8 page[4096], module[65536];
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static pl_u64 reverse_bytes(pl_u64 word, pl_u32 width)
{
    pl_u64 reversed = 0u;
    for (pl_u32 byte = 0u; byte < width / 8u; ++byte)
        reversed = (reversed << 8u) | ((word >> (byte * 8u)) & 255u);
    return reversed;
}
static void move(pl_u32 *at, pl_u32 destination, pl_u32 source)
{
    page[(*at)++] = (pl_u8)(0x48u | (source >= 8u ? 4u : 0u) | (destination >= 8u ? 1u : 0u));
    page[(*at)++] = 0x89u;
    page[(*at)++] = (pl_u8)(0xc0u | ((source & 7u) << 3u) | (destination & 7u));
}
static int save(const char *directory, pl_u32 form, const char *suffix, const void *data, size_t bytes)
{
    if (!directory) return 0;
    char path[4096]; int length = snprintf(path, sizeof path, "%s/byte-swap-%u.%s", directory, form, suffix);
    if (length < 1 || (size_t)length >= sizeof path) return -1;
    FILE *file = fopen(path, "wbx"); if (!file) return -1;
    int status = fwrite(data, 1u, bytes, file) == bytes ? 0 : -1;
    if (fclose(file)) status = -1;
    return status;
}
static int refused(const pl_u8 *bytes, pl_u32 length)
{
    pl_u8 bad[4096], output[4096]; memset(bad, 0x90, sizeof bad); memcpy(bad, bytes, length);
    memset(output, 0xa5, sizeof output);
    pl_x86_map map = {bad, 0x400000u, 4096u, 4096u, PL_ELF_FLAG_EXECUTE, 9u};
    pl_x86_image image = {&map, 1u, 0u, map.address};
    wasm_cut_options options = {image.entry, 1u, sizeof output};
    wasm_cut_report report; memset(&report, 0xa5, sizeof report); pl_u64 emitted = 77u;
    if (wasm_compiler_emit_code_cut(&image, 9u, &options, output, sizeof output, &emitted, &report)
            != WASM_COMPILER_ERROR_GRAMMAR || emitted != 77u) return 0;
    for (size_t rank = 0u; rank < sizeof output; ++rank) if (output[rank] != 0xa5u) return 0;
    for (size_t rank = 0u; rank < sizeof report; ++rank) if (((const pl_u8 *)&report)[rank] != 0xa5u) return 0;
    return 1;
}
int main(int argc, char **argv)
{
    int observe_only = argc == 3 && !strcmp(argv[2], "--observe");
    if (argc != 1 && argc != 2 && !observe_only) return 2;
    const char *directory = argc >= 2 ? argv[1] : NULL;
    pl_u8 *code = mmap(NULL, 4096u, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (code == MAP_FAILED) return 1;
    int status = 1; pl_u32 observations = 0u; pl_u64 seed = 0x8e267abd1580fc63ull;
    for (pl_u32 form = 0u; form < 96u; ++form) {
        pl_u32 width = form < 48u ? 32u : 64u, destination = form / 3u % 16u, variant = form % 3u;
        pl_u32 source = (destination + 1u) % 16u; if (source == 4u) source = 5u;
        pl_u32 consumer = destination == 9u ? 8u : 9u;
        pl_u32 at = 0u, instructions = 1u;
        memset(page, 0x90, sizeof page);
        /* Restore the real oracle stack before RET, but observe the swapped
         * RSP in R11. No invalid-stack fault is mistaken for BSWAP semantics. */
        if (destination == 4u) { move(&at, 10u, 4u); ++instructions; }
        if (variant == 2u) { move(&at, destination, source); ++instructions; }
        if (variant == 1u) { page[at++] = 0x67u; page[at++] = 0x64u; }
        pl_u32 conversion = at;
        if (width == 64u || destination >= 8u) page[at++] = (pl_u8)((width == 64u ? 0x48u : 0x40u) | (destination >= 8u));
        page[at++] = 0x0fu; page[at++] = (pl_u8)(0xc8u | (destination & 7u));
        if (destination == 4u) { move(&at, 11u, 4u); move(&at, 4u, 10u); instructions += 2u; }
        if (variant == 2u) { page[at++] = 0x41u; page[at++] = 0x0fu; page[at++] = 0x92u;
            page[at++] = (pl_u8)(0xc0u | (consumer & 7u)); ++instructions; }
        memcpy(code, page, sizeof page); code[at] = 0xc3u;
        pl_u64 records[512][34];
        for (pl_u32 row = 0u; row < 512u; ++row) {
            machine_state before = {0}, actual;
            for (pl_u32 rank = 0u; rank < 16u; ++rank) before.registers[rank] = random_word(&seed);
            before.rflags = 0x202u | (random_word(&seed) & 0xcd5u);
            pl_u32 input = variant == 2u ? source : destination;
            if (input != 4u && row < 256u) before.registers[input] = (pl_u64)row * 0x0101010101010101ull;
            if (input != 4u && row >= 256u && row < 320u) before.registers[input] = 1ull << (row - 256u);
            actual = before; native_cut(&actual, code); before.registers[4] = actual.registers[4];
            machine_state wanted = before;
            if (destination == 4u) wanted.registers[10] = before.registers[4];
            if (variant == 2u) wanted.registers[destination] = wanted.registers[source];
            wanted.registers[destination] = reverse_bytes(wanted.registers[destination], width);
            if (destination == 4u) { wanted.registers[11] = wanted.registers[4]; wanted.registers[4] = wanted.registers[10]; }
            if (variant == 2u) wanted.registers[consumer] = (wanted.registers[consumer] & ~255ull) | (before.rflags & 1u);
            for (pl_u32 rank = 0u; rank < 16u; ++rank) {
                if (actual.registers[rank] != wanted.registers[rank]) {
                    fprintf(stderr, "BSWAP native form=%u row=%u register=%u\n", form, row, rank); goto finish;
                }
                records[row][rank] = before.registers[rank]; records[row][17u + rank] = actual.registers[rank];
            }
            if (actual.rflags != before.rflags) goto finish;
            records[row][16] = before.rflags; records[row][33] = actual.rflags; ++observations;
        }
        pl_x86_map map = {page, 0x400000u, 4096u, 4096u, PL_ELF_FLAG_EXECUTE, 9u};
        pl_x86_image image = {&map, 1u, 0u, map.address}; pl_x86_instruction decoded;
        if (pl_x86_decode(&image, image.entry + conversion, &decoded)
                || decoded.operation != PL_X86_OPERATION_BYTE_SWAP || decoded.visible_operand_count != 1u
                || decoded.operands[0].bits != width || decoded.operands[0].value.reg.index != destination) goto finish;
        wasm_cut_options options = {image.entry, instructions, sizeof module};
        wasm_cut_report report; pl_u64 emitted = 0u;
        if (!observe_only) {
            int compiled = wasm_compiler_emit_code_cut(&image, 9u, &options, module, sizeof module, &emitted, &report);
            if (compiled || report.source_instructions != instructions || report.source_bytes != at
                    || report.flags_written || report.memory_bytes || report.continuation != image.entry + at) {
                fprintf(stderr, "BSWAP form %u red: compiler=%d\n", form, compiled); goto finish;
            }
        }
        char json[256]; int length = snprintf(json, sizeof json,
            "{\"entry\":\"4194304\",\"form\":%u,\"sourceBytes\":%u,\"instructions\":%u,\"native\":512,\"words\":34}\n",
            form, at, instructions);
        if (length < 1 || (size_t)length >= sizeof json || save(directory, form, "json", json, (size_t)length)
                || save(directory, form, "source-page", page, sizeof page) || save(directory, form, "cases", records, sizeof records)
                || (!observe_only && save(directory, form, "wasm", module, (size_t)emitted))) goto finish;
    }
    if (!observe_only) {
        static const pl_u8 invalid[][4] = {{0xf0u, 0x0fu, 0xcfu, 0x90u}, {0x66u, 0x0fu, 0xcfu, 0x90u},
            {0xf0u, 0x48u, 0x0fu, 0xcfu}};
        for (pl_u32 rank = 0u; rank < 3u; ++rank) if (!refused(invalid[rank], 4u)) goto finish;
        /* An unsupported successor cannot erase a valid BSWAP prefix or be
         * emitted speculatively. Its own admission still refuses unchanged. */
        memset(page, 0x90, sizeof page);
        static const pl_u8 prefix[] = {0x48u, 0x0fu, 0xcfu, 0x66u, 0x0fu, 0xcfu};
        memcpy(page, prefix, sizeof prefix);
        pl_x86_map map = {page, 0x400000u, 4096u, 4096u, PL_ELF_FLAG_EXECUTE, 9u};
        pl_x86_image image = {&map, 1u, 0u, map.address};
        wasm_cut_options options = {image.entry, 2u, sizeof module};
        wasm_cut_report report; pl_u64 emitted = 0u;
        if (wasm_compiler_emit_code_cut(&image, 9u, &options, module, sizeof module, &emitted, &report)
                || report.source_instructions != 1u || report.source_bytes != 3u
                || report.continuation != image.entry + 3u || report.boundary != WASM_CUT_UNSUPPORTED
                || report.boundary_operation != PL_X86_OPERATION_BYTE_SWAP) goto finish;
    }
    status = 0;
finish:
    if (munmap(code, 4096u)) status = 1;
    if (!status) printf("BSWAP: %u actual x86 full-GPR/flags observations%s\n", observations,
        observe_only ? "; lowering not tested" : "");
    return status;
}
