/* Public compiler boundary.  It emits an ordinary compact x86-64 ELF only
 * after executable entries, direct successors, relocations and allocated
 * code-address metadata are closed.  An input copy, private runtime container
 * or decode request is never a successful product.
 */

#include <postlink/compiler.h>
#include <optimized-x86/reader.h>
#include <support/checked.h>
#include <stdint.h>
#include <support/sha256.h>
#include <x86/elf.h>

#include "internal/emit-x86.h"
#include "internal/discover-entry.h"
#include "internal/layout-elf.h"
#include "internal/minimum.h"
#include "internal/compile-elf.h"
#include "internal/relocate-elf.h"
#include <x86/semantics.h>

/* ELF program-header counts are untrusted input.  The compiler does not hide
 * allocation inside its freestanding core, so the public whole-image entry
 * has one explicit finite map bound.  Ordinary linked ELF images use a small
 * number of PT_LOAD segments; a larger image is rejected before decoding and
 * may be split or admitted through the lower-level caller-owned image API. */
#define POSTLINK_EXECUTABLE_MAP_LIMIT 64u

/* e_entry is an execution coordinate, but ELF permits a boot image to spell
 * that coordinate through p_paddr rather than p_vaddr.  The executable body
 * is normalized in virtual coordinates; publication must restore the input
 * alias kind so a firmware or boot wrapper observes the same ABI. */
static int entry_uses_physical_alias(const pl_elf_image *image,
                                     pl_u64 canonical, int *physical)
{
    if (!image || !physical) return PL_ERROR_ELF;
    *physical = 0;
    if (image->entry == canonical) return 0;
    int found = 0;
    for (pl_u32 index = 0u; index < image->program_count; ++index) {
        pl_elf_segment segment;
        int status = pl_elf_program(image, index, &segment);
        if (status) return status;
        if (segment.type != PL_ELF_SEGMENT_LOAD
                || image->entry < segment.physical_address)
            continue;
        pl_u64 relative = image->entry - segment.physical_address;
        if (relative >= segment.memory_bytes) continue;
        pl_u64 translated;
        if (!pl_checked_add_u64(
                segment.virtual_address, relative, &translated))
            return PL_ERROR_ELF;
        if (translated != canonical) continue;
        if (found) return PL_ERROR_ELF;
        found = 1;
    }
    if (!found) return PL_ERROR_ELF;
    *physical = 1;
    return 0;
}

static int virtual_entry_physical_alias(const pl_elf_image *image,
                                        pl_u64 canonical, pl_u64 *physical)
{
    if (!image || !physical) return PL_ERROR_ELF;
    int found = 0;
    pl_u64 candidate = 0u;
    for (pl_u32 index = 0u; index < image->program_count; ++index) {
        pl_elf_segment segment;
        int status = pl_elf_program(image, index, &segment);
        if (status) return status;
        if (segment.type != PL_ELF_SEGMENT_LOAD
                || canonical < segment.virtual_address)
            continue;
        pl_u64 relative = canonical - segment.virtual_address;
        if (relative >= segment.memory_bytes) continue;
        pl_u64 projected;
        if (!pl_checked_add_u64(
                segment.physical_address, relative, &projected))
            return PL_ERROR_ELF;
        if (found && candidate != projected) return PL_ERROR_ELF;
        candidate = projected;
        found = 1;
    }
    if (!found) return PL_ERROR_ELF;
    *physical = candidate;
    return 0;
}

