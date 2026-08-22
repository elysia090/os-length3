/* postlink-boundaries -- verify real block source cuts with the C frontend.
 *
 *     postlink-boundaries MACHINE [TOP]
 *
 * The migration machine is evidence only.  Each guard already contains the
 * exact executable bytes used to compile its block, including alternatives
 * and runtime patches.  Decode those immutable proof extents in C and require
 * the source walk to land exactly on the recorded boundary.  This measures the
 * semantic entrance needed by a real boot without consulting Python, symbols,
 * System.map or a boot trace during compilation.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <postlink/directory.h>
#include <postlink/template.h>
#include <postlink/x86.h>
#include <Zydis/Zydis.h>

typedef struct {
    ZydisMnemonic operation;
    pl_u64 instructions;
} operation_row;

static int descending_instructions(const void *left, const void *right)
{
    const operation_row *a = left, *b = right;
    if (a->instructions < b->instructions) return 1;
    if (a->instructions > b->instructions) return -1;
    return (int)a->operation - (int)b->operation;
}

static int read_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *handle = fopen(path, "rb");
    if (!handle) return -1;
    if (fseek(handle, 0, SEEK_END)) { fclose(handle); return -1; }
    long size = ftell(handle);
    if (size <= 0 || fseek(handle, 0, SEEK_SET)) {
        fclose(handle);
        return -1;
    }
    pl_u8 *payload = malloc((size_t)size);
    if (!payload
            || fread(payload, 1u, (size_t)size, handle) != (size_t)size) {
        free(payload);
        fclose(handle);
        return -1;
    }
    fclose(handle);
    *bytes = payload;
    *length = (pl_u64)size;
    return 0;
}

static int guard_image(const pl_u8 *guard, pl_u32 bytes, pl_u64 entry,
                       pl_x86_map **storage, pl_u32 *capacity,
                       pl_x86_image *out)
{
    if (bytes < PL_GUARD_COUNT_BYTES) return PL_ERROR_GUARD;
    pl_u32 count = pl_read_u16(guard);
    if (!count) return PL_ERROR_GUARD;
    if (count > *capacity) {
        pl_x86_map *maps = realloc(
            *storage, (size_t)count * sizeof *maps);
        if (!maps) return PL_ERROR_X86_CAPACITY;
        *storage = maps;
        *capacity = count;
    }
    pl_u32 cursor = PL_GUARD_COUNT_BYTES;
    for (pl_u32 index = 0u; index < count; ++index) {
        if (cursor > bytes || PL_GUARD_ENTRY_BYTES > bytes - cursor)
            return PL_ERROR_GUARD;
        pl_u64 address = pl_read_u64(guard + cursor);
        pl_u32 length = pl_read_u16(guard + cursor + 8u);
        cursor += PL_GUARD_ENTRY_BYTES;
        if (!length || cursor > bytes || length > bytes - cursor)
            return PL_ERROR_GUARD;
        (*storage)[index].bytes = guard + cursor;
        (*storage)[index].address = address;
        (*storage)[index].file_bytes = length;
        (*storage)[index].memory_bytes = length;
        (*storage)[index].flags = PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE;
        (*storage)[index].generation = 0u;
        cursor += length;
    }
    if (cursor != bytes) return PL_ERROR_GUARD;
    out->maps = *storage;
    out->map_count = count;
    out->reserved = 0u;
    out->entry = entry;
    return pl_x86_image_validate(out);
}

static int decoded_operation(ZydisDecoder *decoder,
                             const pl_x86_instruction *instruction,
                             ZydisMnemonic *operation)
{
    if (instruction->status != PL_X86_DECODE_VALID) {
        *operation = ZYDIS_MNEMONIC_INVALID;
        return 0;
    }
    ZydisDecodedInstruction decoded;
    ZyanStatus status = ZydisDecoderDecodeInstruction(
        decoder, NULL, instruction->source,
        instruction->source_bytes, &decoded);
    if (!ZYAN_SUCCESS(status)) return PL_ERROR_X86;
    *operation = decoded.mnemonic;
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 2 || argc > 3) {
        fprintf(stderr, "usage: postlink-boundaries MACHINE [TOP]\n");
        return 2;
    }
    long requested = argc == 3 ? strtol(argv[2], NULL, 0) : 64;
    if (requested < 0 || requested > ZYDIS_MNEMONIC_MAX_VALUE + 1u)
        return 2;

    pl_u8 *payload = NULL;
    pl_u64 payload_bytes = 0u;
    if (read_file(argv[1], &payload, &payload_bytes)) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 1;
    }
    pl_machine machine;
    int status = pl_machine_parse(payload, payload_bytes, &machine);
    if (status) {
        fprintf(stderr, "cannot parse machine: %s\n", pl_error_name(status));
        free(payload);
        return 1;
    }
    pl_directory_counts counts;
    status = pl_directory_counts_from_machine(payload, &machine, &counts);
    if (status) {
        fprintf(stderr, "cannot read directory counts: %d\n", status);
        free(payload);
        return 1;
    }
    pl_directory directory;
    status = pl_directory_open(
        payload + machine.descriptors.offset, machine.descriptors.length,
        &counts, &directory);
    if (status) {
        fprintf(stderr, "cannot open directory: %d\n", status);
        free(payload);
        return 1;
    }

    ZydisDecoder decoder;
    ZyanStatus decoder_status = ZydisDecoderInit(
        &decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
    if (!ZYAN_SUCCESS(decoder_status)) {
        free(payload);
        return 1;
    }
    pl_u64 operations[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    memset(operations, 0, sizeof operations);
    const pl_u8 *execution = payload + machine.execution.offset;
    pl_x86_map *maps = NULL;
    pl_u32 map_capacity = 0u;
    pl_u64 block_ok = 0u, guard_failed = 0u, boundary_failed = 0u;
    pl_u64 template_failed = 0u, instruction_mismatch = 0u;
    pl_u64 source_instructions = 0u, fault_rows = 0u;
    pl_u64 nonforward_boundary = 0u, decode_stopped = 0u;
    pl_u64 boundary_overshoot = 0u;
    pl_u32 maximum_block_instructions = 0u;
    pl_u32 failure_samples = 0u;

    for (pl_u32 block = 0u; block < counts.block_count; ++block) {
        pl_admission admission;
        status = pl_directory_admit(&directory, block, &admission);
        if (status) { ++guard_failed; continue; }
        pl_x86_image image;
        status = guard_image(
            execution + admission.guard.offset, (pl_u32)admission.guard.length,
            admission.rip, &maps, &map_capacity, &image);
        if (status) { ++guard_failed; continue; }
        pl_x86_frontend frontend;
        status = pl_x86_frontend_open(&image, &frontend);
        if (status) { ++guard_failed; continue; }
        pl_u64 boundary = admission.continuation.field[PL_FIELD_BOUNDARY];
        if (boundary <= admission.rip) {
            ++boundary_failed;
            ++nonforward_boundary;
            if (failure_samples < 12u) {
                fprintf(stderr,
                        "boundary sample block=%u rip=%016llx boundary=%016llx control=%u\n",
                        block, (unsigned long long)admission.rip,
                        (unsigned long long)boundary,
                        admission.continuation.control);
                ++failure_samples;
            }
            continue;
        }

        pl_u32 decoded_count = 0u;
        pl_u64 rip = admission.rip;
        while (rip < boundary) {
            pl_x86_instruction instruction;
            status = pl_x86_frontend_decode(&frontend, rip, &instruction);
            if (status || instruction.status != PL_X86_DECODE_VALID
                    || !instruction.length) {
                ++boundary_failed;
                ++decode_stopped;
                if (failure_samples < 12u) {
                    fprintf(stderr,
                            "decode sample block=%u start=%016llx at=%016llx boundary=%016llx status=%d decode=%u length=%u\n",
                            block, (unsigned long long)admission.rip,
                            (unsigned long long)rip,
                            (unsigned long long)boundary, status,
                            instruction.status, instruction.length);
                    ++failure_samples;
                }
                break;
            }
            if (instruction.length > boundary - rip) {
                ++boundary_failed;
                ++boundary_overshoot;
                if (failure_samples < 12u) {
                    fprintf(stderr,
                            "overshoot sample block=%u start=%016llx at=%016llx boundary=%016llx length=%u control=%u\n",
                            block, (unsigned long long)admission.rip,
                            (unsigned long long)rip,
                            (unsigned long long)boundary, instruction.length,
                            admission.continuation.control);
                    ++failure_samples;
                }
                break;
            }
            ZydisMnemonic operation;
            status = decoded_operation(&decoder, &instruction, &operation);
            if (status) { ++boundary_failed; break; }
            ++operations[operation];
            ++source_instructions;
            fault_rows += instruction.flow == PL_X86_FLOW_FAULT;
            ++decoded_count;
            rip += instruction.length;
        }
        if (status || rip != boundary) continue;
        if (decoded_count > maximum_block_instructions)
            maximum_block_instructions = decoded_count;

        const pl_u8 *tmpl = execution + admission.tmpl.offset;
        pl_template parsed;
        status = pl_template_parse(
            tmpl, (pl_u32)admission.tmpl.length, &parsed);
        if (status) { ++template_failed; continue; }
        if (parsed.instructions != decoded_count) ++instruction_mismatch;
        ++block_ok;
    }

    operation_row rows[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    pl_u32 operation_count = 0u;
    for (pl_u32 operation = 0u;
            operation <= (pl_u32)ZYDIS_MNEMONIC_MAX_VALUE; ++operation) {
        if (!operations[operation]) continue;
        rows[operation_count].operation = (ZydisMnemonic)operation;
        rows[operation_count].instructions = operations[operation];
        ++operation_count;
    }
    qsort(rows, operation_count, sizeof rows[0], descending_instructions);

    printf("blocks              %u\n", counts.block_count);
    printf("  exact boundaries  %llu\n", (unsigned long long)block_ok);
    printf("  guard failures    %llu\n", (unsigned long long)guard_failed);
    printf("  boundary failures %llu\n", (unsigned long long)boundary_failed);
    printf("    non-forward     %llu\n",
           (unsigned long long)nonforward_boundary);
    printf("    decode stopped  %llu\n", (unsigned long long)decode_stopped);
    printf("    overshot cut    %llu\n", (unsigned long long)boundary_overshoot);
    printf("  template failures %llu\n", (unsigned long long)template_failed);
    printf("  count mismatches  %llu\n",
           (unsigned long long)instruction_mismatch);
    printf("source instructions %llu\n",
           (unsigned long long)source_instructions);
    printf("fault instructions  %llu\n", (unsigned long long)fault_rows);
    printf("maximum block       %u instructions\n",
           maximum_block_instructions);
    printf("operation kinds     %u\n", operation_count);
    pl_u32 shown = (pl_u32)requested < operation_count
                 ? (pl_u32)requested : operation_count;
    for (pl_u32 index = 0u; index < shown; ++index) {
        const char *name = rows[index].operation == ZYDIS_MNEMONIC_INVALID
                         ? "fault" : ZydisMnemonicGetString(
                             rows[index].operation);
        printf("  %-18s %12llu\n", name ? name : "unknown",
               (unsigned long long)rows[index].instructions);
    }

    free(maps);
    free(payload);
    return guard_failed || boundary_failed || template_failed ? 1 : 0;
}
