#include <postlink/compiler.h>
#include <x86/elf.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int read_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *file = fopen(path, "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 0;
    long end = ftell(file);
    if (end <= 0 || fseek(file, 0, SEEK_SET)) return 0;
    *bytes = malloc((size_t)end);
    if (!*bytes || fread(*bytes, 1u, (size_t)end, file) != (size_t)end
            || fclose(file))
        return 0;
    *length = (pl_u64)(unsigned long)end;
    return 1;
}

static int write_file(const char *path, const pl_u8 *bytes, pl_u64 length)
{
    FILE *file = fopen(path, "wb");
    if (!file) return 0;
    int ok = fwrite(bytes, 1u, (size_t)length, file) == (size_t)length;
    return fclose(file) == 0 && ok;
}

int main(int argc, char **argv)
{
    int require_dynamic = argc == 4 && !strcmp(argv[3], "--dynamic");
    if ((argc != 3 && argc != 4) || (argc == 4 && !require_dynamic)) return 2;
    pl_u8 *input = 0;
    pl_u64 input_bytes = 0u;
    if (!read_file(argv[1], &input, &input_bytes)) return 2;
    postlink_measurement measurement;
    postlink_report report;
    int status = postlink_measure(
        input, input_bytes, &measurement, &report);
    pl_u8 *output = status ? 0 : malloc((size_t)measurement.output_capacity);
    pl_u8 *workspace = status ? 0 : malloc((size_t)measurement.workspace_bytes);
    if (status || !output || !workspace) {
        fprintf(stderr, "runtime ELF staging: measure failed (%s)\n",
                postlink_status_string(status));
        return 2;
    }
    pl_u64 compiled_bytes = 0u;
    for (;;) {
        status = postlink_compile(
            input, input_bytes, output, measurement.output_capacity,
            &compiled_bytes, workspace, measurement.workspace_bytes,
            &report);
        if (status != POSTLINK_ERROR_WORKSPACE
                || report.required_workspace_bytes
                   <= measurement.workspace_bytes)
            break;
        pl_u8 *larger = realloc(
            workspace, (size_t)report.required_workspace_bytes);
        if (!larger) break;
        workspace = larger;
        measurement.workspace_bytes = report.required_workspace_bytes;
    }
    if (status || !compiled_bytes) {
        fprintf(stderr,
                "runtime ELF staging: compile failed (%s; %u/%u blocks, "
                "%llu/%llu bytes, %llu/%llu instructions, "
                "metadata=%u/%u@0x%llx->0x%llx)\n",
                postlink_status_string(status), report.native_selected_blocks,
                report.native_blocks,
                (unsigned long long)report.native_selected_source_bytes,
                (unsigned long long)report.native_selected_output_bytes,
                (unsigned long long)report.native_source_instructions,
                (unsigned long long)report.native_emitted_instructions,
                report.metadata_failure_kind,
                report.metadata_failure_stage,
                (unsigned long long)report.metadata_failure_field,
                (unsigned long long)report.metadata_failure_target);
        return 1;
    }

    pl_elf_image elf;
    status = pl_elf_open(output, compiled_bytes, &elf);
    pl_u64 runtime_extent = 0u;
    pl_u64 executable_file_bytes = 0u;
    for (pl_u32 index = 0u; !status && index < elf.program_count; ++index) {
        pl_elf_segment segment;
        status = pl_elf_program(&elf, index, &segment);
        pl_u64 end = segment.file_offset + segment.file_bytes;
        if (end > runtime_extent) runtime_extent = end;
        if (segment.flags & PL_ELF_FLAG_EXECUTE) {
            if (executable_file_bytes) status = -1;
            executable_file_bytes = segment.file_bytes;
        }
    }
    if (status || !runtime_extent || compiled_bytes >= input_bytes
            || executable_file_bytes
               != report.native_selected_output_bytes
            || report.native_unselected_blocks
            || !report.native_observable_entries
            || report.native_observable_entries > report.native_entries
            || !report.native_observation_classes
            || report.native_observation_classes
               > report.native_future_classes
            || report.native_future_classes > report.native_blocks
            || report.native_future_shared_blocks
               != report.native_blocks - report.native_future_classes
            || !report.native_observable_future_classes
            || report.native_observable_future_classes
               > report.native_observable_entries
            || report.native_minimum_entry_coordinates
               != report.native_future_classes
                  + report.native_observable_entries
                  - report.native_observable_future_classes
            || report.native_minimum_entry_coordinates
               > report.native_blocks
            || report.native_shareable_entry_blocks
               != report.native_blocks
                  - report.native_minimum_entry_coordinates
            || report.native_direct_frame_blocks
                 + report.native_copied_source_blocks
                 + report.native_erased_blocks
               != report.native_selected_blocks
            || report.native_direct_frame_source_bytes
                 + report.native_copied_source_source_bytes
                 + report.native_erased_source_bytes
               != report.native_selected_source_bytes
            || report.native_direct_frame_output_bytes
                 + report.native_copied_source_output_bytes
               != report.native_selected_output_bytes
            || report.native_emitted_instructions
               >= report.native_source_instructions
            || !report.relocation_records
            || !report.relocated_code_fields
            || (require_dynamic
                && (!report.rewritten_dynamic_code_pointers
                    || !report.rewritten_lazy_binding_code_pointers
                    || !report.rewritten_unwind_rows
                    || report.rewritten_unwind_ranges
                       != report.rewritten_unwind_rows))
            || report.unresolved_relocations
            || !write_file(argv[2], output, compiled_bytes)) {
        fprintf(stderr,
                "runtime ELF staging: output failed (elf=%d extent=%llu/%llu/%llu, "
                "unselected=%u unresolved=%llu, instructions=%llu/%llu, dynamic=%llu unwind=%llu)\n",
                status, (unsigned long long)runtime_extent,
                (unsigned long long)compiled_bytes,
                (unsigned long long)input_bytes,
                report.native_unselected_blocks,
                (unsigned long long)report.unresolved_relocations,
                (unsigned long long)report.native_source_instructions,
                (unsigned long long)report.native_emitted_instructions,
                (unsigned long long)
                    report.rewritten_dynamic_code_pointers,
                (unsigned long long)report.rewritten_unwind_rows);
        return 1;
    }
    printf("runtime ELF: green (%llu -> %llu bytes, %llu -> %llu instructions, "
           "future=%u blocks/%u observations/%u classes, "
           "placement=%u observable/%u classes/%u minimum entries, "
           "%llu relocations, %llu metadata pointers)\n",
           (unsigned long long)input_bytes,
           (unsigned long long)compiled_bytes,
           (unsigned long long)report.native_source_instructions,
           (unsigned long long)report.native_emitted_instructions,
           report.native_blocks,
           report.native_observation_classes,
           report.native_future_classes,
           report.native_observable_entries,
           report.native_observable_future_classes,
           report.native_minimum_entry_coordinates,
           (unsigned long long)report.relocation_records,
           (unsigned long long)(report.rewritten_dynamic_code_pointers
                              + report.rewritten_lazy_binding_code_pointers
                              + report.rewritten_unwind_rows));
    free(workspace);
    free(output);
    free(input);
    return 0;
}
