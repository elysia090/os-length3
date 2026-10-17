/* postlink-elf -- inspect the linked x86 image accepted by the compiler. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/internal/transfer.h"
#include <x86/semantics.h>
#include <x86/decode.h>
#include <Zydis/Zydis.h>

typedef struct {
    pl_u64 rip;
    pl_u64 machine_argument;
    pl_u32 flags;
    pl_u32 machine_operation;
    int lower_status;
    pl_u16 bits[3];
    pl_u8 kind[3];
    pl_u8 register_class[3];
    pl_u8 register_index[3];
    pl_u8 register_flags[3];
    pl_u8 segment_class[3];
    pl_u8 segment_index[3];
    pl_u8 source[PL_X86_MAX_INSTRUCTION_BYTES];
    pl_u8 length;
    pl_u8 visible;
} semantic_example;

typedef struct {
    pl_transfer_builder *transfers;
    pl_u32 identity_limit;
    ZydisDecoder decoder;
    pl_u64 coordinates[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    pl_u64 classes[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
} operation_catalog;

typedef struct {
    pl_u64 coordinates[PL_X86_OPERATION_MAX + 1u];
    pl_u64 lowered[PL_X86_OPERATION_MAX + 1u];
    pl_u64 work;
    pl_u64 span;
    pl_u64 grammar_misses;
    pl_u64 barrier_misses;
    pl_u64 arena_failures;
    pl_u64 valid;
    pl_u64 machine_coordinates[PL_X86_MACHINE_ENTROPY + 1u];
    pl_u64 scalar_float_coordinates[PL_X86_SCALAR_FLOAT_PREDICATE + 1u];
    pl_u64 scalar_float_register_coordinates[
        PL_X86_SCALAR_FLOAT_PREDICATE + 1u];
    pl_u64 scalar_float_memory_coordinates[
        PL_X86_SCALAR_FLOAT_PREDICATE + 1u];
    pl_u64 scalar_float_width_coordinates[2u];
    ZydisDecoder decoder;
    pl_u64 unsupported_mnemonic[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    pl_u64 grammar_miss_mnemonic[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    pl_u64 barrier_mnemonic[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    semantic_example grammar_example[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    semantic_example barrier_example[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    pl_u8 storage[4096];
} semantic_catalog;

static const char *semantic_name(pl_u32 operation)
{
    static const char *const names[PL_X86_OPERATION_MAX + 1u] = {
        "unsupported", "fault", "nop", "move", "move-zero-extend",
        "move-sign-extend", "load-address", "exchange", "add",
        "add-carry", "subtract", "subtract-borrow", "and", "or", "xor",
        "compare", "test", "increment", "decrement", "negate",
        "complement", "branch", "call", "return", "push", "pop", "shift",
        "flag-control", "leave", "accumulator-extend", "high-extend",
        "conditional-set", "conditional-move", "multiply-unsigned",
        "multiply-signed", "divide-unsigned", "divide-signed", "loop",
        "count-zero-branch", "push-flags", "pop-flags", "load-flags-low",
        "store-flags-low", "bit-test", "translate-byte", "byte-swap",
        "enter", "string", "exchange-add", "compare-exchange",
        "shift-no-flags", "bit-summary", "double-shift", "and-not",
        "move-byte-swap", "base-access", "crc32", "bzhi",
    };
    return operation <= PL_X86_OPERATION_MAX ? names[operation] : "invalid";
}

static const char *machine_name(pl_u32 operation)
{
    static const char *const names[PL_X86_MACHINE_ENTROPY + 1u] = {
        "none", "write-msr", "far-return", "write-control",
        "read-control", "write-segment", "descriptor-table", "pop-flags",
        "read-msr", "cpuid", "interrupt-flag", "port-io", "swap-gs",
        "halt", "invalidate-page", "system-transfer", "interrupt-return",
        "atomic", "vector", "read-selector", "software-interrupt",
        "far-transfer", "x87", "time", "validate-selector", "string",
        "memory-order", "debug-register", "system-selector", "cr0-status",
        "segment-stack", "entropy",
    };
    return operation <= PL_X86_MACHINE_ENTROPY ? names[operation] : "invalid";
}

static int catalog_semantic(const pl_x86_instruction *instruction,
                            void *opaque)
{
    semantic_catalog *catalog = opaque;
    pl_u32 operation = instruction->operation;
    if (operation > PL_X86_OPERATION_MAX) return PL_ERROR_X86;
    ++catalog->coordinates[operation];
    if (instruction->status != PL_X86_DECODE_VALID) return 0;
    ++catalog->valid;
    if (instruction->machine_operation <= PL_X86_MACHINE_ENTROPY)
        ++catalog->machine_coordinates[instruction->machine_operation];
    if (instruction->machine_operation == PL_X86_MACHINE_VECTOR
            && (instruction->machine_argument & 0xffu)
               == PL_X86_VECTOR_SCALAR_FLOAT) {
        pl_u32 scalar_operation = (pl_u32)(instruction->machine_argument
            >> PL_X86_SCALAR_FLOAT_OPERATION_SHIFT) & 0xffu;
        if (scalar_operation <= PL_X86_SCALAR_FLOAT_PREDICATE) {
            ++catalog->scalar_float_coordinates[scalar_operation];
            if (instruction->machine_argument
                    & PL_X86_SCALAR_FLOAT_SOURCE_MEMORY)
                ++catalog->scalar_float_memory_coordinates[scalar_operation];
            else
                ++catalog->scalar_float_register_coordinates[scalar_operation];
            pl_u32 target_bytes = (pl_u32)(instruction->machine_argument
                >> PL_X86_SCALAR_FLOAT_TARGET_BYTES_SHIFT) & 0xffu;
            if (target_bytes == 4u)
                ++catalog->scalar_float_width_coordinates[0u];
            else if (target_bytes == 8u)
                ++catalog->scalar_float_width_coordinates[1u];
        }
    }
    if (operation == PL_X86_OPERATION_UNSUPPORTED
            && !(instruction->flags & PL_X86_INSTRUCTION_BARRIER)) {
        ZydisDecodedInstruction decoded;
        ZyanStatus decoded_status = ZydisDecoderDecodeInstruction(
            &catalog->decoder, NULL, instruction->source,
            instruction->source_bytes, &decoded);
        if (!ZYAN_SUCCESS(decoded_status)) return PL_ERROR_X86;
        ++catalog->unsupported_mnemonic[decoded.mnemonic];
    }
    /* A valid architectural trap is already a complete terminal transfer.
     * It deliberately has no SSA plan: the emitted fault function preserves
     * either the instruction RIP or the trap fallthrough.  Counting it as an
     * anonymous barrier made millions of shared INT3 padding coordinates
     * obscure the real closure frontier. */
    if (instruction->flow == PL_X86_FLOW_FAULT) {
        ++catalog->lowered[operation];
        return 0;
    }
    pl_arena arena = { catalog->storage, sizeof catalog->storage, 0u };
    pl_x86_semantic semantic;
    int status = pl_x86_lower(instruction, &arena, &semantic);
    if (!status) {
        ++catalog->lowered[operation];
        catalog->work += semantic.plan.node_count;
        catalog->span += semantic.plan.span;
        return 0;
    }
    if (status == PL_ERROR_X86_SEMANTIC) {
        ZydisDecodedInstruction decoded;
        ZyanStatus decoded_status = ZydisDecoderDecodeInstruction(
            &catalog->decoder, NULL, instruction->source,
            instruction->source_bytes, &decoded);
        if (!ZYAN_SUCCESS(decoded_status)) return PL_ERROR_X86;
        if (instruction->flags & PL_X86_INSTRUCTION_BARRIER) {
            ++catalog->barrier_misses;
            ++catalog->barrier_mnemonic[decoded.mnemonic];
            semantic_example *example =
                &catalog->barrier_example[decoded.mnemonic];
            if (!example->length) {
                example->rip = instruction->rip;
                example->machine_argument = instruction->machine_argument;
                example->flags = instruction->flags;
                example->machine_operation = instruction->machine_operation;
                example->lower_status = status;
                example->length = instruction->length;
                example->visible = instruction->visible_operand_count;
                memcpy(example->source, instruction->source,
                       instruction->source_bytes);
                pl_u32 count = instruction->visible_operand_count < 3u
                             ? instruction->visible_operand_count : 3u;
                for (pl_u32 index = 0u; index < count; ++index) {
                    const pl_x86_operand *operand =
                        &instruction->operands[index];
                    example->kind[index] = operand->kind;
                    example->bits[index] = operand->bits;
                    if (operand->kind == PL_X86_OPERAND_REGISTER) {
                        example->register_class[index] =
                            operand->value.reg.class_id;
                        example->register_index[index] =
                            operand->value.reg.index;
                        example->register_flags[index] =
                            (pl_u8)operand->value.reg.flags;
                    }
                    if (operand->kind == PL_X86_OPERAND_MEMORY) {
                        example->segment_class[index] =
                            operand->value.memory.segment.class_id;
                        example->segment_index[index] =
                            operand->value.memory.segment.index;
                    }
                }
            }
            return 0;
        }
        if (operation == PL_X86_OPERATION_UNSUPPORTED) return 0;
        ++catalog->grammar_misses;
        ++catalog->grammar_miss_mnemonic[decoded.mnemonic];
        semantic_example *example = &catalog->grammar_example[decoded.mnemonic];
        if (!example->length) {
            example->rip = instruction->rip;
            example->flags = instruction->flags;
            example->length = instruction->length;
            example->visible = instruction->visible_operand_count;
            memcpy(example->source, instruction->source,
                   instruction->source_bytes);
            pl_u32 count = instruction->visible_operand_count < 3u
                         ? instruction->visible_operand_count : 3u;
            for (pl_u32 index = 0u; index < count; ++index) {
                const pl_x86_operand *operand = &instruction->operands[index];
                example->kind[index] = operand->kind;
                example->bits[index] = operand->bits;
                if (operand->kind == PL_X86_OPERAND_REGISTER) {
                    example->register_class[index] =
                        operand->value.reg.class_id;
                    example->register_index[index] = operand->value.reg.index;
                    example->register_flags[index] =
                        (pl_u8)operand->value.reg.flags;
                }
                if (operand->kind == PL_X86_OPERAND_MEMORY) {
                    example->segment_class[index] =
                        operand->value.memory.segment.class_id;
                    example->segment_index[index] =
                        operand->value.memory.segment.index;
                }
            }
        }
        return 0;
    }
    if (status == PL_ERROR_ARENA) {
        ++catalog->arena_failures;
        return 0;
    }
    return status;
}

