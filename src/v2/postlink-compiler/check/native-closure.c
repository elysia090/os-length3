#include "../src/internal/discover-entry.h"
#include "../src/internal/layout-elf.h"
#include "../src/internal/compile-elf.h"
#include "../src/internal/x86-selection.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAP_CAPACITY 64u

static int boundary_bit(const pl_u8 *bits, pl_u32 coordinate)
{
    return !!(bits[coordinate >> 3u] & (pl_u8)(1u << (coordinate & 7u)));
}

static int coordinate_source(const pl_x86_image *image, pl_u32 coordinate,
                             pl_u64 *source)
{
    pl_u64 base = 0u;
    if (!image || !source) return 0;
    for (pl_u32 index = 0u; index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        if (coordinate >= base
                && (pl_u64)coordinate - base < map->memory_bytes) {
            *source = map->address + ((pl_u64)coordinate - base);
            return 1;
        }
        base += map->memory_bytes;
    }
    return 0;
}

static int map_output(const pl_x86_image *image, const pl_u8 *input,
                      pl_u64 input_bytes, pl_u8 *workspace,
                      pl_u64 workspace_bytes,
                      const pl_x86_code_grid *code_grids,
                      pl_u32 code_grid_count,
                      const pl_u32 *live_outputs,
                      pl_u32 live_output_count,
                      pl_x86_native_population *population,
                      pl_u64 query, pl_u64 *mapped_source)
{
    pl_x86_runtime_elf_layout runtime;
    int status = pl_x86_runtime_elf_measure(
        input, input_bytes, population->selected_output_bytes, &runtime);
    pl_u8 *output = !status
                  ? malloc((size_t)population->selected_output_bytes) : 0;
    pl_x86_native_layout layout;
    if (!status && !output) status = -1;
    if (!status)
        status = pl_x86_native_write_analyzed(
            image, runtime.code_address, output,
            (pl_u32)population->selected_output_bytes,
            code_grids, code_grid_count,
            live_outputs, live_output_count,
            workspace, workspace_bytes, population, &layout);
    if (!status && (query < layout.output_address
            || query >= layout.output_address + layout.output_bytes))
        status = -1;

    pl_u32 owner = 0xffffffffu;
    pl_u32 next = 0xffffffffu;
    pl_u32 owner_offset = 0u;
    pl_u32 next_offset = 0u;
    pl_u32 boundary_rank = 0u;
    pl_u32 query_offset = status ? 0u
                        : (pl_u32)(query - layout.output_address);
    for (pl_u32 coordinate = 0u;
            !status && coordinate < layout.coordinate_count; ++coordinate) {
        if (!boundary_bit(layout.boundaries, coordinate)) continue;
        if (boundary_rank >= layout.offset_count) {
            status = -1;
            break;
        }
        pl_u32 offset = layout.offset_by_boundary[boundary_rank++];
        if (offset <= query_offset
                && (owner == 0xffffffffu
                    || owner_offset <= offset)) {
            owner = coordinate;
            owner_offset = offset;
        }
        if (offset > query_offset
                && (next == 0xffffffffu
                    || offset < next_offset)) {
            next = coordinate;
            next_offset = offset;
        }
    }
    pl_u64 source = 0u;
    pl_u64 next_source = 0u;
    if (!status && (owner == 0xffffffffu
            || !coordinate_source(image, owner, &source)))
        status = -1;
    if (!status && next != 0xffffffffu
            && !coordinate_source(image, next, &next_source))
        status = -1;
    pl_u64 exact_source = 0u;
    int exact = 0;
    pl_u32 owner_rank = 0u;
    if (!status)
        status = pl_x86_native_rank(&layout, source, &owner_rank);
    if (!status && owner_rank >= layout.live_output_count)
        status = -1;
    if (!status) {
        pl_u64 end = next_source > source ? next_source : source + 256u;
        for (pl_u64 at = source; at < end; ++at) {
            pl_u64 projected = 0u;
            int retained = 0;
            int projected_status = pl_x86_native_project_field(
                &layout, at, 1u, &projected, &retained);
            if (!projected_status && retained && projected == query) {
                exact_source = at;
                exact = 1;
                break;
            }
        }
    }
    if (!status)
        printf("output map: 0x%llx -> source block 0x%llx, "
               "source byte %s0x%llx, block output 0x%llx, "
               "next 0x%llx, live=0x%x\n",
               (unsigned long long)query,
               (unsigned long long)source, exact ? "" : "not-found/",
               (unsigned long long)exact_source,
               (unsigned long long)(layout.output_address + owner_offset),
               (unsigned long long)(next == 0xffffffffu ? 0u
                   : layout.output_address + next_offset),
               layout.live_outputs[owner_rank]);
    if (!status && mapped_source) *mapped_source = source;
    free(output);
    return status;
}

