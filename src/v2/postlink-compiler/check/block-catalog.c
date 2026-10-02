/* Measure the product block former over every executable byte coordinate. */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/internal/form-block.h"
#include "../src/internal/closure.h"
#include "../src/internal/opcodes.h"
#include "../src/internal/plan.h"
#include "../src/internal/quotient.h"
#include "../src/internal/x86-selection.h"
#include <x86/elf.h>

#define BLOCK_ARENA_BYTES (1024u * 1024u)
#define BLOCK_MAXIMUM_INSTRUCTIONS 64u
#define EXECUTABLE_MAP_LIMIT 64u

typedef struct {
    pl_x86_block_builder builder;
    pl_u64 coordinates;
    pl_u64 source_instructions;
    pl_u64 work;
    pl_u64 span;
    pl_u64 fault_coordinates;
    pl_u64 barrier_coordinates;
    pl_u64 direct_coordinates;
    pl_u32 maximum_instructions;
    pl_u32 maximum_work;
    pl_u32 maximum_span;
    pl_u64 maximum_work_rip;
    pl_u64 maximum_work_end;
    pl_u64 maximum_work_coordinates;
    pl_u64 maximum_span_rip;
    pl_u64 maximum_span_end;
    pl_u64 maximum_span_coordinates;
    pl_u64 failure_rip;
    int failure_status;
    pl_u32 *coordinate_ranks;
    pl_u64 coordinate_capacity;
    pl_u64 map_coordinate_base[EXECUTABLE_MAP_LIMIT];
    pl_u64 closed_control_coordinates;
    pl_u64 function_arms;
    pl_u64 resolve_arms;
    pl_u64 barrier_results;
    pl_u64 fault_results;
    pl_u64 halt_results;
} block_catalog;

enum selection_route {
    SELECTION_DIRECT = 0,
    SELECTION_SOURCE = 1,
    SELECTION_ERASED = 2,
    SELECTION_UNSUPPORTED = 3,
    SELECTION_ROUTE_COUNT = 4,
};

typedef struct {
    pl_u64 classes[SELECTION_ROUTE_COUNT];
    pl_u64 coordinates[SELECTION_ROUTE_COUNT];
    pl_u64 class_source_bytes[SELECTION_ROUTE_COUNT];
    pl_u64 class_output_bytes[SELECTION_ROUTE_COUNT];
    pl_u64 coordinate_source_bytes[SELECTION_ROUTE_COUNT];
    pl_u64 coordinate_output_bytes[SELECTION_ROUTE_COUNT];
    pl_u64 omitted_prefix_bytes;
    pl_u64 escape_classes;
    pl_u64 escape_coordinates;
    pl_u64 escape_source_bytes;
    pl_u64 escape_output_bytes;
    pl_u64 escape_work;
    pl_u64 escape_flow_classes[9];
    pl_u64 escape_flow_coordinates[9];
    pl_u64 escape_node_count_classes[65];
    pl_u64 escape_node_count_coordinates[65];
    pl_u64 escape_opcode_classes[PL_OPCODE_COUNT];
    pl_u64 escape_opcode_coordinates[PL_OPCODE_COUNT];
    pl_u64 escape_single_opcode_classes[PL_OPCODE_COUNT];
    pl_u64 escape_single_opcode_coordinates[PL_OPCODE_COUNT];
    pl_u64 escape_single_opcode_first[PL_OPCODE_COUNT];
    pl_u64 pure_source_classes;
    pl_u64 pure_source_coordinates;
    pl_u64 pure_source_instructions;
    pl_u64 pure_source_nodes;
    pl_u64 live_projection_classes;
    pl_u64 live_projection_coordinates;
    pl_u64 live_projection_source_instructions;
    pl_u64 live_projection_output_instructions;
    pl_u64 nested_frame_classes;
    pl_u64 nested_frame_coordinates;
    pl_u64 first_nested_frame;
    pl_u32 maximum_output_work;
    pl_u32 maximum_output_span;
    pl_u64 maximum_output_work_rip;
    pl_u64 maximum_output_work_end;
    pl_u64 maximum_output_work_coordinates;
    pl_u64 maximum_output_span_rip;
    pl_u64 maximum_output_span_end;
    pl_u64 maximum_output_span_coordinates;
    pl_u64 pure_single_opcode_classes[PL_OPCODE_COUNT];
    pl_u64 pure_single_opcode_coordinates[PL_OPCODE_COUNT];
    pl_u64 pure_single_opcode_first[PL_OPCODE_COUNT];
    pl_u64 unsupported_reason_classes[4];
    pl_u64 unsupported_reason_coordinates[4];
    pl_u64 unsupported_opcode_classes[PL_OPCODE_COUNT];
    pl_u64 unsupported_opcode_coordinates[PL_OPCODE_COUNT];
    pl_u64 first_unsupported;
} selection_profile;

static int add_scaled(pl_u64 *value, pl_u64 item, pl_u64 count)
{
    pl_u64 scaled = 0u;
    return pl_checked_mul_u64(item, count, &scaled)
        && pl_checked_add_u64(*value, scaled, value);
}