static void clear_report(postlink_report *report)
{
    if (!report) return;
    report->input_bytes = 0u;
    report->output_bytes = 0u;
    report->executable_coordinates = 0u;
    report->direct_coordinates = 0u;
    report->fault_coordinates = 0u;
    report->unclosed_coordinates = 0u;
    report->first_unclosed_coordinate = 0u;
    report->input_work = 0u;
    report->output_work = 0u;
    report->input_span = 0u;
    report->output_span = 0u;
    report->input_code_bytes = 0u;
    report->output_code_bytes = 0u;
    report->construction_relocations = 0u;
    report->reachable_source_bytes = 0u;
    report->native_source_instructions = 0u;
    report->native_source_work = 0u;
    report->native_normalized_work = 0u;
    report->native_source_span = 0u;
    report->native_normalized_span = 0u;
    report->native_selected_source_bytes = 0u;
    report->native_selected_output_bytes = 0u;
    report->native_eliminated_bytes = 0u;
    report->native_direct_frame_source_bytes = 0u;
    report->native_direct_frame_output_bytes = 0u;
    report->native_copied_source_source_bytes = 0u;
    report->native_copied_source_output_bytes = 0u;
    report->native_erased_source_bytes = 0u;
    report->native_omitted_prefix_bytes = 0u;
    report->native_normalization_escape_source_bytes = 0u;
    report->native_normalization_escape_output_bytes = 0u;
    report->native_normalization_escape_work = 0u;
    report->native_first_normalization_escape_address = 0u;
    report->native_emitted_instructions = 0u;
    report->relocation_records = 0u;
    report->relocated_code_fields = 0u;
    report->relocated_runtime_fields = 0u;
    report->rewritten_relocation_fields = 0u;
    report->rewritten_dynamic_addends = 0u;
    report->rewritten_dynamic_symbols = 0u;
    report->rewritten_dynamic_code_pointers = 0u;
    report->rewritten_lazy_binding_code_pointers = 0u;
    report->rewritten_unwind_rows = 0u;
    report->rewritten_unwind_ranges = 0u;
    report->unresolved_relocations = 0u;
    report->first_unresolved_relocation_offset = 0u;
    report->metadata_failure_field = 0u;
    report->metadata_failure_target = 0u;
    report->projection_source = 0u;
    report->projection_source_end = 0u;
    report->projection_block_start = 0u;
    report->projection_block_end = 0u;
    report->projection_omitted_end = 0u;
    report->native_failure_address = 0u;
    report->native_failure_target = 0u;
    report->native_failure_output = 0u;
    report->native_failure_expected = 0u;
    report->native_failure_status = 0;
    report->native_first_nonimage_control_target = 0u;
    report->native_overlapping_source_address = 0u;
    report->native_overlapping_source_end = 0u;
    report->native_first_overlapping_address = 0u;
    report->entry_candidates = 0u;
    report->function_symbol_rows = 0u;
    report->entry_analysis_workspace_bytes = 0u;
    report->native_entries = 0u;
    report->native_observable_entries = 0u;
    report->code_grid_candidates = 0u;
    report->native_code_grids = 0u;
    report->native_blocks = 0u;
    report->native_observation_classes = 0u;
    report->native_future_classes = 0u;
    report->native_future_shared_blocks = 0u;
    report->native_observable_future_classes = 0u;
    report->native_minimum_entry_coordinates = 0u;
    report->native_shareable_entry_blocks = 0u;
    report->native_selected_blocks = 0u;
    report->native_unselected_blocks = 0u;
    report->native_direct_frame_blocks = 0u;
    report->native_copied_source_blocks = 0u;
    report->native_erased_blocks = 0u;
    report->native_normalization_escape_blocks = 0u;
    report->native_dynamic_blocks = 0u;
    report->native_rflags_dead_blocks = 0u;
    report->native_rflags_projected_blocks = 0u;
    report->native_rflags_projection_grammar_blocks = 0u;
    report->native_rflags_projection_grew_blocks = 0u;
    report->native_rflags_projection_escape_blocks = 0u;
    report->native_rflags_projection_source_identity_blocks = 0u;
    report->native_rflags_projection_changed_grammar_blocks = 0u;
    report->native_first_rflags_projection_grammar_address = 0u;
    report->native_first_rflags_projection_grew_address = 0u;
    report->native_first_rflags_projection_escape_address = 0u;
    report->native_first_rflags_projection_changed_grammar_address = 0u;
    report->native_nonimage_control_edges = 0u;
    report->dispatch_base_candidates = 0u;
    report->dispatch_bases = 0u;
    report->dispatch_targets = 0u;
    report->input_sections = 0u;
    report->executable_sections = 0u;
    report->relocated_executable_sections = 0u;
    report->first_unresolved_relocation_type = 0u;
    report->first_unresolved_relocation_stage = 0u;
    report->metadata_failure_kind = 0u;
    report->metadata_failure_stage = 0u;
    report->native_failure_stage = 0u;
    report->native_failure_end = 0u;
    report->native_failure_live_outputs = 0u;
    report->proof_stage = 0u;
}

static void report_native_population(
    postlink_report *report, const pl_x86_native_population *native)
{
    if (!report || !native) return;
    report->native_failure_end = native->emit_failure_end;
    report->native_failure_live_outputs = native->emit_failure_live_outputs;
    report->reachable_source_bytes = native->reachable_source_bytes;
    report->native_source_instructions = native->source_instructions;
    report->native_source_work = native->source_work;
    report->native_normalized_work = native->normalized_work;
    report->native_source_span = native->source_span;
    report->native_normalized_span = native->normalized_span;
    report->native_selected_source_bytes = native->selected_source_bytes;
    report->native_selected_output_bytes = native->selected_output_bytes;
    report->native_eliminated_bytes = native->eliminated_bytes;
    report->native_direct_frame_source_bytes =
        native->direct_frame_source_bytes;
    report->native_direct_frame_output_bytes =
        native->direct_frame_output_bytes;
    report->native_copied_source_source_bytes =
        native->copied_source_source_bytes;
    report->native_copied_source_output_bytes =
        native->copied_source_output_bytes;
    report->native_erased_source_bytes = native->erased_source_bytes;
    report->native_omitted_prefix_bytes = native->omitted_prefix_bytes;
    report->native_normalization_escape_source_bytes =
        native->normalization_escape_source_bytes;
    report->native_normalization_escape_output_bytes =
        native->normalization_escape_output_bytes;
    report->native_normalization_escape_work =
        native->normalization_escape_work;
    report->native_first_normalization_escape_address =
        native->first_normalization_escape_address;
    report->native_emitted_instructions = native->emitted_instructions;
    report->native_blocks = native->blocks;
    report->native_selected_blocks = native->selected_blocks;
    report->native_unselected_blocks = native->unselected_blocks;
    report->native_direct_frame_blocks = native->direct_frame_blocks;
    report->native_copied_source_blocks = native->copied_source_blocks;
    report->native_erased_blocks = native->erased_blocks;
    report->native_normalization_escape_blocks =
        native->normalization_escape_blocks;
    report->native_first_pareto_address = native->first_pareto_address;
    report->native_pareto_unresolved_blocks =
        native->pareto_unresolved_blocks;
    report->native_pareto_frontier_count = native->pareto_frontier_count;
    for (pl_u32 index = 0u;
            index < POSTLINK_PARETO_DIAGNOSTIC_LIMIT; ++index) {
        report->native_pareto_span[index] = native->pareto_span[index];
        report->native_pareto_work[index] = native->pareto_work[index];
        report->native_pareto_bytes[index] = native->pareto_bytes[index];
    }
    report->native_dynamic_blocks = native->dynamic_blocks;
    report->native_rflags_dead_blocks = native->rflags_dead_blocks;
    report->native_rflags_projected_blocks =
        native->rflags_projected_blocks;
    report->native_rflags_projection_grammar_blocks =
        native->rflags_projection_grammar_blocks;
    report->native_rflags_projection_grew_blocks =
        native->rflags_projection_grew_blocks;
    report->native_rflags_projection_escape_blocks =
        native->rflags_projection_escape_blocks;
    report->native_rflags_projection_source_identity_blocks =
        native->rflags_projection_source_identity_blocks;
    report->native_rflags_projection_changed_grammar_blocks =
        native->rflags_projection_changed_grammar_blocks;
    report->native_first_rflags_projection_grammar_address =
        native->first_rflags_projection_grammar_address;
    report->native_first_rflags_projection_grew_address =
        native->first_rflags_projection_grew_address;
    report->native_first_rflags_projection_escape_address =
        native->first_rflags_projection_escape_address;
    report->native_first_rflags_projection_changed_grammar_address =
        native->first_rflags_projection_changed_grammar_address;
    report->direct_coordinates = native->direct_instructions;
    report->fault_coordinates = native->fault_instructions;
    report->input_work = native->maximum_source_instructions;
    report->output_work = native->emitted_work;
    report->input_span = native->maximum_source_instructions;
    report->output_span = native->emitted_span;
}

