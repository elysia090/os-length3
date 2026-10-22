#define _XOPEN_SOURCE 700

#include <postlink/compiler.h>

#include <errno.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int read_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *file;
    long end;
    size_t read;
    if (!path || !bytes || !length) return 0;
    file = fopen(path, "rb");
    if (!file) return 0;
    if (fseek(file, 0, SEEK_END) != 0) { fclose(file); return 0; }
    end = ftell(file);
    if (end <= 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return 0;
    }
    *bytes = malloc((size_t)end);
    if (!*bytes) { fclose(file); return 0; }
    read = fread(*bytes, 1u, (size_t)end, file);
    fclose(file);
    if (read != (size_t)end) { free(*bytes); *bytes = NULL; return 0; }
    *length = (pl_u64)(unsigned long)end;
    return 1;
}

/* Write a new file beside the output: `temporary` is a mkstemp template, so
 * the name is unpredictable and the file is created exclusively (never through
 * a symlink or into a file someone else made), owner-only until it is complete.
 * It takes `mode`, and reaches the disk, before it is renamed into place; on
 * failure nothing is left behind. */
static int write_new(char *temporary, const pl_u8 *bytes, pl_u64 length,
                     mode_t mode)
{
    int fd;
    pl_u64 done = 0u;
    if (length > (pl_u64)SIZE_MAX) return 0;
    fd = mkstemp(temporary);
    if (fd < 0) return 0;
    while (done < length) {
        ssize_t wrote = write(fd, bytes + done, (size_t)(length - done));
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) break;
        done += (pl_u64)wrote;
    }
    if (done == length && !fchmod(fd, mode) && !fsync(fd) && !close(fd))
        return 1;
    close(fd);
    unlink(temporary);
    return 0;
}

static void print_incomplete(const postlink_report *report)
{
    if (!report) return;
    fprintf(stderr,
            "postlink-compiler: incomplete native closure: pareto=%u at 0x%llx, normalization-escape=%u at 0x%llx..0x%llx live=0x%x (%llu -> %llu bytes, %llu node-delta), selected=%u/%u\n",
            report->native_pareto_unresolved_blocks,
            (unsigned long long)report->native_first_pareto_address,
            report->native_normalization_escape_blocks,
            (unsigned long long)
                report->native_first_normalization_escape_address,
            (unsigned long long)report->native_failure_end,
            report->native_failure_live_outputs,
            (unsigned long long)
                report->native_normalization_escape_source_bytes,
            (unsigned long long)
                report->native_normalization_escape_output_bytes,
            (unsigned long long)report->native_normalization_escape_work,
            report->native_selected_blocks, report->native_blocks);
    if (report->native_pareto_frontier_count) {
        fprintf(stderr, "postlink-compiler: first Pareto frontier:");
        for (pl_u32 index = 0u;
                index < report->native_pareto_frontier_count
                     && index < POSTLINK_PARETO_DIAGNOSTIC_LIMIT;
                ++index)
            fprintf(stderr, " %u/%u/%u",
                    report->native_pareto_span[index],
                    report->native_pareto_work[index],
                    report->native_pareto_bytes[index]);
        fputc('\n', stderr);
    }
}

