/* Check-only filesystem adapter: SquashFS may report unsupported link xattrs.
 * No process observation or production filesystem code is replaced. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>

ssize_t __real_llistxattr(const char *, char *, size_t);
ssize_t __wrap_llistxattr(const char *, char *, size_t);

ssize_t __wrap_llistxattr(const char *path, char *list, size_t bytes)
{
    struct stat status;
    if (!lstat(path, &status) && S_ISLNK(status.st_mode)) {
        const char *mode = getenv("ARTIFACT_TEST_LINK_XATTR_ERROR");
        errno = mode && !strcmp(mode, "io") ? EIO : ENOTSUP;
        return -1;
    }
    return __real_llistxattr(path, list, bytes);
}