static void print_semantic_catalog(const semantic_catalog *catalog)
{
    pl_u64 decoded = 0u, lowered = 0u;
    for (pl_u32 operation = 0u;
            operation <= PL_X86_OPERATION_MAX; ++operation) {
        decoded += catalog->coordinates[operation];
        lowered += catalog->lowered[operation];
    }
    printf("semantic coordinates %llu\n", (unsigned long long)decoded);
    printf("semantic valid    %llu\n", (unsigned long long)catalog->valid);
    printf("semantic lowered  %llu\n", (unsigned long long)lowered);
    printf("semantic unlowered %llu\n",
           (unsigned long long)(catalog->valid - lowered));
    printf("semantic barriers %llu\n",
           (unsigned long long)catalog->barrier_misses);
    printf("semantic grammar misses %llu\n",
           (unsigned long long)catalog->grammar_misses);
    printf("semantic arena failures %llu\n",
           (unsigned long long)catalog->arena_failures);
    printf("semantic work     %llu\n", (unsigned long long)catalog->work);
    printf("semantic span     %llu\n", (unsigned long long)catalog->span);
    pl_u64 machine_coordinates = 0u;
    for (pl_u32 operation = 1u;
            operation <= PL_X86_MACHINE_ENTROPY; ++operation)
        machine_coordinates += catalog->machine_coordinates[operation];
    pl_u64 scalar_coordinates = 0u;
    for (pl_u32 operation = 0u;
            operation <= PL_X86_SCALAR_FLOAT_PREDICATE; ++operation)
        scalar_coordinates += catalog->scalar_float_coordinates[operation];
    printf("machine cuts      %llu\n",
           (unsigned long long)machine_coordinates);
    for (pl_u32 operation = 1u;
            operation <= PL_X86_MACHINE_ENTROPY; ++operation) {
        if (!catalog->machine_coordinates[operation]) continue;
        printf("  machine %-24s coordinates=%10llu\n",
               machine_name(operation),
               (unsigned long long)catalog->machine_coordinates[operation]);
    }
    printf("scalar cuts       %llu\n",
           (unsigned long long)scalar_coordinates);
    pl_u64 scalar_memory = 0u;
    for (pl_u32 operation = 0u;
            operation <= PL_X86_SCALAR_FLOAT_PREDICATE; ++operation)
        scalar_memory += catalog->scalar_float_memory_coordinates[operation];
    printf("  scalar register-only coordinates=%10llu\n",
           (unsigned long long)(scalar_coordinates - scalar_memory));
    printf("  scalar memory-cut    coordinates=%10llu\n",
           (unsigned long long)scalar_memory);
    printf("  scalar binary32      coordinates=%10llu\n",
           (unsigned long long)catalog->scalar_float_width_coordinates[0u]);
    printf("  scalar binary64      coordinates=%10llu\n",
           (unsigned long long)catalog->scalar_float_width_coordinates[1u]);
    static const char *const scalar_names[] = {
        "add", "multiply", "subtract", "divide", "minimum", "maximum",
        "compare-ordered", "compare-unordered", "integer-to-float",
        "float-to-integer-truncate", "widen", "predicate",
    };
    for (pl_u32 operation = 0u;
            operation <= PL_X86_SCALAR_FLOAT_PREDICATE; ++operation) {
        if (!catalog->scalar_float_coordinates[operation]) continue;
        printf("  scalar %-25s coordinates=%10llu register=%10llu memory=%10llu\n",
               scalar_names[operation],
               (unsigned long long)
                   catalog->scalar_float_coordinates[operation],
               (unsigned long long)
                   catalog->scalar_float_register_coordinates[operation],
               (unsigned long long)
                   catalog->scalar_float_memory_coordinates[operation]);
    }
    for (pl_u32 operation = 0u;
            operation <= PL_X86_OPERATION_MAX; ++operation) {
        if (!catalog->coordinates[operation]) continue;
        printf("  %-20s lowered=%10llu coordinates=%10llu\n",
               semantic_name(operation),
               (unsigned long long)catalog->lowered[operation],
               (unsigned long long)catalog->coordinates[operation]);
    }
    pl_u8 shown[ZYDIS_MNEMONIC_MAX_VALUE + 1u] = { 0u };
    printf("unsupported mnemonic leaders\n");
    for (pl_u32 row = 0u; row < 32u; ++row) {
        pl_u32 best = 0u;
        pl_u64 count = 0u;
        for (pl_u32 mnemonic = 0u;
                mnemonic <= (pl_u32)ZYDIS_MNEMONIC_MAX_VALUE; ++mnemonic) {
            if (!shown[mnemonic]
                    && catalog->unsupported_mnemonic[mnemonic] > count) {
                best = mnemonic;
                count = catalog->unsupported_mnemonic[mnemonic];
            }
        }
        if (!count) break;
        shown[best] = 1u;
        const char *name = ZydisMnemonicGetString((ZydisMnemonic)best);
        printf("  %-20s coordinates=%10llu\n",
               name ? name : "unknown", (unsigned long long)count);
    }
    for (pl_u32 mnemonic = 0u;
            mnemonic <= (pl_u32)ZYDIS_MNEMONIC_MAX_VALUE; ++mnemonic)
        shown[mnemonic] = 0u;
    printf("grammar-miss mnemonic leaders\n");
    for (pl_u32 row = 0u; row < 32u; ++row) {
        pl_u32 best = 0u;
        pl_u64 count = 0u;
        for (pl_u32 mnemonic = 0u;
                mnemonic <= (pl_u32)ZYDIS_MNEMONIC_MAX_VALUE; ++mnemonic) {
            if (!shown[mnemonic]
                    && catalog->grammar_miss_mnemonic[mnemonic] > count) {
                best = mnemonic;
                count = catalog->grammar_miss_mnemonic[mnemonic];
            }
        }
        if (!count) break;
        shown[best] = 1u;
        const char *name = ZydisMnemonicGetString((ZydisMnemonic)best);
        const semantic_example *example = &catalog->grammar_example[best];
        printf("  %-20s coordinates=%10llu example=%llx/%u bytes=",
               name ? name : "unknown", (unsigned long long)count,
               (unsigned long long)example->rip, example->visible);
        for (pl_u32 index = 0u; index < example->length; ++index)
            printf("%02x", example->source[index]);
        pl_u32 operands = example->visible < 3u ? example->visible : 3u;
        for (pl_u32 index = 0u; index < operands; ++index) {
            printf(" %u:%u:%u", example->kind[index],
                   example->register_class[index], example->bits[index]);
            if (example->kind[index] == PL_X86_OPERAND_REGISTER)
                printf("/reg=%u:%u", example->register_index[index],
                       example->register_flags[index]);
            if (example->kind[index] == PL_X86_OPERAND_MEMORY)
                printf("/seg=%u:%u", example->segment_class[index],
                       example->segment_index[index]);
        }
        printf(" flags=%x machine=%u:%llx status=%d\n", example->flags,
               example->machine_operation,
               (unsigned long long)example->machine_argument,
               example->lower_status);
    }
    for (pl_u32 mnemonic = 0u;
            mnemonic <= (pl_u32)ZYDIS_MNEMONIC_MAX_VALUE; ++mnemonic)
        shown[mnemonic] = 0u;
    printf("machine-barrier mnemonic leaders\n");
    for (pl_u32 row = 0u; row < 32u; ++row) {
        pl_u32 best = 0u;
        pl_u64 count = 0u;
        for (pl_u32 mnemonic = 0u;
                mnemonic <= (pl_u32)ZYDIS_MNEMONIC_MAX_VALUE; ++mnemonic) {
            if (!shown[mnemonic]
                    && catalog->barrier_mnemonic[mnemonic] > count) {
                best = mnemonic;
                count = catalog->barrier_mnemonic[mnemonic];
            }
        }
        if (!count) break;
        shown[best] = 1u;
        const char *name = ZydisMnemonicGetString((ZydisMnemonic)best);
        const semantic_example *example = &catalog->barrier_example[best];
        printf("  %-20s coordinates=%10llu example=%llx/%u bytes=",
               name ? name : "unknown", (unsigned long long)count,
               (unsigned long long)example->rip, example->visible);
        for (pl_u32 index = 0u; index < example->length; ++index)
            printf("%02x", example->source[index]);
        pl_u32 operands = example->visible < 3u ? example->visible : 3u;
        for (pl_u32 index = 0u; index < operands; ++index) {
            printf(" %u:%u:%u", example->kind[index],
                   example->register_class[index], example->bits[index]);
            if (example->kind[index] == PL_X86_OPERAND_REGISTER)
                printf("/reg=%u:%u", example->register_index[index],
                       example->register_flags[index]);
            if (example->kind[index] == PL_X86_OPERAND_MEMORY)
                printf("/seg=%u:%u", example->segment_class[index],
                       example->segment_index[index]);
        }
        printf(" flags=%x machine=%u:%llx status=%d\n", example->flags,
               example->machine_operation,
               (unsigned long long)example->machine_argument,
               example->lower_status);
    }
}