static int map_source(const pl_x86_image *image, const pl_u8 *input,
                      pl_u64 input_bytes, pl_u8 *workspace,
                      pl_u64 workspace_bytes,
                      const pl_x86_code_grid *code_grids,
                      pl_u32 code_grid_count,
                      const pl_u32 *live_outputs,
                      pl_u32 live_output_count,
                      pl_x86_native_population *population,
                      pl_u64 query, pl_u32 field_bytes)
{
    pl_x86_runtime_elf_layout runtime;
    int status = pl_x86_runtime_elf_measure(
        input, input_bytes, population->selected_output_bytes, &runtime);
    pl_u8 *output = !status
                  ? malloc((size_t)population->selected_output_bytes) : 0;
    pl_x86_native_layout layout;
    if (!status && !output) status = -1;
    if (!status)
        status = pl_x86_native_write_analyzed(
            image, runtime.code_address, output,
            (pl_u32)population->selected_output_bytes,
            code_grids, code_grid_count,
            live_outputs, live_output_count,
            workspace, workspace_bytes, population, &layout);
    pl_u64 projected = 0u;
    int retained = 0;
    if (!status)
        status = field_bytes
            ? pl_x86_native_project_field(
                &layout, query, field_bytes, &projected, &retained)
            : pl_x86_native_resolve(&layout, query, &projected);
    if (!status) {
        if (field_bytes)
            printf("source field: 0x%llx+%u -> output 0x%llx retained=%d\n",
                   (unsigned long long)query, field_bytes,
                   (unsigned long long)projected, retained);
        else
            printf("source map: 0x%llx -> output 0x%llx\n",
                   (unsigned long long)query,
                   (unsigned long long)projected);
    }
    free(output);
    return status;
}

static char operand_kind(pl_u8 kind)
{
    static const char names[] = { 'c', 's', 'l', 'n', 'p' };
    return kind < sizeof names ? names[kind] : '?';
}

