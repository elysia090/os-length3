#include "io.h"
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>

pl_u8 *cli_read_file(const char *path, pl_u64 *bytes)
{
    FILE *file = fopen(path, "rb");
    pl_u8 *data = NULL;
    long length;
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END) || (length = ftell(file)) <= 0
            || (unsigned long)length > SIZE_MAX || fseek(file, 0, SEEK_SET)) goto done;
    data = malloc((size_t)length);
    if (!data) goto done;
    if (fread(data, 1u, (size_t)length, file) != (size_t)length) {
        free(data); data = NULL; goto done;
    }
    *bytes = (pl_u64)(unsigned long)length;
done:
    if (fclose(file)) { free(data); data = NULL; }
    return data;
}

int cli_address(const char *text, pl_u64 *address)
{
    char *end = NULL;
    if (!text || !*text || *text == '-' || *text == '+' || *text <= ' ') return 0;
    errno = 0;
    unsigned long long value = strtoull(text, &end, 0);
    if (errno || !end || *end) return 0;
    *address = (pl_u64)value;
    return 1;
}
