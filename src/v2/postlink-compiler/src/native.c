/* Reachable native block closure without a decoded-row or graph artifact. */

#include "internal/native.h"
#include "internal/quotient.h"
#include "internal/select-x86.h"

#include <support/arena.h>
#include <support/checked.h>

#include <stdint.h>

#define NATIVE_ARENA_BYTES (1024u * 1024u)
#define NATIVE_RANK_COORDINATES 256u

typedef struct {
    const pl_x86_image *image;
    const pl_elf_image *construction;
    pl_u64 construction_bias;
    int construction_bias_valid;
    pl_x86_frontend frontend;
    pl_u8 *boundary;
    pl_u8 *expanded;
    pl_u8 *scanned;
    pl_u8 *covered;
    pl_u8 *relax_large;
    pl_u8 *construction_fields;
    pl_u8 *function_starts;
    /* Complete-future architectural frontier, indexed by boundary rank.
     * This is transient compiler proof state and never part of the ELF. */
    const pl_u32 *live_outputs;
    pl_u32 live_output_count;
    pl_u32 *queue;
    pl_u32 *rank_prefix;
    pl_u32 *relax_prefix;
    pl_u32 rank_prefix_count;
    pl_u8 *relax_pending;
    pl_u32 relax_pending_bytes;
    pl_u32 coordinate_count;
    pl_u32 queue_count;
    pl_u32 queue_cursor;
    pl_u32 output_bytes;
    pl_u32 selection_span_ceiling;
    pl_u32 selection_work_ceiling;
    int selection_limits_valid;
    pl_x86_block_workspace formation;
    pl_x86_block_workspace selection;
    pl_x86_native_population *population;
} native_builder;

static int form_at_limit(const native_builder *builder, pl_u32 coordinate,
                         pl_x86_block *block, pl_u64 *formation_limit);
static int final_block_instruction(const native_builder *builder,
                                   const pl_x86_block *block,
                                   pl_x86_instruction *out);

static int add_u64(pl_u64 *value, pl_u64 addend)
{
    return pl_checked_add_u64(*value, addend, value);
}

static int align_u64(pl_u64 value, pl_u64 alignment, pl_u64 *out)
{
    pl_u64 remainder = value & (alignment - 1u);
    return !remainder
         ? (*out = value, 1)
         : pl_checked_add_u64(value, alignment - remainder, out);
}

/* A hierarchy stores one bit per item, then one bit per nonempty byte of the
 * preceding level.  It is a queue set with O(log_8 N) insert/remove/select
 * and only N/7+O(log N) bytes. */
static int bit_hierarchy_measure(pl_u64 bits, pl_u64 *bytes)
{
    pl_u64 total = 0u;
    if (!bits || !bytes) return 0;
    for (;;) {
        pl_u64 level = (bits + 7u) >> 3u;
        if (!pl_checked_add_u64(total, level, &total)) return 0;
        if (level == 1u) break;
        bits = level;
    }
    *bytes = total;
    return 1;
}

static int coordinate_population(const pl_x86_image *image, pl_u64 *out)
{
    pl_u64 count = 0u;
    if (!image || !out) return PL_ERROR_BLOCK;
    for (pl_u32 index = 0u; index < image->map_count; ++index)
        if (!pl_checked_add_u64(
                count, image->maps[index].memory_bytes, &count))
            return PL_ERROR_BLOCK_LIMIT;
    if (!count || count > 0xffffffffu) return PL_ERROR_BLOCK_LIMIT;
    *out = count;
    return 0;
}

int pl_x86_native_workspace_measure(pl_u64 executable_coordinates,
                                    pl_u64 *workspace_bytes)
{
    pl_u64 bit_bytes;
    pl_u64 queue_bytes;
    pl_u64 prefix_entries;
    pl_u64 prefix_bytes;
    pl_u64 pending_bytes;
    pl_u64 total;
    if (!workspace_bytes || !executable_coordinates
            || executable_coordinates > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    bit_bytes = (executable_coordinates + 7u) >> 3u;
    prefix_entries = (executable_coordinates
                    + NATIVE_RANK_COORDINATES - 1u)
                   / NATIVE_RANK_COORDINATES + 1u;
    if (!pl_checked_mul_u64(
            executable_coordinates, (pl_u64)sizeof(pl_u32), &queue_bytes)
            || !pl_checked_mul_u64(
                prefix_entries, (pl_u64)sizeof(pl_u32), &prefix_bytes)
            || !bit_hierarchy_measure(
                (executable_coordinates + 1u) >> 1u, &pending_bytes)
            || !pl_checked_add_u64(bit_bytes, bit_bytes, &total)
            || !pl_checked_add_u64(total, bit_bytes, &total)
            || !pl_checked_add_u64(total, bit_bytes, &total)
            || !pl_checked_add_u64(total, bit_bytes, &total)
            || !pl_checked_add_u64(total, bit_bytes, &total)
            || !pl_checked_add_u64(total, bit_bytes, &total)
            || !align_u64(total, (pl_u64)sizeof(pl_u32), &total)
            || !pl_checked_add_u64(total, queue_bytes, &total)
            || !pl_checked_add_u64(total, prefix_bytes, &total)
            || !pl_checked_add_u64(total, prefix_bytes, &total)
            || !pl_checked_add_u64(total, pending_bytes, &total)
            || !align_u64(total, 16u, &total)
            || !pl_checked_add_u64(
                total, 4u * (pl_u64)NATIVE_ARENA_BYTES, &total))
        return PL_ERROR_BLOCK_LIMIT;
    *workspace_bytes = total;
    return 0;
}

static pl_u32 popcount_byte(pl_u8 value)
{
    value = (pl_u8)(value - ((value >> 1u) & 0x55u));
    value = (pl_u8)((value & 0x33u) + ((value >> 2u) & 0x33u));
    return (pl_u32)((value + (value >> 4u)) & 0x0fu);
}

static int bit_get(const pl_u8 *bits, pl_u32 coordinate);

static int boundary_rank(const native_builder *builder, pl_u32 coordinate,
                         pl_u32 *rank)
{
    if (!builder || !rank || !builder->boundary || !builder->rank_prefix
            || coordinate >= builder->coordinate_count
            || !bit_get(builder->boundary, coordinate))
        return PL_ERROR_BLOCK;
    pl_u32 page = coordinate / NATIVE_RANK_COORDINATES;
    if (page + 1u >= builder->rank_prefix_count)
        return PL_ERROR_BLOCK;
    pl_u32 value = builder->rank_prefix[page];
    pl_u32 first_byte = (page * NATIVE_RANK_COORDINATES) >> 3u;
    pl_u32 last_byte = coordinate >> 3u;
    for (pl_u32 byte = first_byte; byte < last_byte; ++byte)
        value += popcount_byte(builder->boundary[byte]);
    pl_u32 remainder = coordinate & 7u;
    if (remainder) {
        pl_u8 mask = (pl_u8)((1u << remainder) - 1u);
        value += popcount_byte(
            (pl_u8)(builder->boundary[last_byte] & mask));
    }
    *rank = value;
    return 0;
}

static int address_coordinate(const pl_x86_image *image, pl_u64 address,
                              pl_u32 *coordinate, pl_u32 *map_index)
{
    pl_u64 base = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        if (address >= map->address
                && address - map->address < map->memory_bytes) {
            pl_u64 value = base + address - map->address;
            if (value > 0xffffffffu) return 0;
            if (coordinate) *coordinate = (pl_u32)value;
            if (map_index) *map_index = index;
            return 1;
        }
        base += map->memory_bytes;
    }
    return 0;
}

static int coordinate_address(const pl_x86_image *image, pl_u32 coordinate,
                              pl_u64 *address, pl_u32 *map_index,
                              pl_u64 *map_end)
{
    pl_u64 base = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        if ((pl_u64)coordinate - base < map->memory_bytes) {
            pl_u64 offset = (pl_u64)coordinate - base;
            if (address) *address = map->address + offset;
            if (map_index) *map_index = index;
            if (map_end) *map_end = map->address + map->memory_bytes;
            return 1;
        }
        base += map->memory_bytes;
        if ((pl_u64)coordinate < base) return 0;
    }
    return 0;
}

static int bit_get(const pl_u8 *bits, pl_u32 coordinate)
{
    return (bits[coordinate >> 3u] >> (coordinate & 7u)) & 1u;
}

static void bit_set(pl_u8 *bits, pl_u32 coordinate)
{
    bits[coordinate >> 3u] |= (pl_u8)(1u << (coordinate & 7u));
}

static void bit_clear(pl_u8 *bits, pl_u32 coordinate)
{
    bits[coordinate >> 3u] &=
        (pl_u8)~(pl_u8)(1u << (coordinate & 7u));
}

static int control_relaxed_at(const native_builder *builder,
                              pl_u32 coordinate)
{
    if (!builder) return 0;
    return bit_get(builder->covered, coordinate)
        || bit_get(builder->relax_large, coordinate)
        || bit_get(builder->function_starts, coordinate);
}

static void publish_relaxed_controls(native_builder *builder)
{
    if (!builder) return;
    for (pl_u32 coordinate = 0u;
            coordinate < builder->coordinate_count; ++coordinate)
        if (control_relaxed_at(builder, coordinate))
            bit_set(builder->covered, coordinate);
}

static pl_u32 hierarchy_levels(pl_u32 bits, pl_u32 extent[16])
{
    pl_u32 levels = 0u;
    while (bits && levels < 16u) {
        extent[levels++] = (bits + 7u) >> 3u;
        if (extent[levels - 1u] == 1u) break;
        bits = extent[levels - 1u];
    }
    return levels;
}

static int hierarchy_layout(pl_u32 bits, pl_u32 capacity,
                            pl_u32 extent[16], pl_u32 offset[16],
                            pl_u32 *levels)
{
    if (!bits || !extent || !offset || !levels) return 0;
    *levels = hierarchy_levels(bits, extent);
    if (!*levels || *levels >= 16u) return 0;
    pl_u64 at = 0u;
    for (pl_u32 level = 0u; level < *levels; ++level) {
        if (at > 0xffffffffu) return 0;
        offset[level] = (pl_u32)at;
        at += extent[level];
    }
    return at <= capacity;
}

static int hierarchy_set(pl_u8 *tree, pl_u32 capacity,
                         pl_u32 bits, pl_u32 item)
{
    pl_u32 extent[16], offset[16], levels;
    if (!tree || item >= bits || !hierarchy_layout(
            bits, capacity, extent, offset, &levels))
        return 0;
    pl_u32 index = item;
    for (pl_u32 level = 0u; level < levels; ++level) {
        pl_u32 byte = index >> 3u;
        pl_u8 mask = (pl_u8)(1u << (index & 7u));
        pl_u8 *word = tree + offset[level] + byte;
        int was_empty = !*word;
        *word |= mask;
        if (!was_empty) break;
        index = byte;
    }
    return 1;
}

static int hierarchy_take(pl_u8 *tree, pl_u32 capacity,
                          pl_u32 bits, pl_u32 *item)
{
    pl_u32 extent[16], offset[16], levels;
    if (!tree || !item || !hierarchy_layout(
            bits, capacity, extent, offset, &levels))
        return 0;
    pl_u8 top = tree[offset[levels - 1u]];
    if (!top) return 0;
    pl_u32 index = 0u;
    for (pl_u32 bit = 0u; bit < 8u; ++bit)
        if (top & (pl_u8)(1u << bit)) {
            index = bit;
            break;
        }
    for (pl_u32 level = levels - 1u; level-- > 0u;) {
        if (index >= extent[level]) return 0;
        pl_u8 word = tree[offset[level] + index];
        if (!word) return 0;
        pl_u32 bit = 0u;
        while (!(word & (pl_u8)(1u << bit))) ++bit;
        index = (index << 3u) + bit;
    }
    if (index >= bits) return 0;
    *item = index;

    /* Clear the selected leaf and propagate only across newly empty bytes. */
    pl_u32 child = index;
    for (pl_u32 level = 0u; level < levels; ++level) {
        pl_u32 byte = child >> 3u;
        pl_u8 *word = tree + offset[level] + byte;
        *word &= (pl_u8)~(pl_u8)(1u << (child & 7u));
        if (*word) break;
        child = byte;
    }
    return 1;
}

/* Select the first marked coordinate strictly after `coordinate`.  Boundary
 * populations are sparse in real linked images; walking every intervening
 * source byte from every block made formation quadratic in that sparsity.
 * The bit word is already the canonical population, so skip empty bytes and
 * inspect at most one bit byte at either end. */
static int bit_next(const pl_u8 *bits, pl_u32 coordinates,
                    pl_u32 coordinate, pl_u32 *next)
{
    if (!bits || !next || !coordinates
            || coordinate >= coordinates - 1u) return 0;
    pl_u32 candidate = coordinate + 1u;
    pl_u32 byte = candidate >> 3u;
    pl_u32 byte_count = (coordinates + 7u) >> 3u;
    pl_u8 word = bits[byte];
    word &= (pl_u8)(0xffu << (candidate & 7u));
    for (;;) {
        if (word) {
            pl_u32 bit = 0u;
            while (!(word & (pl_u8)(1u << bit))) ++bit;
            pl_u32 selected = (byte << 3u) + bit;
            if (selected >= coordinates) return 0;
            *next = selected;
            return 1;
        }
        if (++byte >= byte_count) return 0;
        word = bits[byte];
    }
}

/* Inclusive predecessor select for the same canonical bit population. */
static int bit_previous(const pl_u8 *bits, pl_u32 coordinates,
                        pl_u32 coordinate, pl_u32 *previous)
{
    if (!bits || !previous || !coordinates) return 0;
    if (coordinate >= coordinates) coordinate = coordinates - 1u;
    pl_u32 byte = coordinate >> 3u;
    pl_u32 remainder = coordinate & 7u;
    pl_u8 word = bits[byte];
    word &= remainder == 7u
        ? 0xffu : (pl_u8)((1u << (remainder + 1u)) - 1u);
    for (;;) {
        if (word) {
            pl_u32 bit = 8u;
            while (!(word & (pl_u8)(1u << --bit))) { }
            *previous = (byte << 3u) + bit;
            return 1;
        }
        if (!byte) return 0;
        word = bits[--byte];
    }
}

static int mark_construction_fields(native_builder *builder,
                                    const pl_elf_image *elf)
{
    if (!elf) return 0;
    if (!builder || !builder->construction_fields) return PL_ERROR_BLOCK;
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section relocations;
        int status = pl_elf_section_read(elf, section_index, &relocations);
        if (status) return status;
        if (relocations.type != PL_ELF_SECTION_RELA
                || !relocations.info)
            continue;
        pl_elf_section target;
        status = pl_elf_section_read(elf, relocations.info, &target);
        if (status) return status;
        if (!pl_elf_section_is_executable(&target)) continue;
        if (relocations.entry_bytes != PL_ELF_RELOCATION_BYTES
                || relocations.file_bytes % relocations.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 count = relocations.file_bytes / relocations.entry_bytes;
        for (pl_u64 row = 0u; row < count; ++row) {
            pl_elf_relocation relocation;
            pl_u32 coordinate;
            status = pl_elf_relocation_read(
                elf, section_index, row, &relocation);
            if (status) return status;
            if (!address_coordinate(
                    builder->image, relocation.offset, &coordinate, 0))
                return PL_ERROR_BLOCK;
            bit_set(builder->construction_fields, coordinate);
        }
    }
    return 0;
}

/* Same-section local references may be fully resolved by the linker and have
 * no relocation row even under --emit-relocs.  Keep one ephemeral bit per
 * executable coordinate so a reachable LEA can distinguish a function entry
 * from an immutable string in PF_X without an instruction-by-symbol scan. */
static int mark_function_starts(native_builder *builder,
                                const pl_elf_image *elf)
{
    if (!elf) return 0;
    if (!builder || !builder->function_starts) return PL_ERROR_BLOCK;
    int have_static = 0;
    for (pl_u32 index = 0u; index < elf->section_count; ++index) {
        pl_elf_section section;
        int status = pl_elf_section_read(elf, index, &section);
        if (status) return status;
        if (section.type == PL_ELF_SECTION_SYMTAB) {
            have_static = 1;
            break;
        }
    }
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section symbols;
        int status = pl_elf_section_read(elf, section_index, &symbols);
        if (status) return status;
        if (symbols.type != (have_static
                ? PL_ELF_SECTION_SYMTAB : PL_ELF_SECTION_DYNSYM))
            continue;
        if (symbols.entry_bytes != PL_ELF_SYMBOL_BYTES
                || symbols.file_bytes % symbols.entry_bytes)
            return PL_ERROR_ELF;
        pl_u64 count = symbols.file_bytes / symbols.entry_bytes;
        if (count > 0xffffffffu) return PL_ERROR_BLOCK_LIMIT;
        for (pl_u32 index = 0u; index < (pl_u32)count; ++index) {
            pl_elf_symbol symbol;
            pl_elf_section target;
            status = pl_elf_symbol_read(
                elf, section_index, index, &symbol);
            if (status) return status;
            if (symbol.type != PL_ELF_SYMBOL_FUNCTION
                    || !symbol.section_index
                    || symbol.section_index >= elf->section_count)
                continue;
            status = pl_elf_section_read(
                elf, symbol.section_index, &target);
            if (status) return status;
            if (!pl_elf_section_is_executable(&target)
                    || symbol.value < target.address
                    || symbol.value - target.address >= target.memory_bytes)
                continue;
            pl_u32 coordinate;
            if (!address_coordinate(
                    builder->image, symbol.value, &coordinate, 0))
                return PL_ERROR_BLOCK;
            bit_set(builder->function_starts, coordinate);
        }
    }
    return 0;
}

static int find_construction_bias(const pl_elf_image *elf,
                                  const pl_x86_image *image,
                                  pl_u64 *bias)
{
    if (!elf || !image || !bias) return 0;
    for (pl_u32 section_index = 0u;
            section_index < elf->section_count; ++section_index) {
        pl_elf_section section;
        if (pl_elf_section_read(elf, section_index, &section)) return 0;
        if (!pl_elf_section_is_executable(&section)
                || !section.file_bytes
                || section.file_offset > elf->length
                || section.file_bytes > elf->length - section.file_offset)
            continue;
        const pl_u8 *bytes = elf->bytes + section.file_offset;
        for (pl_u32 map = 0u; map < image->map_count; ++map)
            if (image->maps[map].bytes == bytes
                    && image->maps[map].file_bytes >= section.file_bytes) {
                *bias = image->maps[map].address - section.address;
                return 1;
            }
    }
    return 0;
}

static int immutable_scalar(const native_builder *builder,
                            pl_u64 address, pl_u32 bytes, pl_u64 *out)
{
    if (!builder || !builder->construction
            || !builder->construction_bias_valid || !out
            || !bytes || bytes > 8u)
        return 0;
    const pl_elf_image *elf = builder->construction;
    for (pl_u32 index = 0u; index < elf->program_count; ++index) {
        pl_elf_segment segment;
        if (pl_elf_program(elf, index, &segment)) return 0;
        if (segment.type != PL_ELF_SEGMENT_LOAD
                || (segment.flags & PL_ELF_FLAG_WRITE))
            continue;
        pl_u64 start = segment.virtual_address
                     + builder->construction_bias;
        if (address < start) continue;
        pl_u64 offset = address - start;
        if (offset > segment.file_bytes || bytes > segment.file_bytes - offset
                || segment.file_offset > elf->length
                || offset > elf->length - segment.file_offset
                || bytes > elf->length - segment.file_offset - offset)
            continue;
        const pl_u8 *source = elf->bytes + segment.file_offset + offset;
        pl_u64 value = 0u;
        for (pl_u32 byte = 0u; byte < bytes; ++byte)
            value |= (pl_u64)source[byte] << (byte * 8u);
        *out = value;
        return 1;
    }
    return 0;
}

static int local_memory_address(const pl_x86_instruction *instruction,
                                const pl_x86_memory *memory,
                                const pl_u64 *local_address,
                                pl_u32 local_valid, pl_u64 *out)
{
    enum { LOCAL_GPRS = 32u };
    if (!instruction || !memory || !local_address || !out) return 0;
    pl_u64 value = 0u;
    if (memory->base.class_id == PL_X86_REGISTER_IP) {
        value = instruction->fallthrough;
    } else if (memory->base.class_id == PL_X86_REGISTER_GPR
            && memory->base.index < LOCAL_GPRS
            && (local_valid & (1u << memory->base.index))) {
        value = local_address[memory->base.index];
    } else if (memory->base.class_id != PL_X86_REGISTER_NONE) {
        return 0;
    }
    if (memory->index.class_id == PL_X86_REGISTER_GPR
            && memory->index.index < LOCAL_GPRS
            && (local_valid & (1u << memory->index.index))) {
        value += local_address[memory->index.index] * memory->scale;
    } else if (memory->index.class_id != PL_X86_REGISTER_NONE) {
        return 0;
    }
    if (memory->has_displacement)
        value += (pl_u64)memory->displacement;
    *out = value;
    return 1;
}

static pl_u64 width_value(pl_u64 value, pl_u32 bits, int sign_extend)
{
    if (!bits || bits >= 64u) return value;
    pl_u64 mask = (1ull << bits) - 1u;
    value &= mask;
    if (sign_extend && (value & (1ull << (bits - 1u)))) value |= ~mask;
    return value;
}

static int local_operand_value(const native_builder *builder,
                               const pl_x86_instruction *instruction,
                               const pl_x86_operand *operand,
                               const pl_u64 *local_address,
                               pl_u32 local_valid, int sign_extend,
                               pl_u64 *out)
{
    enum { LOCAL_GPRS = 32u };
    if (!operand || !out) return 0;
    if (operand->kind == PL_X86_OPERAND_REGISTER
            && operand->value.reg.class_id == PL_X86_REGISTER_GPR
            && operand->value.reg.index < LOCAL_GPRS
            && (local_valid & (1u << operand->value.reg.index))) {
        *out = width_value(
            local_address[operand->value.reg.index], operand->bits,
            sign_extend);
        return 1;
    }
    if (operand->kind == PL_X86_OPERAND_IMMEDIATE) {
        *out = width_value(operand->value.immediate, operand->bits,
                           sign_extend);
        return 1;
    }
    if (operand->kind == PL_X86_OPERAND_MEMORY && operand->bits
            && !(operand->bits & 7u) && operand->bits <= 64u) {
        pl_u64 address = 0u, value = 0u;
        if (!local_memory_address(
                instruction, &operand->value.memory,
                local_address, local_valid, &address)
                || !immutable_scalar(
                    builder, address, operand->bits / 8u, &value))
            return 0;
        *out = width_value(value, operand->bits, sign_extend);
        return 1;
    }
    return 0;
}

static int mark_block_construction_fields(const native_builder *builder,
                                          pl_x86_block *block)
{
    pl_u32 begin;
    if (!builder || !block || block->end < block->start
            || !address_coordinate(builder->image, block->start, &begin, 0)
            || block->end - block->start
               > (pl_u64)builder->coordinate_count - begin)
        return PL_ERROR_BLOCK;
    pl_u32 end = begin + (pl_u32)(block->end - block->start);
    block->construction_fields = 0u;
    for (pl_u32 coordinate = begin; coordinate < end; ++coordinate)
        if (bit_get(builder->construction_fields, coordinate)) {
            block->construction_fields = 1u;
            break;
        }
    return 0;
}