static int semantic_catalog_is_complete(const semantic_catalog *catalog)
{
    pl_u64 lowered = 0u;
    for (pl_u32 operation = 0u;
            operation <= PL_X86_OPERATION_MAX; ++operation)
        lowered += catalog->lowered[operation];
    return catalog->valid == lowered
        && !catalog->grammar_misses
        && !catalog->barrier_misses
        && !catalog->arena_failures;
}

static int transfer_hash_slots(pl_u32 capacity, pl_u32 *slots);

static int grow_transfer_builder(operation_catalog *catalog)
{
    pl_transfer_builder *builder = catalog->transfers;
    if (builder->identity_capacity >= catalog->identity_limit)
        return PL_ERROR_TRANSFER_CAPACITY;
    pl_u32 capacity = builder->identity_capacity;
    if (capacity > catalog->identity_limit - capacity)
        capacity = catalog->identity_limit;
    else
        capacity *= 2u;
    pl_u32 slot_count = 0u;
    int status = transfer_hash_slots(capacity, &slot_count);
    if (status) return status;
    pl_transfer_identity *identities = realloc(
        builder->identities, (size_t)capacity * sizeof *identities);
    if (!identities) return PL_ERROR_TRANSFER_CAPACITY;
    builder->identities = identities;
    pl_u32 *slots = calloc(slot_count, sizeof *slots);
    if (!slots) return PL_ERROR_TRANSFER_CAPACITY;
    pl_u32 mask = slot_count - 1u;
    for (pl_u32 rank = 0u; rank < builder->identity_count; ++rank) {
        pl_u64 hash = identities[rank].hash;
        pl_u32 slot = (pl_u32)(hash ^ (hash >> 32u)) & mask;
        while (slots[slot]) slot = (slot + 1u) & mask;
        slots[slot] = rank + 1u;
    }
    free(builder->hash_slots);
    builder->identity_capacity = capacity;
    builder->hash_slots = slots;
    builder->hash_slot_count = slot_count;
    return 0;
}

