#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stddef.h>
#include <sys/mman.h>
#include <wasm-compiler/cut.h>
#include <machine/state.h>
#include <x86/decode.h>

_Static_assert(offsetof(machine_state, rflags) == 392u, "native oracle ABI");
extern void native_cut(machine_state *state, const void *code);

static pl_u8 *read_file(const char *path, pl_u64 *bytes)
{
    FILE *file = fopen(path, "rb");
    long size;
    pl_u8 *data;
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END) || (size = ftell(file)) <= 0
            || fseek(file, 0, SEEK_SET)) { fclose(file); return NULL; }
    data = malloc((size_t)size);
    if (!data || fread(data, 1u, (size_t)size, file) != (size_t)size) {
        free(data); fclose(file); return NULL;
    }
    fclose(file); *bytes = (pl_u64)(unsigned long)size; return data;
}

static FILE *output_file(const char *prefix, const char *suffix)
{
    char path[4096];
    int n = snprintf(path, sizeof path, "%s.%s", prefix, suffix);
    return n > 0 && (size_t)n < sizeof path ? fopen(path, "wb") : NULL;
}

static pl_u64 random_word(pl_u64 *seed)
{
    *seed ^= *seed << 13u; *seed ^= *seed >> 7u; *seed ^= *seed << 17u;
    return *seed;
}

static int same_report(const wasm_cut_report *a, const wasm_cut_report *b)
{
    return a->entry == b->entry && a->continuation == b->continuation
        && a->branch_target == b->branch_target
        && a->source_instructions == b->source_instructions
        && a->source_bytes == b->source_bytes && a->module_bytes == b->module_bytes
        && a->read_registers == b->read_registers
        && a->written_registers == b->written_registers
        && a->flags_written == b->flags_written && a->boundary == b->boundary
        && a->boundary_operation == b->boundary_operation
        && a->memory_bytes == b->memory_bytes && a->memory_access == b->memory_access;
}