static int enqueue(native_builder *builder, pl_u64 address)
{
    pl_u32 coordinate;
    if (!address_coordinate(builder->image, address, &coordinate, 0)) {
        /* A linked direct branch can deliberately terminate outside this
         * ELF's executable image (for example an uncalled weak function
         * resolved to address zero).  The ordinary x86 target is already the
         * complete result: retain it as a non-image edge instead of inventing
         * a block or a runtime fallback. */
        if (builder->population->nonimage_control_edges == 0xffffffffu)
            return PL_ERROR_BLOCK_LIMIT;
        if (!builder->population->nonimage_control_edges)
            builder->population->first_nonimage_control_target = address;
        ++builder->population->nonimage_control_edges;
        return 0;
    }
    if (bit_get(builder->boundary, coordinate)) return 0;
    if (builder->queue_count >= builder->coordinate_count)
        return PL_ERROR_BLOCK_LIMIT;
    bit_set(builder->boundary, coordinate);
    builder->queue[builder->queue_count++] = coordinate;
    return 0;
}

static int system_call_continues(const pl_x86_block *block)
{
    return block->machine_operation == PL_X86_MACHINE_SYSTEM_TRANSFER
        && (block->machine_argument == 0u || block->machine_argument == 2u);
}

static int mark_block_instructions(native_builder *builder,
                                   const pl_x86_block *block,
                                   pl_x86_instruction *terminal)
{
    enum { LOCAL_GPRS = 32u };
    pl_u64 local_address[LOCAL_GPRS];
    pl_u64 local_code_origin[LOCAL_GPRS];
    pl_u32 local_valid = 0u;
    pl_u32 local_origin_valid = 0u;
    pl_u32 local_origin_observable = 0u;
    for (pl_u32 index = 0u; index < LOCAL_GPRS; ++index) {
        local_address[index] = 0u;
        local_code_origin[index] = 0u;
    }
    pl_u64 rip = block->start;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        pl_u32 coordinate;
        if (!address_coordinate(builder->image, rip, &coordinate, 0))
            return PL_ERROR_BLOCK;
        bit_set(builder->scanned, coordinate);
        int status = pl_x86_frontend_decode(
            &builder->frontend, rip, terminal);
        if (status) return status;
        /* Close a same-block address slice even when the linker has resolved
         * every relocation.  Only a value consumed by indirect control, or a
         * value proven to name an ELF function, becomes an entry.  A LEA of a
         * string or other PF_X constant remains data. */
        if ((terminal->flags & PL_X86_INSTRUCTION_INDIRECT)
                && (terminal->flow == PL_X86_FLOW_JUMP
                    || terminal->flow == PL_X86_FLOW_CALL)) {
            for (pl_u32 operand = 0u;
                    operand < terminal->visible_operand_count; ++operand) {
                const pl_x86_operand *target = &terminal->operands[operand];
                if (target->kind == PL_X86_OPERAND_REGISTER
                        && target->value.reg.class_id == PL_X86_REGISTER_GPR
                        && target->value.reg.index < LOCAL_GPRS
                        && (local_valid
                            & (1u << target->value.reg.index))) {
                    status = enqueue(
                        builder, local_address[target->value.reg.index]);
                    if (status) return status;
                }
            }
        }
        pl_u32 produced = 0xffffffffu;
        pl_u64 produced_address = 0u;
        int produced_valid = 0;
        pl_u64 produced_origin = 0u;
        int produced_origin_valid = 0;
        int produced_origin_observable = 0;
        if (terminal->visible_operand_count >= 1u
                && terminal->operands[0].kind
                   == PL_X86_OPERAND_REGISTER
                && terminal->operands[0].value.reg.class_id
                   == PL_X86_REGISTER_GPR
                && terminal->operands[0].value.reg.index < LOCAL_GPRS
                && (terminal->operands[0].flags & PL_X86_OPERAND_WRITE))
            produced = terminal->operands[0].value.reg.index;
        if (terminal->operation == PL_X86_OPERATION_LOAD_ADDRESS
                && terminal->visible_operand_count >= 2u
                && terminal->operands[1].kind == PL_X86_OPERAND_MEMORY) {
            produced_valid = local_memory_address(
                terminal, &terminal->operands[1].value.memory,
                local_address, local_valid, &produced_address);
            if (produced_valid
                    && pl_x86_image_contains(
                        builder->image, produced_address)) {
                produced_origin = produced_address;
                produced_origin_valid = 1;
            }
        } else if ((terminal->operation == PL_X86_OPERATION_MOVE
                    || terminal->operation
                       == PL_X86_OPERATION_MOVE_SIGN_EXTEND
                    || terminal->operation
                       == PL_X86_OPERATION_MOVE_ZERO_EXTEND)
                && terminal->visible_operand_count >= 2u) {
            const pl_x86_operand *target = &terminal->operands[0];
            const pl_x86_operand *source = &terminal->operands[1];
            int signed_source = terminal->operation
                == PL_X86_OPERATION_MOVE_SIGN_EXTEND;
            produced_valid = target->kind == PL_X86_OPERAND_REGISTER
                && produced < LOCAL_GPRS
                && local_operand_value(
                    builder, terminal, source,
                    local_address, local_valid, signed_source,
                    &produced_address);
            if (produced_valid)
                produced_address = width_value(
                    produced_address, target->bits, 0);
            if (source->kind == PL_X86_OPERAND_REGISTER
                    && source->value.reg.class_id
                       == PL_X86_REGISTER_GPR
                    && source->value.reg.index < LOCAL_GPRS
                    && (local_origin_valid
                        & (1u << source->value.reg.index))) {
                produced_origin =
                    local_code_origin[source->value.reg.index];
                produced_origin_valid = 1;
                produced_origin_observable =
                    (local_origin_observable
                     & (1u << source->value.reg.index)) != 0u;
            }
        } else if ((terminal->operation == PL_X86_OPERATION_ADD
                    || terminal->operation == PL_X86_OPERATION_SUBTRACT
                    || terminal->operation == PL_X86_OPERATION_AND)
                && terminal->visible_operand_count >= 2u
                && produced < LOCAL_GPRS
                && ((local_valid | local_origin_valid)
                    & (1u << produced))) {
            pl_u64 right = 0u;
            if (local_operand_value(
                    builder, terminal, &terminal->operands[1],
                    local_address, local_valid, 0, &right)) {
                pl_u64 left = local_address[produced];
                produced_address = terminal->operation
                    == PL_X86_OPERATION_ADD ? left + right
                    : terminal->operation == PL_X86_OPERATION_SUBTRACT
                    ? left - right : left & right;
                produced_address = width_value(
                    produced_address, terminal->operands[0].bits, 0);
                produced_valid = 1;
            }
            if (local_origin_valid & (1u << produced)) {
                produced_origin = local_code_origin[produced];
                produced_origin_valid = 1;
                produced_origin_observable = 1;
            }
            const pl_x86_operand *right_operand = &terminal->operands[1];
            if (right_operand->kind == PL_X86_OPERAND_REGISTER
                    && right_operand->value.reg.class_id
                       == PL_X86_REGISTER_GPR
                    && right_operand->value.reg.index < LOCAL_GPRS
                    && (local_origin_valid
                        & (1u << right_operand->value.reg.index))) {
                pl_u64 right_origin =
                    local_code_origin[right_operand->value.reg.index];
                if (produced_origin_valid
                        && produced_origin != right_origin) {
                    status = enqueue(builder, produced_origin);
                    if (status) return status;
                }
                produced_origin = right_origin;
                produced_origin_valid = 1;
                produced_origin_observable = 1;
            }
        }
        /* Once a linked code coordinate contributes to an architecturally
         * visible memory write, relocating or deleting its target would
         * change the stored value.  Publish that target even when arithmetic
         * has converted the coordinate to a rel32 field.  This is the exact
         * consumer missing from a bare LEA rule; unused PF_X constants still
         * create no execution root. */
        int writes_memory =
            (terminal->flags & PL_X86_INSTRUCTION_WRITES_MEMORY) != 0u;
        for (pl_u32 operand = 0u;
                !writes_memory && operand < terminal->operand_count;
                ++operand)
            writes_memory = terminal->operands[operand].kind
                    == PL_X86_OPERAND_MEMORY
                && (terminal->operands[operand].flags
                    & (PL_X86_OPERAND_WRITE
                       | PL_X86_OPERAND_CONDITIONAL_WRITE));
        if (writes_memory)
            for (pl_u32 operand = 0u;
                    operand < terminal->visible_operand_count; ++operand) {
                const pl_x86_operand *value = &terminal->operands[operand];
                if (value->kind != PL_X86_OPERAND_REGISTER
                        || value->value.reg.class_id
                           != PL_X86_REGISTER_GPR
                        || value->value.reg.index >= LOCAL_GPRS
                        || !(local_origin_valid
                            & (1u << value->value.reg.index)))
                    continue;
                status = enqueue(
                    builder, local_code_origin[value->value.reg.index]);
                if (status) return status;
                local_origin_observable |= 1u << value->value.reg.index;
            }
        for (pl_u32 operand = 0u; operand < terminal->operand_count;
             ++operand) {
            const pl_x86_operand *value = &terminal->operands[operand];
            if (value->kind == PL_X86_OPERAND_REGISTER
                    && value->value.reg.class_id == PL_X86_REGISTER_GPR
                    && value->value.reg.index < LOCAL_GPRS
                    && (value->flags & (PL_X86_OPERAND_WRITE
                        | PL_X86_OPERAND_CONDITIONAL_WRITE))) {
                local_valid &= ~(1u << value->value.reg.index);
                local_origin_valid &= ~(1u << value->value.reg.index);
                local_origin_observable &= ~(1u << value->value.reg.index);
            }
        }
        if (produced_valid && produced < LOCAL_GPRS) {
            local_address[produced] = produced_address;
            local_valid |= 1u << produced;
            pl_u32 target_coordinate;
            if (builder->function_starts
                    && address_coordinate(
                        builder->image, produced_address,
                        &target_coordinate, 0)
                    && bit_get(builder->function_starts, target_coordinate)) {
                status = enqueue(builder, produced_address);
                if (status) return status;
            }
        }
        if (produced_origin_valid && produced < LOCAL_GPRS) {
            local_code_origin[produced] = produced_origin;
            local_origin_valid |= 1u << produced;
            if (produced_origin_observable)
                local_origin_observable |= 1u << produced;
        }
        /* Address materialization is not control flow.  PF_X commonly embeds
         * immutable strings and constants reached by same-section LEA.  Code
         * coordinates are admitted by direct control, published ELF/metadata
         * roots, or a proved indirect-control projection such as a table; a
         * bare data address remains in the retained loader projection. */
        for (pl_u64 byte = rip; byte < terminal->fallthrough; ++byte) {
            pl_u32 covered;
            if (!address_coordinate(
                    builder->image, byte, &covered, 0))
                return PL_ERROR_BLOCK;
            bit_set(builder->covered, covered);
        }
        rip = terminal->fallthrough;
    }
    /* A precise cut observes the register generation produced by the pure
     * predecessor slice.  If arithmetic has turned a linked code coordinate
     * into a patch/relative value, the target is already semantically live at
     * this cut even when the consuming store begins the following block. */
    for (pl_u32 reg = 0u; reg < LOCAL_GPRS; ++reg)
        if (local_origin_observable & (1u << reg)) {
            int status = enqueue(builder, local_code_origin[reg]);
            if (status) return status;
        }
    return 0;
}

static int discover(native_builder *builder)
{
    while (builder->queue_cursor < builder->queue_count) {
        pl_u32 coordinate = builder->queue[builder->queue_cursor++];
        /* An instruction may already have been decoded as the interior of a
         * different block.  That does not prove closure from this newly
         * admitted boundary: a following precise cut can expose a successor
         * which the enclosing block never published. */
        if (bit_get(builder->expanded, coordinate)) continue;
        bit_set(builder->expanded, coordinate);
        pl_u64 start;
        if (!coordinate_address(
                builder->image, coordinate, &start, 0, 0))
            return PL_ERROR_BLOCK;
        pl_x86_block block;
        int status = pl_x86_block_lower(
            &builder->frontend, start, &builder->formation, &block);
        if (status) return status;
        pl_x86_instruction terminal;
        status = mark_block_instructions(builder, &block, &terminal);
        if (status) return status;
        pl_u64 map_end = 0u;
        if (!coordinate_address(
                builder->image, coordinate, 0, 0, &map_end))
            return PL_ERROR_BLOCK;
        for (pl_u32 arm = 0u; arm < block.successor_count; ++arm) {
            /* Executable maps are half-open code extents.  A pure fallthrough
             * that lands exactly on the exclusive end is the terminal cut of
             * that extent, not an unresolved control target.  This matters
             * for linked replacement/init fragments whose bytes are copied
             * by metadata rather than executed in section order. */
            if (terminal.flow == PL_X86_FLOW_NEXT
                    && block.successor[arm] == map_end)
                continue;
            status = enqueue(builder, block.successor[arm]);
            if (status) return status;
        }
        /* A native call also has a return continuation.  The physical SSA
         * models the call edge itself; closure must additionally admit the
         * address restored by RET, without inventing a runtime edge record. */
        if (terminal.flow == PL_X86_FLOW_CALL) {
            status = enqueue(builder, terminal.fallthrough);
            if (status) return status;
        }
        /* SYSCALL and SYSENTER leave the current machine state, but their
         * user-side continuation remains linked code.  The kernel chooses
         * when it resumes; it does not make the instruction after the cut
         * unreachable. */
        if (system_call_continues(&block)) {
            status = enqueue(builder, terminal.fallthrough);
            if (status) return status;
        }
        if (block.dynamic_target) {
            if (builder->population->dynamic_blocks == 0xffffffffu)
                return PL_ERROR_BLOCK_LIMIT;
            ++builder->population->dynamic_blocks;
        }
    }
    return 0;
}

/* Resolve an address-valued byte inside an already decoded instruction to
 * that instruction's unique linked spelling.  x86 instructions are at most
 * 15 bytes, and discovery's scanned bitset contains only proved instruction
 * starts, so this bounded reverse search does not admit an overlapping decode. */
static int observed_instruction(const native_builder *builder,
                                pl_u64 address, pl_u32 *start_coordinate,
                                pl_u32 *source_bytes)
{
    pl_u32 coordinate;
    pl_u32 map_index;
    if (!builder || !start_coordinate || !source_bytes
            || !address_coordinate(
                builder->image, address, &coordinate, &map_index))
        return PL_ERROR_BLOCK;
    pl_u64 map_base64 = 0u;
    for (pl_u32 index = 0u; index < map_index; ++index)
        map_base64 += builder->image->maps[index].memory_bytes;
    if (map_base64 > coordinate || map_base64 > 0xffffffffu)
        return PL_ERROR_BLOCK;
    pl_u32 map_base = (pl_u32)map_base64;
    for (pl_u32 distance = 1u; distance <= 15u
            && distance <= coordinate - map_base; ++distance) {
        pl_u32 candidate = coordinate - distance;
        if (!bit_get(builder->scanned, candidate)) continue;
        pl_u64 start;
        if (!coordinate_address(builder->image, candidate, &start, 0, 0))
            return PL_ERROR_BLOCK;
        pl_x86_instruction instruction;
        int status = pl_x86_frontend_decode(
            &builder->frontend, start, &instruction);
        if (status) return status;
        if (address < instruction.fallthrough) {
            *start_coordinate = candidate;
            *source_bytes = instruction.source_bytes;
            return instruction.source_bytes ? 0 : PL_ERROR_BLOCK;
        }
    }
    return PL_ERROR_BLOCK;
}

/* A newly admitted entry may cut through an instruction that was decoded by
 * an older source spelling.  Its containing instruction still completes
 * before control reaches the new spelling, so that fallthrough is a required
 * entry as well.  Repair only such <=15-byte cuts; do not rescan arbitrary
 * block prefixes or materialize an overlap graph. */
static int close_overlapping_cuts(native_builder *builder)
{
    if (!builder) return PL_ERROR_BLOCK;
    /* `queue` is the append-only boundary population until layout starts.
     * Inspect each admitted cut once; a repaired fallthrough is appended and
     * discovery may append further cuts, which the same cursor will reach.
     * Re-scanning the full executable coordinate word after each addition was
     * an avoidable O(coordinates * repair-rounds) path. */
    for (pl_u32 inspect = 0u; inspect < builder->queue_count; ++inspect) {
        pl_u32 coordinate = builder->queue[inspect];
        if (!bit_get(builder->boundary, coordinate))
            return PL_ERROR_BLOCK;
        pl_u64 address;
        if (!coordinate_address(
                builder->image, coordinate, &address, 0, 0))
            return PL_ERROR_BLOCK;
        pl_u32 owner = 0u;
        pl_u32 source_bytes = 0u;
        int status = observed_instruction(
            builder, address, &owner, &source_bytes);
        if (status == PL_ERROR_BLOCK) continue;
        if (status) return status;
        pl_u64 owner_address;
        if (!coordinate_address(
                builder->image, owner, &owner_address, 0, 0))
            return PL_ERROR_BLOCK;
        pl_u64 fallthrough;
        if (!pl_checked_add_u64(
                owner_address, source_bytes, &fallthrough))
            return PL_ERROR_BLOCK_LIMIT;
        pl_u32 before = builder->queue_count;
        status = enqueue(builder, fallthrough);
        if (status) return status;
        if (builder->queue_count != before) {
            status = discover(builder);
            if (status) return status;
        }
    }
    return 0;
}

/* A finite identity/grid extent constrains source bytes, but a cell ending in
 * ordinary fallthrough also publishes its continuation as executable code.
 * Entry collection already publishes every cell start.  Admit only these
 * exact ends before discovery's instruction-start bitset is reused; otherwise
 * later fixed-cell formation would create a successor absent from the closed
 * machine. */
static int close_code_grid_fallthroughs(
    native_builder *builder, const pl_x86_code_grid *grids,
    pl_u32 grid_count)
{
    if (!builder || (grid_count && !grids)) return PL_ERROR_BLOCK;
    int added = 0;
    for (pl_u32 index = 0u; index < grid_count; ++index) {
        const pl_x86_code_grid *grid = &grids[index];
        if (!grid->stride || !grid->count) return PL_ERROR_BLOCK;
        if (!(grid->flags & PL_X86_CODE_GRID_SOURCE_IDENTITY)) continue;
        for (pl_u32 cell = 0u; cell < grid->count; ++cell) {
            pl_u64 start = grid->start + (pl_u64)cell * grid->stride;
            pl_u64 end;
            if (!pl_checked_add_u64(start, grid->stride, &end))
                return PL_ERROR_BLOCK_LIMIT;
            pl_x86_instruction terminal = { 0 };
            int status = pl_x86_frontend_decode(
                &builder->frontend, start, &terminal);
            /* Whole-function identity extents may contain a terminal plus
             * observed tail bytes.  Only the fallback one-instruction cell
             * creates the missing cut handled here. */
            if (status || terminal.fallthrough != end
                    || terminal.flow != PL_X86_FLOW_NEXT
                    || !pl_x86_image_contains(builder->image, end))
                continue;
            pl_u32 coordinate;
            if (!address_coordinate(
                    builder->image, end, &coordinate, 0))
                return PL_ERROR_BLOCK;
            if (bit_get(builder->boundary, coordinate)) continue;
            status = enqueue(builder, end);
            if (status) return status;
            added = 1;
        }
    }
    return added ? discover(builder) : 0;
}

static int mark_code_grids(native_builder *builder,
                           const pl_x86_code_grid *grids,
                           pl_u32 grid_count)
{
    if (!builder || (grid_count && !grids)) return PL_ERROR_BLOCK;
    pl_u64 bit_bytes = ((pl_u64)builder->coordinate_count + 7u) >> 3u;
    /* expanded/scanned have completed their closure lifetime.  Reuse those
     * exact physical bitsets as fixed-cell and fixed-region coordinates; the
     * output needs no sixth/seventh per-byte array. */
    for (pl_u64 index = 0u; index < bit_bytes; ++index) {
        builder->expanded[index] = 0u;
        builder->scanned[index] = 0u;
    }
    for (pl_u32 index = 0u; index < grid_count; ++index) {
        const pl_x86_code_grid *grid = &grids[index];
        pl_u64 extent;
        if (!grid->stride || !grid->count
                || !pl_checked_mul_u64(
                    grid->stride, grid->count, &extent)
                || extent != grid->bytes
                || (grid->flags & ~PL_X86_CODE_GRID_SOURCE_IDENTITY))
            return PL_ERROR_BLOCK;
        for (pl_u32 cell = 0u; cell < grid->count; ++cell) {
            pl_u64 start = grid->start + (pl_u64)cell * grid->stride;
            pl_u32 coordinate;
            if (!address_coordinate(builder->image, start, &coordinate, 0)
                    || !bit_get(builder->boundary, coordinate))
                return PL_ERROR_BLOCK;
            for (pl_u32 byte = 0u; byte < grid->stride; ++byte) {
                pl_u32 member;
                if (!address_coordinate(
                        builder->image, start + byte, &member, 0))
                    return PL_ERROR_BLOCK;
                bit_set(builder->scanned, member);
                if (grid->flags & PL_X86_CODE_GRID_SOURCE_IDENTITY)
                    bit_set(builder->expanded, member);
            }
        }
    }
    return 0;
}

static int fixed_cell_width(const native_builder *builder,
                            pl_u32 coordinate, pl_u32 *width,
                            int *source_identity)
{
    if (!builder || !width || !source_identity) return PL_ERROR_BLOCK;
    *width = 0u;
    *source_identity = 0;
    /* Every precise cut inside the public grid shares the same affine source
     * to output coordinate map.  Cell starts alone are insufficient: PUSH,
     * memory and other precise-fault instructions split one stub into several
     * blocks.  Preserve the distance to the next admitted cut; only a terminal
     * suffix with no cut becomes INT3 padding. */
    if (!bit_get(builder->scanned, coordinate)) return 0;
    *source_identity = bit_get(builder->expanded, coordinate);
    pl_u32 next = coordinate + 1u;
    if (next >= builder->coordinate_count) {
        *width = builder->coordinate_count - coordinate;
        return 0;
    }
    pl_u32 byte = next >> 3u;
    pl_u32 byte_count = (builder->coordinate_count + 7u) >> 3u;
    pl_u8 stop = (pl_u8)(~builder->scanned[byte]
                       | builder->boundary[byte]);
    stop &= (pl_u8)(0xffu << (next & 7u));
    for (;;) {
        if (stop) {
            pl_u32 bit = 0u;
            while (!(stop & (pl_u8)(1u << bit))) ++bit;
            pl_u32 selected = (byte << 3u) + bit;
            next = selected < builder->coordinate_count
                ? selected : builder->coordinate_count;
            break;
        }
        if (++byte >= byte_count) {
            next = builder->coordinate_count;
            break;
        }
        stop = (pl_u8)(~builder->scanned[byte]
                     | builder->boundary[byte]);
    }
    if (next <= coordinate) return PL_ERROR_BLOCK;
    *width = next - coordinate;
    return 0;
}