static int intern_transfer(const pl_x86_instruction *instruction,
                           void *opaque)
{
    operation_catalog *catalog = opaque;
    pl_u32 before = catalog->transfers->identity_count;
    pl_u32 rank = 0u;
    int status = pl_transfer_intern(
        catalog->transfers, instruction, &rank);
    if (status == PL_ERROR_TRANSFER_CAPACITY) {
        status = grow_transfer_builder(catalog);
        if (!status)
            status = pl_transfer_intern(
                catalog->transfers, instruction, &rank);
    }
    if (status) return status;
    ZydisMnemonic operation = ZYDIS_MNEMONIC_INVALID;
    if (instruction->status == PL_X86_DECODE_VALID) {
        ZydisDecodedInstruction decoded;
        ZyanStatus result = ZydisDecoderDecodeInstruction(
            &catalog->decoder, NULL, instruction->source,
            instruction->source_bytes, &decoded);
        if (!ZYAN_SUCCESS(result)) return PL_ERROR_X86;
        operation = decoded.mnemonic;
    }
    ++catalog->coordinates[operation];
    if (catalog->transfers->identity_count != before)
        ++catalog->classes[operation];
    return 0;
}

typedef struct {
    ZydisMnemonic operation;
    pl_u64 coordinates;
    pl_u64 classes;
} operation_row;

