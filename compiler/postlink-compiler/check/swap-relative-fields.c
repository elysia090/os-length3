#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const unsigned char marker[] = "PLFIELD-AUTH-v1!";

static uint32_t read_u32(const unsigned char *source)
{
    return (uint32_t)source[0]
         | (uint32_t)source[1] << 8u
         | (uint32_t)source[2] << 16u
         | (uint32_t)source[3] << 24u;
}

static void write_u32(unsigned char *target, uint32_t value)
{
    for (unsigned index = 0; index < 4; ++index)
        target[index] = (unsigned char)(value >> (index * 8u));
}

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    FILE *file = fopen(argv[1], "r+b");
    if (!file || fseek(file, 0, SEEK_END)) return 2;
    long extent = ftell(file);
    if (extent <= 0 || fseek(file, 0, SEEK_SET)) return 2;
    unsigned char *bytes = malloc((size_t)extent);
    if (!bytes || fread(bytes, 1, (size_t)extent, file) != (size_t)extent)
        return 2;

    size_t field_at = (size_t)extent;
    for (size_t at = 0; at + sizeof marker - 1u + 8u <= (size_t)extent;
            ++at) {
        if (memcmp(bytes + at, marker, sizeof marker - 1u)) continue;
        if (field_at != (size_t)extent) return 2;
        field_at = at + sizeof marker - 1u;
    }
    if (field_at == (size_t)extent) return 2;
    unsigned char *fields = bytes + field_at;

    int64_t first = (int32_t)read_u32(fields);
    int64_t second = 4 + (int32_t)read_u32(fields + 4);
    int64_t new_first = second;
    int64_t new_second = first - 4;
    if (new_first < INT32_MIN || new_first > INT32_MAX
            || new_second < INT32_MIN || new_second > INT32_MAX
            || fseek(file, (long)field_at, SEEK_SET))
        return 2;
    write_u32(fields, (uint32_t)(int32_t)new_first);
    write_u32(fields + 4, (uint32_t)(int32_t)new_second);
    int ok = fwrite(fields, 1, 8u, file) == 8u;
    free(bytes);
    return fclose(file) || !ok;
}
