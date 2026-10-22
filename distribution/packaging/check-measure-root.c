#include <stdio.h>
#include <sys/xattr.h>

/* Fixture setup uses the same Linux xattr interface as ordinary files. It
 * must not silently skip xattr coverage when an optional CLI is unavailable. */
int main(int argc, char **argv)
{
    const unsigned char value[] = { 1u, 2u };
    if (argc != 2) return 2;
    if (setxattr(argv[1], "user.contract", value, sizeof value, 0) != 0) {
        perror("setxattr");
        return 1;
    }
    return 0;
}
