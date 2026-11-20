// The separate ELF proving ordinary Wayland's inherited descriptor path.
#include "presenter.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int descriptor(const char *text) {
    char *end;
    errno = 0;
    long value = strtol(text, &end, 10);
    return errno || end == text || *end || value < 0 || value > INT_MAX ? -1 : (int)value;
}

int main(int argc, char **argv) {
    if (argc != 3) return 51;
    int socket = descriptor(argv[1]), closed = descriptor(argv[2]);
    if (socket <= STDERR_FILENO || closed <= STDERR_FILENO || socket == closed ||
        !getenv("WAYLAND_SOCKET") || getenv("WAYLAND_DISPLAY") || getenv("XDG_RUNTIME_DIR")) return 52;
    int flags = fcntl(socket, F_GETFD);
    if (flags < 0 || flags & FD_CLOEXEC) return 53;
    errno = 0;
    if (fcntl(closed, F_GETFD) != -1 || errno != EBADF) return 54;
    errno = 0;
    if (fcntl(STDIN_FILENO, F_GETFD) != -1 || errno != EBADF) return 55;
    puts("WAYLAND_CLIENT_EXEC fd_inherited=1 cloexec_sentinel_absent=1 stdin_absent=1");
    if (fflush(stdout) != 0) return 56;
    return guest_wayland_inherited(socket);
}