static int oracle_flags_mask(const pl_x86_image *image, const wasm_cut_report *report,
                             pl_u64 initial_rcx, pl_u64 *out)
{
    pl_u64 rip = report->entry, mask = ~0ull;
    int rcx_written = 0;
    for (pl_u64 i = 0u; i < report->source_instructions; ++i) {
        pl_x86_instruction instruction;
        if (pl_x86_decode_profile(image, rip, &instruction)) return 0;
        switch (instruction.operation) {
        case PL_X86_OPERATION_SHIFT: {
            const pl_x86_operand *count = &instruction.operands[1];
            /* This observer does not interpret a preceding RCX write. Fixtures
             * keep CL stable until its last use, including CL/CH aliases. */
            if (count->kind == PL_X86_OPERAND_REGISTER && rcx_written) return 0;
            pl_u32 width = instruction.operands[0].bits;
            pl_u64 bits = count->kind == PL_X86_OPERAND_IMMEDIATE
                        ? count->value.immediate : initial_rcx;
            pl_u64 n = bits & (width == 64u ? 63u : 31u);
            if (instruction.condition<2u) {
                if (n) {
                    mask|=1u; /* Rotates always define CF for a nonzero masked count. */
                    if (n==1u) mask|=0x800u;
                    else mask&=~0x800ull;
                }
                break; /* SF/ZF/AF/PF, and every flag at count zero, are preserved. */
            }
            if (n) {
                mask |= 0xc5u; /* PF, ZF, SF and initially CF */
                mask &= ~0x810ull; /* AF and multi-bit OF are undefined */
                if (n == 1u) mask |= 0x800u;
                if (instruction.condition != 7u && n >= width) mask &= ~1ull;
            }
            break;
        }
        case PL_X86_OPERATION_AND:
        case PL_X86_OPERATION_OR:
        case PL_X86_OPERATION_XOR:
        case PL_X86_OPERATION_TEST: mask = (mask | 0x8c5u) & ~0x10ull; break;
        case PL_X86_OPERATION_INCREMENT:
        case PL_X86_OPERATION_DECREMENT: mask |= 0x8d4u; break;
        case PL_X86_OPERATION_ADD:
        case PL_X86_OPERATION_ADD_CARRY:
        case PL_X86_OPERATION_SUBTRACT:
        case PL_X86_OPERATION_SUBTRACT_BORROW:
        case PL_X86_OPERATION_COMPARE:
        case PL_X86_OPERATION_NEGATE: mask |= 0x8d5u; break;
        case PL_X86_OPERATION_FLAG_CONTROL:
            if (instruction.condition < 2u) mask |= 1u;
            else if (instruction.condition == 3u || instruction.condition == 4u) mask |= 0x400u;
            break;
        case PL_X86_OPERATION_BIT_TEST:
            mask = (mask | 1u) & ~0x894ull; /* CF defined, ZF unchanged; OF/SF/AF/PF undefined. */
            break;
        case PL_X86_OPERATION_BIT_SUMMARY:
            if (instruction.condition<2u) mask=(mask|0x40u)&~0x895ull;
            else if (instruction.condition==4u) mask|=0x8d5u;
            break;
        case PL_X86_OPERATION_MULTIPLY_SIGNED:
            mask = (mask | 0x801u) & ~0xd4ull; /* Only CF/OF are defined. */
            break;
        default: break;
        }
        for (pl_u32 rank = 0u; rank < instruction.visible_operand_count; ++rank) {
            const pl_x86_operand *operand = &instruction.operands[rank];
            if (operand->kind == PL_X86_OPERAND_REGISTER
                    && operand->value.reg.class_id == PL_X86_REGISTER_GPR
                    && operand->value.reg.index == 1u
                    && (operand->flags & (PL_X86_OPERAND_WRITE | PL_X86_OPERAND_CONDITIONAL_WRITE)))
                rcx_written = 1;
        }
        rip = instruction.fallthrough;
    }
    *out = mask; return 1;
}

