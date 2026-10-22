#include <optimized-x86/reader.h>
#include <support/checked.h>
#include <support/sha256.h>

#include <stdio.h>
#include <stdlib.h>

static int read_file(const char *path, pl_u8 **bytes, pl_u64 *length)
{
    FILE *file = fopen(path, "rb");
    if (!file || fseek(file, 0, SEEK_END)) return 0;
    long end = ftell(file);
    if (end <= 0 || fseek(file, 0, SEEK_SET)) {
        fclose(file);
        return 0;
    }
    pl_u8 *loaded = malloc((size_t)end);
    if (!loaded
            || fread(loaded, 1u, (size_t)end, file) != (size_t)end) {
        free(loaded);
        fclose(file);
        return 0;
    }
    fclose(file);
    *bytes = loaded;
    *length = (pl_u64)(unsigned long)end;
    return 1;
}

static int source_matches(const ox_proof *proof,
                          const pl_u8 *source, pl_u64 source_bytes)
{
    pl_u8 digest[PL_SHA256_BYTES];
    if (proof->source_bytes != source_bytes) return 0;
    pl_sha256_digest(source, source_bytes, digest);
    for (pl_u32 index = 0u; index < 4u; ++index)
        if (proof->source_sha256[index]
                != pl_read_u64(digest + index * 8u))
            return 0;
    return 1;
}

int main(int argc, char **argv)
{
    if (argc != 2 && argc != 3) {
        fprintf(stderr,
                "usage: postlink-verify [SOURCE.elf] OPTIMIZED.elf\n");
        return 2;
    }
    const char *source_path = argc == 3 ? argv[1] : NULL;
    const char *optimized_path = argv[argc - 1];
    pl_u8 *optimized = NULL;
    pl_u64 optimized_bytes = 0u;
    if (!read_file(optimized_path, &optimized, &optimized_bytes)) {
        fprintf(stderr, "postlink-verify: cannot read %s\n", optimized_path);
        return 2;
    }
    ox_image image;
    int status = ox_image_open(optimized, optimized_bytes, &image);
    if (status) {
        fprintf(stderr, "postlink-verify: invalid optimized ELF (%d): %s\n",
                status, optimized_path);
        free(optimized);
        return 1;
    }

    if (source_path) {
        pl_u8 *source = NULL;
        pl_u64 source_bytes = 0u;
        if (!read_file(source_path, &source, &source_bytes)) {
            fprintf(stderr, "postlink-verify: cannot read %s\n", source_path);
            free(optimized);
            return 2;
        }
        if (!source_matches(&image.proof, source, source_bytes)) {
            fprintf(stderr,
                    "postlink-verify: source identity does not match proof: %s\n",
                    source_path);
            free(source);
            free(optimized);
            return 1;
        }
        free(source);
    }

    printf("postlink proof: green (%llu -> %llu bytes, "
           "%llu -> %llu work, %llu -> %llu span)\n",
           (unsigned long long)image.proof.source_bytes,
           (unsigned long long)optimized_bytes,
           (unsigned long long)image.proof.input_work,
           (unsigned long long)image.proof.output_work,
           (unsigned long long)image.proof.input_span,
           (unsigned long long)image.proof.output_span);
    free(optimized);
    return 0;
}