static int add_map_population(const pl_x86_image *image,
                              pl_u64 *memory_bytes, pl_u64 *file_bytes)
{
    pl_u64 memory = 0u;
    pl_u64 file = 0u;
    for (pl_u32 index = 0u; index < image->map_count; ++index) {
        if (!pl_checked_add_u64(
                memory, image->maps[index].memory_bytes, &memory)
                || !pl_checked_add_u64(
                    file, image->maps[index].file_bytes, &file))
            return POSTLINK_ERROR_INPUT_ELF;
    }
    *memory_bytes = memory;
    *file_bytes = file;
    return POSTLINK_OK;
}

/* Validate the architectural code domain once.  In a sectioned linked ELF,
 * allocated SHF_EXECINSTR sections publish code coordinates; PF_X is a loader
 * page permission and does not turn adjacent rodata or padding into x86.
 * A stripped ELF has no such construction boundary, so the shared frontend
 * deliberately falls back to PF_X file extents. */
static int analyze_linked_x86(const pl_u8 *input, pl_u64 input_bytes,
                              postlink_report *report)
{
    pl_elf_image elf;
    pl_x86_map code_maps[POSTLINK_EXECUTABLE_MAP_LIMIT];
    pl_x86_image code_image;
    pl_u32 code_map_count = 0u;
    pl_u64 code_coordinates = 0u;
    pl_u64 code_bytes = 0u;
    if (!input || !input_bytes) return POSTLINK_ERROR_ARGUMENT;
    int status = pl_elf_open(input, input_bytes, &elf);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    report->input_sections = elf.section_count;
    pl_elf_code_relocations relocations;
    status = pl_elf_code_relocation_population(&elf, &relocations);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    report->construction_relocations = relocations.relocation_records;
    report->executable_sections = relocations.executable_sections;
    report->relocated_executable_sections =
        relocations.relocated_executable_sections;
    /* Executable construction sections define the finite code domain.  A
     * static ET_EXEC can correctly have no code relocation rows: decoded
     * control/address fields plus allocated metadata are then the complete
     * linked input.  A dynamically loaded image still needs retained static
     * construction rows; runtime relocations alone do not describe every
     * already-resolved code reference that may move. */
    int dynamic = 0;
    for (pl_u32 index = 0u; index < elf.program_count; ++index) {
        pl_elf_segment segment;
        status = pl_elf_program(&elf, index, &segment);
        if (status) return POSTLINK_ERROR_INPUT_ELF;
        if (segment.type == PL_ELF_SEGMENT_DYNAMIC) dynamic = 1;
    }
    if (!relocations.executable_sections
            || (!relocations.relocation_records
                && (elf.type != PL_ELF_TYPE_EXEC || dynamic)))
        return POSTLINK_ERROR_RELOCATIONS;
    status = pl_x86_elf_code_map_count(&elf, &code_map_count);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    if (!code_map_count || code_map_count > POSTLINK_EXECUTABLE_MAP_LIMIT)
        return POSTLINK_ERROR_WORKSPACE;
    status = pl_x86_image_from_elf_code_coordinates(
        &elf, 0u, 0u, PL_X86_ELF_VIRTUAL,
        code_maps, POSTLINK_EXECUTABLE_MAP_LIMIT, &code_image);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    status = add_map_population(&code_image, &code_coordinates, &code_bytes);
    if (status) return status;
    if (!code_coordinates || !code_bytes)
        return POSTLINK_ERROR_INPUT_ELF;
    pl_x86_entry_population entries;
    status = pl_x86_entry_measure(&elf, &code_image, &entries);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    report->entry_candidates = entries.candidate_count;
    report->function_symbol_rows = entries.function_symbol_rows;
    report->entry_analysis_workspace_bytes = entries.analysis_workspace_bytes;
    report->code_grid_candidates = entries.code_grid_candidate_count;
    report->dispatch_base_candidates =
        entries.table_base_candidate_count;

    report->input_bytes = input_bytes;
    report->executable_coordinates = code_coordinates;
    report->input_code_bytes = code_bytes;
    report->output_code_bytes = code_bytes;

    /* Arbitrary byte-offset decoding is a release diagnostic, not a second
     * execution closure.  The product compiler lowers the finite population
     * generated by canonical entries and all of their successors.  The
     * standalone linked-completeness gate still checks every byte coordinate
     * once for decoder/grammar regressions without charging every CLI run. */
    return POSTLINK_OK;
}

/* Before whole-ELF emission only the leading physical coordinates can reject
 * an output. A larger local body may remove a global veneer, dispatch or
 * segment/alignment extent, so neither selected-body bytes nor instruction
 * count is an admissible early length gate. Exact whole-ELF length and rank are
 * compared after sealing. */
static int require_native_improvement(const postlink_report *report)
{
    if (!report
            || !report->native_blocks
            || report->native_unselected_blocks
            || report->output_span > report->input_span
            || report->output_work > report->input_work)
        return POSTLINK_ERROR_NOT_FASTER;
    return POSTLINK_OK;
}

static int align_workspace(pl_u64 value, pl_u64 *out)
{
    pl_u64 remainder = value & 15u;
    return !remainder
         ? (*out = value, 1)
         : pl_checked_add_u64(value, 16u - remainder, out);
}