static int dump_block(const char *label, const pl_x86_image *image,
                      pl_u8 *workspace, pl_u64 workspace_bytes,
                      pl_u64 address,
                      const pl_x86_native_escape_sample *sample,
                      int compact)
{
    pl_u64 coordinates = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index)
        if (!pl_checked_add_u64(
                coordinates, image->maps[index].memory_bytes, &coordinates))
            return -1;
    pl_u64 fixed = ((coordinates + 7u) >> 3u) * 4u;
    fixed = (fixed + sizeof(pl_u32) - 1u)
          & ~((pl_u64)sizeof(pl_u32) - 1u);
    if (!pl_checked_add_u64(
            fixed, coordinates * (pl_u64)sizeof(pl_u32), &fixed))
        return -1;
    fixed = (fixed + 15u) & ~(pl_u64)15u;
    if (fixed > workspace_bytes
            || workspace_bytes - fixed < 4u * 1024u * 1024u)
        return -1;
    pl_u8 *arena = workspace + fixed;
    pl_x86_block_workspace formation = {
        arena, arena + 1024u * 1024u, 1024u * 1024u, 64u,
    };
    pl_x86_block_workspace selection_workspace = {
        arena + 2u * 1024u * 1024u,
        arena + 3u * 1024u * 1024u,
        1024u * 1024u, 64u,
    };
    pl_x86_frontend frontend;
    pl_x86_block block;
    int status = pl_x86_frontend_open(image, &frontend);
    if (!status)
        status = sample
            ? pl_x86_block_lower_projected_until(
                &frontend, address, sample->end,
                sample->live_output_mask, &formation, &block)
            : pl_x86_block_lower(&frontend, address, &formation, &block);
    if (status) return status;
    if (sample) {
        block.construction_fields = sample->construction_fields;
        block.relax_short_control = sample->relax_short_control;
    }
    pl_x86_native_candidates candidates;
    if (compact) {
        status = pl_x86_select_candidates(
            &frontend, &selection_workspace, &block, &candidates);
        if (status) return status;
        printf("escape 0x%llx src=%u nodes=%u span=%u flow=%u "
               "predicate=%u fault=%u machine=%u fields=%u "
               "blocking=0x%x sources=0x%x pending=0x%llx candidates=%u",
               (unsigned long long)block.start,
               block.instruction_count, block.plan.node_count,
               block.plan.span, block.flow, block.has_predicate,
               block.has_fault_predicate, block.machine_operation,
               block.construction_fields,
               candidates.diagnostic.blocking_work,
               candidates.diagnostic.blocking_opcode,
               (unsigned long long)candidates.diagnostic.projected_instruction_mask,
               candidates.count);
        if (candidates.count)
            printf(" emitted=%u/%u/%u",
                   candidates.candidate[0].output_instructions,
                   candidates.candidate[0].output_work,
                   candidates.candidate[0].output_span);
        printf(" source_ops=");
        pl_u64 rip = block.start;
        for (pl_u32 instruction = 0u;
                instruction < block.instruction_count; ++instruction) {
            pl_x86_instruction decoded;
            status = pl_x86_frontend_decode(&frontend, rip, &decoded);
            if (status) return status;
            printf("%s%u", instruction ? "," : "", decoded.operation);
            rip = decoded.fallthrough;
        }
        printf(" plan_ops=");
        for (pl_u32 node = 0u; node < block.plan.node_count; ++node)
            printf("%s%u", node ? "," : "", block.plan.nodes[node].opcode);
        putchar('\n');
        return 0;
    }
    printf("%s block: 0x%llx..0x%llx, %u instructions, %u work/%u span\n",
           label, (unsigned long long)block.start,
           (unsigned long long)block.end, block.instruction_count,
           block.plan.node_count, block.plan.span);
    printf("  shape: kind=%u dynamic=%u predicate=%u fault=%u machine=%u "
           "stack=%u fields=%u\n",
           block.kind, block.dynamic_target, block.has_predicate,
           block.has_fault_predicate, block.machine_operation,
           block.plan.stack_count, block.construction_fields);
    for (pl_u32 wave = 0u; wave < block.plan.span; ++wave) {
        pl_u32 begin = block.plan.wave_offsets[wave];
        pl_u32 end = block.plan.wave_offsets[wave + 1u];
        printf("  wave %u:", wave + 1u);
        for (pl_u32 at = begin; at < end; ++at) {
            pl_u32 value = block.plan.wave_values[at];
            const pl_node *node = &block.plan.nodes[value - 1u];
            printf(" n%u=op%u(", value, node->opcode);
            for (pl_u32 slot = 0u; slot < node->argument_count; ++slot) {
                pl_operand operand =
                    block.plan.arguments[node->argument_at + slot];
                if (slot) putchar(',');
                printf("%c%llx", operand_kind(operand.kind),
                       (unsigned long long)operand.value);
            }
            putchar(')');
        }
        putchar('\n');
    }
    printf("  publications:");
    for (pl_u32 local = 0u; local < block.plan.local_count; ++local) {
        pl_operand operand = block.plan.locals[local];
        if (operand.kind == PL_OPERAND_LOCAL && operand.value == local)
            continue;
        printf(" l%u=%c%llx", local, operand_kind(operand.kind),
               (unsigned long long)operand.value);
    }
    printf("; control=%u/%u target=%c%llx predicate=%c%llx\n",
           block.flow, block.successor_count,
           operand_kind(block.target.kind),
           (unsigned long long)block.target.value,
           operand_kind(block.predicate.kind),
           (unsigned long long)block.predicate.value);
    status = pl_x86_select_candidates(
        &frontend, &selection_workspace, &block, &candidates);
    printf("  candidates: %u (status=%d, diagnostic stage=%u "
           "blocking=0x%x)\n",
           candidates.count, status, candidates.diagnostic_stage,
           candidates.diagnostic.blocking_work);
    for (pl_u32 candidate = 0u;
            candidate < candidates.count; ++candidate) {
        const pl_x86_native_selection *selection =
            &candidates.candidate[candidate];
        printf("    %u: direct=%u source=%u bytes=%u work/span=%u/%u "
               "families=c%ua%ui%uq%us%um%uk%uu%ut%uz%uh%uo%uv%ux%ub%uf%u "
               "fixups=%u",
               candidate, selection->direct_frame,
               selection->copied_source, selection->output_bytes,
               selection->output_work, selection->output_span,
               selection->direct_common_frame,
               selection->direct_add_frame,
               selection->direct_insert_frame,
               selection->direct_compare_frame,
               selection->direct_shift_frame,
               selection->direct_mul_add_carry_frame,
               selection->direct_condition_carry_frame,
               selection->direct_alu_frame,
               selection->direct_transient_owner_frame,
               selection->direct_zero_flag_frame,
               selection->direct_shift_handoff_frame,
               selection->direct_shared_owner_frame,
               selection->direct_value_predicate_frame,
               selection->direct_compare_handoff_frame,
               selection->direct_branch_frame,
               selection->direct_affine_frame,
               selection->fixup_count);
        if (selection->direct_live_frame || selection->direct_shared_dag_frame
                || selection->direct_consumed_flag_frame
                || selection->direct_transient_seed_frame
                || selection->direct_nested_frame
                || selection->direct_shared_parent_frame)
            printf(" extended=live%u/dag%u/flag%u/seed%u/nested%u/parent%u",
                   selection->direct_live_frame,
                   selection->direct_shared_dag_frame,
                   selection->direct_consumed_flag_frame,
                   selection->direct_transient_seed_frame,
                   selection->direct_nested_frame,
                   selection->direct_shared_parent_frame);
        for (pl_u32 field = 0u;
                field < selection->fixup_count; ++field) {
            const pl_x86_native_fixup *fixup =
                &selection->fixups[field];
            printf(" [%u+%u -> %u+%u kind=%u target=0x%llx]",
                   fixup->source_at, fixup->source_bytes,
                   fixup->at, fixup->bytes, fixup->kind,
                   (unsigned long long)fixup->target);
        }
        pl_u8 emitted[2048u];
        pl_u32 emitted_bytes = 0u;
        int emitted_status = pl_x86_select_write_measured(
            &frontend, &block, selection, emitted, sizeof emitted,
            &emitted_bytes);
        printf(" write=%d/%u", emitted_status, emitted_bytes);
        if (!emitted_status) {
            printf(" code=");
            for (pl_u32 byte = 0u; byte < emitted_bytes; ++byte)
                printf("%02x", emitted[byte]);
        }
        putchar('\n');
    }
    return status;
}