static int operation_more_classes(const void *left, const void *right)
{
    const operation_row *a = left, *b = right;
    if (a->classes < b->classes) return 1;
    if (a->classes > b->classes) return -1;
    if (a->coordinates < b->coordinates) return 1;
    if (a->coordinates > b->coordinates) return -1;
    return (int)a->operation - (int)b->operation;
}

static void print_operation_catalog(const operation_catalog *catalog)
{
    operation_row rows[ZYDIS_MNEMONIC_MAX_VALUE + 1u];
    pl_u32 count = 0u;
    for (pl_u32 operation = 0u;
            operation <= (pl_u32)ZYDIS_MNEMONIC_MAX_VALUE; ++operation) {
        if (!catalog->coordinates[operation]) continue;
        rows[count].operation = (ZydisMnemonic)operation;
        rows[count].coordinates = catalog->coordinates[operation];
        rows[count].classes = catalog->classes[operation];
        ++count;
    }
    qsort(rows, count, sizeof rows[0], operation_more_classes);
    printf("operation kinds   %u\n", count);
    pl_u32 shown = count < 32u ? count : 32u;
    for (pl_u32 index = 0u; index < shown; ++index) {
        const char *name = rows[index].operation == ZYDIS_MNEMONIC_INVALID
                         ? "fault" : ZydisMnemonicGetString(
                             rows[index].operation);
        printf("  %-15s classes=%10llu coordinates=%10llu\n",
               name ? name : "unknown",
               (unsigned long long)rows[index].classes,
               (unsigned long long)rows[index].coordinates);
    }
}

