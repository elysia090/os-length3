/* Execute the actual Kbuild Zstd objects without changing their instructions.
 * The public streaming buffer ABI below matches linux/zstd_lib.h; only the
 * test supplies userspace buffers and libc memory operations. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { const void *src; size_t size, pos; } in_buffer;
typedef struct { void *dst; size_t size, pos; } out_buffer;
extern size_t ZSTD_estimateDStreamSize(size_t);
extern void *ZSTD_initStaticDStream(void *, size_t);
extern size_t ZSTD_decompressStream(void *, out_buffer *, in_buffer *);
extern unsigned ZSTD_isError(size_t);
extern const char *ZSTD_getErrorName(size_t);

static uint64_t le64(const unsigned char *p)
{
    uint64_t v = 0;
    for (unsigned i = 0; i < 8; ++i) v |= (uint64_t)p[i] << (i * 8);
    return v;
}

int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    FILE *f = fopen(argv[1], "rb");
    if (!f || fseek(f, 0, SEEK_END)) return 2;
    long length = ftell(f);
    if (length <= 0 || fseek(f, 0, SEEK_SET)) return 2;
    unsigned char *bytes = malloc((size_t)length);
    if (!bytes || fread(bytes, 1, (size_t)length, f) != (size_t)length)
        return 2;
    fclose(f);
    size_t begin = 0, end = (size_t)length;
    if (strcmp(argv[2], "stream")) {
        /* SquashFS 4 superblock: inode/directory table offsets are LE64 at
         * 64/72. Each compressed metadata block has its exact LE16 extent. */
        unsigned field = !strcmp(argv[2], "inode") ? 64u :
                         !strcmp(argv[2], "directory") ? 72u : 0u;
        if (!field || end < 96u) return 2;
        uint64_t offset = le64(bytes + field);
        if (offset > end - 2u) return 2;
        unsigned size = bytes[offset] | (unsigned)bytes[offset + 1u] << 8u;
        if ((size & 0x8000u) || size > end - offset - 2u) return 2;
        begin = (size_t)offset + 2u;
        end = begin + size;
    }
    size_t capacity = ZSTD_estimateDStreamSize(8u * 1024u * 1024u);
    void *workspace = malloc(capacity);
    void *stream = ZSTD_initStaticDStream(workspace, capacity);
    FILE *out = fopen(argv[3], "wb");
    if (!stream || !out) return 2;
    unsigned char output[4096];
    size_t hint = 1u;
    while (begin < end) {
        size_t chunk = end - begin;
        if (chunk > 4096u) chunk = 4096u;
        in_buffer input = { bytes + begin, chunk, 0u };
        while (input.pos < input.size || hint == 1u) {
            out_buffer dest = { output, sizeof(output), 0u };
            size_t before = input.pos;
            hint = ZSTD_decompressStream(stream, &dest, &input);
            if (ZSTD_isError(hint)) {
                fprintf(stderr, "%s\n", ZSTD_getErrorName(hint));
                return 1;
            }
            if (fwrite(output, 1, dest.pos, out) != dest.pos) return 2;
            if (!hint || (input.pos == before && !dest.pos)) break;
        }
        begin += input.pos;
        if (!hint) break;
        if (!input.pos) return 1;
    }
    free(workspace);
    free(bytes);
    if (fclose(out)) return 2;
    return hint ? 1 : 0;
}