static int block_bridge_bytes(const native_builder *builder,
                              pl_u32 coordinate,
                              const pl_x86_block *block,
                              const pl_x86_instruction *terminal,
                              pl_u32 *bridge_bytes)
{
    if (!builder || !block || !terminal || !bridge_bytes)
        return PL_ERROR_BLOCK;
    *bridge_bytes = 0u;
    if ((block->flow != PL_X86_FLOW_NEXT
                && block->flow != PL_X86_FLOW_CONDITIONAL
                && block->flow != PL_X86_FLOW_CALL)
            || !pl_x86_image_contains(
                builder->image, terminal->fallthrough))
        return 0;
    pl_u64 next_address = 0u;
    pl_u32 next_coordinate = 0u;
    int have_next = bit_next(
        builder->boundary, builder->coordinate_count,
        coordinate, &next_coordinate);
    if (have_next && !coordinate_address(
            builder->image, next_coordinate, &next_address, 0, 0))
        return PL_ERROR_BLOCK;
    if (!have_next || next_address != terminal->fallthrough)
        *bridge_bytes = 5u;
    return 0;
}

/* Control/fault/barrier semantics live in the block shell, outside the pure
 * SSA plan.  Count that irreducible terminal once when comparing normalized
 * work with source work; otherwise TEST+Jcc is falsely reported as a one-work
 * normalization escape merely because Jcc is not an SSA node. */
static pl_u32 terminal_shell_work(const pl_x86_instruction *terminal)
{
    return terminal && (terminal->flow != PL_X86_FLOW_NEXT
        || (terminal->flags & (PL_X86_INSTRUCTION_MAY_TRAP
                              | PL_X86_INSTRUCTION_PRECISE_CUT
                              | PL_X86_INSTRUCTION_BARRIER))) ? 1u : 0u;
}

static int select_block_with_minimum_proof(
    const native_builder *builder, const pl_x86_block *block,
    pl_u32 serial_cost, pl_x86_native_selection *selection,
    pl_u32 *minimum_span, pl_u32 *minimum_work)
{
    if (!builder || !block || !selection || !minimum_span || !minimum_work)
        return PL_ERROR_BLOCK;
    pl_x86_native_candidates candidates;
    int status = pl_x86_select_candidates(
        &builder->frontend, &builder->selection, block, &candidates);
    if (status) return status;
    if (!candidates.count) {
        *selection = candidates.diagnostic;
        return 0;
    }
    return pl_x86_candidates_select_joint_minimum(
        &candidates, serial_cost, serial_cost, selection,
        minimum_span, minimum_work);
}

static int select_block_under_limits(
    const native_builder *builder, const pl_x86_block *block,
    pl_u32 serial_cost, pl_x86_native_selection *selection)
{
    pl_u32 minimum_span = 0u;
    pl_u32 minimum_work = 0u;
    return select_block_with_minimum_proof(
        builder, block, serial_cost, selection,
        &minimum_span, &minimum_work);
}

/* Prove the componentwise minimum independently for every semantic family.
 * The release maxima below are diagnostics over the already-proved local
 * witnesses; they are never fed back as slack for another block. */
static int selection_limits(native_builder *builder)
{
    if (!builder || !builder->boundary) return PL_ERROR_BLOCK;
    pl_u32 span_ceiling = 0u;
    pl_u32 work_ceiling = 0u;
    builder->selection_limits_valid = 0;
    for (pl_u32 coordinate = 0u;
            coordinate < builder->coordinate_count; ++coordinate) {
            if (!bit_get(builder->boundary, coordinate)) continue;
            pl_x86_block block;
            int status = form_at_limit(builder, coordinate, &block, 0);
            pl_u32 fixed_width = 0u;
            int source_identity = 0;
            if (!status)
                status = fixed_cell_width(
                    builder, coordinate, &fixed_width, &source_identity);
            if (status) {
                if (builder->population) {
                    builder->population->emit_failure_stage = 226u;
                    (void)coordinate_address(
                        builder->image, coordinate,
                        &builder->population->emit_failure_address, 0, 0);
                    builder->population->emit_failure_status = status;
                }
                return status;
            }
            (void)fixed_width;
            block.source_identity = (pl_u8)source_identity;
            block.relax_short_control =
                (pl_u8)control_relaxed_at(builder, coordinate);
            pl_x86_instruction terminal;
            status = final_block_instruction(builder, &block, &terminal);
            pl_u32 bridge_bytes = 0u;
            if (!status)
                status = block_bridge_bytes(
                    builder, coordinate, &block, &terminal, &bridge_bytes);
            if (status) {
                if (builder->population) {
                    builder->population->emit_failure_stage = 227u;
                    builder->population->emit_failure_address = block.start;
                    builder->population->emit_failure_status = status;
                }
                return status;
            }
            pl_u32 serial_cost = bridge_bytes ? 1u : 0u;
            pl_x86_native_candidates candidates;
            status = pl_x86_select_candidates(
                &builder->frontend, &builder->selection,
                &block, &candidates);
            if (status || !candidates.count) {
                if (builder->population) {
                    builder->population->emit_failure_stage = 228u;
                    builder->population->emit_failure_address = block.start;
                    builder->population->emit_failure_status = status;
                    builder->population->emit_failure_output =
                        candidates.diagnostic_stage;
                    builder->population->emit_failure_expected =
                        candidates.diagnostic.blocking_opcode;
                }
                return status ? status : PL_ERROR_BLOCK;
            }
            pl_u32 minimum_span = 0u;
            pl_u32 minimum_work = 0u;
            pl_x86_native_selection selected;
            status = pl_x86_candidates_select_joint_minimum(
                &candidates, serial_cost, serial_cost, &selected,
                &minimum_span, &minimum_work);
            if (status == PL_ERROR_X86_PARETO && builder->population) {
                pl_x86_native_population *population = builder->population;
                ++population->pareto_unresolved_blocks;
                if (!population->pareto_frontier_count) {
                    population->first_pareto_address = block.start;
                    pl_x86_native_selection frontier[
                        PL_X86_NATIVE_PARETO_LIMIT];
                    pl_u32 retained = 0u;
                    int frontier_status =
                        pl_x86_candidates_pareto_frontier(
                            &candidates, serial_cost, serial_cost,
                            frontier, PL_X86_NATIVE_PARETO_LIMIT,
                            &retained);
                    if (frontier_status) return frontier_status;
                    population->pareto_frontier_count = retained;
                    for (pl_u32 index = 0u; index < retained; ++index) {
                        const pl_x86_native_selection *candidate =
                            &frontier[index];
                        population->pareto_span[index] =
                            candidate->output_span;
                        population->pareto_work[index] =
                            candidate->output_work;
                        population->pareto_bytes[index] =
                            candidate->output_bytes;
                    }
                }
            }
            if (status) return status;
            if (minimum_span > span_ceiling)
                span_ceiling = minimum_span;
            if (minimum_work > work_ceiling)
                work_ceiling = minimum_work;
    }
    builder->selection_span_ceiling = span_ceiling;
    builder->selection_work_ceiling = work_ceiling;
    builder->selection_limits_valid = 1;
    if (builder->population) {
        builder->population->selection_span_ceiling =
            builder->selection_span_ceiling;
        builder->population->selection_work_ceiling =
            builder->selection_work_ceiling;
    }
    return 0;
}

/* Measure one complete placement without changing publication statistics.
 * `covered` is dead after closure discovery and is reused as the rel8
 * relaxation set.  Starting with the empty set and adding exactly the
 * overflowing controls computes the least fixed point: widening can only
 * increase the distance across another block, so a rejected rel8 can never
 * become valid in a later pass. */
static int layout_population(native_builder *builder, pl_u32 *boundary_count)
{
    pl_u32 boundaries = 0u;
    pl_u32 output_at = 0u;
    pl_u32 prefix_page = 0u;
    if (!builder || !builder->rank_prefix || !builder->rank_prefix_count
            || !boundary_count)
        return PL_ERROR_BLOCK;
    builder->rank_prefix[0] = 0u;
    for (pl_u32 coordinate = 0u;
            coordinate < builder->coordinate_count; ++coordinate) {
        if (coordinate
                && coordinate % NATIVE_RANK_COORDINATES == 0u) {
            ++prefix_page;
            if (prefix_page >= builder->rank_prefix_count)
                return PL_ERROR_BLOCK_LIMIT;
            builder->rank_prefix[prefix_page] = boundaries;
        }
        if (!bit_get(builder->boundary, coordinate)) continue;
        pl_x86_block block;
        int status = form_at_limit(builder, coordinate, &block, 0);
        if (status) {
            if (builder->population) {
                builder->population->emit_failure_stage = 11u;
                (void)coordinate_address(
                    builder->image, coordinate,
                    &builder->population->emit_failure_address, 0, 0);
            }
            return status;
        }
        pl_u32 fixed_width = 0u;
        int source_identity = 0;
        status = fixed_cell_width(
            builder, coordinate, &fixed_width, &source_identity);
        if (status) {
            if (builder->population) {
                builder->population->emit_failure_stage = 12u;
                builder->population->emit_failure_address = block.start;
            }
            return status;
        }
        block.source_identity = (pl_u8)source_identity;
        block.relax_short_control =
            (pl_u8)control_relaxed_at(builder, coordinate);
        pl_x86_instruction terminal;
        status = final_block_instruction(builder, &block, &terminal);
        if (status) return status;
        pl_u32 bridge_bytes = 0u;
        status = block_bridge_bytes(
            builder, coordinate, &block, &terminal, &bridge_bytes);
        if (status) return status;
        pl_x86_native_selection selection;
        status = select_block_under_limits(
            builder, &block, bridge_bytes ? 1u : 0u, &selection);
        if (status || !selection.supported) {
            if (builder->population) {
                builder->population->emit_failure_stage = 13u;
                builder->population->emit_failure_address = block.start;
                builder->population->emit_failure_target = selection.reason;
            }
            return status ? status : PL_ERROR_BLOCK;
        }
        if (fixed_width && (!selection.output_bytes
                    || selection.output_bytes > fixed_width)) {
            if (builder->population) {
                builder->population->emit_failure_stage = 14u;
                builder->population->emit_failure_address = block.start;
                builder->population->emit_failure_output =
                    selection.output_bytes + bridge_bytes;
                builder->population->emit_failure_expected = fixed_width;
            }
            return PL_ERROR_BLOCK;
        }
        if (fixed_width > 0xffffffffu - bridge_bytes)
            return PL_ERROR_BLOCK_LIMIT;
        pl_u32 bytes = fixed_width
                     ? fixed_width + bridge_bytes
                     : selection.output_bytes + bridge_bytes;
        if (selection.output_bytes > 0xffffffffu - bridge_bytes
                || output_at > 0xffffffffu - bytes)
            return PL_ERROR_BLOCK_LIMIT;
        builder->queue[boundaries++] = output_at;
        output_at += bytes;
    }
    ++prefix_page;
    if (prefix_page + 1u != builder->rank_prefix_count)
        return PL_ERROR_BLOCK_LIMIT;
    builder->rank_prefix[prefix_page] = boundaries;
    builder->output_bytes = output_at;
    *boundary_count = boundaries;
    return 0;
}

typedef struct {
    pl_x86_block block;
    pl_x86_native_selection selection;
    pl_x86_native_fixup fixup;
    pl_u32 rank;
    int source_identity;
} native_relax_candidate;

static pl_u32 relaxed_delta_at(const native_builder *builder,
                               pl_u32 coordinate)
{
    int marked = bit_get(builder->covered, coordinate);
    int high = bit_get(builder->relax_large, coordinate);
    int low = bit_get(builder->function_starts, coordinate);
    /* Three closure-dead bits are the exact finite rank of every widening
     * delta observed after whole-family reselection.  000 is the sole
     * unrelaxed state; the zero-delta representative remains distinguishable
     * until final publication turns this rank back into a boolean bitset. */
    if (!marked) {
        if (!high) return low ? 1u : 0u;
        return low ? 0u : 2u;
    }
    if (high) return 10u;
    return low ? 4u : 3u;
}

static int relax_prefix_add(native_builder *builder,
                            pl_u32 coordinate, pl_u32 delta)
{
    if (!builder || !builder->relax_prefix || !delta) return PL_ERROR_BLOCK;
    pl_u32 page = coordinate / NATIVE_RANK_COORDINATES;
    for (pl_u32 index = page + 1u; index < builder->rank_prefix_count;
            index += index & (0u - index)) {
        if (builder->relax_prefix[index] > 0xffffffffu - delta)
            return PL_ERROR_BLOCK_LIMIT;
        builder->relax_prefix[index] += delta;
    }
    return 0;
}

static int relaxed_bytes_before(const native_builder *builder,
                                pl_u32 coordinate, pl_u32 *bytes)
{
    if (!builder || !builder->relax_prefix || !bytes
            || coordinate > builder->coordinate_count)
        return PL_ERROR_BLOCK;
    pl_u32 page = coordinate / NATIVE_RANK_COORDINATES;
    pl_u32 total = 0u;
    for (pl_u32 index = page; index; index &= index - 1u) {
        if (total > 0xffffffffu - builder->relax_prefix[index])
            return PL_ERROR_BLOCK_LIMIT;
        total += builder->relax_prefix[index];
    }
    pl_u32 first = page * NATIVE_RANK_COORDINATES;
    for (pl_u32 member = first; member < coordinate; ++member) {
        pl_u32 delta = relaxed_delta_at(builder, member);
        if (total > 0xffffffffu - delta) return PL_ERROR_BLOCK_LIMIT;
        total += delta;
    }
    *bytes = total;
    return 0;
}

static int relax_candidate_open(native_builder *builder,
                                pl_u32 coordinate, pl_u32 boundaries,
                                native_relax_candidate *out)
{
    if (!builder || !out || !bit_get(builder->boundary, coordinate))
        return PL_ERROR_BLOCK;
    *out = (native_relax_candidate){ 0 };
    int status = boundary_rank(builder, coordinate, &out->rank);
    if (status || out->rank >= boundaries)
        return status ? status : PL_ERROR_BLOCK;
    status = form_at_limit(builder, coordinate, &out->block, 0);
    pl_u32 fixed_width = 0u;
    if (!status) status = fixed_cell_width(
        builder, coordinate, &fixed_width, &out->source_identity);
    if (status) return status;
    (void)fixed_width;
    out->block.source_identity = (pl_u8)out->source_identity;
    out->block.relax_short_control = 0u;
    pl_x86_instruction terminal;
    if (!status)
        status = final_block_instruction(
            builder, &out->block, &terminal);
    pl_u32 bridge_bytes = 0u;
    if (!status)
        status = block_bridge_bytes(
            builder, coordinate, &out->block, &terminal, &bridge_bytes);
    if (!status)
        status = select_block_under_limits(
            builder, &out->block, bridge_bytes ? 1u : 0u,
            &out->selection);
    if (status || !out->selection.supported)
        return status ? status : PL_ERROR_BLOCK;
    int found = 0;
    for (pl_u32 field = 0u; field < out->selection.fixup_count; ++field) {
        const pl_x86_native_fixup *fixup = &out->selection.fixups[field];
        if (fixup->kind != PL_X86_NATIVE_FIXUP_PC_RELATIVE
                || fixup->bytes != 1u)
            continue;
        if (found) {
            if (builder->population) {
                builder->population->emit_failure_stage = 243u;
                builder->population->emit_failure_address = out->block.start;
                builder->population->emit_failure_output =
                    out->selection.fixup_count;
            }
            return PL_ERROR_BLOCK;
        }
        out->fixup = *fixup;
        found = 1;
    }
    return found;
}

static int relaxed_target_offset(const native_builder *builder,
                                 pl_u64 target, pl_u32 boundaries,
                                 pl_u32 *target_offset)
{
    pl_u32 coordinate;
    if (!builder || !target_offset
            || !address_coordinate(builder->image, target, &coordinate, 0))
        return 0;
    pl_u32 owner = coordinate;
    if (!bit_get(builder->boundary, owner)) {
        if (!bit_get(builder->expanded, owner)
                || !bit_previous(builder->boundary,
                    builder->coordinate_count, owner, &owner))
            return 0;
        /* Identity coordinates are a union of closed grid intervals and
         * every interval start is a closure boundary.  `owner` is the nearest
         * preceding boundary, so an expanded target with an expanded owner
         * cannot cross a hole: a later interval would contribute a nearer
         * boundary.  Rechecking every interior byte for every fixup was an
         * avoidable quadratic path on long immutable regions. */
        if (!bit_get(builder->expanded, owner)) return 0;
    }
    pl_u32 rank;
    pl_u32 delta;
    if (boundary_rank(builder, owner, &rank) || rank >= boundaries
            || relaxed_bytes_before(builder, owner, &delta))
        return 0;
    pl_u64 result = (pl_u64)builder->queue[rank]
                  + ((pl_u64)coordinate - owner) + delta;
    if (result > 0xffffffffu) return 0;
    *target_offset = (pl_u32)result;
    return 1;
}

static int relax_candidate_fits(native_builder *builder,
                                pl_u32 coordinate, pl_u32 boundaries,
                                native_relax_candidate *candidate,
                                int *fits)
{
    if (builder && builder->population)
        ++builder->population->relaxation_rechecks;
    int status = relax_candidate_open(
        builder, coordinate, boundaries, candidate);
    if (status <= 0) return status ? status : PL_ERROR_BLOCK;
    pl_u32 delta = 0u;
    status = relaxed_bytes_before(builder, coordinate, &delta);
    if (status) return status;
    pl_u64 next = (pl_u64)builder->queue[candidate->rank]
                + candidate->fixup.next_ip_at + delta;
    pl_u32 target_at = 0u;
    *fits = next <= 0xffffffffu && relaxed_target_offset(
        builder, candidate->fixup.target, boundaries, &target_at);
    if (*fits) {
        int64_t displacement = (int64_t)(pl_u64)target_at - (int64_t)next;
        *fits = displacement >= -128 && displacement <= 127;
    }
    return 0;
}

static int relax_candidate_activate(native_builder *builder,
                                    pl_u32 coordinate, pl_u32 index,
                                    pl_u32 candidate_count,
                                    native_relax_candidate *candidate)
{
    if (control_relaxed_at(builder, coordinate)) return 0;
    if (candidate->source_identity) {
        if (builder->population) {
            builder->population->emit_failure_stage = 15u;
            builder->population->emit_failure_address = candidate->block.start;
            builder->population->emit_failure_target = candidate->fixup.target;
        }
        return PL_ERROR_BLOCK;
    }
    pl_x86_native_selection relaxed;
    candidate->block.relax_short_control = 1u;
    int status = pl_x86_select_measure(
        &builder->frontend, &builder->selection,
        &candidate->block, &relaxed);
    if (status || !relaxed.supported
            || relaxed.output_bytes < candidate->selection.output_bytes) {
        if (builder->population) {
            builder->population->emit_failure_stage = 241u;
            builder->population->emit_failure_address = candidate->block.start;
            builder->population->emit_failure_status = status;
            builder->population->emit_failure_output = relaxed.output_bytes;
            builder->population->emit_failure_expected =
                candidate->selection.output_bytes + 1u;
        }
        return status ? status : PL_ERROR_BLOCK;
    }
    pl_u32 delta = relaxed.output_bytes - candidate->selection.output_bytes;
    bit_clear(builder->function_starts, coordinate);
    bit_clear(builder->relax_large, coordinate);
    if (!delta) {
        /* 011 is the canonical near-control representative with no growth. */
        bit_set(builder->function_starts, coordinate);
        bit_set(builder->relax_large, coordinate);
    } else if (delta == 1u) {
        bit_set(builder->function_starts, coordinate);
    } else if (delta == 2u) {
        bit_set(builder->relax_large, coordinate);
    } else if (delta == 4u)
        bit_set(builder->function_starts, coordinate);
    else if (delta == 10u)
        bit_set(builder->relax_large, coordinate);
    else if (delta != 3u) {
        if (builder->population) {
            builder->population->emit_failure_stage = 242u;
            builder->population->emit_failure_address = candidate->block.start;
            builder->population->emit_failure_output = delta;
            builder->population->emit_failure_expected = 3u;
        }
        return PL_ERROR_BLOCK;
    }
    if (delta) bit_set(builder->covered, coordinate);
    if (builder->population)
        ++builder->population->relaxation_widened;
    if (!delta) return 0;
    status = relax_prefix_add(builder, coordinate, delta);
    if (!status && !hierarchy_set(
            builder->relax_pending, builder->relax_pending_bytes,
            candidate_count, index))
        status = PL_ERROR_BLOCK_LIMIT;
    return status;
}

static int relax_candidate_key(native_builder *builder,
                               const pl_u32 *candidates, pl_u32 index,
                               pl_u32 boundaries, pl_u32 *key)
{
    native_relax_candidate candidate;
    int status = relax_candidate_open(
        builder, candidates[index], boundaries, &candidate);
    if (status <= 0) return status ? status : PL_ERROR_BLOCK;
    pl_u64 next = (pl_u64)builder->queue[candidate.rank]
                + candidate.fixup.next_ip_at;
    if (next > 0xffffffffu) return PL_ERROR_BLOCK_LIMIT;
    *key = (pl_u32)next;
    return 0;
}

static int relax_candidate_lower_bound(native_builder *builder,
                                       const pl_u32 *candidates,
                                       pl_u32 candidate_count,
                                       pl_u32 boundaries, pl_u32 key,
                                       pl_u32 *result)
{
    pl_u32 low = 0u, high = candidate_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        pl_u32 candidate_key = 0u;
        int status = relax_candidate_key(
            builder, candidates, middle, boundaries, &candidate_key);
        if (status) return status;
        if (candidate_key < key) low = middle + 1u;
        else high = middle;
    }
    *result = low;
    return 0;
}

/* rel8 validity is a monotone threshold over widening deltas between its
 * source and target.  The former implementation rebuilt and rescanned the
 * complete layout until stable, which is quadratic for a cascading chain.
 * Here the initial short layout is immutable.  A Fenwick word per 256 source
 * coordinates supplies current offsets, while each newly widened control
 * revisits only still-short controls whose original next-IP lies within the
 * architectural 128-byte window. */