/* Equal backing maps can differ only in the at-most-15-byte fetch window at
 * their right boundary.  Count one complete copy and one boundary allowance
 * per alias.  This is a safe capacity bound without allocating one identity
 * row for both physical and virtual coordinates. */
static int transfer_identity_capacity(const pl_x86_image *image,
                                      pl_u32 *capacity)
{
    pl_u64 total = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        int repeated = 0;
        for (pl_u32 prior = 0u; prior < index; ++prior) {
            const pl_x86_map *candidate = &image->maps[prior];
            if (map->bytes == candidate->bytes
                    && map->file_bytes == candidate->file_bytes
                    && map->memory_bytes == candidate->memory_bytes) {
                repeated = 1;
                break;
            }
        }
        pl_u64 added = repeated
                     ? (map->memory_bytes < PL_X86_MAX_INSTRUCTION_BYTES
                        ? map->memory_bytes : PL_X86_MAX_INSTRUCTION_BYTES)
                     : map->memory_bytes;
        if (added > 0xffffffffull
                || total > 0xffffffffull - added)
            return PL_ERROR_TRANSFER_CAPACITY;
        total += added;
    }
    if (!total) return PL_ERROR_TRANSFER;
    *capacity = (pl_u32)total;
    return 0;
}

static int transfer_hash_slots(pl_u32 capacity, pl_u32 *slots)
{
    pl_u32 value = 1u;
    while (value <= capacity) {
        if (value > 0x7fffffffu) return PL_ERROR_TRANSFER_CAPACITY;
        value <<= 1u;
    }
    *slots = value;
    return 0;
}