static int dump_projected(const pl_x86_image *image, const pl_u8 *input,
                          pl_u64 input_bytes, pl_u8 *workspace,
                          pl_u64 workspace_bytes,
                          const pl_x86_code_grid *code_grids,
                          pl_u32 code_grid_count,
                          const pl_u32 *live_outputs,
                          pl_u32 live_output_count,
                          pl_x86_native_population *population,
                          pl_u64 query)
{
    pl_x86_runtime_elf_layout runtime;
    int status = pl_x86_runtime_elf_measure(
        input, input_bytes, population->selected_output_bytes, &runtime);
    pl_u8 *output = !status
                  ? malloc((size_t)population->selected_output_bytes) : 0;
    pl_x86_native_layout layout;
    if (!status && !output) status = -1;
    if (!status)
        status = pl_x86_native_write_analyzed(
            image, runtime.code_address, output,
            (pl_u32)population->selected_output_bytes,
            code_grids, code_grid_count,
            live_outputs, live_output_count,
            workspace, workspace_bytes, population, &layout);
    pl_u32 rank = 0u;
    if (!status) status = pl_x86_native_rank(&layout, query, &rank);
    if (!status && rank >= layout.live_output_count) status = -1;
    pl_u64 base = 0u, end = 0u;
    pl_u32 coordinate = 0u;
    int found = 0;
    for (pl_u32 index = 0u; !status && index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        if (query >= map->address
                && query - map->address < map->memory_bytes) {
            coordinate = (pl_u32)(base + query - map->address);
            end = map->address + map->memory_bytes;
            for (pl_u32 next = coordinate + 1u;
                    next < base + map->memory_bytes; ++next)
                if (boundary_bit(layout.boundaries, next)) {
                    end = map->address + (pl_u64)next - base;
                    break;
                }
            found = 1;
            break;
        }
        base += map->memory_bytes;
    }
    if (!status && (!found || end <= query)) status = -1;
    if (!status) {
        pl_x86_native_escape_sample sample = {
            .start = query,
            .end = end,
            .live_output_mask = layout.live_outputs[rank],
            .construction_fields =
                (pl_u8)boundary_bit(layout.construction_fields, coordinate),
            .relax_short_control = (pl_u8)boundary_bit(
                layout.relaxed_control_coordinates, coordinate),
        };
        status = dump_block("requested projected", image, workspace,
                            workspace_bytes, query, &sample, 0);
    }
    free(output);
    return status;
}

static int dump_projected_range(const pl_x86_image *image,
                                const pl_u8 *input, pl_u64 input_bytes,
                                pl_u8 *workspace, pl_u64 workspace_bytes,
                                const pl_x86_code_grid *code_grids,
                                pl_u32 code_grid_count,
                                const pl_u32 *live_outputs,
                                pl_u32 live_output_count,
                                pl_x86_native_population *population,
                                pl_u64 first, pl_u64 limit)
{
    pl_x86_runtime_elf_layout runtime;
    int status = pl_x86_runtime_elf_measure(
        input, input_bytes, population->selected_output_bytes, &runtime);
    pl_u8 *output = !status
                  ? malloc((size_t)population->selected_output_bytes) : 0;
    pl_x86_native_layout layout;
    if (!status && !output) status = -1;
    if (!status)
        status = pl_x86_native_write_analyzed(
            image, runtime.code_address, output,
            (pl_u32)population->selected_output_bytes,
            code_grids, code_grid_count,
            live_outputs, live_output_count,
            workspace, workspace_bytes, population, &layout);
    pl_u64 base = 0u;
    for (pl_u32 index = 0u; !status && index < image->map_count; ++index) {
        const pl_x86_map *map = &image->maps[index];
        pl_u64 map_end = map->address + map->memory_bytes;
        pl_u64 at = first > map->address ? first : map->address;
        pl_u64 end = limit < map_end ? limit : map_end;
        for (; at < end; ++at) {
            pl_u32 coordinate = (pl_u32)(base + at - map->address);
            if (!boundary_bit(layout.boundaries, coordinate)) continue;
            pl_u32 rank = 0u;
            status = pl_x86_native_rank(&layout, at, &rank);
            if (status || rank >= layout.live_output_count) {
                status = -1;
                break;
            }
            pl_u64 block_end = map_end;
            for (pl_u32 next = coordinate + 1u;
                    next < base + map->memory_bytes; ++next)
                if (boundary_bit(layout.boundaries, next)) {
                    block_end = map->address + (pl_u64)next - base;
                    break;
                }
            pl_x86_native_escape_sample sample = {
                .start = at,
                .end = block_end,
                .live_output_mask = layout.live_outputs[rank],
                .construction_fields = (pl_u8)boundary_bit(
                    layout.construction_fields, coordinate),
                .relax_short_control = (pl_u8)boundary_bit(
                    layout.relaxed_control_coordinates, coordinate),
            };
            status = dump_block("requested range", image, workspace,
                                workspace_bytes, at, &sample, 0);
            if (status) break;
        }
        base += map->memory_bytes;
    }
    free(output);
    return status;
}

