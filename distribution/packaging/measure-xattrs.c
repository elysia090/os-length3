#define _XOPEN_SOURCE 700
#include <errno.h>
#include <ftw.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/xattr.h>

/* The size projection needs name/value extents, never value materialization
 * or a hex dump. Emit NUL-delimited path, record count and canonical bytes.
 * The caller owns inode identity and charges hard-link aliases only once. */
static int measure(const char *path, const struct stat *status, int type,
                   struct FTW *walk)
{
    (void)status;
    (void)walk;
    if (type == FTW_DNR || type == FTW_NS) {
        fprintf(stderr, "cannot inspect release path: %s\n", path);
        return 1;
    }
    ssize_t extent = llistxattr(path, NULL, 0);
    if (extent < 0 && errno == ENOTSUP) return 0;
    if (extent < 0) { perror(path); return 1; }
    if (!extent) return 0;
    char *names = malloc((size_t)extent);
    if (!names) { perror("xattr names"); return 1; }
    ssize_t read = llistxattr(path, names, (size_t)extent);
    if (read < 0) { perror(path); free(names); return 1; }
    uint64_t records = 0u, bytes = 0u;
    for (size_t at = 0u; at < (size_t)read;) {
        size_t length = strnlen(names + at, (size_t)read - at);
        if (length == (size_t)read - at) { free(names); return 1; }
        ssize_t value = lgetxattr(path, names + at, NULL, 0);
        if (value < 0) { perror(path); free(names); return 1; }
        uint64_t row = 16u + (uint64_t)length + (uint64_t)value;
        if (bytes > UINT64_MAX - row || records == UINT64_MAX) {
            free(names);
            return 1;
        }
        bytes += row;
        ++records;
        at += length + 1u;
    }
    free(names);
    return printf("%s%c%llu%c%llu%c", path, 0,
                  (unsigned long long)records, 0,
                  (unsigned long long)bytes, 0) < 0;
}

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    int result = nftw(argv[1], measure, 32, FTW_PHYS);
    if (result < 0) perror(argv[1]);
    return result != 0 || fflush(stdout) != 0;
}
