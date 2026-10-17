#define _POSIX_C_SOURCE 200809L

#include <artifact/archive.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int read_file(const char *path, pl_u8 **bytes, pl_u32 *length)
{
    FILE *file = fopen(path, "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 0;
    long end = ftell(file);
    if (end <= 0 || (unsigned long)end > 0xfffffffful
            || fseek(file, 0, SEEK_SET)) {
        fclose(file);
        return 0;
    }
    *bytes = malloc((size_t)end);
    if (!*bytes || fread(*bytes, 1u, (size_t)end, file) != (size_t)end
            || fclose(file)) {
        free(*bytes);
        *bytes = 0;
        return 0;
    }
    *length = (pl_u32)(unsigned long)end;
    return 1;
}

static int write_file(const char *path, const pl_u8 *bytes, pl_u32 length)
{
    FILE *file = fopen(path, "wb");
    if (!file) return 0;
    int status = fwrite(bytes, 1u, length, file) == length && !fflush(file);
    if (fclose(file)) status = 0;
    return status;
}

int main(int argc, char **argv)
{
    if (argc != 3 || !strcmp(argv[1], argv[2])) {
        fprintf(stderr, "usage: %s INPUT.a OUTPUT.a\n", argv[0]);
        return 2;
    }
    pl_u8 *source = 0, *output = 0;
    pl_u32 source_bytes = 0u, members = 0u, symbols = 0u;
    const char *phase = "read-source";
    int status = read_file(argv[1], &source, &source_bytes)
        ? 0 : ARTIFACT_ERROR_ARCHIVE_RANGE;
    if (!status) {
        phase = "measure-source-view";
        status = artifact_archive_read_measure(
            source, source_bytes, &members, &symbols);
    }
    artifact_archive_member *member = status ? 0 : calloc(
        members, sizeof(*member));
    artifact_archive_symbol *symbol = status || !symbols ? 0 : calloc(
        symbols, sizeof(*symbol));
    pl_u32 *read_header = status ? 0 : malloc(
        (size_t)members * sizeof(*read_header));
    pl_u64 *write_header = status ? 0 : malloc(
        (size_t)members * sizeof(*write_header));
    pl_u32 *long_name = status ? 0 : malloc(
        (size_t)members * sizeof(*long_name));
    if (!status && ((members
                     && (!member || !read_header
                         || !write_header || !long_name))
            || (symbols && !symbol)))
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    artifact_archive_read_workspace reader = {
        member, symbol, read_header, members, symbols,
    };
    artifact_archive_view view = { 0 };
    if (!status) {
        phase = "open-view";
        status = artifact_archive_read(
            source, source_bytes, &reader, &view);
    }
    artifact_archive_workspace writer = {
        write_header, long_name, members,
    };
    artifact_archive_projection projection = { 0 };
    if (!status) {
        phase = "measure-canonical-view";
        status = artifact_archive_project(&view, &writer, &projection);
    }
    if (!status && projection.archive_bytes > 0xffffffffu)
        status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    output = status ? 0 : malloc((size_t)projection.archive_bytes);
    if (!status && !output) status = ARTIFACT_ERROR_ARCHIVE_RANGE;
    pl_u32 output_bytes = 0u;
    if (!status) {
        phase = "write-canonical-view";
        status = artifact_archive_write(
            &view, &writer, output, (pl_u32)projection.archive_bytes,
            &output_bytes);
    }
    if (!status) phase = "publish-canonical-view";
    if (!status && (!write_file(argv[2], output, output_bytes)
            || output_bytes != projection.archive_bytes))
        status = ARTIFACT_ERROR_ARCHIVE;
    if (status)
        fprintf(stderr, "archive normalization: RED (%d, %s): %s\n",
                status, phase, argv[1]);
    else
        printf("archive normalization: green "
               "(%u members/%u symbols, %u -> %u bytes)\n",
               members, symbols, source_bytes, output_bytes);
    free(output);
    free(long_name);
    free(write_header);
    free(read_header);
    free(symbol);
    free(member);
    free(source);
    return status ? 1 : 0;
}