int main(int argc, char **argv)
{
    pl_u8 *input = NULL;
    pl_u8 *output = NULL;
    pl_u8 *workspace = NULL;
    pl_u64 input_bytes = 0u;
    pl_u64 output_bytes = 0u;
    postlink_measurement measurement;
    postlink_report report;
    int status;
    if (argc != 4 || strcmp(argv[2], "-o")) {
        fprintf(stderr,
                "usage: postlink-compiler INPUT.elf -o OUTPUT.elf\n");
        return 2;
    }
    if (!read_file(argv[1], &input, &input_bytes)) {
        fprintf(stderr, "postlink-compiler: cannot read %s\n", argv[1]);
        return 2;
    }
    status = postlink_measure(input, input_bytes, &measurement, &report);
    if (status) {
        fprintf(stderr, "postlink-compiler: %s\n",
                postlink_status_string(status));
        if (status == POSTLINK_ERROR_NOT_SMALLER)
            fprintf(stderr,
                    "postlink-compiler: candidate code=%llu->%llu bytes, instructions=%llu->%llu, work=%llu->%llu, span=%llu->%llu; blocks/observations/future/shared=%u/%u/%u/%u, direct/source/erased=%u/%u/%u, normalization escape=%u\n",
                    (unsigned long long)report.input_code_bytes,
                    (unsigned long long)report.output_code_bytes,
                    (unsigned long long)report.native_source_instructions,
                    (unsigned long long)report.native_emitted_instructions,
                    (unsigned long long)report.input_work,
                    (unsigned long long)report.output_work,
                    (unsigned long long)report.input_span,
                    (unsigned long long)report.output_span,
                    report.native_blocks,
                    report.native_observation_classes,
                    report.native_future_classes,
                    report.native_future_shared_blocks,
                    report.native_direct_frame_blocks,
                    report.native_copied_source_blocks,
                    report.native_erased_blocks,
                    report.native_normalization_escape_blocks);
        if (status == POSTLINK_ERROR_INCOMPLETE)
            print_incomplete(&report);
        if (status == POSTLINK_ERROR_CLOSURE)
            fprintf(stderr,
                    "postlink-compiler: closure stage %u; entries=%u observable=%u blocks=%u observations=%u future=%u\n",
                    report.proof_stage, report.native_entries,
                    report.native_observable_entries,
                    report.native_blocks,
                    report.native_observation_classes,
                    report.native_future_classes);
        if (status == POSTLINK_ERROR_EMIT)
            fprintf(stderr, "postlink-compiler: emission stage %u\n",
                    report.proof_stage);
        if (report.native_failure_stage)
            fprintf(stderr,
                    "postlink-compiler: native stage %u at 0x%llx -> 0x%llx; output=0x%llx expected=0x%llx\n",
                    report.native_failure_stage,
                    (unsigned long long)report.native_failure_address,
                    (unsigned long long)report.native_failure_target,
                    (unsigned long long)report.native_failure_output,
                    (unsigned long long)report.native_failure_expected);
        if (status == POSTLINK_ERROR_PROOF)
            fprintf(stderr,
                    "postlink-compiler: proof stage %u; coordinates=%llu direct/fault=%llu/%llu, work=%llu/%llu, span=%llu/%llu, code=%llu/%llu, functions=%u\n",
                    report.proof_stage,
                    (unsigned long long)report.executable_coordinates,
                    (unsigned long long)report.direct_coordinates,
                    (unsigned long long)report.fault_coordinates,
                    (unsigned long long)report.input_work,
                    (unsigned long long)report.output_work,
                    (unsigned long long)report.input_span,
                    (unsigned long long)report.output_span,
                    (unsigned long long)report.input_code_bytes,
                    (unsigned long long)report.output_code_bytes,
                    report.native_blocks);
        if (status == POSTLINK_ERROR_RELOCATION_CLOSURE)
            fprintf(stderr,
                    "postlink-compiler: %llu unresolved relocations; first stage=%u type=%u offset=0x%llx\n",
                    (unsigned long long)report.unresolved_relocations,
                    report.first_unresolved_relocation_stage,
                    report.first_unresolved_relocation_type,
                    (unsigned long long)
                        report.first_unresolved_relocation_offset);
        if (report.metadata_failure_stage)
            fprintf(stderr,
                    "postlink-compiler: metadata stage=%u kind=%u field=0x%llx target=0x%llx\n",
                    report.metadata_failure_stage,
                    report.metadata_failure_kind,
                    (unsigned long long)report.metadata_failure_field,
                    (unsigned long long)report.metadata_failure_target);
        if (report.projection_source)
            fprintf(stderr,
                    "postlink-compiler: projection source=0x%llx..0x%llx block=0x%llx..0x%llx omitted-end=0x%llx\n",
                    (unsigned long long)report.projection_source,
                    (unsigned long long)report.projection_source_end,
                    (unsigned long long)report.projection_block_start,
                    (unsigned long long)report.projection_block_end,
                    (unsigned long long)report.projection_omitted_end);
        if (report.unclosed_coordinates)
            fprintf(stderr,
                    "postlink-compiler: %llu unclosed executable coordinates; first=0x%llx\n",
                    (unsigned long long)report.unclosed_coordinates,
                    (unsigned long long)report.first_unclosed_coordinate);
        if (report.native_nonimage_control_edges)
            fprintf(stderr,
                    "postlink-compiler: %u preserved non-image control edges; first=0x%llx\n",
                    report.native_nonimage_control_edges,
                    (unsigned long long)
                        report.native_first_nonimage_control_target);
        if (report.native_first_overlapping_address)
            fprintf(stderr,
                    "postlink-compiler: overlapping blocks 0x%llx..0x%llx at 0x%llx\n",
                    (unsigned long long)
                        report.native_overlapping_source_address,
                    (unsigned long long)report.native_overlapping_source_end,
                    (unsigned long long)
                        report.native_first_overlapping_address);
        free(input);
        return 1;
    }
    if (measurement.output_capacity > (pl_u64)SIZE_MAX
            || measurement.workspace_bytes > (pl_u64)SIZE_MAX) {
        fprintf(stderr, "postlink-compiler: measured image exceeds host size\n");
        free(input);
        return 1;
    }
    output = malloc((size_t)measurement.output_capacity);
    if (measurement.workspace_bytes)
        workspace = malloc((size_t)measurement.workspace_bytes);
    if (!output || (measurement.workspace_bytes && !workspace)) {
        fprintf(stderr, "postlink-compiler: cannot allocate measured workspace\n");
        free(workspace);
        free(output);
        free(input);
        return 1;
    }
    for (;;) {
        status = postlink_compile(
            input, input_bytes, output, measurement.output_capacity,
            &output_bytes, workspace, measurement.workspace_bytes, &report);
        if (status != POSTLINK_ERROR_WORKSPACE
                || report.required_workspace_bytes
                   <= measurement.workspace_bytes)
            break;
        if (report.required_workspace_bytes > (pl_u64)SIZE_MAX) break;
        pl_u8 *larger = realloc(
            workspace, (size_t)report.required_workspace_bytes);
        if (!larger) break;
        workspace = larger;
        measurement.workspace_bytes = report.required_workspace_bytes;
    }
    if (status) {
        fprintf(stderr, "postlink-compiler: %s\n",
                postlink_status_string(status));
        if (status == POSTLINK_ERROR_NOT_SMALLER)
            fprintf(stderr,
                    "postlink-compiler: candidate code=%llu->%llu bytes, instructions=%llu->%llu, work=%llu->%llu, span=%llu->%llu; blocks/observations/future/shared=%u/%u/%u/%u, direct/source/erased=%u/%u/%u, normalization escape=%u\n",
                    (unsigned long long)report.input_code_bytes,
                    (unsigned long long)report.output_code_bytes,
                    (unsigned long long)report.native_source_instructions,
                    (unsigned long long)report.native_emitted_instructions,
                    (unsigned long long)report.input_work,
                    (unsigned long long)report.output_work,
                    (unsigned long long)report.input_span,
                    (unsigned long long)report.output_span,
                    report.native_blocks,
                    report.native_observation_classes,
                    report.native_future_classes,
                    report.native_future_shared_blocks,
                    report.native_direct_frame_blocks,
                    report.native_copied_source_blocks,
                    report.native_erased_blocks,
                    report.native_normalization_escape_blocks);
        if (status == POSTLINK_ERROR_INCOMPLETE)
            print_incomplete(&report);
        if (status == POSTLINK_ERROR_CLOSURE)
            fprintf(stderr,
                    "postlink-compiler: closure stage %u; entries=%u observable=%u blocks=%u observations=%u future=%u\n",
                    report.proof_stage, report.native_entries,
                    report.native_observable_entries,
                    report.native_blocks,
                    report.native_observation_classes,
                    report.native_future_classes);
        if (status == POSTLINK_ERROR_EMIT)
            fprintf(stderr, "postlink-compiler: emission stage %u\n",
                    report.proof_stage);
        if (report.native_failure_stage)
            fprintf(stderr,
                    "postlink-compiler: native stage %u status=%d at 0x%llx -> 0x%llx; output=0x%llx expected=0x%llx\n",
                    report.native_failure_stage,
                    report.native_failure_status,
                    (unsigned long long)report.native_failure_address,
                    (unsigned long long)report.native_failure_target,
                    (unsigned long long)report.native_failure_output,
                    (unsigned long long)report.native_failure_expected);
        if (status == POSTLINK_ERROR_PROOF)
            fprintf(stderr,
                    "postlink-compiler: proof stage %u; coordinates=%llu direct/fault=%llu/%llu, work=%llu/%llu, span=%llu/%llu, code=%llu/%llu, functions=%u\n",
                    report.proof_stage,
                    (unsigned long long)report.executable_coordinates,
                    (unsigned long long)report.direct_coordinates,
                    (unsigned long long)report.fault_coordinates,
                    (unsigned long long)report.input_work,
                    (unsigned long long)report.output_work,
                    (unsigned long long)report.input_span,
                    (unsigned long long)report.output_span,
                    (unsigned long long)report.input_code_bytes,
                    (unsigned long long)report.output_code_bytes,
                    report.native_blocks);
        if (status == POSTLINK_ERROR_RELOCATION_CLOSURE)
            fprintf(stderr,
                    "postlink-compiler: %llu unresolved relocations; first stage=%u type=%u offset=0x%llx\n",
                    (unsigned long long)report.unresolved_relocations,
                    report.first_unresolved_relocation_stage,
                    report.first_unresolved_relocation_type,
                    (unsigned long long)
                        report.first_unresolved_relocation_offset);
        if (report.metadata_failure_stage)
            fprintf(stderr,
                    "postlink-compiler: metadata stage=%u kind=%u field=0x%llx target=0x%llx\n",
                    report.metadata_failure_stage,
                    report.metadata_failure_kind,
                    (unsigned long long)report.metadata_failure_field,
                    (unsigned long long)report.metadata_failure_target);
        if (report.projection_source)
            fprintf(stderr,
                    "postlink-compiler: projection source=0x%llx..0x%llx block=0x%llx..0x%llx omitted-end=0x%llx\n",
                    (unsigned long long)report.projection_source,
                    (unsigned long long)report.projection_source_end,
                    (unsigned long long)report.projection_block_start,
                    (unsigned long long)report.projection_block_end,
                    (unsigned long long)report.projection_omitted_end);
        if (report.native_nonimage_control_edges)
            fprintf(stderr,
                    "postlink-compiler: %u preserved non-image control edges; first=0x%llx\n",
                    report.native_nonimage_control_edges,
                    (unsigned long long)
                        report.native_first_nonimage_control_target);
        if (report.native_first_overlapping_address)
            fprintf(stderr,
                    "postlink-compiler: overlapping blocks 0x%llx..0x%llx at 0x%llx\n",
                    (unsigned long long)
                        report.native_overlapping_source_address,
                    (unsigned long long)report.native_overlapping_source_end,
                    (unsigned long long)
                        report.native_first_overlapping_address);
        free(workspace);
        free(output);
        free(input);
        return 1;
    }

    /* The output keeps the input's permission bits (a package's modes are
     * the package's), never wider than the input's. */
    struct stat source_stat;
    mode_t mode = 0755;
    if (stat(argv[1], &source_stat) == 0)
        mode = source_stat.st_mode & 07777;
    size_t temporary_bytes = strlen(argv[3]) + 32u;
    char *temporary = malloc(temporary_bytes);
    if (!temporary
            || snprintf(temporary, temporary_bytes, "%s.postlink-XXXXXX",
                        argv[3]) < 0
            || !write_new(temporary, output, output_bytes, mode)) {
        fprintf(stderr, "postlink-compiler: cannot write %s\n", argv[3]);
        free(temporary);
        free(workspace);
        free(output);
        free(input);
        return 1;
    }
    if (rename(temporary, argv[3])) {
        fprintf(stderr, "postlink-compiler: cannot publish %s\n", argv[3]);
        remove(temporary);
        free(temporary);
        free(workspace);
        free(output);
        free(input);
        return 1;
    }
    printf("postlink compile: green (%llu -> %llu bytes, "
           "%llu work, %llu span; direct/source/erased=%u/%u/%u blocks, "
           "normalization escape=%u blocks/%llu bytes/%llu node-delta)\n",
           (unsigned long long)input_bytes,
           (unsigned long long)output_bytes,
           (unsigned long long)report.output_work,
           (unsigned long long)report.output_span,
           report.native_direct_frame_blocks,
           report.native_copied_source_blocks,
           report.native_erased_blocks,
           report.native_normalization_escape_blocks,
           (unsigned long long)
               report.native_normalization_escape_output_bytes,
           (unsigned long long)report.native_normalization_escape_work);
    free(temporary);
    free(workspace);
    free(output);
    free(input);
    return 0;
}