static int relax_short_controls(native_builder *builder)
{
    if (!builder || !builder->covered || !builder->relax_large
            || !builder->function_starts || !builder->relax_prefix
            || !builder->relax_pending)
        return PL_ERROR_BLOCK;
    pl_u64 bit_bytes = ((pl_u64)builder->coordinate_count + 7u) >> 3u;
    for (pl_u64 byte = 0u; byte < bit_bytes; ++byte) {
        builder->covered[byte] = 0u;
        builder->relax_large[byte] = 0u;
        builder->function_starts[byte] = 0u;
    }
    for (pl_u32 index = 0u; index < builder->rank_prefix_count; ++index)
        builder->relax_prefix[index] = 0u;
    for (pl_u32 byte = 0u; byte < builder->relax_pending_bytes; ++byte)
        builder->relax_pending[byte] = 0u;

    pl_u32 boundaries = 0u;
    int status = selection_limits(builder);
    if (!status) status = layout_population(builder, &boundaries);
    if (status) return status;
    pl_u32 base_output_bytes = builder->output_bytes;
    pl_u32 *candidates = builder->queue + boundaries;
    pl_u32 candidate_capacity = builder->coordinate_count - boundaries;
    pl_u32 maximum_candidates = (pl_u32)(
        ((pl_u64)builder->coordinate_count + 1u) >> 1u);
    pl_u32 candidate_count = 0u;
    pl_u32 previous_key = 0u;
    int have_previous = 0;
    for (pl_u32 coordinate = 0u;
            coordinate < builder->coordinate_count; ++coordinate) {
        if (!bit_get(builder->boundary, coordinate)) continue;
        native_relax_candidate candidate;
        int opened = relax_candidate_open(
            builder, coordinate, boundaries, &candidate);
        if (opened < 0) return opened;
        if (!opened) continue;
        if (candidate_count >= candidate_capacity
                || candidate_count >= maximum_candidates)
            return PL_ERROR_BLOCK_LIMIT;
        pl_u64 key64 = (pl_u64)builder->queue[candidate.rank]
                     + candidate.fixup.next_ip_at;
        if (key64 > 0xffffffffu
                || (have_previous && key64 <= previous_key))
            return PL_ERROR_BLOCK_LIMIT;
        previous_key = (pl_u32)key64;
        have_previous = 1;
        candidates[candidate_count++] = coordinate;
    }
    if (builder->population)
        builder->population->relaxation_candidates = candidate_count;
    if (!candidate_count) return 0;

    for (pl_u32 index = 0u; index < candidate_count; ++index) {
        native_relax_candidate candidate;
        int fits = 0;
        status = relax_candidate_fits(
            builder, candidates[index], boundaries, &candidate, &fits);
        if (!status && !fits)
            status = relax_candidate_activate(
                builder, candidates[index], index,
                candidate_count, &candidate);
        if (status) return status;
    }

    pl_u32 event = 0u;
    while (hierarchy_take(
            builder->relax_pending, builder->relax_pending_bytes,
            candidate_count, &event)) {
        if (builder->population)
            ++builder->population->relaxation_events;
        if (event >= candidate_count) return PL_ERROR_BLOCK;
        pl_u32 coordinate = candidates[event];
        pl_u32 rank = 0u;
        status = boundary_rank(builder, coordinate, &rank);
        if (status || rank >= boundaries)
            return status ? status : PL_ERROR_BLOCK;
        pl_u32 cut = rank + 1u < boundaries
                   ? builder->queue[rank + 1u] : base_output_bytes;
        pl_u32 first_key = cut > 128u ? cut - 128u : 0u;
        pl_u32 last_key = cut > 0xffffffffu - 129u
                        ? 0xffffffffu : cut + 129u;
        pl_u32 first = 0u, last = 0u;
        status = relax_candidate_lower_bound(
            builder, candidates, candidate_count,
            boundaries, first_key, &first);
        if (!status)
            status = relax_candidate_lower_bound(
                builder, candidates, candidate_count,
                boundaries, last_key, &last);
        if (status) return status;
        for (pl_u32 index = first; index < last; ++index) {
            pl_u32 affected = candidates[index];
            if (control_relaxed_at(builder, affected)) continue;
            native_relax_candidate candidate;
            int fits = 0;
            status = relax_candidate_fits(
                builder, affected, boundaries, &candidate, &fits);
            if (!status && !fits)
                status = relax_candidate_activate(
                    builder, affected, index,
                    candidate_count, &candidate);
            if (status) return status;
        }
    }
    return selection_limits(builder);
}

static int form_population(native_builder *builder)
{
    pl_u32 boundaries = 0u;
    pl_u32 output_at = 0u;
    pl_u32 prefix_page = 0u;
    if (!builder || !builder->rank_prefix || !builder->rank_prefix_count)
        return PL_ERROR_BLOCK;
    builder->rank_prefix[0] = 0u;
    for (pl_u32 coordinate = 0u;
            coordinate < builder->coordinate_count; ++coordinate) {
        if (coordinate
                && coordinate % NATIVE_RANK_COORDINATES == 0u) {
            ++prefix_page;
            if (prefix_page >= builder->rank_prefix_count)
                return PL_ERROR_BLOCK_LIMIT;
            builder->rank_prefix[prefix_page] = boundaries;
        }
        if (!bit_get(builder->boundary, coordinate)) continue;
        pl_x86_block block;
        int status = form_at_limit(builder, coordinate, &block, 0);
        if (status) {
            if (builder->population) {
                builder->population->emit_failure_stage = 231u;
                (void)coordinate_address(
                    builder->image, coordinate,
                    &builder->population->emit_failure_address, 0, 0);
                builder->population->emit_failure_status = status;
            }
            return status;
        }
        pl_u32 fixed_width = 0u;
        int source_identity = 0;
        status = fixed_cell_width(
            builder, coordinate, &fixed_width, &source_identity);
        if (status) {
            builder->population->emit_failure_stage = 232u;
            builder->population->emit_failure_address = block.start;
            builder->population->emit_failure_status = status;
            return status;
        }
        /* Linked x86 may deliberately enter a byte inside another valid
         * instruction.  The limit stops composition before the next source
         * entry; it cannot truncate the first instruction.  Each admitted
         * entry is emitted as an independent output body, so overlapping
         * source decodes never become overlapping output owners. */
        pl_u64 source_bytes = block.end >= block.start
                            ? block.end - block.start : 0u;
        if (!add_u64(&builder->population->reachable_source_bytes,
                     source_bytes)
                || !add_u64(&builder->population->source_instructions,
                            block.instruction_count)
                || !add_u64(&builder->population->source_work,
                            block.source_work)
                || !add_u64(&builder->population->normalized_work,
                            block.plan.node_count)
                || !add_u64(&builder->population->source_span,
                            block.source_span)
                || !add_u64(&builder->population->normalized_span,
                            block.plan.span))
            return PL_ERROR_BLOCK_LIMIT;
        if (block.kind == PL_X86_BLOCK_FAULT) {
            if (!add_u64(&builder->population->fault_instructions,
                         block.instruction_count))
                return PL_ERROR_BLOCK_LIMIT;
        } else if (!add_u64(&builder->population->direct_instructions,
                            block.instruction_count)) {
            return PL_ERROR_BLOCK_LIMIT;
        }
        if (block.plan.node_count
                > builder->population->maximum_normalized_work) {
            builder->population->maximum_normalized_work =
                block.plan.node_count;
            builder->population->maximum_work_address = block.start;
        }
        if (block.plan.span
                > builder->population->maximum_normalized_span) {
            builder->population->maximum_normalized_span = block.plan.span;
            builder->population->maximum_span_address = block.start;
        }
        if (block.instruction_count
                > builder->population->maximum_source_instructions)
            builder->population->maximum_source_instructions =
                block.instruction_count;

        pl_x86_native_selection selection;
        block.source_identity = (pl_u8)source_identity;
        block.relax_short_control =
            (pl_u8)control_relaxed_at(builder, coordinate);
        pl_x86_instruction terminal;
        status = final_block_instruction(builder, &block, &terminal);
        if (status) {
            builder->population->emit_failure_stage = 233u;
            builder->population->emit_failure_address = block.start;
            builder->population->emit_failure_status = status;
            return status;
        }
        pl_u32 bridge_bytes = 0u;
        status = block_bridge_bytes(
            builder, coordinate, &block, &terminal, &bridge_bytes);
        if (status) {
            builder->population->emit_failure_stage = 234u;
            builder->population->emit_failure_address = block.start;
            builder->population->emit_failure_status = status;
            return status;
        }
        status = select_block_under_limits(
            builder, &block, bridge_bytes ? 1u : 0u, &selection);
        if (status) {
            builder->population->emit_failure_stage = 1u;
            builder->population->emit_failure_address = block.start;
            return status;
        }
        if (selection.output_bytes > 0xffffffffu - bridge_bytes)
            return PL_ERROR_BLOCK_LIMIT;
        pl_u32 selected_output_bytes =
            selection.output_bytes + bridge_bytes;
        if (status || (fixed_width
                && (!selection.output_bytes
                    || selection.output_bytes > fixed_width))) {
            builder->population->emit_failure_stage = 9u;
            builder->population->emit_failure_address = block.start;
            builder->population->emit_failure_output =
                selection.output_bytes;
            builder->population->emit_failure_expected = fixed_width;
            return status ? status : PL_ERROR_BLOCK;
        }
        pl_u32 stored_source_bytes = fixed_width
                                   ? fixed_width : selection.source_bytes;
        if (fixed_width > 0xffffffffu - bridge_bytes)
            return PL_ERROR_BLOCK_LIMIT;
        pl_u32 stored_output_bytes = fixed_width
                                   ? fixed_width + bridge_bytes
                                   : selected_output_bytes;
        for (pl_u32 node = 0u; node < block.plan.node_count; ++node) {
            pl_u32 opcode = block.plan.nodes[node].opcode;
            if (opcode < PL_OPCODE_COUNT)
                ++builder->population->normalized_opcode[opcode];
        }
        pl_u32 normalized_work_floor = block.plan.node_count;
        pl_u32 shell_work = terminal_shell_work(&terminal);
        if (normalized_work_floor <= 0xffffffffu - shell_work)
            normalized_work_floor += shell_work;
        else
            return PL_ERROR_BLOCK_LIMIT;
        pl_u32 normalized_span_floor = block.plan.span;
        if (normalized_span_floor <= 0xffffffffu - shell_work)
            normalized_span_floor += shell_work;
        else
            return PL_ERROR_BLOCK_LIMIT;
        if (selection.output_instructions == block.instruction_count
                && normalized_work_floor < block.source_work) {
            pl_u64 rip = block.start;
            for (pl_u32 instruction = 0u;
                    instruction < block.instruction_count; ++instruction) {
                pl_x86_instruction decoded;
                status = pl_x86_frontend_decode(
                    &builder->frontend, rip, &decoded);
                if (status) return status;
                ++builder->population->retained_source_operation[
                    decoded.operation];
                rip = decoded.fallthrough;
            }
        }
        builder->queue[boundaries] = output_at;
        if (selection.supported) {
            if (builder->population->selected_blocks == 0xffffffffu
                    || !add_u64(
                        &builder->population->selected_source_bytes,
                        stored_source_bytes)
                    || !add_u64(
                        &builder->population->selected_output_bytes,
                        stored_output_bytes)
                    || (stored_source_bytes >= stored_output_bytes
                        && !add_u64(
                            &builder->population->eliminated_bytes,
                            stored_source_bytes - stored_output_bytes))
                    || !add_u64(
                        &builder->population->emitted_instructions,
                        selection.output_instructions
                            + (bridge_bytes ? 1u : 0u)))
                return PL_ERROR_BLOCK_LIMIT;
            pl_u64 event_work = selection.output_work
                              + (bridge_bytes ? 1u : 0u);
            pl_u64 event_span = selection.output_span
                              + (bridge_bytes ? 1u : 0u);
            if (event_work > builder->population->emitted_work)
                builder->population->emitted_work = event_work;
            if (event_span > builder->population->emitted_span)
                builder->population->emitted_span = event_span;
            if (!add_u64(&builder->population->omitted_prefix_bytes,
                         selection.omitted_prefix_bytes))
                return PL_ERROR_BLOCK_LIMIT;
            if (selection.direct_frame) {
                if (builder->population->direct_frame_blocks == 0xffffffffu
                        || !add_u64(
                            &builder->population->direct_frame_source_bytes,
                            stored_source_bytes)
                        || !add_u64(
                            &builder->population->direct_frame_output_bytes,
                            stored_output_bytes))
                    return PL_ERROR_BLOCK_LIMIT;
                ++builder->population->direct_frame_blocks;
            } else if (selection.copied_source) {
                if (builder->population->copied_source_blocks == 0xffffffffu
                        || !add_u64(
                            &builder->population->copied_source_source_bytes,
                            stored_source_bytes)
                        || !add_u64(
                            &builder->population->copied_source_output_bytes,
                            stored_output_bytes))
                    return PL_ERROR_BLOCK_LIMIT;
                ++builder->population->copied_source_blocks;
                /* A source-identity block is itself an observation: kernel
                 * alternatives, trampolines and other code readers consume
                 * these exact linked bytes.  Retaining them is the canonical
                 * identity rank, not an escape from semantic normalization. */
                if (!block.source_identity
                        && !selection.normalized_family_present
                        && (selection.output_work > normalized_work_floor
                            || selection.output_span
                               > normalized_span_floor)) {
                    if (!builder->population->normalization_escape_blocks) {
                        builder->population
                            ->first_normalization_escape_address = block.start;
                        /* Preserve the first exact source spelling which the
                         * normalized grammar did not cover.  This turns a
                         * release-wide coefficient into a reproducible local
                         * red: target is the live architectural mask, output
                         * is emitted work, expected is the SSA work floor. */
                        builder->population->emit_failure_stage = 244u;
                        builder->population->emit_failure_address =
                            block.start;
                        builder->population->emit_failure_end = block.end;
                        builder->population->emit_failure_live_outputs =
                            block.live_output_mask;
                        builder->population->emit_failure_target =
                            block.end;
                        builder->population->emit_failure_output =
                            selection.output_work;
                        builder->population->emit_failure_expected =
                            normalized_work_floor;
                    }
                    if (builder->population->normalization_escape_blocks
                                == 0xffffffffu
                            || !add_u64(
                                &builder->population
                                    ->normalization_escape_source_bytes,
                                stored_source_bytes)
                            || !add_u64(
                                &builder->population
                                    ->normalization_escape_output_bytes,
                                stored_output_bytes)
                            || !add_u64(
                                &builder->population
                                    ->normalization_escape_work,
                                selection.output_work
                                    > normalized_work_floor
                                ? selection.output_work
                                    - normalized_work_floor : 0u))
                        return PL_ERROR_BLOCK_LIMIT;
                    ++builder->population->normalization_escape_blocks;
                }
            } else {
                if (selection.output_bytes
                        || builder->population->erased_blocks == 0xffffffffu
                        || !add_u64(
                            &builder->population->erased_source_bytes,
                            selection.source_bytes))
                    return PL_ERROR_BLOCK_LIMIT;
                ++builder->population->erased_blocks;
            }
            ++builder->population->selected_blocks;
            if (stored_output_bytes > 0xffffffffu - output_at)
                return PL_ERROR_BLOCK_LIMIT;
            output_at += stored_output_bytes;
        } else {
            if (builder->population->unselected_blocks == 0xffffffffu)
                return PL_ERROR_BLOCK_LIMIT;
            if (!builder->population->emit_failure_stage) {
                builder->population->emit_failure_stage = 7u;
                builder->population->emit_failure_address = block.start;
                builder->population->emit_failure_target = selection.reason;
                builder->population->emit_failure_output =
                    selection.blocking_opcode;
            }
            ++builder->population->unselected_blocks;
            if (selection.reason < 4u)
                ++builder->population->select_reason[selection.reason];
            if (selection.blocking_opcode < PL_OPCODE_COUNT)
                ++builder->population->blocker_opcode[
                    selection.blocking_opcode];
        }
        ++boundaries;
    }
    ++prefix_page;
    if (prefix_page + 1u != builder->rank_prefix_count)
        return PL_ERROR_BLOCK_LIMIT;
    builder->rank_prefix[prefix_page] = boundaries;
    builder->population->boundaries = boundaries;
    builder->population->blocks = boundaries;
    builder->output_bytes = output_at;
    return 0;
}

/* Closure discovery needs only the ordered boundary rank.  Selecting a
 * full-state spelling here is a circular dependency: complete-future
 * liveness has not run yet, so a dead output can manufacture a Pareto blocker
 * before the block that overwrites it is even consulted. */
static int index_population(native_builder *builder)
{
    if (!builder || !builder->population || !builder->rank_prefix
            || !builder->rank_prefix_count)
        return PL_ERROR_BLOCK;
    pl_u32 boundaries = 0u;
    pl_u32 prefix_page = 0u;
    builder->rank_prefix[0] = 0u;
    for (pl_u32 coordinate = 0u;
            coordinate < builder->coordinate_count; ++coordinate) {
        if (coordinate
                && coordinate % NATIVE_RANK_COORDINATES == 0u) {
            ++prefix_page;
            if (prefix_page >= builder->rank_prefix_count)
                return PL_ERROR_BLOCK_LIMIT;
            builder->rank_prefix[prefix_page] = boundaries;
        }
        if (!bit_get(builder->boundary, coordinate)) continue;
        if (boundaries >= builder->coordinate_count)
            return PL_ERROR_BLOCK_LIMIT;
        builder->queue[boundaries++] = 0u;
    }
    ++prefix_page;
    if (prefix_page + 1u != builder->rank_prefix_count)
        return PL_ERROR_BLOCK_LIMIT;
    builder->rank_prefix[prefix_page] = boundaries;
    if (!boundaries) return PL_ERROR_BLOCK;
    builder->population->boundaries = boundaries;
    builder->population->blocks = boundaries;
    builder->output_bytes = 0u;
    return 0;
}