static int account_selection(selection_profile *profile,
                             const pl_x86_block *block,
                             const pl_x86_native_selection *selection,
                             pl_u32 coordinates)
{
    if (!profile || !block || !selection || !coordinates)
        return PL_ERROR_X86_SELECT;
    pl_u32 route = !selection->supported ? SELECTION_UNSUPPORTED
                 : selection->direct_frame ? SELECTION_DIRECT
                 : selection->copied_source ? SELECTION_SOURCE
                 : SELECTION_ERASED;
    if (route == SELECTION_ERASED && selection->output_bytes)
        return PL_ERROR_X86_SELECT;
    ++profile->classes[route];
    profile->coordinates[route] += coordinates;
    profile->class_source_bytes[route] += selection->source_bytes;
    profile->class_output_bytes[route] += selection->output_bytes;
    if (!add_scaled(&profile->coordinate_source_bytes[route],
                    selection->source_bytes, coordinates)
            || !add_scaled(&profile->coordinate_output_bytes[route],
                           selection->output_bytes, coordinates))
        return PL_ERROR_BLOCK_LIMIT;
    if (route == SELECTION_UNSUPPORTED) {
        if (profile->classes[route] == 1u)
            profile->first_unsupported = block->start;
        if (selection->reason < 4u) {
            ++profile->unsupported_reason_classes[selection->reason];
            profile->unsupported_reason_coordinates[selection->reason] +=
                coordinates;
        }
        if (selection->blocking_opcode < PL_OPCODE_COUNT) {
            ++profile->unsupported_opcode_classes[
                selection->blocking_opcode];
            profile->unsupported_opcode_coordinates[
                selection->blocking_opcode] += coordinates;
        }
        return 0;
    }
    if (selection->direct_live_frame) {
        ++profile->live_projection_classes;
        profile->live_projection_coordinates += coordinates;
        profile->live_projection_source_instructions +=
            block->instruction_count;
        profile->live_projection_output_instructions +=
            selection->output_instructions;
    }
    if (selection->direct_nested_frame) {
        if (!profile->nested_frame_classes)
            profile->first_nested_frame = block->start;
        ++profile->nested_frame_classes;
        profile->nested_frame_coordinates += coordinates;
    }
    if (selection->output_work > profile->maximum_output_work) {
        profile->maximum_output_work = selection->output_work;
        profile->maximum_output_work_rip = block->start;
        profile->maximum_output_work_end = block->end;
        profile->maximum_output_work_coordinates = coordinates;
    }
    if (selection->output_span > profile->maximum_output_span) {
        profile->maximum_output_span = selection->output_span;
        profile->maximum_output_span_rip = block->start;
        profile->maximum_output_span_end = block->end;
        profile->maximum_output_span_coordinates = coordinates;
    }
    profile->omitted_prefix_bytes += selection->omitted_prefix_bytes;
    int pure_direct_slice = route == SELECTION_SOURCE
        && block->kind == PL_X86_BLOCK_DIRECT
        && block->flow == PL_X86_FLOW_NEXT
        && !block->dynamic_target && !block->has_predicate
        && !block->has_fault_predicate
        && block->machine_operation == PL_X86_MACHINE_NONE
        && !block->construction_fields && !block->plan.stack_count;
    if (pure_direct_slice) {
        ++profile->pure_source_classes;
        profile->pure_source_coordinates += coordinates;
        profile->pure_source_instructions += selection->output_instructions;
        profile->pure_source_nodes += block->plan.node_count;
        if (block->plan.node_count == 1u) {
            pl_u32 opcode = block->plan.nodes[0].opcode;
            if (opcode >= PL_OPCODE_COUNT) return PL_ERROR_X86_SELECT;
            ++profile->pure_single_opcode_classes[opcode];
            profile->pure_single_opcode_coordinates[opcode] += coordinates;
            if (profile->pure_single_opcode_classes[opcode] == 1u)
                profile->pure_single_opcode_first[opcode] = block->start;
        }
    }
    if (route != SELECTION_SOURCE
            || selection->output_instructions != block->instruction_count
            || block->plan.node_count >= block->source_work)
        return 0;
    ++profile->escape_classes;
    profile->escape_coordinates += coordinates;
    profile->escape_source_bytes += selection->source_bytes;
    profile->escape_output_bytes += selection->output_bytes;
    profile->escape_work += block->source_work - block->plan.node_count;
    if (block->flow < 9u) {
        ++profile->escape_flow_classes[block->flow];
        profile->escape_flow_coordinates[block->flow] += coordinates;
    }
    pl_u32 node_bucket = block->plan.node_count < 64u
                       ? block->plan.node_count : 64u;
    ++profile->escape_node_count_classes[node_bucket];
    profile->escape_node_count_coordinates[node_bucket] += coordinates;
    for (pl_u32 node = 0u; node < block->plan.node_count; ++node) {
        pl_u32 opcode = block->plan.nodes[node].opcode;
        if (opcode >= PL_OPCODE_COUNT) return PL_ERROR_X86_SELECT;
        ++profile->escape_opcode_classes[opcode];
        profile->escape_opcode_coordinates[opcode] += coordinates;
        if (block->plan.node_count == 1u) {
            ++profile->escape_single_opcode_classes[opcode];
            profile->escape_single_opcode_coordinates[opcode] += coordinates;
            if (profile->escape_single_opcode_classes[opcode] == 1u)
                profile->escape_single_opcode_first[opcode] = block->start;
        }
    }
    return 0;
}

static int next_power_of_two_above(pl_u32 value, pl_u32 *out)
{
    pl_u32 result = 1u;
    while (result <= value) {
        if (result > 0x7fffffffu) return -1;
        result <<= 1u;
    }
    *out = result;
    return 0;
}