static int workspace_requirement(const postlink_report *report,
                                 pl_u64 *entry_bytes,
                                 pl_u64 *grid_offset,
                                 pl_u64 *table_offset,
                                 pl_u64 *native_offset,
                                 pl_u64 *total_bytes)
{
    pl_u64 entries;
    pl_u64 entry_values;
    pl_u64 entry_scratch;
    pl_u64 section_support;
    pl_u64 function_index;
    pl_u64 entry_roles;
    pl_u64 grids;
    pl_u64 tables;
    pl_u64 native;
    pl_u64 total;
    if (!report || !entry_bytes || !grid_offset || !table_offset
            || !native_offset || !total_bytes
            || !pl_checked_mul_u64(
                (pl_u64)report->entry_candidates,
                (pl_u64)sizeof(pl_u64), &entry_values)
            || !pl_checked_mul_u64(
                (pl_u64)report->entry_candidates,
                (pl_u64)sizeof(pl_u64), &entry_scratch)
            || !pl_checked_mul_u64(
                (pl_u64)report->function_symbol_rows,
                3u * (pl_u64)sizeof(pl_u64), &function_index)
            || !pl_checked_add_u64(
                (pl_u64)report->input_sections, 7u, &section_support))
        return POSTLINK_ERROR_WORKSPACE;
    if (!pl_checked_add_u64(
            entry_scratch, function_index, &entry_scratch))
        return POSTLINK_ERROR_WORKSPACE;
    if (report->entry_analysis_workspace_bytes > entry_scratch)
        entry_scratch = report->entry_analysis_workspace_bytes;
    section_support >>= 3u;
    if (section_support > entry_scratch)
        entry_scratch = section_support;
    if (!pl_checked_add_u64(entry_values, entry_scratch, &entries)
            || !pl_checked_mul_u64(
                (pl_u64)report->entry_candidates,
                2u * (pl_u64)sizeof(pl_u8), &entry_roles)
            || !pl_checked_add_u64(entries, entry_roles, &entries)
            || !align_workspace(entries, &total)
            || !pl_checked_mul_u64(
                (pl_u64)report->code_grid_candidates,
                (pl_u64)sizeof(pl_x86_code_grid), &grids))
        return POSTLINK_ERROR_WORKSPACE;
    *grid_offset = total;
    if (!pl_checked_add_u64(total, grids, &total)
            || !pl_checked_mul_u64(
                (pl_u64)report->dispatch_base_candidates,
                2u * (pl_u64)sizeof(pl_x86_table), &tables)
            || !align_workspace(total, table_offset)
            || !pl_checked_add_u64(*table_offset, tables, &total)
            || !align_workspace(total, &total)
            || pl_x86_native_workspace_measure(
                report->executable_coordinates, &native)
            || !pl_checked_add_u64(total, native, &total))
        return POSTLINK_ERROR_WORKSPACE;
    *entry_bytes = entry_scratch;
    *native_offset = total - native;
    *total_bytes = total;
    return POSTLINK_OK;
}

int postlink_measure(const pl_u8 *input, pl_u64 input_bytes,
                     postlink_measurement *measurement,
                     postlink_report *report)
{
    int status;
    pl_u64 entry_bytes;
    pl_u64 grid_offset;
    pl_u64 table_offset;
    pl_u64 native_offset;
    if (!measurement || !report) return POSTLINK_ERROR_ARGUMENT;
    measurement->output_capacity = 0u;
    measurement->workspace_bytes = 0u;
    measurement->workspace_alignment = POSTLINK_WORKSPACE_ALIGNMENT;
    clear_report(report);
    status = analyze_linked_x86(input, input_bytes, report);
    if (status) return status;
    status = workspace_requirement(
        report, &entry_bytes, &grid_offset, &table_offset, &native_offset,
        &measurement->workspace_bytes);
    if (status) return status;
    report->required_workspace_bytes = measurement->workspace_bytes;
    (void)entry_bytes;
    (void)grid_offset;
    (void)table_offset;
    (void)native_offset;
    /* A successful product must be smaller, so the source extent is a strict
     * upper bound without estimating an unselected instruction stream. */
    measurement->output_capacity = input_bytes;
    return POSTLINK_OK;
}

