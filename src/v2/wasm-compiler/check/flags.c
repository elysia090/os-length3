#include <stdint.h>
#include <stdio.h>
/* Safe CPL3 hardware oracle only. TF, AC and NT are tested separately by the
 * architectural model, not enabled in the development host process. */
extern void native_flags(uint64_t value, unsigned width, uint64_t result[3]);
int main(int argc, char **argv)
{
    if (argc != 1 && argc != 2) return 2;
    FILE *file = argc == 2 ? fopen(argv[1], "wbx") : NULL;
    if (argc == 2 && !file) return 1;
    uint64_t random = UINT64_C(0x123456789abcdef);
    for (unsigned width = 16u; width <= 64u; width += 48u)
    for (unsigned rank = 0u; rank < 1024u; ++rank) {
        random ^= random << 13u; random ^= random >> 7u; random ^= random << 17u;
        uint64_t row[5] = {width, random & ~UINT64_C(0x44100), 0u, 0u, 0u};
        native_flags(row[1], width, row + 2);
        uint64_t mask = width == 64u ? UINT64_C(0x244dd5) : UINT64_C(0x4dd5);
        if ((row[2] >> 12u & 3u) != 0u
                || row[3] != ((row[2] & ~mask) | (row[1] & mask))
                || row[4] != (row[3] & (width == 64u ? ~UINT64_C(0x30000) : UINT64_C(0xffff)))) {
            fprintf(stderr, "native flags mismatch: width %u case %u\n", width, rank);
            if (file) fclose(file);
            return 1;
        }
        if (file && fwrite(row, sizeof row, 1u, file) != 1u) { fclose(file); return 1; }
    }
    if (file && fclose(file)) return 1;
    puts("PUSHF/POPF native CPL3 oracle: green (2048 cases; not privileged exception delivery)");
    return 0;
}