static int rank_at(void *opaque, pl_u64 address, pl_u32 *rank)
{
    const block_catalog *catalog = opaque;
    const pl_x86_image *image = catalog->builder.frontend.image;
    pl_u32 low = 0u, high = image->map_count;
    while (low < high) {
        pl_u32 middle = low + (high - low) / 2u;
        if (image->maps[middle].address <= address) low = middle + 1u;
        else high = middle;
    }
    if (!low) return 0;
    pl_u32 map = low - 1u;
    if (address < image->maps[map].address
            || address - image->maps[map].address
               >= image->maps[map].memory_bytes)
        return 0;
    pl_u64 coordinate = catalog->map_coordinate_base[map]
                      + address - image->maps[map].address;
    if (coordinate >= catalog->coordinate_capacity) return 0;
    *rank = catalog->coordinate_ranks[coordinate];
    return 1;
}

static int catalog_block(const pl_x86_instruction *instruction, void *opaque)
{
    block_catalog *catalog = opaque;
    pl_x86_block block;
    int status = pl_x86_block_lower(
        &catalog->builder.frontend, instruction->rip,
        &catalog->builder.formation, &block);
    pl_u32 rank = 0u;
    if (!status) status = pl_x86_block_intern(&catalog->builder, &block, &rank);
    if (!status) {
        if (catalog->coordinates >= catalog->coordinate_capacity)
            status = PL_ERROR_BLOCK_LIMIT;
        else
            catalog->coordinate_ranks[catalog->coordinates] = rank;
    }
    if (status) {
        if (!catalog->failure_status) {
            catalog->failure_rip = instruction->rip;
            catalog->failure_status = status;
        }
        return status;
    }

    ++catalog->coordinates;
    catalog->source_instructions += block.instruction_count;
    catalog->work += block.plan.node_count;
    catalog->span += block.plan.span;
    if (block.kind == PL_X86_BLOCK_DIRECT) ++catalog->direct_coordinates;
    else if (block.kind == PL_X86_BLOCK_FAULT) ++catalog->fault_coordinates;
    else ++catalog->barrier_coordinates;
    if (block.instruction_count > catalog->maximum_instructions)
        catalog->maximum_instructions = block.instruction_count;
    if (block.plan.node_count > catalog->maximum_work) {
        catalog->maximum_work = block.plan.node_count;
        catalog->maximum_work_rip = block.start;
        catalog->maximum_work_end = block.end;
        catalog->maximum_work_coordinates = 1u;
    } else if (block.plan.node_count == catalog->maximum_work) {
        ++catalog->maximum_work_coordinates;
    }
    if (block.plan.span > catalog->maximum_span) {
        catalog->maximum_span = block.plan.span;
        catalog->maximum_span_rip = block.start;
        catalog->maximum_span_end = block.end;
        catalog->maximum_span_coordinates = 1u;
    } else if (block.plan.span == catalog->maximum_span) {
        ++catalog->maximum_span_coordinates;
    }
    return 0;
}

/* Bind control directly into the accepted block product.  This pass permits a
 * total dynamic-address resolver; the only successor-free results are exact
 * terminal events, never graph transitions, so no residual state/edge record
 * is retained. */
static int close_direct_control(const pl_x86_instruction *instruction,
                                void *opaque)
{
    block_catalog *catalog = opaque;
    pl_direct_block direct = { 0 };
    int status = pl_x86_close_direct(
        &catalog->builder.frontend, &catalog->builder.formation,
        instruction, rank_at, catalog, &direct);
    if (status) {
        if (!catalog->failure_status) {
            catalog->failure_rip = instruction->rip;
            catalog->failure_status = status;
        }
        return status;
    }
    ++catalog->closed_control_coordinates;
    if (direct.result_kind == PL_DIRECT_FUNCTION) ++catalog->function_arms;
    else if (direct.result_kind == PL_DIRECT_RESOLVE) ++catalog->resolve_arms;
    else if (direct.result_kind == PL_DIRECT_BARRIER)
        ++catalog->barrier_results;
    else if (direct.result_kind == PL_DIRECT_FAULT)
        ++catalog->fault_results;
    else if (direct.result_kind == PL_DIRECT_HALT)
        ++catalog->halt_results;
    else
        return PL_ERROR_BLOCK;
    if (direct.has_branch_predicate) {
        if (direct.alternate_result_kind == PL_DIRECT_FUNCTION)
            ++catalog->function_arms;
        else if (direct.alternate_result_kind == PL_DIRECT_RESOLVE)
            ++catalog->resolve_arms;
        else
            return PL_ERROR_BLOCK;
    }
    return 0;
}

static char operand_kind(pl_u8 kind)
{
    static const char names[] = { 'c', 's', 'l', 'n', 'p' };
    return kind < sizeof names ? names[kind] : '?';
}