static int emit_oracle(const pl_elf_image *elf, const wasm_cut_report *report,
                       const char *prefix)
{
    void *mapping = MAP_FAILED;
    size_t mapping_bytes = 0u;
    pl_x86_map source_map = { 0 };
    for (pl_u32 i = 0u; i < elf->program_count; ++i) {
        pl_elf_segment segment;
        if (pl_elf_program(elf, i, &segment)) return 0;
        if (!pl_elf_segment_is_executable(&segment)
                || report->entry < segment.virtual_address
                || report->entry - segment.virtual_address >= segment.file_bytes) continue;
        pl_u64 base = segment.virtual_address & ~4095ull;
        pl_u64 prefix_bytes = segment.virtual_address - base;
        pl_u64 rounded;
        if (!pl_checked_add_u64(prefix_bytes, segment.memory_bytes, &rounded)
                || !pl_checked_add_u64(rounded, 4095u, &rounded)) return 0;
        rounded &= ~4095ull;
        if (!rounded || rounded > SIZE_MAX) return 0;
        mapping_bytes = (size_t)rounded;
        mapping = mmap((void *)(uintptr_t)base, mapping_bytes, PROT_READ | PROT_WRITE,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
        if (mapping == MAP_FAILED) { perror("oracle mmap"); return 0; }
        memcpy((pl_u8 *)mapping + prefix_bytes, elf->bytes + segment.file_offset,
               (size_t)segment.file_bytes);
        source_map = (pl_x86_map){ elf->bytes + segment.file_offset,
            segment.virtual_address, segment.file_bytes, segment.memory_bytes, 5u, 1u };
        if (report->boundary != WASM_CUT_CONTROL) {
            if (report->continuation < base || report->continuation - base >= rounded) {
                munmap(mapping, mapping_bytes); return 0;
            }
            *((pl_u8 *)mapping + (report->continuation - base)) = 0xc3u;
        }
        break;
    }
    if (mapping == MAP_FAILED) return 0;
    if (mprotect(mapping, mapping_bytes, PROT_READ | PROT_EXEC)) {
        munmap(mapping, mapping_bytes); return 0;
    }
    if (report->written_registers & (1u << 4u)) {
        munmap(mapping, mapping_bytes); return 0;
    }
    /* Only diagnostic page supply. The native observer changes a terminal
     * byte outside this cut's source span; certified instruction bytes stay
     * identical. No ELF/source reader is imported by the generated code. */
    FILE *source_page = output_file(prefix, "source-page");
    if (!source_page) { munmap(mapping, mapping_bytes); return 0; }
    const void *page = (const void *)(uintptr_t)(report->entry & ~4095ull);
    int source_okay = fwrite(page, 1u, 4096u, source_page) == 4096u;
    if (fclose(source_page)) source_okay = 0;
    if (!source_okay) { munmap(mapping, mapping_bytes); return 0; }
    FILE *cases = output_file(prefix, "cases");
    FILE *meta = output_file(prefix, "json");
    FILE *masks = output_file(prefix, "flags-masks");
    if (!cases || !meta || !masks) {
        if (cases) fclose(cases);
        if (meta) fclose(meta);
        if (masks) fclose(masks);
        munmap(mapping, mapping_bytes); return 0;
    }
    pl_u64 flags_mask = ~0ull;
    /* Flags have a per-input definedness mask. Count zero is fully preserved;
     * excluding AF/OF globally would hide precisely that dependency bug. */
    /* Definedness and lowering use the unchanged certified source, not the
     * terminal observer byte or an ISA-equivalent native prefix twin. */
    pl_x86_image image = { &source_map, 1u, 0u, report->entry };
    pl_x86_instruction carry = { 0 }, multiply = { 0 }, summary = { 0 };
    pl_u32 legacy_prefix_twin = 0u;
    for (pl_u64 rip = report->entry, i = 0u; i < report->source_instructions; ++i) {
        pl_x86_instruction instruction;
        if (pl_x86_decode_profile(&image,rip,&instruction)) {
            fclose(cases); fclose(meta); fclose(masks); munmap(mapping,mapping_bytes); return 0;
        }
        if (instruction.operation==PL_X86_OPERATION_BIT_SUMMARY) {
            summary=instruction;
            if (instruction.condition<2u) {
                for (pl_u32 at=0u;at<instruction.length && instruction.source[at]!=0x0fu;++at)
                if (instruction.source[at]==0xf3u) {
                    /* Host supersets (and some TCG CPUs even with feature
                     * bits clear) execute TZCNT/LZCNT here. Compare with the
                     * architecturally equivalent unprefixed legacy scan.
                     * The test-only leading NOP preserves all source/next
                     * coordinates; product/source-page bytes stay untouched.
                     * This is not a native observation of the F3 encoding. */
                    if (mprotect(mapping,mapping_bytes,PROT_READ|PROT_WRITE)) {
                        fclose(cases); fclose(meta); fclose(masks); munmap(mapping,mapping_bytes); return 0;
                    }
                    *((pl_u8 *)(uintptr_t)instruction.rip+at)=0x90u;
                    if (mprotect(mapping,mapping_bytes,PROT_READ|PROT_EXEC)) {
                        fclose(cases); fclose(meta); fclose(masks); munmap(mapping,mapping_bytes); return 0;
                    }
                    legacy_prefix_twin=1u;
                }
            }
            break;
        }
        if (instruction.operation == PL_X86_OPERATION_ADD_CARRY
                || instruction.operation == PL_X86_OPERATION_SUBTRACT_BORROW) {
            carry = instruction; break;
        }
        if (instruction.operation == PL_X86_OPERATION_MULTIPLY_SIGNED) {
            multiply = instruction; break;
        }
        rip = instruction.fallthrough;
    }
    int okay = 1;
    pl_u64 seed = 0x0123456789abcdefull;
    for (pl_u32 i = 0u; okay && i < 512u; ++i) {
        machine_state state = { 0 };
        pl_u64 record[35];
        for (pl_u32 reg = 0u; reg < 16u; ++reg) {
            pl_u64 value = random_word(&seed);
            if (i < 16u) {
                static const pl_u64 boundary[] = {
                    0u,1u,0x7fu,0x80u,0xffu,0x100u,0x7fffu,0x8000u,
                    0xffffu,0x10000u,0x7fffffffu,0x80000000u,0xffffffffu,
                    0x7fffffffffffffffull,0x8000000000000000ull,~0ull
                };
                value = boundary[(i + reg) & 15u];
            }
            state.registers[reg] = value; record[reg] = value;
        }
        /* Include every count in both masking domains, not only random CL. */
        if (i < 128u && !carry.length && !multiply.length && !summary.length) {
            state.registers[1] = (state.registers[1] & ~255ull) | i;
            record[1] = state.registers[1];
        }
        state.rflags = 0x202u | (random_word(&seed) & 0xcd5u);
        if (summary.length && i<256u) {
            pl_u32 width=summary.operands[1].bits, reg=summary.operands[1].value.reg.index;
            pl_u64 mask=~0ull>>(64u-width);
            pl_u32 edge=(i/2u)%(width+3u);
            pl_u64 value=edge==0u ? 0u : edge<=width ? 1ull<<(edge-1u)
                : edge==width+1u ? mask : mask>>1u;
            state.registers[reg]=(state.registers[reg]&~mask)|value;
            record[reg]=state.registers[reg];
        }
        if (i < 256u && multiply.length) {
            pl_u32 width = multiply.operands[0].bits;
            pl_u64 sign = 1ull << (width - 1u), maximum = width == 64u ? ~0ull : (1ull << width) - 1u;
            const pl_u64 boundary[] = {0u,1u,2u,3u,15u,16u,127u,128u,
                sign - 1u,sign,sign + 1u,maximum - 1u,maximum,
                0xffffffffu & maximum,0x100000000ull & maximum,0x100000001ull & maximum};
            for (pl_u32 rank = 0u; rank < 2u; ++rank) {
                const pl_x86_operand *operand = &multiply.operands[
                    multiply.visible_operand_count == 2u ? rank : rank + 1u];
                if (operand->kind != PL_X86_OPERAND_REGISTER) continue;
                pl_u32 reg = operand->value.reg.index;
                pl_u64 value = boundary[(i >> (rank ? 0u : 4u)) & 15u];
                state.registers[reg] = (state.registers[reg] & ~maximum) | value;
                record[reg] = state.registers[reg];
            }
        }
        if (i < 128u && carry.length) {
            /* Both CF values for every pair of width-specific boundaries.
             * Hardware, not an arithmetic reimplementation, supplies outputs. */
            pl_u32 width = carry.operands[0].bits;
            pl_u64 sign = 1ull << (width - 1u), maximum = width == 64u ? ~0ull : (1ull << width) - 1u;
            const pl_u64 boundary[] = {0u,1u,15u,16u,sign - 1u,sign,maximum - 1u,maximum};
            for (pl_u32 rank = 0u; rank < 2u; ++rank) {
                const pl_x86_operand *operand = &carry.operands[rank];
                if (operand->kind != PL_X86_OPERAND_REGISTER) continue;
                const pl_x86_register *reg = &operand->value.reg;
                pl_u32 shift = reg->flags & PL_X86_REGISTER_HIGH8 ? 8u : 0u;
                pl_u64 value = boundary[(i >> (rank ? 1u : 4u)) & 7u];
                state.registers[reg->index] = (state.registers[reg->index] & ~(maximum << shift)) | (value << shift);
                record[reg->index] = state.registers[reg->index];
            }
            state.rflags = (state.rflags & ~1ull) | (i & 1u);
        }
        record[16] = state.rflags;
        pl_u64 row_mask;
        if (!oracle_flags_mask(&image, report, state.registers[1], &row_mask)) {
            fprintf(stderr, "native defined-flags observer requires stable CL input\n");
            okay = 0; break;
        }
        flags_mask &= row_mask;
        native_cut(&state, (const void *)(uintptr_t)report->entry);
        record[4] = state.registers[4];
        pl_u64 next = report->continuation;
        if (report->boundary == WASM_CUT_CONTROL) {
            if (state.registers[0] > 1u) { okay = 0; break; }
            next = state.registers[0] ? report->branch_target : report->continuation;
            /* Branch fixture's observer executes after the compiled cut. */
            state.registers[0] = record[0];
        }
        for (pl_u32 reg = 0u; reg < 16u; ++reg) record[17u + reg] = state.registers[reg];
        record[33] = state.rflags; record[34] = next;
        if (fwrite(record, sizeof record, 1u, cases) != 1u) { okay = 0; break; }
        if (fwrite(&row_mask, sizeof row_mask, 1u, masks) != 1u) { okay = 0; break; }
    }
    if (fprintf(meta,
        "{\"stateBytes\":%zu,\"ripOffset\":%zu,\"flagsOffset\":%zu,"
        "\"retiredOffset\":%zu,\"entry\":\"%llu\",\"instructions\":%llu,"
        "\"flagsMask\":\"%llu\",\"writtenRegisters\":%u,\"sourceBytes\":%llu,"
        "\"moduleBytes\":%llu,\"boundary\":%u,"
        "\"summary\":{\"source\":%u,\"destination\":%u,\"width\":%u,\"undefinedZeroDestination\":%u,\"nativeLegacyPrefixTwin\":%u}}\n",
        sizeof(machine_state), offsetof(machine_state, rip), offsetof(machine_state, rflags),
        offsetof(machine_state, retired), report->entry, report->source_instructions,
        flags_mask, report->written_registers, report->source_bytes, report->module_bytes,
        report->boundary,summary.operands[1].value.reg.index,summary.operands[0].value.reg.index,
        summary.length ? summary.operands[1].bits : 0u,
        (unsigned)(summary.length && summary.condition<2u && report->source_instructions==1u),
        legacy_prefix_twin) < 0) okay = 0;
    if (fclose(cases)) okay = 0;
    if (fclose(meta)) okay = 0;
    if (fclose(masks)) okay = 0;
    if (munmap(mapping, mapping_bytes)) okay = 0;
    return okay;
}

int main(int argc, char **argv)
{
    pl_u64 length = 0u, bytes = 0u;
    wasm_compiler compiler;
    pl_elf_image elf;
    wasm_cut_options options = { 0u, 64u, 65536u };
    wasm_cut_report report = { 0 };
    int failed = 0;
#define EXPECT(expression) do { if (!(expression)) { \
    fprintf(stderr, "cut check: line %u\n", (unsigned)__LINE__); ++failed; } } while (0)
    if (argc < 2 || argc > 4) return 2;
    if (argc == 4) {
        char *end;
        unsigned long limit = strtoul(argv[3], &end, 10);
        if (!*argv[3] || *end || !limit || limit > WASM_CUT_MAX_INSTRUCTIONS) return 2;
        options.maximum_source_instructions = (pl_u32)limit;
    }
    pl_u8 *input = read_file(argv[1], &length);
    if (!input || wasm_compiler_open(&compiler, input, length)
            || pl_elf_open(input, length, &elf)) { free(input); return 1; }
    options.entry = compiler.image.entry;
    int status = wasm_compiler_measure_cut(&compiler, &options, &bytes, &report);
    if (status || !bytes || !report.source_instructions) {
        fprintf(stderr, "real optimized ELF cut emission: red (%d)\n", status);
        free(input); return 1;
    }
    pl_u8 *output = malloc((size_t)bytes);
    if (!output) { free(input); return 1; }
    memset(output, 0xa5, (size_t)bytes);
    pl_u64 written = 99u;
    wasm_cut_report sentinel;
    memset(&sentinel, 0x5a, sizeof sentinel);
    wasm_cut_report saved = sentinel;
    EXPECT(wasm_compiler_emit_cut(&compiler, &options, output, bytes - 1u,
                                 &written, &sentinel) == WASM_COMPILER_ERROR_CAPACITY);
    EXPECT(written == 99u && !memcmp(&saved, &sentinel, sizeof saved));
    for (pl_u64 i = 0u; i < bytes; ++i) EXPECT(output[i] == 0xa5u);
    EXPECT(wasm_compiler_emit_cut(&compiler, &options, output, bytes,
           (pl_u64 *)(void *)output, NULL) == WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_emit_cut(&compiler, &options, output, bytes,
           &written, (wasm_cut_report *)(void *)output) == WASM_COMPILER_ERROR_INPUT);
    for (pl_u64 i = 0u; i < bytes; ++i) EXPECT(output[i] == 0xa5u);
    wasm_cut_options invalid = options;
    invalid.maximum_source_instructions = 0u;
    EXPECT(wasm_compiler_measure_cut(&compiler, &invalid, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    invalid = options; invalid.maximum_module_bytes = 1u;
    EXPECT(wasm_compiler_emit_cut(&compiler, &invalid, output, bytes, &written, NULL)
           == WASM_COMPILER_ERROR_CAPACITY);
    EXPECT(written == 99u);
    invalid = options; invalid.maximum_source_instructions = WASM_CUT_MAX_INSTRUCTIONS + 1u;
    EXPECT(wasm_compiler_measure_cut(&compiler, &invalid, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    invalid = options; invalid.entry = 0u;
    EXPECT(wasm_compiler_emit_cut(&compiler, &invalid, output, bytes, &written, NULL)
           == WASM_COMPILER_ERROR_INPUT);
    EXPECT(wasm_compiler_emit_cut(&compiler, &options, output, bytes, &written, &sentinel) == 0);
    EXPECT(written == bytes && same_report(&report, &sentinel));
    if (report.boundary == WASM_CUT_UNSUPPORTED || report.boundary == WASM_CUT_FAULT) {
        invalid = options; invalid.entry = report.continuation;
        pl_u64 before = written;
        EXPECT(wasm_compiler_emit_cut(&compiler, &invalid, output, bytes, &written, NULL)
               == WASM_COMPILER_ERROR_GRAMMAR);
        EXPECT(written == before);
    }
    wasm_compile_options whole = { 256u, 1048576u };
    EXPECT(wasm_compiler_measure(&compiler, &whole, &written, NULL)
           == WASM_COMPILER_ERROR_INCOMPLETE);
    pl_u8 *alias = malloc((size_t)length);
    if (!alias) failed = 1;
    else {
        memcpy(alias, input, (size_t)length);
        wasm_compiler borrowed;
        EXPECT(wasm_compiler_open(&borrowed, alias, length) == 0);
        EXPECT(wasm_compiler_emit_cut(&borrowed, &options, alias, length, &written, NULL)
               == WASM_COMPILER_ERROR_INPUT);
        EXPECT(!memcmp(alias, input, (size_t)length));
        free(alias);
    }
    if (!failed && argc >= 3) {
        FILE *file = output_file(argv[2], "wasm");
        if (!file) failed = 1;
        else {
            if (fwrite(output, 1u, (size_t)bytes, file) != (size_t)bytes) failed = 1;
            if (fclose(file)) failed = 1;
        }
        if (!failed && !emit_oracle(&elf, &report, argv[2])) failed = 1;
    }
    if (!failed) printf("cut bytes=%llu source=%llu boundary=%u (whole ELF remains red)\n",
                        bytes, report.source_instructions, report.boundary);
    free(output); free(input); return failed ? 1 : 0;
}