static int load(const char *path, pl_u8 **bytes, pl_u64 *extent)
{
    FILE *file = fopen(path, "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 0;
    long end = ftell(file);
    if (end <= 0 || fseek(file, 0, SEEK_SET)) return 0;
    *bytes = malloc((size_t)end);
    if (!*bytes || fread(*bytes, 1u, (size_t)end, file) != (size_t)end
            || fclose(file))
        return 0;
    *extent = (pl_u64)end;
    return 1;
}

int main(int argc, char **argv)
{
    int expect_nonimage = argc == 3 && !strcmp(argv[2], "--nonimage");
    int escape_report = argc == 3 && !strcmp(argv[2], "--escape-report");
    int list_tables = argc == 3 && !strcmp(argv[2], "--list-tables");
    int output_query = argc == 4 && !strcmp(argv[2], "--map-output");
    int output_dump_query = argc == 4 && !strcmp(argv[2], "--dump-output");
    int source_query = argc == 4 && !strcmp(argv[2], "--map-source");
    int dump_query = argc == 4 && !strcmp(argv[2], "--dump-source");
    int projected_query = argc == 4 && !strcmp(argv[2], "--dump-projected");
    int projected_range = argc == 5
                       && !strcmp(argv[2], "--dump-projected-range");
    int escape_query = argc == 4 && !strcmp(argv[2], "--dump-escape");
    int field_query = argc == 5 && !strcmp(argv[2], "--map-field");
    char *query_end = 0;
    pl_u64 query = output_query || output_dump_query
                 || source_query || dump_query
                 || projected_query
                 || projected_range
                 || escape_query || field_query
                 ? strtoull(argv[3], &query_end, 0) : 0u;
    char *width_end = 0;
    unsigned long width = field_query
                        ? strtoul(argv[4], &width_end, 0) : 0u;
    char *range_end_text = 0;
    pl_u64 range_end = projected_range
                     ? strtoull(argv[4], &range_end_text, 0) : 0u;
    if ((argc != 2 && !expect_nonimage && !escape_report && !list_tables
                && !output_query && !output_dump_query && !source_query
                && !dump_query && !projected_query && !projected_range
                && !escape_query && !field_query)
            || ((output_query || output_dump_query || source_query || dump_query
                    || projected_query
                    || projected_range
                    || escape_query || field_query)
                && (!argv[3][0] || !query_end || *query_end))
            || (field_query && (!argv[4][0] || !width_end || *width_end
                || width > 8u || !width))
            || (projected_range && (!argv[4][0] || !range_end_text
                || *range_end_text || range_end <= query)))
        return 2;
    pl_u8 *bytes = 0;
    pl_u64 extent = 0u;
    if (!load(argv[1], &bytes, &extent)) return 2;
    pl_elf_image elf;
    pl_x86_entry_population entry_measure;
    pl_x86_entry_population entry_written;
    pl_x86_map maps[MAP_CAPACITY];
    pl_x86_image image;
    pl_u32 map_count = 0u;
    int status = pl_elf_open(bytes, extent, &elf);
    if (!status) status = pl_x86_elf_code_map_count(&elf, &map_count);
    if (!status && (!map_count || map_count > MAP_CAPACITY)) status = -1;
    if (!status)
        status = pl_x86_image_from_elf_code_coordinates(
            &elf, 0u, 0u, PL_X86_ELF_VIRTUAL,
            maps, MAP_CAPACITY, &image);
    if (!status)
        status = pl_x86_entry_measure(&elf, &image, &entry_measure);
    pl_u64 coordinates = 0u;
    for (pl_u32 index = 0u; !status && index < image.map_count; ++index)
        if (!pl_checked_add_u64(
                coordinates, image.maps[index].memory_bytes, &coordinates))
            status = -1;
    pl_u64 native_bytes = 0u;
    if (!status)
        status = pl_x86_native_workspace_measure(
            coordinates, &native_bytes);
    pl_u64 *entries = !status ? malloc(
        (size_t)entry_measure.candidate_count * sizeof *entries) : 0;
    pl_u64 *scratch = !status ? malloc(
        (size_t)entry_measure.candidate_count * sizeof *scratch) : 0;
    pl_u64 analysis_bytes = entry_measure.analysis_workspace_bytes;
    pl_u8 *analysis = !status ? malloc((size_t)analysis_bytes) : 0;
    pl_u8 *entry_roles = !status ? malloc(
        (size_t)entry_measure.candidate_count) : 0;
    pl_u8 *entry_role_scratch = !status ? malloc(
        (size_t)entry_measure.candidate_count) : 0;
    pl_x86_code_grid *code_grids = !status ? malloc(
        (size_t)(entry_measure.code_grid_candidate_count
                 ? entry_measure.code_grid_candidate_count : 1u)
        * sizeof *code_grids) : 0;
    pl_x86_table *tables = !status ? malloc(
        (size_t)(entry_measure.table_base_candidate_count
                 ? entry_measure.table_base_candidate_count : 1u)
        * sizeof *tables) : 0;
    pl_x86_table *table_scratch = !status ? malloc(
        (size_t)(entry_measure.table_base_candidate_count
                 ? entry_measure.table_base_candidate_count : 1u)
        * sizeof *table_scratch) : 0;
    pl_u8 *workspace = !status ? malloc((size_t)native_bytes) : 0;
    if (!status && (!entries || !scratch || !analysis
            || !entry_roles || !entry_role_scratch
            || !code_grids || !tables || !table_scratch || !workspace))
        status = -1;
    if (!status)
        status = pl_x86_entry_write(
            &elf, &image, entries, entry_measure.candidate_count,
            scratch, entry_measure.candidate_count,
            entry_roles, entry_role_scratch,
            code_grids, entry_measure.code_grid_candidate_count,
            tables, entry_measure.table_base_candidate_count,
            table_scratch, entry_measure.table_base_candidate_count,
            analysis, analysis_bytes,
            &entry_written);
    if (!status && list_tables) {
        pl_u32 closed = 0u, closed_rows = 0u;
        for (pl_u32 index = 0u; index < entry_written.table_base_count;
                ++index)
            if (tables[index].domain_closed) {
                ++closed;
                closed_rows += tables[index].rows;
            }
        printf("tables=%u targets=%u\n", closed, closed_rows);
        printf("shared-base encodings=%u retained addresses=%u\n",
               entry_written.table_base_count, entry_written.table_target_count);
        for (pl_u32 index = 0u; index < entry_written.table_base_count;
                ++index)
            printf("table base=0x%llx consumer=0x%llx rows=%u index=%u closed=%u\n",
                   (unsigned long long)tables[index].base,
                   (unsigned long long)tables[index].consumer,
                   tables[index].rows, tables[index].index_register,
                   tables[index].domain_closed);
        return 0;
    }
    pl_x86_native_population population;
    pl_u32 native_code_grid_count = entry_written.code_grid_count;
    pl_u32 *live_outputs = 0;
    pl_u8 *future_workspace = 0;
    pl_u64 future_workspace_bytes = 0u;
    pl_x86_native_future future = { 0 };
    if (!status)
        status = pl_x86_native_analyze(
            &image, &elf, entries, entry_roles, entry_written.primary_count,
            entry_written.entry_count,
            code_grids, entry_measure.code_grid_candidate_count,
            &native_code_grid_count,
            workspace, native_bytes, &population);
    pl_u64 future_persistent_bytes = 0u;
    pl_u64 future_phase_bytes = 0u;
    if (!status)
        status = pl_x86_native_future_workspace_measure(
            population.blocks,
            &future_persistent_bytes, &future_phase_bytes);
    if (!status && !pl_checked_add_u64(
            future_persistent_bytes, future_phase_bytes,
            &future_workspace_bytes))
        status = -1;
    if (!status) {
        live_outputs = malloc(
            (size_t)population.blocks * sizeof *live_outputs);
        future_workspace = malloc((size_t)future_workspace_bytes);
        if (!live_outputs || !future_workspace) status = -1;
    }
    if (!status)
        status = pl_x86_native_project_live_outputs(
            &image, workspace, native_bytes,
            &population, code_grids, native_code_grid_count,
            live_outputs, population.blocks,
            future_workspace, future_workspace_bytes);
    if (!status)
        status = pl_x86_native_future_project(
            &image, workspace, native_bytes,
            &population, code_grids, native_code_grid_count,
            entries, entry_roles, entry_written.entry_count,
            live_outputs, population.blocks,
            future_workspace, future_workspace_bytes, 0, &future);
    if (status)
        fprintf(stderr,
                "native block closure: RED (status=%d, entries=%u, external=%u@0x%llx, overlap=0x%llx..0x%llx over 0x%llx, dynamic=%u, blocks=%u)\n",
                status, entry_written.entry_count,
                population.nonimage_control_edges,
                (unsigned long long)
                    population.first_nonimage_control_target,
                (unsigned long long)population.overlapping_source_address,
                (unsigned long long)population.overlapping_source_end,
                (unsigned long long)population.first_overlapping_address,
                population.dynamic_blocks,
                population.blocks);
    if (status && population.emit_failure_address)
        (void)dump_block("failed selection", &image, workspace,
                         native_bytes, population.emit_failure_address, 0, 0);
    if (!status && !dump_query && !projected_query && !projected_range
            && !escape_query
            && (!population.blocks || !population.source_instructions
            || !population.source_work || !population.normalized_work
            || population.normalized_work > population.source_work
            || population.normalized_span > population.source_span
            || !population.selected_blocks
            || population.selected_blocks + population.unselected_blocks
               != population.blocks
            || (!output_query && !output_dump_query
                && !source_query && !dump_query
                && !escape_query
                && !escape_report
                && !!population.nonimage_control_edges != expect_nonimage)))
        status = -1;
    if (!status) {
        if (output_query || output_dump_query) {
            pl_u64 mapped_source = 0u;
            status = map_output(&image, bytes, extent,
                                workspace, native_bytes,
                                code_grids, native_code_grid_count,
                                live_outputs, population.blocks,
                                &population, query, &mapped_source);
            if (!status && output_dump_query)
                status = dump_projected(
                    &image, bytes, extent, workspace, native_bytes,
                    code_grids, native_code_grid_count,
                    live_outputs, population.blocks, &population,
                    mapped_source);
        } else if (source_query || field_query)
            status = map_source(&image, bytes, extent,
                                workspace, native_bytes,
                                code_grids, native_code_grid_count,
                                live_outputs, population.blocks,
                                &population, query, (pl_u32)width);
        else if (dump_query)
            status = dump_block(
                "requested source", &image, workspace, native_bytes,
                query, 0, 0);
        else if (projected_query)
            status = dump_projected(
                &image, bytes, extent, workspace, native_bytes,
                code_grids, native_code_grid_count,
                live_outputs, population.blocks, &population, query);
        else if (projected_range)
            status = dump_projected_range(
                &image, bytes, extent, workspace, native_bytes,
                code_grids, native_code_grid_count,
                live_outputs, population.blocks, &population,
                query, range_end);
        else if (escape_query) {
            status = -1;
            for (pl_u32 sample = 0u;
                    sample < population.normalization_escape_blocks
                        && sample < PL_X86_NATIVE_ESCAPE_SAMPLE_COUNT;
                    ++sample)
                if (population.normalization_escape_sample[sample].start
                        == query) {
                    status = dump_block(
                        "requested escape", &image, workspace, native_bytes,
                        query, &population.normalization_escape_sample[sample],
                        0);
                    break;
                }
        }
    }
    if (!status) {
        pl_u32 dominant_opcode = 0xffffffffu;
        pl_u32 dominant_count = 0u;
        for (pl_u32 opcode = 0u; opcode < PL_OPCODE_COUNT; ++opcode)
            if (population.blocker_opcode[opcode] > dominant_count) {
                dominant_opcode = opcode;
                dominant_count = population.blocker_opcode[opcode];
            }
        printf("native block closure: green (%u boundaries, %llu instructions, "
               "%llu -> %llu work, %llu -> %llu span, %u/%u selected, "
               "%llu -> %llu emitted instructions, %llu -> %llu selected "
               "bytes, %llu bytes eliminated)\n",
               population.boundaries,
               (unsigned long long)population.source_instructions,
               (unsigned long long)population.source_work,
               (unsigned long long)population.normalized_work,
               (unsigned long long)population.source_span,
               (unsigned long long)population.normalized_span,
               population.selected_blocks, population.blocks,
               (unsigned long long)population.source_instructions,
               (unsigned long long)population.emitted_instructions,
               (unsigned long long)population.selected_source_bytes,
               (unsigned long long)population.selected_output_bytes,
               (unsigned long long)population.eliminated_bytes);
        printf("native selection blockers: state/position/control=%u/%u/%u; "
               "dominant opcode=%u (%u blocks)\n",
               population.select_reason[PL_X86_NATIVE_SELECT_STATEFUL],
               population.select_reason[PL_X86_NATIVE_SELECT_POSITION],
               population.select_reason[PL_X86_NATIVE_SELECT_CONTROL],
               dominant_opcode, dominant_count);
        printf("native selection physical routes: direct/source/erased="
               "%u/%u/%u blocks, direct/source=%llu/%llu output bytes, "
               "omitted-prefix=%llu bytes\n",
               population.direct_frame_blocks,
               population.copied_source_blocks,
               population.erased_blocks,
               (unsigned long long)population.direct_frame_output_bytes,
               (unsigned long long)population.copied_source_output_bytes,
               (unsigned long long)population.omitted_prefix_bytes);
        printf("normalization escape: %u blocks, %llu -> %llu bytes, "
               "%llu retained plan-node delta, first=0x%llx\n",
               population.normalization_escape_blocks,
               (unsigned long long)
                   population.normalization_escape_source_bytes,
               (unsigned long long)
                   population.normalization_escape_output_bytes,
               (unsigned long long)population.normalization_escape_work,
               (unsigned long long)
               population.first_normalization_escape_address);
        if (!escape_query) {
            printf("normalization escape samples:");
            for (pl_u32 sample = 0u;
                    sample < population.normalization_escape_blocks
                        && sample < 32u;
                    ++sample)
                printf(" 0x%llx", (unsigned long long)
                       population.normalization_escape_sample[sample].start);
            printf("\n");
        }
        printf("maximum normalized work/span: %u@0x%llx / %u@0x%llx; "
               "native body coefficient=%.9Lf\n",
               population.maximum_normalized_work,
               (unsigned long long)population.maximum_work_address,
               population.maximum_normalized_span,
               (unsigned long long)population.maximum_span_address,
               population.selected_source_bytes
                 ? (long double)population.selected_output_bytes
                   / (long double)population.selected_source_bytes
                 : 0.0L);
        printf("rel8 fixed point: %u candidates, %u widened, %u events, "
               "%llu local rechecks\n",
               population.relaxation_candidates,
               population.relaxation_widened,
               population.relaxation_events,
               (unsigned long long)population.relaxation_rechecks);
        printf("retained normalized source operations:");
        for (pl_u32 rank = 0u; rank < 10u; ++rank) {
            pl_u32 best = 0xffffffffu;
            pl_u64 count = 0u;
            for (pl_u32 operation = 0u;
                    operation < PL_X86_NATIVE_OPERATION_COUNT; ++operation) {
                pl_u64 candidate =
                    population.retained_source_operation[operation];
                if (candidate > count) {
                    best = operation;
                    count = candidate;
                }
            }
            if (best == 0xffffffffu || !count) break;
            printf(" %u=%llu", best, (unsigned long long)count);
            population.retained_source_operation[best] = 0u;
        }
        printf("\nnormalized physical opcodes:");
        for (pl_u32 rank = 0u; rank < 10u; ++rank) {
            pl_u32 best = 0xffffffffu;
            pl_u64 count = 0u;
            for (pl_u32 opcode = 0u; opcode < PL_OPCODE_COUNT; ++opcode)
                if (population.normalized_opcode[opcode] > count) {
                    best = opcode;
                    count = population.normalized_opcode[opcode];
                }
            if (best == 0xffffffffu || !count) break;
            printf(" %u=%llu", best, (unsigned long long)count);
            population.normalized_opcode[best] = 0u;
        }
        printf("\n");
        if (escape_query) {
            /* The exact requested block was printed above. */
        } else if (escape_report) {
            printf("escape report coverage: %u/%u\n",
                   population.normalization_escape_blocks
                       < PL_X86_NATIVE_ESCAPE_SAMPLE_COUNT
                     ? population.normalization_escape_blocks
                     : PL_X86_NATIVE_ESCAPE_SAMPLE_COUNT,
                   population.normalization_escape_blocks);
            for (pl_u32 sample = 0u;
                    !status && sample < population.normalization_escape_blocks
                        && sample < PL_X86_NATIVE_ESCAPE_SAMPLE_COUNT;
                    ++sample)
                status = dump_block(
                    "escape", &image, workspace, native_bytes,
                    population.normalization_escape_sample[sample].start,
                    &population.normalization_escape_sample[sample], 1);
        } else {
            status = dump_block(
                "maximum work", &image, workspace, native_bytes,
                population.maximum_work_address, 0, 0);
            if (!status && population.maximum_span_address
                    != population.maximum_work_address)
                status = dump_block(
                    "maximum span", &image, workspace, native_bytes,
                    population.maximum_span_address, 0, 0);
            if (!status && population.first_normalization_escape_address
                    && population.first_normalization_escape_address
                       != population.maximum_work_address
                    && population.first_normalization_escape_address
                       != population.maximum_span_address)
                status = dump_block(
                    "first normalization escape", &image, workspace,
                    native_bytes,
                    population.first_normalization_escape_address,
                    &population.normalization_escape_sample[0], 0);
            for (pl_u32 sample = 1u;
                    !status && sample < population.normalization_escape_blocks
                        && sample < 32u;
                    ++sample)
                status = dump_block(
                    "normalization escape sample", &image, workspace,
                    native_bytes,
                    population.normalization_escape_sample[sample].start,
                    &population.normalization_escape_sample[sample], 0);
        }
    }
    free(future_workspace);
    free(live_outputs);
    free(workspace);
    free(table_scratch);
    free(tables);
    free(code_grids);
    free(entry_role_scratch);
    free(entry_roles);
    free(scratch);
    free(analysis);
    free(entries);
    free(bytes);
    return status ? 1 : 0;
}
