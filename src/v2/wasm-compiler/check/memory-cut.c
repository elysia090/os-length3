#define _GNU_SOURCE
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <machine/memory.h>
#include <x86/decode.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/mman.h>

extern void native_cut(machine_state *state, const void *code);
static pl_u64 random_word(pl_u64 *seed)
{ *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u; return *seed; }
static FILE *output(const char *prefix, const char *suffix)
{
    char path[4096]; int count = snprintf(path, sizeof path, "%s.%s", prefix, suffix);
    return count > 0 && (size_t)count < sizeof path ? fopen(path, "wb") : NULL;
}
static pl_u64 read_word(const pl_u8 *bytes)
{
    pl_u64 value = 0u;
    for (pl_u32 i = 0u; i < 8u; ++i) value |= (pl_u64)bytes[i] << (8u * i);
    return value;
}
static int close_output(FILE **file)
{
    int status = fclose(*file); *file = NULL; return status;
}

int main(int argc, char **argv)
{
    if (argc != 3) return 2;
    FILE *file = NULL, *prefix_file = NULL, *wasm = NULL, *cases = NULL, *meta = NULL, *source_page = NULL;
    pl_u8 *data = NULL, *ram = NULL;
    void *code = MAP_FAILED;
    size_t code_bytes = 0u;
    int relative = 0, result = 2;
    pl_u64 bytes = 0u;
    file = fopen(argv[1], "rb"); long size;
    if (!file || fseek(file, 0, SEEK_END) || (size = ftell(file)) <= 0
            || fseek(file, 0, SEEK_SET)) goto finish;
    data = malloc((size_t)size);
    if (!data || fread(data, 1u, (size_t)size, file) != (size_t)size) goto finish;
    if (close_output(&file)) goto finish;
    wasm_compiler compiler;
    pl_elf_image elf;
    if (wasm_compiler_open(&compiler, data, (pl_u64)size)
            || pl_elf_open(data, (pl_u64)size, &elf)) goto finish;
    wasm_cut_options options = { elf.entry, 1024u, 16384u };
    wasm_cut_report report;
    int status = wasm_compiler_measure_cut(&compiler, &options, &bytes, &report);
    if (status) { fprintf(stderr, "memory cut refused (%d)\n", status); result = 1; goto finish; }
    result = 1;
    if (!report.memory_bytes) {
        if (report.boundary != WASM_CUT_MEMORY || report.source_instructions != 1u
                || report.continuation <= elf.entry) goto finish;
        pl_u8 prefix_module[16384]; pl_u64 prefix_bytes;
        if (wasm_compiler_emit_cut(&compiler, &options, prefix_module, sizeof prefix_module,
                                   &prefix_bytes, NULL)) goto finish;
        prefix_file = output(argv[2], "prefix.wasm");
        if (!prefix_file || fwrite(prefix_module, 1u, (size_t)prefix_bytes, prefix_file) != prefix_bytes
                || close_output(&prefix_file)) goto finish;
        options.entry = report.continuation;
        status = wasm_compiler_measure_cut(&compiler, &options, &bytes, &report);
    }
    if (status || !report.memory_bytes || report.source_instructions != 1u
            || report.boundary != WASM_CUT_MEMORY) goto finish;
    pl_u8 module[16384]; pl_u64 written = 0u;
    if (wasm_compiler_emit_cut(&compiler, &options, module, sizeof module, &written, &report)
            || written != bytes) goto finish;
    wasm = output(argv[2], "wasm");
    if (!wasm || fwrite(module, 1u, (size_t)bytes, wasm) != bytes || close_output(&wasm)) goto finish;
    for (pl_u32 i = 0u; i < elf.program_count; ++i) {
        pl_elf_segment segment;
        if (pl_elf_program(&elf, i, &segment)) goto finish;
        if (!pl_elf_segment_is_executable(&segment)) continue;
        if (report.entry < segment.virtual_address
                || report.entry - segment.virtual_address >= segment.file_bytes) continue;
        pl_u64 base = segment.virtual_address & ~4095ull;
        pl_u64 prefix = segment.virtual_address - base;
        pl_u64 rounded;
        if (!pl_checked_add_u64(prefix, segment.memory_bytes, &rounded)
                || !pl_checked_add_u64(rounded, 4095u, &rounded)) goto finish;
        rounded &= ~4095ull;
        if (!rounded || rounded > SIZE_MAX) goto finish;
        code_bytes = (size_t)rounded;
        code = mmap((void *)(uintptr_t)base, code_bytes, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
        if (code == MAP_FAILED) { perror("native code mapping"); goto finish; }
        memcpy((pl_u8 *)code + prefix, data + segment.file_offset, (size_t)segment.file_bytes);
        if (report.continuation < base || report.continuation - base >= code_bytes) goto finish;
        ((pl_u8 *)code)[report.continuation - base] = 0xc3u;
        if (mprotect(code, code_bytes, PROT_READ | PROT_EXEC)) goto finish;
        break;
    }
    if (code == MAP_FAILED) goto finish;
    source_page = output(argv[2], "source-page");
    if (!source_page || fwrite((const void *)(uintptr_t)(report.entry & ~4095ull),
                                1u, 4096u, source_page) != 4096u || close_output(&source_page)) goto finish;
    pl_x86_map map = { code, (pl_u64)(uintptr_t)code, code_bytes, code_bytes, 5u, 1u };
    pl_x86_image image = { &map, 1u, 0u, report.entry };
    pl_x86_instruction instruction;
    if (pl_x86_decode(&image, report.entry, &instruction)) goto finish;
    int store = instruction.operands[0].kind == PL_X86_OPERAND_MEMORY;
    const pl_x86_memory *operand = &instruction.operands[store ? 0u : 1u].value.memory;
    relative = operand->base.class_id == PL_X86_REGISTER_IP;
    /* High application memory, not ASan's reserved low shadow/gap. */
    pl_u64 base = instruction.address_width == 32u ? 0x23456000ull : 0x123456789000ull;
    if (relative) base = (instruction.fallthrough + (pl_u64)operand->displacement) & ~4095ull;
    if (relative) ram = (pl_u8 *)(uintptr_t)base; /* borrowed private executable mapping */
    else ram = mmap((void *)(uintptr_t)base, 8192u, PROT_READ | PROT_WRITE,
                    MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
    if (ram == MAP_FAILED) { perror("native RAM mapping"); goto finish; }
    if (relative) {
        pl_u64 address = instruction.fallthrough + (pl_u64)operand->displacement;
        if (address < (pl_u64)(uintptr_t)code || code_bytes < 8u
                || address - (pl_u64)(uintptr_t)code > code_bytes - 8u) goto finish;
    }
    cases = output(argv[2], "cases"); meta = output(argv[2], "json");
    if (!cases || !meta) goto finish;
    pl_u64 seed = 0xa56e14dfabc81234ull;
    pl_u8 saved[8192]; int okay = 1;
    for (pl_u32 row = 0u; row < 512u; ++row) {
        machine_state state = { 0 }; pl_u64 record[38];
        for (pl_u32 reg = 0u; reg < 16u; ++reg) state.registers[reg] = random_word(&seed);
        state.rflags = 0x202u | (random_word(&seed) & 0x8d5u);
        pl_u32 offset = row % 3u == 0u ? 4093u : row % 3u == 1u ? 0u : 4088u;
        pl_u64 address = base + offset;
        if (!relative) {
            for (pl_u32 i = 0u; i < 8192u; ++i) ram[i] = (pl_u8)(i * 37u + row * 13u);
            memcpy(saved, ram, sizeof saved);
            if (operand->base.class_id != PL_X86_REGISTER_GPR || operand->base.index >= 16u)
                goto finish;
            pl_u32 base_register = operand->base.index;
            state.registers[base_register] = address - (pl_u64)operand->displacement;
            if (operand->index.class_id == PL_X86_REGISTER_GPR) {
                state.registers[operand->index.index] = row & 15u;
                state.registers[base_register] -= state.registers[operand->index.index] * operand->scale;
            }
            if (instruction.address_width == 32u) state.registers[base_register] |= 0xdeadbeef00000000ull;
        } else address = instruction.fallthrough + (pl_u64)operand->displacement;
        for (pl_u32 reg = 0u; reg < 16u; ++reg) record[reg] = state.registers[reg];
        record[16] = state.rflags; record[35] = address;
        record[36] = read_word((const pl_u8 *)(uintptr_t)address);
        native_cut(&state, (const void *)(uintptr_t)report.entry);
        record[4] = state.registers[4];
        for (pl_u32 reg = 0u; reg < 16u; ++reg) record[17u + reg] = state.registers[reg];
        record[33] = state.rflags; record[34] = report.continuation;
        /* AF has no defined native value for logical operations. The compiled
         * long-mode projection canonically clears this undefined flag. */
        if (instruction.operation == PL_X86_OPERATION_AND || instruction.operation == PL_X86_OPERATION_OR
                || instruction.operation == PL_X86_OPERATION_XOR) record[33] &= ~0x10ull;
        record[37] = read_word((const pl_u8 *)(uintptr_t)address);
        if (!relative) {
            if (store) memcpy(saved + offset, ram + offset, report.memory_bytes);
            if (memcmp(saved, ram, sizeof saved)) okay = 0;
        }
        if (fwrite(record, sizeof record, 1u, cases) != 1u) okay = 0;
    }
    if (fprintf(meta, "{\"entry\":%llu,\"prefixEntry\":%llu,\"moduleBytes\":%llu,\"sourceBytes\":%llu,\"bytes\":%u,\"access\":%u,"
                "\"stateBytes\":%zu,\"ripOffset\":%zu,\"flagsOffset\":%zu,\"retiredOffset\":%zu}\n",
                report.entry, elf.entry, report.module_bytes, report.source_bytes, report.memory_bytes, report.memory_access,
                sizeof(machine_state), offsetof(machine_state, rip), offsetof(machine_state, rflags),
                offsetof(machine_state, retired)) < 0) okay = 0;
    result = okay ? 0 : 1;
finish:
    if (file && close_output(&file)) result = 1;
    if (prefix_file && close_output(&prefix_file)) result = 1;
    if (wasm && close_output(&wasm)) result = 1;
    if (cases && close_output(&cases)) result = 1;
    if (meta && close_output(&meta)) result = 1;
    if (source_page && close_output(&source_page)) result = 1;
    if (!relative && ram && ram != MAP_FAILED && munmap(ram, 8192u)) result = 1;
    if (code != MAP_FAILED && munmap(code, code_bytes)) result = 1;
    free(data);
    if (!result) printf("native memory cut: green (%llu bytes, access %u/%u)\n", bytes, report.memory_bytes, report.memory_access);
    return result;
}