static int postlink_compile_impl(
    const pl_u8 *input, pl_u64 input_bytes,
    pl_u8 *output, pl_u64 output_capacity, pl_u64 *output_bytes,
    pl_u8 *workspace, pl_u64 workspace_bytes,
    const postlink_observer *observer, postlink_report *report)
{
    int status;
    if (!output_bytes) return POSTLINK_ERROR_ARGUMENT;
    *output_bytes = 0u;
    if (!output || !workspace || !report
            || ((uintptr_t)workspace & (POSTLINK_WORKSPACE_ALIGNMENT - 1u)))
        return POSTLINK_ERROR_ARGUMENT;
    clear_report(report);
    status = analyze_linked_x86(input, input_bytes, report);
    if (status) return status;
    pl_u64 entry_bytes;
    pl_u64 grid_offset;
    pl_u64 table_offset;
    pl_u64 native_offset;
    pl_u64 required_workspace;
    status = workspace_requirement(
        report, &entry_bytes, &grid_offset, &table_offset,
        &native_offset, &required_workspace);
    if (status || workspace_bytes < required_workspace)
        return POSTLINK_ERROR_WORKSPACE;
    report->required_workspace_bytes = required_workspace;
    pl_u64 native_workspace_bytes = required_workspace - native_offset;
    pl_u64 *entry_values = (pl_u64 *)(void *)workspace;
    pl_u64 *entry_scratch = entry_values + report->entry_candidates;
    pl_u8 *entry_roles = (pl_u8 *)(void *)(
        workspace + (pl_u64)report->entry_candidates
                  * sizeof(*entry_values) + entry_bytes);
    pl_u8 *entry_role_scratch =
        entry_roles + report->entry_candidates;
    pl_x86_code_grid *code_grids =
        (pl_x86_code_grid *)(void *)(workspace + grid_offset);
    pl_x86_table *tables =
        (pl_x86_table *)(void *)(workspace + table_offset);
    pl_x86_table *table_scratch =
        tables + report->dispatch_base_candidates;
    pl_elf_image entry_elf;
    pl_u64 canonical_entry = 0u;
    int canonical_entry_present = 0;
    pl_x86_entry_population entry_population;
    status = pl_elf_open(input, input_bytes, &entry_elf);
    if (!status)
        status = pl_elf_process_entry(
            &entry_elf, &canonical_entry, &canonical_entry_present);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    pl_x86_map code_maps[POSTLINK_EXECUTABLE_MAP_LIMIT];
    pl_u32 code_map_count = 0u;
    pl_x86_image code_image;
    status = pl_x86_elf_code_map_count(&entry_elf, &code_map_count);
    if (status || !code_map_count
            || code_map_count > POSTLINK_EXECUTABLE_MAP_LIMIT)
        return POSTLINK_ERROR_INPUT_ELF;
    status = pl_x86_image_from_elf_code_coordinates(
        &entry_elf, 0u, 0u, PL_X86_ELF_VIRTUAL,
        code_maps, POSTLINK_EXECUTABLE_MAP_LIMIT, &code_image);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    status = pl_x86_entry_write(
        &entry_elf, &code_image,
        entry_values, report->entry_candidates,
        entry_scratch, report->entry_candidates,
        entry_roles, entry_role_scratch,
        code_grids, report->code_grid_candidates,
        tables, report->dispatch_base_candidates,
        table_scratch, report->dispatch_base_candidates,
        (pl_u8 *)(void *)entry_scratch, entry_bytes,
        &entry_population);
    if (status) return POSTLINK_ERROR_INPUT_ELF;
    report->native_entries = entry_population.entry_count;
    report->native_observable_entries =
        entry_population.address_observable_count;
    pl_u32 native_code_grid_count = entry_population.code_grid_count;
    report->dispatch_bases = 0u;
    for (pl_u32 index = 0u; index < entry_population.table_base_count; ++index)
        if (tables[index].domain_closed) ++report->dispatch_bases;
    report->dispatch_targets = entry_population.table_target_count;
    pl_x86_native_population native = { 0 };
    status = pl_x86_native_analyze(
        &code_image, &entry_elf,
        entry_values, entry_roles, entry_population.primary_count,
        entry_population.entry_count,
        code_grids, report->code_grid_candidates,
        &native_code_grid_count,
        workspace + native_offset, native_workspace_bytes,
        &native);
    report->native_code_grids = native_code_grid_count;
    report->native_nonimage_control_edges = native.nonimage_control_edges;
    report->native_first_nonimage_control_target =
        native.first_nonimage_control_target;
    report->native_overlapping_source_address =
        native.overlapping_source_address;
    report->native_overlapping_source_end = native.overlapping_source_end;
    report->native_first_overlapping_address =
        native.first_overlapping_address;
    report->native_failure_stage = native.emit_failure_stage;
    report->native_failure_address = native.emit_failure_address;
    report->native_failure_target = native.emit_failure_target;
    report->native_failure_output = native.emit_failure_output;
    report->native_failure_expected = native.emit_failure_expected;
    report->native_first_pareto_address = native.first_pareto_address;
    report->native_pareto_unresolved_blocks =
        native.pareto_unresolved_blocks;
    report->native_pareto_frontier_count = native.pareto_frontier_count;
    for (pl_u32 index = 0u;
            index < POSTLINK_PARETO_DIAGNOSTIC_LIMIT; ++index) {
        report->native_pareto_span[index] = native.pareto_span[index];
        report->native_pareto_work[index] = native.pareto_work[index];
        report->native_pareto_bytes[index] = native.pareto_bytes[index];
    }
    report->native_failure_status = status;
    if (status) {
        report->proof_stage = 90u;
        return status == PL_ERROR_X86_PARETO
             ? POSTLINK_ERROR_INCOMPLETE : POSTLINK_ERROR_CLOSURE;
    }
    /* Before the ELF exists, its caller-owned output extent is compiler
     * scratch.  Complete-future classes are measured there and then
     * discarded; no graph, decoded row, or quotient sidecar becomes part of
     * the product.  The runtime ELF writer below overwrites the entire live
     * prefix after this phase has ended. */
    pl_u64 future_persistent_bytes = 0u;
    pl_u64 future_phase_bytes = 0u;
    pl_x86_native_future future = { 0 };
    status = pl_x86_native_future_workspace_measure(
        native.blocks, &future_persistent_bytes, &future_phase_bytes);
    if (status)
        return POSTLINK_ERROR_WORKSPACE;
    /* The future vectors are dead before the ordinary ELF writer starts, so
     * the output buffer is their cheapest home when it fits.  Small, dense
     * control-flow programs can have more quotient state than final ELF
     * bytes; append only that exact exceptional extent to compiler workspace
     * instead of imposing a worst-case 16x allocation on every input. */
    pl_u64 future_offset = 0u;
    pl_u64 future_scratch_offset = 0u;
    pl_u64 live_output_bytes = 0u;
    pl_u64 future_fallback_bytes = 0u;
    pl_u64 enlarged_workspace = 0u;
    if (!align_workspace(required_workspace, &future_offset)
            || !pl_checked_mul_u64(
                native.blocks, sizeof(pl_u32), &live_output_bytes)
            || !pl_checked_add_u64(
                future_offset, live_output_bytes, &future_scratch_offset)
            || !align_workspace(
                future_scratch_offset, &future_scratch_offset)
            || !pl_checked_add_u64(
                future_persistent_bytes, future_phase_bytes,
                &future_fallback_bytes)
            || !pl_checked_add_u64(
                future_scratch_offset, future_fallback_bytes,
                &enlarged_workspace))
        return POSTLINK_ERROR_WORKSPACE;
    if (workspace_bytes < enlarged_workspace) {
        /* The live frontier must survive until the final ELF writer; placing
         * it in output would recreate the old analysis/emission split when
         * the runtime ELF overwrote that buffer. Ask the CLI for its exact
         * block-linear compiler extent, then reuse the following phase area
         * for complete-future quotienting. */
        report->required_workspace_bytes = enlarged_workspace;
        return POSTLINK_ERROR_WORKSPACE;
    }
    pl_u32 *live_outputs = (pl_u32 *)(void *)(workspace + future_offset);
    pl_u8 *future_workspace = workspace + future_scratch_offset;
    pl_u64 future_workspace_bytes = workspace_bytes - future_scratch_offset;
    status = pl_x86_native_project_live_outputs(
        &code_image,
        workspace + native_offset, native_workspace_bytes,
        &native, code_grids, native_code_grid_count,
        live_outputs, native.blocks,
        future_workspace, future_workspace_bytes);
    if (status) {
        report_native_population(report, &native);
        report->proof_stage = 93u;
        report->native_failure_stage = native.emit_failure_stage;
        report->native_failure_address = native.emit_failure_address;
        report->native_failure_target = native.emit_failure_target;
        report->native_failure_output = native.emit_failure_output;
        report->native_failure_expected = native.emit_failure_expected;
        report->native_failure_status = status;
        return status == PL_ERROR_X86_PARETO
             ? POSTLINK_ERROR_INCOMPLETE : POSTLINK_ERROR_CLOSURE;
    }
    /* This is the sole reported/emitted population. The pre-projection pass
     * existed only to discover the closed graph; retaining its costs here
     * would recreate the second storage/work route the future proof removed. */
    report_native_population(report, &native);
    /* A normalization escape already has an exact source-x86 candidate in
     * the selected, closed block population.  It is an optimization miss,
     * not an execution hole: retain that native body and keep its count in
     * the report.  Only a missing joint Pareto witness or a mismatch between
     * selected and emitted physical costs invalidates this proof. */
    int pareto_complete = native.pareto_unresolved_blocks ? 2 : 1;
    if (native.emitted_span < native.selection_span_ceiling
            || native.emitted_work < native.selection_work_ceiling
            || (pareto_complete == 1
                && (native.emitted_span != native.selection_span_ceiling
                    || native.emitted_work != native.selection_work_ceiling))) {
        report->proof_stage = 94u;
        report->native_failure_stage = native.emitted_span
                != native.selection_span_ceiling
            ? 242u : 243u;
        report->native_failure_output = native.emitted_work;
        report->native_failure_expected = native.selection_work_ceiling;
        report->native_failure_address = native.emitted_span;
        report->native_failure_target = native.selection_span_ceiling;
        return POSTLINK_ERROR_INCOMPLETE;
    }
    status = pl_x86_native_future_project(
        &code_image,
        workspace + native_offset, native_workspace_bytes,
        &native, code_grids, native_code_grid_count,
        entry_values, entry_roles, entry_population.entry_count,
        live_outputs, native.blocks,
        future_workspace, future_workspace_bytes, observer, &future);
    if (status) {
        report->proof_stage = 91u;
        report->native_failure_stage = 100u + future.failure_stage;
        report->native_failure_address = future.failure_address;
        report->native_failure_target = future.failure_target;
        report->native_failure_output = future.required_bytes;
        report->native_failure_expected = future.available_bytes;
        report->native_failure_status = (pl_i32)future.failure_status;
        return POSTLINK_ERROR_CLOSURE;
    }
    report->native_observation_classes = future.observation_classes;
    report->native_future_classes = future.future_classes;
    report->native_future_shared_blocks = future.shared_blocks;
    if (future.observable_entries
            != report->native_observable_entries) {
        report->proof_stage = 92u;
        return POSTLINK_ERROR_CLOSURE;
    }
    report->native_observable_future_classes =
        future.observable_classes;
    report->native_minimum_entry_coordinates =
        future.minimum_entry_coordinates;
    report->native_shareable_entry_blocks =
        future.shareable_entry_blocks;
    (void)future_phase_bytes;
    status = require_native_improvement(report);
    if (status) return status;
    if (native.selected_output_bytes > 0xffffffffu)
        return POSTLINK_ERROR_EMIT;

    pl_x86_runtime_elf_layout runtime;
    status = pl_x86_runtime_elf_measure(
        input, input_bytes, native.selected_output_bytes, &runtime);
    if (status) {
        report->proof_stage = 101u;
        return POSTLINK_ERROR_EMIT;
    }
    if (runtime.output_bytes > output_capacity) {
        report->proof_stage = 102u;
        return POSTLINK_ERROR_EMIT;
    }
    pl_u64 staging_bytes = 0u;
    status = pl_x86_runtime_elf_write(
        input, input_bytes, &runtime, 0u,
        output, output_capacity, &staging_bytes);
    if (status || staging_bytes != runtime.output_bytes
            || runtime.code_offset > staging_bytes
            || runtime.code_bytes > staging_bytes - runtime.code_offset) {
        report->proof_stage = 103u;
        return POSTLINK_ERROR_EMIT;
    }
    pl_elf_image staging_check;
    if (pl_elf_open(output, staging_bytes, &staging_check)) {
        report->proof_stage = 211u;
        return POSTLINK_ERROR_PROOF;
    }

    pl_x86_native_layout layout;
    status = pl_x86_native_write_analyzed(
        &code_image,
        runtime.code_address, output + runtime.code_offset,
        (pl_u32)runtime.code_bytes,
        code_grids, native_code_grid_count,
        live_outputs, native.blocks,
        workspace + native_offset, native_workspace_bytes,
        &native, &layout);
    if (status || layout.output_bytes != runtime.code_bytes) {
        report->native_failure_address = native.emit_failure_address;
        report->native_failure_target = native.emit_failure_target;
        report->native_failure_output = native.emit_failure_output;
        report->native_failure_expected = native.emit_failure_expected;
        report->native_failure_stage = native.emit_failure_stage;
        report->native_failure_status = native.emit_failure_status;
        report->proof_stage = 104u;
        return POSTLINK_ERROR_EMIT;
    }
    if (pl_elf_open(output, staging_bytes, &staging_check)) {
        report->proof_stage = 212u;
        return POSTLINK_ERROR_PROOF;
    }
    pl_u64 optimized_entry = 0u;
    pl_u64 published_entry = 0u;
    if (canonical_entry_present) {
        status = pl_x86_native_resolve(
            &layout, canonical_entry, &optimized_entry);
        if (status) {
            report->proof_stage = 105u;
            return POSTLINK_ERROR_EMIT;
        }
        int physical_alias = 0;
        status = entry_uses_physical_alias(
            &entry_elf, canonical_entry, &physical_alias);
        if (status) {
            report->proof_stage = 106u;
            return POSTLINK_ERROR_EMIT;
        }
        published_entry = optimized_entry;
        if (physical_alias) {
            status = virtual_entry_physical_alias(
                &staging_check, optimized_entry, &published_entry);
            if (status) {
                report->proof_stage = 107u;
                return POSTLINK_ERROR_EMIT;
            }
        }
        pl_write_u64(output + 24u, published_entry);
    }
    pl_u8 header_before[PL_ELF_HEADER_BYTES];
    for (pl_u32 index = 0u; index < PL_ELF_HEADER_BYTES; ++index)
        header_before[index] = output[index];
    pl_x86_relocation_report relocations;
    status = pl_x86_relocate_elf(
        input, input_bytes, &runtime, &layout,
        tables, entry_population.table_base_count,
        output, staging_bytes, &relocations);
    report->relocation_records = relocations.records;
    report->relocated_code_fields = relocations.code_fields;
    report->relocated_runtime_fields = relocations.runtime_fields;
    report->rewritten_relocation_fields = relocations.rewritten_fields;
    report->rewritten_dynamic_addends = relocations.dynamic_addends;
    report->rewritten_dynamic_symbols = relocations.dynamic_symbols;
    report->rewritten_dynamic_code_pointers =
        relocations.dynamic_code_pointers;
    report->rewritten_lazy_binding_code_pointers =
        relocations.lazy_binding_code_pointers;
    report->rewritten_unwind_rows = relocations.unwind_rows;
    report->rewritten_unwind_ranges = relocations.unwind_ranges;
    report->unresolved_relocations = relocations.unresolved_records;
    report->first_unresolved_relocation_offset =
        relocations.first_unresolved_offset;
    report->first_unresolved_relocation_type =
        relocations.first_unresolved_type;
    report->first_unresolved_relocation_stage =
        relocations.first_unresolved_stage;
    report->metadata_failure_field = relocations.metadata_failure_field;
    report->metadata_failure_target = relocations.metadata_failure_target;
    report->metadata_failure_kind = relocations.metadata_failure_kind;
    report->metadata_failure_stage = relocations.metadata_failure_stage;
    report->projection_source = relocations.projection_source;
    report->projection_source_end = relocations.projection_source_end;
    report->projection_block_start = relocations.projection_block_start;
    report->projection_block_end = relocations.projection_block_end;
    report->projection_omitted_end = relocations.projection_omitted_end;
    if (status) return POSTLINK_ERROR_RELOCATION_CLOSURE;
    for (pl_u32 index = 0u; index < PL_ELF_HEADER_BYTES; ++index)
        if (output[index] != header_before[index]) {
            report->proof_stage = 400u + index;
            return POSTLINK_ERROR_PROOF;
        }
    report->output_code_bytes = layout.output_bytes;
    pl_u64 entry_function = OX_PROOF_NO_ENTRY_FUNCTION;
    if (canonical_entry_present) {
        pl_u32 entry_rank = 0u;
        status = pl_x86_native_rank(&layout, canonical_entry, &entry_rank);
        if (status) {
            report->proof_stage = 1u;
            return POSTLINK_ERROR_PROOF;
        }
        entry_function = entry_rank;
    }
    pl_u8 digest[PL_SHA256_BYTES];
    pl_sha256_digest(input, input_bytes, digest);
    ox_proof proof = { 0 };
    proof.proof_version = OX_PROOF_VERSION;
    proof.machine_abi = OX_MACHINE_ABI_VERSION;
    proof.flags = OX_PROOF_REQUIRED_FLAGS;
    for (pl_u32 index = 0u; index < 4u; ++index)
        proof.source_sha256[index] = pl_read_u64(digest + index * 8u);
    proof.source_bytes = input_bytes;
    proof.entry_function = entry_function;
    proof.function_count = native.blocks;
    proof.coordinate_count = native.source_instructions;
    proof.direct_count = report->direct_coordinates;
    proof.fault_count = report->fault_coordinates;
    proof.input_span = report->input_span;
    proof.output_span = report->output_span;
    proof.input_work = report->input_work;
    proof.output_work = report->output_work;
    proof.minimum_span = native.selection_span_ceiling;
    proof.minimum_work = native.selection_work_ceiling;
    proof.pareto_complete = (pl_u64)pareto_complete;
    proof.input_code_bytes = report->input_code_bytes;
    proof.output_code_bytes = report->output_code_bytes;

    pl_elf_image staged_elf;
    status = pl_elf_open(output, staging_bytes, &staged_elf);
    if (status) {
        report->proof_stage = 200u + (pl_u32)(-status);
        return POSTLINK_ERROR_PROOF;
    }
    for (pl_u32 index = 0u; index < staged_elf.program_count; ++index) {
        pl_elf_segment staged_program;
        status = pl_elf_program(&staged_elf, index, &staged_program);
        if (status) {
            report->proof_stage = 300u + index;
            return POSTLINK_ERROR_PROOF;
        }
    }
    pl_x86_elf_emission emission;
    status = pl_x86_elf_measure(
        output, staging_bytes, &proof, &emission);
    if (status) {
        report->proof_stage = 20u + (pl_u32)(-status);
        return POSTLINK_ERROR_PROOF;
    }
    if (emission.output_bytes >= input_bytes)
        return POSTLINK_ERROR_NOT_SMALLER;
    if (emission.output_bytes > output_capacity)
        return POSTLINK_ERROR_EMIT;
    pl_u64 sealed_bytes = 0u;
    status = pl_x86_elf_write(
        output, staging_bytes, &proof,
        output, output_capacity, &sealed_bytes);
    if (status || sealed_bytes != emission.output_bytes) {
        report->proof_stage = 3u;
        return POSTLINK_ERROR_PROOF;
    }
    ox_image verified;
    status = ox_image_open(output, sealed_bytes, &verified);
    if (status || verified.entry != published_entry
            || verified.proof.source_bytes != input_bytes
            || verified.proof.entry_function != entry_function
            || verified.proof.function_count != native.blocks) {
        report->proof_stage = 4u;
        return POSTLINK_ERROR_PROOF;
    }
    /* The linked input is always a literal candidate in the complete global
     * program space. Compare complete ordinary ELF results, never a sum of
     * locally selected block lengths. This is the first incumbent gate; the
     * all-program lower-bound frontier must additionally exclude every other
     * candidate before distribution publication can claim global minimality. */
    pl_u64 input_program_bits = 0u, output_program_bits = 0u;
    if (!pl_checked_mul_u64(input_bytes, 8u, &input_program_bits)
            || !pl_checked_mul_u64(
                sealed_bytes, 8u, &output_program_bits))
        return POSTLINK_ERROR_PROOF;
    pl_x86_minimum_key input_key = {
        report->input_span, report->input_work, input_bytes,
        input, input_program_bits,
    };
    pl_x86_minimum_key output_key = {
        report->output_span, report->output_work, sealed_bytes,
        output, output_program_bits,
    };
    int minimum_order = 0;
    status = pl_x86_minimum_compare(
        &output_key, &input_key, &minimum_order);
    if (status || minimum_order >= 0) {
        report->proof_stage = 8u;
        return status ? POSTLINK_ERROR_PROOF : POSTLINK_ERROR_NOT_FASTER;
    }
    if (observer) {
        if (layout.offset_count != native.blocks
                || layout.output_bytes != runtime.code_bytes) {
            report->proof_stage = 5u;
            return POSTLINK_ERROR_PROOF;
        }
        for (pl_u32 state = 0u; state < native.blocks; ++state) {
            pl_u32 first = layout.offset_by_boundary[state];
            pl_u32 end = state + 1u < native.blocks
                       ? layout.offset_by_boundary[state + 1u]
                       : layout.output_bytes;
            pl_u64 file_offset = 0u;
            if (first > end || end > layout.output_bytes
                    || !pl_checked_add_u64(
                        runtime.code_offset, first, &file_offset)
                    || file_offset > sealed_bytes
                    || (pl_u64)(end - first)
                       > sealed_bytes - file_offset
                    || observer->emitted(
                        observer->context, state, file_offset,
                        output + file_offset, end - first)) {
                report->proof_stage = 6u;
                return POSTLINK_ERROR_CLOSURE;
            }
        }
    }
    if (observer && observer->commit(
            observer->context, output, sealed_bytes)) {
        report->proof_stage = 7u;
        return POSTLINK_ERROR_CLOSURE;
    }
    report->output_bytes = sealed_bytes;
    *output_bytes = sealed_bytes;
    (void)entry_bytes;
    return POSTLINK_OK;
}