static int dump_critical_block(const char *label,
                               const pl_x86_frontend *frontend,
                               const pl_x86_block_workspace *workspace,
                               const pl_x86_block_workspace *selection_workspace,
                               pl_u64 rip)
{
    pl_x86_block block;
    int status = pl_x86_block_lower(frontend, rip, workspace, &block);
    if (status) return status;
    printf("%s block          0x%llx..0x%llx, %u instructions, "
           "%u work/%u span\n",
           label, (unsigned long long)block.start,
           (unsigned long long)block.end, block.instruction_count,
           block.plan.node_count, block.plan.span);
    pl_u64 source_rip = block.start;
    for (pl_u32 index = 0u; index < block.instruction_count; ++index) {
        pl_x86_instruction instruction;
        status = pl_x86_frontend_decode(
            frontend, source_rip, &instruction);
        if (status) return status;
        printf("  source %u @0x%llx:", index + 1u,
               (unsigned long long)source_rip);
        for (pl_u32 byte = 0u; byte < instruction.source_bytes; ++byte)
            printf(" %02x", (unsigned)instruction.source[byte]);
        printf("; operation=%u flow=%u flags=0x%x\n",
               instruction.operation, instruction.flow,
               instruction.flags);
        source_rip = instruction.fallthrough;
    }
    for (pl_u32 wave = 0u; wave < block.plan.span; ++wave) {
        pl_u32 begin = block.plan.wave_offsets[wave];
        pl_u32 end = block.plan.wave_offsets[wave + 1u];
        printf("  wave %u:", wave + 1u);
        for (pl_u32 at = begin; at < end; ++at) {
            pl_u32 value = block.plan.wave_values[at];
            const pl_node *node = &block.plan.nodes[value - 1u];
            printf(" n%u=op%u(", value, node->opcode);
            for (pl_u32 slot = 0u; slot < node->argument_count; ++slot) {
                const pl_operand operand =
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
        const pl_operand value = block.plan.locals[local];
        if (value.kind == PL_OPERAND_LOCAL && value.value == local) continue;
        printf(" l%u=%c%llx", local, operand_kind(value.kind),
               (unsigned long long)value.value);
    }
    printf("; live=0x%x\n", block.live_output_mask);
    pl_x86_native_candidates candidates;
    status = pl_x86_select_candidates(
        frontend, selection_workspace, &block, &candidates);
    printf("  candidates: status=%d stage=0x%x reject=0x%x/0x%x "
           "scratch=0x%llx alias=%u:%llx@%u count=%u\n",
           status, candidates.diagnostic_stage,
           candidates.diagnostic.blocking_work,
           candidates.diagnostic.blocking_opcode,
           (unsigned long long)
               candidates.diagnostic.projected_instruction_mask,
           (unsigned)candidates.diagnostic.frame_alias_kind,
           (unsigned long long)candidates.diagnostic.frame_alias_value,
           (unsigned)candidates.diagnostic.frame_alias_local,
           candidates.count);
    if (!status && candidates.diagnostic.blocking_work) {
        pl_x86_alu_schedule_diagnostic schedule;
        int schedule_status = pl_x86_select_alu_schedule_diagnostic(
            &block, &schedule);
        printf("  ALU schedule: status=%d changed=0x%x flag=n%u@l%u "
               "standalone=0x%x\n",
               schedule_status, schedule.changed,
               schedule.final_flag_node, schedule.final_flag_owner,
               schedule.standalone_flag_dependencies);
        if (!schedule_status)
            for (pl_u32 local = 0u; local < PL_X86_GPR_COUNT; ++local)
                if (schedule.changed & (1u << local))
                    printf("    l%u: sources=0x%x dependencies=0x%x\n",
                           local, schedule.sources[local],
                           schedule.dependencies[local]);
    }
    if (status) {
        for (pl_u32 index = 0u; index < candidates.count; ++index) {
            pl_u8 diagnostic[2048u];
            pl_u32 diagnostic_bytes = 0u;
            int write_status = pl_x86_select_write_measured(
                frontend, &block, &candidates.candidate[index],
                diagnostic, sizeof diagnostic, &diagnostic_bytes);
            printf("    partial %u: write=%d expected/actual=%u/%u "
                   "direct/source=%u/%u\n", index, write_status,
                   candidates.candidate[index].output_bytes,
                   diagnostic_bytes,
                   (unsigned)candidates.candidate[index].direct_frame,
                   (unsigned)candidates.candidate[index].copied_source);
        }
        return status;
    }
    for (pl_u32 index = 0u; index < candidates.count; ++index) {
        const pl_x86_native_selection *candidate =
            &candidates.candidate[index];
        printf("    %u: direct/source=%u/%u bytes=%u instructions=%u "
               "work/span=%u/%u reject=0x%x/0x%x scratch=0x%llx "
               "alias=%u:%llx@%u families="
               "c%ua%ui%uq%us%um%uk%uu%ut%uz%uh%uo%uv%ux%ub%uf%ud%u\n",
               index, candidate->direct_frame, candidate->copied_source,
               candidate->output_bytes, candidate->output_instructions,
               candidate->output_work, candidate->output_span,
               candidate->blocking_work, candidate->blocking_opcode,
               (unsigned long long)candidate->projected_instruction_mask,
               (unsigned)candidate->frame_alias_kind,
               (unsigned long long)candidate->frame_alias_value,
               (unsigned)candidate->frame_alias_local,
               candidate->direct_common_frame,
               candidate->direct_add_frame,
               candidate->direct_insert_frame,
               candidate->direct_compare_frame,
               candidate->direct_shift_frame,
               candidate->direct_mul_add_carry_frame,
               candidate->direct_condition_carry_frame,
               candidate->direct_alu_frame,
               candidate->direct_transient_owner_frame,
               candidate->direct_zero_flag_frame,
               candidate->direct_shift_handoff_frame,
               candidate->direct_shared_owner_frame,
               candidate->direct_value_predicate_frame,
               candidate->direct_compare_handoff_frame,
               candidate->direct_branch_frame,
               candidate->direct_affine_frame,
               candidate->direct_live_frame);
        pl_u8 emitted[2048u];
        pl_u32 emitted_bytes = 0u;
        int emitted_status = pl_x86_select_write_measured(
            frontend, &block, candidate,
            emitted, sizeof emitted, &emitted_bytes);
        printf("      code[%d/%u]=", emitted_status, emitted_bytes);
        if (!emitted_status)
            for (pl_u32 byte = 0u; byte < emitted_bytes; ++byte)
                printf("%02x", emitted[byte]);
        putchar('\n');
        if (!emitted_status && emitted_bytes) {
            const pl_x86_map emitted_map = {
                emitted, 0x1000u, emitted_bytes, emitted_bytes,
                PL_ELF_FLAG_READ | PL_ELF_FLAG_EXECUTE, 1u,
            };
            const pl_x86_image emitted_image = {
                &emitted_map, 1u, 0u, 0x1000u,
            };
            pl_x86_frontend emitted_frontend;
            int decode_status = pl_x86_frontend_open(
                &emitted_image, &emitted_frontend);
            pl_u64 emitted_rip = 0x1000u;
            pl_u32 instruction = 0u;
            while (!decode_status
                    && emitted_rip < 0x1000u + emitted_bytes) {
                pl_x86_instruction decoded;
                decode_status = pl_x86_frontend_decode(
                    &emitted_frontend, emitted_rip, &decoded);
                if (decode_status || !decoded.source_bytes) break;
                printf("        native %u:", ++instruction);
                for (pl_u32 byte = 0u;
                        byte < decoded.source_bytes; ++byte)
                    printf(" %02x", (unsigned)decoded.source[byte]);
                printf("; operation=%u flags=0x%x\n",
                       decoded.operation, decoded.flags);
                emitted_rip = decoded.fallthrough;
            }
            if (decode_status || emitted_rip != 0x1000u + emitted_bytes)
                printf("        native decode RED status=%d end=0x%llx\n",
                       decode_status, (unsigned long long)emitted_rip);
        }
    }
    pl_x86_native_selection frontier[PL_X86_NATIVE_MAX_CANDIDATES];
    pl_u32 frontier_count = 0u;
    status = pl_x86_candidates_pareto_frontier(
        &candidates, 0u, 0u, frontier,
        PL_X86_NATIVE_MAX_CANDIDATES, &frontier_count);
    if (status) return status;
    printf("  Pareto frontier:");
    for (pl_u32 index = 0u; index < frontier_count; ++index)
        printf(" %u/%u/%uB",
               frontier[index].output_work,
               frontier[index].output_span,
               frontier[index].output_bytes);
    putchar('\n');
    return 0;
}

static int load_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *handle = fopen(path, "rb");
    if (!handle || fseek(handle, 0, SEEK_END)) return -1;
    long size = ftell(handle);
    if (size <= 0 || fseek(handle, 0, SEEK_SET)) {
        fclose(handle);
        return -1;
    }
    pl_u8 *loaded = malloc((size_t)size);
    if (!loaded || fread(loaded, 1u, (size_t)size, handle) != (size_t)size) {
        free(loaded);
        fclose(handle);
        return -1;
    }
    fclose(handle);
    *bytes = loaded;
    *length = (pl_u64)size;
    return 0;
}

int main(int argc, char **argv)
{
    int eager_code = argc == 3 && !strcmp(argv[2], "--eager-code");
    int inspect = argc == 4 && !strcmp(argv[2], "--inspect");
    char *inspect_end = NULL;
    pl_u64 inspect_address = inspect
        ? (pl_u64)strtoull(argv[3], &inspect_end, 0) : 0u;
    if ((argc != 2 && !eager_code && !inspect)
            || (inspect && (!argv[3][0] || !inspect_end || *inspect_end))) {
        fprintf(stderr,
                "usage: postlink-block-catalog LINKED-X86-ELF "
                "[--eager-code | --inspect ADDRESS]\n");
        return 2;
    }
    pl_u8 *bytes = NULL;
    pl_u64 length = 0u;
    if (load_file(argv[1], &bytes, &length)) {
        fprintf(stderr, "cannot read %s\n", argv[1]);
        return 1;
    }

    pl_elf_image elf;
    pl_x86_map maps[EXECUTABLE_MAP_LIMIT];
    pl_x86_image image = { 0 };
    int status = pl_elf_open(bytes, length, &elf);
    pl_u32 map_count = 0u;
    if (!status)
        status = eager_code
               ? pl_x86_elf_code_map_count(&elf, &map_count)
               : pl_x86_elf_map_count(&elf, &map_count);
    if (!status && (!map_count || map_count > EXECUTABLE_MAP_LIMIT))
        status = PL_ERROR_X86_CAPACITY;
    if (!status) {
        status = eager_code
               ? pl_x86_image_from_elf_code_coordinates(
                    &elf, 0u, 0u, PL_X86_ELF_VIRTUAL,
                    maps, EXECUTABLE_MAP_LIMIT, &image)
               : pl_x86_image_from_elf_coordinates(
                    &elf, 0u, 0u, PL_X86_ELF_VIRTUAL,
                    maps, EXECUTABLE_MAP_LIMIT, &image);
    }

    pl_u64 coordinate_count = 0u;
    for (pl_u32 index = 0u; !status && index < image.map_count; ++index) {
        if (!pl_checked_add_u64(coordinate_count, image.maps[index].memory_bytes,
                                &coordinate_count))
            status = PL_ERROR_X86_CAPACITY;
    }
    if (!status && (!coordinate_count || coordinate_count > 0x7fffffffu))
        status = PL_ERROR_X86_CAPACITY;
    if (inspect) {
        pl_u8 *inspect_first = status ? NULL : malloc(BLOCK_ARENA_BYTES);
        pl_u8 *inspect_second = status ? NULL : malloc(BLOCK_ARENA_BYTES);
        pl_u8 *select_first = status ? NULL : malloc(BLOCK_ARENA_BYTES);
        pl_u8 *select_second = status ? NULL : malloc(BLOCK_ARENA_BYTES);
        pl_x86_frontend frontend;
        if (!status && (!inspect_first || !inspect_second
                    || !select_first || !select_second))
            status = PL_ERROR_BLOCK_LIMIT;
        if (!status) status = pl_x86_frontend_open(&image, &frontend);
        pl_x86_block_workspace inspect_workspace = {
            inspect_first, inspect_second,
            BLOCK_ARENA_BYTES, BLOCK_MAXIMUM_INSTRUCTIONS,
        };
        pl_x86_block_workspace selection_workspace = {
            select_first, select_second,
            BLOCK_ARENA_BYTES, BLOCK_MAXIMUM_INSTRUCTIONS,
        };
        if (!status)
            status = dump_critical_block(
                "inspected", &frontend, &inspect_workspace,
                &selection_workspace, inspect_address);
        free(select_second);
        free(select_first);
        free(inspect_second);
        free(inspect_first);
        free(bytes);
        return status ? 1 : 0;
    }
    pl_u32 identity_capacity = (pl_u32)coordinate_count;
    pl_u32 hash_slot_count = 0u;
    if (!status && next_power_of_two_above(
            identity_capacity, &hash_slot_count))
        status = PL_ERROR_BLOCK_LIMIT;

    pl_u8 *first = status ? NULL : malloc(BLOCK_ARENA_BYTES);
    pl_u8 *second = status ? NULL : malloc(BLOCK_ARENA_BYTES);
    pl_u8 *compare_first = status ? NULL : malloc(BLOCK_ARENA_BYTES);
    pl_u8 *compare_second = status ? NULL : malloc(BLOCK_ARENA_BYTES);
    pl_x86_block_identity *identities = status ? NULL : malloc(
        (size_t)identity_capacity * sizeof *identities);
    pl_u32 *hash_slots = status ? NULL : malloc(
        (size_t)hash_slot_count * sizeof *hash_slots);
    pl_u32 *coordinate_ranks = status ? NULL : malloc(
        (size_t)identity_capacity * sizeof *coordinate_ranks);
    if (!status && (!first || !second || !compare_first || !compare_second
            || !identities || !hash_slots || !coordinate_ranks))
        status = PL_ERROR_BLOCK_LIMIT;

    block_catalog catalog = { 0 };
    catalog.coordinate_ranks = coordinate_ranks;
    catalog.coordinate_capacity = coordinate_count;
    pl_u64 map_base = 0u;
    for (pl_u32 index = 0u; !status && index < image.map_count; ++index) {
        catalog.map_coordinate_base[index] = map_base;
        if (!pl_checked_add_u64(
                map_base, image.maps[index].memory_bytes, &map_base))
            status = PL_ERROR_X86_CAPACITY;
    }
    pl_x86_block_workspace formation = {
        first, second, BLOCK_ARENA_BYTES, BLOCK_MAXIMUM_INSTRUCTIONS,
    };
    pl_x86_block_workspace comparison = {
        compare_first, compare_second,
        BLOCK_ARENA_BYTES, BLOCK_MAXIMUM_INSTRUCTIONS,
    };
    if (!status)
        status = pl_x86_block_builder_open(
            &catalog.builder, &image, &formation, &comparison,
            identities, identity_capacity, hash_slots, hash_slot_count);
    pl_x86_catalog decoded = { 0 };
    if (!status)
        status = pl_x86_catalog_image(
            &image, catalog_block, &catalog, &decoded);
    pl_x86_catalog control = { 0 };
    if (!status)
        status = pl_x86_catalog_image(
            &image, close_direct_control, &catalog, &control);
    if (!status && control.coordinates != catalog.coordinates)
        status = PL_ERROR_BLOCK;

    pl_u32 *class_coordinates = status ? NULL : calloc(
        catalog.builder.identity_count ? catalog.builder.identity_count : 1u,
        sizeof *class_coordinates);
    if (!status && !class_coordinates) status = PL_ERROR_BLOCK_LIMIT;
    for (pl_u64 coordinate = 0u; !status
            && coordinate < catalog.coordinates; ++coordinate) {
        pl_u32 rank = coordinate_ranks[coordinate];
        if (rank >= catalog.builder.identity_count
                || class_coordinates[rank] == 0xffffffffu)
            status = PL_ERROR_BLOCK_LIMIT;
        else
            ++class_coordinates[rank];
    }

    selection_profile selections = { 0 };
    for (pl_u32 rank = 0u; !status
            && rank < catalog.builder.identity_count; ++rank) {
        pl_x86_block block;
        status = pl_x86_block_lower(
            &catalog.builder.frontend,
            catalog.builder.identities[rank].representative,
            &catalog.builder.formation, &block);
        pl_x86_native_selection selection;
        if (!status)
            status = pl_x86_select_measure(
                &catalog.builder.frontend, &catalog.builder.comparison,
                &block, &selection);
        if (!status)
            status = account_selection(
                &selections, &block, &selection, class_coordinates[rank]);
        if (status) {
            catalog.failure_rip =
                catalog.builder.identities[rank].representative;
            catalog.failure_status = status;
        }
    }

    if (status) {
        fprintf(stderr, "block catalog RED status=%d rip=0x%llx\n",
                status, (unsigned long long)catalog.failure_rip);
    } else {
        printf("block catalog: green\n");
        printf("catalog domain       %s\n",
               eager_code ? "eager SHF_EXECINSTR" : "complete PF_X");
        printf("coordinates          %llu\n",
               (unsigned long long)catalog.coordinates);
        printf("function classes     %u\n", catalog.builder.identity_count);
        printf("shared coordinates   %llu\n",
               (unsigned long long)catalog.builder.shared);
        printf("direct/fault/barrier %llu/%llu/%llu\n",
               (unsigned long long)catalog.direct_coordinates,
               (unsigned long long)catalog.fault_coordinates,
               (unsigned long long)catalog.barrier_coordinates);
        printf("source instructions  %llu (maximum %u)\n",
               (unsigned long long)catalog.source_instructions,
               catalog.maximum_instructions);
        printf("physical work/span   %llu/%llu (maximum %u/%u)\n",
               (unsigned long long)catalog.work,
               (unsigned long long)catalog.span,
               catalog.maximum_work, catalog.maximum_span);
        printf("maximum work site    0x%llx..0x%llx (%llu coordinates)\n",
               (unsigned long long)catalog.maximum_work_rip,
               (unsigned long long)catalog.maximum_work_end,
               (unsigned long long)catalog.maximum_work_coordinates);
        printf("maximum span site    0x%llx..0x%llx (%llu coordinates)\n",
               (unsigned long long)catalog.maximum_span_rip,
               (unsigned long long)catalog.maximum_span_end,
               (unsigned long long)catalog.maximum_span_coordinates);
        printf("native route classes  direct/source/erased/unsupported="
               "%llu/%llu/%llu/%llu\n",
               (unsigned long long)selections.classes[SELECTION_DIRECT],
               (unsigned long long)selections.classes[SELECTION_SOURCE],
               (unsigned long long)selections.classes[SELECTION_ERASED],
               (unsigned long long)
                   selections.classes[SELECTION_UNSUPPORTED]);
        printf("native route coordinates direct/source/erased/unsupported="
               "%llu/%llu/%llu/%llu\n",
               (unsigned long long)
                   selections.coordinates[SELECTION_DIRECT],
               (unsigned long long)
                   selections.coordinates[SELECTION_SOURCE],
               (unsigned long long)
                   selections.coordinates[SELECTION_ERASED],
               (unsigned long long)
                   selections.coordinates[SELECTION_UNSUPPORTED]);
        printf("native class bytes    direct=%llu->%llu "
               "source=%llu->%llu erased=%llu->%llu unsupported=%llu\n",
               (unsigned long long)
                   selections.class_source_bytes[SELECTION_DIRECT],
               (unsigned long long)
                   selections.class_output_bytes[SELECTION_DIRECT],
               (unsigned long long)
                   selections.class_source_bytes[SELECTION_SOURCE],
               (unsigned long long)
                   selections.class_output_bytes[SELECTION_SOURCE],
               (unsigned long long)
                   selections.class_source_bytes[SELECTION_ERASED],
               (unsigned long long)
                   selections.class_output_bytes[SELECTION_ERASED],
               (unsigned long long)
                   selections.class_source_bytes[SELECTION_UNSUPPORTED]);
        printf("live projection       %llu classes/%llu coordinates, "
               "%llu->%llu instructions\n",
               (unsigned long long)selections.live_projection_classes,
               (unsigned long long)selections.live_projection_coordinates,
               (unsigned long long)
                   selections.live_projection_source_instructions,
               (unsigned long long)
                   selections.live_projection_output_instructions);
        printf("nested SSA emission   %llu classes/%llu coordinates; first=0x%llx\n",
               (unsigned long long)selections.nested_frame_classes,
               (unsigned long long)selections.nested_frame_coordinates,
               (unsigned long long)selections.first_nested_frame);
        printf("selected x86 maximum  work=%u at 0x%llx..0x%llx "
               "(%llu coordinates), span=%u at 0x%llx..0x%llx "
               "(%llu coordinates)\n",
               selections.maximum_output_work,
               (unsigned long long)selections.maximum_output_work_rip,
               (unsigned long long)selections.maximum_output_work_end,
               (unsigned long long)
                   selections.maximum_output_work_coordinates,
               selections.maximum_output_span,
               (unsigned long long)selections.maximum_output_span_rip,
               (unsigned long long)selections.maximum_output_span_end,
               (unsigned long long)
                   selections.maximum_output_span_coordinates);
        printf("normalization escape  %llu classes/%llu coordinates, "
               "%llu->%llu class bytes, %llu retained plan-node delta\n",
               (unsigned long long)selections.escape_classes,
               (unsigned long long)selections.escape_coordinates,
               (unsigned long long)selections.escape_source_bytes,
               (unsigned long long)selections.escape_output_bytes,
               (unsigned long long)selections.escape_work);
        printf("escape flow classes/coordinates:");
        for (pl_u32 flow = 0u; flow < 9u; ++flow)
            if (selections.escape_flow_classes[flow])
                printf(" %u=%llu/%llu", flow,
                       (unsigned long long)
                           selections.escape_flow_classes[flow],
                       (unsigned long long)
                           selections.escape_flow_coordinates[flow]);
        printf("\n");
        printf("escape node-count classes/coordinates:");
        for (pl_u32 nodes = 0u; nodes <= 64u; ++nodes)
            if (selections.escape_node_count_classes[nodes])
                printf(" %u=%llu/%llu", nodes,
                       (unsigned long long)
                           selections.escape_node_count_classes[nodes],
                       (unsigned long long)
                           selections.escape_node_count_coordinates[nodes]);
        printf("\n");
        printf("escape physical opcodes:");
        pl_u8 shown_escape_opcode[PL_OPCODE_COUNT] = { 0 };
        for (pl_u32 order = 0u; order < 16u; ++order) {
            pl_u32 best = PL_OPCODE_COUNT;
            pl_u64 count = 0u;
            for (pl_u32 opcode = 0u; opcode < PL_OPCODE_COUNT; ++opcode) {
                pl_u64 candidate =
                    selections.escape_opcode_coordinates[opcode];
                if (!shown_escape_opcode[opcode] && candidate > count) {
                    best = opcode;
                    count = candidate;
                }
            }
            if (best == PL_OPCODE_COUNT || !count) break;
            shown_escape_opcode[best] = 1u;
            printf(" op%u=%llu/%llu", best,
                   (unsigned long long)
                       selections.escape_opcode_coordinates[best],
                   (unsigned long long)
                       selections.escape_opcode_classes[best]);
        }
        printf("\n");
        printf("single-node escape opcodes:");
        pl_u8 shown_single_opcode[PL_OPCODE_COUNT] = { 0 };
        for (pl_u32 order = 0u; order < 16u; ++order) {
            pl_u32 best = PL_OPCODE_COUNT;
            pl_u64 count = 0u;
            for (pl_u32 opcode = 0u; opcode < PL_OPCODE_COUNT; ++opcode) {
                pl_u64 candidate =
                    selections.escape_single_opcode_coordinates[opcode];
                if (!shown_single_opcode[opcode] && candidate > count) {
                    best = opcode;
                    count = candidate;
                }
            }
            if (best == PL_OPCODE_COUNT || !count) break;
            shown_single_opcode[best] = 1u;
            printf(" op%u=%llu/%llu@0x%llx", best,
                   (unsigned long long)
                       selections.escape_single_opcode_coordinates[best],
                   (unsigned long long)
                       selections.escape_single_opcode_classes[best],
                   (unsigned long long)
                       selections.escape_single_opcode_first[best]);
        }
        printf("\n");
        printf("pure source slices    %llu classes/%llu coordinates, "
               "%llu instructions/%llu nodes\n",
               (unsigned long long)selections.pure_source_classes,
               (unsigned long long)selections.pure_source_coordinates,
               (unsigned long long)selections.pure_source_instructions,
               (unsigned long long)selections.pure_source_nodes);
        printf("pure single-node source opcodes:");
        pl_u8 shown_pure_opcode[PL_OPCODE_COUNT] = { 0 };
        for (pl_u32 order = 0u; order < 16u; ++order) {
            pl_u32 best = PL_OPCODE_COUNT;
            pl_u64 count = 0u;
            for (pl_u32 opcode = 0u; opcode < PL_OPCODE_COUNT; ++opcode) {
                pl_u64 candidate =
                    selections.pure_single_opcode_coordinates[opcode];
                if (!shown_pure_opcode[opcode] && candidate > count) {
                    best = opcode;
                    count = candidate;
                }
            }
            if (best == PL_OPCODE_COUNT || !count) break;
            shown_pure_opcode[best] = 1u;
            printf(" op%u=%llu/%llu@0x%llx", best,
                   (unsigned long long)
                       selections.pure_single_opcode_coordinates[best],
                   (unsigned long long)
                       selections.pure_single_opcode_classes[best],
                   (unsigned long long)
                       selections.pure_single_opcode_first[best]);
        }
        printf("\n");
        printf("unsupported reasons  ready/state/position/control="
               "%llu/%llu/%llu/%llu classes; first=0x%llx\n",
               (unsigned long long)selections.unsupported_reason_classes[0],
               (unsigned long long)selections.unsupported_reason_classes[1],
               (unsigned long long)selections.unsupported_reason_classes[2],
               (unsigned long long)selections.unsupported_reason_classes[3],
               (unsigned long long)selections.first_unsupported);
        printf("unsupported physical opcodes:");
        pl_u8 shown_unsupported_opcode[PL_OPCODE_COUNT] = { 0 };
        for (pl_u32 order = 0u; order < 16u; ++order) {
            pl_u32 best = PL_OPCODE_COUNT;
            pl_u64 count = 0u;
            for (pl_u32 opcode = 0u; opcode < PL_OPCODE_COUNT; ++opcode) {
                pl_u64 candidate =
                    selections.unsupported_opcode_coordinates[opcode];
                if (!shown_unsupported_opcode[opcode]
                        && candidate > count) {
                    best = opcode;
                    count = candidate;
                }
            }
            if (best == PL_OPCODE_COUNT || !count) break;
            shown_unsupported_opcode[best] = 1u;
            printf(" op%u=%llu/%llu", best,
                   (unsigned long long)
                       selections.unsupported_opcode_coordinates[best],
                   (unsigned long long)
                       selections.unsupported_opcode_classes[best]);
        }
        printf("\n");
        printf("direct-control closure %llu coordinates\n",
               (unsigned long long)catalog.closed_control_coordinates);
        printf("direct function/resolve arms %llu/%llu\n",
               (unsigned long long)catalog.function_arms,
               (unsigned long long)catalog.resolve_arms);
        printf("terminal barrier/fault/halt results %llu/%llu/%llu\n",
               (unsigned long long)catalog.barrier_results,
               (unsigned long long)catalog.fault_results,
               (unsigned long long)catalog.halt_results);
        printf("retained residual state/edge rows 0/0\n");
        printf("hash probes          %llu (maximum %u)\n",
               (unsigned long long)catalog.builder.probes,
               catalog.builder.maximum_probe);
        status = dump_critical_block(
            "maximum-work", &catalog.builder.frontend,
            &catalog.builder.formation, &catalog.builder.comparison,
            catalog.maximum_work_rip);
        if (!status && catalog.maximum_span_rip != catalog.maximum_work_rip)
            status = dump_critical_block(
                "maximum-span", &catalog.builder.frontend,
                &catalog.builder.formation, &catalog.builder.comparison,
                catalog.maximum_span_rip);
    }

    free(hash_slots);
    free(identities);
    free(coordinate_ranks);
    free(compare_second);
    free(compare_first);
    free(second);
    free(first);
    free(class_coordinates);
    free(bytes);
    return status ? 1 : 0;
}