int main(int argc, char **argv)
{
    int completeness_failed = 0;
    int catalog_coordinates = argc == 3
        && (!strcmp(argv[2], "--coordinates")
            || !strcmp(argv[2], "--physical-coordinates")
            || !strcmp(argv[2], "--alias-coordinates")
            || !strcmp(argv[2], "--alias-transfers")
            || !strcmp(argv[2], "--semantics")
            || !strcmp(argv[2], "--alias-semantics")
            || !strcmp(argv[2], "--require-semantics")
            || !strcmp(argv[2], "--alias-require-semantics"));
    if (argc < 2 || argc > 3 || (argc == 3 && !catalog_coordinates)) {
        fprintf(stderr,
                "usage: postlink-elf PROGRAM [--coordinates|--physical-coordinates|--alias-coordinates|--alias-transfers|--semantics|--alias-semantics|--require-semantics|--alias-require-semantics]\n");
        return 2;
    }
    FILE *handle = fopen(argv[1], "rb");
    if (!handle) { fprintf(stderr, "cannot open %s\n", argv[1]); return 1; }
    if (fseek(handle, 0, SEEK_END)) return 1;
    long size = ftell(handle);
    if (size < 0 || fseek(handle, 0, SEEK_SET)) return 1;
    pl_u8 *bytes = size ? malloc((size_t)size) : 0;
    if (!bytes || fread(bytes, 1, (size_t)size, handle) != (size_t)size) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 1;
    }
    fclose(handle);
    pl_elf_image image;
    if (pl_elf_open(bytes, (pl_u64)size, &image)) {
        fprintf(stderr, "%s is not a supported linked x86-64 ELF\n", argv[1]);
        return 1;
    }
    printf("type              %s\n",
           image.type == PL_ELF_TYPE_EXEC ? "ET_EXEC" : "ET_DYN");
    printf("entry             0x%016llx\n",
           (unsigned long long)image.entry);
    printf("program headers   %u\n", image.program_count);
    pl_u32 executable = 0;
    for (pl_u32 index = 0; index < image.program_count; ++index) {
        pl_elf_segment segment;
        if (pl_elf_program(&image, index, &segment)) {
            fprintf(stderr, "program header %u is malformed\n", index);
            return 1;
        }
        if (!pl_elf_segment_is_executable(&segment)) continue;
        executable += 1u;
        printf("  execute[%u]     vaddr=0x%016llx file=0x%llx+0x%llx memory=0x%llx\n",
               executable - 1u,
               (unsigned long long)segment.virtual_address,
               (unsigned long long)segment.file_offset,
               (unsigned long long)segment.file_bytes,
               (unsigned long long)segment.memory_bytes);
    }
    printf("executable maps   %u\n", executable);
    if (argc == 3) {
        pl_u32 map_count = 0u;
        int status = pl_x86_elf_map_count(&image, &map_count);
        if (status) return 1;
        printf("compiler maps     %u\n", map_count);
        int aliases = !strcmp(argv[2], "--alias-coordinates")
                   || !strcmp(argv[2], "--alias-transfers")
                   || !strcmp(argv[2], "--alias-semantics")
                   || !strcmp(argv[2], "--alias-require-semantics");
        int report_transfers = !strcmp(argv[2], "--alias-transfers");
        int report_semantics = !strcmp(argv[2], "--semantics")
                            || !strcmp(argv[2], "--alias-semantics")
                            || !strcmp(argv[2], "--require-semantics")
                            || !strcmp(argv[2], "--alias-require-semantics");
        int require_semantics = !strcmp(argv[2], "--require-semantics")
                             || !strcmp(argv[2],
                                        "--alias-require-semantics");
        if (aliases && map_count > 0x7fffffffu) return 1;
        pl_u32 map_capacity = aliases ? map_count * 2u : map_count;
        pl_x86_map *maps = map_capacity
                         ? malloc((size_t)map_capacity * sizeof *maps) : NULL;
        if (map_count && !maps) return 1;
        pl_x86_image source;
        pl_u32 coordinate_kind = !strcmp(argv[2], "--physical-coordinates")
                               ? PL_X86_ELF_PHYSICAL
                               : PL_X86_ELF_VIRTUAL;
        status = aliases
               ? pl_x86_image_from_elf_aliases(
                   &image, 0u, 0u, 0u, maps, map_capacity, &source)
               : pl_x86_image_from_elf_coordinates(
                   &image, 0u, 0u, coordinate_kind,
                   maps, map_capacity, &source);
        if (status) {
            fprintf(stderr, "cannot project executable maps: %d\n", status);
            free(maps);
            free(bytes);
            return 1;
        }
        pl_transfer_identity *identities = NULL;
        pl_u32 *transfer_slots = NULL;
        pl_transfer_builder transfers;
        operation_catalog operations;
        semantic_catalog semantics;
        memset(&semantics, 0, sizeof semantics);
        if (report_semantics) {
            ZyanStatus decoder_status = ZydisDecoderInit(
                &semantics.decoder, ZYDIS_MACHINE_MODE_LONG_64,
                ZYDIS_STACK_WIDTH_64);
            if (!ZYAN_SUCCESS(decoder_status)) {
                fprintf(stderr, "cannot initialize semantic catalog\n");
                free(maps);
                free(bytes);
                return 1;
            }
        }
        if (report_transfers) {
            pl_u32 identity_limit = 0u;
            pl_u32 identity_capacity = 0u;
            pl_u32 hash_slot_count = 0u;
            status = transfer_identity_capacity(&source, &identity_limit);
            identity_capacity = identity_limit < 65536u
                              ? identity_limit : 65536u;
            if (!status)
                status = transfer_hash_slots(
                    identity_capacity, &hash_slot_count);
            if (status) {
                fprintf(stderr, "transfer capacity is not representable: %d\n",
                        status);
                free(maps);
                free(bytes);
                return 1;
            }
            identities = malloc(
                (size_t)identity_capacity * sizeof *identities);
            transfer_slots = malloc(
                (size_t)hash_slot_count * sizeof *transfer_slots);
            if (!identities || !transfer_slots) {
                fprintf(stderr,
                        "cannot allocate bounded transfer-class workspace\n");
                free(transfer_slots);
                free(identities);
                free(maps);
                free(bytes);
                return 1;
            }
            status = pl_transfer_builder_open(
                &transfers, &source, identities, identity_capacity,
                transfer_slots, hash_slot_count);
            if (status) {
                fprintf(stderr, "cannot open transfer classes: %d\n", status);
                free(transfer_slots);
                free(identities);
                free(maps);
                free(bytes);
                return 1;
            }
            memset(&operations, 0, sizeof operations);
            operations.transfers = &transfers;
            operations.identity_limit = identity_limit;
            ZyanStatus decoder_status = ZydisDecoderInit(
                &operations.decoder, ZYDIS_MACHINE_MODE_LONG_64,
                ZYDIS_STACK_WIDTH_64);
            if (!ZYAN_SUCCESS(decoder_status)) {
                fprintf(stderr, "cannot initialize operation catalog\n");
                free(transfer_slots);
                free(identities);
                free(maps);
                free(bytes);
                return 1;
            }
            printf("transfer limit    %u classes\n", identity_limit);
        }
        pl_x86_catalog catalog;
        status = pl_x86_catalog_image(
            &source,
            report_transfers ? intern_transfer
                             : report_semantics ? catalog_semantic : NULL,
            report_transfers ? (void *)&operations
                             : report_semantics ? (void *)&semantics : NULL,
            &catalog);
        if (report_transfers) {
            identities = transfers.identities;
            transfer_slots = transfers.hash_slots;
        }
        if (status) {
            fprintf(stderr, "cannot catalog x86 coordinates: %d\n", status);
            free(transfer_slots);
            free(identities);
            free(maps);
            free(bytes);
            return 1;
        }
        printf("coordinate space  %s\n",
               aliases ? "physical+virtual"
                       : coordinate_kind == PL_X86_ELF_PHYSICAL
                           ? "physical" : "virtual");
        printf("entry mapped      %s\n",
               pl_x86_image_contains(&source, source.entry) ? "yes" : "no");
        printf("coordinates       %llu\n",
               (unsigned long long)catalog.coordinates);
        printf("decoded           %llu\n",
               (unsigned long long)catalog.decoded);
        printf("invalid faults    %llu\n",
               (unsigned long long)catalog.invalid);
        printf("overlong faults   %llu\n",
               (unsigned long long)catalog.overlong);
        printf("fetch faults      %llu\n",
               (unsigned long long)catalog.fetch_faults);
        printf("fault functions   %llu\n",
               (unsigned long long)catalog.fault_functions);
        printf("precise cuts      %llu\n",
               (unsigned long long)catalog.precise_cuts);
        printf("direct edges      %llu\n",
               (unsigned long long)catalog.direct_edges);
        printf("direct in image   %llu\n",
               (unsigned long long)catalog.direct_edges_in_image);
        printf("direct outside    %llu\n",
               (unsigned long long)catalog.direct_edges_outside_image);
        printf("indirect edges    %llu\n",
               (unsigned long long)catalog.indirect_edges);
        if (report_transfers) {
            printf("transfer workspace %u classes, %u hash slots, %llu temporary bytes\n",
                   transfers.identity_capacity, transfers.hash_slot_count,
                   (unsigned long long)transfers.identity_capacity
                       * sizeof *identities
                   + (unsigned long long)transfers.hash_slot_count
                       * sizeof *transfer_slots);
            printf("transfer classes %u\n", transfers.identity_count);
            printf("shared transfers %llu\n",
                   (unsigned long long)transfers.shared);
            printf("transfer probes  %llu\n",
                   (unsigned long long)transfers.probes);
            printf("maximum probe    %u\n", transfers.maximum_probe);
            print_operation_catalog(&operations);
            free(transfer_slots);
            free(identities);
        }
        if (report_semantics) {
            print_semantic_catalog(&semantics);
            if (require_semantics
                    && !semantic_catalog_is_complete(&semantics)) {
                fprintf(stderr,
                        "semantic completeness: RED (linked image has coordinates without direct semantics)\n");
                completeness_failed = 1;
            } else if (require_semantics) {
                printf("semantic completeness: green\n");
            }
        }
        free(maps);
    }
    free(bytes);
    return executable && !completeness_failed ? 0 : 1;
}