int postlink_compile(const pl_u8 *input, pl_u64 input_bytes,
                     pl_u8 *output, pl_u64 output_capacity,
                     pl_u64 *output_bytes,
                     pl_u8 *workspace, pl_u64 workspace_bytes,
                     postlink_report *report)
{
    return postlink_compile_impl(
        input, input_bytes, output, output_capacity, output_bytes,
        workspace, workspace_bytes, 0, report);
}

int postlink_compile_observed(
    const pl_u8 *input, pl_u64 input_bytes,
    pl_u8 *output, pl_u64 output_capacity, pl_u64 *output_bytes,
    pl_u8 *workspace, pl_u64 workspace_bytes,
    const postlink_observer *observer, postlink_report *report)
{
    if (!observer || !observer->begin || !observer->block
            || !observer->emitted || !observer->commit)
        return POSTLINK_ERROR_ARGUMENT;
    return postlink_compile_impl(
        input, input_bytes, output, output_capacity, output_bytes,
        workspace, workspace_bytes, observer, report);
}

const char *postlink_status_string(int status)
{
    switch (status) {
    case POSTLINK_OK: return "success";
    case POSTLINK_ERROR_ARGUMENT: return "invalid argument";
    case POSTLINK_ERROR_INPUT_ELF: return "invalid linked x86-64 ELF";
    case POSTLINK_ERROR_WORKSPACE: return "insufficient compiler workspace";
    case POSTLINK_ERROR_SEMANTICS: return "x86 semantics are not closed";
    case POSTLINK_ERROR_CLOSURE: return "control closure is incomplete";
    case POSTLINK_ERROR_EMIT: return "native ELF emission failed";
    case POSTLINK_ERROR_PROOF: return "optimized ELF proof failed";
    case POSTLINK_ERROR_NOT_SMALLER: return "optimized ELF is not smaller";
    case POSTLINK_ERROR_NOT_FASTER: return "optimized ELF is not faster";
    case POSTLINK_ERROR_INCOMPLETE:
        return "native optimized-ELF compiler is incomplete";
    case POSTLINK_ERROR_RELOCATIONS:
        return "dynamic linked ELF lacks static construction relocations "
               "(--emit-relocs)";
    case POSTLINK_ERROR_RELOCATION_CLOSURE:
        return "linked ELF construction relocations are not closed";
    default: return "unknown post-link compiler error";
    }
}