int pl_x86_native_analyze(const pl_x86_image *image,
                          const pl_elf_image *construction,
                          const pl_u64 *entries,
                          pl_u32 primary_entry_count, pl_u32 entry_count,
                          pl_x86_code_grid *code_grids,
                          pl_u32 code_grid_capacity,
                          pl_u32 *code_grid_count,
                          pl_u8 *workspace, pl_u64 workspace_bytes,
                          pl_x86_native_population *out)
{
    pl_u64 coordinate_count;
    pl_u64 required;
    pl_u64 bit_bytes;
    pl_u64 offset;
    if (!image || !entries || !primary_entry_count
            || !code_grids || !code_grid_count
            || *code_grid_count > code_grid_capacity
            || primary_entry_count > entry_count || !workspace || !out)
        return PL_ERROR_BLOCK;
    int status = pl_x86_image_validate(image);
    if (status) return status;
    status = coordinate_population(image, &coordinate_count);
    if (status) return status;
    status = pl_x86_native_workspace_measure(coordinate_count, &required);
    if (status || workspace_bytes < required) return PL_ERROR_BLOCK_LIMIT;

    *out = (pl_x86_native_population){ 0 };
    out->executable_coordinates = coordinate_count;
    bit_bytes = (coordinate_count + 7u) >> 3u;
    for (pl_u64 index = 0u; index < bit_bytes * 7u; ++index)
        workspace[index] = 0u;
    offset = bit_bytes * 7u;
    if (!align_u64(offset, (pl_u64)sizeof(pl_u32), &offset))
        return PL_ERROR_BLOCK_LIMIT;
    pl_u32 *queue = (pl_u32 *)(void *)(workspace + offset);
    offset += coordinate_count * (pl_u64)sizeof *queue;
    pl_u32 rank_prefix_count =
        ((pl_u32)coordinate_count + NATIVE_RANK_COORDINATES - 1u)
        / NATIVE_RANK_COORDINATES + 1u;
    pl_u32 *rank_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *rank_prefix;
    pl_u32 *relax_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *relax_prefix;
    pl_u64 relax_pending_bytes = 0u;
    if (!bit_hierarchy_measure((coordinate_count + 1u) >> 1u,
                               &relax_pending_bytes)
            || relax_pending_bytes > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *relax_pending = workspace + offset;
    offset += relax_pending_bytes;
    if (!align_u64(offset, 16u, &offset)) return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *first = workspace + offset;
    pl_u8 *second = first + NATIVE_ARENA_BYTES;
    pl_u8 *select_first = second + NATIVE_ARENA_BYTES;
    pl_u8 *select_second = select_first + NATIVE_ARENA_BYTES;

    native_builder builder = {
        .image = image,
        .construction = construction,
        .boundary = workspace,
        .expanded = workspace + bit_bytes,
        .scanned = workspace + bit_bytes * 2u,
        .covered = workspace + bit_bytes * 3u,
        .relax_large = workspace + bit_bytes * 4u,
        .construction_fields = workspace + bit_bytes * 5u,
        .function_starts = workspace + bit_bytes * 6u,
        .queue = queue,
        .rank_prefix = rank_prefix,
        .relax_prefix = relax_prefix,
        .rank_prefix_count = rank_prefix_count,
        .relax_pending = relax_pending,
        .relax_pending_bytes = (pl_u32)relax_pending_bytes,
        .coordinate_count = (pl_u32)coordinate_count,
        .formation = { first, second, NATIVE_ARENA_BYTES,
                       (pl_u32)coordinate_count },
        .selection = { select_first, select_second, NATIVE_ARENA_BYTES,
                       (pl_u32)coordinate_count },
        .population = out,
    };
    if (construction)
        builder.construction_bias_valid = find_construction_bias(
            construction, image, &builder.construction_bias);
    status = pl_x86_frontend_open(image, &builder.frontend);
    if (!status) status = mark_construction_fields(&builder, construction);
    if (!status) status = mark_function_starts(&builder, construction);
    for (pl_u32 index = 0u; !status && index < primary_entry_count; ++index)
        status = enqueue(&builder, entries[index]);
    /* Primary entries are roots, not edges.  They must name executable bytes
     * in this ELF; only successors discovered from proved blocks may end at a
     * non-image target. */
    if (!status && out->nonimage_control_edges) status = PL_ERROR_BLOCK;
    if (!status) status = discover(&builder);
    for (pl_u32 index = primary_entry_count;
            !status && index < entry_count; ++index) {
        pl_u32 coordinate;
        if (!address_coordinate(image, entries[index], &coordinate, 0))
            return PL_ERROR_BLOCK;
        if (bit_get(builder.covered, coordinate)) {
            if (bit_get(builder.scanned, coordinate)) {
                if (!bit_get(builder.boundary, coordinate)) {
                    status = enqueue(&builder, entries[index]);
                    if (!status) status = discover(&builder);
                    ++out->metadata_boundary_targets;
                }
            } else {
                pl_u32 instruction_coordinate = 0u;
                pl_u32 instruction_bytes = 0u;
                status = observed_instruction(
                    &builder, entries[index], &instruction_coordinate,
                    &instruction_bytes);
                if (status || *code_grid_count >= code_grid_capacity)
                    return status ? status : PL_ERROR_BLOCK_LIMIT;
                pl_u64 instruction_start;
                if (!coordinate_address(
                        image, instruction_coordinate,
                        &instruction_start, 0, 0))
                    return PL_ERROR_BLOCK;
                if (!bit_get(builder.boundary, instruction_coordinate)) {
                    status = enqueue(&builder, instruction_start);
                }
                pl_u64 instruction_end;
                if (!status && !pl_checked_add_u64(
                        instruction_start, instruction_bytes,
                        &instruction_end))
                    status = PL_ERROR_BLOCK_LIMIT;
                if (!status && pl_x86_image_contains(
                        image, instruction_end)) {
                    pl_u32 end_coordinate;
                    if (!address_coordinate(
                            image, instruction_end, &end_coordinate, 0))
                        status = PL_ERROR_BLOCK;
                    else if (!bit_get(builder.boundary, end_coordinate))
                        status = enqueue(&builder, instruction_end);
                }
                if (!status) status = discover(&builder);
                if (status) return status;
                code_grids[(*code_grid_count)++] = (pl_x86_code_grid){
                    instruction_start, instruction_bytes,
                    instruction_bytes, 1u,
                    PL_X86_CODE_GRID_SOURCE_IDENTITY
                };
                ++out->metadata_interior_targets;
            }
            continue;
        }
        status = enqueue(&builder, entries[index]);
        if (!status) status = discover(&builder);
    }
    if (!status) status = close_code_grid_fallthroughs(
        &builder, code_grids, *code_grid_count);
    if (!status) status = close_overlapping_cuts(&builder);
    if (!status) status = mark_code_grids(
        &builder, code_grids, *code_grid_count);
    if (!status) status = index_population(&builder);
    return status;
}

static int native_future_add(pl_u64 *total, pl_u64 bytes)
{
    pl_u64 aligned;
    return total && align_u64(*total, 8u, &aligned)
        && pl_checked_add_u64(aligned, bytes, total);
}

static int native_future_hash_slots(pl_u32 blocks, pl_u32 *out)
{
    if (!blocks || !out) return PL_ERROR_BLOCK_LIMIT;
    pl_u32 slots = 1u;
    while (slots <= blocks) {
        if (slots > 0x40000000u) return PL_ERROR_BLOCK_LIMIT;
        slots <<= 1u;
    }
    *out = slots;
    return 0;
}

int pl_x86_native_future_workspace_measure(pl_u32 blocks,
                                           pl_u64 *persistent_bytes,
                                           pl_u64 *phase_bytes)
{
    pl_u32 hash_slots;
    pl_u32 quotient_bytes;
    pl_u64 block_u32;
    pl_u64 pairs_u32;
    pl_u64 identities;
    pl_u64 slots;
    pl_u64 order;
    pl_u64 persistent = 0u;
    pl_u64 observation_phase = 0u;
    pl_u64 weighted_phase = 0u;
    pl_u64 phase;
    if (!persistent_bytes || !phase_bytes || !blocks
            || native_future_hash_slots(blocks, &hash_slots)
            || pl_finite_future_workspace_measure(
                blocks, 2u, &quotient_bytes)
            || !pl_checked_mul_u64(
                blocks, (pl_u64)sizeof(pl_u32), &block_u32)
            || !pl_checked_mul_u64(block_u32, 2u, &pairs_u32)
            || !pl_checked_mul_u64(
                blocks, (pl_u64)sizeof(pl_x86_block_identity),
                &identities)
            || !pl_checked_mul_u64(
                hash_slots, (pl_u64)sizeof(pl_u32), &slots)
            || !pl_checked_mul_u64(
                blocks, (pl_u64)sizeof(pl_u32), &order)
            || !native_future_add(&persistent, block_u32)
            || !native_future_add(&persistent, pairs_u32)
            || !native_future_add(&persistent, block_u32)
            || !native_future_add(&observation_phase, identities)
            || !native_future_add(&observation_phase, slots)
            /* Observation identities become the exact two-arm work/frontier
             * columns after interning.  The weighted immediate-rank pass then
             * needs one order vector followed by the ordinary complete-future
             * scratch.  Keeping both extents in one phase bound also covers
             * the fallback where the dead closure-queue suffix is too short
             * for the identity rows. */
            || !native_future_add(&weighted_phase, identities)
            || !native_future_add(&weighted_phase, order)
            || !native_future_add(&weighted_phase, quotient_bytes))
        return PL_ERROR_BLOCK_LIMIT;
    phase = observation_phase > quotient_bytes
          ? observation_phase : quotient_bytes;
    if (weighted_phase > phase) phase = weighted_phase;
    if (!pl_checked_add_u64(persistent, 7u, &persistent)
            || !pl_checked_add_u64(phase, 7u, &phase)
            || persistent > 0xffffffffu || phase > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    *persistent_bytes = persistent;
    *phase_bytes = phase;
    return 0;
}

static int native_builder_reopen(const pl_x86_image *image,
                                 pl_u8 *workspace,
                                 pl_u64 workspace_bytes,
                                 pl_u32 coordinate_count,
                                 native_builder *out)
{
    pl_u64 required;
    pl_u64 bit_bytes;
    pl_u64 offset;
    if (!image || !workspace || !coordinate_count || !out
            || pl_x86_native_workspace_measure(
                coordinate_count, &required)
            || workspace_bytes < required)
        return PL_ERROR_BLOCK_LIMIT;
    bit_bytes = ((pl_u64)coordinate_count + 7u) >> 3u;
    offset = bit_bytes * 7u;
    if (!align_u64(offset, (pl_u64)sizeof(pl_u32), &offset))
        return PL_ERROR_BLOCK_LIMIT;
    pl_u32 *queue = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)coordinate_count * sizeof *queue;
    pl_u32 rank_prefix_count =
        (coordinate_count + NATIVE_RANK_COORDINATES - 1u)
        / NATIVE_RANK_COORDINATES + 1u;
    pl_u32 *rank_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *rank_prefix;
    pl_u32 *relax_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *relax_prefix;
    pl_u64 relax_pending_bytes = 0u;
    if (!bit_hierarchy_measure(((pl_u64)coordinate_count + 1u) >> 1u,
                               &relax_pending_bytes)
            || relax_pending_bytes > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *relax_pending = workspace + offset;
    offset += relax_pending_bytes;
    if (!align_u64(offset, 16u, &offset)
            || offset > required
            || 4u * (pl_u64)NATIVE_ARENA_BYTES > required - offset)
        return PL_ERROR_BLOCK_LIMIT;
    *out = (native_builder){
        .image = image,
        .boundary = workspace,
        .expanded = workspace + bit_bytes,
        .scanned = workspace + bit_bytes * 2u,
        .covered = workspace + bit_bytes * 3u,
        .relax_large = workspace + bit_bytes * 4u,
        .construction_fields = workspace + bit_bytes * 5u,
        .function_starts = workspace + bit_bytes * 6u,
        .queue = queue,
        .rank_prefix = rank_prefix,
        .relax_prefix = relax_prefix,
        .rank_prefix_count = rank_prefix_count,
        .relax_pending = relax_pending,
        .relax_pending_bytes = (pl_u32)relax_pending_bytes,
        .coordinate_count = coordinate_count,
        .formation = {
            workspace + offset,
            workspace + offset + NATIVE_ARENA_BYTES,
            NATIVE_ARENA_BYTES, coordinate_count,
        },
        .selection = {
            workspace + offset + 2u * NATIVE_ARENA_BYTES,
            workspace + offset + 3u * NATIVE_ARENA_BYTES,
            NATIVE_ARENA_BYTES, coordinate_count,
        },
    };
    return pl_x86_frontend_open(image, &out->frontend);
}

/* An address-valued relocation may name a byte inside an instruction rather
 * than an instruction entry.  Such a coordinate observes the containing
 * block's identity, but it must never manufacture an overlapping x86 entry.
 * Analysis has already admitted every uncovered metadata target, so a
 * non-boundary value must lie inside the preceding admitted block in the same
 * executable map. */
static int native_address_owner_rank(native_builder *source,
                                     pl_u64 address, pl_u32 block_count,
                                     pl_u32 *rank, pl_u64 *owner_start,
                                     pl_u64 *owner_end)
{
    pl_u32 coordinate;
    pl_u32 map_index;
    if (!source || !source->image || !rank || !owner_start || !owner_end
            || !address_coordinate(
                source->image, address, &coordinate, &map_index))
        return PL_ERROR_BLOCK;
    *owner_start = 0u;
    *owner_end = 0u;
    pl_u64 map_base64 = 0u;
    for (pl_u32 index = 0u; index < map_index; ++index)
        map_base64 += source->image->maps[index].memory_bytes;
    if (map_base64 > coordinate || map_base64 > 0xffffffffu)
        return PL_ERROR_BLOCK;
    pl_u32 map_base = (pl_u32)map_base64;
    pl_u32 boundary = 0u;
    if (!bit_previous(source->boundary, source->coordinate_count,
                      coordinate, &boundary)
            || boundary < map_base)
        return PL_ERROR_BLOCK;
    pl_x86_block block = { 0 };
    int status = form_at_limit(source, boundary, &block, 0);
    *owner_start = block.start;
    *owner_end = block.end;
    if (status || address < block.start || address >= block.end)
        return PL_ERROR_BLOCK;
    status = boundary_rank(source, boundary, rank);
    return status || *rank >= block_count
         ? PL_ERROR_BLOCK : 0;
}

static int native_observe_block(
    const postlink_observer *observer,
    const pl_x86_frontend *frontend,
    const pl_x86_block_workspace *scratch,
    const pl_x86_block_workspace *instruction_scratch,
    pl_u32 state, const pl_x86_block *block,
    pl_u64 residual_work, pl_u64 residual_span,
    pl_u64 minimum_work, pl_u64 minimum_span,
    pl_u32 closed_successors, const pl_u32 successor[2],
    pl_x86_native_future *diagnostic)
{
    if (!observer) return 0;
    (void)instruction_scratch;
    if (!frontend || !scratch || !scratch->first || !scratch->second) {
        diagnostic->failure_stage = 190u;
        return PL_ERROR_BLOCK_LIMIT;
    }
    if (residual_work != minimum_work || residual_span != minimum_span) {
        diagnostic->failure_stage = 189u;
        diagnostic->failure_status = PL_ERROR_X86_PARETO;
        return PL_ERROR_X86_PARETO;
    }
    pl_u32 law_bytes = 0u, binding_bytes = 0u;
    int status = pl_x86_block_law_measure(
            frontend, block, closed_successors, &law_bytes);
    if (!status)
        status = pl_x86_block_bindings_measure(
            block, closed_successors, &binding_bytes);
    /* X86N5 is a proof-carrying normal instruction, not a cost annotation.
     * The two stored costs are the independently derived componentwise lower
     * bounds.  Flags assert that the finite candidate grammar was exhausted
     * for each bound and that this exact law is their joint witness.  A
     * selected cost distinct from either lower bound is rejected above, so a
     * second selected-cost column would only duplicate the same values. The
     * live frontier is not stored: it is the unique dependency-height
     * projection of the canonical SSA law. Keeping that projection here
     * would be a second residual-state route. */
    pl_u64 header_bytes64 = 7u;
    pl_u64 header_value[4] = {
        minimum_work, minimum_span, law_bytes, binding_bytes,
    };
    for (pl_u32 field = 0u; field < 4u; ++field) {
        pl_u64 value = header_value[field];
        do { ++header_bytes64; value >>= 7u; } while (value);
    }
    if (header_bytes64 > 0xffffffffu) return PL_ERROR_BLOCK_LIMIT;
    pl_u32 header_bytes = (pl_u32)header_bytes64;
    pl_u64 total_bytes = (pl_u64)header_bytes + law_bytes
                       + binding_bytes;
    if (status || total_bytes > scratch->bytes_each
            || total_bytes > 0xffffffffu) {
        diagnostic->failure_stage = 190u;
        diagnostic->required_bytes = total_bytes;
        diagnostic->available_bytes = scratch->bytes_each;
        diagnostic->failure_status = status;
        return status ? status : PL_ERROR_BLOCK_LIMIT;
    }
    pl_u8 *normal = scratch->second;
    normal[0] = 'X'; normal[1] = '8'; normal[2] = '6'; normal[3] = 'N';
    normal[4] = 5u;
    normal[5] = 2u;
    normal[6] = 7u; /* span lower bound | work lower bound | joint witness */
    pl_u32 header_at = 7u;
    for (pl_u32 field = 0u; field < 4u; ++field) {
        pl_u64 value = header_value[field];
        do {
            pl_u8 byte = (pl_u8)(value & 0x7fu);
            value >>= 7u;
            normal[header_at++] = (pl_u8)(byte | (value ? 0x80u : 0u));
        } while (value);
    }
    if (header_at != header_bytes) return PL_ERROR_BLOCK;
    pl_u32 written = 0u;
    status = pl_x86_block_law_write(
        frontend, block, closed_successors,
        normal + header_bytes,
        scratch->bytes_each - header_bytes, &written);
    if (status || written != law_bytes)
        return status ? status : PL_ERROR_BLOCK;
    status = pl_x86_block_bindings_write(
        block, closed_successors,
        normal + header_bytes + law_bytes,
        scratch->bytes_each - header_bytes - law_bytes, &written);
    if (status || written != binding_bytes)
        return status ? status : PL_ERROR_BLOCK;
    status = observer->block(
        observer->context, state, normal, (pl_u32)total_bytes, successor);
    if (status) {
        diagnostic->failure_stage = 191u;
        diagnostic->failure_status = status;
        return PL_ERROR_BLOCK;
    }
    return 0;
}

#define NATIVE_SUCCESSOR_CLOSED 0x80000000u
#define NATIVE_SUCCESSOR_RANK   0x0fffffffu
#define NATIVE_TRANSFER_MANDATORY 0x80000000u
#define NATIVE_TRANSFER_LOCAL_SHIFT PL_X86_LOCAL_COUNT
#define NATIVE_TRANSFER_LOCAL_MASK  0x1fu

/* SysV x86-64 state which a near RET may publish to an arbitrary caller.
 * Caller-clobbered argument registers and RFLAGS are deliberately absent;
 * RAX/RDX are possible scalar return lanes, callee-saved registers and RSP
 * retain their ABI values, and segment bases remain machine state. */
static pl_u32 native_abi_return_outputs(void)
{
    return (1u << 0u) | (1u << 2u) | (1u << 3u)
         | (1u << 4u) | (1u << 5u)
         | (1u << 12u) | (1u << 13u) | (1u << 14u) | (1u << 15u)
         | (1u << PL_X86_FS_BASE_LOCAL)
         | (1u << PL_X86_GS_BASE_LOCAL);
}

static int native_transfer_input(
    pl_u32 state, pl_u32 blocks, pl_u32 live_output,
    const pl_u32 *transfer_end, const pl_u32 *transfer,
    pl_u32 *input)
{
    const pl_u32 all_outputs = (1u << PL_X86_LOCAL_COUNT) - 1u;
    if (!transfer_end || !transfer || !input || state >= blocks
            || transfer_end[state] > transfer_end[state + 1u])
        return PL_ERROR_BLOCK;
    pl_u32 required = live_output;
    /* A transfer is a simultaneous SSA substitution.  Remove every
     * overwritten output coordinate before adding any input dependency;
     * clearing coordinates while dependencies are being accumulated can
     * erase an input required by an earlier output and makes the transfer
     * non-monotone. */
    for (pl_u32 at = transfer_end[state];
            at < transfer_end[state + 1u]; ++at) {
        pl_u32 entry = transfer[at];
        if (entry & NATIVE_TRANSFER_MANDATORY) continue;
        pl_u32 local = (entry >> NATIVE_TRANSFER_LOCAL_SHIFT)
                     & NATIVE_TRANSFER_LOCAL_MASK;
        if (local >= PL_X86_LOCAL_COUNT) return PL_ERROR_BLOCK;
        pl_u32 bit = 1u << local;
        if (!(live_output & bit)) continue;
        required &= ~bit;
    }
    for (pl_u32 at = transfer_end[state];
            at < transfer_end[state + 1u]; ++at) {
        pl_u32 entry = transfer[at];
        pl_u32 dependency = entry & all_outputs;
        if (entry & NATIVE_TRANSFER_MANDATORY) {
            required |= dependency;
            continue;
        }
        pl_u32 local = (entry >> NATIVE_TRANSFER_LOCAL_SHIFT)
                     & NATIVE_TRANSFER_LOCAL_MASK;
        if (local >= PL_X86_LOCAL_COUNT) return PL_ERROR_BLOCK;
        if (live_output & (1u << local)) required |= dependency;
    }
    *input = required;
    return 0;
}

/* Least fixed point of
 *
 *   live_out(q) = forced(q) U union live_in(successor(q))
 *   live_in(q)  = backward_SSA_q(live_out(q)).
 *
 * Only two u32 masks per state survive the solve. The reverse CSR and ring
 * queue occupy the mutually-exclusive phase extent and disappear before the
 * finite-future quotient. Each bit can enter a state once, so propagation is
 * monotone and cannot hide an N^2 predecessor scan. */
static int native_live_fixed_point(
    pl_u32 blocks,
    const pl_u32 *forced, const pl_u32 *successor,
    const pl_u32 *transfer_end, const pl_u32 *transfer,
    pl_u32 *live_outputs, pl_u32 *live_input,
    pl_u8 *scratch, pl_u64 scratch_bytes)
{
    if (!blocks || !forced || !successor || !transfer_end || !transfer
            || !live_outputs || !live_input || !scratch
            || blocks > NATIVE_SUCCESSOR_RANK
            || scratch_bytes > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    pl_arena arena = { scratch, (pl_u32)scratch_bytes, 0u };
    pl_u32 *offset = pl_arena_take(
        &arena, (blocks + 1u) * (pl_u32)sizeof *offset);
    pl_u32 *cursor = pl_arena_take(
        &arena, blocks * (pl_u32)sizeof *cursor);
    pl_u32 *predecessor = pl_arena_take(
        &arena, blocks * 2u * (pl_u32)sizeof *predecessor);
    pl_u32 *queue = pl_arena_take(
        &arena, blocks * (pl_u32)sizeof *queue);
    pl_u32 queued_bytes = (blocks + 7u) >> 3u;
    pl_u8 *queued = pl_arena_take(&arena, queued_bytes);
    if (!offset || !cursor || !predecessor || !queue || !queued)
        return PL_ERROR_BLOCK_LIMIT;
    for (pl_u32 byte = 0u; byte < queued_bytes; ++byte) queued[byte] = 0u;
    for (pl_u32 state = 0u; state <= blocks; ++state) offset[state] = 0u;
    pl_u32 edges = 0u;
    for (pl_u32 state = 0u; state < blocks; ++state) {
        for (pl_u32 arm = 0u; arm < 2u; ++arm) {
            pl_u32 edge = successor[state * 2u + arm];
            if (!(edge & NATIVE_SUCCESSOR_CLOSED)) continue;
            pl_u32 target = edge & NATIVE_SUCCESSOR_RANK;
            if (target >= blocks || edges == 0xffffffffu)
                return PL_ERROR_BLOCK;
            ++offset[target + 1u];
            ++edges;
        }
    }
    for (pl_u32 state = 0u; state < blocks; ++state) {
        if (offset[state + 1u] > 0xffffffffu - offset[state])
            return PL_ERROR_BLOCK_LIMIT;
        offset[state + 1u] += offset[state];
        cursor[state] = offset[state];
        live_outputs[state] = forced[state];
        live_input[state] = 0u;
        queue[state] = state;
        queued[state >> 3u] |= (pl_u8)(1u << (state & 7u));
    }
    if (offset[blocks] != edges || edges > blocks * 2u)
        return PL_ERROR_BLOCK;
    for (pl_u32 state = 0u; state < blocks; ++state) {
        for (pl_u32 arm = 0u; arm < 2u; ++arm) {
            pl_u32 edge = successor[state * 2u + arm];
            if (!(edge & NATIVE_SUCCESSOR_CLOSED)) continue;
            pl_u32 target = edge & NATIVE_SUCCESSOR_RANK;
            if (cursor[target] >= offset[target + 1u])
                return PL_ERROR_BLOCK;
            predecessor[cursor[target]++] = state;
        }
    }

    pl_u32 head = 0u, tail = 0u, pending = blocks;
    const pl_u32 all_outputs = (1u << PL_X86_LOCAL_COUNT) - 1u;
    while (pending) {
        pl_u32 state = queue[head];
        head = head + 1u == blocks ? 0u : head + 1u;
        --pending;
        queued[state >> 3u] &=
            (pl_u8)~(pl_u8)(1u << (state & 7u));
        pl_u32 input = 0u;
        int status = native_transfer_input(
            state, blocks, live_outputs[state],
            transfer_end, transfer, &input);
        if (status || (input & ~all_outputs)
                || (live_input[state] & ~input))
            return status ? status : PL_ERROR_BLOCK;
        pl_u32 delta = input & ~live_input[state];
        if (!delta) continue;
        live_input[state] = input;
        for (pl_u32 at = offset[state]; at < offset[state + 1u]; ++at) {
            pl_u32 previous = predecessor[at];
            pl_u32 grown = live_outputs[previous] | delta;
            if (grown == live_outputs[previous]) continue;
            live_outputs[previous] = grown;
            pl_u8 mask = (pl_u8)(1u << (previous & 7u));
            if (queued[previous >> 3u] & mask) continue;
            if (pending >= blocks) return PL_ERROR_BLOCK;
            queue[tail] = previous;
            tail = tail + 1u == blocks ? 0u : tail + 1u;
            ++pending;
            queued[previous >> 3u] |= mask;
        }
    }
    return 0;
}

static void native_copy_closure_population(
    pl_x86_native_population *target,
    const pl_x86_native_population *source)
{
    target->executable_coordinates = source->executable_coordinates;
    target->dynamic_blocks = source->dynamic_blocks;
    target->nonimage_control_edges = source->nonimage_control_edges;
    target->metadata_boundary_targets = source->metadata_boundary_targets;
    target->metadata_interior_targets = source->metadata_interior_targets;
    target->first_nonimage_control_target =
        source->first_nonimage_control_target;
    target->first_overlapping_address = source->first_overlapping_address;
    target->overlapping_source_address = source->overlapping_source_address;
    target->overlapping_source_end = source->overlapping_source_end;
    target->relaxation_candidates = source->relaxation_candidates;
    target->relaxation_widened = source->relaxation_widened;
    target->relaxation_events = source->relaxation_events;
    target->relaxation_rechecks = source->relaxation_rechecks;
}

int pl_x86_native_project_live_outputs(
    const pl_x86_image *image,
    pl_u8 *native_workspace, pl_u64 native_workspace_bytes,
    pl_x86_native_population *population,
    const pl_x86_code_grid *code_grids, pl_u32 code_grid_count,
    pl_u32 *live_outputs, pl_u32 live_output_capacity,
    pl_u8 *scratch, pl_u64 scratch_bytes)
{
    if (!image || !native_workspace || !population
            || (code_grid_count && !code_grids) || !scratch
            || !live_outputs
            || !population->blocks
            || population->blocks != population->boundaries
            || live_output_capacity < population->blocks
            || population->blocks > 0x0fffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    native_builder source;
    int status = native_builder_reopen(
        image, native_workspace, native_workspace_bytes,
        (pl_u32)population->executable_coordinates, &source);
    if (status) return status;
    status = mark_code_grids(&source, code_grids, code_grid_count);
    if (status || source.rank_prefix[source.rank_prefix_count - 1u]
                    != population->blocks)
        return status ? status : PL_ERROR_BLOCK;

    pl_u32 blocks = population->blocks;
    pl_u64 persistent_bytes = (pl_u64)blocks * 4u * sizeof(pl_u32);
    pl_u64 transfer_end_bytes = ((pl_u64)blocks + 1u) * sizeof(pl_u32);
    pl_u64 queued_bytes = ((pl_u64)blocks + 7u) >> 3u;
    pl_u64 reverse_bytes = ((pl_u64)blocks * 5u + 1u) * sizeof(pl_u32);
    pl_u64 required = 0u;
    if (!pl_checked_add_u64(reverse_bytes, queued_bytes, &reverse_bytes)
            || !pl_checked_add_u64(
                persistent_bytes, transfer_end_bytes, &required)
            || !pl_checked_add_u64(required, reverse_bytes, &required)
            || required > scratch_bytes || required > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u32 *forced = (pl_u32 *)(void *)scratch;
    pl_u32 *successor = forced + blocks;
    pl_u32 *live_input = successor + blocks * 2u;
    pl_u8 *phase = (pl_u8 *)(void *)(live_input + blocks);
    pl_u32 *transfer_end = (pl_u32 *)(void *)phase;
    pl_u32 *transfer = (pl_u32 *)(void *)(phase + transfer_end_bytes);
    pl_u64 transfer_capacity_bytes = scratch_bytes - persistent_bytes
                                   - transfer_end_bytes - reverse_bytes;
    pl_u32 transfer_capacity = (pl_u32)(
        transfer_capacity_bytes / sizeof(pl_u32));
    pl_u32 transfer_count = 0u;
    transfer_end[0] = 0u;

    const pl_u32 all_outputs = (1u << PL_X86_LOCAL_COUNT) - 1u;
    const pl_u32 linked_value_outputs = (1u << PL_X86_GPR_COUNT) - 1u;
    pl_u32 state = 0u;
    for (pl_u32 coordinate = 0u;
            coordinate < source.coordinate_count; ++coordinate) {
        if (!bit_get(source.boundary, coordinate)) continue;
        if (state >= blocks) return PL_ERROR_BLOCK;
        pl_x86_block block;
        status = form_at_limit(&source, coordinate, &block, 0);
        if (status) {
            population->emit_failure_stage = 220u;
            (void)coordinate_address(
                image, coordinate, &population->emit_failure_address, 0, 0);
            population->emit_failure_status = status;
            return status;
        }
        pl_u32 closed = 0u;
        successor[state * 2u] = 0u;
        successor[state * 2u + 1u] = 0u;
        for (pl_u32 arm = 0u; arm < block.successor_count; ++arm) {
            pl_u32 target_coordinate = 0u;
            if (!address_coordinate(
                    image, block.successor[arm], &target_coordinate, 0))
                continue;
            if (!bit_get(source.boundary, target_coordinate))
                return PL_ERROR_BLOCK;
            pl_u32 target_rank = 0u;
            status = boundary_rank(&source, target_coordinate, &target_rank);
            if (status || target_rank >= blocks)
                return status ? status : PL_ERROR_BLOCK;
            successor[state * 2u + arm] =
                target_rank | NATIVE_SUCCESSOR_CLOSED;
            closed |= 1u << arm;
        }
        pl_u32 expected = block.successor_count
                        ? (1u << block.successor_count) - 1u : 0u;
        int abi_return = block.kind == PL_X86_BLOCK_DIRECT
            && block.flow == PL_X86_FLOW_RETURN
            && block.machine_operation == PL_X86_MACHINE_NONE;
        int external = !abi_return
            && (block.kind != PL_X86_BLOCK_DIRECT
                || block.dynamic_target || !block.successor_count
                || closed != expected);
        /* A linked construction expression is an observable value lane.
         * Relocation may distinguish two currently equal GPR scalars after
         * code motion (symbol+addend is not an untyped constant), so retain
         * the architectural value coordinates until symbolic bindings enter
         * SSA.  RFLAGS and segment bases are not construction values: if a
         * successor observes them, the ordinary complete-future edge makes
         * them live. Rooting them here would leak full-state materialization
         * backward from every relocation. */
        forced[state] = block.construction_fields ? linked_value_outputs
                       : abi_return ? native_abi_return_outputs()
                      : external ? all_outputs : 0u;
        pl_arena dependency_arena = {
            source.selection.first, source.selection.bytes_each, 0u,
        };
        pl_u32 mandatory = 0u;
        pl_u32 dependency[PL_X86_LOCAL_COUNT];
        status = pl_x86_block_live_transfer(
            &block, &dependency_arena, &mandatory, dependency);
        if (status || (mandatory & ~all_outputs))
            return status ? status : PL_ERROR_BLOCK;
        if (mandatory) {
            if (transfer_count >= transfer_capacity)
                return PL_ERROR_BLOCK_LIMIT;
            transfer[transfer_count++] =
                NATIVE_TRANSFER_MANDATORY | mandatory;
        }
        for (pl_u32 local = 0u; local < PL_X86_LOCAL_COUNT; ++local) {
            pl_u32 identity = 1u << local;
            if (dependency[local] & ~all_outputs)
                return PL_ERROR_BLOCK;
            if (dependency[local] == identity) continue;
            if (transfer_count >= transfer_capacity)
                return PL_ERROR_BLOCK_LIMIT;
            transfer[transfer_count++] =
                local << NATIVE_TRANSFER_LOCAL_SHIFT
                | dependency[local];
        }
        transfer_end[state + 1u] = transfer_count;
        ++state;
    }
    if (state != blocks) return PL_ERROR_BLOCK;
    pl_u8 *reverse = (pl_u8 *)(void *)(transfer + transfer_count);
    pl_u64 reverse_offset = (pl_u64)(reverse - scratch);
    if (reverse_offset > scratch_bytes
            || scratch_bytes - reverse_offset < reverse_bytes)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u64 reverse_capacity = scratch_bytes - reverse_offset;
    pl_u64 bit_bytes = ((pl_u64)source.coordinate_count + 7u) >> 3u;
    for (pl_u64 byte = 0u; byte < bit_bytes; ++byte)
        source.function_starts[byte] = 0u;

    /* Identity is the total-frame spelling of a dead output, not a demand to
     * preserve it.  Validate only the complete-future projection here.  A
     * full-frame candidate is neither emitted nor part of the proof and may
     * itself have an irrelevant Pareto frontier; materializing it merely for
     * a local byte comparison would reopen dead state at every barrier. */
    pl_u32 grammar_boundaries = 0u;
    pl_u32 escape_boundaries = 0u;
    pl_u32 source_identity_boundaries = 0u;
    pl_u32 changed_grammar_boundaries = 0u;
    pl_u64 first_grammar_address = 0u;
    pl_u64 first_escape_address = 0u;
    pl_u64 first_changed_grammar_address = 0u;
    for (;;) {
        status = native_live_fixed_point(
            blocks, forced, successor, transfer_end, transfer,
            live_outputs, live_input, reverse,
            reverse_capacity);
        if (status) {
            population->emit_failure_stage = 224u;
            population->emit_failure_status = status;
            return status;
        }
        int retry = 0;
        state = 0u;
        for (pl_u32 coordinate = 0u;
                coordinate < source.coordinate_count; ++coordinate) {
            if (!bit_get(source.boundary, coordinate)) continue;
            if (state >= blocks) return PL_ERROR_BLOCK;
            if (live_outputs[state] == all_outputs) {
                ++state;
                continue;
            }
            source.live_outputs = 0;
            source.live_output_count = 0u;
            pl_x86_block full;
            status = form_at_limit(&source, coordinate, &full, 0);
            pl_u32 fixed_width = 0u;
            int source_identity = 0;
            if (!status)
                status = fixed_cell_width(
                    &source, coordinate, &fixed_width, &source_identity);
            (void)fixed_width;
            full.source_identity = (pl_u8)source_identity;
            /* Output placement does not exist during liveness.  A short
             * spelling is sufficient to prove that the projected semantic
             * family is executable; exact rel8 widening runs once afterward
             * on that same projected family. */
            full.relax_short_control = 0u;
            pl_x86_instruction terminal;
            pl_u32 bridge_bytes = 0u;
            if (!status) status = final_block_instruction(
                &source, &full, &terminal);
            if (!status) status = block_bridge_bytes(
                &source, coordinate, &full, &terminal, &bridge_bytes);
            int flags_changed =
                full.plan.locals[PL_X86_RFLAGS_LOCAL].kind
                    != PL_OPERAND_LOCAL
                || full.plan.locals[PL_X86_RFLAGS_LOCAL].value
                    != PL_X86_RFLAGS_LOCAL;

            source.live_outputs = live_outputs;
            source.live_output_count = blocks;
            pl_x86_block projected_block;
            status = form_at_limit(
                &source, coordinate, &projected_block, 0);
            projected_block.source_identity = (pl_u8)source_identity;
            projected_block.relax_short_control =
                full.relax_short_control;
            pl_x86_native_selection projected_selection;
            if (!status) status = select_block_under_limits(
                &source, &projected_block, bridge_bytes ? 1u : 0u,
                &projected_selection);
            int escape = !status && projected_selection.supported
                && projected_selection.copied_source
                && !projected_selection.normalized_family_present;
            /* A longer projected spelling is still the exact complete-future
             * program and may be offset by larger release-wide eliminations;
             * never restore dead state merely to win a local byte count.
             * Likewise an exact copied-x86 projection is a grammar member,
             * not an interpreter escape. Only absence of any executable
             * representative forces the full frame and another fixed point. */
            if (status || !projected_selection.supported) {
                if (!bit_get(source.function_starts, coordinate)) {
                    bit_set(source.function_starts, coordinate);
                    if (!grammar_boundaries)
                        first_grammar_address = full.start;
                    ++grammar_boundaries;
                    if (escape) {
                        if (!escape_boundaries)
                            first_escape_address = full.start;
                        ++escape_boundaries;
                    }
                    if (source_identity) ++source_identity_boundaries;
                    if (flags_changed) {
                        if (!changed_grammar_boundaries)
                            first_changed_grammar_address = full.start;
                        ++changed_grammar_boundaries;
                    }
                }
                if (forced[state] != all_outputs) {
                    forced[state] = all_outputs;
                    retry = 1;
                }
                status = 0;
            }
            ++state;
        }
        if (state != blocks) return PL_ERROR_BLOCK;
        source.live_outputs = 0;
        source.live_output_count = 0u;
        if (!retry) break;
    }
    pl_u32 dead_rflags = 0u;
    for (state = 0u; state < blocks; ++state)
        if (!(live_outputs[state] & (1u << PL_X86_RFLAGS_LOCAL)))
            ++dead_rflags;
    source.live_outputs = live_outputs;
    source.live_output_count = blocks;

    pl_x86_native_population projected = { 0 };
    native_copy_closure_population(&projected, population);
    projected.rflags_dead_blocks = dead_rflags;
    projected.rflags_projection_grammar_blocks = grammar_boundaries;
    projected.rflags_projected_blocks = dead_rflags;
    projected.rflags_projection_grew_blocks = 0u;
    projected.rflags_projection_escape_blocks = escape_boundaries;
    projected.rflags_projection_source_identity_blocks =
        source_identity_boundaries;
    projected.rflags_projection_changed_grammar_blocks =
        changed_grammar_boundaries;
    projected.first_rflags_projection_grammar_address =
        first_grammar_address;
    projected.first_rflags_projection_grew_address = 0u;
    projected.first_rflags_projection_escape_address = first_escape_address;
    projected.first_rflags_projection_changed_grammar_address =
        first_changed_grammar_address;
    source.population = &projected;
    source.selection_limits_valid = 0;
    source.selection_span_ceiling = 0u;
    source.selection_work_ceiling = 0u;
    source.output_bytes = 0u;
    status = relax_short_controls(&source);
    if (status && !projected.emit_failure_stage) {
        projected.emit_failure_stage = 235u;
        projected.emit_failure_status = status;
    }
    if (!status) {
        status = form_population(&source);
        if (status && !projected.emit_failure_stage)
            projected.emit_failure_stage = 229u;
    }
    int block_mismatch = projected.blocks != blocks;
    if (status || block_mismatch) {
        if (!projected.emit_failure_stage) {
            projected.emit_failure_stage = status ? 225u : 230u;
            projected.emit_failure_output = projected.blocks;
            projected.emit_failure_expected = blocks;
        }
        projected.emit_failure_status = status;
        *population = projected;
        return status ? status : PL_ERROR_BLOCK;
    }
    *population = projected;
    return 0;
}

int pl_x86_native_future_project(
    const pl_x86_image *image,
    pl_u8 *native_workspace, pl_u64 native_workspace_bytes,
    const pl_x86_native_population *population,
    const pl_x86_code_grid *code_grids, pl_u32 code_grid_count,
    const pl_u64 *entries, const pl_u8 *entry_roles, pl_u32 entry_count,
    const pl_u32 *live_outputs, pl_u32 live_output_count,
    pl_u8 *persistent_workspace, pl_u64 persistent_workspace_bytes,
    const postlink_observer *observer,
    pl_x86_native_future *out)
{
    pl_u64 coordinate_count64;
    pl_u64 required_persistent;
    pl_u64 required_phase;
    pl_u32 hash_slot_count;
    if (!out) return PL_ERROR_BLOCK_LIMIT;
    *out = (pl_x86_native_future){ 0 };
    out->failure_stage = 1u;
    if (!image || !native_workspace || !population
            || (code_grid_count && !code_grids)
            || !entries || !entry_roles || !entry_count
            || !live_outputs || live_output_count != population->blocks
            || !persistent_workspace
            || (observer && (!observer->begin || !observer->block
                             || !observer->emitted
                             || !observer->commit))
            || !population->blocks
            || population->blocks != population->boundaries
            || population->executable_coordinates > 0xffffffffu
            || coordinate_population(image, &coordinate_count64)
            || coordinate_count64 != population->executable_coordinates
            || pl_x86_native_future_workspace_measure(
                population->blocks, &required_persistent, &required_phase)
            || persistent_workspace_bytes < required_persistent
            || native_future_hash_slots(
                population->blocks, &hash_slot_count))
        return PL_ERROR_BLOCK_LIMIT;
    out->failure_stage = 2u;
    native_builder source;
    int status = native_builder_reopen(
        image, native_workspace, native_workspace_bytes,
        (pl_u32)coordinate_count64, &source);
    if (status) {
        out->failure_status = status;
        return status;
    }
    status = mark_code_grids(&source, code_grids, code_grid_count);
    if (status) {
        out->failure_status = status;
        return status;
    }
    /* project_live_outputs has replaced the dead relaxation-class bitset with
     * the proved output frontier. Every later observation and selection must
     * see that same projected block, never the pre-proof full frame. */
    source.live_outputs = live_outputs;
    source.live_output_count = live_output_count;
    out->failure_stage = 3u;
    if (source.rank_prefix[source.rank_prefix_count - 1u]
            != population->blocks)
        return PL_ERROR_BLOCK;

    pl_u32 alignment_skip = (pl_u32)(
        (0u - (uintptr_t)(void *)persistent_workspace) & 7u);
    out->failure_stage = 4u;
    if (alignment_skip > persistent_workspace_bytes)
        return PL_ERROR_BLOCK_LIMIT;
    pl_arena future = {
        persistent_workspace + alignment_skip,
        (pl_u32)(persistent_workspace_bytes - alignment_skip), 0u,
    };
    pl_u32 block_bytes = population->blocks * (pl_u32)sizeof(pl_u32);
    pl_u32 *observation = pl_arena_take(&future, block_bytes);
    pl_u32 *successor = pl_arena_take(&future, block_bytes * 2u);
    pl_u32 *state_class = pl_arena_take(&future, block_bytes);
    if (!observation || !successor || !state_class)
        return PL_ERROR_BLOCK_LIMIT;
    if (!pl_arena_take(&future, 0u)) return PL_ERROR_BLOCK_LIMIT;

    /* Observation identities and their hash index are independent physical
     * arrays.  The identities fit in the dead suffix of the closure queue;
     * the hash index fits after the persistent observation/successor/class
     * vectors in output scratch.  Requiring them to be adjacent created an
     * artificial 11 MB peak on the linked kernel. */
    out->failure_stage = 5u;
    pl_u32 persistent_tail_at = (future.used + 7u) & ~7u;
    if (persistent_tail_at > future.size) return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *persistent_tail = future.base + persistent_tail_at;
    pl_u64 persistent_tail_bytes = future.size - persistent_tail_at;
    pl_u8 *identity_unaligned = (pl_u8 *)(void *)(
        source.queue + population->blocks);
    pl_u8 *identity_end = (pl_u8 *)(void *)source.rank_prefix;
    pl_u64 identity_bytes =
        (pl_u64)population->blocks * sizeof(pl_x86_block_identity);
    pl_u64 hash_bytes =
        (pl_u64)hash_slot_count * sizeof(pl_u32);
    if (identity_unaligned > identity_end) return PL_ERROR_BLOCK_LIMIT;
    uintptr_t identity_address = (uintptr_t)(void *)identity_unaligned;
    uintptr_t aligned_identity_address =
        (identity_address + 7u) & ~(uintptr_t)7u;
    if (aligned_identity_address < identity_address
            || aligned_identity_address
               > (uintptr_t)(void *)identity_end)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *identity_base =
        (pl_u8 *)(void *)aligned_identity_address;
    out->failure_stage = 6u;
    out->required_bytes = identity_bytes + hash_bytes;
    out->available_bytes = (pl_u64)(identity_end - identity_base);
    pl_x86_block_identity *identities = 0;
    pl_u32 *hash_slots = 0;
    if (identity_bytes <= out->available_bytes
            && hash_bytes <= persistent_tail_bytes) {
        identities = (pl_x86_block_identity *)(void *)identity_base;
        hash_slots = (pl_u32 *)(void *)persistent_tail;
    } else if (identity_bytes <= persistent_tail_bytes
            && hash_bytes <= persistent_tail_bytes - identity_bytes) {
        identities =
            (pl_x86_block_identity *)(void *)persistent_tail;
        hash_slots = (pl_u32 *)(void *)(persistent_tail + identity_bytes);
        out->available_bytes = persistent_tail_bytes;
    } else {
        return PL_ERROR_BLOCK_LIMIT;
    }
    out->failure_stage = 7u;
    out->failure_stage = 8u;
    pl_x86_block_builder classes;
    status = pl_x86_block_builder_open(
        &classes, image, &source.formation, &source.selection,
        identities, population->blocks, hash_slots, hash_slot_count);
    if (status) {
        out->failure_status = status;
        return status;
    }

    if (observer) {
        status = observer->begin(
            observer->context, population->blocks, 2u,
            population->source_instructions);
        if (status) {
            out->failure_status = status;
            return PL_ERROR_BLOCK;
        }
    }

    pl_u32 state = 0u;
    for (pl_u32 coordinate = 0u;
            coordinate < source.coordinate_count; ++coordinate) {
        if (!bit_get(source.boundary, coordinate)) continue;
        out->failure_stage = 9u;
        if (state >= population->blocks) return PL_ERROR_BLOCK;
        pl_x86_block block;
        pl_u64 formation_limit = 0u;
        status = form_at_limit(
            &source, coordinate, &block, &formation_limit);
        if (status) {
            (void)coordinate_address(
                image, coordinate, &out->failure_address, 0, 0);
            out->failure_status = status;
            return status;
        }
        out->failure_address = block.start;
        pl_u32 closed = 0u;
        successor[state * 2u] = state;
        successor[state * 2u + 1u] = state;
        for (pl_u32 arm = 0u; arm < block.successor_count; ++arm) {
            pl_u32 target_coordinate;
            if (!address_coordinate(
                    image, block.successor[arm], &target_coordinate, 0))
                continue;
            out->failure_stage = 10u;
            out->failure_target = block.successor[arm];
            if (!bit_get(source.boundary, target_coordinate))
                return PL_ERROR_BLOCK;
            pl_u32 target_rank = 0u;
            status = boundary_rank(&source, target_coordinate, &target_rank);
            out->failure_stage = 11u;
            if (status || target_rank >= population->blocks)
                return PL_ERROR_BLOCK;
            successor[state * 2u + arm] = target_rank;
            closed |= 1u << arm;
        }
        if (block.successor_count == 1u)
            successor[state * 2u + 1u] = successor[state * 2u];
        out->failure_stage = 12u;
        classes.formation_limit = formation_limit;
        status = pl_x86_block_observation_intern(
            &classes, &block, closed, &observation[state]);
        if (status) {
            out->failure_status = status;
            return status;
        }
        /* The future relation is over the selected physical candidate, not
         * merely over the semantic plan.  Recompute the same unavoidable
         * bridge charge used by publication and retain only its exact joint
         * minimum work until observation interning finishes.  state_class is
         * otherwise dead in this phase and is overwritten by the quotient. */
        pl_u32 fixed_width = 0u;
        int source_identity = 0;
        status = fixed_cell_width(
            &source, coordinate, &fixed_width, &source_identity);
        if (status) return status;
        (void)fixed_width;
        block.source_identity = (pl_u8)source_identity;
        block.relax_short_control =
            (pl_u8)control_relaxed_at(&source, coordinate);
        pl_x86_instruction terminal;
        status = final_block_instruction(&source, &block, &terminal);
        pl_u32 bridge_bytes = 0u;
        if (!status)
            status = block_bridge_bytes(
                &source, coordinate, &block, &terminal, &bridge_bytes);
        pl_x86_native_selection selected;
        pl_u32 minimum_span = 0u;
        pl_u32 minimum_work = 0u;
        if (!status)
            status = select_block_with_minimum_proof(
                &source, &block, bridge_bytes ? 1u : 0u, &selected,
                &minimum_span, &minimum_work);
        if (status || !selected.supported
                || selected.output_work > 0xffffffffu
                                           - (bridge_bytes ? 1u : 0u)) {
            out->failure_stage = 121u;
            out->failure_status = status;
            return status ? status : PL_ERROR_BLOCK;
        }
        state_class[state] = selected.output_work
                           + (bridge_bytes ? 1u : 0u);
        out->failure_stage = 19u;
        pl_u64 residual_span = selected.output_span
                             + (bridge_bytes ? 1u : 0u);
        status = native_observe_block(
            observer, &source.frontend, &source.selection,
            &source.formation,
            state, &block, state_class[state],
            residual_span,
            minimum_work, minimum_span,
            closed, successor + state * 2u, out);
        if (status) return status;
        ++state;
    }
    out->failure_stage = 13u;
    if (state != population->blocks || !classes.identity_count)
        return PL_ERROR_BLOCK;

    /* Observation identities and their hash slots are dead once every block
     * has its dense observation rank.  Their 24 bytes per state are exactly
     * the two u64 work cells and two u32 frontier cells required by the
     * weighted relation.  The complete live-output frontier is a deterministic
     * projection of the exact observation spelling (normalized topology plus
     * ordered live outputs), so its observation rank is an exact derived rank:
     * no scalar span and no second frontier materialization is admitted.
     *
     * state_class temporarily holds work, then becomes the final result;
     * observation becomes the immediate weighted class only after the radix
     * pass has consumed it.  Thus every physical array has one lifetime and
     * the quotient still receives the literal
     * (observation, work, live-frontier, successor-class) relation. */
    if (persistent_tail_bytes > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;

    pl_u8 *weighted_base = (pl_u8 *)(void *)identities;
    pl_u64 weighted_bytes = identity_bytes;
    pl_u64 *residual_work = (pl_u64 *)(void *)weighted_base;
    pl_u32 *frontier = (pl_u32 *)(void *)(
        weighted_base + (pl_u64)population->blocks * 2u
                                      * sizeof(pl_u64));
    for (pl_u32 index = 0u; index < population->blocks; ++index) {
        pl_u64 work = state_class[index];
        residual_work[index * 2u] = work;
        residual_work[index * 2u + 1u] = work;
        frontier[index * 2u] = observation[index];
        frontier[index * 2u + 1u] = observation[index];
    }

    pl_u8 *phase_at = persistent_tail;
    pl_u64 phase_remaining = persistent_tail_bytes;
    if ((pl_u8 *)(void *)identities == persistent_tail) {
        if (weighted_bytes > phase_remaining)
            return PL_ERROR_BLOCK_LIMIT;
        phase_at += weighted_bytes;
        phase_remaining -= weighted_bytes;
    }
    pl_u64 order_bytes =
        (pl_u64)population->blocks * sizeof(pl_u32);
    if (order_bytes > phase_remaining)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u32 *order = (pl_u32 *)(void *)phase_at;
    phase_at += order_bytes;
    phase_remaining -= order_bytes;
    if (phase_remaining > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;

    pl_weighted_future_machine machine = {
        population->blocks, classes.identity_count, 2u,
        classes.identity_count,
        observation, successor, residual_work, frontier,
    };
    pl_weighted_future_workspace workspace = {
        state_class, order, observation, population->blocks,
        phase_at, (pl_u32)phase_remaining,
    };
    pl_weighted_future_projection weighted = { 0 };
    out->failure_stage = 14u;
    status = pl_weighted_future_project(&machine, &workspace, &weighted);
    if (status) {
        /* Preserve the failing substage instead of reporting every quotient
         * rejection as the outer refinement call.  Large release inputs need
         * to distinguish a bad observation rank from an insufficient phase
         * extent without reproducing the failure in a second implementation. */
        out->failure_stage = 140u + weighted.future.failure_stage;
        out->failure_status = status;
        out->failure_address = weighted.future.failure_value;
        out->failure_target = weighted.future.failure_limit;
        return status;
    }
    pl_finite_future_projection projection = weighted.future;
    pl_u8 *observable_seen = persistent_tail;
    if (projection.classes > persistent_tail_bytes)
        return PL_ERROR_BLOCK_LIMIT;
    for (pl_u32 index = 0u; index < projection.classes; ++index)
        observable_seen[index] = 0u;
    pl_u32 observable_entries = 0u;
    pl_u32 observable_classes = 0u;
    for (pl_u32 index = 0u; index < entry_count; ++index) {
        out->failure_stage = 15u;
        out->failure_address = entries[index];
        if (!(entry_roles[index] & PL_X86_ENTRY_EXECUTION_ROOT))
            return PL_ERROR_BLOCK;
        if (!(entry_roles[index] & PL_X86_ENTRY_ADDRESS_VALUE)) continue;
        pl_u32 coordinate;
        out->failure_stage = 16u;
        if (!address_coordinate(image, entries[index], &coordinate, 0))
            return PL_ERROR_BLOCK;
        pl_u32 rank = 0u;
        pl_u64 owner_start = 0u;
        pl_u64 owner_end = 0u;
        status = native_address_owner_rank(
            &source, entries[index], population->blocks, &rank,
            &owner_start, &owner_end);
        out->failure_stage = 17u;
        if (status || rank >= population->blocks
                || state_class[rank] >= projection.classes) {
            out->failure_status = status;
            out->failure_target = owner_start;
            out->required_bytes = owner_end;
            out->available_bytes = rank;
            return PL_ERROR_BLOCK;
        }
        pl_u32 future_class = state_class[rank];
        if (!observable_seen[future_class]) {
            observable_seen[future_class] = 1u;
            ++observable_classes;
        }
        ++observable_entries;
    }
    out->failure_stage = 18u;
    if (observable_classes > observable_entries
            || observable_entries - observable_classes
               > population->blocks - projection.classes)
        return PL_ERROR_BLOCK;
    pl_u32 minimum_entries = projection.classes
                           + observable_entries - observable_classes;
    *out = (pl_x86_native_future){
        .blocks = population->blocks,
        .observation_classes = classes.identity_count,
        .future_classes = projection.classes,
        .shared_blocks = population->blocks - projection.classes,
        .observable_entries = observable_entries,
        .observable_classes = observable_classes,
        .minimum_entry_coordinates = minimum_entries,
        .shareable_entry_blocks = population->blocks - minimum_entries,
        .checked_successors = projection.checked_transitions,
        .splitters = projection.splitters,
        .moved_blocks = projection.moved_states,
    };
    return 0;
}

static int output_address_for(const native_builder *builder,
                              pl_u64 output_base, pl_u64 source,
                              pl_u64 *output)
{
    pl_u32 coordinate;
    pl_u32 rank;
    if (!builder || !output
            || !address_coordinate(builder->image, source, &coordinate, 0)
            || !bit_get(builder->boundary, coordinate)
            || boundary_rank(builder, coordinate, &rank)
            || rank >= builder->population->boundaries
            || output_base > 0xffffffffffffffffull
                            - builder->queue[rank])
        return PL_ERROR_BLOCK;
    *output = output_base + builder->queue[rank];
    return 0;
}

/* A source-identity extent is one affine coordinate interval even when only
 * some of its instruction starts are closure boundaries.  RIP-relative data
 * references commonly name an interior byte (for example alt_site + 10), so
 * resolving boundaries alone would silently retain the old linked address.
 * Project from the nearest owning boundary; fixed-cell formation guarantees
 * that every byte up to this coordinate is emitted at the same displacement. */
static int output_address_for_identity(const native_builder *builder,
                                       pl_u64 output_base,
                                       pl_u32 coordinate, pl_u64 *output)
{
    if (!builder || !output || coordinate >= builder->coordinate_count
            || !bit_get(builder->expanded, coordinate))
        return PL_ERROR_BLOCK;
    pl_u32 owner = 0u;
    if (!bit_previous(builder->boundary, builder->coordinate_count,
                      coordinate, &owner))
        return PL_ERROR_BLOCK;
    /* See relaxed_target_offset: nearest-boundary ownership plus the grid
     * start invariant makes endpoint membership necessary and sufficient. */
    if (!bit_get(builder->expanded, owner)) return PL_ERROR_BLOCK;
    pl_u64 source;
    pl_u64 base;
    if (!coordinate_address(builder->image, owner, &source, 0, 0))
        return PL_ERROR_BLOCK;
    int status = output_address_for(builder, output_base, source, &base);
    pl_u64 relative = (pl_u64)coordinate - owner;
    if (status || base > 0xffffffffffffffffull - relative)
        return PL_ERROR_BLOCK;
    *output = base + relative;
    return 0;
}

static int form_at_limit(const native_builder *builder, pl_u32 coordinate,
                         pl_x86_block *block, pl_u64 *formation_limit)
{
    pl_u64 start;
    pl_u64 map_end;
    pl_u32 map_index;
    if (!coordinate_address(builder->image, coordinate,
                            &start, &map_index, &map_end))
        return PL_ERROR_BLOCK;
    pl_u64 limit = map_end;
    pl_u32 next_coordinate = 0u;
    if (bit_next(builder->boundary, builder->coordinate_count,
                 coordinate, &next_coordinate)) {
        pl_u64 next;
        pl_u32 next_map;
        if (!coordinate_address(builder->image, next_coordinate,
                                &next, &next_map, 0))
            return PL_ERROR_BLOCK;
        if (next_map == map_index) limit = next;
    }
    pl_u32 fixed_width = 0u;
    int source_identity = 0;
    int status = fixed_cell_width(
        builder, coordinate, &fixed_width, &source_identity);
    if (status) return status;
    if (fixed_width) {
        pl_u64 fixed_end;
        if (!pl_checked_add_u64(start, fixed_width, &fixed_end))
            return PL_ERROR_BLOCK_LIMIT;
        if (fixed_end < limit) limit = fixed_end;
    }
    if (formation_limit) *formation_limit = limit;
    pl_u32 live_output_mask = (1u << PL_X86_LOCAL_COUNT) - 1u;
    if (builder->live_outputs) {
        pl_u32 rank = 0u;
        if (boundary_rank(builder, coordinate, &rank)
                || rank >= builder->live_output_count)
            return PL_ERROR_BLOCK;
        live_output_mask = builder->live_outputs[rank];
    }
    status = builder->live_outputs
           ? pl_x86_block_lower_projected_until(
                &builder->frontend, start, limit, live_output_mask,
                &builder->formation, block)
           : pl_x86_block_lower_until(
                &builder->frontend, start, limit,
                &builder->formation, block);
    return status ? status : mark_block_construction_fields(builder, block);
}

static int form_at(const native_builder *builder, pl_u32 coordinate,
                   pl_x86_block *block)
{
    return form_at_limit(builder, coordinate, block, 0);
}

static int final_block_instruction(const native_builder *builder,
                                   const pl_x86_block *block,
                                   pl_x86_instruction *out)
{
    pl_u64 rip = block->start;
    if (!block->instruction_count) return PL_ERROR_BLOCK;
    for (pl_u32 index = 0u; index < block->instruction_count; ++index) {
        int status = pl_x86_frontend_decode(&builder->frontend, rip, out);
        if (status) return status;
        rip = out->fallthrough;
    }
    return 0;
}

static int write_population(native_builder *builder, pl_u64 output_address,
                            pl_u8 *output, pl_u32 output_capacity,
                            pl_u32 *fixup_count)
{
    if (!builder || !output || !fixup_count
            || builder->output_bytes > output_capacity)
        return PL_ERROR_BLOCK_LIMIT;
    *fixup_count = 0u;
    for (pl_u32 byte = 0u; byte < builder->output_bytes; ++byte)
        output[byte] = 0xccu;
    pl_u32 boundary_index = 0u;
    for (pl_u32 coordinate = 0u;
            coordinate < builder->coordinate_count; ++coordinate) {
        if (!bit_get(builder->boundary, coordinate)) continue;
        pl_u64 start = 0u;
        if (!coordinate_address(
                builder->image, coordinate, &start, 0, 0))
            return PL_ERROR_BLOCK;
        pl_x86_block block;
        int status = form_at(builder, coordinate, &block);
        if (status) {
            if (builder->population) {
                builder->population->emit_failure_stage = 1u;
                builder->population->emit_failure_address = start;
            }
            return status;
        }
        pl_u32 fixed_width = 0u;
        int source_identity = 0;
        status = fixed_cell_width(
            builder, coordinate, &fixed_width, &source_identity);
        if (status) return status;
        block.source_identity = (pl_u8)source_identity;
        block.relax_short_control =
            (pl_u8)control_relaxed_at(builder, coordinate);
        if (boundary_index >= builder->population->boundaries)
            return PL_ERROR_BLOCK_LIMIT;
        pl_u32 at = builder->queue[boundary_index++];
        if (at > builder->output_bytes)
            return PL_ERROR_BLOCK_LIMIT;
        pl_x86_instruction terminal;
        status = final_block_instruction(builder, &block, &terminal);
        if (status) return status;
        pl_u32 bridge_bytes = 0u;
        status = block_bridge_bytes(
            builder, coordinate, &block, &terminal, &bridge_bytes);
        if (status) return status;
        pl_x86_native_selection selection;
        pl_u32 written = 0u;
        status = select_block_under_limits(
            builder, &block, bridge_bytes ? 1u : 0u, &selection);
        if (!status)
            status = pl_x86_select_write_measured(
            &builder->frontend, &block, &selection,
            output + at, builder->output_bytes - at,
            &written);
        if (status || !selection.supported
                || written != selection.output_bytes
                || written > builder->output_bytes - at) {
            if (builder->population) {
                builder->population->emit_failure_stage = 2u;
                builder->population->emit_failure_address = start;
                builder->population->emit_failure_status = status;
                builder->population->emit_failure_output = written;
                builder->population->emit_failure_expected =
                    selection.output_bytes;
            }
            return status ? status : PL_ERROR_BLOCK;
        }
        if (source_identity) {
            if (!fixed_width || !selection.copied_source
                    || selection.omitted_prefix_bytes
                    || written != selection.source_bytes
                    || written > fixed_width
                    || fixed_width > builder->output_bytes - at) {
                if (builder->population) {
                    builder->population->emit_failure_stage = 10u;
                    builder->population->emit_failure_address = start;
                    builder->population->emit_failure_output = written;
                    builder->population->emit_failure_expected = fixed_width;
                }
                return PL_ERROR_BLOCK;
            }
            pl_u32 tail = fixed_width - written;
            if (tail) {
                pl_u32 copied = 0u;
                if (pl_x86_image_read(
                        builder->image, block.start + written,
                        output + at + written, tail, &copied)
                        || copied != tail)
                    return PL_ERROR_BLOCK;
            }
        }

        for (pl_u32 index = 0u; index < selection.fixup_count; ++index) {
            const pl_x86_native_fixup *fixup = &selection.fixups[index];
            pl_u64 target = fixup->target;
            pl_u32 target_coordinate;
            if (address_coordinate(
                    builder->image, target, &target_coordinate, 0)) {
                if (bit_get(builder->boundary, target_coordinate)) {
                    status = output_address_for(
                        builder, output_address, target, &target);
                    if (status) return status;
                } else if (bit_get(builder->expanded, target_coordinate)) {
                    status = output_address_for_identity(
                        builder, output_address, target_coordinate, &target);
                    if (status) return status;
                } else if (fixup->kind
                           == PL_X86_NATIVE_FIXUP_PC_RELATIVE) {
                    /* A direct control target inside the admitted image must
                     * be one of its proved boundaries. */
                    if (builder->population) {
                        builder->population->emit_failure_stage = 3u;
                        builder->population->emit_failure_address = start;
                        builder->population->emit_failure_target = target;
                    }
                    return PL_ERROR_BLOCK;
                }
                /* RIP-relative data can share a PF_X load with code.  Its
                 * linked virtual coordinate remains stable; construction
                 * relocation closure separately rewrites code-address data. */
            }
            status = pl_x86_select_bind_fixup(
                output + at, written, &selection, index,
                output_address + at, target);
            if (status) {
                if (builder->population) {
                    builder->population->emit_failure_stage = 4u;
                    builder->population->emit_failure_address = start;
                    builder->population->emit_failure_target = target;
                }
                return status;
            }
            if (*fixup_count == 0xffffffffu)
                return PL_ERROR_BLOCK_LIMIT;
            ++*fixup_count;
        }

        if ((block.flow == PL_X86_FLOW_NEXT
                    || block.flow == PL_X86_FLOW_CONDITIONAL
                    || block.flow == PL_X86_FLOW_CALL)
                && pl_x86_image_contains(
                    builder->image, terminal.fallthrough)) {
            pl_u64 fallthrough;
            status = output_address_for(
                builder, output_address, terminal.fallthrough, &fallthrough);
            if (status || at > 0xffffffffu - written
                    || output_address > 0xffffffffffffffffull
                                         - at - written) {
                if (builder->population) {
                    builder->population->emit_failure_stage = 6u;
                    builder->population->emit_failure_address = start;
                    builder->population->emit_failure_target =
                        terminal.fallthrough;
                    builder->population->emit_failure_output = fallthrough;
                    builder->population->emit_failure_expected =
                        output_address + at + written;
                }
                return PL_ERROR_BLOCK;
            }
            pl_u32 body_bytes = fixed_width ? fixed_width : written;
            if (at > 0xffffffffu - body_bytes)
                return PL_ERROR_BLOCK_LIMIT;
            pl_u32 body_end = at + body_bytes;
            pl_u32 allocated_end = boundary_index
                                     < builder->population->boundaries
                                 ? builder->queue[boundary_index]
                                 : builder->output_bytes;
            pl_u64 sequential = output_address + body_end;
            if (fallthrough != sequential) {
                if (body_end > 0xffffffffu - 5u
                        || allocated_end != body_end + 5u
                        || body_end + 5u > builder->output_bytes) {
                    if (builder->population) {
                        builder->population->emit_failure_stage = 6u;
                        builder->population->emit_failure_address = start;
                        builder->population->emit_failure_target =
                            terminal.fallthrough;
                        builder->population->emit_failure_output =
                            allocated_end;
                        builder->population->emit_failure_expected =
                            body_end + 5u;
                    }
                    return PL_ERROR_BLOCK;
                }
                pl_u64 next = sequential + 5u;
                pl_u64 magnitude;
                pl_u32 displacement;
                if (fallthrough >= next) {
                    magnitude = fallthrough - next;
                    if (magnitude > 0x7fffffffu) return PL_ERROR_BLOCK;
                    displacement = (pl_u32)magnitude;
                } else {
                    magnitude = next - fallthrough;
                    if (magnitude > 0x80000000u) return PL_ERROR_BLOCK;
                    displacement = 0u - (pl_u32)magnitude;
                }
                output[body_end] = 0xe9u;
                pl_write_u32(output + body_end + 1u, displacement);
                if (*fixup_count == 0xffffffffu)
                    return PL_ERROR_BLOCK_LIMIT;
                ++*fixup_count;
            } else if (allocated_end != body_end) {
                if (builder->population) {
                    builder->population->emit_failure_stage = 6u;
                    builder->population->emit_failure_address = start;
                    builder->population->emit_failure_target =
                        terminal.fallthrough;
                    builder->population->emit_failure_output = allocated_end;
                    builder->population->emit_failure_expected = body_end;
                }
                return PL_ERROR_BLOCK;
            }
        }
    }
    if (boundary_index != builder->population->boundaries)
        return PL_ERROR_BLOCK;
    return 0;
}

int pl_x86_native_write(const pl_x86_image *image,
                        const pl_u64 *entries, pl_u32 entry_count,
                        pl_u64 output_address,
                        pl_u8 *output, pl_u32 output_capacity,
                        pl_u8 *workspace, pl_u64 workspace_bytes,
                        pl_x86_native_population *population,
                        pl_x86_native_layout *layout)
{
    pl_u64 coordinate_count;
    pl_u64 required;
    pl_u64 bit_bytes;
    pl_u64 offset;
    if (!image || !entries || !entry_count || !output || !workspace
            || !population || !layout)
        return PL_ERROR_BLOCK;
    int status = pl_x86_image_validate(image);
    if (status) return status;
    status = coordinate_population(image, &coordinate_count);
    if (status) return status;
    status = pl_x86_native_workspace_measure(coordinate_count, &required);
    if (status || workspace_bytes < required)
        return PL_ERROR_BLOCK_LIMIT;

    *population = (pl_x86_native_population){ 0 };
    *layout = (pl_x86_native_layout){ 0 };
    population->executable_coordinates = coordinate_count;
    bit_bytes = (coordinate_count + 7u) >> 3u;
    for (pl_u64 index = 0u; index < bit_bytes * 7u; ++index)
        workspace[index] = 0u;
    offset = bit_bytes * 7u;
    if (!align_u64(offset, (pl_u64)sizeof(pl_u32), &offset))
        return PL_ERROR_BLOCK_LIMIT;
    pl_u32 *queue = (pl_u32 *)(void *)(workspace + offset);
    offset += coordinate_count * (pl_u64)sizeof *queue;
    pl_u32 rank_prefix_count =
        ((pl_u32)coordinate_count + NATIVE_RANK_COORDINATES - 1u)
        / NATIVE_RANK_COORDINATES + 1u;
    pl_u32 *rank_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *rank_prefix;
    pl_u32 *relax_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *relax_prefix;
    pl_u64 relax_pending_bytes = 0u;
    if (!bit_hierarchy_measure((coordinate_count + 1u) >> 1u,
                               &relax_pending_bytes)
            || relax_pending_bytes > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *relax_pending = workspace + offset;
    offset += relax_pending_bytes;
    if (!align_u64(offset, 16u, &offset))
        return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *first = workspace + offset;
    pl_u8 *second = first + NATIVE_ARENA_BYTES;
    pl_u8 *select_first = second + NATIVE_ARENA_BYTES;
    pl_u8 *select_second = select_first + NATIVE_ARENA_BYTES;

    native_builder builder = {
        .image = image,
        .boundary = workspace,
        .expanded = workspace + bit_bytes,
        .scanned = workspace + bit_bytes * 2u,
        .covered = workspace + bit_bytes * 3u,
        .relax_large = workspace + bit_bytes * 4u,
        .construction_fields = workspace + bit_bytes * 5u,
        .function_starts = workspace + bit_bytes * 6u,
        .queue = queue,
        .rank_prefix = rank_prefix,
        .relax_prefix = relax_prefix,
        .rank_prefix_count = rank_prefix_count,
        .relax_pending = relax_pending,
        .relax_pending_bytes = (pl_u32)relax_pending_bytes,
        .coordinate_count = (pl_u32)coordinate_count,
        .formation = { first, second, NATIVE_ARENA_BYTES,
                       (pl_u32)coordinate_count },
        .selection = { select_first, select_second, NATIVE_ARENA_BYTES,
                       (pl_u32)coordinate_count },
        .population = population,
    };
    status = pl_x86_frontend_open(image, &builder.frontend);
    for (pl_u32 index = 0u; !status && index < entry_count; ++index)
        status = enqueue(&builder, entries[index]);
    if (!status && population->nonimage_control_edges)
        status = PL_ERROR_BLOCK;
    if (!status) status = discover(&builder);
    if (!status) status = mark_code_grids(&builder, 0, 0u);
    if (!status) status = relax_short_controls(&builder);
    if (!status) status = form_population(&builder);
    if (!status && population->unselected_blocks) status = PL_ERROR_BLOCK;
    pl_u32 fixups = 0u;
    if (!status)
        status = write_population(
            &builder, output_address, output, output_capacity, &fixups);
    if (status) return status;
    publish_relaxed_controls(&builder);

    layout->image = image;
    layout->boundaries = builder.boundary;
    layout->construction_fields = builder.construction_fields;
    layout->fixed_coordinates = builder.scanned;
    layout->source_identity_coordinates = builder.expanded;
    layout->relaxed_control_coordinates = builder.covered;
    layout->offset_by_boundary = builder.queue;
    layout->rank_prefix = builder.rank_prefix;
    layout->coordinate_count = builder.coordinate_count;
    layout->offset_count = builder.population->boundaries;
    layout->rank_prefix_count = builder.rank_prefix_count;
    layout->output_address = output_address;
    layout->output_bytes = builder.output_bytes;
    layout->fixup_count = fixups;
    layout->selection_span_ceiling = builder.selection_span_ceiling;
    layout->selection_work_ceiling = builder.selection_work_ceiling;
    layout->formation = builder.formation;
    layout->selection = builder.selection;
    return 0;
}

int pl_x86_native_write_analyzed(
    const pl_x86_image *image, pl_u64 output_address,
    pl_u8 *output, pl_u32 output_capacity,
    const pl_x86_code_grid *code_grids, pl_u32 code_grid_count,
    const pl_u32 *live_outputs, pl_u32 live_output_count,
    pl_u8 *workspace, pl_u64 workspace_bytes,
    pl_x86_native_population *population,
    pl_x86_native_layout *layout)
{
    pl_u64 coordinate_count;
    pl_u64 required;
    pl_u64 bit_bytes;
    pl_u64 offset;
    if (!image || !output || !workspace || !population || !layout
            || (!!live_outputs != !!live_output_count)
            || (live_outputs && live_output_count != population->blocks)
            || population->unselected_blocks
            || population->selected_blocks != population->blocks
            || population->selected_output_bytes > output_capacity
            || population->selected_output_bytes > 0xffffffffu)
        return PL_ERROR_BLOCK;
    int status = pl_x86_image_validate(image);
    if (status) return status;
    status = coordinate_population(image, &coordinate_count);
    if (status || coordinate_count != population->executable_coordinates)
        return PL_ERROR_BLOCK;
    status = pl_x86_native_workspace_measure(coordinate_count, &required);
    if (status || workspace_bytes < required)
        return PL_ERROR_BLOCK_LIMIT;

    bit_bytes = (coordinate_count + 7u) >> 3u;
    offset = bit_bytes * 7u;
    if (!align_u64(offset, (pl_u64)sizeof(pl_u32), &offset))
        return PL_ERROR_BLOCK_LIMIT;
    pl_u32 *offset_by_boundary =
        (pl_u32 *)(void *)(workspace + offset);
    offset += coordinate_count * (pl_u64)sizeof *offset_by_boundary;
    pl_u32 rank_prefix_count =
        ((pl_u32)coordinate_count + NATIVE_RANK_COORDINATES - 1u)
        / NATIVE_RANK_COORDINATES + 1u;
    pl_u32 *rank_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *rank_prefix;
    pl_u32 *relax_prefix = (pl_u32 *)(void *)(workspace + offset);
    offset += (pl_u64)rank_prefix_count * sizeof *relax_prefix;
    pl_u64 relax_pending_bytes = 0u;
    if (!bit_hierarchy_measure((coordinate_count + 1u) >> 1u,
                               &relax_pending_bytes)
            || relax_pending_bytes > 0xffffffffu)
        return PL_ERROR_BLOCK_LIMIT;
    pl_u8 *relax_pending = workspace + offset;
    offset += relax_pending_bytes;
    if (!align_u64(offset, 16u, &offset))
        return PL_ERROR_BLOCK_LIMIT;

    native_builder builder = {
        .image = image,
        .boundary = workspace,
        .expanded = workspace + bit_bytes,
        .scanned = workspace + bit_bytes * 2u,
        .covered = workspace + bit_bytes * 3u,
        .relax_large = workspace + bit_bytes * 4u,
        .construction_fields = workspace + bit_bytes * 5u,
        .function_starts = workspace + bit_bytes * 6u,
        .live_outputs = live_outputs,
        .live_output_count = live_output_count,
        .queue = offset_by_boundary,
        .rank_prefix = rank_prefix,
        .relax_prefix = relax_prefix,
        .rank_prefix_count = rank_prefix_count,
        .relax_pending = relax_pending,
        .relax_pending_bytes = (pl_u32)relax_pending_bytes,
        .coordinate_count = (pl_u32)coordinate_count,
        .output_bytes = (pl_u32)population->selected_output_bytes,
        .selection_span_ceiling = population->selection_span_ceiling,
        .selection_work_ceiling = population->selection_work_ceiling,
        .selection_limits_valid = 1,
        .formation = { workspace + offset,
                       workspace + offset + NATIVE_ARENA_BYTES,
                       NATIVE_ARENA_BYTES, (pl_u32)coordinate_count },
        .selection = { workspace + offset + 2u * NATIVE_ARENA_BYTES,
                       workspace + offset + 3u * NATIVE_ARENA_BYTES,
                       NATIVE_ARENA_BYTES, (pl_u32)coordinate_count },
        .population = population,
    };
    status = pl_x86_frontend_open(image, &builder.frontend);
    /* Complete-future refinement deliberately reuses the dead discovery
     * bitsets.  Fixed code extents remain a layout input, so reconstruct
     * their two projections from the caller-owned finite extent list instead
     * of retaining another per-coordinate artifact. */
    if (!status)
        status = mark_code_grids(
            &builder, code_grids, code_grid_count);
    pl_u32 fixups = 0u;
    if (!status)
        status = write_population(
            &builder, output_address, output, output_capacity, &fixups);
    if (status) return status;
    publish_relaxed_controls(&builder);

    *layout = (pl_x86_native_layout){
        .image = image,
        .boundaries = builder.boundary,
        .construction_fields = builder.construction_fields,
        .fixed_coordinates = builder.scanned,
        .source_identity_coordinates = builder.expanded,
        .relaxed_control_coordinates = builder.covered,
        .offset_by_boundary = builder.queue,
        .rank_prefix = builder.rank_prefix,
        .live_outputs = builder.live_outputs,
        .coordinate_count = builder.coordinate_count,
        .offset_count = builder.population->boundaries,
        .rank_prefix_count = builder.rank_prefix_count,
        .live_output_count = builder.live_output_count,
        .output_address = output_address,
        .output_bytes = builder.output_bytes,
        .fixup_count = fixups,
        .selection_span_ceiling = builder.selection_span_ceiling,
        .selection_work_ceiling = builder.selection_work_ceiling,
        .formation = builder.formation,
        .selection = builder.selection,
    };
    return 0;
}

int pl_x86_native_resolve(const pl_x86_native_layout *layout,
                          pl_u64 source_address, pl_u64 *output_address)
{
    pl_u32 coordinate;
    pl_u32 rank;
    if (!layout || !layout->image || !layout->boundaries
            || !layout->offset_by_boundary || !layout->rank_prefix
            || !output_address
            || !address_coordinate(
                layout->image, source_address, &coordinate, 0)
            || coordinate >= layout->coordinate_count
            || !bit_get(layout->boundaries, coordinate))
        return PL_ERROR_BLOCK;
    native_builder builder = {
        .boundary = (pl_u8 *)(void *)layout->boundaries,
        .rank_prefix = (pl_u32 *)(void *)layout->rank_prefix,
        .rank_prefix_count = layout->rank_prefix_count,
        .coordinate_count = layout->coordinate_count,
    };
    if (boundary_rank(&builder, coordinate, &rank)
            || rank >= layout->offset_count
            || layout->output_address > 0xffffffffffffffffull
                                      - layout->offset_by_boundary[rank])
        return PL_ERROR_BLOCK;
    *output_address = layout->output_address
                    + layout->offset_by_boundary[rank];
    return 0;
}

int pl_x86_native_rank(const pl_x86_native_layout *layout,
                       pl_u64 source_address, pl_u32 *rank)
{
    pl_u32 coordinate;
    if (!layout || !layout->image || !layout->boundaries
            || !layout->rank_prefix || !rank
            || !address_coordinate(
                layout->image, source_address, &coordinate, 0)
            || coordinate >= layout->coordinate_count
            || !bit_get(layout->boundaries, coordinate))
        return PL_ERROR_BLOCK;
    native_builder builder = {
        .boundary = (pl_u8 *)(void *)layout->boundaries,
        .rank_prefix = (pl_u32 *)(void *)layout->rank_prefix,
        .rank_prefix_count = layout->rank_prefix_count,
        .coordinate_count = layout->coordinate_count,
    };
    int status = boundary_rank(&builder, coordinate, rank);
    return status || *rank >= layout->offset_count
         ? PL_ERROR_BLOCK : 0;
}

int pl_x86_native_project_field_diagnostic(
    const pl_x86_native_layout *layout,
    pl_u64 source_address, pl_u32 source_bytes,
    pl_u64 *output_address, int *retained,
    pl_x86_native_projection *projection)
{
    if (projection) {
        *projection = (pl_x86_native_projection){ 0 };
        projection->source_address = source_address;
    }
    pl_u32 coordinate;
    pl_u32 map_index;
    if (!layout || !layout->image || !layout->boundaries
            || !layout->construction_fields
            || !layout->fixed_coordinates
            || !layout->source_identity_coordinates
            || !layout->relaxed_control_coordinates
            || !layout->offset_by_boundary || !layout->rank_prefix
            || !source_bytes
            || !output_address || !retained
            || !layout->formation.first || !layout->formation.second
            || !layout->selection.first || !layout->selection.second
            || !address_coordinate(layout->image, source_address,
                                   &coordinate, &map_index))
        return projection
             ? (projection->reason = 61u,
                PL_ERROR_NATIVE_PROJECT_ARGUMENT)
             : PL_ERROR_NATIVE_PROJECT_ARGUMENT;
    pl_u64 map_base64 = 0u;
    for (pl_u32 index = 0u; index < map_index; ++index)
        map_base64 += layout->image->maps[index].memory_bytes;
    if (map_base64 > coordinate) return PL_ERROR_NATIVE_PROJECT_BOUNDARY;
    pl_u32 map_base = (pl_u32)map_base64;
    pl_u32 boundary = 0u;
    if (!bit_previous(layout->boundaries, layout->coordinate_count,
                      coordinate, &boundary)
            || boundary < map_base) {
        /* This executable map has no admitted block at or before the
         * construction field.  The field belongs wholly to unreachable
         * linked payload and therefore has no output byte to relocate. */
        *retained = 0;
        *output_address = 0u;
        return 0;
    }

    /* Address-observed terminal spans retain one affine source-to-output
     * coordinate map.  Their decoded block ends at the terminal instruction,
     * but construction fields in the published tail are still live bytes and
     * must be rebound at the same relative coordinate. */
    if (bit_get(layout->source_identity_coordinates, coordinate)) {
        pl_u64 end_coordinate = (pl_u64)coordinate + source_bytes;
        if (end_coordinate > layout->coordinate_count)
            return PL_ERROR_NATIVE_PROJECT_END;
        for (pl_u32 byte = 0u; byte < source_bytes; ++byte) {
            pl_u32 member = coordinate + byte;
            if (!bit_get(layout->fixed_coordinates, member)
                    || !bit_get(
                        layout->source_identity_coordinates, member))
                return PL_ERROR_NATIVE_PROJECT_END;
        }
        pl_u64 owner = layout->image->maps[map_index].address
                     + (pl_u64)(boundary - map_base);
        pl_u64 base;
        int status = pl_x86_native_resolve(layout, owner, &base);
        pl_u64 relative = (pl_u64)coordinate - boundary;
        if (status || base > 0xffffffffffffffffull - relative)
            return PL_ERROR_NATIVE_PROJECT_RESOLVE;
        *output_address = base + relative;
        *retained = 1;
        if (projection) {
            projection->block_start = owner;
            projection->block_end = owner
                                  + (pl_u64)(end_coordinate - boundary);
            projection->source_end = source_address + source_bytes;
            projection->reason =
                PL_X86_NATIVE_PROJECTION_SOURCE_IDENTITY;
        }
        return 0;
    }

    native_builder builder = {
        .image = layout->image,
        .boundary = (pl_u8 *)(void *)layout->boundaries,
        .expanded =
            (pl_u8 *)(void *)layout->source_identity_coordinates,
        .scanned = (pl_u8 *)(void *)layout->fixed_coordinates,
        .construction_fields =
            (pl_u8 *)(void *)layout->construction_fields,
        .covered =
            (pl_u8 *)(void *)layout->relaxed_control_coordinates,
        .queue = (pl_u32 *)(void *)layout->offset_by_boundary,
        .rank_prefix = (pl_u32 *)(void *)layout->rank_prefix,
        .live_outputs = layout->live_outputs,
        .live_output_count = layout->live_output_count,
        .rank_prefix_count = layout->rank_prefix_count,
        .coordinate_count = layout->coordinate_count,
        .output_bytes = layout->output_bytes,
        .selection_span_ceiling = layout->selection_span_ceiling,
        .selection_work_ceiling = layout->selection_work_ceiling,
        .selection_limits_valid = 1,
        .formation = layout->formation,
        .selection = layout->selection,
    };
    pl_u64 source_end = 0u;
    if (!pl_checked_add_u64(source_address, source_bytes, &source_end)) {
        if (projection) {
            projection->reason = 68u;
            projection->source_end = source_end;
        }
        return PL_ERROR_NATIVE_PROJECT_END;
    }
    int status = pl_x86_frontend_open(layout->image, &builder.frontend);
    pl_x86_block block = { 0 };
    pl_x86_native_selection selection = { 0 };
    /* An independently admitted overlapping entry can begin inside the
     * instruction that owns this construction field.  Nearest-boundary alone
     * would then project the field through the overlapping spelling.  Walk
     * back to the first admitted body that contains the complete field; the
     * formation cut still permits its first x86 instruction to cross the next
     * entry, so this selects the unique linked owner without an overlap graph. */
    int complete_owner = 0;
    int synthetic_owner = 0;
    pl_u32 nearest_boundary = boundary;
    while (!status && nearest_boundary - boundary
            < PL_X86_MAX_INSTRUCTION_BYTES) {
        int candidate_status = form_at(&builder, boundary, &block);
        if (!candidate_status
                && source_address >= block.start
                && source_end <= block.end) {
            block.relax_short_control = (pl_u8)bit_get(
                layout->relaxed_control_coordinates, boundary);
            pl_x86_instruction terminal;
            candidate_status = final_block_instruction(
                &builder, &block, &terminal);
            pl_u32 bridge_bytes = 0u;
            if (!candidate_status)
                candidate_status = block_bridge_bytes(
                    &builder, boundary, &block, &terminal, &bridge_bytes);
            if (!candidate_status)
                candidate_status = select_block_under_limits(
                    &builder, &block, bridge_bytes ? 1u : 0u,
                    &selection);
            pl_u64 candidate_omitted = 0u;
            if (!candidate_status && selection.supported
                    && selection.direct_frame) {
                synthetic_owner = 1;
                pl_u64 relative64 = source_address - block.start;
                if (relative64 <= 0xffffffffu) {
                    pl_u32 relative = (pl_u32)relative64;
                    for (pl_u32 field = 0u;
                            field < selection.fixup_count; ++field) {
                        const pl_x86_native_fixup *fixup =
                            &selection.fixups[field];
                        if (!fixup->source_bytes
                                || fixup->source_at != relative
                                || fixup->source_bytes != source_bytes)
                            continue;
                        pl_u64 base = 0u;
                        candidate_status = pl_x86_native_resolve(
                            layout, block.start, &base);
                        if (candidate_status
                                || base > 0xffffffffffffffffull
                                           - fixup->at)
                            return PL_ERROR_NATIVE_PROJECT_RESOLVE;
                        *output_address = base + fixup->at;
                        *retained = 1;
                        if (projection) {
                            projection->block_start = block.start;
                            projection->block_end = block.end;
                            projection->source_end = source_end;
                            projection->synthetic_target = fixup->target;
                            projection->synthetic_kind = fixup->kind;
                            projection->reason =
                                PL_X86_NATIVE_PROJECTION_SYNTHETIC_FIELD;
                        }
                        return 0;
                    }
                }
            }
            if (!candidate_status && selection.supported
                    && !selection.direct_frame
                    && pl_checked_add_u64(
                        block.start, selection.omitted_prefix_bytes,
                        &candidate_omitted)
                    && source_address >= candidate_omitted) {
                complete_owner = 1;
                break;
            }
        }
        if (boundary == map_base) break;
        do {
            --boundary;
        } while (boundary > map_base
                && !bit_get(layout->boundaries, boundary));
        if (!bit_get(layout->boundaries, boundary)) break;
    }
    if (!status && !complete_owner) {
        if (synthetic_owner) {
            if (projection) {
                projection->block_start = block.start;
                projection->block_end = block.end;
                projection->source_end = source_end;
                projection->reason = 70u;
            }
            return PL_ERROR_NATIVE_PROJECT_SYNTHETIC;
        }
        /* An overlapping entry may consume some of the same linked bytes
         * under a different instruction meaning.  That does not retain the
         * construction field of an unadmitted source instruction: selection
         * already owns the overlapping spelling as ordinary bytes. */
        *retained = 0;
        *output_address = 0u;
        return 0;
    }
    pl_u64 omitted_end;
    if (status || !selection.supported)
        return PL_ERROR_NATIVE_PROJECT_FORM;
    if (projection) {
        projection->block_start = block.start;
        projection->block_end = block.end;
    }
    if (source_address < block.start)
        return PL_ERROR_NATIVE_PROJECT_BEFORE;
    /* A construction record can describe a code field in a lexical gap that
     * is absent from the linked closure.  No byte from that instruction is
     * emitted, so the field is wholly absent rather than an invalid partial
     * projection. */
    if (source_address >= block.end) {
        *retained = 0;
        *output_address = 0u;
        return 0;
    }
    if (source_end > block.end) {
        if (projection) {
            projection->reason = 68u;
            projection->source_end = source_end;
        }
        return PL_ERROR_NATIVE_PROJECT_END;
    }
    /* Newly selected instructions are ordinary x86, but their fields are not
     * retained source bytes.  Silently projecting a construction relocation
     * by offset would patch an unrelated immediate after reordering.  The
     * compiler therefore rejects such a field; a later selector may accept
     * it only by publishing an exact source-field to output-field mapping. */
    if (selection.direct_frame) {
        if (projection) projection->reason = 70u;
        return PL_ERROR_NATIVE_PROJECT_SYNTHETIC;
    }
    if (!pl_checked_add_u64(block.start,
                            selection.omitted_prefix_bytes, &omitted_end))
        return PL_ERROR_NATIVE_PROJECT_OMISSION;
    if (projection) {
        projection->source_end = source_end;
        projection->omitted_end = omitted_end;
    }
    if (source_end <= omitted_end) {
        *retained = 0;
        *output_address = 0u;
        return 0;
    }
    if (source_address < omitted_end)
        return PL_ERROR_NATIVE_PROJECT_PARTIAL;
    pl_u64 relative = source_address - block.start
                    - selection.omitted_prefix_bytes;
    pl_u64 base;
    status = pl_x86_native_resolve(layout, block.start, &base);
    if (status || base > 0xffffffffffffffffull - relative)
        return PL_ERROR_NATIVE_PROJECT_RESOLVE;
    *output_address = base + relative;
    *retained = 1;
    return 0;
}

int pl_x86_native_project_field(const pl_x86_native_layout *layout,
                                pl_u64 source_address, pl_u32 source_bytes,
                                pl_u64 *output_address, int *retained)
{
    return pl_x86_native_project_field_diagnostic(
        layout, source_address, source_bytes,
        output_address, retained, 0);
}

int pl_x86_native_resolve_field(const pl_x86_native_layout *layout,
                                pl_u64 source_address,
                                pl_u64 *output_address)
{
    int retained = 0;
    int status = pl_x86_native_project_field(
        layout, source_address, 1u, output_address, &retained);
    return status || !retained ? PL_ERROR_BLOCK : 0;
}

int pl_x86_native_project_boundary(const pl_x86_native_layout *layout,
                                   pl_u64 source_address,
                                   pl_u64 *output_address)
{
    pl_u32 coordinate;
    pl_u32 map_index;
    int one_past_map = 0;
    if (!layout || !layout->image || !layout->boundaries
            || !layout->construction_fields
            || !layout->offset_by_boundary || !layout->rank_prefix
            || !output_address
            || !layout->formation.first || !layout->formation.second
            || !layout->selection.first || !layout->selection.second)
        return PL_ERROR_BLOCK;
    if (!address_coordinate(
            layout->image, source_address, &coordinate, &map_index)) {
        pl_u64 base = 0u;
        int found = 0;
        for (pl_u32 index = 0u; index < layout->image->map_count; ++index) {
            const pl_x86_map *map = &layout->image->maps[index];
            if (source_address == map->address + map->memory_bytes) {
                pl_u64 one_past = base + map->memory_bytes;
                if (one_past > layout->coordinate_count) return PL_ERROR_BLOCK;
                coordinate = (pl_u32)one_past;
                map_index = index;
                one_past_map = 1;
                found = 1;
                break;
            }
            base += map->memory_bytes;
        }
        if (!found) return PL_ERROR_BLOCK;
    }
    pl_u64 map_base64 = 0u;
    for (pl_u32 index = 0u; index < map_index; ++index)
        map_base64 += layout->image->maps[index].memory_bytes;
    if (map_base64 > coordinate) return PL_ERROR_BLOCK;
    pl_u32 map_base = (pl_u32)map_base64;
    /* Coordinates concatenate disjoint executable maps.  The coordinate one
     * past one map is numerically equal to the first coordinate of the next
     * map, even when their virtual addresses have a gap.  An FDE ending at
     * the former must project through the preceding block, never through the
     * unrelated next map. */
    if (one_past_map && coordinate == map_base) return PL_ERROR_BLOCK;
    pl_u32 candidate_boundary = one_past_map
                    ? coordinate - 1u
                    : coordinate == layout->coordinate_count
                    ? coordinate - 1u : coordinate;
    pl_u32 boundary = 0u;
    if (!bit_previous(layout->boundaries, layout->coordinate_count,
                      candidate_boundary, &boundary)
            || boundary < map_base)
        return PL_ERROR_BLOCK;

    native_builder builder = {
        .image = layout->image,
        .boundary = (pl_u8 *)(void *)layout->boundaries,
        .expanded =
            (pl_u8 *)(void *)layout->source_identity_coordinates,
        .scanned = (pl_u8 *)(void *)layout->fixed_coordinates,
        .construction_fields =
            (pl_u8 *)(void *)layout->construction_fields,
        .queue = (pl_u32 *)(void *)layout->offset_by_boundary,
        .rank_prefix = (pl_u32 *)(void *)layout->rank_prefix,
        .live_outputs = layout->live_outputs,
        .live_output_count = layout->live_output_count,
        .rank_prefix_count = layout->rank_prefix_count,
        .coordinate_count = layout->coordinate_count,
        .output_bytes = layout->output_bytes,
        .selection_span_ceiling = layout->selection_span_ceiling,
        .selection_work_ceiling = layout->selection_work_ceiling,
        .selection_limits_valid = 1,
        .formation = layout->formation,
        .selection = layout->selection,
    };
    int status = pl_x86_frontend_open(layout->image, &builder.frontend);
    pl_x86_block block;
    if (!status) status = form_at(&builder, boundary, &block);
    pl_x86_native_selection selection;
    if (!status) {
        pl_x86_instruction terminal;
        status = final_block_instruction(&builder, &block, &terminal);
        pl_u32 bridge_bytes = 0u;
        if (!status)
            status = block_bridge_bytes(
                &builder, boundary, &block, &terminal, &bridge_bytes);
        if (!status)
            status = select_block_under_limits(
                &builder, &block, bridge_bytes ? 1u : 0u, &selection);
    }
    if (status || !selection.supported || source_address < block.start)
        return PL_ERROR_BLOCK;
    if (source_address > block.end) {
        /* boundary is the last admitted block start at or before the source
         * boundary.  Therefore the lexical suffix after block.end contains
         * no member of the closed population.  Project the whole unreachable
         * suffix to the preceding output end without decoding or lowering it:
         * its bytes cannot affect any admitted future, even when an input FDE
         * lexically covered them. */
        source_address = block.end;
    }
    if (selection.direct_frame) {
        pl_u64 base;
        status = pl_x86_native_resolve(layout, block.start, &base);
        if (status) return PL_ERROR_BLOCK;
        if (source_address == block.start) {
            *output_address = base;
            return 0;
        }
        if (source_address == block.end
                && base <= 0xffffffffffffffffull - selection.output_bytes) {
            *output_address = base + selection.output_bytes;
            return 0;
        }
        return PL_ERROR_NATIVE_PROJECT_SYNTHETIC;
    }
    pl_u64 copied_from = block.start + selection.omitted_prefix_bytes;
    pl_u64 relative = source_address <= copied_from
                    ? 0u : source_address - copied_from;
    if (relative > selection.output_bytes) return PL_ERROR_BLOCK;
    pl_u64 base;
    status = pl_x86_native_resolve(layout, block.start, &base);
    if (status || base > 0xffffffffffffffffull - relative)
        return PL_ERROR_BLOCK;
    *output_address = base + relative;
    return 0;
}
