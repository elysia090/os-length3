#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <x86/decode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/mman.h>

extern void native_stack_cut(const machine_state *state, const void *entry);
extern void native_stack_capture(void);
extern pl_u64 native_stack_result[17];
static FILE *output(const char *prefix, const char *suffix)
{
    char path[4096]; int size = snprintf(path, sizeof path, "%s.%s", prefix, suffix);
    return size > 0 && (size_t)size < sizeof path ? fopen(path, "wb") : NULL;
}
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static pl_u64 word(const void *source)
{
    const pl_u8 *bytes = source; pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)bytes[i] << (i * 8u);
    return value;
}
static void put(void *target, pl_u64 value)
{ pl_u8 *bytes = target; for (pl_u32 i = 0u; i < 8u; ++i) bytes[i] = (pl_u8)(value >> (8u * i)); }

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    int result = 1;
    FILE *input = NULL, *wasm = NULL, *cases = NULL, *meta = NULL;
    pl_u8 *data = NULL, *code = MAP_FAILED, *ram = MAP_FAILED;
    size_t code_bytes = 0u;
    input = fopen(argv[1], "rb"); long size;
    if (!input || fseek(input, 0, SEEK_END) || (size = ftell(input)) <= 0
            || fseek(input, 0, SEEK_SET)) goto finish;
    data = malloc((size_t)size);
    if (!data || fread(data, 1u, (size_t)size, input) != (size_t)size) goto finish;
    wasm_compiler compiler; pl_elf_image elf;
    if (wasm_compiler_open(&compiler, data, (pl_u64)size)
            || pl_elf_open(data, (pl_u64)size, &elf)) goto finish;
    wasm_cut_options options = { elf.entry, 1u, 16384u };
    wasm_cut_report report; pl_u64 bytes, written;
    int status = wasm_compiler_measure_cut(&compiler, &options, &bytes, &report);
    if (status || report.source_instructions != 1u || report.memory_bytes != 8u) {
        fprintf(stderr, "stack cut rejected (%d)\n", status); goto finish;
    }
    pl_u8 module[16384];
    if (wasm_compiler_emit_cut(&compiler, &options, module, sizeof module, &written, &report)
            || bytes != written) goto finish;
    wasm = output(argv[2], "wasm"); cases = output(argv[2], "cases"); meta = output(argv[2], "json");
    if (!wasm || !cases || !meta || fwrite(module, 1u, (size_t)bytes, wasm) != bytes) goto finish;
    pl_u64 map_base = 0u, file_base = 0u;
    for (pl_u32 i = 0u; i < elf.program_count; ++i) {
        pl_elf_segment segment;
        if (pl_elf_program(&elf, i, &segment)) goto finish;
        if (!pl_elf_segment_is_executable(&segment) || elf.entry < segment.virtual_address
                || elf.entry - segment.virtual_address >= segment.file_bytes) continue;
        if (segment.file_bytes > 0x100000u) goto finish;
        code_bytes = (size_t)((segment.file_bytes + 4095u) & ~4095ull) + 4096u;
        code = mmap(NULL, code_bytes, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (code == MAP_FAILED) goto finish;
        map_base = segment.virtual_address; file_base = segment.file_offset;
        memcpy(code, data + file_base, (size_t)segment.file_bytes); break;
    }
    if (code == MAP_FAILED || elf.entry - map_base >= code_bytes) goto finish;
    /* Decode uses the authenticated ELF map, not padding beyond its source. */
    pl_x86_map maps[64]; pl_x86_image image;
    if (pl_x86_image_from_elf(&elf, 0u, 1u, maps, 64u, &image)) goto finish;
    pl_x86_instruction instruction;
    if (pl_x86_decode(&image, elf.entry, &instruction)) goto finish;
    int call = instruction.operation == PL_X86_OPERATION_CALL;
    int returning = instruction.operation == PL_X86_OPERATION_RETURN;
    int push = call || instruction.operation == PL_X86_OPERATION_PUSH;
    pl_u64 catcher = call ? instruction.target : instruction.fallthrough;
    if (catcher < map_base || catcher - map_base > code_bytes - 14u) goto finish;
    pl_u8 *jump = code + (catcher - map_base);
    jump[0] = 0xffu; jump[1] = 0x25u; memset(jump + 2, 0, 4u);
    put(jump + 6, (pl_u64)(uintptr_t)native_stack_capture);
    ram = mmap((void *)(uintptr_t)0x223456780000ull, 8192u, PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (ram == MAP_FAILED) goto finish;
    pl_u64 seed = 0x87651ffdaa34128full;
    for (pl_u32 row = 0u; row < 512u; ++row) {
        machine_state state = {0}; pl_u64 record[38]; pl_u8 saved[8192];
        for (pl_u32 i = 0u; i < 16u; ++i) state.registers[i] = random_word(&seed);
        state.rflags = 0x202u | (random_word(&seed) & 0x8d5u);
        pl_u32 offset = row % 3u == 0u ? 4093u : row % 3u == 1u ? 4096u : 4088u;
        for (pl_u32 i = 0u; i < 8192u; ++i) ram[i] = (pl_u8)(i * 37u + row);
        if (returning) put(ram + offset, (pl_u64)(uintptr_t)jump);
        memcpy(saved, ram, sizeof saved);
        state.registers[4] = (pl_u64)(uintptr_t)(ram + offset) + (push ? 8u : 0u);
        for (pl_u32 i = 0u; i < 16u; ++i) record[i] = state.registers[i];
        record[16] = state.rflags; record[35] = (pl_u64)(uintptr_t)(ram + offset);
        record[36] = word(ram + offset);
        native_stack_cut(&state, code + (elf.entry - map_base));
        for (pl_u32 i = 0u; i < 16u; ++i) record[17u + i] = native_stack_result[i];
        record[33] = native_stack_result[16];
        record[34] = returning ? record[36] : call ? instruction.target : instruction.fallthrough;
        record[37] = word(ram + offset);
        if (call) {
            if (record[37] != (pl_u64)(uintptr_t)(code + instruction.fallthrough - map_base)) goto finish;
            record[37] = instruction.fallthrough; /* Remove only oracle relocation bias. */
        }
        if (push) memcpy(saved + offset, ram + offset, 8u);
        if (memcmp(saved, ram, sizeof saved) || fwrite(record, sizeof record, 1u, cases) != 1u) goto finish;
    }
    if (fprintf(meta, "{\"entry\":%llu,\"prefixEntry\":%llu,\"bytes\":8,\"access\":%u,"
                     "\"stateBytes\":%zu,\"ripOffset\":%zu,\"flagsOffset\":%zu,\"retiredOffset\":%zu,"
                     "\"returning\":%s}\n", report.entry, elf.entry, report.memory_access,
                     sizeof(machine_state), offsetof(machine_state, rip), offsetof(machine_state, rflags),
                     offsetof(machine_state, retired), returning ? "true" : "false") < 0) goto finish;
    result = 0;
finish:
    if (input && fclose(input)) result = 1;
    if (wasm && fclose(wasm)) result = 1;
    if (cases && fclose(cases)) result = 1;
    if (meta && fclose(meta)) result = 1;
    if (code != MAP_FAILED && munmap(code, code_bytes)) result = 1;
    if (ram != MAP_FAILED && munmap(ram, 8192u)) result = 1;
    free(data);
    if (!result) puts("native stack cut: green (512 cases; relocated test mapping only)");
    return result;
}
